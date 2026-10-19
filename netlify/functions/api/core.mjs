// OpenUS API core. Storage is injected so the logic can be tested without Netlify.
// store(name) must return an object with get(key,{type:'json'}), getWithMetadata(key,{type:'json'}),
// setJSON(key,val,opts) -> {modified, etag}, delete(key).
import crypto from 'node:crypto';

const DAY = 864e5;
const SESSION_DAYS = 120;
const INVITE_HOURS = 48;
const KEEP_EVENTS = 300;
const KEEP_CHECKINS = 100;

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => { throw new HttpError(400, m); };

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = (n = 16) => crypto.randomBytes(n).toString('base64url');
const now = () => Date.now();
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const normEmail = (e) => clean(e, 120).toLowerCase();

function hashPassword(pw, salt = rid(16)) {
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url');
  return { salt, hash };
}
function checkPassword(pw, salt, hash) {
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hash, 'base64url');
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}

const DEFAULT_PERMS = { location: false, arrivals: true, history: true };
const DEFAULT_AGREEMENTS = { 'No secret dating apps': true, 'Phones open on request': true, 'Tell each other when plans change': true };

export function makeApi({ store, pushSender }) {
  const users = store('users');
  const emails = store('emails');
  const sessions = store('sessions');
  const invites = store('invites');
  const couples = store('couples');
  const locs = store('locations');
  const subs = store('push');

  // ---------- helpers ----------
  async function readUser(uid) { return uid ? users.get(uid, { type: 'json' }) : null; }
  function publicUser(u) { return u && { id: u.id, name: u.name, photo: u.photo || null }; }

  async function auth(req) {
    const h = req.headers.get('authorization') || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!tok) throw new HttpError(401, 'Please sign in');
    const s = await sessions.get(sha(tok), { type: 'json' });
    if (!s || s.exp < now()) throw new HttpError(401, 'Your session expired. Please sign in again.');
    const u = await readUser(s.uid);
    if (!u) throw new HttpError(401, 'Account not found');
    return u;
  }

  async function newSession(uid) {
    const tok = rid(32);
    await sessions.setJSON(sha(tok), { uid, exp: now() + SESSION_DAYS * DAY });
    return tok;
  }

  // Compare-and-swap update on one couple document (only two writers, retries are plenty).
  async function updateCouple(cid, fn) {
    for (let i = 0; i < 8; i++) {
      const cur = await couples.getWithMetadata(cid, { type: 'json' });
      if (!cur || !cur.data) throw new HttpError(404, 'Connection not found');
      const doc = cur.data;
      const out = await fn(doc);
      prune(doc);
      doc.v = (doc.v || 0) + 1; doc.updated = now();
      const r = await couples.setJSON(cid, doc, { onlyIfMatch: cur.etag });
      if (r && r.modified !== false) return { doc, out };
      await new Promise((res) => setTimeout(res, 40 + Math.random() * 120));
    }
    throw new HttpError(409, 'Busy, please try again');
  }

  function prune(doc) {
    const cut = now() - 30 * DAY;
    doc.events = (doc.events || []).filter((e) => e.ts >= cut || !e.movement).slice(0, KEEP_EVENTS);
    doc.checkins = (doc.checkins || []).slice(0, KEEP_CHECKINS);
    doc.requests = (doc.requests || []).filter((r) => r.status === 'pending' || r.ts >= cut).slice(-200);
  }

  function addEvent(doc, ev) {
    doc.events = doc.events || [];
    doc.events.unshift({ id: rid(6), ts: now(), ...ev });
  }

  const other = (doc, uid) => doc.members.find((m) => m !== uid);
  const assertMember = (doc, uid) => { if (!doc.members.includes(uid)) throw new HttpError(403, 'Not part of this connection'); };

  async function notify(uid, title, body, tag) {
    if (!uid || !pushSender) return;
    try {
      const rec = (await subs.get(uid, { type: 'json' })) || { list: [] };
      rec.inbox = [{ title, body, tag, ts: now() }, ...(rec.inbox || [])].slice(0, 10);
      const alive = [];
      for (const s of rec.list) {
        const ok = await pushSender(s).catch(() => true);
        if (ok !== 'gone') alive.push(s);
      }
      rec.list = alive;
      await subs.setJSON(uid, rec);
    } catch (e) { /* notifications are best-effort */ }
  }

  async function stateFor(u) {
    if (!u.coupleId) return { me: publicUser(u), email: u.email, couple: null };
    const doc = await couples.get(u.coupleId, { type: 'json' });
    if (!doc) return { me: publicUser(u), email: u.email, couple: null };
    const pid = other(doc, u.id);
    const partner = pid ? publicUser(await readUser(pid)) : null;
    let partnerLoc = null;
    if (pid && !doc.paused && doc.perms?.[pid]?.location) {
      const l = await locs.get(pid, { type: 'json' });
      if (l && l.ts > now() - 2 * DAY) partnerLoc = { lat: l.lat, lng: l.lng, acc: l.acc, ts: l.ts };
    }
    const myLoc = await locs.get(u.id, { type: 'json' });
    return {
      me: publicUser(u), email: u.email, partner, partnerLoc,
      myLoc: myLoc ? { lat: myLoc.lat, lng: myLoc.lng, ts: myLoc.ts } : null,
      couple: {
        id: doc.id, v: doc.v, paused: !!doc.paused, members: doc.members,
        perms: doc.perms, agreements: doc.agreements, requests: doc.requests,
        checkins: doc.checkins, contacts: doc.contacts, places: doc.places,
        settings: doc.settings, events: doc.events.filter((e) => !e.movement || (doc.perms?.[e.who]?.history !== false)),
        inviteCode: doc.inviteCode && doc.inviteExp > now() && doc.members.length < 2 ? doc.inviteCode : null,
        inviteExp: doc.inviteExp,
      },
    };
  }

  function distM(a, b) {
    const R = 6371000, t = Math.PI / 180;
    const dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  async function makeInvite(doc) {
    for (let i = 0; i < 6; i++) {
      const code = Array.from(crypto.randomBytes(6)).map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
      const r = await invites.setJSON(code, { cid: doc.id, exp: now() + INVITE_HOURS * 3600e3 }, { onlyIfNew: true });
      if (r && r.modified !== false) { doc.inviteCode = code; doc.inviteExp = now() + INVITE_HOURS * 3600e3; return code; }
    }
    throw new HttpError(500, 'Could not create an invite code');
  }

  // ---------- routes ----------
  const routes = {
    'POST /signup': async (req, body) => {
      const email = normEmail(body.email), pw = String(body.password || ''), name = clean(body.name, 24);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Enter a valid email address');
      if (pw.length < 8) bad('Use a password with at least 8 characters');
      if (!name) bad('Enter your name or nickname');
      const id = rid(12);
      const claim = await emails.setJSON(sha(email), { uid: id }, { onlyIfNew: true });
      if (claim && claim.modified === false) bad('That email already has an account. Sign in instead.');
      const { salt, hash } = hashPassword(pw);
      await users.setJSON(id, { id, email, name, salt, hash, photo: null, coupleId: null, created: now() });
      const token = await newSession(id);
      return { token, state: await stateFor(await readUser(id)) };
    },

    'POST /login': async (req, body) => {
      const email = normEmail(body.email), pw = String(body.password || '');
      const rec = await emails.get(sha(email), { type: 'json' });
      const u = rec && (await readUser(rec.uid));
      if (!u || !checkPassword(pw, u.salt, u.hash)) throw new HttpError(401, 'Email or password is incorrect');
      const token = await newSession(u.id);
      return { token, state: await stateFor(u) };
    },

    'POST /logout': async (req) => {
      const tok = (req.headers.get('authorization') || '').slice(7);
      if (tok) await sessions.delete(sha(tok));
      return { ok: true };
    },

    'GET /state': async (req) => stateFor(await auth(req)),

    'POST /profile': async (req, body) => {
      const u = await auth(req);
      if (body.name !== undefined) { const n = clean(body.name, 24); if (!n) bad('Name cannot be empty'); u.name = n; }
      if (body.photo !== undefined) {
        if (body.photo && (!/^data:image\/(jpeg|png|webp);base64,/.test(body.photo) || body.photo.length > 200000)) bad('That photo is too large');
        u.photo = body.photo || null;
      }
      await users.setJSON(u.id, u);
      return stateFor(u);
    },

    'POST /password': async (req, body) => {
      const u = await auth(req);
      if (!checkPassword(String(body.current || ''), u.salt, u.hash)) bad('Current password is incorrect');
      if (String(body.next || '').length < 8) bad('Use at least 8 characters');
      Object.assign(u, hashPassword(String(body.next)));
      await users.setJSON(u.id, u);
      return { ok: true };
    },

    // Start a connection and get an invite code for the partner.
    'POST /connect/create': async (req) => {
      const u = await auth(req);
      if (u.coupleId) {
        const existing = await couples.get(u.coupleId, { type: 'json' });
        if (existing && existing.members.length >= 2) bad('You are already connected. Leave that connection first.');
        if (existing) {
          const { doc } = await updateCouple(u.coupleId, async (d) => { await makeInvite(d); });
          return stateFor(u);
        }
      }
      const id = rid(12);
      const doc = {
        id, v: 1, created: now(), members: [u.id], paused: false,
        perms: { [u.id]: { ...DEFAULT_PERMS } }, agreements: { ...DEFAULT_AGREEMENTS },
        requests: [], checkins: [], contacts: [], places: [], events: [],
        settings: { movementSaving: true, quietHours: false },
      };
      await makeInvite(doc);
      addEvent(doc, { type: 'system', who: u.id, text: `${u.name} started OpenUS` });
      await couples.setJSON(id, doc);
      u.coupleId = id; await users.setJSON(u.id, u);
      return stateFor(u);
    },

    'POST /connect/join': async (req, body) => {
      const u = await auth(req);
      const code = clean(body.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const inv = await invites.get(code, { type: 'json' });
      if (!inv || inv.exp < now()) bad('That code is not valid or has expired. Ask your partner for a new one.');
      if (u.coupleId === inv.cid) return stateFor(u);
      if (u.coupleId) {
        const mine = await couples.get(u.coupleId, { type: 'json' });
        if (mine && mine.members.length >= 2) bad('You are already connected to someone. Leave that connection first.');
      }
      const { doc } = await updateCouple(inv.cid, (d) => {
        if (d.members.includes(u.id)) return;
        if (d.members.length >= 2) bad('This connection already has two people');
        d.members.push(u.id);
        d.perms[u.id] = { ...DEFAULT_PERMS };
        d.inviteCode = null;
        addEvent(d, { type: 'system', who: u.id, text: `${u.name} accepted the invite. You're connected by consent.` });
      });
      await invites.delete(code);
      u.coupleId = inv.cid; await users.setJSON(u.id, u);
      await notify(other(doc, u.id), 'OpenUS', `${u.name} joined your connection`, 'join');
      return stateFor(u);
    },

    'POST /connect/leave': async (req) => {
      const u = await auth(req);
      if (!u.coupleId) return stateFor(u);
      const cid = u.coupleId;
      let pid = null;
      await updateCouple(cid, (d) => {
        pid = other(d, u.id);
        d.members = d.members.filter((m) => m !== u.id);
        delete d.perms[u.id];
        d.paused = true;
        addEvent(d, { type: 'system', who: u.id, text: `${u.name} left the connection. Sharing has stopped.` });
      });
      await locs.delete(u.id);
      u.coupleId = null; await users.setJSON(u.id, u);
      if (pid) await notify(pid, 'OpenUS', `${u.name} left the connection`, 'leave');
      return stateFor(u);
    },

    // All shared actions go through here.
    'POST /act': async (req, body) => {
      const u = await auth(req);
      if (!u.coupleId) bad('Connect with your partner first');
      const t = body.type;
      const pushes = [];
      await updateCouple(u.coupleId, (d) => {
        assertMember(d, u.id);
        const pid = other(d, u.id);
        const needPartner = () => { if (!pid) bad('Your partner has not joined yet'); if (d.paused) bad('The connection is paused. Resume it first.'); };
        switch (t) {
          case 'perm': {
            const k = body.key; if (!(k in DEFAULT_PERMS)) bad('Unknown setting');
            d.perms[u.id][k] = !!body.value;
            const L = { location: 'location', arrivals: 'arrival alerts', history: 'movement history' }[k];
            addEvent(d, { type: 'perm', who: u.id, text: `${u.name} turned ${L} ${body.value ? 'on' : 'off'}` });
            break;
          }
          case 'pause': {
            d.paused = !!body.value;
            addEvent(d, { type: 'system', who: u.id, text: `${u.name} ${d.paused ? 'paused' : 'resumed'} the connection` });
            pushes.push([pid, `${u.name} ${d.paused ? 'paused' : 'resumed'} your connection`, 'pause']);
            break;
          }
          case 'request': {
            needPartner();
            const name = clean(body.name, 60); if (!name) bad('Type an agreement first');
            const value = !!body.value;
            if (d.requests.some((r) => r.status === 'pending' && r.name.toLowerCase() === name.toLowerCase())) bad('There is already a pending request for that');
            if (value && d.agreements[name] === true) bad('That agreement is already active');
            d.requests.push({ id: rid(8), name, value, from: u.id, to: pid, status: 'pending', ts: now() });
            pushes.push([pid, `${u.name} sent a request`, `${value ? 'Add' : 'Remove'}: “${name}”`]);
            break;
          }
          case 'decide': {
            const r = d.requests.find((x) => x.id === body.id);
            if (!r || r.status !== 'pending') bad('That request was already handled');
            if (r.to !== u.id) bad('Only your partner can approve this');
            r.status = body.ok ? 'approved' : 'declined'; r.decided = now();
            if (body.ok) { if (r.value) d.agreements[r.name] = true; else delete d.agreements[r.name]; }
            addEvent(d, { type: 'agreement', who: u.id, text: `${u.name} ${r.status} “${r.name}” (${r.value ? 'add' : 'remove'})` });
            pushes.push([r.from, `${u.name} ${r.status} your request`, `“${r.name}”`]);
            break;
          }
          case 'cancelRequest': {
            const r = d.requests.find((x) => x.id === body.id && x.from === u.id && x.status === 'pending');
            if (!r) bad('Request not found'); r.status = 'withdrawn'; r.decided = now();
            break;
          }
          case 'checkin': {
            needPartner();
            const mood = clean(body.mood, 20) || 'Good', note = clean(body.note, 300);
            d.checkins.unshift({ id: rid(8), from: u.id, to: pid, mood, note, ts: now(), seen: false, reply: null });
            addEvent(d, { type: 'checkin', who: u.id, text: `${u.name} checked in: ${mood}` });
            pushes.push([pid, `${u.name} checked in: ${mood}`, note || 'Open OpenUS to reply']);
            break;
          }
          case 'checkinReply': {
            const c = d.checkins.find((x) => x.id === body.id && x.to === u.id); if (!c) bad('Check-in not found');
            c.reply = clean(body.reply, 40) || '❤️'; c.seen = true;
            pushes.push([c.from, `${u.name} replied ${c.reply}`, 'to your check-in']);
            break;
          }
          case 'seen': { d.checkins.forEach((c) => { if (c.to === u.id) c.seen = true; }); break; }
          case 'contactAdd': {
            const name = clean(body.name, 30); if (!name) bad('Type a name first');
            d.contacts.push({ id: rid(6), name, kind: clean(body.kind, 20) || 'Friend', by: u.id });
            addEvent(d, { type: 'contact', who: u.id, text: `${u.name} added ${name} as a trusted contact` });
            break;
          }
          case 'contactRemove': { d.contacts = d.contacts.filter((c) => c.id !== body.id); break; }
          case 'placeAdd': {
            const name = clean(body.name, 30); if (!name) bad('Name the place first');
            const lat = +body.lat, lng = +body.lng, radius = Math.min(2000, Math.max(75, +body.radius || 200));
            if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) bad('Location is missing. Allow location access and try again.');
            d.places.push({ id: rid(6), name, lat, lng, radius, by: u.id });
            addEvent(d, { type: 'place', who: u.id, text: `${u.name} saved ${name} as a safe place` });
            break;
          }
          case 'placeRemove': { d.places = d.places.filter((p) => p.id !== body.id); break; }
          case 'placeRadius': { const p = d.places.find((x) => x.id === body.id); if (p) p.radius = Math.min(2000, Math.max(75, +body.radius || 200)); break; }
          case 'setting': {
            if (!['movementSaving', 'quietHours'].includes(body.key)) bad('Unknown setting');
            d.settings[body.key] = !!body.value; break;
          }
          case 'clearHistory': { d.events = d.events.filter((e) => !e.movement); addEvent(d, { type: 'system', who: u.id, text: `${u.name} cleared movement history` }); break; }
          case 'sos': {
            needPartner();
            addEvent(d, { type: 'alert', who: u.id, text: `${u.name} asked for help${body.note ? ': ' + clean(body.note, 120) : ''}` });
            pushes.push([pid, `⚠️ ${u.name} needs you`, clean(body.note, 120) || 'Open OpenUS to see their location']);
            break;
          }
          default: bad('Unknown action');
        }
      });
      for (const [to, title, msg] of pushes) await notify(to, title, msg, t);
      return stateFor(u);
    },

    // Location update with geofence arrive/leave detection.
    'POST /location': async (req, body) => {
      const u = await auth(req);
      const lat = +body.lat, lng = +body.lng, acc = Math.round(+body.acc || 0);
      if (!isFinite(lat) || !isFinite(lng)) bad('Bad location');
      if (!u.coupleId) return { ok: true };
      const doc = await couples.get(u.coupleId, { type: 'json' });
      if (!doc || doc.paused || !doc.perms?.[u.id]?.location) { await locs.delete(u.id); return { ok: true, sharing: false }; }
      const prev = (await locs.get(u.id, { type: 'json' })) || { inside: {} };
      const inside = {};
      const transitions = [];
      for (const p of doc.places || []) {
        const dm = distM({ lat, lng }, p);
        const was = !!prev.inside?.[p.id];
        // hysteresis so GPS jitter doesn't flap
        const is = was ? dm <= p.radius + 40 : dm <= p.radius;
        inside[p.id] = is;
        if (prev.ts && is !== was && acc < 250) transitions.push({ p, arrived: is });
      }
      await locs.setJSON(u.id, { lat, lng, acc, ts: now(), inside });
      if (transitions.length) {
        const pid = other(doc, u.id);
        await updateCouple(u.coupleId, (d) => {
          for (const tr of transitions) {
            if (d.settings.movementSaving && d.perms[u.id]?.history !== false)
              addEvent(d, { type: 'move', movement: true, who: u.id, place: tr.p.name, text: `${u.name} ${tr.arrived ? 'arrived at' : 'left'} ${tr.p.name}` });
          }
        });
        if (doc.perms[u.id]?.arrivals) for (const tr of transitions) await notify(pid, `${u.name} ${tr.arrived ? 'arrived at' : 'left'} ${tr.p.name}`, 'OpenUS safe places', 'move');
      }
      return { ok: true, sharing: true, transitions: transitions.map((x) => ({ place: x.p.name, arrived: x.arrived })) };
    },

    'POST /push/subscribe': async (req, body) => {
      const u = await auth(req);
      const s = body.subscription;
      if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint)) bad('Bad subscription');
      const rec = (await subs.get(u.id, { type: 'json' })) || { list: [] };
      rec.list = [{ endpoint: s.endpoint }, ...rec.list.filter((x) => x.endpoint !== s.endpoint)].slice(0, 5);
      await subs.setJSON(u.id, rec);
      return { ok: true };
    },

    'POST /push/inbox': async (req) => {
      const u = await auth(req);
      const rec = (await subs.get(u.id, { type: 'json' })) || {};
      return { inbox: rec.inbox || [] };
    },

    'POST /delete-account': async (req, body) => {
      const u = await auth(req);
      if (!checkPassword(String(body.password || ''), u.salt, u.hash)) bad('Password is incorrect');
      if (u.coupleId) await routes['POST /connect/leave'](req, {});
      await emails.delete(sha(u.email)); await users.delete(u.id); await subs.delete(u.id); await locs.delete(u.id);
      return { ok: true };
    },
  };

  return async function handle(req, path) {
    try {
      const key = `${req.method} ${path}`;
      const fn = routes[key];
      if (!fn) throw new HttpError(404, 'Not found');
      let body = {};
      if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
      const out = await fn(req, body || {});
      return Response.json(out, { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return Response.json({ error: status === 500 ? 'Something went wrong. Please try again.' : e.message }, { status, headers: { 'cache-control': 'no-store' } });
    }
  };
}

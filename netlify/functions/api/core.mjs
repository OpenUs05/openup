// OpenUS sync + live GPS API.
// A "room" is one couple's shared app data. Each phone gets its own device token.
// The app's own saved data is stored as-is (one string per storage key) and merged on the phones.
import crypto from 'node:crypto';

const DAY = 864e5;
const MAX_DOC = 4_000_000; // bytes

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => { throw new HttpError(400, m); };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = (n = 16) => crypto.randomBytes(n).toString('base64url');
const now = () => Date.now();
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function distM(a, b) {
  const R = 6371000, t = Math.PI / 180;
  const x = Math.sin((b.lat - a.lat) * t / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin((b.lng - a.lng) * t / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function makeApi({ store, pushSender }) {
  const rooms = store('rooms');
  const codes = store('codes');
  const devices = store('devices');
  const subs = store('push');

  async function device(req) {
    const h = req.headers.get('authorization') || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!tok) throw new HttpError(401, 'Not synced');
    const d = await devices.get(sha(tok), { type: 'json' });
    if (!d) throw new HttpError(401, 'This phone is no longer synced');
    return d;
  }
  async function newDevice(roomId) {
    const tok = rid(32);
    await devices.setJSON(sha(tok), { roomId, created: now() });
    return tok;
  }
  async function newCode(roomId) {
    for (let i = 0; i < 8; i++) {
      const code = Array.from(crypto.randomBytes(6)).map((b) => ALPHA[b % 32]).join('');
      const r = await codes.setJSON(code, { roomId, exp: now() + 7 * DAY }, { onlyIfNew: true });
      if (r && r.modified !== false) return code;
    }
    throw new HttpError(500, 'Could not make a code');
  }
  async function getRoom(id) {
    const r = await rooms.getWithMetadata(id, { type: 'json' });
    if (!r || !r.data) throw new HttpError(404, 'Sync not found');
    return r;
  }
  // compare-and-swap with retry (few writers per room)
  async function update(id, fn) {
    for (let i = 0; i < 8; i++) {
      const { data, etag } = await getRoom(id);
      const out = await fn(data);
      if (out === false) return data;
      const r = await rooms.setJSON(id, data, { onlyIfMatch: etag });
      if (r && r.modified !== false) return data;
      await new Promise((res) => setTimeout(res, 40 + Math.random() * 120));
    }
    throw new HttpError(409, 'Busy, try again');
  }
  function checkDoc(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) bad('Nothing to sync');
    for (const [k, v] of Object.entries(doc)) if (typeof k !== 'string' || (v !== null && typeof v !== 'string')) bad('Bad sync data');
    if (JSON.stringify(doc).length > MAX_DOC) bad('Too much data to sync (try smaller photos)');
  }
  function view(room) {
    const cut = now() - 2 * DAY;
    const locs = {};
    for (const [role, l] of Object.entries(room.locs || {})) if (l.ts > cut && l.sharing) locs[role] = { lat: l.lat, lng: l.lng, acc: l.acc, ts: l.ts, name: l.name };
    return { v: room.v, doc: room.doc, locs, gps: (room.gps || []).slice(0, 30), code: room.code || null };
  }
  async function notify(roomId, exceptRole, title, body, tag) {
    if (!pushSender) return;
    try {
      const rec = (await subs.get(roomId, { type: 'json' })) || { list: [] };
      rec.inbox = [{ title, body, tag, ts: now(), from: exceptRole }, ...(rec.inbox || [])].slice(0, 10);
      const keep = [];
      for (const s of rec.list) {
        if (s.role === exceptRole) { keep.push(s); continue; }
        const ok = await pushSender(s).catch(() => true);
        if (ok !== 'gone') keep.push(s);
      }
      rec.list = keep;
      await subs.setJSON(roomId, rec);
    } catch { /* best effort */ }
  }

  const routes = {
    'POST /sync/create': async (req, body) => {
      checkDoc(body.doc);
      const id = rid(12);
      const room = { id, v: 1, doc: body.doc, locs: {}, inside: {}, gps: [], created: now() };
      room.code = await newCode(id);
      await rooms.setJSON(id, room);
      const token = await newDevice(id);
      return { token, ...view(room) };
    },
    'POST /sync/join': async (req, body) => {
      const code = clean(body.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const c = await codes.get(code, { type: 'json' });
      if (!c || c.exp < now()) bad('That code is not valid or has expired. Make a new one on the other phone.');
      const { data } = await getRoom(c.roomId);
      const token = await newDevice(c.roomId);
      return { token, ...view(data) };
    },
    'GET /sync': async (req) => {
      const d = await device(req);
      const { data } = await getRoom(d.roomId);
      return view(data);
    },
    'POST /sync/push': async (req, body) => {
      const d = await device(req);
      checkDoc(body.doc);
      let conflict = null;
      const room = await update(d.roomId, (r) => {
        if (+body.v !== r.v) { conflict = r; return false; }
        r.doc = body.doc; r.v += 1; r.updated = now();
      });
      if (conflict) return { conflict: true, ...view(conflict) };
      return { ok: true, v: room.v };
    },
    'POST /sync/code': async (req) => {
      const d = await device(req);
      const code = await newCode(d.roomId);
      await update(d.roomId, (r) => { r.code = code; });
      return { code };
    },
    'POST /sync/leave': async (req) => {
      const tok = (req.headers.get('authorization') || '').slice(7);
      if (tok) await devices.delete(sha(tok));
      return { ok: true };
    },
    // Permanently delete this phone's synced space (required by the app stores).
    'POST /sync/delete': async (req) => {
      const d = await device(req);
      const { data } = await getRoom(d.roomId);
      if (data.code) await codes.delete(data.code);
      await rooms.delete(d.roomId);
      await subs.delete(d.roomId);
      const tok = (req.headers.get('authorization') || '').slice(7);
      await devices.delete(sha(tok));
      return { ok: true };
    },
    // Live GPS: store the position and detect arrive/leave at pinned safe places.
    'POST /sync/location': async (req, body) => {
      const d = await device(req);
      const role = clean(body.role, 40); if (!role) bad('Pick who you are first');
      const name = clean(body.name, 40) || role;
      const sharing = !!body.sharing;
      const lat = +body.lat, lng = +body.lng, acc = Math.round(+body.acc || 0);
      if (sharing && (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) bad('Bad location');
      const transitions = [];
      let alertsOn = true;
      await update(d.roomId, (r) => {
        r.locs = r.locs || {}; r.inside = r.inside || {}; r.gps = r.gps || [];
        if (!sharing) { delete r.locs[role]; delete r.inside[role]; return; }
        let gpsCfg = {};
        try { gpsCfg = JSON.parse(r.doc.openusGPS || '{}') || {}; } catch {}
        alertsOn = gpsCfg.alerts !== false;
        const places = gpsCfg.places || {};
        const prevInside = r.inside[role] || null;
        const inside = {};
        for (const [pname, p] of Object.entries(places)) {
          if (!isFinite(+p.lat) || !isFinite(+p.lng)) continue;
          const radius = Math.min(3000, Math.max(50, +p.radius || 300));
          const dm = distM({ lat, lng }, { lat: +p.lat, lng: +p.lng });
          const was = !!prevInside?.[pname];
          const is = was ? dm <= radius + 40 : dm <= radius;
          inside[pname] = is;
          if (prevInside && is !== was && acc < 300) transitions.push({ place: pname, arrived: is });
        }
        r.inside[role] = inside;
        r.locs[role] = { lat, lng, acc, ts: now(), name, sharing: true };
        for (const t of transitions) r.gps.unshift({ id: rid(6), role, name, place: t.place, arrived: t.arrived, ts: now() });
        r.gps = r.gps.filter((g) => g.ts > now() - 30 * DAY).slice(0, 200);
      });
      if (alertsOn) for (const t of transitions) await notify(d.roomId, role, `${name} ${t.arrived ? 'arrived at' : 'left'} ${t.place}`, 'OpenUS live location', 'gps');
      return { ok: true, transitions };
    },
    'POST /push/subscribe': async (req, body) => {
      const d = await device(req);
      const s = body.subscription, role = clean(body.role, 40);
      if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint)) bad('Bad subscription');
      const rec = (await subs.get(d.roomId, { type: 'json' })) || { list: [] };
      rec.list = [{ endpoint: s.endpoint, role }, ...rec.list.filter((x) => x.endpoint !== s.endpoint)].slice(0, 10);
      await subs.setJSON(d.roomId, rec);
      return { ok: true };
    },
    'POST /push/inbox': async (req, body) => {
      const d = await device(req);
      const role = clean(body.role, 40);
      const rec = (await subs.get(d.roomId, { type: 'json' })) || {};
      return { inbox: (rec.inbox || []).filter((n) => n.from !== role) };
    },
  };

  return async function handle(req, path) {
    try {
      const fn = routes[`${req.method} ${path}`];
      if (!fn) throw new HttpError(404, 'Not found');
      let body = {};
      if (req.method === 'POST') { try { body = (await req.json()) || {}; } catch { body = {}; } }
      return Response.json(await fn(req, body), { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return Response.json({ error: status === 500 ? 'Something went wrong. Please try again.' : e.message }, { status, headers: { 'cache-control': 'no-store' } });
    }
  };
}

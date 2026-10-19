import { makeApi } from '../netlify/functions/api/core.mjs';
import { makePushSender, generateVapidKeys } from '../netlify/functions/api/push.mjs';
import assert from 'node:assert/strict';

// in-memory stand-in for Netlify Blobs with etag semantics
const mem = {};
const store = (name) => {
  const m = (mem[name] ??= new Map());
  return {
    async get(k) { const e = m.get(k); return e ? structuredClone(e.v) : null; },
    async getWithMetadata(k) { const e = m.get(k); return e ? { data: structuredClone(e.v), etag: e.etag } : null; },
    async setJSON(k, v, o = {}) {
      const e = m.get(k);
      if (o.onlyIfNew && e) return { modified: false };
      if (o.onlyIfMatch && (!e || e.etag !== o.onlyIfMatch)) return { modified: false };
      const etag = Math.random().toString(36); m.set(k, { v: structuredClone(v), etag }); return { modified: true, etag };
    },
    async delete(k) { m.delete(k); },
  };
};
const pushed = [];
const api = makeApi({ store, pushSender: async (s) => { pushed.push(s.endpoint); return true; } });
async function call(method, path, body, token) {
  const req = new Request('https://x/api' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const r = await api(req, path); const j = await r.json(); return { status: r.status, ...j };
}

let a = await call('POST', '/signup', { email: 'Cavan@x.com', password: 'secret123', name: 'Cavan' });
assert.equal(a.status, 200); const ta = a.token;
assert.equal((await call('POST', '/signup', { email: 'cavan@x.com', password: 'secret123', name: 'C' })).status, 400, 'dup email');
assert.equal((await call('POST', '/login', { email: 'cavan@x.com', password: 'wrong' })).status, 401);
assert.equal((await call('POST', '/login', { email: 'cavan@x.com', password: 'secret123' })).status, 200);
let s = await call('POST', '/connect/create', null, ta);
const code = s.couple.inviteCode; assert.match(code, /^[A-Z0-9]{6}$/);
let b = await call('POST', '/signup', { email: 'sam@x.com', password: 'secret123', name: 'Sam' }); const tb = b.token;
await call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.example/a' } }, ta);
s = await call('POST', '/connect/join', { code: code.toLowerCase() }, tb);
assert.equal(s.couple.members.length, 2); assert.equal(s.partner.name, 'Cavan');
assert.equal(pushed.length, 1, 'cavan notified of join');
// third person cannot join (code consumed)
let c = await call('POST', '/signup', { email: 'z@x.com', password: 'secret123', name: 'Z' });
assert.equal((await call('POST', '/connect/join', { code }, c.token)).status, 400);
// agreement request flow
s = await call('POST', '/act', { type: 'request', name: 'No texting exes', value: true }, ta);
const rq = s.couple.requests.find(r => r.status === 'pending');
assert.equal((await call('POST', '/act', { type: 'decide', id: rq.id, ok: true }, ta)).status, 400, 'requester cannot self-approve');
s = await call('POST', '/act', { type: 'decide', id: rq.id, ok: true }, tb);
assert.equal(s.couple.agreements['No texting exes'], true);
// check-in
s = await call('POST', '/act', { type: 'checkin', mood: 'Great', note: 'hi' }, tb);
s = await call('GET', '/state', null, ta);
assert.equal(s.couple.checkins[0].from, s.partner.id);
// location + geofence
await call('POST', '/act', { type: 'perm', key: 'location', value: true }, tb);
await call('POST', '/act', { type: 'placeAdd', name: 'Home', lat: 52.13, lng: -106.67, radius: 200 }, ta);
await call('POST', '/location', { lat: 52.2, lng: -106.67, acc: 20 }, tb);
let l = await call('POST', '/location', { lat: 52.1301, lng: -106.6701, acc: 20 }, tb);
assert.deepEqual(l.transitions, [{ place: 'Home', arrived: true }]);
s = await call('GET', '/state', null, ta);
assert.ok(s.partnerLoc && Math.abs(s.partnerLoc.lat - 52.1301) < 1e-6, 'partner location visible');
assert.ok(s.couple.events.some(e => e.text === 'Sam arrived at Home'));
// location hidden when sharing off
await call('POST', '/act', { type: 'perm', key: 'location', value: false }, tb);
s = await call('GET', '/state', null, ta); assert.equal(s.partnerLoc, null);
// concurrent writes don't lose data
await Promise.all([1,2,3,4,5].map(i => call('POST', '/act', { type: 'contactAdd', name: 'P' + i }, i % 2 ? ta : tb)));
s = await call('GET', '/state', null, ta); assert.equal(s.couple.contacts.length, 5);
// auth required
assert.equal((await call('GET', '/state')).status, 401);
// leave
s = await call('POST', '/connect/leave', null, tb); assert.equal(s.couple, null);
s = await call('GET', '/state', null, ta); assert.equal(s.couple.members.length, 1); assert.equal(s.partner, null);
// reinvite works
s = await call('POST', '/connect/create', null, ta); assert.ok(s.couple.inviteCode);

// VAPID signer produces a valid ES256 JWT
const k = generateVapidKeys();
const send = makePushSender({ publicKey: k.publicKey, privateKey: k.privateKey });
let captured; globalThis.fetch = async (u, o) => { captured = o; return new Response(null, { status: 201 }); };
assert.equal(await send({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }), true);
assert.match(captured.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
console.log('ALL TESTS PASSED');

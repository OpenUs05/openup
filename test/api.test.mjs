import { makeApi } from '../netlify/functions/api/core.mjs';
import { makePushSender, generateVapidKeys } from '../netlify/functions/api/push.mjs';
import assert from 'node:assert/strict';
const mem = {};
export const store = (name) => { const m = (mem[name] ??= new Map()); return {
  async get(k) { const e = m.get(k); return e ? structuredClone(e.v) : null; },
  async getWithMetadata(k) { const e = m.get(k); return e ? { data: structuredClone(e.v), etag: e.etag } : null; },
  async setJSON(k, v, o = {}) { const e = m.get(k); if (o.onlyIfNew && e) return { modified: false }; if (o.onlyIfMatch && (!e || e.etag !== o.onlyIfMatch)) return { modified: false }; const etag = Math.random().toString(36); m.set(k, { v: structuredClone(v), etag }); return { modified: true, etag }; },
  async delete(k) { m.delete(k); } }; };
const pushed = [];
const api = makeApi({ store, pushSender: async (s) => { pushed.push(s.role); return true; } });
async function call(method, path, body, token) {
  const req = new Request('https://x/api' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const r = await api(req, path); return { status: r.status, ...(await r.json()) };
}
const doc = { openusAppV2: JSON.stringify({ names: { a: 'Cavan', b: 'Bri' } }), openusGPS: null };
const A = await call('POST', '/sync/create', { doc });
assert.match(A.code, /^[A-Z0-9]{6}$/); assert.equal(A.v, 1);
const B = await call('POST', '/sync/join', { code: A.code.toLowerCase() });
assert.equal(B.doc.openusAppV2, doc.openusAppV2);
assert.equal((await call('POST', '/sync/join', { code: 'ZZZZZZ' })).status, 400);
// push + conflict
let r = await call('POST', '/sync/push', { v: 1, doc: { ...doc, openusAppV2: '{"x":1}' } }, A.token); assert.equal(r.v, 2);
r = await call('POST', '/sync/push', { v: 1, doc: { ...doc, openusAppV2: '{"x":2}' } }, B.token); assert.equal(r.conflict, true); assert.equal(r.doc.openusAppV2, '{"x":1}');
// GPS: pin Home, B arrives -> A notified
await call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.example/a' }, role: 'a' }, A.token);
await call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.example/b' }, role: 'b' }, B.token);
r = await call('POST', '/sync/push', { v: 2, doc: { ...doc, openusGPS: JSON.stringify({ places: { Home: { lat: 52.13, lng: -106.67, radius: 200 } }, alerts: true }) } }, A.token); assert.equal(r.v, 3);
r = await call('POST', '/sync/location', { role: 'b', name: 'Bri', sharing: true, lat: 52.2, lng: -106.67, acc: 10 }, B.token); assert.deepEqual(r.transitions, []);
r = await call('POST', '/sync/location', { role: 'b', name: 'Bri', sharing: true, lat: 52.1301, lng: -106.6701, acc: 10 }, B.token);
assert.deepEqual(r.transitions, [{ place: 'Home', arrived: true }]);
assert.deepEqual(pushed, ['a'], 'only partner gets push');
let s = await call('GET', '/sync', null, A.token);
assert.equal(s.locs.b.name, 'Bri'); assert.equal(s.gps[0].place, 'Home');
let inbox = await call('POST', '/push/inbox', { role: 'a' }, A.token); assert.equal(inbox.inbox[0].title, 'Bri arrived at Home');
// leaving
r = await call('POST', '/sync/location', { role: 'b', name: 'Bri', sharing: true, lat: 52.2, lng: -106.67, acc: 10 }, B.token);
assert.deepEqual(r.transitions, [{ place: 'Home', arrived: false }]);
// stop sharing hides location
await call('POST', '/sync/location', { role: 'b', sharing: false }, B.token);
s = await call('GET', '/sync', null, A.token); assert.equal(s.locs.b, undefined);
// leave revokes token
await call('POST', '/sync/leave', {}, B.token); assert.equal((await call('GET', '/sync', null, B.token)).status, 401);
assert.equal((await call('GET', '/sync')).status, 401);
const k = generateVapidKeys(); const send = makePushSender({ publicKey: k.publicKey, privateKey: k.privateKey });
let cap; globalThis.fetch = async (u, o) => { cap = o; return new Response(null, { status: 201 }); };
assert.equal(await send({ endpoint: 'https://fcm.googleapis.com/fcm/send/x' }), true); assert.match(cap.headers.Authorization, /^vapid t=/);
console.log('ALL TESTS PASSED');

// Local test server: serves public/ and the API with in-memory storage.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { makeApi } from '../netlify/functions/api/core.mjs';
const mem = {};
const store = (name) => { const m = (mem[name] ??= new Map()); return {
  async get(k) { const e = m.get(k); return e ? structuredClone(e.v) : null; },
  async getWithMetadata(k) { const e = m.get(k); return e ? { data: structuredClone(e.v), etag: e.etag } : null; },
  async setJSON(k, v, o = {}) { const e = m.get(k); if (o.onlyIfNew && e) return { modified: false }; if (o.onlyIfMatch && (!e || e.etag !== o.onlyIfMatch)) return { modified: false }; const etag = Math.random().toString(36); m.set(k, { v: structuredClone(v), etag }); return { modified: true, etag }; },
  async delete(k) { m.delete(k); } }; };
const api = makeApi({ store, pushSender: null });
const root = new URL('../public/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = new Request(url, { method: req.method, headers: req.headers, body: ['GET','HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const p = url.pathname.replace(/^\/api/, '');
    const out = p === '/config' ? Response.json({ vapidPublicKey: null }) : await api(r, p);
    res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer())); return;
  }
  let f = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(8787, () => console.log('dev on 8787'));

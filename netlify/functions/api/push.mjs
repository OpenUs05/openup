// Minimal Web Push sender (no payload, so no encryption needed). The service worker
// fetches the actual notification text from /api/push/inbox when the push arrives.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function makePushSender({ publicKey, privateKey, subject }) {
  if (!publicKey || !privateKey) return null;
  const pub = Buffer.from(publicKey, 'base64url'); // 65-byte uncompressed P-256 point
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privateKey },
    format: 'jwk',
  });
  return async function send(sub) {
    const aud = new URL(sub.endpoint).origin;
    const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject || 'mailto:openus@example.com' }));
    const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
    const jwt = `${header}.${claims}.${b64u(sig)}`;
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { TTL: '86400', Urgency: 'high', Authorization: `vapid t=${jwt}, k=${publicKey}`, 'Content-Length': '0' },
    });
    if (r.status === 404 || r.status === 410) return 'gone';
    return r.ok;
  };
}

export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { publicKey: b64u(pub), privateKey: jwk.d };
}

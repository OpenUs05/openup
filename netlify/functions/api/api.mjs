import { getStore } from '@netlify/blobs';
import { makeApi } from './core.mjs';
import { makePushSender } from './push.mjs';

let handler;
function getHandler() {
  if (!handler) {
    const pushSender = makePushSender({
      publicKey: Netlify.env.get('VAPID_PUBLIC_KEY'),
      privateKey: Netlify.env.get('VAPID_PRIVATE_KEY'),
      subject: Netlify.env.get('VAPID_SUBJECT'),
    });
    handler = makeApi({ store: (name) => getStore({ name: `openus-${name}`, consistency: 'strong' }), pushSender });
  }
  return handler;
}

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/^\/api/, '') || '/';
  if (req.method === 'GET' && path === '/config') {
    return Response.json({ vapidPublicKey: Netlify.env.get('VAPID_PUBLIC_KEY') || null }, { headers: { 'cache-control': 'no-store' } });
  }
  return getHandler()(req, path);
};

export const config = { path: '/api/*' };

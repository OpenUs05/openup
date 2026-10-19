// OpenUS service worker: offline app shell + push notifications.
const SHELL = 'openus-shell-v2';
const AUTH = 'openus-auth';
const FILES = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== AUTH).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // network first so updates show up right away; cached shell when offline
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok && FILES.includes(url.pathname)) caches.open(SHELL).then((c) => c.put(e.request, r.clone()));
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match('/index.html')))
  );
});

// The page hands us its session token so a push can fetch the real message text.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'token') {
    e.waitUntil(caches.open(AUTH).then((c) => e.data.token ? c.put('/__token', new Response(e.data.token)) : c.delete('/__token')));
  }
});

async function latest() {
  try {
    const c = await caches.open(AUTH);
    const r = await c.match('/__token');
    if (!r) return null;
    const token = await r.text();
    const res = await fetch('/api/push/inbox', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
    const j = await res.json();
    return (j.inbox || [])[0] || null;
  } catch { return null; }
}

self.addEventListener('push', (e) => {
  e.waitUntil(latest().then((n) => self.registration.showNotification(n ? n.title : 'OpenUS', {
    body: n ? n.body : 'You have new activity',
    icon: '/icon-192.png', badge: '/icon-192.png', tag: n ? n.tag : 'openus', renotify: true,
  })));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('/');
  }));
});

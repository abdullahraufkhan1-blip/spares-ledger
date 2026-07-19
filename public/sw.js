// Minimal service worker: makes the app installable and paints a clean offline notice.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() =>
    new Response(
      '<meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;background:#EEF0F3;display:flex;height:100vh;align-items:center;justify-content:center"><div style="text-align:center"><h2 style="color:#23386B">Spares Ledger is offline</h2><p style="color:#69707C">Check your internet connection and reload.</p></div></body>',
      { headers: { 'Content-Type': 'text/html' } })
  ));
});

self.addEventListener('push', e => {
  let d = { title: 'Spares Ledger', body: '' };
  try { d = e.data.json(); } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    tag: 'spares-alert', renotify: true,
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow('/');
  }));
});

/* Agentic OS — Web Push service worker (Phase 10).
 * Receives aes128gcm-encrypted pushes from the kernel (VAPID-authenticated),
 * decrypts them via the Push API, and shows a OS notification. Clicking it
 * focuses the OS dashboard. */
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Agentic OS', body: 'New notification', url: '/' };
  try {
    data = event.data ? event.data.json() : data;
  } catch { /* fallback payload above */ }
  event.waitUntil(self.registration.showNotification(data.title || 'Agentic OS', {
    body: data.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag || 'agentic-os',
    data: { url: data.url || '/' },
    requireInteraction: false,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});

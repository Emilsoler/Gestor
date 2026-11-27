// Service worker del panel máster: solo muestra los avisos de los chats (no guarda copias de la app ni de datos).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { c: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(String(d.t || 'Mutual Bell'), { body: String(d.c || ''), icon: '../icons/apple-touch-icon.png' }));
});
// La función manda la dirección de Créditos y Cobros; un aviso del panel abre siempre los chats del panel.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mia = abiertas.find((c) => new URL(c.url).pathname.startsWith(new URL(self.registration.scope).pathname));
    if (mia) { mia.postMessage({ abrir: 'chats' }); await mia.focus(); return; }
    await self.clients.openWindow(new URL('./#chats', self.registration.scope).href);
  })());
});

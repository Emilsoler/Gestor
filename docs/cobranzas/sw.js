// Service worker de cobranzas: hace que la app abra sin conexión y que siempre use la última versión.
// Igual que el del gestor (../sw.js): los archivos de la app van primero a la red y, si no hay o
// tarda, se usa la copia guardada; tipografías e íconos, primero la copia; la base de datos, siempre
// directo a la red (acá no se guardan datos). Comparte con el gestor la librería de la base, la
// configuración, las cuentas de importes, el armado de Excel y las tipografías (../).
//
// Al cambiar la lista de archivos o una tipografía/ícono, subir VERSION para renovar la copia.
const VERSION = 'cobranzas-v65';
const ESPERA_MS = 4000;

const NUCLEO = [
  './', 'styles.css', 'app.js', 'datos.js', 'calculo.js', 'textos.js', 'creditos.js', 'chat.js', 'vehiculos.js', 'refinanciacion.js', 'acuerdo.js', 'demanda.js', 'descuento.js', 'agencias.js', 'prendaforms.js', 'modelos/acuerdo-refinanciacion.docx', 'modelos/demanda-prendaria.docx', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  '../vendor/supabase.js', '../config.js', '../liquidacion.js', '../excel.js', '../oficio.js', '../agencias/solicitud.js',
  '../fonts/plex-sans-latin-300.woff2', '../fonts/plex-sans-latin-400.woff2', '../fonts/plex-sans-latin-500.woff2', '../fonts/plex-sans-latin-600.woff2',
  '../fonts/plex-mono-latin-400.woff2', '../fonts/plex-mono-latin-500.woff2',
  '../fonts/cinzel-latin-400-normal.woff2', '../fonts/eb-garamond-latin-400-italic.woff2', '../fonts/poppins-latin-600-normal.woff2', '../fonts/poppins-latin-700-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(NUCLEO)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  // Solo las copias propias: las del gestor (gestor-v…) son de su service worker.
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('cobranzas-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const pedido = e.request, url = new URL(pedido.url);
  if (pedido.method !== 'GET' || url.origin !== self.location.origin) return;
  const fijo = /\/(fonts|icons)\//.test(url.pathname);
  e.respondWith(fijo ? copiaPrimero(pedido) : redPrimero(e, pedido));
});

async function guardar(pedido, respuesta) {
  if (respuesta && respuesta.ok && respuesta.type === 'basic') {
    const c = await caches.open(VERSION);
    await c.put(pedido, respuesta.clone());
  }
  return respuesta;
}

async function copiaPrimero(pedido) {
  return (await caches.match(pedido)) || guardar(pedido, await fetch(pedido));
}

async function redPrimero(e, pedido) {
  const deRed = fetch(pedido, { cache: 'no-cache' }).then((r) => guardar(pedido, r));
  e.waitUntil(deRed.catch(() => {}));
  const espera = new Promise((ok) => setTimeout(ok, ESPERA_MS, null));
  try {
    const r = await Promise.race([deRed, espera]);
    if (r) return r;
  } catch { /* sin red: se usa la copia */ }
  const copia = (await caches.match(pedido, { ignoreSearch: true })) || (pedido.mode === 'navigate' ? await caches.match('./') : null);
  return copia || deRed;
}

// ───────────────────────── Avisos (Web Push) ─────────────────────────
// La función `agencias` manda un aviso cuando una agencia quiere hablar con la Mutual. En el iPhone solo llegan con la
// app instalada en la pantalla de inicio, y cada aviso tiene que mostrarse (userVisibleOnly): por eso siempre se muestra.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { c: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(String(d.t || 'Mutual Bell'), {
    body: String(d.c || ''), icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { u: String(d.u || '') },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.u || '/Gestor/cobranzas/#agencias-chats', self.location.origin).href;
  e.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mia = abiertas.find((c) => new URL(c.url).pathname.startsWith(new URL(self.registration.scope).pathname));
    if (mia) { mia.postMessage({ abrir: 'agencias-chats' }); await mia.focus(); return; } // ya abierta: se avisa y se enfoca
    await self.clients.openWindow(url);
  })());
});

// Service worker de cobranzas: hace que la app abra sin conexión y que siempre use la última versión.
// Igual que el del gestor (../sw.js): los archivos de la app van primero a la red y, si no hay o
// tarda, se usa la copia guardada; tipografías e íconos, primero la copia; la base de datos, siempre
// directo a la red (acá no se guardan datos). Comparte con el gestor la librería de la base, la
// configuración, las cuentas de importes, el armado de Excel y las tipografías (../).
//
// Al cambiar la lista de archivos o una tipografía/ícono, subir VERSION para renovar la copia.
const VERSION = 'cobranzas-v2';
const ESPERA_MS = 4000;

const NUCLEO = [
  './', 'styles.css', 'app.js', 'datos.js', 'calculo.js', 'textos.js', 'creditos.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  '../vendor/supabase.js', '../config.js', '../liquidacion.js', '../excel.js',
  '../fonts/plex-sans-latin-300.woff2', '../fonts/plex-sans-latin-400.woff2', '../fonts/plex-sans-latin-500.woff2', '../fonts/plex-sans-latin-600.woff2',
  '../fonts/plex-mono-latin-400.woff2', '../fonts/plex-mono-latin-500.woff2',
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

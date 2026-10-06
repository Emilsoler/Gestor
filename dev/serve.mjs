// Sirve docs/ en http://127.0.0.1:8080 apuntando al stack local (dev/stack.sh up).
// Cambia dos cosas respecto de lo publicado, sin tocar los archivos:
//   - config.js apunta a la base local (y relee cada 2 s, para que las pruebas no esperen)
//   - la política de seguridad permite conectarse a 127.0.0.1:54321
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const STACK = process.env.STACK || '/home/claude/.stack';
const env = Object.fromEntries(readFileSync(`${STACK}/keys.env`, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const PORT = +process.env.PORT || 8080;
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

http.createServer(async (req, res) => {
  try {
    let ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (ruta.endsWith('/')) ruta += 'index.html';
    if (ruta === '/config.js') {
      res.writeHead(200, { 'content-type': TIPOS['.js'], 'cache-control': 'no-store' });
      // ?sondeo=ms en la dirección de la página cambia cada cuánto relee (para las pruebas de tiempo real)
      return res.end(`window.GESTOR_CONFIG = Object.assign(${JSON.stringify({ url: env.SUPABASE_URL, key: env.ANON_KEY })}, { sondeoMs: +new URLSearchParams(location.search).get('sondeo') || ${+process.env.SONDEO_MS || 2000} });`);
    }
    const archivo = normalize(join(docs, ruta));
    if (!archivo.startsWith(docs)) { res.writeHead(403); return res.end(); }
    let cuerpo = await readFile(archivo);
    if (ruta === '/index.html') {
      cuerpo = Buffer.from(String(cuerpo).replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:54321 ws://127.0.0.1:54321"));
    }
    res.writeHead(200, { 'content-type': TIPOS[extname(archivo)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(cuerpo);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no encontrado');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`app en http://127.0.0.1:${PORT}`));

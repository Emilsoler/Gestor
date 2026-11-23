// Doble del almacenamiento de Supabase (Storage) para las pruebas locales: lo justo que usa la función
// `agencias` para los documentos de las solicitudes. La puerta local (gateway.mjs) le pasa /storage/v1/*.
//   POST   /object/{carpeta}/{ruta}              subir (clave de servicio; content-type = tipo del archivo)
//   DELETE /object/{carpeta}   {prefixes:[…]}    borrar
//   POST   /object/sign/{carpeta}/{ruta}         enlace firmado → {signedURL: "/object/sign/…?token=…"}
//   GET    /object/sign/{carpeta}/{ruta}?token=  bajar con el enlace (sin clave, como el real)
// Todo en memoria. GET /__objetos lista lo guardado y DELETE /__objetos lo vacía (para las pruebas).
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = +process.env.STORAGE_FALSO_PORT || 54344;
const SERVICIO = process.env.SERVICE_KEY || '';
const MAX = 10 * 1024 * 1024;
const objetos = new Map(); // "carpeta/ruta" → { bytes, tipo }
const firmas = new Map(); // token → "carpeta/ruta"

const json = (res, status, cuerpo) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(cuerpo));
const conClave = (req) => !SERVICIO || req.headers.authorization === `Bearer ${SERVICIO}`;

function leer(req, tope) {
  return new Promise((ok, mal) => {
    const partes = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > tope) { mal(new Error('grande')); req.destroy(); } else partes.push(c); });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', mal);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ruta = decodeURIComponent(url.pathname);
  try {
    if (ruta === '/__objetos' && req.method === 'DELETE') { objetos.clear(); firmas.clear(); return json(res, 200, []); }
    if (ruta === '/__objetos') return json(res, 200, [...objetos.entries()].map(([k, v]) => ({ clave: k, tipo: v.tipo, tamano: v.bytes.length })));
    let m = ruta.match(/^\/object\/sign\/(.+)$/);
    if (m && req.method === 'GET') {
      const clave = firmas.get(url.searchParams.get('token') || '');
      const o = clave === m[1] && objetos.get(clave);
      if (!o) return json(res, 400, { statusCode: '400', error: 'InvalidJWT', message: 'invalid signature' });
      return res.writeHead(200, { 'content-type': o.tipo, 'content-length': o.bytes.length }).end(o.bytes);
    }
    if (!conClave(req)) return json(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'falta la clave' });
    if (m && req.method === 'POST') {
      if (!objetos.has(m[1])) return json(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const token = randomBytes(16).toString('hex');
      firmas.set(token, m[1]);
      return json(res, 200, { signedURL: `/object/sign/${m[1]}?token=${token}` });
    }
    m = ruta.match(/^\/object\/([^/]+)\/(.+)$/);
    if (m && req.method === 'POST') {
      const clave = `${m[1]}/${m[2]}`;
      if (objetos.has(clave) && req.headers['x-upsert'] !== 'true') return json(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      const tipo = String(req.headers['content-type'] || '');
      // Los mismos tipos que admiten las carpetas reales (migraciones 0028 y 0040).
      const admitidos = m[1] === 'chat-audios' ? ['audio/mp4', 'audio/webm', 'audio/ogg'] : ['application/pdf', 'image/jpeg'];
      if (!admitidos.includes(tipo)) return json(res, 400, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${tipo} is not supported` });
      const bytes = await leer(req, MAX);
      objetos.set(clave, { bytes, tipo });
      return json(res, 200, { Key: clave, Id: randomBytes(8).toString('hex') });
    }
    m = ruta.match(/^\/object\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      const { prefixes = [] } = JSON.parse(String(await leer(req, 1e6)) || '{}');
      const borrados = prefixes.filter((p) => objetos.delete(`${m[1]}/${p}`)).map((p) => ({ name: p }));
      return json(res, 200, borrados);
    }
    json(res, 404, { statusCode: '404', error: 'not_found', message: 'no route' });
  } catch (e) {
    json(res, e.message === 'grande' ? 413 : 500, { statusCode: '413', error: 'Payload too large', message: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log('storage-falso en', PORT));

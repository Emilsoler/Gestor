// Un doble mínimo de Traccar para las pruebas locales (en 127.0.0.1:54342). La función `ubicar`
// corre apuntando acá (TRACCAR_URL) cuando el vehículo tiene traccar_id, así se prueba el camino
// con equipo sin depender de un servidor de rastreo real.
//
//   POST /__pos  { "<deviceId>": { latitude, longitude, speed, course, deviceTime, attributes }, … }
//   GET  /api/positions   devuelve esas posiciones (como Traccar), si el token es válido
import http from 'node:http';

const PORT = +process.env.TRACCAR_FALSO_PORT || 54342;
const TOKEN = process.env.TRACCAR_FALSO_TOKEN || 'prueba';
let pos = {};

const leer = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });

http.createServer(async (req, res) => {
  const cuerpo = await leer(req);
  if (req.url === '/__pos' && req.method === 'POST') {
    try { pos = JSON.parse(cuerpo || '{}'); } catch { pos = {}; }
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: Object.keys(pos).length }));
  }
  if (req.url.startsWith('/api/positions')) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${TOKEN}`) return res.writeHead(401).end('no autorizado');
    const lista = Object.entries(pos).map(([deviceId, p]) => ({ deviceId: +deviceId || deviceId, ...p }));
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(lista));
  }
  res.writeHead(404).end('no');
}).listen(PORT, '127.0.0.1', () => console.log('traccar falso en', PORT));

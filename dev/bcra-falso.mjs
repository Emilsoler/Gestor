// Un doble de la API Central de Deudores del BCRA para las pruebas locales (en 127.0.0.1:54341).
// La función `bcra` corre en local apuntando acá (BCRA_URL), así se prueba de punta a punta sin
// depender del BCRA ni consultar a personas reales.
//
//   POST   /__casos     { "<cuit>": { deudas, historicas, cheques }, … }  reemplaza los casos. Cada endpoint:
//                       { results: {…} }  responde 200 con eso, como el BCRA
//                       null o ausente    responde 404 ("No se encontró datos…"), como el BCRA
//                       { status: 500 }   responde ese error
//                       { cuerpo: {…} }   responde 200 con ese cuerpo tal cual (p. ej. un 404 dentro de un 200)
//                       { cortar: true }  corta la conexión sin responder
//   GET    /__pedidos   las rutas pedidas, en orden
//   DELETE /__pedidos   las olvida (y los casos)
import http from 'node:http';

const PORT = +process.env.BCRA_FALSO_PORT || 54341;
let casos = {};
let pedidos = [];

const leer = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
const json = (res, status, cuerpo) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(cuerpo));
const MENSAJES = {
  400: 'Parámetro erróneo: Ingresar 11 dígitos para realizar la consulta.',
  404: 'No se encontró datos para la identificación ingresada.',
  500: 'Se produjo un error al ejecutar la acción.',
};

http.createServer(async (req, res) => {
  const cuerpo = await leer(req);
  if (req.url === '/__casos' && req.method === 'POST') { casos = JSON.parse(cuerpo || '{}'); return json(res, 200, { casos: Object.keys(casos).length }); }
  if (req.url === '/__pedidos' && req.method === 'GET') return json(res, 200, pedidos);
  if (req.url === '/__pedidos' && req.method === 'DELETE') { pedidos = []; casos = {}; return json(res, 200, {}); }

  // Como el servidor del BCRA, sin distinguir mayúsculas.
  const m = /^\/centraldedeudores\/v1\.0\/deudas\/(?:(historicas|chequesrechazados)\/)?([^/?]+)$/i.exec(req.url);
  if (req.method !== 'GET' || !m) return json(res, 404, { status: 404, errorMessages: ['Ruta inexistente'] });
  pedidos.push(req.url);
  const endpoint = { historicas: 'historicas', chequesrechazados: 'cheques' }[(m[1] || '').toLowerCase()] || 'deudas';
  const id = m[2];
  if (!/^\d{11}$/.test(id)) return json(res, 400, { status: 400, errorMessages: [MENSAJES[400]] });
  const caso = casos[id]?.[endpoint];
  if (caso?.cortar) return req.socket.destroy();
  if (caso?.cuerpo) return json(res, 200, caso.cuerpo);
  if (caso?.status) return json(res, caso.status, { status: caso.status, errorMessages: [MENSAJES[caso.status] || 'Error'] });
  if (caso?.results) return json(res, 200, { status: 200, results: caso.results });
  return json(res, 404, { status: 404, errorMessages: [MENSAJES[404]] });
}).listen(PORT, '127.0.0.1', () => console.log('bcra falso en', PORT));

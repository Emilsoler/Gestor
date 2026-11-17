// Un doble de la API de InfoAuto para las pruebas locales (en 127.0.0.1:54343). La función `agencias`
// corre en local apuntando acá (INFOAUTO_API), así se prueba de punta a punta sin gastar consultas reales.
// Los vehículos y precios son inventados. Pagina como InfoAuto (page, page_size y cabecera X-Pagination).
//
//   GET    /__pedidos   las rutas pedidas (con la consulta), en orden
//   DELETE /__pedidos   las olvida
import http from 'node:http';

const PORT = +process.env.INFOAUTO_FALSO_PORT || 54343;
const USUARIO = 'agencia-prueba', CLAVE = 'clave-prueba';
let pedidos = [];

// 3 marcas (una sin precios); 120 modelos de una marca, para obligar a paginar.
const MARCAS = [
  { id: 1, name: 'MARCA UNO', prices: true, list_price: true },
  { id: 2, name: 'MARCA DOS', prices: true, list_price: false },
  { id: 3, name: 'MARCA SIN PRECIOS', prices: false, list_price: false },
];
const GRUPOS = {
  1: [{ id: 10, name: 'SEDAN', prices: true, list_price: true, prices_from: 2015, prices_to: 2026 },
      { id: 11, name: 'VIEJITO', prices: true, list_price: false, prices_from: 1995, prices_to: 2001 }],
  2: Array.from({ length: 120 }, (_, k) => ({ id: 100 + k, name: `MODELO ${String(k).padStart(3, '0')}`, prices: true, list_price: false, prices_from: 2018, prices_to: 2024 })),
};
const MODELOS = {
  '1/10': [
    { codia: 500001, description: 'SEDAN 1.6 BASE        L/24', prices: true, list_price: true, prices_from: 2020, prices_to: 2026 },
    { codia: 500002, description: 'SEDAN 2.0 FULL', prices: true, list_price: false, prices_from: 2015, prices_to: 2022 },
  ],
  '1/11': [{ codia: 500009, description: 'VIEJITO 1.0', prices: true, list_price: false, prices_from: 1995, prices_to: 2001 }],
};
// Precios en miles de pesos, como InfoAuto.
const PRECIOS = {
  500001: [{ year: 2026, price: 30000 }, { year: 2024, price: 25000 }, { year: 2020, price: 18000 }],
  500002: [{ year: 2022, price: 20000 }, { year: 2015, price: 9000 }],
  500009: [{ year: 2001, price: 3000 }],
};
const LISTA = { 500001: { list_price: 35000 } };

const json = (res, status, cuerpo, extra = {}) => res.writeHead(status, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(cuerpo));

function paginar(res, xs, u) {
  const size = Math.min(+u.searchParams.get('page_size') || 20, 100), page = Math.max(+u.searchParams.get('page') || 1, 1);
  const total_pages = Math.max(1, Math.ceil(xs.length / size));
  json(res, 200, xs.slice((page - 1) * size, page * size), { 'x-pagination': JSON.stringify({ page, page_size: size, total: xs.length, total_pages }) });
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__pedidos') {
    if (req.method === 'DELETE') { pedidos = []; return json(res, 200, {}); }
    return json(res, 200, pedidos);
  }
  pedidos.push(u.pathname + u.search);
  if (u.pathname === '/cars/auth/login') {
    const ok = req.headers.authorization === `Basic ${Buffer.from(`${USUARIO}:${CLAVE}`).toString('base64')}`;
    return ok ? json(res, 200, { access_token: 'acceso-falso', refresh_token: 'refresco-falso' }) : json(res, 401, { message: 'credenciales' });
  }
  if (u.pathname === '/cars/auth/refresh') return json(res, 200, { access_token: 'acceso-falso' });
  if (req.headers.authorization !== 'Bearer acceso-falso') return json(res, 401, { message: 'token' });
  const p = u.pathname.replace(/^\/cars\/pub/, '');
  let m;
  if (p === '/current_year') return json(res, 200, { year: 2026 });
  if (p === '/brands/') return paginar(res, MARCAS, u);
  if ((m = p.match(/^\/brands\/(\d+)\/groups\/$/))) return paginar(res, GRUPOS[m[1]] || [], u);
  if ((m = p.match(/^\/brands\/(\d+)\/groups\/(\d+)\/models\/$/))) return paginar(res, MODELOS[`${m[1]}/${m[2]}`] || [], u);
  if ((m = p.match(/^\/models\/(\d+)\/prices\/$/))) return PRECIOS[m[1]] ? json(res, 200, PRECIOS[m[1]]) : json(res, 404, {});
  if ((m = p.match(/^\/models\/(\d+)\/list_price$/))) return LISTA[m[1]] ? json(res, 200, LISTA[m[1]]) : json(res, 404, {});
  json(res, 404, { message: 'no existe' });
}).listen(PORT, '127.0.0.1');

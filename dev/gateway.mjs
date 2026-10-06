// Puerta de entrada local que imita la de Supabase:
//   /auth/v1/*  -> GoTrue      /rest/v1/* -> PostgREST
// Exige el header `apikey`, igual que la plataforma.
//
// Realtime: el servidor real no se puede correr acá, así que hay un doble mínimo del
// protocolo (Phoenix) que alcanza para probar el camino "la base avisa → la app relee".
// Arranca apagado, que es el caso que la app debe tolerar siempre; se prende con
// POST /__realtime {"activo":true}. Los avisos salen de NOTIFY gestor_rt (ver stack.sh).
import http from 'node:http';
import { WebSocketServer } from 'ws';
import pg from 'pg';

const PORT = +process.env.GATEWAY_PORT || 54321;
const ROUTES = [
  ['/auth/v1', { host: '127.0.0.1', port: +process.env.GOTRUE_PORT || 9999 }],
  ['/rest/v1', { host: '127.0.0.1', port: +process.env.PGRST_PORT || 3000 }],
];
const KEYS = new Set((process.env.API_KEYS || '').split(',').filter(Boolean));
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers':
    'authorization,apikey,content-type,prefer,range,accept-profile,content-profile,x-client-info,x-supabase-api-version,accept',
  'access-control-expose-headers': 'content-range,content-profile,x-supabase-api-version',
  'access-control-max-age': '600',
};

// Para probar cortes: POST /__caido {"caido":true} hace que todo responda 503.
let caido = false;
let realtime = false;

http
  .createServer((req, res) => {
    if (req.url === '/__caido') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        try { caido = !!JSON.parse(b || '{}').caido; } catch {}
        res.writeHead(200, CORS).end(JSON.stringify({ caido }));
      });
      return;
    }
    if (req.url === '/__realtime') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        try { realtime = !!JSON.parse(b || '{}').activo; } catch {}
        if (!realtime) for (const ws of sockets.keys()) ws.terminate(); // se cae, como una conexión que se corta
        res.writeHead(200, CORS).end(JSON.stringify({ realtime }));
      });
      return;
    }
    if (req.method === 'OPTIONS') { // como la plataforma: acepta los headers que el cliente anuncie
      const pedidos = req.headers['access-control-request-headers'];
      return res.writeHead(204, pedidos ? { ...CORS, 'access-control-allow-headers': pedidos } : CORS).end();
    }
    if (caido) return res.writeHead(503, { ...CORS, 'content-type': 'application/json' }).end('{"message":"caido"}');
    const route = ROUTES.find(([p]) => req.url === p || req.url.startsWith(p + '/') || req.url.startsWith(p + '?'));
    if (!route) return res.writeHead(404, { ...CORS, 'content-type': 'application/json' }).end('{"message":"no route"}');
    const key = req.headers.apikey || new URL(req.url, 'http://x').searchParams.get('apikey');
    if (KEYS.size && !KEYS.has(key))
      return res.writeHead(401, { ...CORS, 'content-type': 'application/json' }).end('{"message":"Invalid API key"}');
    const [prefix, target] = route;
    const headers = { ...req.headers, host: `${target.host}:${target.port}` };
    // PostgREST recibe el JWT del usuario o, si no hay, la clave pública como identidad anónima.
    if (!headers.authorization && key) headers.authorization = `Bearer ${key}`;
    const up = http.request(
      { ...target, method: req.method, path: req.url.slice(prefix.length) || '/', headers },
      (r) => {
        const h = { ...r.headers };
        for (const k of Object.keys(h)) if (k.startsWith('access-control-')) delete h[k];
        res.writeHead(r.statusCode, { ...h, ...CORS });
        r.pipe(res);
      },
    );
    up.on('error', (e) => res.writeHead(502, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ message: String(e) })));
    req.pipe(up);
  })
  .on('upgrade', (req, socket, head) => {
    if (!realtime || !req.url.startsWith('/realtime/v1/websocket')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, atender);
  })
  .listen(PORT, '127.0.0.1', () => console.log('gateway en', PORT));

// ───────── Doble de Realtime ─────────
const wss = new WebSocketServer({ noServer: true });
const sockets = new Map(); // ws -> Map(topic -> { joinRef, cambios, enviar })

function atender(ws) {
  const canales = new Map();
  sockets.set(ws, canales);
  ws.on('close', () => sockets.delete(ws));
  ws.on('message', (crudo) => {
    let m; try { m = JSON.parse(String(crudo)); } catch { return; }
    const v2 = Array.isArray(m); // serializador v2: [join_ref, ref, topic, event, payload]
    const [joinRef, ref, topic, evento, carga] = v2 ? m : [m.join_ref, m.ref, m.topic, m.event, m.payload];
    const enviar = (jr, r, t, e, p) => ws.send(JSON.stringify(v2 ? [jr, r, t, e, p] : { join_ref: jr, ref: r, topic: t, event: e, payload: p }));
    if (evento === 'heartbeat') return enviar(null, ref, 'phoenix', 'phx_reply', { status: 'ok', response: {} });
    if (evento === 'phx_join') {
      const cambios = (carga?.config?.postgres_changes || []).map((b, i) => ({ ...b, id: 1000 + i }));
      canales.set(topic, { joinRef, cambios, enviar });
      enviar(joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: cambios } });
      return enviar(joinRef, null, topic, 'system', { status: 'ok', extension: 'postgres_changes', channel: topic.replace(/^realtime:/, ''), message: 'Subscribed to PostgreSQL' });
    }
    if (evento === 'phx_leave') { canales.delete(topic); return enviar(joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }); }
  });
}

function difundir(tabla) {
  for (const canales of sockets.values()) for (const [topic, c] of canales) {
    const ids = c.cambios.filter((b) => b.table === tabla).map((b) => b.id);
    if (ids.length) c.enviar(c.joinRef, null, topic, 'postgres_changes', {
      ids, data: { schema: 'public', table: tabla, type: 'UPDATE', commit_timestamp: new Date().toISOString(), columns: [], record: {}, old_record: {}, errors: null },
    });
  }
}

const escucha = new pg.Client({ host: '127.0.0.1', port: +process.env.PGPORT || 54322, user: 'supabase_admin', database: 'postgres' });
escucha.on('notification', (n) => difundir(n.payload));
escucha.on('error', (e) => console.error('escucha:', e.message));
escucha.connect().then(() => escucha.query('listen gestor_rt')).catch((e) => console.error('escucha:', e.message));

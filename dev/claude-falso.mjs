// Un doble de la API de Claude para las pruebas locales del chat (en 127.0.0.1:54340).
// La función `chat` corre en local apuntando acá (ANTHROPIC_URL), así se prueba de punta a punta
// sin gastar crédito ni depender de lo que conteste el modelo.
//
//   POST /__guion   [paso, paso, …]  lo que va a contestar, en orden. Cada paso es uno de:
//                   { texto: "…" }                         respuesta final
//                   { herramientas: [{ name, input }, …] } pide herramientas (con un "pensamiento" firmado)
//                   { error: { status, type, message } }   la API falla
//                   Sin guion, contesta "Listo.".
//   GET  /__pedidos  lo que le llegó (cuerpo y encabezados de cada pedido)
//   DELETE /__pedidos
import http from 'node:http';

const PORT = +process.env.CLAUDE_FALSO_PORT || 54340;
let guion = [];
let pedidos = [];
let n = 0;

const leer = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
const json = (res, status, cuerpo) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(cuerpo));

http.createServer(async (req, res) => {
  const cuerpo = await leer(req);
  if (req.url === '/__guion' && req.method === 'POST') { guion = JSON.parse(cuerpo || '[]'); return json(res, 200, { pasos: guion.length }); }
  if (req.url === '/__pedidos' && req.method === 'GET') return json(res, 200, pedidos);
  if (req.url === '/__pedidos' && req.method === 'DELETE') { pedidos = []; guion = []; return json(res, 200, {}); }
  if (req.url !== '/v1/messages' || req.method !== 'POST') return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'no' } });

  const pedido = JSON.parse(cuerpo);
  pedidos.push({ headers: { 'x-api-key': req.headers['x-api-key'], 'anthropic-version': req.headers['anthropic-version'] }, cuerpo: pedido });
  if (req.headers['x-api-key'] !== 'clave-de-prueba') return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });

  const paso = guion.shift() || { texto: 'Listo.' };
  if (paso.error) return json(res, paso.error.status, { type: 'error', error: { type: paso.error.type, message: paso.error.message } });
  const id = () => `toolu_falso_${++n}`;
  const content = paso.herramientas
    ? [{ type: 'thinking', thinking: 'Voy a usar las herramientas del gestor.', signature: `firma-${n}` },
       ...paso.herramientas.map((h) => ({ type: 'tool_use', id: id(), name: h.name, input: h.input || {} }))]
    : [{ type: 'text', text: paso.texto }];
  json(res, 200, {
    id: `msg_falso_${++n}`, type: 'message', role: 'assistant', model: pedido.model, content,
    stop_reason: paso.herramientas ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}).listen(PORT, '127.0.0.1', () => console.log('claude falso en', PORT));

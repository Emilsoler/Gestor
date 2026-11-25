// Lectura de los PDF de una demanda (función `leer-demanda` de Supabase).
//
// Solo para el estudio: el botón «Hacer demanda» de «Nueva causa» del gestor manda { tipo, archivos } (tipo: 'prendaria' o
// 'documentos'; archivos: [{ nombre, tipo, base64 }] con la prenda o los pagarés). La función se los da a Claude para que
// transcriba los datos de la demanda (demandados, contrato y vehículo, o la lista de pagarés) y los devuelve ya controlados
// (leer.js). El Word lo arma la app con los modelos del estudio, y la persona lo revisa antes de presentarlo.
//
// No guarda nada: ni los archivos ni lo leído. En los registros no queda contenido, solo el estado de las respuestas.
// Permisos: la sesión de la persona (mismas barreras que la app: `mi_acceso`). Secreto: ANTHROPIC_API_KEY (el mismo del chat).
import { INSTRUCCIONES, SIN_DATOS, TIPOS, bloquesDelPedido, elegirArchivos, extraerJson, hayDatos, limpiarLectura } from './leer.js';

const URL_BASE = Deno.env.get('SUPABASE_URL') || '';
const URL_CLAUDE = (Deno.env.get('ANTHROPIC_URL') || 'https://api.anthropic.com').replace(/\/+$/, ''); // otra solo en las pruebas locales
const MODELO = Deno.env.get('DEMANDA_LECTURA_MODELO') || 'claude-sonnet-5-5'; // lee documentos escaneados: acá conviene el más preciso
const ORIGENES = (Deno.env.get('GESTOR_ORIGENES') || 'https://emilsoler.github.io,http://127.0.0.1:8080').split(',').map((s) => s.trim());

function clavePublica() {
  try {
    const claves = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
    if (claves.default) return String(claves.default);
  } catch { /* formato viejo: abajo */ }
  return Deno.env.get('SUPABASE_ANON_KEY') || '';
}

function cabeceras(req: Request) {
  const origen = req.headers.get('origin') || '';
  return {
    ...(ORIGENES.includes(origen) ? { 'access-control-allow-origin': origen, vary: 'origin' } : {}),
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
    'access-control-max-age': '600',
  };
}

type Cors = Record<string, string>;
const responder = (cuerpo: unknown, status: number, cors: Cors) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' } });
const falla = (error: string, mensaje: string, status: number, cors: Cors) => responder({ error, mensaje }, status, cors);

/** Una consulta a la API de la base con la sesión de la persona. */
async function base(jwt: string, ruta: string, cuerpo?: unknown) {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, {
    method: cuerpo === undefined ? 'GET' : 'POST',
    headers: { apikey: clavePublica(), authorization: `Bearer ${jwt}`, accept: 'application/json', 'content-type': 'application/json' },
    ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
  });
  const texto = await r.text();
  let datos: any = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { /* no es JSON */ }
  return { ok: r.ok, status: r.status, datos, codigo: String(datos?.code || '') };
}

/** Le pide a Claude que transcriba los documentos. El JSON crudo, o null si no se pudo (sin clave, sin crédito, saturado…). */
async function leerConClaude(tipo: string, archivos: { nombre: string; tipo: string; base64: string }[]): Promise<{ crudo?: unknown; error?: string }> {
  const clave = Deno.env.get('ANTHROPIC_API_KEY') || '';
  if (!clave) return { error: 'sin_clave' };
  const cuerpo = JSON.stringify({ model: MODELO, max_tokens: 6000, system: (INSTRUCCIONES as Record<string, string>)[tipo], messages: [{ role: 'user', content: bloquesDelPedido(archivos) }] });
  for (let intento = 0; intento < 2; intento++) {
    try {
      const r = await fetch(`${URL_CLAUDE}/v1/messages`, {
        method: 'POST', headers: { 'x-api-key': clave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: cuerpo, signal: AbortSignal.timeout(120_000),
      });
      if (r.ok) {
        const d = await r.json();
        const t = (Array.isArray(d?.content) ? d.content : []).filter((b: any) => b?.type === 'text').map((b: any) => String(b.text || '')).join('\n');
        const crudo = extraerJson(t);
        return crudo ? { crudo } : { error: 'ilegible' };
      }
      // Sin el detalle (podría llevar texto de los documentos): solo el estado y el tipo de error.
      let tipo = ''; try { tipo = String((await r.json())?.error?.type || ''); } catch { /* sin cuerpo */ }
      console.error(JSON.stringify({ lectura: 'claude', status: r.status, tipo }));
      if (!(r.status === 429 || r.status === 529 || r.status >= 500) || intento) return { error: 'api' };
    } catch {
      console.error(JSON.stringify({ lectura: 'claude', status: 0 }));
      if (intento) return { error: 'api' };
    }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  return { error: 'api' };
}

export async function manejar(req: Request): Promise<Response> {
  const cors = cabeceras(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return falla('metodo', 'Solo POST.', 405, cors);

  // 1. Quién pide: la sesión de la app, autorizada en la base (como en la función `bcra`).
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return falla('sin_sesion', 'Falta iniciar sesión.', 401, cors);
  const acceso = await base(jwt, 'rpc/mi_acceso', {}).catch(() => null);
  if (!acceso) return falla('base', 'No se pudo consultar la base de datos. Probá de nuevo en un momento.', 502, cors);
  if (acceso.status === 401 || /jwt/i.test(String(acceso.datos?.message || ''))) return falla('sin_sesion', 'La sesión venció: volvé a ingresar.', 401, cors);
  if (acceso.codigo === '42501' || (acceso.ok && !acceso.datos?.autorizado)) return falla('sin_acceso', 'Esta cuenta no está autorizada para usar la app.', 403, cors);
  if (!acceso.ok) return falla('base', 'No se pudo consultar la base de datos. Probá de nuevo en un momento.', 502, cors);
  if (acceso.datos?.clave_temporal) return falla('clave_temporal', 'Antes de seguir, elegí tu contraseña definitiva.', 403, cors);

  // 2. Qué pide: el tipo de demanda y los archivos que la persona adjuntó.
  let pedido: any;
  try { pedido = await req.json(); } catch { return falla('pedido', 'El pedido no se pudo leer. Si los archivos son muy pesados, adjuntá menos.', 400, cors); }
  const tipo = String(pedido?.tipo ?? '');
  if (!TIPOS.includes(tipo)) return falla('pedido', 'Falta elegir si la demanda es prendaria o de documentos.', 400, cors);
  const { usar, omitidos } = elegirArchivos(pedido?.archivos);
  if (!usar.length) return falla('sin_archivos', 'No hay PDF para leer (o pesan demasiado). Adjuntá los archivos o cargá los datos a mano.', 400, cors);

  // 3. La lectura, con el control de cada dato.
  const inicio = Date.now();
  const l = await leerConClaude(tipo, usar);
  if (l.error === 'sin_clave') return falla('sin_clave', 'La lectura automática no está habilitada todavía. Cargá los datos a mano.', 503, cors);
  if (l.error === 'ilegible') return falla('lectura', 'No se pudo interpretar la lectura. Probá de nuevo o cargá los datos a mano.', 502, cors);
  if (!l.crudo) return falla('lectura', 'No se pudo leer ahora. Probá de nuevo en un momento o cargá los datos a mano.', 502, cors);
  const lectura = limpiarLectura(tipo, l.crudo);
  console.log(JSON.stringify({ lectura: 'ok', tipo, ms: Date.now() - inicio, archivos: usar.length }));
  if (!hayDatos(lectura)) return falla('sin_datos', SIN_DATOS, 422, cors);
  return responder({ ...lectura, leidos: usar.length, omitidos }, 200, cors);
}

Deno.serve(manejar);

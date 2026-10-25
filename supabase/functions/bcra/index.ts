// Aprobación de créditos: consulta a la Central de Deudores del BCRA (función `bcra` de Supabase).
//
// La app manda un CUIT o CUIL. Acá se verifica la sesión (con la base: mismas barreras que la app), se
// le pide al BCRA la situación actual, la de los últimos 24 meses y los cheques rechazados, se arma el
// semáforo y se guarda la consulta en public.consultas_bcra con la sesión de quien consulta. Devuelve
// la fila guardada.
//
// No usa ninguna clave secreta: la API del BCRA es pública y la base se usa con la sesión de la persona.
// En los registros no queda el CUIT.
import { ErrorBCRA, consultar, cuitValido, resumir, sinCuit, soloDigitos } from './bcra.ts';

const URL_BASE = Deno.env.get('SUPABASE_URL') || '';
const URL_BCRA = Deno.env.get('BCRA_URL') || 'https://api.bcra.gob.ar'; // otra solo en las pruebas locales
const ORIGENES = (Deno.env.get('GESTOR_ORIGENES') || 'https://emilsoler.github.io,http://127.0.0.1:8080').split(',').map((s) => s.trim());

/** La clave pública del proyecto (la misma de config.js): con ella y la sesión se pide a la API. */
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

const responder = (cuerpo: unknown, status: number, cors: Record<string, string>) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' } });

class ErrorBase extends Error {
  constructor(mensaje: string, public status: number, public codigo: string) { super(mensaje); }
}

/** La API de la base (PostgREST) con la sesión de la persona. */
async function base(jwt: string, ruta: string, cuerpo: unknown, prefer = '') {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, {
    method: 'POST',
    headers: {
      apikey: clavePublica(), authorization: `Bearer ${jwt}`, accept: 'application/json', 'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    body: JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos: any = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { /* respuesta que no es JSON: va en el error */ }
  if (!r.ok) throw new ErrorBase(datos?.message || texto.slice(0, 200) || `La base respondió ${r.status}`, r.status, datos?.code || '');
  return datos;
}

const STATUS: Record<string, number> = { limite: 429, tiempo: 504, parametro: 400 };

export async function manejar(req: Request): Promise<Response> {
  const cors = cabeceras(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return responder({ error: 'metodo', mensaje: 'Solo POST.' }, 405, cors);

  // 1. Quién pide: la sesión de la app. La base dice si está autorizado (y la puerta de la API
  //    rechaza a quien no lo está antes de cualquier otra cosa).
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return responder({ error: 'sin_sesion', mensaje: 'Falta iniciar sesión.' }, 401, cors);
  let acceso: any;
  try {
    acceso = await base(jwt, 'rpc/mi_acceso', {});
  } catch (e) {
    if (e instanceof ErrorBase && (e.status === 401 || /jwt/i.test(e.message))) return responder({ error: 'sin_sesion', mensaje: 'La sesión venció: volvé a ingresar.' }, 401, cors);
    if (e instanceof ErrorBase && e.codigo === '42501') return responder({ error: 'sin_acceso', mensaje: 'Esta cuenta no está autorizada para usar la app.' }, 403, cors);
    console.error('mi_acceso:', e);
    return responder({ error: 'base', mensaje: 'No se pudo consultar la base de datos. Probá de nuevo en un momento.' }, 502, cors);
  }
  if (!acceso?.autorizado) return responder({ error: 'sin_acceso', mensaje: 'Esta cuenta no está autorizada para usar la app.' }, 403, cors);
  if (acceso.clave_temporal) return responder({ error: 'clave_temporal', mensaje: 'Antes de consultar, elegí tu contraseña definitiva.' }, 403, cors);

  // 2. El CUIT. Se rechaza uno mal escrito antes de preguntar: para el BCRA un número que no existe
  //    "no figura", y eso se podría leer como una persona sin deudas.
  let pedido: any;
  try { pedido = await req.json(); } catch { return responder({ error: 'pedido', mensaje: 'El pedido no se pudo leer.' }, 400, cors); }
  const cuit = soloDigitos(pedido?.cuit).slice(0, 20);
  if (cuit.length !== 11) return responder({ error: 'cuit', mensaje: 'El CUIT o CUIL tiene que tener 11 números.' }, 400, cors);
  if (!cuitValido(cuit)) return responder({ error: 'cuit', mensaje: 'Ese CUIT o CUIL no existe: revisá los números (el último no coincide con los demás).' }, 400, cors);

  // 3. El BCRA.
  const inicio = Date.now();
  let r;
  try {
    r = await consultar(cuit, { url: URL_BCRA });
  } catch (e) {
    const err = e instanceof ErrorBCRA ? e : new ErrorBCRA('red', 0, sinCuit(String(e)));
    console.error(JSON.stringify({ bcra: 'error', tipo: err.tipo, status: err.status, ms: Date.now() - inicio, detalle: err.detalle }));
    return responder({ error: `bcra_${err.tipo}`, mensaje: err.message }, STATUS[err.tipo] || 502, cors);
  }

  // 4. El semáforo y la constancia.
  const resumen = resumir(r.deudas, r.cheques, r.historicas);
  let fila: any;
  try {
    [fila] = await base(jwt, 'consultas_bcra?select=*', {
      cuit, ...resumen,
      resultado: { deudas: r.deudas, historicas: r.historicas, cheques: r.cheques, errores: r.errores },
    }, 'return=representation');
  } catch (e) {
    console.error('guardar:', e instanceof ErrorBase ? `${e.status} ${e.codigo} ${e.message}` : e);
    if (e instanceof ErrorBase && e.codigo === '42501') return responder({ error: 'sin_acceso', mensaje: 'Esta cuenta no está autorizada para usar la app.' }, 403, cors);
    return responder({ error: 'base', mensaje: 'El BCRA respondió, pero la consulta no se pudo guardar. Probá de nuevo.' }, 502, cors);
  }

  console.log(JSON.stringify({ bcra: 'ok', ms: Date.now() - inicio, ...r.estados, semaforo: resumen.semaforo }));
  return responder({ consulta: fila }, 200, cors);
}

Deno.serve(manejar);

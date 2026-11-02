// Cotización de vehículos: consultas a la API de InfoAuto (función `infoauto` de Supabase).
//
// La app manda:  { ruta: '/search/', params: { ... } }   (una consulta GET a InfoAuto)
// y la función devuelve lo que InfoAuto respondió. Ejemplos de rutas permitidas:
//   /datetime   /current_year   /brands/   /search/   /models/{codia}   /models/{codia}/prices/   /models/{codia}/list_price
//
// Usuario y contraseña NO están en el código: se cargan como secretos en Supabase
//   INFOAUTO_USER, INFOAUTO_PASS (y opcional INFOAUTO_API, por defecto el entorno de prueba).
// El token se guarda en public.infoauto_token y se reutiliza (dura 1 hora; se renueva con el refresh token
// de 24 horas). Pedir un token nuevo en cada consulta se considera mal uso de la API.
// No se permiten las rutas que bajan el catálogo completo (/batch/, /brands/download/).
const URL_BASE = Deno.env.get('SUPABASE_URL') || '';
const CLAVE_SERVICIO = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const API = (Deno.env.get('INFOAUTO_API') || 'https://demo.api.infoauto.com.ar').replace(/\/+$/, '');
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

// Rutas permitidas (solo consultas puntuales, nunca el catálogo entero).
const PERMITIDAS = [
  /^\/datetime$/, /^\/current_year$/, /^\/brands\/$/, /^\/brands\/\d+\/(models|groups|prices)\/$/,
  /^\/brands\/\d+\/groups\/\d+\/(models|prices)\/$/, /^\/search\/$/, /^\/models\/\d{1,10}$/,
  /^\/models\/\d{1,10}\/(list_price|prices\/|as_codia|photos\/|features\/)$/, /^\/features\/$/, /^\/features\/\d+\/choices\/$/,
];

/** El pedido a la base con la sesión de la persona (misma barrera que el resto de la app). */
async function miAcceso(jwt: string) {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/mi_acceso`, {
    method: 'POST',
    headers: { apikey: clavePublica(), authorization: `Bearer ${jwt}`, 'content-type': 'application/json', accept: 'application/json' },
    body: '{}',
  });
  if (r.status === 401) return { status: 401 };
  if (!r.ok) return { status: r.status };
  return { status: 200, acceso: await r.json() };
}

/** La fila del token, con la clave de servicio (nadie más puede leerla). */
async function tokenGuardado(): Promise<any> {
  const r = await fetch(`${URL_BASE}/rest/v1/infoauto_token?id=eq.1&select=*`, {
    headers: { apikey: CLAVE_SERVICIO, authorization: `Bearer ${CLAVE_SERVICIO}`, accept: 'application/json' },
  });
  if (!r.ok) return null;
  const [fila] = await r.json();
  return fila || null;
}

async function guardarToken(t: { access: string; refresh: string }) {
  const ahora = Date.now();
  await fetch(`${URL_BASE}/rest/v1/infoauto_token?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey: CLAVE_SERVICIO, authorization: `Bearer ${CLAVE_SERVICIO}`, 'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      id: 1, access_token: t.access, refresh_token: t.refresh,
      access_vence: new Date(ahora + 55 * 60_000).toISOString(),   // vale 1 hora: se renueva antes
      refresh_vence: new Date(ahora + 23 * 3_600_000).toISOString(), // vale 24 horas
      actualizado: new Date(ahora).toISOString(),
    }),
  });
}

class ErrorInfoAuto extends Error {
  constructor(mensaje: string, public status: number, public codigo: string) { super(mensaje); }
}

function leerTokens(d: any): { access: string; refresh: string } {
  const access = d?.access_token ?? d?.accessToken ?? d?.access ?? '';
  const refresh = d?.refresh_token ?? d?.refreshToken ?? d?.refresh ?? '';
  if (!access) throw new ErrorInfoAuto('InfoAuto respondió el login con un formato que no se esperaba.', 502, 'formato_login');
  return { access: String(access), refresh: String(refresh) };
}

/** Un access token vigente: el guardado, o uno renovado, o (solo si hace falta) uno nuevo con usuario y contraseña. */
async function accessToken(): Promise<string> {
  const fila = await tokenGuardado();
  const ahora = Date.now();
  if (fila?.access_token && fila.access_vence && Date.parse(fila.access_vence) > ahora + 30_000) return fila.access_token;

  if (fila?.refresh_token && fila.refresh_vence && Date.parse(fila.refresh_vence) > ahora + 30_000) {
    const r = await fetch(`${API}/cars/auth/refresh`, { method: 'POST', headers: { authorization: `Bearer ${fila.refresh_token}` }, signal: AbortSignal.timeout(20_000) });
    if (r.ok) {
      const t = leerTokens(await r.json());
      if (!t.refresh) t.refresh = fila.refresh_token;
      await guardarToken(t);
      return t.access;
    }
  }

  const usuario = Deno.env.get('INFOAUTO_USER') || '';
  const clave = Deno.env.get('INFOAUTO_PASS') || '';
  if (!usuario || !clave) throw new ErrorInfoAuto('Faltan cargar el usuario y la contraseña de InfoAuto en Supabase (secretos INFOAUTO_USER e INFOAUTO_PASS).', 503, 'sin_credenciales');
  const r = await fetch(`${API}/cars/auth/login`, {
    method: 'POST', headers: { authorization: `Basic ${btoa(`${usuario}:${clave}`)}` }, signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 401 || r.status === 403) throw new ErrorInfoAuto('InfoAuto no aceptó el usuario o la contraseña cargados.', 502, 'login_rechazado');
  if (!r.ok) throw new ErrorInfoAuto(`InfoAuto respondió ${r.status} al iniciar sesión.`, 502, 'login');
  const t = leerTokens(await r.json());
  await guardarToken(t);
  return t.access;
}

async function consulta(ruta: string, params: Record<string, unknown>): Promise<{ status: number; cuerpo: unknown }> {
  const url = new URL(`${API}/cars/pub${ruta}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    url.searchParams.set(String(k).slice(0, 40), String(v).slice(0, 200));
  }
  const pedir = async (token: string) => fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  let r = await pedir(await accessToken());
  if (r.status === 401) { // el token pudo vencer antes de lo previsto: se descarta y se renueva una vez
    await fetch(`${URL_BASE}/rest/v1/infoauto_token?id=eq.1`, { method: 'PATCH', headers: { apikey: CLAVE_SERVICIO, authorization: `Bearer ${CLAVE_SERVICIO}`, 'content-type': 'application/json' }, body: JSON.stringify({ access_vence: new Date(0).toISOString() }) });
    r = await pedir(await accessToken());
  }
  const texto = await r.text();
  let cuerpo: unknown = texto;
  try { cuerpo = texto ? JSON.parse(texto) : null; } catch { /* queda el texto */ }
  return { status: r.status, cuerpo };
}

export async function manejar(req: Request): Promise<Response> {
  const cors = cabeceras(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return responder({ error: 'metodo', mensaje: 'Solo POST.' }, 405, cors);

  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return responder({ error: 'sin_sesion', mensaje: 'Falta iniciar sesión.' }, 401, cors);
  const a = await miAcceso(jwt);
  if (a.status === 401) return responder({ error: 'sin_sesion', mensaje: 'La sesión venció: volvé a ingresar.' }, 401, cors);
  if (a.status !== 200) return responder({ error: 'base', mensaje: 'No se pudo consultar la base de datos. Probá de nuevo en un momento.' }, 502, cors);
  if (!a.acceso?.autorizado) return responder({ error: 'sin_acceso', mensaje: 'Esta cuenta no está autorizada para usar la app.' }, 403, cors);
  if (a.acceso.clave_temporal) return responder({ error: 'clave_temporal', mensaje: 'Antes de consultar, elegí tu contraseña definitiva.' }, 403, cors);

  let pedido: any;
  try { pedido = await req.json(); } catch { return responder({ error: 'pedido', mensaje: 'El pedido no se pudo leer.' }, 400, cors); }
  const ruta = String(pedido?.ruta ?? '');
  if (!PERMITIDAS.some((re) => re.test(ruta))) return responder({ error: 'ruta', mensaje: 'Esa consulta no está permitida.' }, 400, cors);

  try {
    const r = await consulta(ruta, pedido?.params || {});
    if (r.status >= 400) {
      console.error(JSON.stringify({ infoauto: 'error', ruta, status: r.status }));
      return responder({ error: 'infoauto', status: r.status, mensaje: `InfoAuto respondió ${r.status}.`, detalle: r.cuerpo }, r.status === 429 ? 429 : 502, cors);
    }
    return responder({ ruta, resultado: r.cuerpo }, 200, cors);
  } catch (e) {
    if (e instanceof ErrorInfoAuto) {
      console.error(JSON.stringify({ infoauto: 'error', codigo: e.codigo }));
      return responder({ error: e.codigo, mensaje: e.message }, e.status, cors);
    }
    console.error('infoauto:', (e as Error)?.name);
    return responder({ error: 'red', mensaje: 'No se pudo conectar con InfoAuto. Probá de nuevo en un momento.' }, 502, cors);
  }
}

Deno.serve(manejar);

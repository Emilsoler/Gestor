// Aprobación de créditos: consultas al BCRA (función `bcra` de Supabase).
//
// La app manda uno de estos pedidos:
//   { cuit }                              Central de Deudores: la situación actual, la de los últimos 24 meses y
//                                         los cheques rechazados; se arma el semáforo y se guarda en
//                                         public.consultas_bcra.
//   { accion: 'cheque', entidad, numero } Central de Cheques Denunciados: si ese cheque fue denunciado como
//                                         extraviado, sustraído o adulterado; se guarda en public.consultas_cheques.
//   { accion: 'entidades' }               la lista de bancos para elegir el del cheque (no se guarda nada).
//   { accion: 'arca_probar' }             prueba la conexión con ARCA: consulta la constancia del CUIT del certificado.
// La consulta por CUIT suma, si la app está conectada con ARCA, la constancia de inscripción (arca.ts): si
// ARCA falla, la consulta al BCRA sale igual y lo anota.
// Antes de cualquier cosa se verifica la sesión con la base (mismas barreras que la app). Lo que se guarda va
// con la sesión de quien consulta, y se devuelve la fila guardada.
//
// La API del BCRA es pública y la base se usa con la sesión de la persona. El único secreto es la clave de
// ARCA (ARCA_CLAVE), que firma el pedido de acceso a ARCA y no sale de acá.
// En los registros no queda el CUIT, el número de cheque ni el permiso de ARCA.
import {
  ErrorBCRA, codigoEntidad, consultar, consultarCheque, cuitValido, entidades, numeroCheque, resumir, sinCuit, soloDigitos,
} from './bcra.ts';
import { ErrorArca, constancia, iniciarSesion, leerCredencial, resumirPersona, sinDatos, type Permiso } from './arca.ts';

const URL_BASE = Deno.env.get('SUPABASE_URL') || '';
const URL_BCRA = Deno.env.get('BCRA_URL') || 'https://api.bcra.gob.ar'; // otra solo en las pruebas locales
const ORIGENES = (Deno.env.get('GESTOR_ORIGENES') || 'https://emilsoler.github.io,http://127.0.0.1:8080').split(',').map((s) => s.trim());
// ARCA: se prueban en orden si no hay conexión. El padrón está en arca.gob.ar (manual del servicio, v4.1) y
// queda el dominio de AFIP de respaldo; WSAA sigue en el de AFIP.
const ARCA_WSAA = (Deno.env.get('ARCA_WSAA_URL') || 'https://wsaa.afip.gov.ar/ws/services/LoginCms').split(',').map((s) => s.trim());
const ARCA_PADRON = (Deno.env.get('ARCA_PADRON_URL')
  || 'https://aws.arca.gob.ar/sr-padron/webservices/personaServiceA5,https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5').split(',').map((s) => s.trim());

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

const STATUS: Record<string, number> = { limite: 429, tiempo: 504, parametro: 400, entidad: 400, numero: 400 };
// Para los registros de los cheques: sin el número (ni el de la cuenta, si el BCRA lo repite en un error).
const sinNumeros = (s: unknown) => sinCuit(s).replace(/\d{6,}/g, '…');

type Cors = Record<string, string>;

/** Guarda una constancia con la sesión de la persona: devuelve la fila guardada o la respuesta de error. */
async function guardar(jwt: string, tabla: string, fila: unknown, cors: Cors): Promise<{ fila?: any; error?: Response }> {
  try {
    const [f] = await base(jwt, `${tabla}?select=*`, fila, 'return=representation');
    return { fila: f };
  } catch (e) {
    console.error(`guardar ${tabla}:`, e instanceof ErrorBase ? `${e.status} ${e.codigo} ${e.message}` : e);
    if (e instanceof ErrorBase && e.codigo === '42501') return { error: responder({ error: 'sin_acceso', mensaje: 'Esta cuenta no está autorizada para usar la app.' }, 403, cors) };
    if (e instanceof ErrorBase && (e.codigo === 'PGRST205' || e.codigo === '42P01')) {
      return { error: responder({ error: 'sin_tabla', mensaje: 'Esta consulta todavía no está activada en la base. Avisale a Claude.' }, 503, cors) };
    }
    return { error: responder({ error: 'base', mensaje: 'El BCRA respondió, pero la consulta no se pudo guardar. Probá de nuevo.' }, 502, cors) };
  }
}

// ───────────────────────── ARCA ─────────────────────────

/** Prueba cada dirección mientras el problema sea que no hay conexión. */
async function conRespaldo<T>(urls: string[], pedido: (url: string) => Promise<T>): Promise<T> {
  let ultimo: unknown;
  for (const url of urls) {
    try { return await pedido(url); } catch (e) {
      ultimo = e;
      if (!(e instanceof ErrorArca && e.tipo === 'red')) throw e;
    }
  }
  throw ultimo;
}

/**
 * La constancia de un CUIT (o, sin CUIT, la del propio certificado). Usa el permiso guardado si todavía vale;
 * si no, pide uno y lo guarda. Si ARCA no acepta el guardado, pide otro una vez. `config` es que la app
 * todavía no está conectada (falta la clave o el certificado).
 */
async function consultarArca(jwt: string, cuit: string | null) {
  const clavePem = Deno.env.get('ARCA_CLAVE') || '';
  let config: any;
  try {
    config = await base(jwt, 'rpc/arca_config', {});
  } catch (e) {
    if (e instanceof ErrorBase && (e.codigo === 'PGRST202' || e.codigo === '42883')) throw new ErrorArca('config', 'La conexión con ARCA todavía no está activada en la base. Avisale a Claude.');
    if (e instanceof ErrorBase && e.codigo === '42501') throw new ErrorArca('config', 'Esta cuenta no está autorizada para usar la app.');
    throw new ErrorArca('arca', 'No se pudo leer la configuración de ARCA. Probá de nuevo en un momento.', sinDatos(e));
  }
  if (!clavePem) throw new ErrorArca('config', 'Falta cargar la clave de ARCA en Supabase (el secreto ARCA_CLAVE).');
  if (!config?.certificado) throw new ErrorArca('config', 'Falta guardar en la base el certificado de ARCA. Avisale a Claude.');
  const cred = leerCredencial(clavePem, config.certificado);
  let permiso: Permiso | null = config.ticket?.token ? config.ticket : null;
  const guardado = !!permiso;
  for (let intento = 0; ; intento++) {
    if (!permiso) {
      try {
        permiso = await conRespaldo(ARCA_WSAA, (url) => iniciarSesion(cred, url));
      } catch (e) {
        // Otra consulta pudo haberlo pedido y guardado recién.
        if (e instanceof ErrorArca && e.tipo === 'ya_autenticado') {
          const otra = await base(jwt, 'rpc/arca_config', {}).catch(() => null);
          if (otra?.ticket?.token) { permiso = otra.ticket; } else throw e;
        } else throw e;
      }
      try { await base(jwt, 'rpc/arca_guardar_ticket', { p_ticket: permiso }); } catch (e) {
        console.error(JSON.stringify({ arca: 'no se guardó el permiso', detalle: sinDatos(e instanceof Error ? e.message : e) }));
      }
    }
    try {
      return { cred, persona: await conRespaldo(ARCA_PADRON, (url) => constancia(permiso!, cred.cuit, cuit ?? cred.cuit, url)) };
    } catch (e) {
      if (e instanceof ErrorArca && e.tipo === 'permiso' && guardado && intento === 0) { permiso = null; continue; }
      throw e;
    }
  }
}

const errorDeArca = (e: unknown) => (e instanceof ErrorArca ? e : new ErrorArca('arca', 'No se pudo consultar a ARCA. Probá de nuevo en un rato.', sinDatos(e)));
const STATUS_ARCA: Record<string, number> = { config: 409, clave: 409, certificado: 409, vencido: 409, no_autorizado: 409, ya_autenticado: 429, tiempo: 504 };

/** El botón «Probar la conexión con ARCA»: la constancia del CUIT del certificado. */
async function probarArca(jwt: string, cors: Cors): Promise<Response> {
  const inicio = Date.now();
  try {
    const { cred, persona } = await consultarArca(jwt, null);
    const r = resumirPersona(persona);
    console.log(JSON.stringify({ arca: 'prueba ok', ms: Date.now() - inicio }));
    return responder({ arca: { ok: true, cuit: cred.cuit, alias: cred.alias, vence: cred.vence.toISOString(), nombre: r.nombre, estado: r.estado } }, 200, cors);
  } catch (e) {
    const err = errorDeArca(e);
    console.error(JSON.stringify({ arca: 'prueba error', tipo: err.tipo, ms: Date.now() - inicio, detalle: sinDatos(err.detalle) }));
    return responder({ error: `arca_${err.tipo}`, mensaje: err.message }, STATUS_ARCA[err.tipo] || 502, cors);
  }
}

/** Central de Deudores: el CUIT, el semáforo y la constancia. */
async function deudas(jwt: string, pedido: any, cors: Cors): Promise<Response> {
  // Se rechaza un CUIT mal escrito antes de preguntar: para el BCRA un número que no existe "no figura",
  // y eso se podría leer como una persona sin deudas.
  const cuit = soloDigitos(pedido?.cuit).slice(0, 20);
  if (cuit.length !== 11) return responder({ error: 'cuit', mensaje: 'El CUIT o CUIL tiene que tener 11 números.' }, 400, cors);
  if (!cuitValido(cuit)) return responder({ error: 'cuit', mensaje: 'Ese CUIT o CUIL no existe: revisá los números (el último no coincide con los demás).' }, 400, cors);

  const inicio = Date.now();
  // ARCA va a la par del BCRA. Si la app no está conectada con ARCA, la consulta sale sin la constancia; si
  // ARCA falla, sale con el aviso.
  const pedidoArca = consultarArca(jwt, cuit).then(
    ({ persona }) => ({ resumen: resumirPersona(persona), persona }),
    (e) => {
      const err = errorDeArca(e);
      if (err.tipo === 'config') return null;
      console.error(JSON.stringify({ arca: 'error', tipo: err.tipo, detalle: sinDatos(err.detalle) }));
      return { error: err.message, tipo: err.tipo };
    },
  );
  let r;
  try {
    r = await consultar(cuit, { url: URL_BCRA });
  } catch (e) {
    const err = e instanceof ErrorBCRA ? e : new ErrorBCRA('red', 0, sinCuit(String(e)));
    console.error(JSON.stringify({ bcra: 'error', tipo: err.tipo, status: err.status, ms: Date.now() - inicio, detalle: err.detalle }));
    return responder({ error: `bcra_${err.tipo}`, mensaje: err.message }, STATUS[err.tipo] || 502, cors);
  }
  const arca = await pedidoArca;

  const resumen = resumir(r.deudas, r.cheques, r.historicas);
  // Sin deudas, el BCRA no dice el nombre: si ARCA lo sabe, va ese.
  if (!resumen.denominacion && arca && 'resumen' in arca && arca.resumen.nombre) resumen.denominacion = arca.resumen.nombre.slice(0, 300);
  const g = await guardar(jwt, 'consultas_bcra', {
    cuit, ...resumen,
    resultado: { deudas: r.deudas, historicas: r.historicas, cheques: r.cheques, errores: r.errores, ...(arca ? { arca } : {}) },
  }, cors);
  if (g.error) return g.error;
  console.log(JSON.stringify({ bcra: 'ok', ms: Date.now() - inicio, ...r.estados, semaforo: resumen.semaforo, arca: !arca ? 'sin' : 'error' in arca ? `error:${arca.tipo}` : 'ok' }));
  return responder({ consulta: g.fila }, 200, cors);
}

/** Central de Cheques Denunciados: el banco, el número y la constancia. */
async function cheque(jwt: string, pedido: any, cors: Cors): Promise<Response> {
  const entidad = codigoEntidad(pedido?.entidad);
  if (!entidad) return responder({ error: 'entidad', mensaje: 'Elegí el banco del cheque.' }, 400, cors);
  const numero = numeroCheque(pedido?.numero);
  if (!numero) return responder({ error: 'numero', mensaje: 'El número de cheque tiene que tener solo números (hasta 15) y no puede ser cero.' }, 400, cors);

  const inicio = Date.now();
  let r;
  try {
    r = await consultarCheque(entidad, numero, { url: URL_BCRA });
  } catch (e) {
    const err = e instanceof ErrorBCRA ? e : new ErrorBCRA('red', 0, String(e));
    console.error(JSON.stringify({ cheque: 'error', tipo: err.tipo, status: err.status, ms: Date.now() - inicio, detalle: sinNumeros(err.detalle) }));
    return responder({ error: `bcra_${err.tipo}`, mensaje: err.message }, STATUS[err.tipo] || 502, cors);
  }

  const g = await guardar(jwt, 'consultas_cheques', {
    entidad, numero, denunciado: r.denunciado, entidad_nombre: r.entidad_nombre, fecha_bcra: r.fecha_bcra, resultado: r.resultado,
  }, cors);
  if (g.error) return g.error;
  console.log(JSON.stringify({ cheque: 'ok', ms: Date.now() - inicio, denunciado: r.denunciado }));
  return responder({ consulta: g.fila }, 200, cors);
}

/** La lista de bancos para elegir el del cheque. La app la guarda unos días: se pide poco. */
async function listaEntidades(cors: Cors): Promise<Response> {
  const inicio = Date.now();
  try {
    const lista = await entidades({ url: URL_BCRA });
    console.log(JSON.stringify({ entidades: 'ok', ms: Date.now() - inicio, cantidad: lista.length }));
    return responder({ entidades: lista }, 200, cors);
  } catch (e) {
    const err = e instanceof ErrorBCRA ? e : new ErrorBCRA('red', 0, String(e));
    console.error(JSON.stringify({ entidades: 'error', tipo: err.tipo, status: err.status, ms: Date.now() - inicio, detalle: sinNumeros(err.detalle) }));
    return responder({ error: `bcra_${err.tipo}`, mensaje: err.message }, STATUS[err.tipo] || 502, cors);
  }
}

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

  // 2. Qué pide.
  let pedido: any;
  try { pedido = await req.json(); } catch { return responder({ error: 'pedido', mensaje: 'El pedido no se pudo leer.' }, 400, cors); }
  const accion = pedido?.accion ?? 'deudas';
  if (accion === 'deudas') return deudas(jwt, pedido, cors);
  if (accion === 'cheque') return cheque(jwt, pedido, cors);
  if (accion === 'entidades') return listaEntidades(cors);
  if (accion === 'arca_probar') return probarArca(jwt, cors);
  return responder({ error: 'pedido', mensaje: 'Esa consulta no existe.' }, 400, cors);
}

Deno.serve(manejar);

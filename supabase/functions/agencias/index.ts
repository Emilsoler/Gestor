// Cotizador para agencias y concesionarias (app docs/agencias/). Función `agencias` de Supabase.
//
// Licencia "Agencias/Concesionarias" de InfoAuto: las agencias pueden simular y compartir información
// puntual del préstamo, SIN exposición de códigos ni valuaciones de InfoAuto. Por eso esta función:
//   * nunca devuelve el precio del vehículo ni el CODIA: el auto elegido viaja como una referencia cifrada
//     (AES-GCM, clave derivada de la de servicio) que solo esta función puede leer;
//   * de los modelos devuelve solo marca, modelo y versión para poder elegir (decisión de la persona,
//     a confirmar con InfoAuto) y los años con precio, no los precios;
//   * consulta a InfoAuto en el momento (no guarda precios ni copia el catálogo) y reutiliza el token
//     (pedir uno por consulta es mal uso), igual que la función `infoauto`;
//   * registra cada simulación sin el valor del vehículo, con un tope diario por agencia.
//
// Las agencias NO son miembros del gestor (la API de la base les está cerrada); esta función las
// reconoce con public.agencia_sesion, usando la clave de servicio.
//
// Pedido: { accion, ... }. Acciones: yo, clave_definida, marcas, modelos {marca}, versiones {marca, grupo},
// anios {ref}, cotizar {ref, anio, cuotas, monto?, vehiculo?}, bcra {cuit}, solicitar {consulta, ref, anio,
// cuotas, monto?, vehiculo?, ingresos, ingreso, categoria, datos, consentimiento}, archivo (multipart: id, slot,
// archivo), enviar {id}, solicitudes, rapida {capital, cuotas, tasa, gastos} (solo la agencia con simulacion_rapida); y para la Mutual, archivos {id}, eliminar {id} y crear_agencia {nombre, email, notas}.
// Chat «M» (migración 0038): de la agencia, chat_leer {desde, leido}, chat_enviar {texto}, chat_audio (multipart: audio, seg; 0040),
// chat_audio_ver {mensaje}, chat_representante y chat_cerrar;
// de la Mutual, chats, chat_resumen, chat_ver, chat_responder, chat_audio_ver, chat_cerrar {chat}, chat_eliminar {chat}, push_clave, push_suscribir, push_quitar y push_probar.
//
// BCRA: la agencia consulta el CUIT de su cliente en la Central de Deudores (API pública). La consulta queda
// guardada entera en consultas_bcra para la Mutual; a la agencia se le devuelven el color, el nombre y, del último
// período, las entidades con su situación y deuda (sin lo histórico ni los cheques).
// La solicitud de aprobación exige esa consulta (verde, o amarillo y sin antecedentes «sujeto a revisión»; rojo,
// no apto), ingresos demostrables con la cuota dentro del tope de la relación cuota/ingreso, y recalcula el
// crédito acá (no se confía en los importes que mande el navegador). Después se suben los documentos, uno por
// pedido, a la carpeta privada `solicitudes` del almacenamiento, y `enviar` la deja pendiente para la Mutual.
// En los registros no quedan el CUIT ni los datos del cliente.
import { simularCredito, montoMaximo, tasasDelCredito, anioMinimo, tasaPara } from './credito.js';
// Copia exacta de ../bcra/bcra.ts (las pruebas lo controlan): el mismo semáforo que Cobranzas.
import { ErrorBCRA, consultar, cuitValido, resumir, sinCuit, soloDigitos, ultimoPeriodo } from './bcra.ts';
// Copia exacta de docs/agencias/solicitud.js (las pruebas lo controlan): documentos y controles de la solicitud.
import { MAX_FOTO, base64, tipoImagen, urlDeFoto } from './foto.js';
// Chat de las agencias (botón «M»): el asistente, su hoja de respuestas y los avisos a la Mutual (migración 0038).
import { MAX_AUDIO_BYTES, RESPUESTA_SEGURA, SIN_ASISTENTE, TEXTO_AUDIO, armarMensajes, instrucciones, limpiarRespuesta, segundosDeAudio, textoDeAgencia, tipoAudio } from './chat.js';
import { enviarPush, nuevasClaves } from './push.js';
import { CATEGORIAS, DOCS, MAX_BYTES, docsRequeridos, relacionCuota, revisarDatos, tipoArchivo } from './solicitud.js';

const URL_BASE = Deno.env.get('SUPABASE_URL') || '';
const CLAVE_SERVICIO = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const API = (Deno.env.get('INFOAUTO_API') || 'https://api.infoauto.com.ar').replace(/\/+$/, '');
const URL_BCRA = Deno.env.get('BCRA_URL') || 'https://api.bcra.gob.ar'; // otra solo en las pruebas locales
const URL_CLAUDE = (Deno.env.get('ANTHROPIC_URL') || 'https://api.anthropic.com').replace(/\/+$/, ''); // otra solo en las pruebas locales
const MODELO_CHAT = Deno.env.get('AGENCIAS_CHAT_MODELO') || 'claude-haiku-5-5';
const CUENTA_PRUEBA = '22c74a82-fae6-4f50-8254-a61d1374ce69'; // agencia de prueba de la Mutual (emiliano_soler@hotmail.com)
const TOPE_AGENCIA_DIA = 200; // mensajes de una agencia por día (con o sin asistente)
const TOPE_ASISTENTE_DIA = 60; // respuestas del asistente por agencia y por día: acota el gasto de la API de Claude
const PUSH_LOCAL = Deno.env.get('PUSH_PERMITIR_LOCAL') === '1'; // solo en las pruebas locales: deja registrar un celular falso en 127.0.0.1
const SUJETO_VAPID = Deno.env.get('AVISO_SUJETO') || 'https://emilsoler.github.io/Gestor/cobranzas/';
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
  new Response(JSON.stringify(cuerpo), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

class Falla extends Error {
  constructor(mensaje: string, public status: number, public codigo: string) { super(mensaje); }
}

// ───────────────────────── Base (clave de servicio) ─────────────────────────
const servicio = { apikey: CLAVE_SERVICIO, authorization: `Bearer ${CLAVE_SERVICIO}`, 'content-type': 'application/json', accept: 'application/json' };

async function rpc(nombre: string, args: Record<string, unknown>) {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/${nombre}`, { method: 'POST', headers: servicio, body: JSON.stringify(args) });
  if (!r.ok) throw new Falla('No se pudo consultar la base de datos. Probá de nuevo en un momento.', 502, 'base');
  const t = await r.text(); // las que no devuelven nada responden vacío
  return t ? JSON.parse(t) : null;
}

/** El usuario de la sesión, preguntado al servicio de login (la firma ya la controló la plataforma). */
async function usuario(jwt: string): Promise<string | null> {
  const r = await fetch(`${URL_BASE}/auth/v1/user`, { headers: { apikey: clavePublica(), authorization: `Bearer ${jwt}` } });
  if (r.status === 401 || r.status === 403) return null;
  if (!r.ok) throw new Falla('No se pudo verificar la sesión. Probá de nuevo en un momento.', 502, 'base');
  const u = await r.json();
  return typeof u?.id === 'string' ? u.id : null;
}

// ───────────────────────── Almacenamiento (carpeta privada de los documentos) ─────────────────────────
const CARPETA = 'solicitudes';
const almacen = (ruta: string) => `${URL_BASE}/storage/v1/object${ruta}`;
const conClave = { apikey: CLAVE_SERVICIO, authorization: `Bearer ${CLAVE_SERVICIO}` };

const CARPETA_AUDIOS = 'chat-audios'; // los mensajes de voz del chat (migración 0040)
async function subirArchivo(path: string, bytes: Uint8Array, tipo: string, carpeta = CARPETA) {
  const r = await fetch(almacen(`/${carpeta}/${path}`), { method: 'POST', headers: { ...conClave, 'content-type': tipo, 'x-upsert': 'false' }, body: bytes });
  if (!r.ok) {
    console.error(JSON.stringify({ agencias: 'almacen', status: r.status }));
    throw new Falla('No se pudo guardar el archivo. Probá de nuevo en un momento.', 502, 'almacen');
  }
}

async function borrarArchivos(paths: string[], carpeta = CARPETA) {
  const xs = paths.filter((p) => typeof p === 'string' && p);
  if (!xs.length) return;
  try {
    await fetch(almacen(`/${carpeta}`), { method: 'DELETE', headers: { ...conClave, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: xs }) });
  } catch { /* quedan huérfanos: no traban nada */ }
}

/** Un enlace para abrir el archivo, que vence a los 15 minutos. */
async function enlace(path: string, carpeta = CARPETA): Promise<string | null> {
  const r = await fetch(almacen(`/sign/${carpeta}/${path}`), { method: 'POST', headers: { ...conClave, 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: 900 }) });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  const u = String(d?.signedURL ?? d?.signedUrl ?? '');
  return u ? `${URL_BASE}/storage/v1${u.startsWith('/') ? '' : '/'}${u}` : null;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
/** Clave provisoria al azar de 12 caracteres, sin los que se confunden al leerlos (0/O, 1/l/I). */
function claveProvisoria(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const tope = 256 - (256 % abc.length); // descarta los valores que sesgarían el reparto
  let s = '';
  while (s.length < 12) for (const b of crypto.getRandomValues(new Uint8Array(24))) if (b < tope && s.length < 12) s += abc[b % abc.length];
  return s;
}
const esUuid = (x: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x ?? ''));
// La fecha de hoy en Córdoba (UTC−3, sin horario de verano).
const hoyCordoba = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
const nombreArchivo = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f\\/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'archivo';

// ───────────────────────── InfoAuto (token compartido con la función `infoauto`) ─────────────────────────
async function tokenGuardado(): Promise<any> {
  const r = await fetch(`${URL_BASE}/rest/v1/infoauto_token?id=eq.1&select=*`, { headers: servicio });
  if (!r.ok) return null;
  const [fila] = await r.json();
  return fila || null;
}

async function guardarToken(t: { access: string; refresh: string }) {
  const ahora = Date.now();
  await fetch(`${URL_BASE}/rest/v1/infoauto_token?on_conflict=id`, {
    method: 'POST',
    headers: { ...servicio, prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      id: 1, access_token: t.access, refresh_token: t.refresh,
      access_vence: new Date(ahora + 55 * 60_000).toISOString(),
      refresh_vence: new Date(ahora + 23 * 3_600_000).toISOString(),
      actualizado: new Date(ahora).toISOString(),
    }),
  });
}

function leerTokens(d: any): { access: string; refresh: string } {
  const access = d?.access_token ?? d?.accessToken ?? d?.access ?? '';
  const refresh = d?.refresh_token ?? d?.refreshToken ?? d?.refresh ?? '';
  if (!access) throw new Falla('El servicio de cotización respondió con un formato inesperado.', 502, 'formato_login');
  return { access: String(access), refresh: String(refresh) };
}

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
  const u = Deno.env.get('INFOAUTO_USER') || '', p = Deno.env.get('INFOAUTO_PASS') || '';
  if (!u || !p) throw new Falla('El servicio de cotización no está configurado.', 503, 'sin_credenciales');
  const r = await fetch(`${API}/cars/auth/login`, { method: 'POST', headers: { authorization: `Basic ${btoa(`${u}:${p}`)}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Falla('El servicio de cotización no está disponible en este momento.', 502, 'login');
  const t = leerTokens(await r.json());
  await guardarToken(t);
  return t.access;
}

/** Un GET a InfoAuto. Devuelve el cuerpo y la paginación (cabecera X-Pagination). */
async function infoauto(ruta: string, params: Record<string, string | number> = {}): Promise<{ cuerpo: any; paginacion: any }> {
  const url = new URL(`${API}/cars/pub${ruta}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const pedir = async (token: string) => fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  let r = await pedir(await accessToken());
  if (r.status === 401) {
    await fetch(`${URL_BASE}/rest/v1/infoauto_token?id=eq.1`, { method: 'PATCH', headers: servicio, body: JSON.stringify({ access_vence: new Date(0).toISOString() }) });
    r = await pedir(await accessToken());
  }
  if (r.status === 404) return { cuerpo: null, paginacion: null };
  if (!r.ok) {
    console.error(JSON.stringify({ agencias: 'infoauto', status: r.status }));
    throw new Falla('El servicio de cotización no respondió. Probá de nuevo en un momento.', r.status === 429 ? 429 : 502, 'infoauto');
  }
  let paginacion: any = null;
  try { paginacion = JSON.parse(r.headers.get('x-pagination') || 'null'); } catch { paginacion = null; }
  return { cuerpo: await r.json().catch(() => null), paginacion };
}

/** Una lista paginada, pedida a demanda (marcas, modelos de una marca, versiones de un modelo), con tope. */
async function todas(ruta: string, maxPaginas = 10): Promise<any[]> {
  const out: any[] = [], vistos = new Set<string>();
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const { cuerpo, paginacion } = await infoauto(ruta, { page: pagina, page_size: 100 });
    const items = Array.isArray(cuerpo) ? cuerpo : [];
    let nuevos = 0;
    for (const x of items) {
      const k = String(x?.codia ?? x?.id ?? JSON.stringify(x));
      if (vistos.has(k)) continue;
      vistos.add(k); out.push(x); nuevos++;
    }
    const total = Number(paginacion?.total_pages ?? paginacion?.pages ?? paginacion?.last_page);
    if (!items.length || !nuevos) break;
    if (Number.isFinite(total) && total > 0 ? pagina >= total : items.length < 100) break;
  }
  return out;
}

// ───────────────────────── Referencia cifrada del vehículo ─────────────────────────
let claveRef: CryptoKey | null = null;
async function clave(): Promise<CryptoKey> {
  if (claveRef) return claveRef;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`agencias-ref:${CLAVE_SERVICIO}`));
  claveRef = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return claveRef;
}
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function cifrar(codia: number): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await clave(), new TextEncoder().encode(String(codia))));
  const out = new Uint8Array(iv.length + c.length);
  out.set(iv); out.set(c, iv.length);
  return b64u(out);
}

async function descifrar(ref: unknown): Promise<number> {
  try {
    const b = deB64u(String(ref || '').slice(0, 200));
    const p = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, await clave(), b.slice(12));
    const n = Number(new TextDecoder().decode(p));
    if (Number.isInteger(n) && n > 0) return n;
  } catch { /* abajo */ }
  throw new Falla('No se reconoce el vehículo elegido. Elegilo de nuevo.', 400, 'ref');
}

// ───────────────────────── Datos que se muestran ─────────────────────────
const texto = (x: unknown) => String(x ?? '').replace(/\s+/g, ' ').trim();
const enPesos = (miles: unknown) => Math.round((Number(miles) || 0) * 1000); // InfoAuto informa en miles

let anioCache: { n: number; hasta: number } | null = null;
/** El año en curso según InfoAuto (los usados se cotizan contra él), guardado una hora. */
async function anioActual(): Promise<number> {
  if (anioCache && anioCache.hasta > Date.now()) return anioCache.n;
  const { cuerpo } = await infoauto('/current_year');
  const v = Number(cuerpo?.year ?? cuerpo?.current_year ?? cuerpo);
  const n = Number.isInteger(v) && v > 1990 ? v : new Date().getFullYear();
  anioCache = { n, hasta: Date.now() + 3_600_000 };
  return n;
}

/** Los años financiables de un modelo (sin precios). '0km' si tiene precio de lista. */
async function aniosDe(codia: number, a: any): Promise<{ anios: string[]; precios: Map<string, number> }> {
  const [usados, lista, actual] = await Promise.all([
    infoauto(`/models/${codia}/prices/`), infoauto(`/models/${codia}/list_price`), anioActual(),
  ]);
  const minimo = anioMinimo(a, actual), precios = new Map<string, number>();
  for (const p of Array.isArray(usados.cuerpo) ? usados.cuerpo : []) {
    const anio = Math.trunc(Number(p?.year)), pesos = enPesos(p?.price);
    if (anio > 1900 && pesos > 0 && anio >= minimo) precios.set(String(anio), pesos);
  }
  const cero = enPesos(lista.cuerpo?.list_price);
  if (cero > 0) precios.set('0km', cero);
  const anios = [...precios.keys()].sort((x, y) => (x === '0km' ? -1 : y === '0km' ? 1 : Number(y) - Number(x)));
  return { anios, precios };
}

/** Los años que abarca una versión según el listado (`prices_from`–`prices_to` y '0km' si tiene precio de lista), sin
 *  precios: sirven para elegir primero el año y después la versión. Es el rango del listado; el año exacto lo confirma
 *  `aniosDe` al elegir la versión (puede haber años sueltos sin precio). */
function aniosDeVersion(m: any, minimo: number, actual: number): string[] {
  const xs: string[] = [];
  if (m?.list_price) xs.push('0km');
  if (m?.prices) {
    const hasta = Math.min(Math.trunc(Number(m.prices_to)) || 0, actual + 1);
    const desde = Math.max(Math.trunc(Number(m.prices_from)) || hasta, minimo || 0, 1990);
    for (let y = hasta; y >= desde; y--) xs.push(String(y));
  }
  return xs;
}

function plazosValidos(a: any): number[] {
  return (Array.isArray(a.plazos) ? a.plazos : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 120).sort((x: number, y: number) => x - y);
}

function cuotaDe(monto: number, cuotas: number, a: any, tasa: number) {
  return simularCredito({ capital: monto, cuotas, g: a.gastos || {}, tasa });
}

/** El crédito para un vehículo (referencia cifrada), un año y un plazo, con los parámetros vigentes. */
const cuitDeCotizacion = (x: unknown) => { const c = soloDigitos(x).slice(0, 20); return c.length === 11 && cuitValido(c) ? c : ''; };

async function calcular(pedido: any, a: any) {
  const codia = await descifrar(pedido.ref);
  const anio = String(pedido.anio || '');
  const plazos = plazosValidos(a);
  const cuotas = Math.trunc(Number(pedido.cuotas));
  if (!plazos.includes(cuotas)) throw new Falla('Elegí uno de los plazos disponibles.', 400, 'plazo');
  const [{ precios }, actual] = await Promise.all([aniosDe(codia, a), anioActual()]);
  const valor = precios.get(anio);
  if (!valor) throw new Falla('Ese año no se puede financiar para este vehículo.', 400, 'anio');
  const maximo = montoMaximo(valor, a);
  if (!maximo) return { financiable: false as const };
  const pedidoMonto = Math.round(Number(pedido.monto) || 0);
  const minimo = Math.max(Number(a.monto_minimo) || 0, 1);
  // Lo más que se puede prestar: lo que pidió la agencia (si pidió algo) sin pasar el máximo de la Mutual.
  const techo = pedidoMonto > 0 ? Math.min(pedidoMonto, maximo) : maximo;
  if (techo < minimo) throw new Falla(`El monto mínimo es de $ ${minimo.toLocaleString('es-AR')}.`, 400, 'monto');
  const tasa = tasaPara(anio, a, actual);
  // «Quiero pagar hasta $X por mes»: en cada plazo, el monto más alto (de a `paso` pesos) cuya cuota no pase de X.
  // La cuota crece con el monto, así que se busca por mitades. Nunca pasa del techo, que ya está por debajo del máximo.
  const cuotaMax = Math.round(Number(pedido.cuota_max) || 0);
  const paso = Math.max(1000, Number(a.redondeo) || 0);
  const montoParaCuota = (n: number): number => {
    const cuotaDeMonto = (m: number) => cuotaDe(m, n, a, tasa)?.cuota ?? Infinity;
    if (cuotaDeMonto(techo) <= cuotaMax) return techo;
    let lo = Math.ceil(minimo / paso), hi = Math.floor(techo / paso);
    if (lo > hi || cuotaDeMonto(lo * paso) > cuotaMax) return 0;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (cuotaDeMonto(mid * paso) <= cuotaMax) lo = mid; else hi = mid - 1; }
    return lo * paso;
  };
  let monto = techo;
  if (cuotaMax > 0) {
    monto = montoParaCuota(cuotas);
    if (!monto) throw new Falla(`Con una cuota de hasta $ ${cuotaMax.toLocaleString('es-AR')} no se llega al monto mínimo en ${cuotas} ${cuotas === 1 ? 'cuota' : 'cuotas'}. Probá con más cuotas o una cuota mayor.`, 400, 'cuota_max');
  }
  const sim = cuotaDe(monto, cuotas, a, tasa);
  if (!sim) throw new Falla('No se pudo calcular el crédito con estos datos.', 400, 'calculo');
  const opciones = plazos.map((n) => {
    const m = cuotaMax > 0 ? montoParaCuota(n) : monto;
    const s = m ? cuotaDe(m, n, a, tasa) : null;
    return s ? (cuotaMax > 0 ? { cuotas: n, cuota: s.cuota, monto: m } : { cuotas: n, cuota: s.cuota }) : null;
  }).filter(Boolean);
  // Qué parte del valor del vehículo se presta: solo para la Mutual (va en los datos de la solicitud, que la agencia no ve).
  const pct = Math.round((monto / valor) * 1000) / 10;
  return { financiable: true as const, anio, maximo, monto, cuotas, tasa, sim, opciones, pct, cuotaMax };
}

// ───────────────────────── Foto del vehículo (ver foto.js) ─────────────────────────
const FOTOS = (Deno.env.get('AGENCIAS_FOTOS') || 'si').toLowerCase() !== 'no';

/** La foto del modelo como data:image/…;base64, o null. Nunca corta la cotización: cualquier falla es «sin foto». */
async function fotoDe(codia: number): Promise<string | null> {
  if (!FOTOS) return null;
  try {
    const { cuerpo } = await infoauto(`/models/${codia}/photos/`);
    const url = urlDeFoto(cuerpo, `${API}/`);
    if (!url) return null;
    // Si la foto está en la misma API, va con el token; si es de otro servidor (un CDN), sin nada.
    const mismaApi = new URL(url).host === new URL(API).host;
    const r = await fetch(url, { headers: mismaApi ? { authorization: `Bearer ${await accessToken()}` } : {}, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    if (Number(r.headers.get('content-length') || 0) > MAX_FOTO) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    const tipo = bytes.length <= MAX_FOTO ? tipoImagen(bytes) : null;
    return tipo ? `data:${tipo};base64,${base64(bytes)}` : null;
  } catch (e) {
    console.error(JSON.stringify({ agencias: 'foto', error: String((e as Error)?.message || e).slice(0, 200) }));
    return null;
  }
}

// ───────────────────────── Chat de las agencias (botón «M») ─────────────────────────
// El asistente contesta primero; si la agencia lo pide, la conversación queda «en espera» y se le avisa a la Mutual
// (notificación al celular y, si están cargados RESEND_API_KEY y AVISO_EMAIL, mail). La Mutual responde desde
// Créditos y Cobros → Agencias → Chats. Las agencias hablan siempre con esta función: las tablas están cerradas a la API.
async function rest(metodo: string, ruta: string, cuerpo?: unknown, extra: Record<string, string> = {}): Promise<any> {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, {
    method: metodo,
    headers: { ...servicio, ...(cuerpo !== undefined ? { prefer: 'return=representation' } : {}), ...extra },
    body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
  });
  if (!r.ok) throw new Falla('No se pudo completar el pedido. Probá de nuevo en un momento.', 502, 'base');
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const contar = async (ruta: string): Promise<number> => {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, { method: 'HEAD', headers: { ...servicio, prefer: 'count=exact' } });
  return Number((r.headers.get('content-range') || '').split('/')[1]) || 0;
};
const ahoraISO = () => new Date().toISOString();
const inicioDelDia = () => new Date(`${hoyCordoba()}T00:00:00-03:00`).toISOString();

// Cada vendedor tiene su conversación (migración 0042): lo que habla uno no lo ve otro de la misma agencia.
async function chatAbierto(vendedorId: string): Promise<any> {
  const [c] = await rest('GET', `chats_agencia?vendedor_id=eq.${vendedorId}&estado=neq.cerrado&select=*`);
  return c || null;
}
async function chatNuevo(ag: any): Promise<any> {
  try { const [c] = await rest('POST', 'chats_agencia', { agencia_id: ag.id, vendedor_id: ag.vendedor_id, agencia: String(ag.nombre).slice(0, 120), vendedor: String(ag.vendedor || '').slice(0, 120) }); return c; } catch (e) {
    const c = await chatAbierto(ag.vendedor_id); // dos pedidos a la vez: el segundo se encuentra con el primero
    if (c) return c;
    throw e;
  }
}
// Del audio solo sale que existe y cuánto dura (`audio_seg`): la ruta no la ve nadie fuera de la función.
const mensajesDe = (chat: string, desde = 0): Promise<any[]> =>
  rest('GET', `mensajes_agencia?chat_id=eq.${chat}&id=gt.${Math.max(0, Math.trunc(desde) || 0)}&select=id,de,texto,momento,audio_seg&order=id.asc&limit=300`);
async function agregar(chat: string, de: string, texto: string, audio?: Record<string, unknown>): Promise<any> {
  const [m] = await rest('POST', 'mensajes_agencia', { chat_id: chat, de, texto, ...(audio || {}) });
  return { id: m.id, de: m.de, texto: m.texto, momento: m.momento, audio_seg: m.audio_seg ?? null };
}
const marcar = (chat: string, cambios: Record<string, unknown>) => rest('PATCH', `chats_agencia?id=eq.${chat}`, { actualizado: ahoraISO(), ...cambios });
const vistaChat = (c: any) => (c ? { id: c.id, estado: c.estado, sin_leer: !!c.sin_leer_agencia } : null);

/** Le pregunta al asistente. null si no se pudo (sin clave, sin crédito, saturado…): el que llama ofrece el representante. */
async function preguntarAlAsistente(a: any, agencia: string, filas: any[]): Promise<string | null> {
  const clave = Deno.env.get('ANTHROPIC_API_KEY') || '';
  const messages = armarMensajes(filas);
  if (!clave || !messages.length) return null;
  const cuerpo = JSON.stringify({ model: MODELO_CHAT, max_tokens: 500, system: instrucciones(a, agencia), messages });
  for (let intento = 0; intento < 2; intento++) {
    try {
      const r = await fetch(`${URL_CLAUDE}/v1/messages`, {
        method: 'POST', headers: { 'x-api-key': clave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: cuerpo, signal: AbortSignal.timeout(25_000),
      });
      if (r.ok) {
        const d = await r.json();
        const t = (Array.isArray(d?.content) ? d.content : []).filter((b: any) => b?.type === 'text').map((b: any) => String(b.text || '')).join('\n').trim();
        return t || null;
      }
      // Sin el detalle (podría llevar texto de la conversación): solo el estado y el tipo de error, para el panel de registros.
      let tipo = ''; try { tipo = String((await r.json())?.error?.type || ''); } catch { /* sin cuerpo */ }
      console.error(JSON.stringify({ agencias: 'asistente', status: r.status, tipo }));
      if (!(r.status === 429 || r.status === 529 || r.status >= 500) || intento) return null;
    } catch {
      console.error(JSON.stringify({ agencias: 'asistente', status: 0 }));
      if (intento) return null;
    }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return null;
}

// ── Avisos a la Mutual ──
async function clavesPush(): Promise<{ publica: string; privada: JsonWebKey }> {
  const leer = async () => (await rest('GET', 'push_claves?id=eq.1&select=publica,privada'))?.[0];
  let f = await leer();
  if (!f) {
    const n = await nuevasClaves();
    await fetch(`${URL_BASE}/rest/v1/push_claves?on_conflict=id`, { method: 'POST', headers: { ...servicio, prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ id: 1, publica: n.publica, privada: n.privada }) });
    f = await leer(); // si dos pedidos las crearon a la vez, vale la que quedó guardada
  }
  if (!f) throw new Falla('No se pudieron preparar los avisos.', 502, 'base');
  return f;
}

/** Notificación al celular de cada usuario de la Mutual que la activó y, si está configurado, un mail. Nunca corta el pedido. */
async function avisarMutual(titulo: string, cuerpo: string, url: string, soloUsuario?: string): Promise<{ enviados: number; fallidos: number; mail: boolean }> {
  const res = { enviados: 0, fallidos: 0, mail: false };
  try {
    const subs: any[] = await rest('GET', `avisos_push?select=id,endpoint,p256dh,auth${soloUsuario ? `&user_id=eq.${soloUsuario}` : ''}`);
    if (subs?.length) {
      const claves = await clavesPush();
      await Promise.all(subs.map(async (s) => {
        const r = await enviarPush(s, { t: titulo, c: cuerpo, u: url }, claves, { sujeto: SUJETO_VAPID });
        if (r.ok) res.enviados++; else res.fallidos++;
        if (r.vencida) await rest('DELETE', `avisos_push?id=eq.${s.id}`).catch(() => {});
        else if (!r.ok) console.error(JSON.stringify({ agencias: 'push', status: r.status }));
      }));
    }
  } catch { console.error(JSON.stringify({ agencias: 'push', status: -1 })); }
  const clave = Deno.env.get('RESEND_API_KEY') || '', para = Deno.env.get('AVISO_EMAIL') || '';
  if (clave && para && !soloUsuario) {
    try {
      const r = await fetch(Deno.env.get('RESEND_URL') || 'https://api.resend.com/emails', {
        method: 'POST', headers: { authorization: `Bearer ${clave}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ from: Deno.env.get('AVISO_REMITENTE') || 'Mutual Bell <onboarding@resend.dev>', to: [para], subject: titulo, text: `${cuerpo}\n\nResponder: https://emilsoler.github.io/Gestor/cobranzas/#agencias-chats` }),
      });
      res.mail = r.ok;
      if (!r.ok) console.error(JSON.stringify({ agencias: 'mail', status: r.status }));
    } catch { console.error(JSON.stringify({ agencias: 'mail', status: 0 })); }
  }
  return res;
}
const aBase64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

/** El audio de un mensaje, ya bajado (base64): así el navegador lo reproduce sin abrir otra conexión ni ver la ruta.
 *  `vendedorId`: si viene, solo se entrega si el mensaje es de una conversación de ese vendedor. */
async function audioDeMensaje(id: unknown, vendedorId?: string): Promise<{ tipo: string; seg: number; datos: string }> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) throw new Falla('Falta el mensaje.', 400, 'pedido');
  const [m] = await rest('GET', `mensajes_agencia?id=eq.${n}&select=chat_id,audio_path,audio_tipo,audio_seg`);
  if (!m?.audio_path) throw new Falla('Ese mensaje no tiene audio.', 404, 'audio');
  if (vendedorId && !(await rest('GET', `chats_agencia?id=eq.${m.chat_id}&vendedor_id=eq.${vendedorId}&select=id`))?.length) throw new Falla('Ese mensaje no tiene audio.', 404, 'audio');
  const url = await enlace(String(m.audio_path), CARPETA_AUDIOS);
  const r = url ? await fetch(url) : null;
  if (!r || !r.ok) throw new Falla('No se pudo traer el audio. Probá de nuevo en un momento.', 502, 'almacen');
  return { tipo: String(m.audio_tipo), seg: Number(m.audio_seg) || 0, datos: aBase64(new Uint8Array(await r.arrayBuffer())) };
}

const controlarTope = async (agenciaId: string) => {
  if (await contar(`mensajes_agencia?de=eq.agencia&momento=gte.${encodeURIComponent(inicioDelDia())}&select=id,chats_agencia!inner(agencia_id)&chats_agencia.agencia_id=eq.${agenciaId}`) >= TOPE_AGENCIA_DIA)
    throw new Falla('Llegaste al tope de mensajes de hoy. Probá mañana o consultá con la Mutual.', 429, 'tope');
};
const URL_CHATS = '/Gestor/cobranzas/#agencias-chats';
const resumen = (t: string, n = 140) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Todas las acciones del chat y de los avisos. `ag.miembro`: la Mutual (responde y administra); si no, una agencia. */
async function accionChat(accion: string, pedido: any, ctx: { ag: any; a: any; uid: string; form: FormData | null }, cors: Cors): Promise<Response> {
  const { ag, a, uid, form } = ctx;
  const ok = (cuerpo: unknown) => responder(cuerpo, 200, cors);

  // ── La Mutual ──
  if (accion === 'chats' || accion === 'chat_resumen') {
    if (!ag.miembro) throw new Falla('Pedido desconocido.', 400, 'accion');
    const [espera, sinLeer, atencion] = await Promise.all([
      contar('chats_agencia?estado=eq.espera&select=id'),
      contar('chats_agencia?sin_leer_mutual=eq.true&estado=neq.cerrado&select=id'),
      contar('chats_agencia?estado=neq.cerrado&or=(estado.eq.espera,sin_leer_mutual.eq.true)&select=id'), // las que piden atención (para la insignia)
    ]);
    if (accion === 'chat_resumen') return ok({ espera, sin_leer: sinLeer, atencion });
    const chats = await rest('GET', 'chats_agencia?select=*,ultimo:mensajes_agencia(de,texto,momento)&ultimo.order=id.desc&ultimo.limit=1&order=actualizado.desc&limit=100');
    return ok({ espera, sin_leer: sinLeer, atencion, chats: (chats || []).map((c: any) => ({ ...c, ultimo: c.ultimo?.[0] || null })) });
  }
  if (accion === 'chat_ver' || accion === 'chat_responder') {
    if (!ag.miembro) throw new Falla('Pedido desconocido.', 400, 'accion');
    if (!esUuid(pedido.chat)) throw new Falla('Falta la conversación.', 400, 'pedido');
    const [c] = await rest('GET', `chats_agencia?id=eq.${pedido.chat}&select=*`);
    if (!c) throw new Falla('Esa conversación ya no existe.', 404, 'chat');
    if (accion === 'chat_ver') {
      if (c.sin_leer_mutual) { await marcar(c.id, { sin_leer_mutual: false }); c.sin_leer_mutual = false; }
      return ok({ chat: c, mensajes: await mensajesDe(c.id) });
    }
    if (c.estado === 'cerrado') throw new Falla('La conversación está cerrada.', 409, 'cerrado');
    const t = textoDeAgencia(pedido.texto);
    if (!t) throw new Falla('Escribí tu respuesta.', 400, 'pedido');
    const m = await agregar(c.id, 'mutual', t);
    await marcar(c.id, { estado: 'humano', espera_desde: null, sin_leer_agencia: true, sin_leer_mutual: false });
    return ok({ mensaje: m });
  }
  if (accion === 'chat_cerrar' && ag.miembro) {
    if (!esUuid(pedido.chat)) throw new Falla('Falta la conversación.', 400, 'pedido');
    await marcar(pedido.chat, { estado: 'cerrado', espera_desde: null, sin_leer_mutual: false });
    return ok({ ok: true });
  }
  if (accion === 'chat_eliminar' && ag.miembro) {
    // Borra la conversación entera (los mensajes se van con ella por la clave foránea) y los audios que hubiera en el almacenamiento.
    if (!esUuid(pedido.chat)) throw new Falla('Falta la conversación.', 400, 'pedido');
    const audios = await rest('GET', `mensajes_agencia?chat_id=eq.${pedido.chat}&audio_path=not.is.null&select=audio_path`);
    await rest('DELETE', `chats_agencia?id=eq.${pedido.chat}`);
    await borrarArchivos((audios || []).map((x: any) => String(x.audio_path)), CARPETA_AUDIOS);
    return ok({ ok: true });
  }
  if (accion === 'chat_audio_ver' && ag.miembro) return ok(await audioDeMensaje(pedido.mensaje));
  if (accion === 'push_clave') {
    if (!ag.miembro) throw new Falla('Pedido desconocido.', 400, 'accion');
    return ok({ publica: (await clavesPush()).publica });
  }
  if (accion === 'push_suscribir' || accion === 'push_quitar' || accion === 'push_probar') {
    if (!ag.miembro) throw new Falla('Pedido desconocido.', 400, 'accion');
    const s = pedido.suscripcion || {}, endpoint = String(s.endpoint || '');
    if (accion === 'push_probar') {
      const r = await avisarMutual('Aviso de prueba', 'Si ves esto, los avisos del chat de las agencias funcionan en este celular.', URL_CHATS, uid);
      return ok({ ...r, celulares: await contar(`avisos_push?user_id=eq.${uid}&select=id`) });
    }
    if (!/^https:\/\/[^\s]{10,1990}$/.test(endpoint) && !(PUSH_LOCAL && /^http:\/\/127\.0\.0\.1:\d+\/[^\s]{0,200}$/.test(endpoint))) throw new Falla('El celular no mandó una suscripción válida.', 400, 'pedido');
    if (accion === 'push_quitar') { await rest('DELETE', `avisos_push?endpoint=eq.${encodeURIComponent(endpoint)}&user_id=eq.${uid}`); return ok({ ok: true }); }
    const p256dh = String(s.keys?.p256dh || ''), auth = String(s.keys?.auth || '');
    if (!/^[\w-]{20,200}$/.test(p256dh) || !/^[\w-]{10,100}$/.test(auth)) throw new Falla('El celular no mandó una suscripción válida.', 400, 'pedido');
    await rest('POST', 'avisos_push?on_conflict=endpoint', { user_id: uid, endpoint, p256dh, auth, agente: String(pedido.agente || '').slice(0, 300) }, { prefer: 'resolution=merge-duplicates,return=minimal' });
    return ok({ ok: true });
  }

  // ── Las agencias ──
  if (ag.miembro) throw new Falla('Entrá con la cuenta de una agencia para probar el chat.', 400, 'accion');
  if (!a.chat_habilitado) throw new Falla('El chat todavía no está habilitado.', 403, 'chat_apagado');

  if (accion === 'chat_leer') {
    const c = await chatAbierto(ag.vendedor_id);
    if (!c) return ok({ chat: null, mensajes: [] });
    const mensajes = await mensajesDe(c.id, Number(pedido.desde) || 0);
    if (pedido.leido === true && c.sin_leer_agencia) await rest('PATCH', `chats_agencia?id=eq.${c.id}`, { sin_leer_agencia: false });
    return ok({ chat: vistaChat(c), mensajes });
  }
  if (accion === 'chat_cerrar') {
    const c = await chatAbierto(ag.vendedor_id);
    if (c) await marcar(c.id, { estado: 'cerrado', espera_desde: null, sin_leer_mutual: false });
    return ok({ ok: true });
  }
  if (accion === 'chat_enviar') {
    const t = textoDeAgencia(pedido.texto);
    if (!t) throw new Falla('Escribí tu mensaje.', 400, 'pedido');
    await controlarTope(ag.id);
    const c = (await chatAbierto(ag.vendedor_id)) || (await chatNuevo(ag));
    const mio = await agregar(c.id, 'agencia', t);
    const nuevos = [mio];
    const estado = c.estado; let derivar = false;
    if (c.estado === 'bot') {
      let texto = SIN_ASISTENTE;
      derivar = true;
      const respuestas = await contar(`mensajes_agencia?de=eq.bot&momento=gte.${encodeURIComponent(inicioDelDia())}&select=id,chats_agencia!inner(agencia_id)&chats_agencia.agencia_id=eq.${ag.id}`);
      if (respuestas >= TOPE_ASISTENTE_DIA) texto = RESPUESTA_SEGURA;
      else {
        const crudo = await preguntarAlAsistente(a, ag.nombre, await rest('GET', `mensajes_agencia?chat_id=eq.${c.id}&select=de,texto&order=id.desc&limit=30`).then((x: any[]) => x.reverse()));
        if (crudo) { const l = limpiarRespuesta(crudo); texto = l.texto; derivar = l.derivar; }
      }
      nuevos.push(await agregar(c.id, 'bot', texto));
      await marcar(c.id, {});
    } else {
      // Con un representante en juego el asistente se calla; se avisa solo si la Mutual ya había leído lo anterior.
      await marcar(c.id, { sin_leer_mutual: true });
      if (!c.sin_leer_mutual) await avisarMutual(`${ag.nombre}: mensaje nuevo`, resumen(t), URL_CHATS);
    }
    return ok({ chat: { id: c.id, estado, sin_leer: false }, mensajes: nuevos, derivar });
  }
  if (accion === 'chat_audio_ver') return ok(await audioDeMensaje(pedido.mensaje, ag.vendedor_id));
  if (accion === 'chat_audio') {
    // Un mensaje de voz solo se manda cuando ya hay una persona de la Mutual en la conversación: el asistente no escucha audios.
    const c = await chatAbierto(ag.vendedor_id);
    if (!c || c.estado === 'bot') throw new Falla('Los audios son para hablar con una persona de la Mutual: primero tocá «Hablar con un representante».', 409, 'audio_sin_representante');
    const f = form?.get('audio'), seg = segundosDeAudio(pedido.seg);
    if (!(f instanceof File) || !seg) throw new Falla('Falta el audio.', 400, 'pedido');
    if (!f.size) throw new Falla('El audio está vacío. Probá grabarlo de nuevo.', 400, 'vacio');
    if (f.size > MAX_AUDIO_BYTES) throw new Falla('El audio es muy largo. Grabalo más corto (hasta 2 minutos).', 413, 'tamano');
    const bytes = new Uint8Array(await f.arrayBuffer()), tipo = tipoAudio(bytes);
    if (!tipo) throw new Falla('Ese archivo no es un audio que podamos recibir. Probá grabarlo de nuevo.', 415, 'tipo');
    await controlarTope(ag.id);
    const path = `${c.id}/${crypto.randomUUID()}.${tipo.ext}`;
    await subirArchivo(path, bytes, tipo.tipo, CARPETA_AUDIOS);
    let m;
    try { m = await agregar(c.id, 'agencia', TEXTO_AUDIO, { audio_path: path, audio_seg: seg, audio_tipo: tipo.tipo }); } catch (e) { await borrarArchivos([path], CARPETA_AUDIOS); throw e; }
    await marcar(c.id, { sin_leer_mutual: true });
    if (!c.sin_leer_mutual) await avisarMutual(`${ag.nombre}: mensaje de voz`, `Te mandó un audio de ${seg} s.`, URL_CHATS);
    return ok({ chat: { id: c.id, estado: c.estado, sin_leer: false }, mensajes: [m] });
  }
  if (accion === 'chat_representante') {
    const c = await chatAbierto(ag.vendedor_id);
    const ultima = c ? (await rest('GET', `mensajes_agencia?chat_id=eq.${c.id}&de=eq.agencia&select=texto&order=id.desc&limit=1`))?.[0] : null;
    if (!c || !ultima) throw new Falla('Escribí primero tu consulta, así la Mutual sabe de qué se trata.', 400, 'sin_consulta');
    if (c.estado !== 'bot') return ok({ chat: vistaChat(c), mensajes: [] });
    const m = await agregar(c.id, 'bot', 'Listo, le avisé a la Mutual. Te van a responder por acá apenas puedan.');
    await marcar(c.id, { estado: 'espera', espera_desde: ahoraISO(), sin_leer_mutual: true });
    await avisarMutual(`${ag.nombre} quiere hablar con vos`, resumen(String(ultima.texto)), URL_CHATS);
    return ok({ chat: { id: c.id, estado: 'espera', sin_leer: false }, mensajes: [m] });
  }
  throw new Falla('Pedido desconocido.', 400, 'accion');
}

// ───────────────────────── Pedido ─────────────────────────
export async function manejar(req: Request): Promise<Response> {
  const cors = cabeceras(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return responder({ error: 'metodo', mensaje: 'Solo POST.' }, 405, cors);

  try {
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!jwt) throw new Falla('Falta iniciar sesión.', 401, 'sin_sesion');
    const uid = await usuario(jwt);
    if (!uid) throw new Falla('La sesión venció: volvé a ingresar.', 401, 'sin_sesion');
    const ses = await rpc('agencia_sesion', { p_user: uid });
    if (!ses?.agencia) throw new Falla('Esta cuenta no está habilitada para usar el cotizador.', 403, 'sin_acceso');
    const ag = ses.agencia, a = ses.ajustes || {};

    // Los archivos llegan como formulario (multipart), uno por pedido; todo lo demás, en JSON.
    let pedido: any, form: FormData | null = null;
    if (/multipart\/form-data/i.test(req.headers.get('content-type') || '')) {
      try { form = await req.formData(); } catch { throw new Falla('El archivo no se pudo leer. Probá de nuevo.', 400, 'pedido'); }
      pedido = { accion: String(form.get('accion') || ''), seg: form.get('seg') };
      if (pedido.accion !== 'archivo' && pedido.accion !== 'chat_audio') throw new Falla('Pedido desconocido.', 400, 'accion');
    } else {
      try { pedido = await req.json(); } catch { throw new Falla('El pedido no se pudo leer.', 400, 'pedido'); }
    }
    const accion = String(pedido?.accion || '');

    if (accion === 'yo') {
      return responder({
        agencia: ag.nombre, vendedor: ag.miembro ? '' : String(ag.vendedor || ''), titular: !!ag.titular, miembro: !!ag.miembro, clave_temporal: !!ag.clave_temporal,
        habilitado: !!a.habilitado, plazos: plazosValidos(a), leyenda: String(a.leyenda || ''), contacto: String(a.contacto || ''),
        relacion_max: Number(a.relacion_max) || 45,
        chat: !!a.chat_habilitado && !ag.miembro,
        // Solo la agencia marcada (la de prueba de la persona): los valores con que arranca la simulación rápida.
        ...(ag.simulacion_rapida ? { rapida: { tasa: tasaPara('0km', a, new Date().getFullYear()), gastos: a.gastos || {} } } : {}),
      }, 200, cors);
    }
    if (accion === 'clave_definida') {
      if (!ag.miembro) await rpc('agencia_clave_definida', { p_user: uid });
      return responder({ ok: true }, 200, cors);
    }
    if (ag.clave_temporal) throw new Falla('Antes de cotizar, elegí tu contraseña definitiva.', 403, 'clave_temporal');
    if (!a.habilitado && !ag.miembro) throw new Falla('El cotizador todavía no está habilitado. Consultá con la Mutual.', 403, 'deshabilitado');

    if (/^(chat|push_)/.test(accion) || accion === 'chats') return await accionChat(accion, pedido, { ag, a, uid, form }, cors);

    if (accion === 'marcas') {
      const xs = await todas('/brands/');
      const marcas = xs.filter((m) => m && Number.isInteger(Number(m.id)) && texto(m.name) && (m.prices || m.list_price))
        .map((m) => ({ id: Number(m.id), nombre: texto(m.name) })).sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
      return responder({ marcas }, 200, cors);
    }
    if (accion === 'modelos') {
      const marca = Math.trunc(Number(pedido.marca));
      if (!(marca > 0)) throw new Falla('Elegí una marca.', 400, 'pedido');
      const minimo = anioMinimo(a, await anioActual());
      const xs = await todas(`/brands/${marca}/groups/`);
      const modelos = xs.filter((g) => g && Number.isInteger(Number(g.id)) && texto(g.name) && (g.list_price || (g.prices && (!minimo || Number(g.prices_to) >= minimo))))
        .map((g) => ({ id: Number(g.id), nombre: texto(g.name) })).sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
      return responder({ modelos }, 200, cors);
    }
    if (accion === 'versiones') {
      const marca = Math.trunc(Number(pedido.marca)), grupo = Math.trunc(Number(pedido.grupo));
      if (!(marca > 0) || !(grupo > 0)) throw new Falla('Elegí la marca y el modelo.', 400, 'pedido');
      const actual = await anioActual(), minimo = anioMinimo(a, actual);
      const xs = await todas(`/brands/${marca}/groups/${grupo}/models/`);
      const versiones = [];
      for (const m of xs) {
        const codia = Math.trunc(Number(m?.codia));
        if (!(codia > 0) || !texto(m.description)) continue;
        if (!m.list_price && !(m.prices && (!minimo || Number(m.prices_to) >= minimo))) continue;
        versiones.push({ ref: await cifrar(codia), nombre: texto(m.description), anios: aniosDeVersion(m, minimo, actual) });
      }
      versiones.sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
      return responder({ versiones }, 200, cors);
    }
    if (accion === 'anios') {
      const codia = await descifrar(pedido.ref);
      const { anios } = await aniosDe(codia, a);
      return responder({ anios }, 200, cors);
    }
    if (accion === 'foto') {
      const codia = await descifrar(pedido.ref);
      return responder({ foto: await fotoDe(codia) }, 200, cors);
    }
    if (accion === 'cotizar') {
      const c = await calcular(pedido, a);
      if (!c.financiable) return responder({ financiable: false, mensaje: 'Este vehículo no alcanza el monto mínimo de financiación.' }, 200, cors);
      if (!ag.miembro) {
        const ok = await rpc('agencia_registrar', {
          p_user: uid, p_vehiculo: texto(pedido.vehiculo).slice(0, 200), p_anio: c.anio, p_monto: c.monto, p_cuotas: c.cuotas, p_cuota: c.sim.cuota,
          // El CUIT que la agencia consultó, para la lista de cotizaciones de la Mutual; un CUIT mal escrito no se guarda.
          p_cuit: cuitDeCotizacion(pedido?.cuit),
        });
        if (ok !== true) throw new Falla('Llegaste al tope de cotizaciones de hoy. Probá mañana o consultá con la Mutual.', 429, 'tope');
      }
      // Solo condiciones del préstamo: ni el valor del vehículo ni el CODIA.
      return responder({
        financiable: true, anio: c.anio, maximo: c.maximo, monto: c.monto, cuotas: c.cuotas, cuota: c.sim.cuota, total: c.sim.totalCredito,
        gastos_otorgamiento: c.sim.gastos, ...tasasDelCredito(c.sim), opciones: c.opciones,
        ...(c.cuotaMax > 0 ? { cuota_max: c.cuotaMax } : {}),
        leyenda: String(a.leyenda || ''), contacto: String(a.contacto || ''),
      }, 200, cors);
    }
    if (accion === 'rapida') {
      // Simulación rápida: capital, cuotas, tasa y gastos a mano, sin CUIT ni vehículo. Solo para la agencia marcada
      // (migración 0036); a las demás se les contesta como a un pedido que no existe. No usa InfoAuto ni se registra.
      if (!ag.simulacion_rapida) throw new Falla('Pedido desconocido.', 400, 'accion');
      const capital = Math.round(Number(pedido.capital) || 0), cuotas = Math.trunc(Number(pedido.cuotas));
      const tasa = Number(pedido.tasa);
      if (!(capital > 0)) throw new Falla('Escribí el capital.', 400, 'capital');
      if (!(cuotas >= 1 && cuotas <= 120)) throw new Falla('Las cuotas tienen que ser de 1 a 120.', 400, 'cuotas');
      if (!(tasa >= 0 && tasa <= 100)) throw new Falla('Revisá la tasa mensual.', 400, 'tasa');
      const g: Record<string, number | null> = {};
      for (const k of ['sellado', 'arancel', 'arancelMin', 'contratos', 'envio', 'gestoria', 'seguro', 'administrativos', 'cuotaSocial', 'igr']) {
        g[k] = Math.max(0, Number(pedido.gastos?.[k]) || 0);
      }
      g.redondeo = null; // automático, como en el cotizador
      const sim = simularCredito({ capital, cuotas, g, tasa });
      if (!sim) throw new Falla('No se pudo calcular el crédito con estos datos.', 400, 'calculo');
      const opciones = plazosValidos(a).map((n) => { const s = simularCredito({ capital, cuotas: n, g, tasa }); return s ? { cuotas: n, cuota: s.cuota } : null; }).filter(Boolean);
      return responder({
        financiable: true, rapida: true, monto: capital, cuotas, cuota: sim.cuota, total: sim.totalCredito, tasa,
        gastos_otorgamiento: sim.gastos, sellado: sim.sellado, arancel: sim.arancel, ...tasasDelCredito(sim), opciones,
      }, 200, cors);
    }
    if (accion === 'bcra') {
      // Un CUIT mal escrito se rechaza antes de preguntar: para el BCRA "no figura", y se leería como sin deudas.
      const cuit = soloDigitos(pedido?.cuit).slice(0, 20);
      if (cuit.length !== 11) throw new Falla('El CUIT o CUIL tiene que tener 11 números.', 400, 'cuit');
      if (!cuitValido(cuit)) throw new Falla('Ese CUIT o CUIL no existe: revisá los números (el último no coincide con los demás).', 400, 'cuit');
      let r;
      try { r = await consultar(cuit, { url: URL_BCRA }); } catch (e) {
        const err = e instanceof ErrorBCRA ? e : new ErrorBCRA('red', 0, sinCuit(String(e)));
        console.error(JSON.stringify({ agencias: 'bcra', tipo: err.tipo, status: err.status }));
        // Solo la cuenta de prueba de la Mutual (por id, así un cambio de nombre no la rompe): si el BCRA está caído, deja ver la cotización sin consulta (no guarda nada,
        // no hay `consulta` y por eso tampoco se puede enviar una solicitud). Las agencias reales siguen viendo el error.
        if (ag.id === CUENTA_PRUEBA && err.tipo !== 'limite') {
          return responder({ consulta: null, cuit, denominacion: '', semaforo: 'sin_consulta', periodo: '', deuda_total: 0, bancos: [], sin_consulta: true }, 200, cors);
        }
        throw new Falla(err.message, err.tipo === 'limite' ? 429 : err.tipo === 'tiempo' ? 504 : 502, `bcra_${err.tipo}`);
      }
      const resumen = resumir(r.deudas, r.cheques, r.historicas);
      let consulta: string | null = null;
      if (!ag.miembro) { // la vista previa de la Mutual no guarda (para eso está Cobranzas)
        const g = await rpc('agencia_bcra_guardar', {
          p_user: uid, p_fila: { cuit, ...resumen, resultado: { deudas: r.deudas, historicas: r.historicas, cheques: r.cheques, errores: r.errores } },
        });
        if (g?.tope) throw new Falla('Llegaste al tope de consultas de hoy. Probá mañana o consultá con la Mutual.', 429, 'tope');
        consulta = g?.id || null;
      }
      // A la agencia: el color, el nombre y un resumen de la Central de Deudores (con qué entidades opera, situación y deuda
      // informada en el último período; pedido de la persona del 18/11/2026). Lo histórico y los cheques quedan para la Mutual.
      const bancos = ultimoPeriodo(r.deudas).entidades
        .map((e: any) => ({
          entidad: String(e?.entidad ?? '').trim().slice(0, 120) || 'Entidad sin nombre',
          situacion: Math.max(0, Math.min(6, Math.trunc(Number(e?.situacion) || 0))),
          monto: Math.round((Number(e?.monto) || 0) * 1000), // el BCRA informa en miles de pesos
        }))
        .sort((a: any, b: any) => b.situacion - a.situacion || b.monto - a.monto)
        .slice(0, 40);
      return responder({
        consulta, cuit, denominacion: resumen.denominacion, semaforo: resumen.semaforo,
        periodo: resumen.periodo, deuda_total: Math.round(resumen.deuda_total), bancos,
      }, 200, cors);
    }
    if (accion === 'solicitar') {
      if (ag.miembro) throw new Falla('En la vista previa no se envían solicitudes.', 400, 'vista_previa');
      const consulta = String(pedido.consulta || '');
      if (!esUuid(consulta)) throw new Falla('Primero consultá el CUIT del cliente.', 400, 'consulta');
      if (pedido.ingresos !== true) throw new Falla('Sin ingresos demostrables no se puede solicitar el crédito.', 400, 'ingresos');
      const ingreso = Math.round(Number(pedido.ingreso) || 0);
      if (!(ingreso > 0) || ingreso > 1e11) throw new Falla('Escribí el ingreso mensual aproximado del cliente.', 400, 'ingreso');
      const categoria = String(pedido.categoria || '');
      if (!Object.hasOwn(CATEGORIAS, categoria)) throw new Falla('Elegí cómo obtiene sus ingresos el cliente.', 400, 'categoria');
      if (pedido.consentimiento !== true) throw new Falla('Falta la conformidad del cliente para enviar sus datos y documentos a la Mutual.', 400, 'consentimiento');
      const rd = revisarDatos(pedido.datos, hoyCordoba());
      if (rd.errores) throw new Falla(rd.errores.join(' '), 400, 'datos');
      const c = await calcular(pedido, a);
      if (!c.financiable) throw new Falla('Este vehículo no alcanza el monto mínimo de financiación.', 400, 'monto');
      const tope = Number(a.relacion_max) || 45, rel = relacionCuota(c.sim.cuota, ingreso) as number;
      if (rel > tope) throw new Falla(`La cuota es el ${rel.toLocaleString('es-AR')} % del ingreso: supera el ${tope.toLocaleString('es-AR')} %. Probá con más cuotas o un monto menor.`, 400, 'relacion');
      const t = tasasDelCredito(c.sim);
      const g = await rpc('agencia_solicitar', {
        p_user: uid, p_consulta: consulta,
        p_datos: {
          cliente: rd.datos.celular, vehiculo: texto(pedido.vehiculo).slice(0, 200), anio: c.anio, monto: c.monto, cuotas: c.cuotas,
          cuota: c.sim.cuota, total: c.sim.totalCredito, tasa: c.tasa, cft: t.cft, ingreso, categoria, datos: { ...rd.datos, pct_valor: c.pct },
        },
      });
      if (g?.error === 'consulta') throw new Falla('La consulta al BCRA de este cliente venció: consultá el CUIT de nuevo.', 400, 'consulta');
      if (g?.error === 'semaforo') throw new Falla('El cliente no es apto según el BCRA: no se puede solicitar el crédito.', 400, 'semaforo');
      if (g?.error === 'repetida') throw new Falla('Ya hay una solicitud pendiente para este cliente.', 409, 'repetida');
      if (g?.error === 'relacion') throw new Falla(`La cuota supera el ${tope.toLocaleString('es-AR')} % del ingreso.`, 400, 'relacion');
      if (!g?.id) throw new Falla('No se pudo enviar la solicitud. Probá de nuevo.', 502, 'base');
      await borrarArchivos(Array.isArray(g.borrar) ? g.borrar : []);
      return responder({ ok: true, id: g.id, requeridos: docsRequeridos(categoria, c.anio) }, 200, cors);
    }
    if (accion === 'archivo') {
      if (ag.miembro) throw new Falla('En la vista previa no se envían solicitudes.', 400, 'vista_previa');
      const id = String(form?.get('id') || ''), slot = String(form?.get('slot') || ''), f = form?.get('archivo');
      if (!esUuid(id) || !Object.hasOwn(DOCS, slot) || !(f instanceof File)) throw new Falla('Falta el archivo.', 400, 'pedido');
      const nombre = nombreArchivo(f.name);
      if (f.size > MAX_BYTES) throw new Falla(`«${nombre}» pesa más de 10 MB. Mandalo más liviano (por ejemplo, una foto en vez de un escaneo).`, 413, 'tamano');
      if (!f.size) throw new Falla(`«${nombre}» está vacío.`, 400, 'vacio');
      const bytes = new Uint8Array(await f.arrayBuffer());
      const tipo = tipoArchivo(bytes);
      if (!tipo) throw new Falla(`«${nombre}» no es un PDF ni una foto JPG.`, 415, 'tipo');
      const path = `${id}/${slot}-${crypto.randomUUID().slice(0, 8)}.${tipo.ext}`;
      const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
      await subirArchivo(path, bytes, tipo.tipo);
      let g;
      try {
        g = await rpc('agencia_archivo', { p_user: uid, p_id: id, p_archivo: { slot, nombre, path, tipo: tipo.tipo, tamano: bytes.length, sha256 } });
      } catch (e) { await borrarArchivos([path]); throw e; }
      if (!g?.ok) {
        await borrarArchivos([path]);
        if (g?.error === 'cantidad') throw new Falla(`Son demasiados archivos en «${DOCS[slot as keyof typeof DOCS].titulo}».`, 400, 'cantidad');
        throw new Falla('Esa solicitud ya no admite archivos: armala de nuevo.', 400, 'solicitud');
      }
      return responder({ ok: true }, 200, cors);
    }
    if (accion === 'enviar') {
      if (ag.miembro) throw new Falla('En la vista previa no se envían solicitudes.', 400, 'vista_previa');
      if (!esUuid(pedido.id)) throw new Falla('Falta la solicitud.', 400, 'pedido');
      const g = await rpc('agencia_enviar', { p_user: uid, p_id: pedido.id });
      if (g?.error === 'faltan') {
        const xs = (Array.isArray(g.faltan) ? g.faltan : []).map((k: string) => DOCS[k as keyof typeof DOCS]?.titulo || k);
        throw new Falla(`Falta adjuntar: ${xs.join('; ')}.`, 400, 'faltan');
      }
      if (!g?.ok) throw new Falla('Esa solicitud ya no se puede enviar: armala de nuevo.', 400, 'solicitud');
      return responder({ ok: true }, 200, cors);
    }
    if (accion === 'archivos') {
      // Solo para la Mutual: enlaces que vencen a los 15 minutos para abrir los documentos de una solicitud.
      if (!ag.miembro) throw new Falla('Pedido desconocido.', 400, 'accion');
      if (!esUuid(pedido.id)) throw new Falla('Falta la solicitud.', 400, 'pedido');
      const r = await fetch(`${URL_BASE}/rest/v1/solicitudes_credito?id=eq.${pedido.id}&select=archivos`, { headers: servicio });
      if (!r.ok) throw new Falla('No se pudo leer la solicitud.', 502, 'base');
      const [fila] = await r.json();
      const archivos = await Promise.all((Array.isArray(fila?.archivos) ? fila.archivos : []).map(async (x: any) => ({
        slot: String(x.slot || ''), nombre: String(x.nombre || ''), tipo: String(x.tipo || ''), tamano: Number(x.tamano) || 0, url: await enlace(String(x.path || '')),
      })));
      return responder({ archivos }, 200, cors);
    }
    if (accion === 'eliminar') {
      // Solo para la Mutual: borra la solicitud y sus documentos del almacenamiento (los documentos no se recuperan).
      if (!ag.miembro) throw new Falla('Pedido desconocido.', 400, 'accion');
      if (!esUuid(pedido.id)) throw new Falla('Falta la solicitud.', 400, 'pedido');
      const g = await rpc('solicitud_eliminar', { p_user: uid, p_id: pedido.id });
      await borrarArchivos(Array.isArray(g?.borrar) ? g.borrar : []);
      if (!g?.ok) throw new Falla('No se pudo eliminar la solicitud. Probá de nuevo.', 502, 'base');
      return responder({ ok: true }, 200, cors);
    }
    if (accion === 'crear_agencia') {
      // Solo para la Mutual: crea la cuenta de una agencia con una clave provisoria al azar, la habilita y devuelve la clave
      // UNA vez (no se guarda ni se registra en ningún lado). La agencia tiene que elegir la suya al entrar.
      if (!ag.miembro) throw new Falla('Pedido desconocido.', 400, 'accion');
      const email = String(pedido.email || '').trim().toLowerCase(), nombre = String(pedido.nombre || '').trim();
      // Sin fecha de aviso a InfoAuto: desde el 18/11/2026 no hace falta avisarles (migración 0034).
      const notas = String(pedido.notas || '').trim().slice(0, 500);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new Falla('El email no es válido.', 400, 'pedido');
      if (!nombre || nombre.length > 120) throw new Falla('Falta el nombre de la agencia.', 400, 'pedido');
      const clave = claveProvisoria();
      const c = await fetch(`${URL_BASE}/auth/v1/admin/users`, { method: 'POST', headers: servicio, body: JSON.stringify({ email, password: clave, email_confirm: true }) });
      if (c.status === 409 || c.status === 422) throw new Falla('Ya existe una cuenta con ese email. Si es de una agencia, usá «Ya tiene cuenta: solo habilitar».', 409, 'existe');
      if (!c.ok) throw new Falla('No se pudo crear la cuenta. Probá de nuevo en un momento.', 502, 'cuenta');
      const creado = await c.json();
      const alta = await fetch(`${URL_BASE}/rest/v1/rpc/agencia_alta`, { method: 'POST', headers: servicio, body: JSON.stringify({ p_user: uid, p_email: email, p_nombre: nombre, p_informada: null, p_notas: notas }) });
      if (!alta.ok) {
        // Si no se pudo habilitar (por ejemplo, ya hay 20 activas), la cuenta recién creada no queda suelta.
        if (esUuid(creado?.id)) await fetch(`${URL_BASE}/auth/v1/admin/users/${creado.id}`, { method: 'DELETE', headers: servicio }).catch(() => {});
        let msg = 'No se pudo habilitar la agencia.';
        try { const e = await alta.json(); if (e?.message && alta.status === 400) msg = String(e.message); } catch { /* sin detalle */ }
        throw new Falla(msg, 400, 'alta');
      }
      return responder({ ok: true, email, clave }, 200, cors);
    }
    if (accion === 'crear_vendedor') {
      // Solo para la Mutual (el alta de un vendedor la da la persona, no el dueño de la agencia): crea la cuenta con una clave
      // provisoria al azar, la suma a una agencia que ya existe y devuelve la clave UNA vez (no se guarda ni se registra).
      if (!ag.miembro) throw new Falla('Pedido desconocido.', 400, 'accion');
      const email = String(pedido.email || '').trim().toLowerCase(), nombre = String(pedido.nombre || '').trim();
      if (!esUuid(pedido.agencia)) throw new Falla('Elegí la agencia.', 400, 'pedido');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new Falla('El email no es válido.', 400, 'pedido');
      if (!nombre || nombre.length > 120) throw new Falla('Falta el nombre del vendedor.', 400, 'pedido');
      const clave = claveProvisoria();
      const c = await fetch(`${URL_BASE}/auth/v1/admin/users`, { method: 'POST', headers: servicio, body: JSON.stringify({ email, password: clave, email_confirm: true }) });
      if (c.status === 409 || c.status === 422) throw new Falla('Ya existe una cuenta con ese email.', 409, 'existe');
      if (!c.ok) throw new Falla('No se pudo crear la cuenta. Probá de nuevo en un momento.', 502, 'cuenta');
      const creado = await c.json();
      const alta = await fetch(`${URL_BASE}/rest/v1/rpc/agencia_vendedor_alta`, { method: 'POST', headers: servicio, body: JSON.stringify({ p_user: uid, p_agencia: pedido.agencia, p_email: email, p_nombre: nombre }) });
      if (!alta.ok) {
        // Si no se pudo sumar al vendedor, la cuenta recién creada no queda suelta.
        if (esUuid(creado?.id)) await fetch(`${URL_BASE}/auth/v1/admin/users/${creado.id}`, { method: 'DELETE', headers: servicio }).catch(() => {});
        let msg = 'No se pudo dar de alta al vendedor.';
        try { const e = await alta.json(); if (e?.message && alta.status === 400) msg = String(e.message); } catch { /* sin detalle */ }
        throw new Falla(msg, 400, 'alta');
      }
      return responder({ ok: true, email, clave }, 200, cors);
    }
    if (accion === 'cotizaciones') {
      return responder({ cotizaciones: ag.miembro ? [] : await rpc('agencia_cotizaciones', { p_user: uid }) }, 200, cors);
    }
    if (accion === 'cotizacion_eliminar') {
      // Oculta de «Mis cotizaciones» (no borra: el tope diario y el registro de la Mutual siguen). Sin `id`, las oculta todas.
      if (ag.miembro) throw new Falla('Pedido desconocido.', 400, 'accion');
      const id = pedido.id == null ? null : Number(pedido.id);
      if (id !== null && !(Number.isSafeInteger(id) && id > 0)) throw new Falla('Falta la cotización.', 400, 'pedido');
      const n = await rpc('agencia_cotizacion_ocultar', { p_user: uid, p_id: id });
      return responder({ ok: true, eliminadas: Number(n) || 0 }, 200, cors);
    }
    if (accion === 'solicitudes') {
      return responder({ solicitudes: ag.miembro ? [] : await rpc('agencia_solicitudes', { p_user: uid }) }, 200, cors);
    }
    throw new Falla('Pedido desconocido.', 400, 'accion');
  } catch (e) {
    if (e instanceof Falla) {
      if (e.status >= 500) console.error(JSON.stringify({ agencias: 'error', codigo: e.codigo }));
      return responder({ error: e.codigo, mensaje: e.message }, e.status, cors);
    }
    console.error('agencias:', (e as Error)?.name);
    return responder({ error: 'red', mensaje: 'No se pudo completar la cotización. Probá de nuevo en un momento.' }, 502, cors);
  }
}

Deno.serve(manejar);

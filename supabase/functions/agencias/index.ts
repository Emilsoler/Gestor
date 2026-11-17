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
// cuotas, monto?, vehiculo?, cliente?}, solicitudes.
//
// BCRA: la agencia consulta el CUIT de su cliente en la Central de Deudores (API pública). La consulta queda
// guardada entera en consultas_bcra para la Mutual; a la agencia se le devuelve solo el color y el nombre.
// La solicitud de aprobación exige esa consulta en verde y recalcula el crédito acá (no se confía en los
// importes que mande el navegador). En los registros no queda el CUIT.
import { simularCredito, montoMaximo, tasasDelCredito, anioMinimo, tasaPara } from './credito.js';
// Copia exacta de ../bcra/bcra.ts (las pruebas lo controlan): el mismo semáforo que Cobranzas.
import { ErrorBCRA, consultar, cuitValido, resumir, sinCuit, soloDigitos } from './bcra.ts';

const URL_BASE = Deno.env.get('SUPABASE_URL') || '';
const CLAVE_SERVICIO = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const API = (Deno.env.get('INFOAUTO_API') || 'https://api.infoauto.com.ar').replace(/\/+$/, '');
const URL_BCRA = Deno.env.get('BCRA_URL') || 'https://api.bcra.gob.ar'; // otra solo en las pruebas locales
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

function plazosValidos(a: any): number[] {
  return (Array.isArray(a.plazos) ? a.plazos : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 120).sort((x: number, y: number) => x - y);
}

function cuotaDe(monto: number, cuotas: number, a: any, tasa: number) {
  return simularCredito({ capital: monto, cuotas, g: a.gastos || {}, tasa });
}

/** El crédito para un vehículo (referencia cifrada), un año y un plazo, con los parámetros vigentes. */
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
  const monto = pedidoMonto > 0 ? Math.min(pedidoMonto, maximo) : maximo;
  if (monto < minimo) throw new Falla(`El monto mínimo es de $ ${minimo.toLocaleString('es-AR')}.`, 400, 'monto');
  const tasa = tasaPara(anio, a, actual);
  const sim = cuotaDe(monto, cuotas, a, tasa);
  if (!sim) throw new Falla('No se pudo calcular el crédito con estos datos.', 400, 'calculo');
  const opciones = plazos.map((n) => { const s = cuotaDe(monto, n, a, tasa); return s ? { cuotas: n, cuota: s.cuota } : null; }).filter(Boolean);
  return { financiable: true as const, anio, maximo, monto, cuotas, tasa, sim, opciones };
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

    let pedido: any;
    try { pedido = await req.json(); } catch { throw new Falla('El pedido no se pudo leer.', 400, 'pedido'); }
    const accion = String(pedido?.accion || '');

    if (accion === 'yo') {
      return responder({
        agencia: ag.nombre, miembro: !!ag.miembro, clave_temporal: !!ag.clave_temporal,
        habilitado: !!a.habilitado, plazos: plazosValidos(a), leyenda: String(a.leyenda || ''), contacto: String(a.contacto || ''),
      }, 200, cors);
    }
    if (accion === 'clave_definida') {
      if (!ag.miembro) await rpc('agencia_clave_definida', { p_user: uid });
      return responder({ ok: true }, 200, cors);
    }
    if (ag.clave_temporal) throw new Falla('Antes de cotizar, elegí tu contraseña definitiva.', 403, 'clave_temporal');
    if (!a.habilitado && !ag.miembro) throw new Falla('El cotizador todavía no está habilitado. Consultá con la Mutual.', 403, 'deshabilitado');

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
      const minimo = anioMinimo(a, await anioActual());
      const xs = await todas(`/brands/${marca}/groups/${grupo}/models/`);
      const versiones = [];
      for (const m of xs) {
        const codia = Math.trunc(Number(m?.codia));
        if (!(codia > 0) || !texto(m.description)) continue;
        if (!m.list_price && !(m.prices && (!minimo || Number(m.prices_to) >= minimo))) continue;
        versiones.push({ ref: await cifrar(codia), nombre: texto(m.description) });
      }
      versiones.sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
      return responder({ versiones }, 200, cors);
    }
    if (accion === 'anios') {
      const codia = await descifrar(pedido.ref);
      const { anios } = await aniosDe(codia, a);
      return responder({ anios }, 200, cors);
    }
    if (accion === 'cotizar') {
      const c = await calcular(pedido, a);
      if (!c.financiable) return responder({ financiable: false, mensaje: 'Este vehículo no alcanza el monto mínimo de financiación.' }, 200, cors);
      if (!ag.miembro) {
        const ok = await rpc('agencia_registrar', {
          p_user: uid, p_vehiculo: texto(pedido.vehiculo).slice(0, 200), p_anio: c.anio, p_monto: c.monto, p_cuotas: c.cuotas, p_cuota: c.sim.cuota,
        });
        if (ok !== true) throw new Falla('Llegaste al tope de cotizaciones de hoy. Probá mañana o consultá con la Mutual.', 429, 'tope');
      }
      // Solo condiciones del préstamo: ni el valor del vehículo ni el CODIA.
      return responder({
        financiable: true, anio: c.anio, maximo: c.maximo, monto: c.monto, cuotas: c.cuotas, cuota: c.sim.cuota, total: c.sim.totalCredito,
        gastos_otorgamiento: c.sim.gastos, ...tasasDelCredito(c.sim), opciones: c.opciones,
        leyenda: String(a.leyenda || ''), contacto: String(a.contacto || ''),
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
      // A la agencia, solo el color y el nombre: el detalle (entidades, montos, cheques) queda para la Mutual.
      return responder({ consulta, cuit, denominacion: resumen.denominacion, semaforo: resumen.semaforo }, 200, cors);
    }
    if (accion === 'solicitar') {
      if (ag.miembro) throw new Falla('En la vista previa no se envían solicitudes.', 400, 'vista_previa');
      const consulta = String(pedido.consulta || '');
      if (!/^[0-9a-f-]{36}$/i.test(consulta)) throw new Falla('Primero consultá el CUIT del cliente.', 400, 'consulta');
      const c = await calcular(pedido, a);
      if (!c.financiable) throw new Falla('Este vehículo no alcanza el monto mínimo de financiación.', 400, 'monto');
      const t = tasasDelCredito(c.sim);
      const g = await rpc('agencia_solicitar', {
        p_user: uid, p_consulta: consulta,
        p_datos: { cliente: texto(pedido.cliente).slice(0, 300), vehiculo: texto(pedido.vehiculo).slice(0, 200), anio: c.anio, monto: c.monto, cuotas: c.cuotas, cuota: c.sim.cuota, total: c.sim.totalCredito, tasa: c.tasa, cft: t.cft },
      });
      if (g?.error === 'consulta') throw new Falla('La consulta al BCRA de este cliente venció: consultá el CUIT de nuevo.', 400, 'consulta');
      if (g?.error === 'semaforo') throw new Falla('Solo se puede solicitar la aprobación con el cliente en verde.', 400, 'semaforo');
      if (g?.error === 'repetida') throw new Falla('Ya hay una solicitud pendiente para este cliente.', 409, 'repetida');
      if (!g?.id) throw new Falla('No se pudo enviar la solicitud. Probá de nuevo.', 502, 'base');
      return responder({ ok: true, id: g.id }, 200, cors);
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

// Todo lo que habla con la base (Supabase): sesión, lectura, escritura y sincronización.
// La interfaz (app.js) no toca la red: usa lo que exporta este archivo. El mapa está en mapa.js.
//
// Es la misma base y el mismo login que el gestor de juicios (../datos.js) y cobranzas
// (../cobranzas/datos.js): la sesión se guarda con la misma clave, así que quien entró en
// cualquiera de las apps ya está adentro de esta.
//
// La ubicación de un vehículo NO se pide con una consulta común: la hace la función `ubicar` de
// Supabase (supabase/functions/ubicar), que controla el consentimiento, pregunta al equipo (o
// simula) y deja constancia en la bitácora. Acá solo se la invoca y se muestra lo que devuelve.

const cfg = window.GESTOR_CONFIG || {};
export const enMarco = window.top !== window.self;
export const configurado =
  /^https?:\/\/\S+$/.test(cfg.url || '') && !!cfg.key && !/TU-PROYECTO|TU-CLAVE/.test(`${cfg.url}${cfg.key}`);

export const sb = configurado && !enMarco
  ? window.supabase.createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'gestor.sesion' },
    })
  : null;

const SONDEO_RAPIDO = cfg.sondeoMs || 30_000;
const SONDEO_LENTO = 5 * 60_000;
const CACHE = 'pr.cache';
const FORMA = 1;
const TABLAS = ['vehiculos', 'ubicaciones', 'ajustes_prenda'];
const COLUMNAS = { ubicaciones: '*' };
const LIMITE = { ubicaciones: 300 }; // la bitácora: las más recientes
const faltaTabla = (e) => e?.code === 'PGRST205' || e?.code === '42P01' || e?.status === 404;

export const AJUSTES_BASE = { id: 1, politica: 'mora', zona_km: 20, base_lat: -32.6259, base_lon: -62.6887 };

export const D = {
  usuario: null, acceso: null,
  vehiculos: [], ubicaciones: [], ajustes_prenda: [],
  activo: true,  // la base tiene las tablas de Prenda
  cargado: false, leido: null, deCache: false, enLinea: true, enVivo: false,
};
export const ajustes = () => ({ ...AJUSTES_BASE, ...(D.ajustes_prenda[0] || {}) });

const oyentes = new Set();
export const alCambiar = (fn) => oyentes.add(fn);
const avisar = (que, detalle) => oyentes.forEach((fn) => { try { fn(que, detalle); } catch (e) { console.error(e); } });

// ───────────────────────── Errores ─────────────────────────
const pareceRed = (e) =>
  !!e && (e.name === 'TypeError' || e.name === 'AuthRetryableFetchError' ||
    /failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(String(e.message || e)));

function marcar(e, status) {
  if (!(e instanceof Error)) e = Object.assign(new Error(e?.message || 'Error'), e);
  if (status !== undefined && e.status === undefined) e.status = status;
  e.sinRed = pareceRed(e) || e.status === 0 || (e.status >= 500 && e.status < 600);
  e.sinSesion = !e.sinRed && (e.status === 401 || e.code === 'PGRST301' || /jwt/i.test(e.message || ''));
  e.sinAcceso = e.code === '42501' && /cuenta no autorizada/.test(e.message || '');
  if (e.sinRed) ponerEnLinea(false);
  return e;
}
async function pedir(consulta) {
  let r;
  try { r = await consulta; } catch (e) { throw marcar(e); }
  if (r.error) throw marcar(r.error, r.status);
  ponerEnLinea(true);
  return r.data;
}
export function mensaje(e, siSinRed = 'no se guardó') {
  if (!e) return 'No se pudo completar la operación';
  if (e.sinRed) return `Sin conexión: ${siSinRed}`;
  if (e.sinSesion) return 'La sesión venció: volvé a ingresar';
  switch (e.code) {
    case '23505': return 'Ya existe un registro con esa clave';
    case '23514': return 'Hay un dato con formato inválido';
    case '42501': return e.sinAcceso ? 'Esta cuenta no está autorizada para usar la app' : 'Tu cuenta no tiene permiso para hacer esto';
    case 'invalid_credentials': return 'Email o contraseña incorrectos';
    case 'email_not_confirmed': return 'La cuenta todavía no está activada';
    case 'same_password': return 'La contraseña nueva tiene que ser distinta de la actual';
    case 'weak_password': return 'Esa contraseña es demasiado fácil de adivinar: probá con otra';
    case 'over_request_rate_limit': return 'Demasiados intentos seguidos. Esperá un momento y probá de nuevo';
  }
  if (e.status === 429) return 'Demasiados intentos seguidos. Esperá un momento y probá de nuevo';
  return e.message || 'No se pudo completar la operación';
}
function ponerEnLinea(v) { if (D.enLinea === v) return; D.enLinea = v; avisar('estado'); }

// ───────────────────────── Forma de los datos ─────────────────────────
const lista = (x) => (Array.isArray(x) ? x : []);
const DE = {
  vehiculos: (f) => ({ ...f, anio: f.anio || null, zona_km: +f.zona_km || 0, consentimiento: f.consentimiento || null, sim: f.sim || null }),
  ubicaciones: (f) => ({ ...f, resultado: f.resultado || {} }),
  ajustes_prenda: (f) => ({ ...f, zona_km: +f.zona_km, base_lat: +f.base_lat, base_lon: +f.base_lon }),
};
export const SITUACIONES = ['al_dia', 'mora', 'ejecucion'];
export const SIT_TXT = { al_dia: 'Al día', mora: 'En mora', ejecucion: 'En ejecución' };
const CAMPOS_VEH = ['dominio', 'marca', 'modelo', 'anio', 'deudor', 'dni', 'telefono', 'operacion', 'expte',
  'situacion', 'consentimiento', 'imei', 'equipo', 'instalado', 'traccar_id', 'sim', 'zona_km', 'notas'];
function vehAFila(v) {
  const f = {};
  for (const k of CAMPOS_VEH) if (k in v) f[k] = v[k];
  if ('anio' in f) f.anio = f.anio ? +f.anio : null;
  if ('instalado' in f) f.instalado = f.instalado || null;
  if ('zona_km' in f) f.zona_km = +f.zona_km || 0;
  if ('dominio' in f) f.dominio = String(f.dominio || '').toUpperCase().trim();
  return f;
}
const ORDEN = {
  vehiculos: (a, b) => (a.dominio || '').localeCompare(b.dominio || '', 'es') || a.id.localeCompare(b.id),
  ubicaciones: (a, b) => String(b.momento).localeCompare(String(a.momento)) || a.id.localeCompare(b.id),
  ajustes_prenda: (a, b) => a.id - b.id,
};
const firma = (filas) => JSON.stringify([...filas].sort((a, b) => String(a.id).localeCompare(String(b.id))));

function ponerLocal(t, fila) { D[t] = [...D[t].filter((x) => x.id !== fila.id), fila].sort(ORDEN[t]); guardarCache(); avisar('datos'); return fila; }
function quitarLocal(t, id) { D[t] = D[t].filter((x) => x.id !== id); guardarCache(); avisar('datos'); }

// ───────────────────────── Copia en el dispositivo ─────────────────────────
function guardarCache() {
  if (!D.usuario || !D.cargado) return;
  try {
    localStorage.setItem(CACHE, JSON.stringify({
      forma: FORMA, uid: D.usuario.id, email: D.usuario.email, ts: (D.leido || new Date()).getTime(),
      vehiculos: D.vehiculos, ubicaciones: D.ubicaciones.slice(0, 80), ajustes_prenda: D.ajustes_prenda,
    }));
  } catch { /* sin espacio o modo privado */ }
}
function leerCache() {
  try { const c = JSON.parse(localStorage.getItem(CACHE) || 'null'); return c && c.uid && c.forma === FORMA && Array.isArray(c.vehiculos) ? c : null; } catch { return null; }
}
function borrarCache() { try { localStorage.removeItem(CACHE); } catch { /* nada */ } }
function usarCache(c) { for (const t of TABLAS) D[t] = lista(c[t]).map(DE[t]).sort(ORDEN[t]); D.cargado = true; D.deCache = true; D.leido = new Date(c.ts); }
function vaciar() { D.usuario = null; D.acceso = null; for (const t of TABLAS) D[t] = []; D.cargado = false; D.leido = null; D.deCache = false; D.enVivo = false; }

// ───────────────────────── Lectura ─────────────────────────
async function leerTabla(t) {
  const tope = LIMITE[t];
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    let q = sb.from(t).select(COLUMNAS[t] || '*').order(t === 'ubicaciones' ? 'momento' : 'id', { ascending: t !== 'ubicaciones' }).range(desde, desde + 999);
    const tramo = await pedir(q);
    filas.push(...tramo);
    if (tramo.length < 1000 || (tope && filas.length >= tope)) break;
  }
  return (tope ? filas.slice(0, tope) : filas).map(DE[t]);
}
async function leerSiHay(t) {
  try { const filas = await leerTabla(t); D.activo = true; return filas; }
  catch (e) { if (e.sinRed || e.sinSesion || e.sinAcceso || !faltaTabla(e)) throw e; D.activo = false; return null; }
}
async function recargar(tablas = TABLAS) {
  const [acceso, ...listas] = await Promise.all([pedir(sb.rpc('mi_acceso')), ...tablas.map(leerSiHay)]);
  D.acceso = acceso;
  if (!acceso.autorizado) return false;
  let cambio = D.deCache || !D.cargado;
  tablas.forEach((t, i) => { if (listas[i] && firma(D[t]) !== firma(listas[i])) { D[t] = listas[i].sort(ORDEN[t]); cambio = true; } });
  D.cargado = true; D.deCache = false; D.leido = new Date();
  guardarCache();
  return cambio;
}

// ───────────────────────── Sincronización ─────────────────────────
let canal = null, reloj = null, enCurso = null, pendiente = null, ultimoIntento = 0, antirrebote = null;
export function sincronizar(tablas) {
  if (!sb || !D.usuario) return Promise.resolve();
  if (enCurso) { pendiente = !tablas || pendiente === TABLAS ? TABLAS : [...new Set([...(pendiente || []), ...tablas])]; return enCurso; }
  ultimoIntento = Date.now();
  enCurso = (async () => {
    try {
      if (!D.acceso || !D.acceso.autorizado || D.acceso.clave_temporal) { avisar('sesion', await trasIngreso()); return; }
      const cambio = await recargar(tablas);
      if (!D.acceso.autorizado) { sinAcceso(); avisar('sesion', 'sin-acceso'); return; }
      avisar(cambio ? 'datos' : 'estado');
    } catch (e) {
      marcar(e);
      if (e.sinAcceso) { sinAcceso(); avisar('sesion', 'sin-acceso'); }
      else if (e.sinSesion) { await cerrarLocal(); avisar('sesion', 'ingreso'); }
      else if (!e.sinRed) console.error('sincronizar:', e);
    } finally { enCurso = null; if (pendiente) { const t = pendiente; pendiente = null; sincronizar(t); } }
  })();
  return enCurso;
}
const avisadas = new Set();
function pedirSinc(t) { avisadas.add(t); clearTimeout(antirrebote); antirrebote = setTimeout(() => { const ts = [...avisadas]; avisadas.clear(); sincronizar(ts); }, 250); }
function conectar() {
  if (!canal) {
    try {
      canal = sb.channel('prenda');
      for (const t of TABLAS) canal.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => pedirSinc(t));
      canal.subscribe((estado) => { const vivo = estado === 'SUBSCRIBED'; if (vivo === D.enVivo) return; D.enVivo = vivo; avisar('estado'); if (vivo) sincronizar(); });
    } catch (e) { console.error('tiempo real:', e); canal = null; }
  }
  if (!reloj) reloj = setInterval(latido, 5000);
}
function cortar() { if (canal) { try { sb.removeChannel(canal); } catch { /* nada */ } canal = null; } D.enVivo = false; }
const seActualizaSola = () => !!D.usuario && (!D.acceso || (D.acceso.autorizado && !D.acceso.clave_temporal));
function latido() { if (!seActualizaSola() || document.visibilityState !== 'visible') return; if (Date.now() - ultimoIntento >= (D.enVivo ? SONDEO_LENTO : SONDEO_RAPIDO)) sincronizar(); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && seActualizaSola() && Date.now() - ultimoIntento > 10_000) sincronizar(); });
window.addEventListener('online', () => { if (seActualizaSola()) sincronizar(); });
window.addEventListener('offline', () => ponerEnLinea(false));

// ───────────────────────── Sesión ─────────────────────────
const haySesionGuardada = () => { try { return !!localStorage.getItem('gestor.sesion'); } catch { return false; } };
async function trasIngreso() {
  let sesion = null, fallo = null;
  try { const r = await sb.auth.getSession(); sesion = r.data.session; fallo = r.error; } catch (e) { fallo = e; }
  const copia = leerCache();
  if (!sesion) {
    if (haySesionGuardada() && (pareceRed(fallo) || !navigator.onLine)) {
      ponerEnLinea(false);
      if (copia && !D.cargado) { D.usuario = { id: copia.uid, email: copia.email }; usarCache(copia); }
      if (!reloj) reloj = setInterval(latido, 5000);
      return D.cargado ? 'listo' : 'sin-red';
    }
    await cerrarLocal(); return 'ingreso';
  }
  D.usuario = { id: sesion.user.id, email: sesion.user.email };
  if (copia && copia.uid !== D.usuario.id) borrarCache();
  else if (copia && !D.cargado) usarCache(copia);
  if (!reloj) reloj = setInterval(latido, 5000);
  try {
    D.acceso = await pedir(sb.rpc('mi_acceso'));
    if (!D.acceso.autorizado) { sinAcceso(); return 'sin-acceso'; }
    if (D.acceso.clave_temporal) return 'clave-temporal';
    await recargar();
  } catch (e) {
    if (e.sinAcceso) { sinAcceso(); return 'sin-acceso'; }
    if (e.sinSesion) { await cerrarLocal(); return 'ingreso'; }
    if (!e.sinRed) throw e;
    return D.cargado ? 'listo' : 'sin-red';
  }
  conectar();
  return 'listo';
}
function sinAcceso() { cortar(); borrarCache(); D.acceso = { autorizado: false }; for (const t of TABLAS) D[t] = []; D.cargado = false; D.leido = null; D.deCache = false; }
async function cerrarLocal() { cortar(); clearInterval(reloj); reloj = null; try { await sb.auth.signOut({ scope: 'local' }); } catch { /* sin red */ } borrarCache(); vaciar(); }
export async function iniciar() {
  if (enMarco) return 'en-marco';
  if (!configurado) return 'sin-configurar';
  sb.auth.onAuthStateChange((evento, sesion) => setTimeout(() => alEventoDeSesion(evento, sesion), 0));
  return trasIngreso();
}
export async function reconectar() { if (enMarco) return 'en-marco'; if (!configurado) return 'sin-configurar'; if (enCurso) await enCurso; return trasIngreso(); }
async function alEventoDeSesion(evento, sesion) {
  if (evento === 'SIGNED_OUT') { if (!D.usuario) return; cortar(); clearInterval(reloj); reloj = null; borrarCache(); vaciar(); avisar('sesion', 'ingreso'); }
  else if ((evento === 'SIGNED_IN' || evento === 'TOKEN_REFRESHED') && sesion) { if (!D.usuario) avisar('sesion', await trasIngreso()); else if (!D.acceso) sincronizar(); }
}
export async function entrar(email, clave) {
  let r;
  try { r = await sb.auth.signInWithPassword({ email: email.trim(), password: clave }); } catch (e) { throw marcar(e); }
  if (r.error) throw marcar(r.error);
  ponerEnLinea(true); return trasIngreso();
}
export async function salir() { await cerrarLocal(); }
export async function cambiarClave(nueva) {
  let r;
  try { r = await sb.auth.updateUser({ password: nueva }); } catch (e) { throw marcar(e); }
  if (r.error) throw marcar(r.error);
  const eraTemporal = !!D.acceso?.clave_temporal;
  await pedir(sb.rpc('clave_definida'));
  D.acceso = { ...D.acceso, clave_temporal: false };
  return eraTemporal ? trasIngreso() : 'listo';
}

// ───────────────────────── Escritura de vehículos y ajustes ─────────────────────────
async function modificar(t, id, rev, campos) {
  let q = sb.from(t).update(campos).eq('id', id);
  if (rev != null) q = q.eq('rev', rev);
  const filas = await pedir(q.select());
  if (filas.length) return { fila: ponerLocal(t, DE[t](filas[0])) };
  const actual = await pedir(sb.from(t).select('*').eq('id', id).maybeSingle());
  if (actual) ponerLocal(t, DE[t](actual)); else quitarLocal(t, id);
  return { conflicto: true, actual: actual ? DE[t](actual) : null };
}
async function agregar(t, fila) { return ponerLocal(t, DE[t](await pedir(sb.from(t).insert(fila).select().single()))); }

export const crearVehiculo = (v) => agregar('vehiculos', vehAFila(v));
export const borrarVehiculo = async (id) => { await pedir(sb.from('vehiculos').delete().eq('id', id)); quitarLocal('vehiculos', id); };
export async function cambiarVehiculo(id, campos) {
  const actual = D.vehiculos.find((x) => x.id === id);
  return modificar('vehiculos', id, actual ? actual.rev : null, vehAFila(campos));
}
export const guardarAjustes = (rev, campos) => modificar('ajustes_prenda', 1, rev, campos);

// ───────────────────────── Ubicar (función de Supabase) ─────────────────────────
/** Pide la ubicación de un vehículo. Devuelve la constancia guardada (fila de ubicaciones). */
export async function ubicar(vehiculo_id, motivo, nota = '') {
  if (!sb) throw Object.assign(new Error('La app no está conectada a su base de datos'), { codigo: 'sin_configurar' });
  let r;
  try { r = await sb.functions.invoke('ubicar', { body: { vehiculo_id, motivo, nota } }); } catch (e) { throw marcar(e); }
  if (r.error) {
    let detalle = null;
    try { detalle = await r.error.context?.json(); } catch { /* sin cuerpo */ }
    const status = r.error.context?.status;
    const sinRed = r.error.name === 'FunctionsFetchError';
    const e = new Error(detalle?.mensaje || (sinRed ? 'Sin conexión: no se pudo ubicar'
      : status === 404 ? 'El equipo todavía no reportó una posición.'
      : 'No se pudo ubicar. Probá de nuevo en un momento.'));
    e.codigo = detalle?.error || (sinRed ? 'red' : 'ubicar');
    e.status = status;
    if (sinRed) ponerEnLinea(false);
    if (status === 401) e.sinSesion = true;
    throw e;
  }
  ponerEnLinea(true);
  const u = DE.ubicaciones(r.data.ubicacion);
  // La bitácora y la "última posición" del vehículo se actualizan solas por Realtime; igual la
  // ponemos ya para que se vea sin esperar.
  D.ubicaciones = [u, ...D.ubicaciones.filter((x) => x.id !== u.id)].sort(ORDEN.ubicaciones);
  avisar('datos');
  return u;
}

/** Última consulta registrada de un vehículo (de la bitácora en memoria). */
export const ultimaUbicacion = (id) => D.ubicaciones.find((u) => u.vehiculo === id) || null;
export const ubicacionesDe = (id) => D.ubicaciones.filter((u) => u.vehiculo === id);

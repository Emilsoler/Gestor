// Todo lo que habla con la base (Supabase): sesión, lectura, escritura y sincronización.
// La interfaz (app.js) no toca la red: usa lo que exporta este archivo.
//
// Cómo se mantiene al día lo que se ve:
//   1. Tiempo real: la base avisa cada cambio (por ejemplo, cuando actualiza Claude) y se vuelve a leer.
//   2. Respaldo: si el tiempo real no está, se relee cada 30 s mientras la app está a la vista.
//   3. Sin conexión: se muestra la última copia guardada en el dispositivo, solo para consultar.
//
// Cada fila tiene un número de revisión (`rev`) que la base sube en cada cambio. Al guardar
// se manda la revisión que uno tenía: si ya no coincide, alguien más la cambió y no se pisa.

const cfg = window.GESTOR_CONFIG || {};

/** La app no se usa dentro de un marco: otra página podría montarla ahí para inducir clics. */
export const enMarco = window.top !== window.self;

export const configurado =
  /^https?:\/\/\S+$/.test(cfg.url || '') && !!cfg.key && !/TU-PROYECTO|TU-CLAVE/.test(`${cfg.url}${cfg.key}`);

export const sb = configurado && !enMarco
  ? window.supabase.createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'gestor.sesion' },
    })
  : null;

const SONDEO_RAPIDO = cfg.sondeoMs || 30_000; // sin tiempo real
const SONDEO_LENTO = 5 * 60_000; // con tiempo real, por si se perdió algún aviso
const CACHE = 'gj.cache';
const TABLAS = ['causas', 'acuerdos', 'plantillas'];
const CLAVE = { causas: 'expte', acuerdos: 'id', plantillas: 'id' };

/** Estado compartido con la interfaz. Se lee libremente; solo este archivo lo modifica. */
export const D = {
  usuario: null, // { id, email }
  acceso: null, // { autorizado, clave_temporal, nombre, email }
  causas: [],
  acuerdos: [],
  plantillas: [],
  cargado: false, // hay algo para mostrar (de la base o de la copia local)
  leido: null, // Date de la última lectura buena (de la base, o de cuándo se guardó la copia)
  deCache: false, // lo que se ve es la copia del dispositivo
  enLinea: true, // la última operación de red anduvo
  enVivo: false, // canal de tiempo real conectado
};

const oyentes = new Set();
/** fn(que, detalle): que = 'datos' | 'estado' | 'sesion' (detalle = pantalla a mostrar). */
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
  e.sinAcceso = e.code === '42501' && /cuenta no autorizada/.test(e.message || ''); // la puerta de la API (gestor_puerta)
  if (e.sinRed) ponerEnLinea(false);
  return e;
}

/** Espera una consulta de supabase-js y devuelve sus datos, o lanza el error ya clasificado. */
async function pedir(consulta) {
  let r;
  try { r = await consulta; } catch (e) { throw marcar(e); }
  if (r.error) throw marcar(r.error, r.status);
  ponerEnLinea(true);
  return r.data;
}

/** Texto para mostrarle a la persona. `siSinRed` dice qué no se pudo hacer por falta de conexión. */
export function mensaje(e, siSinRed = 'no se guardó') {
  if (!e) return 'No se pudo completar la operación';
  if (e.sinRed) return `Sin conexión: ${siSinRed}`;
  if (e.sinSesion) return 'La sesión venció: volvé a ingresar';
  switch (e.code) {
    case '23505': return 'Ya existe un registro con esa clave';
    case '23514': return 'Hay un dato con formato inválido';
    case '42501': return e.sinAcceso ? 'Esta cuenta no está autorizada para usar el gestor' : 'Tu cuenta no tiene permiso para hacer esto';
    case 'invalid_credentials': return 'Email o contraseña incorrectos';
    case 'email_not_confirmed': return 'La cuenta todavía no está activada';
    case 'same_password': return 'La contraseña nueva tiene que ser distinta de la actual';
    case 'weak_password': return 'Esa contraseña es demasiado fácil de adivinar: probá con otra';
    case 'over_request_rate_limit': return 'Demasiados intentos seguidos. Esperá un momento y probá de nuevo';
    case 'user_banned': return 'Esta cuenta está bloqueada';
  }
  if (e.status === 429) return 'Demasiados intentos seguidos. Esperá un momento y probá de nuevo';
  return e.message || 'No se pudo completar la operación';
}

function ponerEnLinea(v) {
  if (D.enLinea === v) return;
  D.enLinea = v;
  avisar('estado');
}

// ───────────────────────── Forma de los datos ─────────────────────────
// La base guarda fechas vacías como null; la interfaz las maneja como ''.

const DE = {
  causas: (f) => ({ ...f, vence: f.vence || '', fecha: f.fecha || '', etiquetas: f.etiquetas || [], historial: f.historial || [] }),
  acuerdos: (f) => ({ ...f, cuotas: f.cuotas || [] }),
  plantillas: (f) => ({ ...f }),
};

const CAMPOS_CAUSA = ['expte', 'actor', 'demandado', 'tipo', 'nom', 'oficina', 'estado', 'etiquetas', 'proxima', 'vence', 'ultima', 'fecha', 'notas', 'historial', 'liquidacion'];
const movLimpio = (h) => (h.hecha ? { fecha: h.fecha || '', texto: h.texto || '', hecha: true } : { fecha: h.fecha || '', texto: h.texto || '' });

function causaAFila(c) {
  const f = {};
  for (const k of CAMPOS_CAUSA) f[k] = c[k] ?? '';
  f.vence = c.vence || null;
  f.fecha = c.fecha || null;
  f.etiquetas = c.etiquetas || [];
  f.historial = (c.historial || []).map(movLimpio);
  f.liquidacion = c.liquidacion || null;
  return f;
}

/** La última acción es el movimiento de fecha más reciente; a igual fecha, el anotado después. */
export function ultimaDe(historial) {
  let mejor = null;
  (historial || []).forEach((h) => { if (!mejor || (h.fecha || '') >= (mejor.fecha || '')) mejor = h; });
  return mejor ? { ultima: mejor.texto || '', fecha: mejor.fecha || '' } : { ultima: '', fecha: '' };
}

const ORDEN = {
  causas: (a, b) => a.expte.localeCompare(b.expte),
  acuerdos: (a, b) => (a.deudor || '').localeCompare(b.deudor || '') || a.id.localeCompare(b.id),
  plantillas: (a, b) => (a.titulo || '').localeCompare(b.titulo || '') || a.id.localeCompare(b.id),
};
const firma = (t, filas) => JSON.stringify([...filas].sort((a, b) => String(a[CLAVE[t]]).localeCompare(String(b[CLAVE[t]]))));

function ponerLocal(t, fila) {
  const k = CLAVE[t];
  D[t] = [...D[t].filter((x) => x[k] !== fila[k]), fila].sort(ORDEN[t]);
  guardarCache();
  avisar('datos');
  return fila;
}
function quitarLocal(t, clave) {
  D[t] = D[t].filter((x) => x[CLAVE[t]] !== clave);
  guardarCache();
  avisar('datos');
}

// ───────────────────────── Copia en el dispositivo ─────────────────────────

function guardarCache() {
  if (!D.usuario || !D.cargado) return;
  try {
    localStorage.setItem(CACHE, JSON.stringify({
      uid: D.usuario.id, email: D.usuario.email, ts: (D.leido || new Date()).getTime(),
      causas: D.causas, acuerdos: D.acuerdos, plantillas: D.plantillas,
    }));
  } catch { /* sin espacio o modo privado: la app sigue andando sin copia local */ }
}
function leerCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE) || 'null');
    return c && c.uid && Array.isArray(c.causas) ? c : null;
  } catch { return null; }
}
function borrarCache() { try { localStorage.removeItem(CACHE); } catch { /* nada */ } }
function usarCache(c) {
  D.causas = (c.causas || []).sort(ORDEN.causas);
  D.acuerdos = (c.acuerdos || []).sort(ORDEN.acuerdos);
  D.plantillas = (c.plantillas || []).sort(ORDEN.plantillas);
  D.cargado = true; D.deCache = true; D.leido = new Date(c.ts);
}
function vaciar() {
  D.usuario = null; D.acceso = null; D.causas = []; D.acuerdos = []; D.plantillas = [];
  D.cargado = false; D.leido = null; D.deCache = false; D.enVivo = false;
}

// ───────────────────────── Lectura ─────────────────────────

async function leerTabla(t) {
  const filas = [];
  for (let desde = 0; ; desde += 1000) { // la API entrega de a 1000 filas como máximo
    const tramo = await pedir(sb.from(t).select('*').order(CLAVE[t]).range(desde, desde + 999));
    filas.push(...tramo);
    if (tramo.length < 1000) break;
  }
  return filas.map(DE[t]);
}

/** Lee de la base y actualiza D. Devuelve true si algo cambió. */
async function recargar(tablas = TABLAS) {
  const [acceso, ...listas] = await Promise.all([pedir(sb.rpc('mi_acceso')), ...tablas.map(leerTabla)]);
  D.acceso = acceso;
  if (!acceso.autorizado) return false; // lo resuelve quien llama
  let cambio = D.deCache || !D.cargado;
  tablas.forEach((t, i) => {
    if (firma(t, D[t]) !== firma(t, listas[i])) { D[t] = listas[i].sort(ORDEN[t]); cambio = true; }
  });
  D.cargado = true; D.deCache = false; D.leido = new Date();
  guardarCache();
  return cambio;
}

// ───────────────────────── Sincronización ─────────────────────────

let canal = null, reloj = null, enCurso = null, pendiente = null, ultimoIntento = 0, antirrebote = null;

/** Vuelve a leer de la base. Nunca lanza: si no hay red, queda marcado en D.enLinea. */
export function sincronizar(tablas) {
  if (!sb || !D.usuario) return Promise.resolve();
  if (enCurso) { // una sola lectura a la vez; lo que se pida mientras tanto se hace al terminar
    pendiente = !tablas || pendiente === TABLAS ? TABLAS : [...new Set([...(pendiente || []), ...tablas])];
    return enCurso;
  }
  ultimoIntento = Date.now();
  enCurso = (async () => {
    try {
      if (!D.acceso || !D.acceso.autorizado || D.acceso.clave_temporal) {
        avisar('sesion', await trasIngreso()); // veníamos sin conexión o sin permiso: rehacer el ingreso completo
        return;
      }
      const cambio = await recargar(tablas);
      if (!D.acceso.autorizado) { sinAcceso(); avisar('sesion', 'sin-acceso'); return; } // le quitaron el acceso mientras usaba la app
      avisar(cambio ? 'datos' : 'estado');
    } catch (e) {
      marcar(e);
      if (e.sinAcceso) { sinAcceso(); avisar('sesion', 'sin-acceso'); }
      else if (e.sinSesion) { await cerrarLocal(); avisar('sesion', 'ingreso'); }
      else if (!e.sinRed) console.error('sincronizar:', e);
    } finally {
      enCurso = null;
      if (pendiente) { const t = pendiente; pendiente = null; sincronizar(t); }
    }
  })();
  return enCurso;
}

const avisadas = new Set(); // tablas con cambios avisados por tiempo real, a la espera de releerse
function pedirSinc(t) {
  avisadas.add(t);
  clearTimeout(antirrebote);
  antirrebote = setTimeout(() => { const ts = [...avisadas]; avisadas.clear(); sincronizar(ts); }, 250);
}

function conectar() {
  if (!canal) {
    try {
      canal = sb.channel('gestor');
      for (const t of TABLAS) canal.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => pedirSinc(t));
      canal.subscribe((estado) => {
        const vivo = estado === 'SUBSCRIBED';
        if (vivo === D.enVivo) return;
        D.enVivo = vivo;
        avisar('estado');
        if (vivo) sincronizar(); // al (re)conectar, ponerse al día con lo que haya pasado
      });
    } catch (e) { console.error('tiempo real:', e); canal = null; }
  }
  if (!reloj) reloj = setInterval(latido, 5000);
}
function cortar() {
  if (canal) { try { sb.removeChannel(canal); } catch { /* nada */ } canal = null; }
  D.enVivo = false;
}
// Solo se relee sola la pantalla de trabajo: las de "sin acceso" y "elegí tu contraseña" esperan a la persona.
const seActualizaSola = () => !!D.usuario && (!D.acceso || (D.acceso.autorizado && !D.acceso.clave_temporal));
function latido() {
  if (!seActualizaSola() || document.visibilityState !== 'visible') return;
  if (Date.now() - ultimoIntento >= (D.enVivo ? SONDEO_LENTO : SONDEO_RAPIDO)) sincronizar();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && seActualizaSola() && Date.now() - ultimoIntento > 10_000) sincronizar();
});
window.addEventListener('online', () => { if (seActualizaSola()) sincronizar(); });
window.addEventListener('offline', () => ponerEnLinea(false));

// ───────────────────────── Sesión ─────────────────────────

const haySesionGuardada = () => { try { return !!localStorage.getItem('gestor.sesion'); } catch { return false; } };

/**
 * Verifica la sesión y el acceso, y carga los datos. Devuelve la pantalla que corresponde:
 * 'ingreso' | 'sin-acceso' | 'clave-temporal' | 'sin-red' | 'listo'.
 * Sin conexión, si hay copia en el dispositivo se entra igual ('listo', con D.deCache) para consultar.
 */
async function trasIngreso() {
  let sesion = null, fallo = null;
  try { const r = await sb.auth.getSession(); sesion = r.data.session; fallo = r.error; } catch (e) { fallo = e; }

  const copia = leerCache();
  if (!sesion) {
    // Puede ser que no haya sesión, o que haya una guardada que no se pudo renovar por falta de red.
    if (haySesionGuardada() && (pareceRed(fallo) || !navigator.onLine)) {
      ponerEnLinea(false);
      if (copia && !D.cargado) { D.usuario = { id: copia.uid, email: copia.email }; usarCache(copia); }
      if (!reloj) reloj = setInterval(latido, 5000);
      return D.cargado ? 'listo' : 'sin-red';
    }
    await cerrarLocal();
    return 'ingreso';
  }

  D.usuario = { id: sesion.user.id, email: sesion.user.email };
  if (copia && copia.uid !== D.usuario.id) borrarCache(); // copia de otra cuenta: no se muestra
  else if (copia && !D.cargado) usarCache(copia); // se pinta ya con lo guardado, mientras llega lo nuevo
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

/** La cuenta tiene sesión pero no está autorizada: no queda ningún dato en la app ni en el dispositivo. */
function sinAcceso() {
  cortar(); borrarCache();
  D.acceso = { autorizado: false };
  D.causas = []; D.acuerdos = []; D.plantillas = []; D.cargado = false; D.leido = null; D.deCache = false;
}

async function cerrarLocal() {
  cortar();
  clearInterval(reloj); reloj = null;
  try { await sb.auth.signOut({ scope: 'local' }); } catch { /* sin red: igual se borra del dispositivo */ }
  borrarCache();
  vaciar();
}

/** Arranque de la app (una sola vez). Devuelve la pantalla inicial. */
export async function iniciar() {
  if (enMarco) return 'en-marco';
  if (!configurado) return 'sin-configurar';
  sb.auth.onAuthStateChange((evento, sesion) => setTimeout(() => alEventoDeSesion(evento, sesion), 0));
  return trasIngreso();
}

/** Botón "Reintentar": rehace el ingreso completo y devuelve la pantalla que corresponde. */
export async function reconectar() {
  if (enMarco) return 'en-marco';
  if (!configurado) return 'sin-configurar';
  if (enCurso) await enCurso;
  return trasIngreso();
}

async function alEventoDeSesion(evento, sesion) {
  if (evento === 'SIGNED_OUT') {
    if (!D.usuario) return;
    cortar(); clearInterval(reloj); reloj = null; borrarCache(); vaciar();
    avisar('sesion', 'ingreso');
  } else if ((evento === 'SIGNED_IN' || evento === 'TOKEN_REFRESHED') && sesion) {
    if (!D.usuario) avisar('sesion', await trasIngreso()); // se ingresó desde otra pestaña
    else if (!D.acceso) sincronizar(); // veníamos sin conexión y volvió
  }
}

export async function entrar(email, clave) {
  let r;
  try { r = await sb.auth.signInWithPassword({ email: email.trim(), password: clave }); } catch (e) { throw marcar(e); }
  if (r.error) throw marcar(r.error);
  ponerEnLinea(true);
  return trasIngreso();
}

export async function salir() {
  await cerrarLocal();
}

/** Cambia la contraseña. Si era la temporal, deja constancia y termina el ingreso. */
export async function cambiarClave(nueva) {
  let r;
  try { r = await sb.auth.updateUser({ password: nueva }); } catch (e) { throw marcar(e); }
  if (r.error) throw marcar(r.error);
  const eraTemporal = !!D.acceso?.clave_temporal;
  await pedir(sb.rpc('clave_definida'));
  D.acceso = { ...D.acceso, clave_temporal: false };
  return eraTemporal ? trasIngreso() : 'listo';
}

// ───────────────────────── Escritura ─────────────────────────
// Las que modifican algo existente devuelven { fila } o { conflicto: true, actual }.
// `actual` es la versión que hay ahora en la base, o null si la fila ya no existe.

async function modificar(t, clave, rev, campos) {
  let q = sb.from(t).update(campos).eq(CLAVE[t], clave);
  if (rev != null) q = q.eq('rev', rev);
  const filas = await pedir(q.select());
  if (filas.length) return { fila: ponerLocal(t, DE[t](filas[0])) };
  const actual = await pedir(sb.from(t).select('*').eq(CLAVE[t], clave).maybeSingle());
  if (actual) ponerLocal(t, DE[t](actual)); else quitarLocal(t, clave);
  return { conflicto: true, actual: actual ? DE[t](actual) : null };
}
async function agregar(t, fila) {
  return ponerLocal(t, DE[t](await pedir(sb.from(t).insert(fila).select().single())));
}
async function eliminar(t, clave) {
  await pedir(sb.from(t).delete().eq(CLAVE[t], clave));
  quitarLocal(t, clave);
}

export const crearCausa = (c) => agregar('causas', causaAFila(c));
/** Guarda la ficha completa. Con forzar, pisa lo que haya aunque otro la haya cambiado. */
export function guardarCausa(c, { forzar = false } = {}) {
  const { expte, ...campos } = causaAFila(c);
  return modificar('causas', expte, forzar ? null : c.rev, campos);
}
/** Cambia solo algunos campos (por ejemplo al marcar una acción como realizada). */
export function actualizarCausa(expte, rev, campos) {
  const f = { ...campos };
  if ('vence' in f) f.vence = f.vence || null;
  if ('fecha' in f) f.fecha = f.fecha || null;
  if ('historial' in f) f.historial = f.historial.map(movLimpio);
  return modificar('causas', expte, rev, f);
}
export const borrarCausa = (expte) => eliminar('causas', expte);

export const crearAcuerdo = (a) => agregar('acuerdos', a);
export const actualizarAcuerdo = (id, rev, campos) => modificar('acuerdos', id, rev, campos);
export const borrarAcuerdo = (id) => eliminar('acuerdos', id);

export const crearPlantilla = (p) => agregar('plantillas', p);
export const guardarPlantilla = (id, rev, campos) => modificar('plantillas', id, rev, campos);
export const borrarPlantilla = (id) => eliminar('plantillas', id);

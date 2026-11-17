// Cotizador de créditos prendarios para agencias y concesionarias (Asociación Mutual Bell).
//
// El vendedor elige marca, modelo, versión y año, y ve las condiciones del crédito de la Mutual. Todo lo
// pide a la función `agencias` de Supabase, que es la que consulta los valores de los vehículos y NUNCA
// los devuelve: acá no llega ni el valor ni el código del vehículo (licencia de la guía de precios), solo
// el monto máximo, las cuotas y las tasas. La app no lee la base: a las agencias la API les está cerrada.
//
// Un usuario de la Mutual (miembro del gestor) entra en «vista previa» y además ve «Administración»:
// solicitudes, parámetros del crédito, agencias y cotizaciones (eso sí, por la API de la base, con sus permisos).
//
// El recorrido de la agencia: 1) CUIT del cliente → BCRA (verde «Continuar»; amarillo o sin antecedentes
// «Continuar – Sujeto a revisión»; rojo «No apto»); 2) vehículo y crédito; 3) si quieren avanzar: ingresos
// demostrables (sin eso no sigue) y el ingreso mensual (la cuota no puede pasar el 45 %); cómo obtiene los
// ingresos; 4) su documentación; 5) datos del cliente con la suya; y se envía todo a la Mutual.
import { CATEGORIAS, DOCS, DOCS_INGRESOS, MAX_BYTES, docsPermitidos, docsRequeridos, dniDelCuit, relacionCuota, revisarDatos, tipoArchivo } from './solicitud.js';

const cfg = window.GESTOR_CONFIG || {};
const sb = window.supabase && cfg.url && cfg.key && window.top === window.self
  ? window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'gestor.sesion' } })
  : null;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plata = (n) => `$ ${Math.round(Number(n) || 0).toLocaleString('es-AR')}`;
const pct = (n) => `${(Number(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
const soloNumero = (s) => Number(String(s ?? '').replace(/[^\d]/g, '')) || 0;
/** "1,2" o "1.2" → 1.2; "13.000" o "13000" → 13000; vacío → null. Con coma, los puntos son de miles; sin coma, un
 *  punto seguido de exactamente 3 cifras también (13.000), y si no es el decimal (1.2, 0.1). */
const numero = (s) => {
  let t = String(s ?? '').trim().replace(/\s|\$/g, '');
  if (t === '') return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
/** Para mostrar en un campo: decimales con coma, sin separador de miles. */
const enCampo = (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace('.', ','));
const fechaHora = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); };

const S = {
  fase: 'cargando', // cargando | ingreso | clave | sinacceso | app
  error: '', ocupado: false,
  yo: null, // { agencia, miembro, clave_temporal, habilitado, plazos, leyenda, contacto }
  vista: 'cotizar', // cotizar | solicitudes (agencia) | admin (Mutual)
  marcas: null, marca: '', modelos: null, modelo: '', versiones: null, version: '', anios: null, anio: '',
  plazo: 0, monto: '', cargando: '', res: null,
  cuit: '', bcra: null, bcraError: '', continuo: false, confirmarOtro: false, sols: null,
  sol: null, // la solicitud que se está armando (nuevaSol)
  adm: null, admTab: 'solicitudes', admMsg: '',
};

/** Lo que la agencia va cargando de la solicitud. `docs`: casillero → [{file, nombre}] (los archivos quedan en el
 *  navegador hasta que se envía). `envio`: la solicitud ya creada en la base, si una subida quedó a medias. */
function nuevaSol() {
  return {
    abierta: false, ingresos: null, ingreso: '', categoria: '', docs: {},
    dni: '', domicilio: '', estado_civil: '', matrimonio_lugar: '', matrimonio_fecha: '', celular: '', cbu: '', conformidad: false,
    errores: [], error: '', enviando: false, progreso: '', preparando: 0, enviada: false, envio: null,
  };
}
S.sol = nuevaSol();

// ───────────────────────── Red ─────────────────────────
async function fn(cuerpo) {
  if (!sb) throw new Error('El cotizador no está configurado.');
  let r;
  try { r = await sb.functions.invoke('agencias', { body: cuerpo }); } catch { throw new Error('Sin conexión: probá de nuevo en un momento.'); }
  if (r.error) {
    let d = null;
    try { d = await r.error.context?.json(); } catch { /* sin cuerpo */ }
    const e = new Error(d?.mensaje || (r.error.name === 'FunctionsFetchError' ? 'Sin conexión: probá de nuevo en un momento.' : 'No se pudo completar la consulta. Probá de nuevo en un momento.'));
    e.codigo = d?.error || ''; e.status = r.error.context?.status;
    throw e;
  }
  return r.data;
}

function falla(e) {
  if (e?.status === 401 || e?.codigo === 'sin_sesion') { salir(); return; }
  if (e?.codigo === 'sin_acceso') { S.fase = 'sinacceso'; render(); return; }
  if (e?.codigo === 'clave_temporal') { S.fase = 'clave'; render(); return; }
  S.error = e?.message || 'No se pudo completar la consulta.';
  render();
}

// ───────────────────────── Sesión ─────────────────────────
async function arrancar() {
  if (!sb) { S.fase = 'ingreso'; S.error = 'El cotizador no está configurado.'; render(); return; }
  const { data } = await sb.auth.getSession();
  if (!data.session) { S.fase = 'ingreso'; render(); return; }
  await cargarYo();
}

async function cargarYo() {
  S.fase = 'cargando'; render();
  try {
    S.yo = await fn({ accion: 'yo' });
    if (S.yo.clave_temporal) { S.fase = 'clave'; render(); return; }
    S.fase = 'app'; S.plazo = S.yo.plazos?.includes(S.plazo) ? S.plazo : S.yo.plazos?.[(S.yo.plazos?.length || 1) - 1] || 0;
    render();
    if (S.yo.miembro && !S.marcas) cargarMarcas();
  } catch (e) {
    if (e.status === 401 || e.codigo === 'sin_sesion') { await sb.auth.signOut().catch(() => {}); S.fase = 'ingreso'; S.error = ''; render(); return; }
    if (e.codigo === 'sin_acceso') { S.fase = 'sinacceso'; render(); return; }
    S.fase = 'ingreso'; S.error = e.message; render();
  }
}

async function ingresar(email, clave) {
  S.ocupado = true; S.error = ''; render();
  const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: clave });
  S.ocupado = false;
  if (error) {
    S.error = error.code === 'invalid_credentials' ? 'Email o contraseña incorrectos.'
      : error.status === 429 ? 'Demasiados intentos seguidos. Esperá un momento.' : 'No se pudo ingresar. Probá de nuevo.';
    render(); return;
  }
  await cargarYo();
}

async function cambiarClave(a, b) {
  if (a.length < 10) { S.error = 'La contraseña tiene que tener al menos 10 caracteres.'; render(); return; }
  if (a !== b) { S.error = 'Las dos contraseñas no coinciden.'; render(); return; }
  S.ocupado = true; S.error = ''; render();
  const { error } = await sb.auth.updateUser({ password: a });
  if (error) { S.ocupado = false; S.error = error.code === 'same_password' ? 'Tiene que ser distinta de la actual.' : error.code === 'weak_password' ? 'Esa contraseña es muy fácil de adivinar.' : 'No se pudo cambiar la contraseña.'; render(); return; }
  try { await fn({ accion: 'clave_definida' }); } catch { /* se vuelve a pedir la próxima vez */ }
  S.ocupado = false;
  await cargarYo();
}

async function salir() {
  try { await sb?.auth.signOut(); } catch { /* igual se limpia */ }
  Object.assign(S, { fase: 'ingreso', yo: null, error: '', marcas: null, marca: '', modelos: null, modelo: '', versiones: null, version: '', anios: null, anio: '', res: null, adm: null, vista: 'cotizar', cuit: '', bcra: null, bcraError: '', continuo: false, confirmarOtro: false, sols: null, sol: nuevaSol() });
  render();
}

// ───────────────────────── El cliente (BCRA) ─────────────────────────
const soloDigitos = (x) => String(x ?? '').replace(/\D/g, '');
/** Dígito verificador del CUIT/CUIL (el mismo control que hace la función antes de preguntar al BCRA). */
function cuitValido(c) {
  if (!/^\d{11}$/.test(c)) return false;
  const p = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let v = 11 - (p.reduce((a, k, i) => a + k * +c[i], 0) % 11);
  if (v === 11) v = 0;
  return v !== 10 && v === +c[10];
}
const cuitLindo = (c) => (/^\d{11}$/.test(c) ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : c);
/** Lo que ve la agencia según el color del BCRA. Amarillo y sin antecedentes siguen, pero «sujeto a revisión». */
const SEMAFORO = {
  verde: { color: 'Verde', accion: 'Continuar', texto: 'sin atrasos informados en el sistema financiero.', sigue: true },
  amarillo: { color: 'Amarillo', accion: 'Continuar – Sujeto a revisión', texto: 'tiene alguna observación en el sistema financiero. La Mutual la va a revisar.', sigue: true },
  sin_datos: { color: 'Sin antecedentes', accion: 'Continuar – Sujeto a revisión', texto: 'no figura con deudas en el sistema financiero. La Mutual lo va a revisar.', sigue: true },
  rojo: { color: 'Rojo', accion: 'No apto', texto: 'tiene atrasos o cheques rechazados informados. No se puede solicitar el crédito.', sigue: false },
};

async function consultarCliente() {
  const cuit = soloDigitos(S.cuit);
  if (cuit.length !== 11) { S.bcraError = 'El CUIT o CUIL tiene que tener 11 números.'; render(); return; }
  if (!cuitValido(cuit)) { S.bcraError = 'Ese CUIT o CUIL no existe: revisá los números.'; render(); return; }
  Object.assign(S, { cargando: 'bcra', bcraError: '', bcra: null, continuo: false, res: null, sol: nuevaSol() }); render();
  try { S.bcra = await fn({ accion: 'bcra', cuit }); } catch (e) {
    S.cargando = '';
    if (e?.status === 401 || ['sin_sesion', 'sin_acceso', 'clave_temporal'].includes(e?.codigo)) { falla(e); return; }
    S.bcraError = e.message; render(); return;
  }
  S.cargando = ''; render();
  if (!S.marcas) cargarMarcas();
}

function otroCliente() {
  // Si ya cargó datos o documentos de este cliente, pide que lo confirme con un segundo toque.
  if (S.sol.abierta && !S.sol.enviada && !S.confirmarOtro) { S.confirmarOtro = true; render(); return; }
  Object.assign(S, { cuit: '', bcra: null, bcraError: '', continuo: false, confirmarOtro: false, res: null, monto: '', sol: nuevaSol() });
  render();
}

// ───────────────────────── La solicitud ─────────────────────────
const hoy = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD, en la hora del teléfono
const tope = () => S.yo?.relacion_max || 45;
const relacionActual = () => (S.res?.financiable ? relacionCuota(S.res.cuota, soloNumero(S.sol.ingreso)) : null);
const relacionOk = () => S.sol.ingresos === true && relacionActual() !== null && relacionActual() <= tope();
const porcentaje = (n) => (Number(n) || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });
const tamano = (n) => (n >= 1048576 ? `${(n / 1048576).toLocaleString('es-AR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const LADO_FOTO = 2000; // px: se leen bien recibos y declaraciones, y cada foto queda en menos de 1 MB

function abrirSolicitud() {
  const L = S.sol;
  L.abierta = true;
  if (!L.dni) L.dni = dniDelCuit(S.bcra?.cuit);
  render();
  $('#pasoIngresos')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Un PDF va como está; una foto (también PNG o las del iPhone) se achica y se pasa a JPG. */
async function prepararArchivo(f) {
  const nombre = f.name || 'archivo';
  const cabeza = new Uint8Array(await f.slice(0, 8).arrayBuffer());
  const tipo = tipoArchivo(cabeza);
  if (tipo?.ext === 'pdf') {
    if (f.size > MAX_BYTES) throw new Error(`«${nombre}» pesa más de 10 MB: mandalo más liviano o como fotos.`);
    return f;
  }
  let bmp;
  try { bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }); } catch {
    if (tipo?.ext === 'jpg' && f.size <= MAX_BYTES) return f;
    throw new Error(`«${nombre}» no es un PDF ni una foto que se pueda leer.`);
  }
  const k = Math.min(1, LADO_FOTO / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
  const cx = cv.getContext('2d');
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); // una captura con transparencia no queda negra
  cx.drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  const blob = await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', 0.85));
  if (!blob || blob.size > MAX_BYTES) throw new Error(`No se pudo preparar «${nombre}». Probá con otra foto o en PDF.`);
  return new File([blob], `${nombre.replace(/\.[^.]*$/, '') || 'foto'}.jpg`, { type: 'image/jpeg' });
}

async function agregarArchivos(slot, files) {
  const L = S.sol, d = DOCS[slot];
  if (!d) return;
  L.error = '';
  for (const f of files) {
    if ((L.docs[slot]?.length || 0) >= d.max) { L.error = `En «${d.titulo}» van hasta ${d.max} archivos.`; break; }
    L.preparando++; render();
    try { const listo = await prepararArchivo(f); (L.docs[slot] ||= []).push({ file: listo, nombre: listo.name }); } catch (e) { L.error = e.message; }
    L.preparando--;
  }
  render();
}

function quitarArchivo(slot, i) {
  const L = S.sol;
  L.docs[slot]?.splice(i, 1);
  L.envio = null; // si ya se había subido, la solicitud se arma de nuevo (la base descarta la anterior y sus archivos)
  render();
}

function revisarSolicitud() {
  const L = S.sol, errores = [];
  const rd = revisarDatos({ dni: L.dni, domicilio: L.domicilio, estado_civil: L.estado_civil, matrimonio_lugar: L.matrimonio_lugar, matrimonio_fecha: L.matrimonio_fecha, celular: L.celular, cbu: L.cbu }, hoy());
  if (rd.errores) errores.push(...rd.errores);
  for (const k of docsRequeridos(L.categoria, S.res.anio)) if (!L.docs[k]?.length) errores.push(`Adjuntá: ${DOCS[k].titulo}.`);
  if (!L.conformidad) errores.push('Marcá que el cliente está de acuerdo con enviar sus datos y documentos a la Mutual.');
  return { errores, datos: rd.datos };
}

async function enviarSolicitud() {
  const L = S.sol;
  if (L.enviando || L.preparando || S.yo.miembro || !relacionOk()) return;
  const { errores, datos } = revisarSolicitud();
  L.errores = errores; L.error = '';
  if (errores.length) { render(); $('#erroresSol')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  const r = S.res;
  const cuerpo = { accion: 'solicitar', consulta: S.bcra.consulta, ref: S.version, anio: r.anio, cuotas: r.cuotas, monto: r.monto, vehiculo: r.vehiculo,
    ingresos: true, ingreso: soloNumero(L.ingreso), categoria: L.categoria, datos, consentimiento: true };
  const firma = JSON.stringify(cuerpo);
  const permitidos = docsPermitidos(L.categoria, r.anio);
  const archivos = Object.entries(L.docs).filter(([k]) => permitidos.includes(k)).flatMap(([slot, xs]) => xs.map((x) => ({ slot, x })));
  L.enviando = true; L.progreso = 'Enviando la solicitud…'; render();
  try {
    // Si una subida anterior quedó a medias con estos mismos datos, sigue desde ahí.
    if (!L.envio || L.envio.firma !== firma) L.envio = { id: (await fn(cuerpo)).id, firma, subidos: new Set() };
    let n = 0;
    for (const { slot, x } of archivos) {
      n++;
      if (L.envio.subidos.has(x)) continue;
      L.progreso = `Subiendo archivo ${n} de ${archivos.length}…`; render();
      const fd = new FormData();
      fd.append('accion', 'archivo'); fd.append('id', L.envio.id); fd.append('slot', slot); fd.append('archivo', x.file, x.nombre);
      await fn(fd);
      L.envio.subidos.add(x);
    }
    L.progreso = 'Enviando…'; render();
    await fn({ accion: 'enviar', id: L.envio.id });
    L.enviada = true; L.envio = null; S.sols = null;
  } catch (e) {
    L.enviando = false; L.progreso = '';
    if (e?.status === 401 || ['sin_sesion', 'sin_acceso'].includes(e?.codigo)) { falla(e); return; }
    if (['solicitud', 'consulta'].includes(e?.codigo)) L.envio = null;
    L.error = e.message; render(); return;
  }
  L.enviando = false; L.progreso = ''; render();
  $('#resultado')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function cargarSolicitudes() {
  S.sols = null; render();
  try { S.sols = (await fn({ accion: 'solicitudes' })).solicitudes || []; } catch (e) { S.sols = []; falla(e); return; }
  render();
}

// ───────────────────────── Elegir el auto ─────────────────────────
async function cargarMarcas() {
  S.cargando = 'marcas'; S.error = ''; render();
  try { S.marcas = (await fn({ accion: 'marcas' })).marcas || []; } catch (e) { S.cargando = ''; falla(e); return; }
  S.cargando = ''; render();
}

async function elegirMarca(id) {
  Object.assign(S, { marca: id, modelos: null, modelo: '', versiones: null, version: '', anios: null, anio: '', res: null, error: '' });
  if (!id) { render(); return; }
  S.cargando = 'modelos'; render();
  try { S.modelos = (await fn({ accion: 'modelos', marca: Number(id) })).modelos || []; } catch (e) { S.cargando = ''; falla(e); return; }
  S.cargando = ''; render();
}

async function elegirModelo(id) {
  Object.assign(S, { modelo: id, versiones: null, version: '', anios: null, anio: '', res: null, error: '' });
  if (!id) { render(); return; }
  S.cargando = 'versiones'; render();
  try { S.versiones = (await fn({ accion: 'versiones', marca: Number(S.marca), grupo: Number(id) })).versiones || []; } catch (e) { S.cargando = ''; falla(e); return; }
  S.cargando = ''; render();
}

async function elegirVersion(ref) {
  Object.assign(S, { version: ref, anios: null, anio: '', res: null, error: '' });
  if (!ref) { render(); return; }
  S.cargando = 'anios'; render();
  try { S.anios = (await fn({ accion: 'anios', ref })).anios || []; } catch (e) { S.cargando = ''; falla(e); return; }
  S.anio = S.anios[0] || '';
  S.cargando = ''; render();
}

const nombreDe = (xs, id, k = 'id') => (xs || []).find((x) => String(x[k]) === String(id))?.nombre || '';
const vehiculoElegido = () => [nombreDe(S.marcas, S.marca), nombreDe(S.modelos, S.modelo), nombreDe(S.versiones, S.version, 'ref')].filter(Boolean).join(' ');
const etiquetaAnio = (a) => (a === '0km' ? '0 km' : a);

async function cotizar() {
  if (!S.version || !S.anio || !S.plazo) { S.error = 'Elegí el vehículo, el año y el plazo.'; render(); return; }
  S.cargando = 'cotizar'; S.error = ''; render();
  try {
    S.res = await fn({ accion: 'cotizar', ref: S.version, anio: S.anio, cuotas: S.plazo, monto: soloNumero(S.monto) || undefined, vehiculo: vehiculoElegido() });
    S.res.vehiculo = vehiculoElegido();
  } catch (e) { S.cargando = ''; S.res = null; falla(e); return; }
  S.cargando = ''; render();
  $('#resultado')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function textoParaComprador(r) {
  return `Te paso las condiciones del crédito prendario de la Asociación Mutual Bell:\n\n`
    + `Vehículo: ${r.vehiculo} (${etiquetaAnio(r.anio)})\n`
    + `Monto del crédito: ${plata(r.monto)}\n`
    + `${r.cuotas} cuotas de ${plata(r.cuota)}\n`
    + `Total a pagar: ${plata(r.total)}\n`
    + `TNA ${pct(r.tna)} · TEA ${pct(r.tea)} · CFT ${pct(r.cft)}\n\n`
    + (r.leyenda ? `${r.leyenda}\n` : '') + (r.contacto ? `${r.contacto}\n` : '') + (S.yo?.agencia && !S.yo.miembro ? `\nAtentamente, ${S.yo.agencia}` : '');
}

// ───────────────────────── Administración (solo la Mutual) ─────────────────────────
async function cargarAdmin() {
  S.adm = { cargando: true }; render();
  try {
    const [aj, ag, co, so] = await Promise.all([
      sb.from('ajustes_agencias').select('*').eq('id', 1).maybeSingle(),
      sb.from('agencias').select('*').order('nombre'),
      sb.from('cotizaciones_agencia').select('*').order('momento', { ascending: false }).limit(200),
      sb.from('solicitudes_credito').select('*').neq('estado', 'cargando').order('momento', { ascending: false }).limit(200),
    ]);
    const err = aj.error || ag.error || co.error || so.error;
    if (err) throw err;
    // El detalle del BCRA de cada solicitud (por qué dio ese color), de las consultas guardadas.
    const ids = [...new Set((so.data || []).map((x) => x.consulta).filter(Boolean))];
    const bc = ids.length ? await sb.from('consultas_bcra').select('id,semaforo,motivos,deuda_total,entidades,peor_situacion,periodo').in('id', ids) : { data: [] };
    S.adm = { ajustes: aj.data, agencias: ag.data || [], cotizaciones: co.data || [], solicitudes: so.data || [], bcra: new Map((bc.data || []).map((x) => [x.id, x])), docs: new Map() };
  } catch (e) {
    S.adm = { error: /relation|PGRST205|does not exist/i.test(`${e.code} ${e.message}`) ? 'Falta activar el cotizador en la base.' : 'No se pudo leer la administración.' };
  }
  render();
}

async function guardarParametros(form) {
  const v = (n) => form.elements[n]?.value ?? '';
  // Plazos: "12, 18, 24" o un rango "1-24" (o "1 a 24").
  const plazos = [];
  for (const parte of v('plazos').split(/[,;]+/)) {
    const m = parte.trim().match(/^(\d+)\s*(?:-|a|al)\s*(\d+)$/i);
    if (m) { for (let n = Math.min(+m[1], +m[2]); n <= Math.max(+m[1], +m[2]) && plazos.length < 200; n++) plazos.push(n); }
    else for (const n of parte.split(/[^\d]+/).filter(Boolean).map(Number)) plazos.push(n);
  }
  // Tasas por modelo: "2021=5; 2018=6; 2014=7" (desde ese año, esa tasa).
  const tasas = [];
  let tasasMal = false;
  for (const parte of v('tasas').split(/[;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = parte.match(/^(\d{4})\s*[=:]\s*([\d.,]+)\s*%?$/);
    const t = m ? numero(m[2]) : NaN;
    if (!m || !(t >= 0)) { tasasMal = true; break; }
    tasas.push({ desde: +m[1], tasa: t });
  }
  if (tasasMal) { S.admMsg = 'Las tasas por modelo van así: 2021=5; 2018=6; 2014=7 (desde ese año, esa tasa).'; render(); return; }
  const g = {};
  for (const k of ['sellado', 'arancel', 'arancelMin', 'contratos', 'envio', 'gestoria', 'seguro', 'administrativos', 'cuotaSocial', 'igr']) g[k] = numero(v(`g_${k}`)) ?? 0;
  g.redondeo = numero(v('g_redondeo'));
  const fila = {
    habilitado: form.elements.habilitado.checked,
    pct_financiable: numero(v('pct_financiable')), tasa_mensual: numero(v('tasa_mensual')), plazos: [...new Set(plazos.filter((n) => n >= 1 && n <= 120))].sort((a, b) => a - b),
    anio_minimo: numero(v('anio_minimo')), tasas: tasas.sort((x, y) => y.desde - x.desde),
    antiguedad_max: numero(v('antiguedad_max')), monto_minimo: numero(v('monto_minimo')) ?? 0, monto_maximo: numero(v('monto_maximo')),
    relacion_max: numero(v('relacion_max')) ?? 45,
    redondeo: numero(v('redondeo')) || 1, tope_diario: numero(v('tope_diario')) || 300, leyenda: v('leyenda').trim(), contacto: v('contacto').trim(), gastos: g,
  };
  if (!fila.plazos.length) { S.admMsg = 'Escribí al menos un plazo (por ejemplo: 12, 18, 24 o 1-24).'; render(); return; }
  const malos = Object.entries({ ...fila, ...g }).filter(([, x]) => typeof x === 'number' && Number.isNaN(x)).map(([k]) => k);
  if (malos.length || fila.pct_financiable == null || fila.tasa_mensual == null) { S.admMsg = 'Hay un número mal escrito: revisá los campos (usá coma para los decimales).'; render(); return; }
  const { error } = await sb.from('ajustes_agencias').update(fila).eq('id', 1);
  S.admMsg = error ? `No se guardó: ${error.message}` : 'Parámetros guardados.';
  await cargarAdmin();
  if (!error) await cargarYo();
}

async function altaAgencia(form) {
  const v = (n) => form.elements[n].value.trim();
  if (!v('email') || !v('nombre') || !v('informada')) { S.admMsg = 'Completá nombre, email y la fecha en que se informó a la guía de precios.'; render(); return; }
  const { error } = await sb.rpc('alta_agencia', { p_email: v('email'), p_nombre: v('nombre'), p_informada: v('informada'), p_notas: v('notas') });
  S.admMsg = error ? error.message : 'Agencia habilitada.';
  await cargarAdmin();
}

/** Los documentos de una solicitud: enlaces que da la función y vencen a los 15 minutos. */
async function verDocumentos(id) {
  S.adm.docs.set(id, { cargando: true }); render();
  try { S.adm.docs.set(id, { lista: (await fn({ accion: 'archivos', id })).archivos || [], hora: Date.now() }); } catch (e) { S.adm.docs.set(id, { error: e.message }); }
  render();
}

async function resolverSolicitud(id, estado) {
  const nota = document.querySelector(`[data-nota="${CSS.escape(id)}"]`)?.value.trim() || '';
  const { error } = await sb.from('solicitudes_credito').update({ estado, nota }).eq('id', id);
  S.admMsg = error ? `No se guardó: ${error.message}` : estado === 'aprobada' ? 'Solicitud aprobada.' : estado === 'rechazada' ? 'Solicitud rechazada.' : 'La solicitud volvió a pendiente.';
  await cargarAdmin();
}

async function cambiarActiva(id, activa) {
  const { error } = await sb.from('agencias').update({ activa }).eq('id', id);
  S.admMsg = error ? error.message : (activa ? 'Agencia activada.' : 'Agencia pausada: ya no puede cotizar.');
  await cargarAdmin();
}

// ───────────────────────── Pantallas ─────────────────────────
function vistaIngreso() {
  return `<section class="card ingreso">
    <h2>Ingresá con tu usuario</h2>
    <p class="hint m0">El usuario y la contraseña te los da la Asociación Mutual Bell.</p>
    <form id="fIngreso" class="grilla" novalidate>
      <label class="f ancho">Email<input name="email" type="email" autocomplete="username" required></label>
      <label class="f ancho">Contraseña<input name="clave" type="password" autocomplete="current-password" required></label>
      ${S.error ? `<p class="aviso ancho m0" role="alert">${esc(S.error)}</p>` : ''}
      <div class="ancho"><button class="btn primario" type="submit" ${S.ocupado ? 'disabled' : ''}>${S.ocupado ? 'Ingresando…' : 'Ingresar'}</button></div>
    </form>
    <p class="hint m0">¿Olvidaste la contraseña? Pedile a la Mutual que te la restablezca.</p>
  </section>`;
}

function vistaClave() {
  return `<section class="card ingreso">
    <h2>Elegí tu contraseña</h2>
    <p class="hint m0">Es la primera vez que entrás: reemplazá la contraseña provisoria por una tuya (al menos 10 caracteres).</p>
    <form id="fClave" class="grilla" novalidate>
      <label class="f ancho">Contraseña nueva<input name="a" type="password" autocomplete="new-password" minlength="10" required></label>
      <label class="f ancho">Repetila<input name="b" type="password" autocomplete="new-password" minlength="10" required></label>
      ${S.error ? `<p class="aviso ancho m0" role="alert">${esc(S.error)}</p>` : ''}
      <div class="ancho"><button class="btn primario" type="submit" ${S.ocupado ? 'disabled' : ''}>${S.ocupado ? 'Guardando…' : 'Guardar contraseña'}</button></div>
    </form>
  </section>`;
}

function selector(id, etiqueta, xs, valor, clave, cargando, deshabilitado) {
  const vacio = cargando ? 'Cargando…' : deshabilitado ? '—' : `Elegí ${etiqueta.toLowerCase()}`;
  return `<label class="f">${esc(etiqueta)}<select id="${id}" ${!xs || cargando || deshabilitado ? 'disabled' : ''}>
    <option value="">${esc(vacio)}</option>${(xs || []).map((x) => `<option value="${esc(x[clave])}"${String(x[clave]) === String(valor) ? ' selected' : ''}>${esc(x.nombre)}</option>`).join('')}</select></label>`;
}

function vistaCliente() {
  const B = S.bcra, c = S.cargando;
  if (!B) {
    return `<section class="card no-imprimir">
      <div class="card-cab"><h2>1 · El cliente</h2>${S.yo.miembro ? '<span class="etq">Vista previa de la Mutual · no se registra</span>' : ''}</div>
      <form id="fCliente" class="grilla" novalidate>
        <label class="f ancho">CUIT o CUIL del cliente<input id="inCuit" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="Ej.: 20-12345678-6" value="${esc(S.cuit)}"></label>
        ${S.bcraError ? `<p class="aviso ancho m0" role="alert">${esc(S.bcraError)}</p>` : ''}
        <div class="ancho acciones"><button class="btn primario" type="submit" ${c === 'bcra' ? 'disabled' : ''}>${c === 'bcra' ? 'Consultando…' : 'Consultar BCRA'}</button></div>
      </form>
      <p class="hint m0">Se consulta la Central de Deudores del BCRA. Hacelo con el consentimiento del cliente y solo para evaluar este crédito.</p>
    </section>`;
  }
  const sem = SEMAFORO[B.semaforo] || SEMAFORO.sin_datos;
  return `<section class="card semaforo s-${esc(B.semaforo)}">
    <div class="card-cab"><h2>1 · El cliente</h2><button class="btn chico no-imprimir" type="button" id="btnOtroCliente">${S.confirmarOtro ? 'Sí, empezar con otro' : 'Otro cliente'}</button></div>
    <div class="sem-fila"><span class="sem-luz" aria-hidden="true"></span><div><b class="sem-nombre">${esc(sem.accion)}</b><div>${esc(B.denominacion || 'Sin nombre informado')}</div><div class="hint mono">${esc(cuitLindo(B.cuit))}</div></div></div>
    <p class="hint m0">BCRA: ${esc(sem.color.toLowerCase())}, ${esc(sem.texto)}</p>
    ${S.confirmarOtro ? '<p class="aviso suave m0">Se borra todo lo que cargaste de este cliente (datos y documentos). Tocá de nuevo para confirmarlo.</p>' : ''}
    ${sem.sigue && !S.continuo ? `<div class="acciones no-imprimir"><button class="btn primario" type="button" id="btnContinuar">${esc(sem.accion)}</button></div>` : ''}
  </section>`;
}

function vistaCotizar() {
  const Y = S.yo;
  if (!Y.habilitado && !Y.miembro) return `<section class="card"><h2>El cotizador todavía no está habilitado</h2><p class="hint m0">Consultá con la Asociación Mutual Bell.</p></section>`;
  const aviso = !Y.habilitado ? '<p class="aviso suave m0 no-imprimir">Las agencias todavía no pueden usarlo: habilitalo en Administración → Parámetros cuando los revises.</p>' : '';
  if (!S.bcra || !S.continuo) return aviso + vistaCliente();
  const c = S.cargando;
  const anios = S.anios ? S.anios.map((a) => ({ id: a, nombre: etiquetaAnio(a) })) : null;
  const sinAnios = S.anios && !S.anios.length;
  const plazos = Y.plazos || [];
  const plazo = plazos.length > 6
    ? `<label class="f">Cuotas<select id="selPlazo">${plazos.map((n) => `<option value="${n}"${n === S.plazo ? ' selected' : ''}>${n} ${n === 1 ? 'cuota' : 'cuotas'}</option>`).join('')}</select></label>`
    : `<div class="f ancho">Plazo<div class="plazos" role="group" aria-label="Cantidad de cuotas">${plazos.map((n) => `<button type="button" data-plazo="${n}" aria-pressed="${n === S.plazo}">${n} cuotas</button>`).join('')}</div></div>`;
  const form = `<section class="card no-imprimir">
    <div class="card-cab"><h2>2 · El vehículo y el crédito</h2></div>
    <div class="grilla">
      ${selector('selMarca', 'Marca', S.marcas, S.marca, 'id', c === 'marcas', false)}
      ${selector('selModelo', 'Modelo', S.modelos, S.modelo, 'id', c === 'modelos', !S.marca)}
      ${selector('selVersion', 'Versión', S.versiones, S.version, 'ref', c === 'versiones', !S.modelo)}
      ${selector('selAnio', 'Año', anios, S.anio, 'id', c === 'anios', !S.version)}
      ${sinAnios ? '<p class="aviso suave ancho m0">Esta versión no se puede financiar. Probá con otra.</p>' : ''}
      ${S.modelos && !S.modelos.length ? '<p class="aviso suave ancho m0">Esta marca no tiene modelos para financiar.</p>' : ''}
      ${plazo}
      <label class="f">Monto a pedir (opcional)<input id="inMonto" inputmode="numeric" autocomplete="off" placeholder="Vacío = el máximo" value="${esc(S.monto)}"></label>
    </div>
    ${S.error ? `<p class="aviso m0" role="alert">${esc(S.error)}</p>` : ''}
    <div class="acciones"><button class="btn primario" type="button" id="btnCotizar" ${!S.version || !S.anio || c ? 'disabled' : ''}>${c === 'cotizar' ? 'Calculando…' : 'Ver crédito'}</button></div>
  </section>`;
  return aviso + vistaCliente() + form + (S.res ? vistaResultado(S.res) + vistaSolicitud() : '');
}

/** De todos los plazos, los que se muestran en la tabla: el elegido, el más largo y los "redondos". */
function opcionesVisibles(r) {
  const xs = r.opciones || [];
  if (xs.length <= 6) return xs;
  const max = xs[xs.length - 1]?.cuotas;
  return xs.filter((o) => o.cuotas === r.cuotas || o.cuotas === max || [3, 6, 9, 12, 18, 24, 36, 48, 60].includes(o.cuotas));
}

/** Al pie del crédito: el botón para seguir con la solicitud, o el aviso de que ya se envió. */
function vistaAvanzar() {
  const L = S.sol;
  if (L.enviada) return '<p class="aviso ok m0" role="status">Solicitud enviada a la Mutual, con toda la documentación. Vas a ver la respuesta en «Mis solicitudes».</p>';
  if (L.abierta) return '';
  return `<div class="solicitar no-imprimir">
    <h3>¿El cliente quiere avanzar?</h3>
    <p class="hint m0">Seguí con la solicitud: ingresos, documentación y datos del cliente. La Mutual la revisa y tiene la última palabra.</p>
    <div class="acciones"><button class="btn primario" type="button" id="btnAvanzar">Continuar con la solicitud</button></div>
  </div>`;
}

function htmlRelacion() {
  const rel = relacionActual(), max = tope();
  if (rel === null) return `<p class="hint m0">Con el ingreso se calcula qué parte se lleva la cuota de ${plata(S.res.cuota)} (hasta el ${porcentaje(max)} %).</p>`;
  if (rel > max) return `<p class="aviso m0" role="alert">La cuota (${plata(S.res.cuota)}) es el ${porcentaje(rel)} % del ingreso: supera el ${porcentaje(max)} %. Para avanzar, probá con más cuotas o un monto menor.</p>`;
  return `<p class="aviso ok m0">La cuota es el ${porcentaje(rel)} % del ingreso (el tope es ${porcentaje(max)} %).</p>
    <div class="f">¿Cómo obtiene sus ingresos?<div class="categorias" role="radiogroup" aria-label="Cómo obtiene sus ingresos">${Object.entries(CATEGORIAS)
      .map(([k, t], i) => `<button type="button" role="radio" data-categoria="${k}" aria-checked="${S.sol.categoria === k}"><span class="num-cat">${i + 1}</span>${esc(t)}</button>`).join('')}</div></div>`;
}

/** Un casillero de documentos: lo que ya se adjuntó y el botón para sumar (PDF o fotos). */
function casillero(slot) {
  const L = S.sol, d = DOCS[slot], xs = L.docs[slot] || [];
  const requerido = docsRequeridos(L.categoria, S.res.anio).includes(slot);
  const etq = xs.length ? (xs.length < d.esperados ? `<span class="etq">${xs.length} de ${d.esperados}</span>` : '<span class="etq ok">Listo</span>')
    : requerido ? '<span class="etq no">Falta</span>' : '<span class="etq">Opcional</span>';
  return `<div class="doc" id="doc-${slot}">
    <div class="card-cab"><b>${esc(d.titulo)}</b>${etq}</div>
    ${xs.length ? `<ul class="doc-lista">${xs.map((x, i) => `<li><span class="doc-nombre">${esc(x.nombre)}</span><span class="hint">${tamano(x.file.size)}</span><button class="btn chico" type="button" data-quitar="${slot}" data-i="${i}" ${L.enviando ? 'disabled' : ''}>Quitar</button></li>`).join('')}</ul>` : ''}
    ${xs.length < d.max && !L.enviando ? `<label class="btn chico doc-sumar">${xs.length ? 'Agregar otro archivo' : 'Adjuntar'}<input class="oculto" type="file" accept="application/pdf,image/*" multiple data-slot="${slot}"></label>` : ''}
    ${xs.length && xs.length < d.esperados ? `<p class="hint m0">Se esperan ${d.esperados}. Si están todos en un mismo PDF, alcanza con ese.</p>` : ''}
  </div>`;
}

function vistaSolicitud() {
  const L = S.sol, r = S.res;
  if (!L.abierta || L.enviada || !r?.financiable) return '';
  let html = `<section class="card no-imprimir" id="pasoIngresos"><h2>3 · Ingresos</h2>
    <div class="f">¿Tiene ingresos demostrables?<div class="opciones2" role="radiogroup" aria-label="Ingresos demostrables">
      <button type="button" role="radio" data-ingresos="si" aria-checked="${L.ingresos === true}">Sí</button>
      <button type="button" role="radio" data-ingresos="no" aria-checked="${L.ingresos === false}">No</button></div></div>`;
  if (L.ingresos === false) html += '<p class="aviso m0" role="alert">Sin ingresos demostrables no se puede avanzar con la solicitud.</p>';
  if (L.ingresos === true) {
    html += `<label class="f">Ingreso mensual aproximado ($)<input id="inIngreso" inputmode="numeric" autocomplete="off" placeholder="Ej.: 1.500.000" value="${esc(L.ingreso)}"></label>
      <div id="bloqueRelacion" class="bloque">${htmlRelacion()}</div>`;
  }
  html += '</section>';
  if (!relacionOk() || !L.categoria) return html;

  const v = (k) => esc(L[k] ?? '');
  const dniCuit = dniDelCuit(S.bcra?.cuit), dni = soloDigitos(L.dni);
  html += `<section class="card no-imprimir"><h2>4 · Documentación de ingresos</h2>
    <p class="hint m0">${esc(CATEGORIAS[L.categoria])}. PDF o fotos, hasta 10 MB cada archivo (las fotos se achican solas).</p>
    ${DOCS_INGRESOS[L.categoria].map(casillero).join('')}
  </section>
  <section class="card no-imprimir" id="pasoDatos"><h2>5 · Datos del cliente</h2>
    <div class="bloque"><label class="f">DNI<input data-campo="dni" inputmode="numeric" autocomplete="off" maxlength="12" value="${v('dni')}"></label>
      ${dniCuit && dni && dni !== dniCuit ? '<p class="aviso suave m0">No coincide con el CUIL que se consultó en el BCRA.</p>' : ''}
      ${casillero('dni')}</div>
    <div class="bloque"><div class="f">Vehículo cotizado<div class="dato">${esc(r.vehiculo)} · ${esc(etiquetaAnio(r.anio))}</div></div>
      ${casillero('titulo')}${r.anio === '0km' ? '<p class="hint m0">Es 0 km: todavía no tiene título, así que es opcional.</p>' : ''}</div>
    <div class="bloque"><label class="f">Domicilio real<input data-campo="domicilio" autocomplete="off" maxlength="300" placeholder="Calle, número y localidad" value="${v('domicilio')}"></label>
      ${casillero('servicio')}</div>
    <div class="bloque"><div class="f">Estado civil<div class="opciones2" role="radiogroup" aria-label="Estado civil">
        <button type="button" role="radio" data-civil="soltero" aria-checked="${L.estado_civil === 'soltero'}">Soltero/a</button>
        <button type="button" role="radio" data-civil="casado" aria-checked="${L.estado_civil === 'casado'}">Casado/a</button></div></div>
      ${L.estado_civil === 'casado' ? `<div class="grilla">
        <label class="f">Lugar del matrimonio<input data-campo="matrimonio_lugar" autocomplete="off" maxlength="200" value="${v('matrimonio_lugar')}"></label>
        <label class="f">Fecha del matrimonio<input data-campo="matrimonio_fecha" type="date" max="${hoy()}" value="${v('matrimonio_fecha')}"></label></div>` : ''}</div>
    <div class="bloque"><label class="f">Celular, con característica<input data-campo="celular" type="tel" inputmode="tel" autocomplete="off" maxlength="25" placeholder="Ej.: 3534 123456" value="${v('celular')}"></label></div>
    <div class="bloque"><label class="f">CBU o CVU donde se deposita el crédito<input data-campo="cbu" inputmode="numeric" autocomplete="off" maxlength="30" value="${v('cbu')}"></label>
      ${casillero('cbu')}</div>
    <label class="check"><input type="checkbox" id="chkConformidad" ${L.conformidad ? 'checked' : ''}> El cliente está de acuerdo con enviar estos datos y documentos a la Asociación Mutual Bell para que evalúe el crédito.</label>
    ${L.errores.length ? `<div class="aviso m0" role="alert" id="erroresSol"><b>Antes de enviar, falta:</b><ul>${L.errores.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
    ${L.error ? `<p class="aviso m0" role="alert">${esc(L.error)}</p>` : ''}
    ${L.preparando ? '<p class="hint m0">Preparando las fotos…</p>' : ''}
    ${S.yo.miembro ? '<p class="hint m0">Vista previa de la Mutual: la agencia ve acá el botón «Enviar solicitud a la Mutual».</p>'
      : `<div class="acciones"><button class="btn primario" type="button" id="btnEnviarSol" ${L.enviando || L.preparando ? 'disabled' : ''}>${L.enviando ? esc(L.progreso || 'Enviando…') : 'Enviar solicitud a la Mutual'}</button></div>`}
  </section>`;
  return html;
}

function vistaResultado(r) {
  if (!r.financiable) return `<section class="card resultado" id="resultado"><h2>No se puede financiar</h2><p class="m0">${esc(r.mensaje || 'Este vehículo no alcanza las condiciones del crédito.')}</p></section>`;
  const opciones = opcionesVisibles(r).map((o) => `<tr class="${o.cuotas === r.cuotas ? 'elegido' : ''}"><td>${o.cuotas} ${o.cuotas === 1 ? 'cuota' : 'cuotas'}</td><td class="num">${plata(o.cuota)}</td></tr>`).join('');
  return `<section class="card resultado" id="resultado">
    <div class="card-cab"><h2>${esc(r.vehiculo)}</h2><span class="etq">${esc(etiquetaAnio(r.anio))}</span></div>
    <div class="destacado"><span class="titulo">Monto máximo que financia la Mutual</span><span class="cifra">${plata(r.maximo)}</span></div>
    <div class="cuota-grande">Crédito de <b>${plata(r.monto)}</b> en ${r.cuotas} ${r.cuotas === 1 ? 'cuota' : 'cuotas'} de <b>${plata(r.cuota)}</b></div>
    <dl class="tasas m0"><div><dt>TNA</dt><dd>${pct(r.tna)}</dd></div><div><dt>TEA</dt><dd>${pct(r.tea)}</dd></div><div><dt>CFT</dt><dd>${pct(r.cft)}</dd></div></dl>
    <table><tbody>
      <tr><td>Total a pagar</td><td class="num">${plata(r.total)}</td></tr>
      <tr><td>Gastos de otorgamiento (incluidos en las cuotas)</td><td class="num">${plata(r.gastos_otorgamiento)}</td></tr>
    </tbody></table>
    <div class="scroll"><table><thead><tr><th>Otros plazos con este monto</th><th class="num">Cuota</th></tr></thead><tbody>${opciones}</tbody></table></div>
    <p class="leyenda m0">El CFT incluye los gastos de otorgamiento, el seguro, los gastos administrativos y la cuota social. No incluye IVA. ${esc(r.leyenda || '')}</p>
    ${r.contacto ? `<p class="leyenda m0">${esc(r.contacto)}</p>` : ''}
    <div class="acciones no-imprimir">
      <button class="btn" type="button" id="btnWhatsapp">Enviar al cliente por WhatsApp</button>
      <button class="btn" type="button" id="btnImprimir">Imprimir</button>
    </div>
    ${vistaAvanzar()}
  </section>`;
}

const ESTADOS = { pendiente: ['Pendiente', ''], aprobada: ['Aprobada', 'ok'], rechazada: ['Rechazada', 'no'] };
const etqEstado = (e) => { const [t, c] = ESTADOS[e] || [e, '']; return `<span class="etq ${c}">${esc(t)}</span>`; };

/** «Mis solicitudes», para la agencia. */
function vistaSolicitudes() {
  if (!S.sols) return '<section class="card"><p class="hint m0">Cargando…</p></section>';
  if (!S.sols.length) return '<section class="card"><h2>Mis solicitudes</h2><p class="hint m0">Todavía no mandaste solicitudes. Se envían desde «Cotizar», después de ver el crédito.</p></section>';
  return `<section class="card"><h2>Mis solicitudes</h2>${S.sols.map((x) => `<div class="sol">
      <div class="card-cab"><b>${esc(x.denominacion || cuitLindo(x.cuit))}</b>${etqEstado(x.estado)}</div>
      <div class="hint">${esc(fechaHora(x.momento))} · <span class="mono">${esc(cuitLindo(x.cuit))}</span>${['amarillo', 'sin_datos'].includes(x.semaforo) ? ' · sujeta a revisión' : ''}</div>
      <div>${esc(x.vehiculo)} <span class="hint">${esc(etiquetaAnio(x.anio))}</span></div>
      <div class="mono">${plata(x.monto)} · ${x.cuotas} × ${plata(x.cuota)}</div>
      ${x.nota ? `<p class="m0">Respuesta de la Mutual: ${esc(x.nota)}</p>` : ''}
    </div>`).join('')}</section>`;
}

/** [1,2,3,…,24] → "1-24"; [12,18,24] → "12, 18, 24". */
function plazosTexto(xs) {
  const v = [...new Set((xs || []).map(Number))].sort((a, b) => a - b), out = [];
  for (let i = 0; i < v.length; i++) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    out.push(j - i >= 2 ? `${v[i]}-${v[j]}` : v.slice(i, j + 1).join(', '));
    i = j;
  }
  return out.join(', ');
}

function vistaAdmin() {
  const A = S.adm;
  if (!A || A.cargando) return '<section class="card"><p class="hint m0">Cargando…</p></section>';
  if (A.error) return `<section class="card"><p class="aviso m0">${esc(A.error)}</p></section>`;
  const tabs = `<nav class="tabs" role="tablist">${[['solicitudes', `Solicitudes${A.solicitudes.some((x) => x.estado === 'pendiente') ? ` (${A.solicitudes.filter((x) => x.estado === 'pendiente').length})` : ''}`], ['parametros', 'Parámetros'], ['agencias', `Agencias (${A.agencias.filter((x) => x.activa).length}/20)`], ['cotizaciones', 'Cotizaciones']]
    .map(([k, t]) => `<button role="tab" data-adm="${k}" aria-selected="${S.admTab === k}">${esc(t)}</button>`).join('')}</nav>`;
  const msg = S.admMsg ? `<p class="aviso suave m0" role="status">${esc(S.admMsg)}</p>` : '';
  let cuerpo = '';
  if (S.admTab === 'solicitudes') {
    const SEM = { verde: ['Verde · Continuar', 'ok'], amarillo: ['Amarillo · Sujeto a revisión', 'rev'], sin_datos: ['Sin antecedentes · Sujeto a revisión', 'rev'], rojo: ['Rojo · No apto', 'no'] };
    const fila = (t, v) => `<tr><td>${t}</td><td class="num">${v}</td></tr>`;
    const docs = (x) => {
      const n = Array.isArray(x.archivos) ? x.archivos.length : 0;
      if (!n) return '';
      const D = A.docs.get(x.id);
      if (!D || D.error) return `${D?.error ? `<p class="aviso m0">${esc(D.error)}</p>` : ''}<div class="acciones"><button class="btn" type="button" data-docs="${esc(x.id)}">Ver documentos (${n})</button></div>`;
      if (D.cargando) return '<p class="hint m0">Buscando los documentos…</p>';
      const grupos = Object.keys(DOCS).map((k) => [k, D.lista.filter((a) => a.slot === k)]).filter(([, xs]) => xs.length);
      return `<div class="docs-adm"><b>Documentos</b>${grupos.map(([k, xs]) => `<div><span class="hint">${esc(DOCS[k].titulo)}</span><ul class="doc-lista">${xs.map((a) =>
        `<li>${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.nombre)}</a>` : esc(a.nombre)}<span class="hint">${tamano(a.tamano)}</span></li>`).join('')}</ul></div>`).join('')}
        <p class="hint m0">Los enlaces vencen a los 15 minutos: si vence uno, tocá <button class="btn chico" type="button" data-docs="${esc(x.id)}">Ver documentos</button> de nuevo.</p></div>`;
    };
    const una = (x) => {
      const b = A.bcra.get(x.consulta), motivos = Array.isArray(b?.motivos) ? b.motivos : [];
      const pend = x.estado === 'pendiente', d = x.datos || {}, [semT, semC] = SEM[x.semaforo] || [x.semaforo, ''];
      const dniCuit = dniDelCuit(x.cuit);
      return `<div class="sol">
        <div class="card-cab"><b>${esc(x.denominacion || cuitLindo(x.cuit))}</b>${etqEstado(x.estado)}</div>
        <div class="hint">${esc(fechaHora(x.enviada || x.momento))} · pide <b>${esc(x.agencia)}</b></div>
        <table><tbody>
          ${fila('CUIT', esc(cuitLindo(x.cuit)))}
          ${fila('BCRA', `<span class="etq ${semC}">${esc(semT)}</span>`)}
          ${b ? fila('Deuda informada · entidades', `${plata(b.deuda_total)} · ${esc(b.entidades)}`) : ''}
          ${fila('Vehículo', `${esc(x.vehiculo)} (${esc(etiquetaAnio(x.anio))})`)}
          ${fila('Crédito', `${plata(x.monto)} en ${x.cuotas} × ${plata(x.cuota)}`)}
          ${fila('Total · tasa mensual · CFT', `${plata(x.total)} · ${pct(x.tasa)} · ${pct(x.cft)}`)}
          ${x.ingreso ? fila('Ingreso mensual declarado', `${plata(x.ingreso)} · la cuota es el ${porcentaje(x.relacion)} %`) : ''}
          ${x.categoria ? fila('Ingresos', esc(CATEGORIAS[x.categoria] || x.categoria)) : ''}
          ${d.dni ? fila('DNI', `${esc(Number(d.dni).toLocaleString('es-AR'))}${dniCuit && dniCuit !== d.dni ? ' <span class="etq no">no coincide con el CUIL</span>' : ''}`) : ''}
          ${d.domicilio ? fila('Domicilio real', esc(d.domicilio)) : ''}
          ${d.estado_civil ? fila('Estado civil', d.estado_civil === 'casado' ? `Casado/a · ${esc(d.matrimonio_lugar || '')}, ${esc(d.matrimonio_fecha ? d.matrimonio_fecha.split('-').reverse().join('/') : '')}` : 'Soltero/a') : ''}
          ${x.cliente ? fila('Celular', esc(x.cliente)) : ''}
          ${d.cbu ? fila('CBU o CVU', `<span class="mono">${esc(d.cbu)}</span>`) : ''}
        </tbody></table>
        ${motivos.length ? `<p class="hint m0">BCRA: ${esc(motivos.join(' · '))}</p>` : ''}
        ${docs(x)}
        ${pend ? `<label class="f">Nota para la agencia (opcional)<input data-nota="${esc(x.id)}" maxlength="500" autocomplete="off"></label>
          <div class="acciones"><button class="btn primario" type="button" data-resolver="${esc(x.id)}" data-estado="aprobada">Aprobar</button><button class="btn" type="button" data-resolver="${esc(x.id)}" data-estado="rechazada">Rechazar</button></div>`
          : `<p class="hint m0">${esc(x.resuelto_por)} · ${esc(fechaHora(x.resuelto))}${x.nota ? ` · ${esc(x.nota)}` : ''} <button class="btn chico" type="button" data-resolver="${esc(x.id)}" data-estado="pendiente">Volver a pendiente</button></p>`}
      </div>`;
    };
    const pend = A.solicitudes.filter((x) => x.estado === 'pendiente'), resto = A.solicitudes.filter((x) => x.estado !== 'pendiente');
    cuerpo = `<section class="card"><h2>Solicitudes de aprobación de crédito</h2>${msg}
      ${pend.length ? pend.map(una).join('') : '<p class="hint m0">No hay solicitudes pendientes.</p>'}
      <p class="hint m0">El detalle completo del BCRA de cada cliente está en Créditos y Cobros → Créditos → Deudas por CUIT (la consulta figura hecha por la agencia).</p></section>
      ${resto.length ? `<section class="card"><h2>Resueltas</h2>${resto.map(una).join('')}</section>` : ''}`;
  } else if (S.admTab === 'parametros') {
    const j = A.ajustes || {}, g = j.gastos || {};
    const campo = (n, t, val, extra = '') => `<label class="f">${esc(t)}<input name="${n}" inputmode="decimal" autocomplete="off" value="${esc(typeof val === 'number' || /^-?\d+(\.\d+)?$/.test(String(val ?? '')) ? enCampo(val) : (val ?? ''))}" ${extra}></label>`;
    cuerpo = `<form id="fParametros" class="card" novalidate>
      <h2>Parámetros del crédito</h2>
      <label class="check"><input type="checkbox" name="habilitado" ${j.habilitado ? 'checked' : ''}> Cotizador habilitado para las agencias</label>
      <div class="grilla">
        ${campo('pct_financiable', '% del valor del vehículo que se financia', j.pct_financiable)}
        ${campo('tasa_mensual', 'Tasa mensual (%) si el modelo no entra en ningún tramo', j.tasa_mensual)}
        ${campo('plazos', 'Plazos en cuotas (ej.: 12, 18, 24 o un rango: 1-24)', plazosTexto(j.plazos), 'inputmode="text"')}
        ${campo('tasas', 'Tasa mensual según el modelo (desde el año = tasa %)', (j.tasas || []).map((t) => `${t.desde}=${enCampo(t.tasa)}`).join('; '), 'inputmode="text" placeholder="2021=5; 2018=6; 2014=7"')}
        ${campo('anio_minimo', 'Modelo más viejo que se financia (año; vacío = sin tope)', j.anio_minimo, 'inputmode="numeric"')}
        ${campo('antiguedad_max', 'Antigüedad máxima del vehículo (años; vacío = sin tope)', j.antiguedad_max)}
        ${campo('monto_minimo', 'Monto mínimo ($)', j.monto_minimo)}
        ${campo('monto_maximo', 'Monto máximo ($; vacío = sin tope)', j.monto_maximo)}
        ${campo('redondeo', 'Redondear el máximo hacia abajo a ($)', j.redondeo)}
        ${campo('tope_diario', 'Tope de cotizaciones por agencia y por día', j.tope_diario)}
        ${campo('relacion_max', 'Relación cuota / ingreso máxima (%)', j.relacion_max ?? 45)}
      </div>
      <h3>Gastos (como el simulador interno)</h3>
      <div class="grilla">
        ${campo('g_sellado', 'Sellado (% del total del crédito)', g.sellado)}${campo('g_arancel', 'Arancel (% del total del crédito)', g.arancel)}
        ${campo('g_arancelMin', 'Arancel mínimo ($)', g.arancelMin)}${campo('g_contratos', 'Contratos y administrativos ($)', g.contratos)}
        ${campo('g_envio', 'Envío de documentación ($)', g.envio)}${campo('g_gestoria', 'Gestoría ($)', g.gestoria)}
        ${campo('g_redondeo', 'Redondeo de gastos ($; vacío = automático)', g.redondeo)}${campo('g_seguro', 'Seguro de vida (% del capital por cuota)', g.seguro)}
        ${campo('g_administrativos', 'Gastos administrativos ($ por cuota)', g.administrativos)}${campo('g_cuotaSocial', 'Cuota social ($ por cuota)', g.cuotaSocial)}
        ${campo('g_igr', 'IGR (% de los intereses)', g.igr)}
      </div>
      <label class="f">Leyenda al pie de cada cotización<textarea name="leyenda" maxlength="1000">${esc(j.leyenda || '')}</textarea></label>
      <label class="f">Contacto de la Mutual (opcional; sale en la cotización)<input name="contacto" maxlength="300" value="${esc(j.contacto || '')}" inputmode="text"></label>
      ${msg}
      <div class="acciones"><button class="btn primario" type="submit">Guardar parámetros</button></div>
    </form>`;
  } else if (S.admTab === 'agencias') {
    const filas = A.agencias.map((x) => `<tr><td><b>${esc(x.nombre)}</b><br><span class="hint">${esc(x.email)}</span></td>
      <td>${x.activa ? '<span class="etq ok">Activa</span>' : '<span class="etq no">Pausada</span>'}<br><span class="hint">Informada: ${esc(x.informada_infoauto || '—')}</span></td>
      <td><button class="btn chico" type="button" data-activa="${esc(x.id)}" data-valor="${x.activa ? '0' : '1'}">${x.activa ? 'Pausar' : 'Activar'}</button></td></tr>`).join('');
    cuerpo = `<section class="card"><h2>Agencias</h2>
      ${A.agencias.length ? `<div class="scroll"><table><tbody>${filas}</tbody></table></div>` : '<p class="hint m0">Todavía no hay agencias.</p>'}
      ${msg}</section>
      <form id="fAlta" class="card" novalidate>
        <h2>Agregar una agencia</h2>
        <p class="hint m0">1) Avisale por escrito a la guía de precios que vas a sumar esta agencia (lo exige la licencia; tope: 20).
          2) Creá su cuenta en el panel de Supabase (Authentication → Users → Add user, con «Auto Confirm User») con una contraseña provisoria.
          3) Completá esto: al entrar, la agencia va a tener que elegir su propia contraseña.</p>
        <div class="grilla">
          <label class="f">Nombre de la agencia<input name="nombre" maxlength="120" autocomplete="off"></label>
          <label class="f">Email de la cuenta<input name="email" type="email" autocomplete="off"></label>
          <label class="f">Fecha en que se informó a la guía de precios<input name="informada" type="date"></label>
          <label class="f">Notas<input name="notas" maxlength="500" autocomplete="off"></label>
        </div>
        <div class="acciones"><button class="btn primario" type="submit">Habilitar agencia</button></div>
      </form>`;
  } else {
    const filas = A.cotizaciones.map((x) => `<tr><td>${esc(fechaHora(x.momento))}</td><td>${esc(x.agencia)}</td><td>${esc(x.vehiculo)} <span class="hint">${esc(etiquetaAnio(x.anio))}</span></td>
      <td class="num">${plata(x.monto)}</td><td class="num">${x.cuotas} × ${plata(x.cuota)}</td></tr>`).join('');
    cuerpo = `<section class="card"><h2>Cotizaciones de las agencias</h2>
      ${A.cotizaciones.length ? `<div class="scroll"><table><thead><tr><th>Fecha</th><th>Agencia</th><th>Vehículo</th><th class="num">Monto</th><th class="num">Cuotas</th></tr></thead><tbody>${filas}</tbody></table></div>`
        : '<p class="hint m0">Todavía no hay cotizaciones.</p>'}
      <p class="hint m0">Se muestran las últimas 200. No se guarda el valor del vehículo.</p></section>`;
  }
  return tabs + cuerpo;
}

function render() {
  const der = $('#cabDer');
  if (S.fase === 'app' || S.fase === 'clave' || S.fase === 'sinacceso') {
    der.innerHTML = `${S.yo ? `<span class="quien">${esc(S.yo.agencia)}</span>` : ''}<button class="btn chico" type="button" id="btnSalir">Salir</button>`;
  } else der.innerHTML = '';
  const m = $('#main');
  if (S.fase === 'cargando') m.innerHTML = '<p class="hint">Abriendo el cotizador…</p>';
  else if (S.fase === 'ingreso') m.innerHTML = vistaIngreso();
  else if (S.fase === 'clave') m.innerHTML = vistaClave();
  else if (S.fase === 'sinacceso') m.innerHTML = '<section class="card ingreso"><h2>Esta cuenta no está habilitada</h2><p class="hint m0">Consultá con la Asociación Mutual Bell.</p></section>';
  else {
    const otra = S.yo.miembro ? ['admin', 'Administración'] : ['solicitudes', 'Mis solicitudes'];
    const tabs = S.yo.habilitado || S.yo.miembro ? `<nav class="tabs no-imprimir" role="tablist"><button role="tab" data-vista="cotizar" aria-selected="${S.vista === 'cotizar'}">Cotizar</button><button role="tab" data-vista="${otra[0]}" aria-selected="${S.vista === otra[0]}">${otra[1]}</button></nav>` : '';
    m.innerHTML = tabs + (S.vista === 'admin' && S.yo.miembro ? vistaAdmin() : S.vista === 'solicitudes' && !S.yo.miembro ? vistaSolicitudes() : vistaCotizar());
  }
  $('#pie').textContent = S.fase === 'app' ? 'Simulación de referencia sujeta a aprobación crediticia de la Asociación Mutual Bell.' : '';
}

// ───────────────────────── Eventos ─────────────────────────
document.addEventListener('submit', (e) => {
  const f = e.target;
  e.preventDefault();
  if (f.id === 'fIngreso') ingresar(f.elements.email.value, f.elements.clave.value);
  else if (f.id === 'fClave') cambiarClave(f.elements.a.value, f.elements.b.value);
  else if (f.id === 'fCliente') consultarCliente();
  else if (f.id === 'fParametros') guardarParametros(f);
  else if (f.id === 'fAlta') altaAgencia(f);
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'selMarca') elegirMarca(t.value);
  else if (t.id === 'selModelo') elegirModelo(t.value);
  else if (t.id === 'selVersion') elegirVersion(t.value);
  else if (t.id === 'selAnio') { S.anio = t.value; S.res = null; render(); }
  else if (t.id === 'selPlazo') { S.plazo = Number(t.value); if (S.res) cotizar(); }
  else if (t.dataset.slot && t.files?.length) { const xs = [...t.files]; t.value = ''; agregarArchivos(t.dataset.slot, xs); }
  else if (t.id === 'chkConformidad') S.sol.conformidad = t.checked;
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'inMonto') {
    const n = soloNumero(t.value);
    S.monto = n ? n.toLocaleString('es-AR') : '';
    if (t.value !== S.monto) { t.value = S.monto; }
  } else if (t.id === 'inCuit') S.cuit = t.value;
  else if (t.id === 'inIngreso') {
    const antes = relacionOk(), n = soloNumero(t.value);
    S.sol.ingreso = n ? n.toLocaleString('es-AR') : '';
    if (t.value !== S.sol.ingreso) t.value = S.sol.ingreso;
    if (S.sol.categoria && antes !== relacionOk()) {
      // Con la categoría ya elegida, pasar el tope muestra u oculta los pasos siguientes: se redibuja todo y se
      // vuelve al campo, con el cursor al final.
      render();
      const c = $('#inIngreso');
      c?.focus(); c?.setSelectionRange(c.value.length, c.value.length);
    } else {
      const b = $('#bloqueRelacion'); // solo esta parte, para no perder el teclado mientras escribe
      if (b) b.innerHTML = htmlRelacion();
    }
  } else if (t.dataset.campo) S.sol[t.dataset.campo] = t.value;
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'btnSalir') salir();
  else if (t.id === 'btnCotizar') cotizar();
  else if (t.dataset.plazo) { S.plazo = Number(t.dataset.plazo); if (S.res) cotizar(); else render(); }
  else if (t.id === 'btnWhatsapp' && S.res) window.open(`https://wa.me/?text=${encodeURIComponent(textoParaComprador(S.res))}`, '_blank', 'noopener');
  else if (t.id === 'btnImprimir') window.print();
  else if (t.id === 'btnOtroCliente') otroCliente();
  else if (t.id === 'btnContinuar') { S.continuo = true; render(); }
  else if (t.id === 'btnAvanzar') abrirSolicitud();
  else if (t.dataset.ingresos) { S.sol.ingresos = t.dataset.ingresos === 'si'; render(); if (S.sol.ingresos) $('#inIngreso')?.focus(); }
  else if (t.dataset.categoria) { S.sol.categoria = t.dataset.categoria; render(); }
  else if (t.dataset.civil) { S.sol.estado_civil = t.dataset.civil; render(); }
  else if (t.dataset.quitar) quitarArchivo(t.dataset.quitar, Number(t.dataset.i));
  else if (t.id === 'btnEnviarSol') enviarSolicitud();
  else if (t.dataset.docs) verDocumentos(t.dataset.docs);
  else if (t.dataset.resolver) resolverSolicitud(t.dataset.resolver, t.dataset.estado);
  else if (t.dataset.vista) { S.vista = t.dataset.vista; S.admMsg = ''; if (S.vista === 'admin') cargarAdmin(); else if (S.vista === 'solicitudes') cargarSolicitudes(); else render(); }
  else if (t.dataset.adm) { S.admTab = t.dataset.adm; S.admMsg = ''; render(); }
  else if (t.dataset.activa) cambiarActiva(t.dataset.activa, t.dataset.valor === '1');
});

sb?.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT' && S.fase === 'app') { S.fase = 'ingreso'; render(); } });
arrancar();

// Cotizador de créditos prendarios para agencias y concesionarias (Asociación Mutual Bell).
//
// El vendedor elige marca, modelo, versión y año, y ve las condiciones del crédito de la Mutual. Todo lo
// pide a la función `agencias` de Supabase, que es la que consulta los valores de los vehículos y NUNCA
// los devuelve: acá no llega ni el valor ni el código del vehículo (licencia de la guía de precios), solo
// el monto máximo, las cuotas y las tasas. La app no lee la base: a las agencias la API les está cerrada.
//
// Un usuario de la Mutual (miembro del gestor) entra en «vista previa», sin enviar nada. La administración
// (solicitudes, parámetros, agencias y cotizaciones) está en Créditos y Cobros → Agencias.
//
// El recorrido de la agencia: 1) CUIT del cliente → BCRA (verde «Continuar»; amarillo o sin antecedentes
// «Continuar – Sujeto a revisión»; rojo «No apto»); 2) vehículo y crédito; 3) si quieren avanzar: ingresos
// demostrables (sin eso no sigue) y el ingreso mensual (la cuota no puede pasar el 45 %); cómo obtiene los
// ingresos; 4) su documentación; 5) datos del cliente con la suya; y se envía todo a la Mutual.
import { iniciarChat, apagarChat } from './chat.js?v=20261123b';
import { CATEGORIAS, DOCS, MAX_BYTES, docsPermitidos, docsRequeridos, dniDelCuit, relacionCuota, revisarDatos, tipoArchivo } from './solicitud.js';

const cfg = window.GESTOR_CONFIG || {};
// Sesión propia, no la del gestor ('gestor.sesion', que comparten el gestor, Cobranzas y Prenda): así entrar acá
// con la cuenta de una agencia no saca a la persona de sus apps en ese mismo navegador, ni al revés.
const sb = window.supabase && cfg.url && cfg.key && window.top === window.self
  ? window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'agencias.sesion' } })
  : null;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plata = (n) => `$ ${Math.round(Number(n) || 0).toLocaleString('es-AR')}`;
const pct = (n) => `${(Number(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
const soloNumero = (s) => Number(String(s ?? '').replace(/[^\d]/g, '')) || 0;
const fechaHora = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); };

const S = {
  fase: 'cargando', // cargando | ingreso | clave | sinacceso | app
  error: '', ocupado: false,
  yo: null, // { agencia, miembro, clave_temporal, habilitado, plazos, leyenda, contacto }
  vista: 'cotizar', // cotizar | solicitudes (agencia) | admin (Mutual)
  marcas: null, marca: '', modelos: null, modelo: '', versiones: null, version: '', anios: null, anio: '', buscaVer: '',
  plazo: 0, monto: '', cuotaMax: '', cargando: '', res: null,
  foto: null, // { ref, src }: la foto de la versión elegida (src null si no hay); la pide `cargarFoto`
  cuit: '', bcra: null, bcraError: '', continuo: false, confirmarOtro: false, sols: null, cots: null, elimCot: '', elimTodas: false, novedades: null,
  sol: null, // la solicitud que se está armando (nuevaSol)
  rap: null, // simulación rápida (solo la agencia marcada; `nuevaRapida`)
};

/** Lo que la agencia va cargando de la solicitud. `docs`: casillero → [{file, nombre}] (los archivos quedan en el
 *  navegador hasta que se envía). `envio`: la solicitud ya creada en la base, si una subida quedó a medias. */
function nuevaSol() {
  return {
    abierta: false, ingresos: null, ingreso: '', categoria: '', docs: {}, chk: {},
    actividad: '', dni: '', nacionalidad: '', nacimiento: '', dom_calle: '', dom_numero: '', dom_piso: '', dom_depto: '', dom_cp: '', dom_localidad: '', dom_departamento: '', dom_provincia: '', estado_civil: '', matrimonio_lugar: '', matrimonio_fecha: '', conyuge_nombre: '', conyuge_dni: '', conyuge_nacionalidad: '', conyuge_domicilio: '', conyuge_nacimiento: '', celular: '', cbu: '', alias: '', conformidad: false,
    cuenta: '', cuenta_titular: '', cuenta_cuit: '', cuenta_relacion: '',
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
    iniciarChat(fn, !!S.yo.chat);
    if (S.yo.miembro && !S.marcas) cargarMarcas();
    else mirarNovedades();
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
  apagarChat();
  try { await sb?.auth.signOut(); } catch { /* igual se limpia */ }
  Object.assign(S, { fase: 'ingreso', yo: null, error: '', marcas: null, marca: '', modelos: null, modelo: '', versiones: null, version: '', anios: null, anio: '', buscaVer: '', res: null, vista: 'cotizar', cuit: '', bcra: null, bcraError: '', continuo: false, confirmarOtro: false, sols: null, cots: null, sol: nuevaSol(), rap: null });
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
  sin_consulta: { color: 'Sin consulta', accion: 'Continuar sin consulta BCRA', texto: 'el BCRA no respondió. Es solo para probar: sin consulta no se puede enviar una solicitud.', sigue: true },
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
  Object.assign(S, { cuit: '', bcra: null, bcraError: '', continuo: false, confirmarOtro: false, res: null, monto: '', cuotaMax: '', sol: nuevaSol() });
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

/** Los documentos que se sacan con la cámara del celular, cada uno con su nombre (la Mutual los ve ordenados por ese nombre). */
const TIPOS_FOTO = [
  { k: 'dni_frente', t: 'DNI (frente)' },
  { k: 'dni_dorso', t: 'DNI (dorso)' },
  { k: 'servicio', t: 'Impuesto o servicio' },
  { k: 'titulo', t: 'Título del automotor' },
  { k: 'constancia', t: 'Constancia de CUIT o inscripción' },
  { k: 'recibo', t: 'Recibo de sueldo' },
  { k: 'otro', t: 'Otro documento' },
];

/** Tilda sola la lista de control cuando ya se sacó la foto que corresponde (la agencia la puede destildar). */
function tildarSegunFoto(k) {
  const L = S.sol, c = (L.chk ||= {}), hay = (t) => (L.docs.documentacion || []).some((x) => x.tipo === t);
  if (k === 'dni_frente' || k === 'dni_dorso') { if (hay('dni_frente') && hay('dni_dorso')) c.dni = true; }
  else if (k === 'servicio' || k === 'titulo') c[k] = true;
  else if (k === 'recibo' && L.categoria === 'dependencia') c.ing0 = true;
  else if (k === 'constancia' && L.categoria !== 'dependencia') c.ing0 = true;
}

/** Una foto sacada con la cámara: se achica como cualquier otra y queda con el nombre del documento («DNI (frente).jpg»). */
async function agregarFoto(k, files) {
  const L = S.sol, tipo = TIPOS_FOTO.find((x) => x.k === k), slot = 'documentacion', d = DOCS[slot];
  if (!tipo) return;
  L.error = '';
  for (const f of files) {
    if ((L.docs[slot]?.length || 0) >= d.max) { L.error = `Van hasta ${d.max} archivos.`; break; }
    L.preparando++; render();
    try {
      const listo = await prepararArchivo(f);
      const usados = new Set((L.docs[slot] || []).map((x) => x.nombre));
      const ext = listo.type === 'application/pdf' ? 'pdf' : 'jpg';
      let n = 1, nombre = `${tipo.t}.${ext}`;
      while (usados.has(nombre)) { n++; nombre = `${tipo.t} ${n}.${ext}`; }
      (L.docs[slot] ||= []).push({ file: new File([listo], nombre, { type: listo.type }), nombre, tipo: k });
      tildarSegunFoto(k);
    } catch (e) { L.error = e.message; }
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

/** Los casilleros que quedaron vacíos. No impiden enviar (nov 2026: a veces los documentos llegan a la Mutual por otra vía). */
const sinAdjuntar = () => docsRequeridos(S.sol.categoria, S.res.anio).filter((k) => !S.sol.docs[k]?.length);

function revisarSolicitud() {
  const L = S.sol, errores = [];
  const rd = revisarDatos({ actividad: L.actividad, dni: L.dni, nacionalidad: L.nacionalidad, nacimiento: L.nacimiento, dom_calle: L.dom_calle, dom_numero: L.dom_numero, dom_piso: L.dom_piso, dom_depto: L.dom_depto, dom_cp: L.dom_cp, dom_localidad: L.dom_localidad, dom_departamento: L.dom_departamento, dom_provincia: L.dom_provincia, estado_civil: L.estado_civil, matrimonio_lugar: L.matrimonio_lugar, matrimonio_fecha: L.matrimonio_fecha,
    conyuge_nombre: L.conyuge_nombre, conyuge_dni: L.conyuge_dni, conyuge_nacionalidad: L.conyuge_nacionalidad, conyuge_domicilio: L.conyuge_domicilio, conyuge_nacimiento: L.conyuge_nacimiento,
    celular: L.celular, cbu: L.cbu, alias: L.alias, cuenta: L.cuenta, cuenta_titular: L.cuenta_titular, cuenta_cuit: L.cuenta_cuit, cuenta_relacion: L.cuenta_relacion }, hoy());
  if (rd.errores) errores.push(...rd.errores);
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
  S.novedades = new Set(conNovedad(S.sols).map((x) => x.id)); // se marcan en la lista; después ya se dan por vistas
  marcarVistas();
  render();
}

async function cargarCotizaciones() {
  S.cots = null; render();
  try { S.cots = (await fn({ accion: 'cotizaciones' })).cotizaciones || []; } catch (e) { S.cots = []; falla(e); return; }
  render();
}

// ───────────────────────── Elegir el auto ─────────────────────────
async function cargarMarcas() {
  S.cargando = 'marcas'; S.error = ''; render();
  try { S.marcas = (await fn({ accion: 'marcas' })).marcas || []; } catch (e) { S.cargando = ''; falla(e); return; }
  S.cargando = ''; render();
}

async function elegirMarca(id) {
  Object.assign(S, { marca: id, modelos: null, modelo: '', versiones: null, version: '', anios: null, anio: '', buscaVer: '', res: null, error: '' });
  if (!id) { render(); return; }
  S.cargando = 'modelos'; render();
  try { S.modelos = (await fn({ accion: 'modelos', marca: Number(id) })).modelos || []; } catch (e) { S.cargando = ''; falla(e); return; }
  S.cargando = ''; render();
}

async function elegirModelo(id) {
  Object.assign(S, { modelo: id, versiones: null, version: '', anios: null, anio: '', buscaVer: '', res: null, error: '' });
  if (!id) { render(); return; }
  S.cargando = 'versiones'; render();
  try { S.versiones = (await fn({ accion: 'versiones', marca: Number(S.marca), grupo: Number(id) })).versiones || []; } catch (e) { S.cargando = ''; falla(e); return; }
  S.cargando = ''; render();
}

/** Primero el año: el que se elige filtra las versiones. Si la versión ya elegida no anda para ese año, se borra. */
function elegirAnio(anio) {
  S.anio = anio; S.res = null; S.error = '';
  const v = (S.versiones || []).find((x) => x.ref === S.version);
  if (v && !(v.anios || []).includes(anio)) Object.assign(S, { version: '', anios: null, buscaVer: '' });
  render();
}

/** Los años que ofrece el modelo: los de todas sus versiones (0 km primero, después del más nuevo al más viejo). */
function aniosDelModelo() {
  if (!S.versiones) return null;
  const set = new Set(S.versiones.flatMap((v) => v.anios || []));
  return [...set].sort((x, y) => (x === '0km' ? -1 : y === '0km' ? 1 : Number(y) - Number(x)));
}

/** Las versiones que hay para el año elegido. */
const versionesDelAnio = () => (S.versiones || []).filter((v) => !S.anio || (v.anios || []).includes(S.anio));

/** Al elegir la versión se confirma con InfoAuto que tenga valor para ese año (el listado da solo el rango). */
async function elegirVersion(ref) {
  Object.assign(S, { version: ref, anios: null, res: null, error: '', buscaVer: '' });
  if (!ref) { render(); return; }
  S.cargando = 'anios'; render();
  try { S.anios = (await fn({ accion: 'anios', ref })).anios || []; } catch (e) { S.cargando = ''; falla(e); return; }
  S.cargando = '';
  if (!S.anios.includes(S.anio)) {
    S.error = `Esa versión no se puede financiar para ${etiquetaAnio(S.anio)}. Elegí otra versión u otro año.`;
    S.version = '';
  }
  render();
}

/** Para buscar sin importar mayúsculas ni acentos, y con las palabras en cualquier orden. */
const normal = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function filtrarVersiones(q) {
  const palabras = normal(q).split(/\s+/).filter(Boolean);
  return versionesDelAnio().filter((v) => { const n = normal(v.nombre); return palabras.every((p) => n.includes(p)); });
}
function htmlListaVersiones(q) {
  const xs = filtrarVersiones(q);
  if (!xs.length) return '<p class="combo-vacio">No hay versiones con ese texto.</p>';
  return xs.map((v) => `<button type="button" role="option" data-ver="${esc(v.ref)}" aria-selected="${v.ref === S.version}">${esc(v.nombre)}</button>`).join('');
}
/** Saca de la pantalla lo que venía después del formulario (el crédito anterior), sin redibujar. */
function quitarDespues(el) {
  for (let n = el?.nextElementSibling; n;) { const x = n.nextElementSibling; n.remove(); n = x; }
}
function abrirLista(q) {
  const l = $('#listaVersiones');
  if (!l) return;
  l.innerHTML = htmlListaVersiones(q); l.hidden = false;
  $('#inVersion')?.setAttribute('aria-expanded', 'true');
}
function cerrarLista() {
  const l = $('#listaVersiones');
  if (l) l.hidden = true;
  $('#inVersion')?.setAttribute('aria-expanded', 'false');
}

const nombreDe = (xs, id, k = 'id') => (xs || []).find((x) => String(x[k]) === String(id))?.nombre || '';
const vehiculoElegido = () => [nombreDe(S.marcas, S.marca), nombreDe(S.modelos, S.modelo), nombreDe(S.versiones, S.version, 'ref')].filter(Boolean).join(' ');
const etiquetaAnio = (a) => (a === '0km' ? '0 km' : a);

async function cotizar() {
  if (!S.version || !S.anio || !S.plazo) { S.error = 'Elegí el vehículo, el año y el plazo.'; render(); return; }
  S.cargando = 'cotizar'; S.error = ''; render();
  try {
    S.res = await fn({ accion: 'cotizar', ref: S.version, anio: S.anio, cuotas: S.plazo, monto: soloNumero(S.monto) || undefined, cuota_max: soloNumero(S.cuotaMax) || undefined, vehiculo: vehiculoElegido(), cuit: soloDigitos(S.cuit) });
    S.res.vehiculo = vehiculoElegido();
    // Lo que escribió la agencia, para explicar el resultado.
    S.res.pidio = soloNumero(S.monto) || 0;
  } catch (e) { S.cargando = ''; S.res = null; falla(e); return; }
  S.cargando = ''; render();
  $('#resultado')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (S.res?.financiable) cargarFoto(S.version);
}

/** La foto de la versión, una vez por versión. Si no hay o falla, el resultado queda sin foto. */
async function cargarFoto(ref) {
  if (S.foto?.ref === ref) return;
  S.foto = { ref, src: null };
  let src = null;
  try { src = (await fn({ accion: 'foto', ref })).foto || null; } catch { src = null; }
  if (S.foto?.ref !== ref || !/^data:image\/(jpeg|png|webp);base64,/.test(String(src || ''))) return;
  S.foto.src = src;
  const f = $('#fotoVehiculo');
  const h = $('#hojaFoto');
  if (h) h.innerHTML = `<img src="${src}" alt="">`;
  if (f) f.innerHTML = `<img src="${src}" alt="Foto del vehículo">`; else render();
}

/** El mensaje de WhatsApp. Sin `r.vehiculo` (simulación rápida) sale igual, sin la línea del vehículo; la leyenda y el
 *  contacto, si la respuesta no los trae, se toman de los parámetros que llegaron al entrar. */
function textoParaComprador(r, extra = '') {
  const leyenda = r.leyenda ?? S.yo?.leyenda, contacto = r.contacto ?? S.yo?.contacto;
  return `Te paso las condiciones del crédito prendario de la Asociación Mutual Bell:\n\n`
    + (r.vehiculo ? `Vehículo: ${r.vehiculo} (${etiquetaAnio(r.anio)})\n` : '')
    + `Monto del crédito: ${plata(r.monto)}\n`
    + `${r.cuotas} cuotas de ${plata(r.cuota)}\n\n`
    + (extra ? `${extra}\n\n` : '')
    + (leyenda ? `${leyenda}\n` : '') + (contacto ? `${contacto}\n` : '') + (S.yo?.agencia && !S.yo.miembro ? `\nAtentamente, ${S.yo.agencia}` : '');
}

// ───────────────────────── Simulación rápida ─────────────────────────
// Solo para la cuenta de prueba de la persona («PROPIO», migración 0036): capital, cuotas, tasa y gastos a mano,
// sin CUIT ni vehículo. La función la rechaza para cualquier otra agencia.
const GASTOS_RAPIDA = [
  ['sellado', 'Sellado', '%'], ['arancel', 'Arancel del Registro', '%'], ['arancelMin', 'Arancel mínimo', '$'],
  ['contratos', 'Contratos', '$'], ['envio', 'Envío', '$'], ['gestoria', 'Gestoría', '$'],
  ['seguro', 'Seguro (por cuota, sobre el capital)', '%'], ['administrativos', 'Gastos administrativos (por cuota)', '$'],
  ['cuotaSocial', 'Cuota social (por cuota)', '$'], ['igr', 'IGR (sobre los intereses)', '%'],
];
// Los que se reparten en las cuotas van plegados (pedido de la persona del 19/11/2026); se tocan poco.
// Se calcula igual con el valor de los parámetros, pero no se muestra (pedido de la persona, 19/11/2026).
const GASTOS_OCULTOS = ['arancelMin'];
const GASTOS_PLEGADOS = ['seguro', 'administrativos', 'cuotaSocial', 'igr'];
// Al lado de estos porcentajes, el monto que dio la última simulación.
const CON_MONTO = ['sellado', 'arancel'];
/** Número escrito a la argentina («1.500.000», «1,2») → número. */
const numAR = (x) => Number(String(x ?? '').trim().replace(/\./g, '').replace(',', '.')) || 0;
const escribirAR = (n, dec = 2) => (Number(n) || 0).toLocaleString('es-AR', { maximumFractionDigits: dec });

function nuevaRapida() {
  const R = S.yo?.rapida || {}, g = R.gastos || {};
  return {
    capital: '', cuotas: String(S.yo?.plazos?.[S.yo.plazos.length - 1] || 12), tasa: escribirAR(R.tasa ?? 5),
    g: Object.fromEntries(GASTOS_RAPIDA.map(([k]) => [k, escribirAR(g[k] ?? 0)])),
    res: null, error: '', cargando: false, otros: false,
  };
}

async function simularRapida() {
  const R = S.rap, capital = numAR(R.capital), cuotas = Math.trunc(numAR(R.cuotas));
  if (!(capital > 0)) { R.error = 'Escribí el capital.'; render(); return; }
  if (!(cuotas >= 1 && cuotas <= 120)) { R.error = 'Las cuotas tienen que ser de 1 a 120.'; render(); return; }
  R.cargando = true; R.error = ''; render();
  try {
    R.res = await fn({ accion: 'rapida', capital, cuotas, tasa: numAR(R.tasa), gastos: Object.fromEntries(GASTOS_RAPIDA.map(([k]) => [k, numAR(R.g[k])])) });
  } catch (e) { R.cargando = false; R.res = null; R.error = e?.message || 'No se pudo calcular.'; render(); return; }
  R.cargando = false; render();
  $('#resultado')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// El mismo mensaje que el del cotizador, sin la línea del vehículo y con lo que hay que mandar para avanzar
// (pedidos de la persona, 19/11/2026; el texto es el suyo).
const DOCS_RAPIDA = `Recordá que para avanzar en tu crédito debes enviarnos por acá:
1) Foto de DNI (ambos lados)
2) Foto de un impuesto o Servicio para constatar el domicilio
3) A) En caso de ser empleado en relación de dependencia: Últimos 6 recibos de sueldo.
    B) En caso de ser Monotributista: Constancia de Inscripción y últimos 3 pagos.
    C) En caso de ser Responsable Inscripto: Constancia de Inscripción, últimas 3 DDJJ de IVA y Ganancias.
4) Título del automotor.
5) Estado civil; en caso de ser casado/a: menciona el lugar y fecha de matrimonio
6) Nro. de celular
7) CBU dónde se va a depositar el crédito`;
const textoRapida = (r) => textoParaComprador({ ...r, vehiculo: '' }, DOCS_RAPIDA);

function vistaRapida() {
  const R = S.rap ||= nuevaRapida(), r = R.res;
  const campo = (id, etq, val, pista = '', monto = null) => {
    const input = `<input data-rap="${id}" inputmode="decimal" autocomplete="off" value="${esc(val)}"${pista ? ` placeholder="${esc(pista)}"` : ''}>`;
    return `<label class="f">${esc(etq)}${monto == null ? input : `<span class="con-monto">${input}<span class="monto-calc" title="Monto según la última simulación">${monto === '' ? '' : `= ${plata(monto)}`}</span></span>`}</label>`;
  };
  const gasto = ([k, etq, u]) => campo(`g.${k}`, `${etq} (${u})`, R.g[k], '', CON_MONTO.includes(k) ? (r ? r[k] ?? '' : '') : null);
  const visibles = GASTOS_RAPIDA.filter(([k]) => !GASTOS_PLEGADOS.includes(k) && !GASTOS_OCULTOS.includes(k)), plegados = GASTOS_RAPIDA.filter(([k]) => GASTOS_PLEGADOS.includes(k));
  const form = `<section class="card no-imprimir">
    <div class="card-cab"><h2>Simulación rápida</h2></div>
    <p class="hint">Sin CUIT ni vehículo: escribí el capital, las cuotas, la tasa y los gastos. Solo para tu cuenta.</p>
    <div class="grilla">
      ${campo('capital', 'Capital ($)', R.capital, 'Ej.: 5.000.000')}
      ${campo('cuotas', 'Cantidad de cuotas', R.cuotas)}
      ${campo('tasa', 'Tasa mensual (%)', R.tasa)}
    </div>
    <h3>Gastos</h3>
    <div class="grilla">${visibles.map(gasto).join('')}</div>
    <details class="plegado" id="rapOtros"${R.otros ? ' open' : ''}>
      <summary>Gastos que se reparten en las cuotas <span class="hint">(seguro ${esc(R.g.seguro)} %, administrativos $ ${esc(R.g.administrativos)}, cuota social $ ${esc(R.g.cuotaSocial)}, IGR ${esc(R.g.igr)} %)</span></summary>
      <div class="grilla">${plegados.map(gasto).join('')}</div>
    </details>
    ${R.error ? `<p class="aviso m0" role="alert">${esc(R.error)}</p>` : ''}
    <div class="acciones">
      <button class="btn primario" type="button" id="btnRapida" ${R.cargando ? 'disabled' : ''}>${R.cargando ? 'Calculando…' : 'Simular'}</button>
      <button class="btn" type="button" id="btnRapidaReset">Volver a los valores de la Mutual</button>
    </div>
  </section>`;
  if (!r) return form;
  const opciones = opcionesVisibles(r).map((o) => `<tr class="${o.cuotas === r.cuotas ? 'elegido' : ''}"><td>${o.cuotas} ${o.cuotas === 1 ? 'cuota' : 'cuotas'}</td><td class="num">${plata(o.cuota)}</td></tr>`).join('');
  return form + `<section class="card resultado" id="resultado">
    <div class="cuota-grande">Crédito de <b>${plata(r.monto)}</b> en ${r.cuotas} ${r.cuotas === 1 ? 'cuota' : 'cuotas'} de <b>${plata(r.cuota)}</b></div>
    <table><tbody>
      <tr><td>Total a pagar</td><td class="num">${plata(r.total)}</td></tr>
      <tr><td>Gastos de otorgamiento (incluidos en las cuotas)</td><td class="num">${plata(r.gastos_otorgamiento)}</td></tr>
    </tbody></table>
    ${opciones ? `<div class="scroll"><table><thead><tr><th>Otros plazos con este monto</th><th class="num">Cuota</th></tr></thead><tbody>${opciones}</tbody></table></div>` : ''}
    <p class="leyenda tasas m0">Tasa mensual ${pct(r.tasa)}. No incluye IVA.</p>
    ${hojaImprimir(r, '')}
    <div class="acciones no-imprimir">
      <button class="btn" type="button" id="btnWhatsappRapida">Enviar por WhatsApp</button>
      <button class="btn" type="button" id="btnImprimir">Imprimir</button>
    </div>
  </section>`;
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

/** La versión: un campo donde se escribe para buscar y, debajo, la lista que se va achicando. */
function buscadorVersion() {
  const c = S.cargando, sinAnio = !S.anio, cargando = c === 'versiones' || c === 'anios';
  const valor = S.version ? nombreDe(S.versiones, S.version, 'ref') : S.buscaVer;
  const ph = c === 'versiones' ? 'Cargando…' : c === 'anios' ? 'Confirmando…' : !S.modelo ? '—' : sinAnio ? 'Primero elegí el año' : 'Escribí para buscar (ej.: SRX 4x4)';
  return `<div class="f combo">Versión
    <input id="inVersion" type="search" role="combobox" aria-expanded="false" aria-controls="listaVersiones" autocomplete="off" autocorrect="off" spellcheck="false"
      placeholder="${esc(ph)}" value="${esc(valor)}" ${!S.versiones || sinAnio || cargando ? 'disabled' : ''}>
    <div id="listaVersiones" class="combo-lista" role="listbox" hidden></div>
  </div>`;
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
  // «Otro cliente» va fuera del recuadro, para que el espacio de la derecha sea el resumen del BCRA.
  return `<div class="otro-cliente no-imprimir">
      ${S.confirmarOtro ? '<span class="aviso suave m0">Se borra todo lo que cargaste de este cliente (datos y documentos). Tocá de nuevo para confirmarlo.</span>' : ''}
      <button class="btn chico" type="button" id="btnOtroCliente">${S.confirmarOtro ? 'Sí, empezar con otro' : 'Otro cliente'}</button>
    </div>
    <section class="card semaforo no-imprimir s-${esc(B.semaforo)}">
    <div class="cliente-cols">
      <div class="cliente-izq">
        <h2>1 · El cliente</h2>
        <div class="sem-fila"><span class="sem-luz" aria-hidden="true"></span><div><b class="sem-nombre">${esc(sem.accion)}</b><div>${esc(B.denominacion || 'Sin nombre informado')}</div><div class="hint mono">${esc(cuitLindo(B.cuit))}</div></div></div>
        <p class="hint m0">BCRA: ${esc(sem.color.toLowerCase())}, ${esc(sem.texto)}</p>
        ${sem.sigue && !S.continuo ? `<div class="acciones no-imprimir"><button class="btn primario" type="button" id="btnContinuar">${esc(sem.accion)}</button></div>` : ''}
      </div>
      ${resumenBCRA(B)}
    </div>
  </section>`;
}

const SITUACION = { 0: 'Sin dato', 1: '1 · Normal', 2: '2 · Riesgo bajo', 3: '3 · Riesgo medio', 4: '4 · Riesgo alto', 5: '5 · Irrecuperable', 6: '6 · Irrec. técnica' };

/** El resumen de la Central de Deudores: con qué entidades opera, su situación y la deuda informada (último período). */
function resumenBCRA(B) {
  const bancos = Array.isArray(B.bancos) ? B.bancos : null;
  if (!bancos || B.sin_consulta) return ''; // respuesta de una versión anterior de la función
  const per = /^\d{6}$/.test(B.periodo || '') ? `${B.periodo.slice(4, 6)}/${B.periodo.slice(0, 4)}` : '';
  if (!bancos.length) {
    return `<aside class="bcra-res"><h3>Situación en el BCRA</h3><p class="hint m0">No tiene deudas informadas en el sistema financiero${per ? ` (${esc(per)})` : ''}.</p></aside>`;
  }
  const filas = bancos.map((b) => `<tr><td>${esc(b.entidad)}</td><td><span class="sit sit-${Math.min(Number(b.situacion) || 0, 3)}">${esc(SITUACION[b.situacion] || b.situacion)}</span></td><td class="num">${esc(plata(b.monto))}</td></tr>`).join('');
  return `<aside class="bcra-res">
    <h3>Situación en el BCRA</h3>
    <div class="bcra-tabla"><table>
      <thead><tr><th>Entidad</th><th>Situación</th><th class="num">Deuda</th></tr></thead>
      <tbody>${filas}</tbody>
      <tfoot><tr><td colspan="2">Total · ${bancos.length === 1 ? '1 entidad' : `${bancos.length} entidades`}</td><td class="num">${esc(plata(B.deuda_total))}</td></tr></tfoot>
    </table></div>
    <p class="hint m0">Central de Deudores${per ? `, período ${esc(per)}` : ''}.</p>
  </aside>`;
}

function vistaCotizar() {
  const Y = S.yo;
  if (!Y.habilitado && !Y.miembro) return `<section class="card"><h2>El cotizador todavía no está habilitado</h2><p class="hint m0">Consultá con la Asociación Mutual Bell.</p></section>`;
  const aviso = Y.miembro ? `<p class="aviso suave m0 no-imprimir">Vista previa de la Mutual: probás el recorrido sin enviar nada.${Y.habilitado ? '' : ' Las agencias todavía no pueden usarlo.'}
      Las solicitudes, los parámetros y las agencias se manejan en <a href="../cobranzas/#agencias">Créditos y Cobros → Agencias</a>.</p>` : '';
  if (!S.bcra || !S.continuo) return aviso + vistaCliente();
  const c = S.cargando;
  const delModelo = aniosDelModelo();
  const anios = delModelo ? delModelo.map((a) => ({ id: a, nombre: etiquetaAnio(a) })) : null;
  const sinAnios = delModelo && S.versiones.length && !delModelo.length;
  const plazos = Y.plazos || [];
  const plazo = plazos.length > 6
    ? `<label class="f">Cuotas<select id="selPlazo">${plazos.map((n) => `<option value="${n}"${n === S.plazo ? ' selected' : ''}>${n} ${n === 1 ? 'cuota' : 'cuotas'}</option>`).join('')}</select></label>`
    : `<div class="f ancho">Plazo<div class="plazos" role="group" aria-label="Cantidad de cuotas">${plazos.map((n) => `<button type="button" data-plazo="${n}" aria-pressed="${n === S.plazo}">${n} cuotas</button>`).join('')}</div></div>`;
  const form = `<section class="card no-imprimir">
    <div class="card-cab"><h2>2 · El vehículo y el crédito</h2></div>
    <div class="grilla">
      ${selector('selMarca', 'Marca', S.marcas, S.marca, 'id', c === 'marcas', false)}
      ${selector('selModelo', 'Modelo', S.modelos, S.modelo, 'id', c === 'modelos', !S.marca)}
      ${selector('selAnio', 'Año', anios, S.anio, 'id', c === 'versiones', !S.modelo)}
      ${buscadorVersion()}
      ${sinAnios ? '<p class="aviso suave ancho m0">Este modelo no tiene años para financiar. Probá con otro.</p>' : ''}
      ${S.anio && S.versiones && !versionesDelAnio().length ? '<p class="aviso suave ancho m0">No hay versiones para ese año.</p>' : ''}
      ${S.modelos && !S.modelos.length ? '<p class="aviso suave ancho m0">Esta marca no tiene modelos para financiar.</p>' : ''}
      ${plazo}
      <label class="f">Monto solicitado<input id="inMonto" inputmode="numeric" autocomplete="off" value="${esc(S.monto)}"><small class="ayuda-monto">Si dejas este espacio vacío se hará la simulación por el máximo permitido</small></label>
      <p class="ancho m0"><strong>También tenés la posibilidad de indicar simplemente la cuota que puede pagar el cliente y nosotros calculamos el resto</strong></p>
      <label class="f">Cuota que quiere pagar (hasta)<input id="inCuotaMax" inputmode="numeric" autocomplete="off" value="${esc(S.cuotaMax)}"><small class="ayuda-monto">Opcional: te decimos hasta qué monto llega con esa cuota, en cada plazo</small></label>
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
    ${S.bcra?.sin_consulta ? '<p class="hint m0 no-imprimir">Sin consulta al BCRA no se puede continuar con la solicitud.</p>' : '<div class="acciones"><button class="btn primario" type="button" id="btnAvanzar">Continuar con la solicitud</button></div>'}
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

/** Lo que la Mutual necesita para aprobar el crédito (texto pedido por la persona, 20/11/2026). */
const REQUISITOS = `<p class="m0"><b>Recordá que para aprobar el crédito necesitamos estos archivos (PDF o fotos):</b></p>
  <ol class="requisitos">
    <li>Foto de DNI (ambos lados)</li>
    <li>Foto de un impuesto o servicio para constatar el domicilio</li>
    <li>A) En caso de ser empleado en relación de dependencia: últimos 6 recibos de sueldo.<br>
      B) En caso de ser monotributista: constancia de inscripción y últimos 3 pagos.<br>
      C) En caso de ser responsable inscripto: constancia de inscripción, últimas 3 DDJJ de IVA y Ganancias.</li>
    <li>Título del automotor</li>
  </ol>
  <p class="hint m0">Cada archivo puede pesar hasta 10 MB (las fotos se achican solas).</p>`;

/** Lista que tilda la propia agencia a medida que sube cada documento. No mira los archivos ni se guarda: es solo una ayuda para no olvidarse. */
const INGRESOS_LISTA = {
  dependencia: ['Recibos de sueldo'],
  monotributo: ['Constancia de inscripción', 'Últimos pagos del monotributo'],
  inscripto: ['Constancia de inscripción', 'Declaraciones juradas de IVA y Ganancias'],
};

function checklistArchivos(L) {
  const item = (k, texto) => { const ok = !!L.chk?.[k];
    return `<button class="chk-item" type="button" data-chk="${k}" aria-pressed="${ok}"><span class="chk" aria-hidden="true">${ok ? '✅' : '❌'}</span><span>${esc(texto)}</span></button>`; };
  const ingresos = (INGRESOS_LISTA[L.categoria] || []).map((t, i) => item(`ing${i}`, t)).join('');
  return `<div class="checklist"><p class="m0"><b>Checklist</b> <span class="hint">Tocá cada ítem cuando ya lo hayas subido. No impide enviar.</span></p>
    <div class="checklist-lista">${item('dni', 'DNI, ambos lados')}${item('servicio', 'Impuesto o servicio (domicilio)')}${ingresos}${item('titulo', 'Título del automotor')}</div></div>`;
}

/** Botones para sacar la foto de cada documento directamente con la cámara (en la compu abren el selector de archivos). */
function htmlCamara(xs) {
  const botones = TIPOS_FOTO.map((t) => {
    const n = xs.filter((x) => x.tipo === t.k).length;
    return `<label class="camara-btn ${n ? 'hecho' : ''}"><span class="camara-ico" aria-hidden="true">${n ? '✅' : '📷'}</span><span>${esc(t.t)}${n > 1 ? ` (${n})` : ''}</span><input class="oculto" type="file" accept="image/*" capture="environment" data-camara="${t.k}" aria-label="Sacar foto: ${esc(t.t)}"></label>`;
  }).join('');
  return `<div class="camara"><p class="m0"><b>Sacar fotos con la cámara</b> <span class="hint">Tocá el documento, sacale la foto y queda cargada. Podés repetir el mismo para sumar más (por ejemplo, varios recibos).</span></p>
    <div class="camara-grid">${botones}</div>
    <p class="hint m0">Para que se lea bien: apoyá el documento sobre una mesa lisa, con buena luz y sin sombras, y que se vean los cuatro bordes.</p></div>`;
}

/** El recuadro donde la agencia suelta o elige todos los archivos juntos. */
function casillero(slot) {
  const L = S.sol, d = DOCS[slot], xs = L.docs[slot] || [];
  const lleno = xs.length >= d.max;
  const etq = xs.length ? `<span class="etq ok">${xs.length} ${xs.length === 1 ? 'archivo' : 'archivos'}</span>` : '<span class="etq">Sin adjuntar</span>';
  return `<div class="doc" id="doc-${slot}">
    <div class="card-cab"><b>${esc(d.titulo)}</b>${etq}</div>
    ${lleno || L.enviando ? '' : htmlCamara(xs)}
    ${lleno || L.enviando ? '' : `<label class="canasta" data-canasta="${slot}"><span class="canasta-t">Arrastrá los archivos acá</span><span class="hint">o tocá para elegirlos (podés elegir varios de una vez)</span><input class="oculto" type="file" accept="application/pdf,image/*" multiple data-slot="${slot}"></label>`}
    ${lleno ? `<p class="hint m0">Llegaste al máximo de ${d.max} archivos.</p>` : ''}
    ${xs.length ? `<ul class="doc-lista">${xs.map((x, i) => `<li><span class="doc-nombre">${esc(x.nombre)}</span><span class="hint">${tamano(x.file.size)}</span><button class="btn chico" type="button" data-quitar="${slot}" data-i="${i}" ${L.enviando ? 'disabled' : ''}>Quitar</button></li>`).join('')}</ul>` : ''}
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
  html += `<section class="card no-imprimir"><h2>4 · Documentación</h2>
    <div class="requisitos-caja">${REQUISITOS}</div>
    ${casillero('documentacion')}
    ${checklistArchivos(L)}
  </section>
  <section class="card no-imprimir" id="pasoDatos"><h2>5 · Datos del cliente</h2>
    <div class="bloque"><label class="f">Empleo, profesión o actividad (opcional)<input data-campo="actividad" autocomplete="off" maxlength="200" placeholder="Ej.: empleado de comercio en Supermercado X; docente; productor agropecuario" value="${v('actividad')}"></label></div>
    <div class="bloque"><label class="f">DNI<input data-campo="dni" inputmode="numeric" autocomplete="off" maxlength="12" value="${v('dni')}"></label>
      ${dniCuit && dni && dni !== dniCuit ? '<p class="aviso suave m0">No coincide con el CUIL que se consultó en el BCRA.</p>' : ''}</div>
    <div class="bloque"><div class="f">Vehículo cotizado<div class="dato">${esc(r.vehiculo)} · ${esc(etiquetaAnio(r.anio))}</div></div></div>
    <div class="bloque"><div class="grilla">
      <label class="f">Nacionalidad<input data-campo="nacionalidad" autocomplete="off" maxlength="80" placeholder="Ej.: Argentina" value="${v('nacionalidad')}"></label>
      <label class="f">Fecha de nacimiento<input data-campo="nacimiento" type="date" max="${hoy()}" value="${v('nacimiento')}"></label></div></div>
    <div class="bloque"><p class="hint m0"><b>Domicilio real</b></p><div class="grilla">
      <label class="f">Calle<input data-campo="dom_calle" autocomplete="off" maxlength="120" value="${v('dom_calle')}"></label>
      <label class="f">Número<input data-campo="dom_numero" autocomplete="off" maxlength="12" placeholder="o S/N" value="${v('dom_numero')}"></label>
      <label class="f">Piso (opcional)<input data-campo="dom_piso" autocomplete="off" maxlength="12" value="${v('dom_piso')}"></label>
      <label class="f">Depto. (opcional)<input data-campo="dom_depto" autocomplete="off" maxlength="12" value="${v('dom_depto')}"></label>
      <label class="f">Código postal (opcional)<input data-campo="dom_cp" autocomplete="off" maxlength="10" value="${v('dom_cp')}"></label>
      <label class="f">Localidad<input data-campo="dom_localidad" autocomplete="off" maxlength="100" value="${v('dom_localidad')}"></label>
      <label class="f">Departamento (opcional)<input data-campo="dom_departamento" autocomplete="off" maxlength="100" value="${v('dom_departamento')}"></label>
      <label class="f">Provincia<input data-campo="dom_provincia" autocomplete="off" maxlength="100" value="${v('dom_provincia')}"></label></div></div>
    <div class="bloque"><div class="f">Estado civil<div class="opciones2" role="radiogroup" aria-label="Estado civil">
        <button type="button" role="radio" data-civil="soltero" aria-checked="${L.estado_civil === 'soltero'}">Soltero/a</button>
        <button type="button" role="radio" data-civil="casado" aria-checked="${L.estado_civil === 'casado'}">Casado/a</button></div></div>
      ${L.estado_civil === 'casado' ? `<div class="grilla">
        <label class="f">Lugar del matrimonio<input data-campo="matrimonio_lugar" autocomplete="off" maxlength="200" value="${v('matrimonio_lugar')}"></label>
        <label class="f">Fecha del matrimonio<input data-campo="matrimonio_fecha" type="date" max="${hoy()}" value="${v('matrimonio_fecha')}"></label></div>
      <p class="hint m0"><b>Datos del cónyuge</b></p>
      <div class="grilla">
        <label class="f">Apellido y nombre<input data-campo="conyuge_nombre" autocomplete="off" maxlength="200" value="${v('conyuge_nombre')}"></label>
        <label class="f">DNI<input data-campo="conyuge_dni" inputmode="numeric" autocomplete="off" maxlength="10" value="${v('conyuge_dni')}"></label>
        <label class="f">Nacionalidad<input data-campo="conyuge_nacionalidad" autocomplete="off" maxlength="80" value="${v('conyuge_nacionalidad')}"></label>
        <label class="f">Fecha de nacimiento<input data-campo="conyuge_nacimiento" type="date" max="${hoy()}" value="${v('conyuge_nacimiento')}"></label>
        <label class="f ancho">Domicilio<input data-campo="conyuge_domicilio" autocomplete="off" maxlength="300" value="${v('conyuge_domicilio')}"></label></div>` : ''}</div>
    <div class="bloque"><label class="f">Celular, con característica<input data-campo="celular" type="tel" inputmode="tel" autocomplete="off" maxlength="25" placeholder="Ej.: 3534 123456" value="${v('celular')}"></label></div>
    <div class="bloque"><label class="f">CBU o CVU donde se deposita el crédito (opcional)<input data-campo="cbu" inputmode="numeric" autocomplete="off" maxlength="30" value="${v('cbu')}"></label>
      <label class="f">O, si no lo tenés a mano, el alias de la cuenta (opcional)<input data-campo="alias" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="20" placeholder="Ej.: juan.perez.mp" value="${v('alias')}"></label>
      <div class="f">¿De quién es la cuenta?<div class="opciones2" role="radiogroup" aria-label="Titular de la cuenta">
        <button type="button" role="radio" data-cuenta="propia" aria-checked="${L.cuenta === 'propia'}">Cuenta propia</button>
        <button type="button" role="radio" data-cuenta="terceros" aria-checked="${L.cuenta === 'terceros'}">De un tercero</button></div></div>
      ${L.cuenta === 'terceros' ? `<div class="grilla">
        <label class="f">Titular de la cuenta (nombre o razón social)<input data-campo="cuenta_titular" autocomplete="off" maxlength="200" value="${v('cuenta_titular')}"></label>
        <label class="f">CUIT o CUIL del titular<input data-campo="cuenta_cuit" inputmode="numeric" autocomplete="off" maxlength="20" value="${v('cuenta_cuit')}"></label>
        <label class="f ancho">Relación con el cliente (opcional)<input data-campo="cuenta_relacion" autocomplete="off" maxlength="120" placeholder="Ej.: agencia vendedora, cónyuge" value="${v('cuenta_relacion')}"></label></div>` : ''}
      ${L.cuenta === 'terceros' ? '<p class="hint m0">Si la cuenta es de un tercero, sumá a los archivos una constancia que muestre el CBU o alias y quién es el titular.</p>' : ''}</div>
    <label class="check"><input type="checkbox" id="chkConformidad" ${L.conformidad ? 'checked' : ''}> El cliente está de acuerdo con enviar estos datos y documentos a la Asociación Mutual Bell para que evalúe el crédito.</label>
    ${sinAdjuntar().length ? '<p class="hint m0">No adjuntaste ningún archivo. Podés enviar la solicitud igual y mandar los documentos a la Mutual por otra vía.</p>' : ''}
    ${L.errores.length ? `<div class="aviso m0" role="alert" id="erroresSol"><b>Antes de enviar, falta:</b><ul>${L.errores.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
    ${L.error ? `<p class="aviso m0" role="alert">${esc(L.error)}</p>` : ''}
    ${L.preparando ? '<p class="hint m0">Preparando las fotos…</p>' : ''}
    ${S.yo.miembro ? '<p class="hint m0">Vista previa de la Mutual: la agencia ve acá el botón «Enviar solicitud a la Mutual».</p>'
      : `<div class="acciones"><button class="btn primario" type="button" id="btnEnviarSol" ${L.enviando || L.preparando ? 'disabled' : ''}>${L.enviando ? esc(L.progreso || 'Enviando…') : 'Enviar solicitud a la Mutual'}</button></div>`}
  </section>`;
  return html;
}

// Lo que sale en papel: solo la simulación hecha, con una introducción y un cierre breves (pedido de la persona, 19/11/2026).
// En pantalla no se ve; styles.css lo muestra al imprimir y esconde el resto del resultado.
function hojaImprimir(r, vehiculo) {
  // Diseño (pedido de la persona, 19/11/2026): el escudo arriba, con la foto del vehículo al lado si la hay, letras con estilo
  // (Cinzel y EB Garamond, que ya trae la app) y el nombre de la Mutual en cursiva al pie. Sin franjas ni imagen de fondo.
  const foto = vehiculo ? `<figure class="hoja-foto" id="hojaFoto">${S.foto?.ref === S.version && S.foto.src ? `<img src="${S.foto.src}" alt="">` : ''}</figure>` : '';
  return `<div class="hoja-imprimir">
    <div class="hoja-cuerpo">
      <div class="hoja-cabeza"><img class="hoja-escudo" src="logo.svg" alt="" width="84" height="84">${foto}</div>
      <p class="hoja-titulo">Simulación de crédito prendario</p>
      <div class="hoja-adorno" aria-hidden="true"><i></i><b></b><i></i></div>
      ${vehiculo ? `<p class="hoja-vehiculo">${esc(vehiculo)}</p>` : ''}
      <div class="hoja-monto">
        <span class="hoja-rotulo">Crédito de</span>
        <span class="hoja-cifra">${plata(r.monto)}</span>
        <span class="hoja-plan">en <b>${r.cuotas} ${r.cuotas === 1 ? 'cuota' : 'cuotas'}</b> de <b>${plata(r.cuota)}</b></span>
      </div>
      <div class="hoja-adorno" aria-hidden="true"><i></i><b></b><i></i></div>
      <p class="hoja-gracias">Gracias por pensar en nosotros para la compra de tu próximo auto.<br>Quedamos a tu disposición para más consultas.</p>
    </div>
    <p class="hoja-firma">Asociación Mutual Bell</p>
  </div>`;
}

// La hoja está oculta en pantalla, así que el navegador no bajó sus tipografías: se piden antes de imprimir
// (si no llegan a tiempo, se imprime igual con las de reemplazo).
async function imprimir() {
  try {
    await Promise.race([
      Promise.all(['400 20px "Cinzel"', 'italic 400 20px "EB Garamond"', '400 20px "EB Garamond"', '700 20px "EB Garamond"'].map((f) => document.fonts.load(f))),
      new Promise((ok) => setTimeout(ok, 2500)),
    ]);
  } catch { /* se imprime con lo que haya */ }
  window.print();
}

/** Las filas de la tabla «cuota de hasta $X»: en cada plazo, hasta qué monto llega. */
function opcionesPorCuota(r) {
  return opcionesVisibles(r).map((o) => `<tr class="${o.cuotas === r.cuotas ? 'elegido' : ''}"><td>${o.cuotas} ${o.cuotas === 1 ? 'cuota' : 'cuotas'}</td><td class="num">${plata(o.monto)}</td><td class="num">${plata(o.cuota)}</td></tr>`).join('');
}

/** Lo que explica de dónde sale el monto: la cuota pedida (cuentas con lo que escribió la agencia). */
function avisosDeMonto(r) {
  const xs = [];
  if (r.cuota_max && r.pidio && r.monto < r.pidio) xs.push(`Con una cuota de hasta ${plata(r.cuota_max)} en ${r.cuotas} cuotas se llega a ${plata(r.monto)}: faltan ${plata(r.pidio - r.monto)} del monto pedido. Probá con más cuotas.`);
  else if (!r.cuota_max && r.pidio && r.monto < r.pidio) xs.push(`Pediste ${plata(r.pidio)}, pero la Mutual financia hasta ${plata(r.monto)}.`);
  return xs.map((x) => `<p class="aviso suave m0 no-imprimir">${esc(x)}</p>`).join('');
}

function vistaResultado(r) {
  if (!r.financiable) return `<section class="card resultado" id="resultado"><h2>No se puede financiar</h2><p class="m0">${esc(r.mensaje || 'Este vehículo no alcanza las condiciones del crédito.')}</p></section>`;
  const opciones = opcionesVisibles(r).map((o) => `<tr class="${o.cuotas === r.cuotas ? 'elegido' : ''}"><td>${o.cuotas} ${o.cuotas === 1 ? 'cuota' : 'cuotas'}</td><td class="num">${plata(o.cuota)}</td></tr>`).join('');
  return `<section class="card resultado" id="resultado">
    <div class="vehiculo-cab">
      <figure class="figura" id="fotoVehiculo">${S.foto?.ref === S.version && S.foto.src ? `<img src="${S.foto.src}" alt="Foto del vehículo">` : ''}</figure>
      <div class="card-cab"><h2>${esc(r.vehiculo)}</h2><span class="etq">${esc(etiquetaAnio(r.anio))}</span></div>
    </div>
    <div class="destacado"><span class="titulo">Monto máximo que financia la Mutual</span><span class="cifra">${plata(r.maximo)}</span></div>
    ${r.valor_vehiculo ? `<p class="no-imprimir m0"><b>Valor del vehículo (solo lo ves vos):</b> ${plata(r.valor_vehiculo)}</p>` : ''}
    <div class="cuota-grande">Crédito de <b>${plata(r.monto)}</b> en ${r.cuotas} ${r.cuotas === 1 ? 'cuota' : 'cuotas'} de <b>${plata(r.cuota)}</b></div>
    ${avisosDeMonto(r)}
    <table><tbody>
      <tr><td>Total a pagar</td><td class="num">${plata(r.total)}</td></tr>
      <tr><td>Gastos de otorgamiento (incluidos en las cuotas)</td><td class="num">${plata(r.gastos_otorgamiento)}</td></tr>
    </tbody></table>
    ${r.cuota_max
      ? `<div class="scroll"><table><thead><tr><th>Con una cuota de hasta ${plata(r.cuota_max)}</th><th class="num">Monto</th><th class="num">Cuota</th></tr></thead><tbody>${opcionesPorCuota(r)}</tbody></table></div>`
      : `<div class="scroll"><table><thead><tr><th>Otros plazos con este monto</th><th class="num">Cuota</th></tr></thead><tbody>${opciones}</tbody></table></div>`}
    <p class="leyenda tasas m0">No incluye IVA. ${esc(r.leyenda || '')}</p>
    ${r.contacto ? `<p class="leyenda m0">${esc(r.contacto)}</p>` : ''}
    ${hojaImprimir(r, `${r.vehiculo} · ${etiquetaAnio(r.anio)}`)}
    <div class="acciones no-imprimir">
      <button class="btn" type="button" id="btnWhatsapp">Enviar al cliente por WhatsApp</button>
      <button class="btn" type="button" id="btnImprimir">Imprimir</button>
    </div>
    ${vistaAvanzar()}
  </section>`;
}

// La agencia ve «Recibida» donde la Mutual tiene `pendiente`: lo primero que pasa es que le llega.
const ESTADOS = { pendiente: ['Recibida', ''], en_analisis: ['En análisis', 'rev'], aprobada: ['Aprobada', 'ok'], rechazada: ['Rechazada', 'no'] };
const DICE_ESTADO = { pendiente: 'La Mutual recibió la solicitud.', en_analisis: 'La Mutual la está analizando.' };

// ───────────────────────── Novedades de «Mis solicitudes» ─────────────────────────
// Un número en la solapa avisa cuando una solicitud cambió de estado desde la última vez que la agencia la miró.
// Lo recordado vive en este dispositivo (id → estado visto): es una comodidad, no un dato que importe guardar.
const VISTAS = 'agencias.vistas';
const leerVistas = () => { try { return JSON.parse(localStorage.getItem(VISTAS) || '{}') || {}; } catch { return {}; } };
const guardarVistas = (m) => { try { localStorage.setItem(VISTAS, JSON.stringify(m)); } catch { /* sin almacenamiento: no hay avisos, nada más */ } };
/** Las solicitudes que cambiaron de estado desde que se miraron (una recién enviada, en «Recibida», no cuenta). */
const conNovedad = (xs, vistas = leerVistas()) => (xs || []).filter((x) => x.estado !== 'pendiente' && vistas[x.id] !== x.estado);
const rotuloSolicitudes = () => { const n = conNovedad(S.sols).length; return `Mis solicitudes${n ? ` (${n})` : ''}`; };
function marcarVistas() {
  const m = leerVistas();
  for (const x of S.sols || []) m[x.id] = x.estado;
  guardarVistas(m);
}
/** Mira en silencio si hay novedades y cambia solo el rótulo de la solapa, sin volver a dibujar lo que se está escribiendo. */
async function mirarNovedades() {
  if (S.fase !== 'app' || !S.yo?.habilitado || S.yo.miembro || S.vista === 'solicitudes') return;
  try { S.sols = (await fn({ accion: 'solicitudes' })).solicitudes || []; } catch { return; }
  const b = document.querySelector('[data-vista="solicitudes"]');
  if (b) b.textContent = rotuloSolicitudes();
}
setInterval(mirarNovedades, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') mirarNovedades(); });
const etqEstado = (e) => { const [t, c] = ESTADOS[e] || [e, '']; return `<span class="etq ${c}">${esc(t)}</span>`; };

/** «Mis cotizaciones»: las últimas 50 del vendedor, para reenviarlas. Es lo que se calculó ese día: no se recalcula. */
function vistaHistorial() {
  if (!S.cots) return '<section class="card"><p class="hint m0">Cargando…</p></section>';
  if (!S.cots.length) return '<section class="card"><h2>Mis cotizaciones</h2><p class="hint m0">Todavía no hiciste cotizaciones. Aparecen acá apenas cotices un vehículo.</p></section>';
  return `<section class="card"><h2>Mis cotizaciones</h2><p class="hint">Las últimas 50. Son las condiciones de ese día: si querés una actual, cotizá de nuevo.</p>
    ${S.elimTodas ? '<span class="aviso suave m0">Se sacan todas las cotizaciones de tu lista. Tocá de nuevo para confirmarlo.</span>' : ''}
    <div class="acciones">
      <button class="btn chico" type="button" data-elimtodas>${S.elimTodas ? 'Sí, eliminar todas' : 'Eliminar todas'}</button>
      ${S.elimTodas ? '<button class="btn chico" type="button" data-elimtodas-no>Cancelar</button>' : ''}
    </div>${S.cots.map((x) => `<div class="sol">
      <div class="card-cab"><b>${esc(x.vehiculo || 'Vehículo')}</b> <span class="hint">${esc(etiquetaAnio(x.anio))}</span></div>
      <div class="hint">${esc(fechaHora(x.momento))}${x.cuit ? ` · <span class="mono">${esc(cuitLindo(x.cuit))}</span>` : ''}</div>
      <div class="mono">${plata(x.monto)} · ${x.cuotas} × ${plata(x.cuota)}</div>
      ${S.elimCot === String(x.id) ? '<span class="aviso suave m0">Se saca de tu lista. Tocá de nuevo para confirmarlo.</span>' : ''}
      <div class="acciones">
        <button class="btn chico" type="button" data-wacot="${esc(String(x.id))}">Mandar por WhatsApp</button>
        <button class="btn chico" type="button" data-elimcot="${esc(String(x.id))}">${S.elimCot === String(x.id) ? 'Sí, eliminar' : 'Eliminar'}</button>
        ${S.elimCot === String(x.id) ? '<button class="btn chico" type="button" data-elimcot-no>Cancelar</button>' : ''}
      </div>
    </div>`).join('')}</section>`;
}

/** Saca una cotización de la lista (con segundo toque). Es solo del historial: el cálculo ya hecho no cambia. */
async function eliminarCotizacion(id) {
  if (S.elimCot !== id) { S.elimCot = id; S.elimTodas = false; render(); return; }
  S.elimCot = '';
  try {
    await fn({ accion: 'cotizacion_eliminar', id: Number(id) });
    S.cots = (S.cots || []).filter((c) => String(c.id) !== id);
  } catch (e) { falla(e); return; }
  render();
}

/** Saca todas las cotizaciones de la lista (con segundo toque). La función, sin `id`, oculta todas las del vendedor, no solo las 50 que se ven. */
async function eliminarTodasCotizaciones() {
  if (!S.elimTodas) { S.elimTodas = true; S.elimCot = ''; render(); return; }
  S.elimTodas = false;
  try {
    await fn({ accion: 'cotizacion_eliminar' });
    S.cots = [];
  } catch (e) { falla(e); return; }
  render();
}

// ───────────────────────── «Ver mi solicitud» ─────────────────────────
// El detalle de lo que la agencia mandó: lo pide a la función (`solicitud`), que no devuelve el % del valor del vehículo
// ni enlaces a los archivos; de estos solo se ven el nombre y el tamaño.
const ESTADO_CIVIL = { soltero: 'Soltero/a', casado: 'Casado/a', divorciado: 'Divorciado/a', viudo: 'Viudo/a', separado: 'Separado/a', conviviente: 'Conviviente' };
const fechaLinda = (f) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(f || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(f || ''); };
const tamanoLindo = (b) => { const n = Number(b) || 0; return n >= 1048576 ? `${(n / 1048576).toLocaleString('es-AR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; };

async function verSolicitud(id) {
  S.det = { id, cargando: true }; render();
  try { S.det = { id, sol: (await fn({ accion: 'solicitud', id })).solicitud }; } catch (e) { S.det = null; falla(e); render(); return; }
  render();
  window.scrollTo({ top: 0 });
}

function vistaDetalle() {
  const D = S.det;
  const volver = '<button class="btn chico no-imprimir" type="button" id="btnVolverSol">← Volver a mis solicitudes</button>';
  if (D.cargando) return `<section class="card">${volver}<p class="hint m0">Cargando…</p></section>`;
  const x = D.sol, d = x.datos || {};
  const fila = (r, v) => (v === undefined || v === null || String(v).trim() === '' ? '' : `<div class="dato"><span class="hint">${esc(r)}</span><span>${esc(String(v))}</span></div>`);
  const bloque = (t, filas) => (filas.join('') ? `<div class="sol-bloque"><h3>${esc(t)}</h3>${filas.join('')}</div>` : '');
  const archivos = Array.isArray(x.archivos) ? x.archivos : [];
  const cuenta = d.cuenta === 'terceros' ? 'De un tercero' : d.cuenta === 'propia' ? 'Propia' : '';
  return `<section class="card">${volver}
    <div class="card-cab"><h2 class="m0">Mi solicitud</h2>${etqEstado(x.estado)}</div>
    ${DICE_ESTADO[x.estado] ? `<div class="hint">${esc(DICE_ESTADO[x.estado])}</div>` : ''}
    ${x.nota ? `<p class="m0">Respuesta de la Mutual: ${esc(x.nota)}</p>` : ''}
    <div class="hint">Enviada el ${esc(fechaHora(x.momento))}</div>
    ${bloque('Cliente', [fila('Nombre', x.denominacion), fila('CUIT', cuitLindo(x.cuit)), fila('DNI', d.dni), fila('Celular', d.celular), fila('Empleo o actividad', d.actividad),
      fila('Nacionalidad', d.nacionalidad), fila('Fecha de nacimiento', fechaLinda(d.nacimiento)), fila('Domicilio', d.domicilio), fila('Estado civil', ESTADO_CIVIL[d.estado_civil] || d.estado_civil)])}
    ${d.estado_civil === 'casado' ? bloque('Matrimonio y cónyuge', [fila('Lugar del matrimonio', d.matrimonio_lugar), fila('Fecha del matrimonio', fechaLinda(d.matrimonio_fecha)), fila('Cónyuge', d.conyuge_nombre),
      fila('DNI del cónyuge', d.conyuge_dni), fila('Nacionalidad del cónyuge', d.conyuge_nacionalidad), fila('Nacimiento del cónyuge', fechaLinda(d.conyuge_nacimiento)), fila('Domicilio del cónyuge', d.conyuge_domicilio)]) : ''}
    ${bloque('Crédito', [fila('Vehículo', x.vehiculo ? `${x.vehiculo} (${etiquetaAnio(x.anio)})` : ''), fila('Monto', plata(x.monto)), fila('Cuotas', `${x.cuotas} × ${plata(x.cuota)}`),
      fila('Total a pagar', plata(x.total)), fila('Tasa mensual', pct(x.tasa))])}
    ${bloque('Ingresos', [fila('Cómo los obtiene', CATEGORIAS[x.categoria] || x.categoria), fila('Ingreso mensual declarado', x.ingreso ? plata(x.ingreso) : ''), fila('La cuota es el', x.relacion ? pct(x.relacion) + ' del ingreso' : '')])}
    ${bloque('Cuenta para el desembolso', [fila('CBU o CVU', d.cbu), fila('Alias', d.alias), fila('La cuenta es', cuenta), fila('Titular', d.cuenta_titular), fila('CUIT o CUIL del titular', d.cuenta_cuit ? cuitLindo(String(d.cuenta_cuit)) : ''), fila('Relación con el cliente', d.cuenta_relacion)])}
    <div class="sol-bloque"><h3>Documentación enviada</h3>${archivos.length
    ? `<ul class="m0">${archivos.map((a) => `<li>${esc(a.nombre || 'Archivo')} <span class="hint">${esc(tamanoLindo(a.tamano))}</span></li>`).join('')}</ul>`
    : '<p class="hint m0">No se adjuntaron archivos con esta solicitud.</p>'}</div>
  </section>`;
}

/** «Mis solicitudes», para la agencia. */
function vistaSolicitudes() {
  if (S.det) return vistaDetalle();
  if (!S.sols) return '<section class="card"><p class="hint m0">Cargando…</p></section>';
  if (!S.sols.length) return '<section class="card"><h2>Mis solicitudes</h2><p class="hint m0">Todavía no mandaste solicitudes. Se envían desde «Cotizar», después de ver el crédito.</p></section>';
  return `<section class="card"><h2>Mis solicitudes</h2>${S.sols.map((x) => `<div class="sol">
      <div class="card-cab"><b>${esc(x.denominacion || cuitLindo(x.cuit))}</b>${etqEstado(x.estado)}</div>
      ${DICE_ESTADO[x.estado] ? `<div class="hint">${esc(DICE_ESTADO[x.estado])}${S.novedades?.has(x.id) ? ' <b>Novedad</b>' : ''}</div>` : S.novedades?.has(x.id) ? '<div class="hint"><b>Novedad</b></div>' : ''}
      <div class="acciones no-imprimir"><button class="btn chico" type="button" data-versol="${esc(x.id)}">Ver mi solicitud</button></div>
      <div class="hint">${esc(fechaHora(x.momento))} · <span class="mono">${esc(cuitLindo(x.cuit))}</span>${['amarillo', 'sin_datos'].includes(x.semaforo) ? ' · sujeta a revisión' : ''}</div>
      <div>${esc(x.vehiculo)} <span class="hint">${esc(etiquetaAnio(x.anio))}</span></div>
      <div class="mono">${plata(x.monto)} · ${x.cuotas} × ${plata(x.cuota)}</div>
      ${x.nota ? `<p class="m0">Respuesta de la Mutual: ${esc(x.nota)}</p>` : ''}
    </div>`).join('')}</section>`;
}

function render() {
  const der = $('#cabDer');
  if (S.fase === 'app' || S.fase === 'clave' || S.fase === 'sinacceso') {
    der.innerHTML = `${S.yo ? `<span class="quien">${esc(S.yo.agencia)}${S.yo.vendedor && !S.yo.titular ? ` · ${esc(S.yo.vendedor)}` : ''}</span>` : ''}<button class="btn chico" type="button" id="btnSalir">Salir</button>`;
  } else der.innerHTML = '';
  const m = $('#main');
  if (S.fase === 'cargando') m.innerHTML = '<p class="hint">Abriendo el cotizador…</p>';
  else if (S.fase === 'ingreso') m.innerHTML = vistaIngreso();
  else if (S.fase === 'clave') m.innerHTML = vistaClave();
  else if (S.fase === 'sinacceso') m.innerHTML = '<section class="card ingreso"><h2>Esta cuenta no está habilitada</h2><p class="hint m0">Consultá con la Asociación Mutual Bell.</p></section>';
  else {
    const rapida = S.yo.rapida && !S.yo.miembro;
    const tabs = S.yo.habilitado && !S.yo.miembro ? `<nav class="tabs no-imprimir" role="tablist"><button role="tab" data-vista="cotizar" aria-selected="${S.vista === 'cotizar'}">Cotizar</button>${rapida ? `<button role="tab" data-vista="rapida" aria-selected="${S.vista === 'rapida'}">Simulación rápida</button>` : ''}<button role="tab" data-vista="historial" aria-selected="${S.vista === 'historial'}">Mis cotizaciones</button><button role="tab" data-vista="solicitudes" aria-selected="${S.vista === 'solicitudes'}">${esc(rotuloSolicitudes())}</button></nav>` : '';
    m.innerHTML = tabs + (S.vista === 'solicitudes' && !S.yo.miembro ? vistaSolicitudes() : S.vista === 'historial' && !S.yo.miembro ? vistaHistorial() : S.vista === 'rapida' && rapida ? vistaRapida() : vistaCotizar());
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
});

// Arrastrar los archivos al recuadro (en la compu; en el celular se toca y se eligen de la galería).
const canastaDe = (e) => e.target.closest?.('[data-canasta]');
document.addEventListener('dragover', (e) => { const c = canastaDe(e); if (!c) return; e.preventDefault(); c.classList.add('encima'); });
document.addEventListener('dragleave', (e) => { canastaDe(e)?.classList.remove('encima'); });
document.addEventListener('drop', (e) => {
  const c = canastaDe(e);
  if (!c) return;
  e.preventDefault(); c.classList.remove('encima');
  if (e.dataTransfer?.files?.length) agregarArchivos(c.dataset.canasta, [...e.dataTransfer.files]);
});
// Soltar un archivo fuera del recuadro no tiene que abrirlo en la pantalla y perder lo cargado.
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => { if (e.dataTransfer?.types?.includes('Files') && !canastaDe(e)) e.preventDefault(); });

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'selMarca') elegirMarca(t.value);
  else if (t.id === 'selModelo') elegirModelo(t.value);
  else if (t.id === 'selAnio') elegirAnio(t.value);
  else if (t.id === 'selPlazo') { S.plazo = Number(t.value); if (S.res) cotizar(); }
  else if (t.dataset.camara && t.files?.length) { const xs = [...t.files]; t.value = ''; agregarFoto(t.dataset.camara, xs); }
  else if (t.dataset.slot && t.files?.length) { const xs = [...t.files]; t.value = ''; agregarArchivos(t.dataset.slot, xs); }
  else if (t.id === 'chkConformidad') S.sol.conformidad = t.checked;
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'inMonto') {
    const n = soloNumero(t.value);
    S.monto = n ? n.toLocaleString('es-AR') : '';
    if (t.value !== S.monto) { t.value = S.monto; }
  } else if (t.id === 'inCuotaMax') {
    const n = soloNumero(t.value);
    S.cuotaMax = n ? n.toLocaleString('es-AR') : '';
    if (t.value !== S.cuotaMax) t.value = S.cuotaMax;
  } else if (t.id === 'inVersion') {
    // Se escribe para buscar: si había una versión elegida, deja de estarlo. Solo se redibuja la lista (no se pierde el teclado).
    S.buscaVer = t.value;
    if (S.version) { S.version = ''; S.anios = null; S.res = null; const b = $('#btnCotizar'); if (b) b.disabled = true; quitarDespues(t.closest('section')); }
    abrirLista(t.value);
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
  else if (t.dataset.rap && S.rap) {
    const k = t.dataset.rap;
    if (k.startsWith('g.')) S.rap.g[k.slice(2)] = t.value;
    else if (k === 'capital') { const n = soloNumero(t.value); S.rap.capital = n ? n.toLocaleString('es-AR') : ''; if (t.value !== S.rap.capital) t.value = S.rap.capital; }
    else S.rap[k] = t.value;
  }
});

// La lista de versiones: se abre al entrar al campo (completa, para mirar) y se cierra al tocar afuera.
document.addEventListener('focusin', (e) => {
  if (e.target.id === 'inVersion') { e.target.select(); abrirLista(S.version ? '' : e.target.value); }
});
document.addEventListener('toggle', (e) => { if (e.target.id === 'rapOtros' && S.rap) S.rap.otros = e.target.open; }, true);
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.combo')) cerrarLista();
  else if (e.target.closest('#listaVersiones')) e.preventDefault(); // que el campo no pierda el foco antes del toque
});
document.addEventListener('keydown', (e) => {
  if (e.target.id !== 'inVersion') return;
  if (e.key === 'Escape') cerrarLista();
  else if (e.key === 'Enter') { // Enter elige la primera de la lista
    e.preventDefault();
    const b = $('#listaVersiones [data-ver]');
    if (b) elegirVersion(b.dataset.ver);
  } else if (e.key === 'ArrowDown') { e.preventDefault(); abrirLista(e.target.value); $('#listaVersiones [data-ver]')?.focus(); }
});
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t.dataset?.ver) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); t.nextElementSibling?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); (t.previousElementSibling || $('#inVersion'))?.focus(); }
  else if (e.key === 'Escape') { cerrarLista(); $('#inVersion')?.focus(); }
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.ver) { elegirVersion(t.dataset.ver); return; }
  if (t.id === 'btnSalir') salir();
  else if (t.id === 'btnCotizar') cotizar();
  else if (t.dataset.plazo) { S.plazo = Number(t.dataset.plazo); if (S.res) cotizar(); else render(); }
  else if (t.id === 'btnWhatsapp' && S.res) window.open(`https://wa.me/?text=${encodeURIComponent(textoParaComprador(S.res))}`, '_blank', 'noopener');
  else if (t.id === 'btnImprimir') imprimir();
  else if (t.id === 'btnOtroCliente') otroCliente();
  else if (t.id === 'btnContinuar') { S.continuo = true; render(); }
  else if (t.id === 'btnAvanzar') abrirSolicitud();
  else if (t.dataset.ingresos) { S.sol.ingresos = t.dataset.ingresos === 'si'; render(); if (S.sol.ingresos) $('#inIngreso')?.focus(); }
  else if (t.dataset.categoria) { S.sol.categoria = t.dataset.categoria; render(); }
  else if (t.dataset.civil) { S.sol.estado_civil = t.dataset.civil; render(); }
  else if (t.dataset.cuenta) { S.sol.cuenta = t.dataset.cuenta; render(); }
  else if (t.dataset.chk) { S.sol.chk[t.dataset.chk] = !S.sol.chk[t.dataset.chk]; render(); }
  else if (t.dataset.quitar) quitarArchivo(t.dataset.quitar, Number(t.dataset.i));
  else if (t.id === 'btnEnviarSol') enviarSolicitud();
  else if (t.dataset.wacot) { const x = S.cots?.find((c) => String(c.id) === t.dataset.wacot); if (x) window.open(`https://wa.me/?text=${encodeURIComponent(textoParaComprador(x))}`, '_blank', 'noopener'); }
  else if (t.dataset.elimcot) eliminarCotizacion(t.dataset.elimcot);
  else if (t.hasAttribute('data-elimcot-no')) { S.elimCot = ''; render(); }
  else if (t.hasAttribute('data-elimtodas')) eliminarTodasCotizaciones();
  else if (t.hasAttribute('data-elimtodas-no')) { S.elimTodas = false; render(); }
  else if (t.id === 'btnRapida') simularRapida();
  else if (t.id === 'btnRapidaReset') { S.rap = { ...nuevaRapida(), capital: S.rap?.capital || '', cuotas: S.rap?.cuotas || nuevaRapida().cuotas }; render(); }
  else if (t.id === 'btnWhatsappRapida' && S.rap?.res) window.open(`https://wa.me/?text=${encodeURIComponent(textoRapida(S.rap.res))}`, '_blank', 'noopener');

  else if (t.dataset.versol) verSolicitud(t.dataset.versol);
  else if (t.id === 'btnVolverSol') { S.det = null; render(); }
  else if (t.dataset.vista) { S.vista = t.dataset.vista; S.det = null; if (S.vista === 'solicitudes') cargarSolicitudes(); else if (S.vista === 'historial') cargarCotizaciones(); else render(); }
});

sb?.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT' && S.fase === 'app') { S.fase = 'ingreso'; render(); } });
arrancar();

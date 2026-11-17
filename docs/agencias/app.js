// Cotizador de créditos prendarios para agencias y concesionarias (Asociación Mutual Bell).
//
// El vendedor elige marca, modelo, versión y año, y ve las condiciones del crédito de la Mutual. Todo lo
// pide a la función `agencias` de Supabase, que es la que consulta los valores de los vehículos y NUNCA
// los devuelve: acá no llega ni el valor ni el código del vehículo (licencia de la guía de precios), solo
// el monto máximo, las cuotas y las tasas. La app no lee la base: a las agencias la API les está cerrada.
//
// Un usuario de la Mutual (miembro del gestor) entra en «vista previa» y además ve «Administración»:
// parámetros del crédito, agencias y cotizaciones (eso sí, por la API de la base, con sus permisos).

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
  vista: 'cotizar', // cotizar | admin
  marcas: null, marca: '', modelos: null, modelo: '', versiones: null, version: '', anios: null, anio: '',
  plazo: 0, monto: '', comprador: '', cargando: '', res: null,
  adm: null, admTab: 'parametros', admMsg: '',
};

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
    S.fase = 'app'; S.plazo = S.plazo || S.yo.plazos?.[Math.min(2, (S.yo.plazos?.length || 1) - 1)] || 0;
    render();
    if (S.yo.habilitado || S.yo.miembro) cargarMarcas();
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
  Object.assign(S, { fase: 'ingreso', yo: null, error: '', marcas: null, marca: '', modelos: null, modelo: '', versiones: null, version: '', anios: null, anio: '', res: null, adm: null, vista: 'cotizar' });
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
  const hola = S.comprador.trim() ? `Hola ${S.comprador.trim()}, ` : '';
  return `${hola}te paso las condiciones del crédito prendario de la Asociación Mutual Bell:\n\n`
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
    const [aj, ag, co] = await Promise.all([
      sb.from('ajustes_agencias').select('*').eq('id', 1).maybeSingle(),
      sb.from('agencias').select('*').order('nombre'),
      sb.from('cotizaciones_agencia').select('*').order('momento', { ascending: false }).limit(200),
    ]);
    const err = aj.error || ag.error || co.error;
    if (err) throw err;
    S.adm = { ajustes: aj.data, agencias: ag.data || [], cotizaciones: co.data || [] };
  } catch (e) {
    S.adm = { error: /relation|PGRST205|does not exist/i.test(`${e.code} ${e.message}`) ? 'Falta activar el cotizador en la base.' : 'No se pudo leer la administración.' };
  }
  render();
}

async function guardarParametros(form) {
  const v = (n) => form.elements[n]?.value ?? '';
  const plazos = v('plazos').split(/[^\d]+/).map(Number).filter((n) => n >= 1 && n <= 120);
  const g = {};
  for (const k of ['sellado', 'arancel', 'arancelMin', 'contratos', 'envio', 'gestoria', 'seguro', 'administrativos', 'cuotaSocial', 'igr']) g[k] = numero(v(`g_${k}`)) ?? 0;
  g.redondeo = numero(v('g_redondeo'));
  const fila = {
    habilitado: form.elements.habilitado.checked,
    pct_financiable: numero(v('pct_financiable')), tasa_mensual: numero(v('tasa_mensual')), plazos: [...new Set(plazos)].sort((a, b) => a - b),
    antiguedad_max: numero(v('antiguedad_max')), monto_minimo: numero(v('monto_minimo')) ?? 0, monto_maximo: numero(v('monto_maximo')),
    redondeo: numero(v('redondeo')) || 1, tope_diario: numero(v('tope_diario')) || 300, leyenda: v('leyenda').trim(), contacto: v('contacto').trim(), gastos: g,
  };
  if (!fila.plazos.length) { S.admMsg = 'Escribí al menos un plazo (por ejemplo: 12, 18, 24, 36).'; render(); return; }
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

function vistaCotizar() {
  const Y = S.yo;
  if (!Y.habilitado && !Y.miembro) return `<section class="card"><h2>El cotizador todavía no está habilitado</h2><p class="hint m0">Consultá con la Asociación Mutual Bell.</p></section>`;
  const c = S.cargando;
  const anios = S.anios ? S.anios.map((a) => ({ id: a, nombre: etiquetaAnio(a) })) : null;
  const sinAnios = S.anios && !S.anios.length;
  const form = `<section class="card no-imprimir">
    <div class="card-cab"><h2>Cotizar un crédito</h2>${Y.miembro ? '<span class="etq">Vista previa de la Mutual · no se registra</span>' : ''}</div>
    ${!Y.habilitado ? '<p class="aviso suave m0">Las agencias todavía no pueden usarlo: habilitalo en Administración cuando revises los parámetros.</p>' : ''}
    <div class="grilla">
      ${selector('selMarca', 'Marca', S.marcas, S.marca, 'id', c === 'marcas', false)}
      ${selector('selModelo', 'Modelo', S.modelos, S.modelo, 'id', c === 'modelos', !S.marca)}
      ${selector('selVersion', 'Versión', S.versiones, S.version, 'ref', c === 'versiones', !S.modelo)}
      ${selector('selAnio', 'Año', anios, S.anio, 'id', c === 'anios', !S.version)}
      ${sinAnios ? '<p class="aviso suave ancho m0">Esta versión no se puede financiar. Probá con otra.</p>' : ''}
      ${S.modelos && !S.modelos.length ? '<p class="aviso suave ancho m0">Esta marca no tiene modelos para financiar.</p>' : ''}
      <div class="f ancho">Plazo<div class="plazos" role="group" aria-label="Cantidad de cuotas">${(Y.plazos || []).map((n) => `<button type="button" data-plazo="${n}" aria-pressed="${n === S.plazo}">${n} cuotas</button>`).join('')}</div></div>
      <label class="f">Monto a pedir (opcional)<input id="inMonto" inputmode="numeric" autocomplete="off" placeholder="Vacío = el máximo" value="${esc(S.monto)}"></label>
      <label class="f">Nombre del comprador (opcional)<input id="inComprador" autocomplete="off" maxlength="80" placeholder="Solo para el mensaje" value="${esc(S.comprador)}"></label>
    </div>
    ${S.error ? `<p class="aviso m0" role="alert">${esc(S.error)}</p>` : ''}
    <div class="acciones"><button class="btn primario" type="button" id="btnCotizar" ${!S.version || !S.anio || c ? 'disabled' : ''}>${c === 'cotizar' ? 'Calculando…' : 'Ver crédito'}</button></div>
  </section>`;
  return form + (S.res ? vistaResultado(S.res) : '');
}

function vistaResultado(r) {
  if (!r.financiable) return `<section class="card resultado" id="resultado"><h2>No se puede financiar</h2><p class="m0">${esc(r.mensaje || 'Este vehículo no alcanza las condiciones del crédito.')}</p></section>`;
  const opciones = (r.opciones || []).map((o) => `<tr class="${o.cuotas === r.cuotas ? 'elegido' : ''}"><td>${o.cuotas} cuotas</td><td class="num">${plata(o.cuota)}</td></tr>`).join('');
  return `<section class="card resultado" id="resultado">
    <div class="card-cab"><h2>${esc(r.vehiculo)}</h2><span class="etq">${esc(etiquetaAnio(r.anio))}</span></div>
    <div class="destacado"><span class="titulo">Monto máximo que financia la Mutual</span><span class="cifra">${plata(r.maximo)}</span></div>
    <div class="cuota-grande">Crédito de <b>${plata(r.monto)}</b> en ${r.cuotas} cuotas de <b>${plata(r.cuota)}</b></div>
    <dl class="tasas m0"><div><dt>TNA</dt><dd>${pct(r.tna)}</dd></div><div><dt>TEA</dt><dd>${pct(r.tea)}</dd></div><div><dt>CFT</dt><dd>${pct(r.cft)}</dd></div></dl>
    <table><tbody>
      <tr><td>Total a pagar</td><td class="num">${plata(r.total)}</td></tr>
      <tr><td>Gastos de otorgamiento (incluidos en las cuotas)</td><td class="num">${plata(r.gastos_otorgamiento)}</td></tr>
    </tbody></table>
    <div class="scroll"><table><thead><tr><th>Otros plazos con este monto</th><th class="num">Cuota</th></tr></thead><tbody>${opciones}</tbody></table></div>
    <p class="leyenda m0">El CFT incluye los gastos de otorgamiento, el seguro, los gastos administrativos y la cuota social. No incluye IVA. ${esc(r.leyenda || '')}</p>
    ${r.contacto ? `<p class="leyenda m0">${esc(r.contacto)}</p>` : ''}
    <div class="acciones no-imprimir">
      <button class="btn primario" type="button" id="btnWhatsapp">Enviar por WhatsApp</button>
      <button class="btn" type="button" id="btnImprimir">Imprimir</button>
    </div>
  </section>`;
}

function vistaAdmin() {
  const A = S.adm;
  if (!A || A.cargando) return '<section class="card"><p class="hint m0">Cargando…</p></section>';
  if (A.error) return `<section class="card"><p class="aviso m0">${esc(A.error)}</p></section>`;
  const tabs = `<nav class="tabs" role="tablist">${[['parametros', 'Parámetros'], ['agencias', `Agencias (${A.agencias.filter((x) => x.activa).length}/20)`], ['cotizaciones', 'Cotizaciones']]
    .map(([k, t]) => `<button role="tab" data-adm="${k}" aria-selected="${S.admTab === k}">${esc(t)}</button>`).join('')}</nav>`;
  const msg = S.admMsg ? `<p class="aviso suave m0" role="status">${esc(S.admMsg)}</p>` : '';
  let cuerpo = '';
  if (S.admTab === 'parametros') {
    const j = A.ajustes || {}, g = j.gastos || {};
    const campo = (n, t, val, extra = '') => `<label class="f">${esc(t)}<input name="${n}" inputmode="decimal" autocomplete="off" value="${esc(typeof val === 'number' || /^-?\d+(\.\d+)?$/.test(String(val ?? '')) ? enCampo(val) : (val ?? ''))}" ${extra}></label>`;
    cuerpo = `<form id="fParametros" class="card" novalidate>
      <h2>Parámetros del crédito</h2>
      <label class="check"><input type="checkbox" name="habilitado" ${j.habilitado ? 'checked' : ''}> Cotizador habilitado para las agencias</label>
      <div class="grilla">
        ${campo('pct_financiable', '% del valor del vehículo que se financia', j.pct_financiable)}
        ${campo('tasa_mensual', 'Tasa mensual (%) sobre saldo', j.tasa_mensual)}
        ${campo('plazos', 'Plazos (cuotas, separados por coma)', (j.plazos || []).join(', '), 'inputmode="text"')}
        ${campo('antiguedad_max', 'Antigüedad máxima del vehículo (años; vacío = sin tope)', j.antiguedad_max)}
        ${campo('monto_minimo', 'Monto mínimo ($)', j.monto_minimo)}
        ${campo('monto_maximo', 'Monto máximo ($; vacío = sin tope)', j.monto_maximo)}
        ${campo('redondeo', 'Redondear el máximo hacia abajo a ($)', j.redondeo)}
        ${campo('tope_diario', 'Tope de cotizaciones por agencia y por día', j.tope_diario)}
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
    const tabs = S.yo.miembro ? `<nav class="tabs no-imprimir" role="tablist"><button role="tab" data-vista="cotizar" aria-selected="${S.vista === 'cotizar'}">Cotizar</button><button role="tab" data-vista="admin" aria-selected="${S.vista === 'admin'}">Administración</button></nav>` : '';
    m.innerHTML = tabs + (S.vista === 'admin' && S.yo.miembro ? vistaAdmin() : vistaCotizar());
  }
  $('#pie').textContent = S.fase === 'app' ? 'Simulación de referencia sujeta a aprobación crediticia de la Asociación Mutual Bell.' : '';
}

// ───────────────────────── Eventos ─────────────────────────
document.addEventListener('submit', (e) => {
  const f = e.target;
  e.preventDefault();
  if (f.id === 'fIngreso') ingresar(f.elements.email.value, f.elements.clave.value);
  else if (f.id === 'fClave') cambiarClave(f.elements.a.value, f.elements.b.value);
  else if (f.id === 'fParametros') guardarParametros(f);
  else if (f.id === 'fAlta') altaAgencia(f);
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'selMarca') elegirMarca(t.value);
  else if (t.id === 'selModelo') elegirModelo(t.value);
  else if (t.id === 'selVersion') elegirVersion(t.value);
  else if (t.id === 'selAnio') { S.anio = t.value; S.res = null; render(); }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'inMonto') {
    const n = soloNumero(t.value);
    S.monto = n ? n.toLocaleString('es-AR') : '';
    if (t.value !== S.monto) { t.value = S.monto; }
  } else if (t.id === 'inComprador') S.comprador = t.value;
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'btnSalir') salir();
  else if (t.id === 'btnCotizar') cotizar();
  else if (t.dataset.plazo) { S.plazo = Number(t.dataset.plazo); if (S.res) cotizar(); else render(); }
  else if (t.id === 'btnWhatsapp' && S.res) window.open(`https://wa.me/?text=${encodeURIComponent(textoParaComprador(S.res))}`, '_blank', 'noopener');
  else if (t.id === 'btnImprimir') window.print();
  else if (t.dataset.vista) { S.vista = t.dataset.vista; S.admMsg = ''; if (S.vista === 'admin') cargarAdmin(); else render(); }
  else if (t.dataset.adm) { S.admTab = t.dataset.adm; S.admMsg = ''; render(); }
  else if (t.dataset.activa) cambiarActiva(t.dataset.activa, t.dataset.valor === '1');
});

sb?.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT' && S.fase === 'app') { S.fase = 'ingreso'; render(); } });
arrancar();

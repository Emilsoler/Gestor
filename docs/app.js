// Interfaz del gestor. Los datos y la red viven en datos.js.
import {
  D, iniciar, reconectar, entrar, salir, cambiarClave, alCambiar, mensaje, ultimaDe,
  crearCausa, guardarCausa, actualizarCausa, borrarCausa,
  crearAcuerdo, actualizarAcuerdo, borrarAcuerdo,
  crearPlantilla, guardarPlantilla, borrarPlantilla,
  crearEscrito, actualizarAgenda, preguntarAClaude, leerChat, guardarChat, leerDeudor,
} from './datos.js';
import { idNuevo, nuevaLiquidacion, cobradoRubro, totalPago, liqNormal, liqCalc, importe, pesos, enCelda, planillaExcel } from './liquidacion.js';
import { MODELOS, ACCIONES, CAMPOS_OFICIO, esModeloOficio, rellenar, htmlOficio, pdfOficio, enLetras, cifra, ordinal, datosDeCausa, partirDomicilio, dniOficio, nombreArchivo } from './oficio.js';

const VERSION = '1.12.0';

// Cuatro datos de cada causa, con valores fijos: los mismos que acepta la base (supabase/migrations/0007).
const UBICACIONES = ['Casillero', 'A despacho'];
const ESTADOS = ['0. Iniciamos', '1.1 Demanda', '1.2 Contestación', '2. No oposición de excepciones', '3. Sentencia', '4. Ejecución de Sentencia', '5. Martillero Designado'];
const CAUTELARES = ['Sin Cautelar', 'Embargo de sueldo', 'Vehículo secuestrado'];
const SITUACIONES = ['En trámite', 'Acuerdo', 'Archivada'];
// Los tres rubros de un acuerdo de pago; cada uno lleva sus propias cuotas (ver "Acuerdos").
const RUBROS_ACU = [['capital', 'Capital, intereses y gastos'], ['martillero', 'Honorarios martillero'], ['abogado', 'Honorarios abogado']];
const FRECUENCIAS = [['mes', 'Mensual'], ['quincena', 'Cada 15 días'], ['semana', 'Semanal']];
const PLAN_VACIO = () => ({ n: '', monto: '', fecha: '', cada: 'mes' });
/** Un acuerdo nuevo, como se escribe en el formulario: deudor, causa, notas y el plan de cuotas de cada rubro. */
const NA_VACIO = (deudor = '') => ({ deudor, expte: '', notas: '', planes: Object.fromEntries(RUBROS_ACU.map(([r]) => [r, PLAN_VACIO()])) });
const STALE = 30; // días sin movimiento para marcar una causa
const GRACIA = 5; // días después del vencimiento de una cuota antes de preguntar si se pagó
const CLAVE_MIN = 10;
// La tarea de Claude que presenta en el SAC. No tiene horario: corre cuando la persona toca
// "Ejecutar ahora" en esta página. Las tareas de este tipo no se pueden arrancar desde otra app
// (no tienen activador por API), por eso «Ahora» la abre y el último toque es de la persona.
// Requiere la compu del estudio: ahí está el Chrome con la sesión del SAC.
const TAREA_SAC = 'https://claude.ai/scheduled-task/trig_01AFgigkwo8pfvJccpFYUx3n';
const COBRANZAS = 'cobranzas/'; // la app de cobranzas, en la misma base y con la misma sesión

const S = {
  pantalla: 'arranque',
  q: '', estado: '', nom: '', tag: '', quick: '', view: 'lista', sort: { k: 'dias', dir: -1 },
  open: null, isNew: false, confirmDel: false, choque: null, // ficha abierta
  planilla: false, liqSucia: false, // la planilla de liquidación está a la vista / tiene cambios sin guardar
  cau: null, // la acción cautelar que se está armando desde la ficha (ver "Acción cautelar")
  tpl: false, tpSel: '', tplDel: '', clave: false, // otros paneles
  // Acuerdos: el formulario de uno nuevo en la vista (na) y en la ficha (naf, null si está cerrado),
  // el acuerdo desplegado en la vista, los formularios abiertos de "cargar cuotas" de un rubro y el
  // acuerdo que se está por eliminar.
  na: NA_VACIO(), naAbierto: false, naf: null, acVer: '', pq: {}, acDel: '',
  menu: false, instalar: null, ocupado: false,
  chat: null, // la conversación con Claude (ver "Chat con Claude")
};
try { S.view = localStorage.getItem('gj.view') || 'lista'; } catch { /* sin almacenamiento */ }
try { S.maxi = localStorage.getItem('gj.maxi') === '1'; } catch { /* sin almacenamiento */ }

// ───────────────────────── Utilidades ─────────────────────────

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const copia = (o) => JSON.parse(JSON.stringify(o));
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const parse = (s) => { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const fmt = (s) => { const d = parse(s); return d ? d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—'; };
const days = (s) => { const d = parse(s); return d ? Math.round((today() - d) / 864e5) : null; };
const money = (n) => '$ ' + Math.round(n || 0).toLocaleString('es-AR');
const hora = (d) => d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const cuando = (d) => (iso(d) === iso(new Date()) ? 'hoy' : 'el ' + d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })) + ' a las ' + hora(d);
// Hay juicios sin contraparte (limitación de la capacidad, sucesiones…): no llevan demandado
// y se nombran por el actor, como en la carátula del SAC.
const titulo = (c) => c.demandado || c.actor || '(sin carátula)';
const partes = (c) => (c.actor && !c.demandado ? c.actor : `${c.actor || 'AMB'} c/ ${c.demandado || '…'}`);
const bajada = (c) => (c.demandado ? `${c.actor || ''} c/ … ${c.tipo || ''}` : c.tipo || '');
const caratula = (c) => `${partes(c)}${c.tipo ? ' – ' + c.tipo : ''}`;
const uClass = (u) => (u === 'Casillero' ? 's-casillero' : u === 'A despacho' ? 's-despacho' : '');
// La etapa, por tramos: en discusión (1.1 a 2) ámbar, con sentencia (3 y 4) verde, martillero designado (5) coral.
const eClass = (e) => { const n = parseFloat(e); return !(n >= 1) ? '' : n < 3 ? 's-notificando' : n < 5 ? 's-sentencia' : 's-subasta'; };
const CAUTELAR_CLASE = { 'Embargo de sueldo': 't-emb', 'Vehículo secuestrado': 't-sec' };
const ubiHtml = (c) => (c.ubicacion ? `<span class="pill ${uClass(c.ubicacion)}">${esc(c.ubicacion)}</span>` : '');
// La etapa va como etiqueta, debajo de la carátula: una columna más no entra en la pantalla de una notebook.
const etapaHtml = (c) => (c.estado ? `<span class="tag etapa ${eClass(c.estado)}">${esc(c.estado)}</span>` : '');
const movil = window.matchMedia('(max-width: 720px)');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  // los avisos largos (por ejemplo, por qué no se pudo presentar ahora) quedan más tiempo a la vista
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, Math.min(12000, Math.max(3200, msg.length * 55)));
}

/** Redibuja una parte de la pantalla sin sacar el foco ni el cursor del campo en que se estaba escribiendo. */
function conFoco(raiz, redibujar) {
  const activo = document.activeElement, id = activo && raiz && raiz.contains(activo) ? activo.id : '';
  let cursor = null; try { if (id && activo.selectionStart != null) cursor = [activo.selectionStart, activo.selectionEnd]; } catch { /* tipos sin selección */ }
  redibujar();
  if (!id) return;
  const el = document.getElementById(id);
  if (el && el !== document.activeElement) { el.focus(); if (cursor) try { el.setSelectionRange(cursor[0], cursor[1]); } catch { /* tipos sin selección */ } }
}

function dueState(c) { const d = parse(c.vence); if (!d || !(c.proxima || '').trim()) return ''; const n = Math.round((d - today()) / 864e5); return n < 0 ? 'late' : n <= 7 ? 'soon' : ''; }
const isArch = (c) => c.situacion === 'Archivada';
const isAcu = (c) => c.situacion === 'Acuerdo';
function isStale(c) { if (isArch(c) || isAcu(c)) return false; const n = days(c.fecha); return n === null || n > STALE; }

// ───────────────────────── Pantallas de ingreso ─────────────────────────

function mostrar(pantalla) {
  S.pantalla = pantalla;
  const enApp = pantalla === 'listo';
  $('#vArranque').hidden = true;
  $('#vApp').hidden = !enApp;
  $('#vIngreso').hidden = enApp;
  if (enApp) { $('#ingresoCuerpo').innerHTML = ''; render(); seguirEnlace(); return; } // no dejar el formulario (ni la clave) en la página
  closeDrawer(); cerrarChat(); S.chat = null; S.menu = false; renderMenu();
  for (const k of ['#main', '#stats', '#chips', '#avisos', '#franja', '#fEstado', '#fNom', '#nAgenda', '#nAcuerdos']) $(k).innerHTML = ''; // ni los datos, al salir
  $('#sub').textContent = ''; $('#q').value = ''; S.q = '';
  renderIngreso();
}

function renderIngreso() {
  const c = $('#ingresoCuerpo'), email = esc(D.usuario?.email || '');
  const error = '<p class="error" id="i_error" role="alert" hidden></p>';
  if (S.pantalla === 'ingreso') {
    c.innerHTML = `<form id="fIngreso" novalidate>
      <label class="f">Email<input id="i_email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false"></label>
      <label class="f">Contraseña<input id="i_clave" type="password" autocomplete="current-password"></label>
      ${error}
      <button class="btn primary" type="submit">Ingresar</button>
    </form>
    <p class="pie hint">¿Olvidaste la contraseña? Pedile a Claude que te guíe para restablecerla.</p>`;
    $('#i_email').focus();
  } else if (S.pantalla === 'clave-temporal') {
    c.innerHTML = `<div><b>Elegí tu contraseña</b>
      <p class="hint m0">La clave con la que entraste es temporal. Elegí una que solo vos conozcas, de ${CLAVE_MIN} caracteres o más.</p></div>
    <form id="fClave" novalidate>
      <input type="email" autocomplete="username" value="${email}" hidden>
      <label class="f">Contraseña nueva<input id="n_clave" type="password" autocomplete="new-password"></label>
      <label class="f">Repetila<input id="n_clave2" type="password" autocomplete="new-password"></label>
      ${error}
      <button class="btn primary" type="submit">Guardar contraseña</button>
    </form>
    <p class="pie hint">Ingresaste como ${email}. <button class="btn small" data-ing="salir">Cerrar sesión</button></p>`;
    $('#n_clave').focus();
  } else if (S.pantalla === 'sin-acceso') {
    c.innerHTML = `<div><b>Esta cuenta no está autorizada</b>
      <p class="hint m0">Ingresaste como ${email}, pero esa cuenta no tiene permiso para usar el gestor. Si tendría que tenerlo, pedí el alta al estudio.</p></div>
    <div class="actions"><button class="btn" data-ing="reintentar">Volver a comprobar</button><button class="btn" data-ing="salir">Cerrar sesión</button></div>`;
  } else if (S.pantalla === 'sin-red') {
    c.innerHTML = `<div><b>No se pudo conectar con la base de datos</b>
      <p class="hint m0">Revisá tu conexión a internet. Si hace más de una semana que el gestor no se usa, la base puede estar en pausa: pedile a Claude que la reactive.</p></div>
    <div class="actions"><button class="btn primary" data-ing="reintentar">Reintentar</button></div>`;
  } else if (S.pantalla === 'en-marco') {
    c.innerHTML = `<div><b>El gestor no se abre dentro de otra página</b>
      <p class="hint m0">Por seguridad solo funciona en su propia pestaña o instalado como app.</p></div>
    <div class="actions"><a class="btn primary" href="./" target="_top" rel="noopener">Abrir el gestor</a></div>`;
  } else if (S.pantalla === 'sin-configurar') {
    c.innerHTML = `<div><b>Falta conectar la app con su base de datos</b>
      <p class="hint m0">Todavía no se cargaron la dirección y la clave pública del proyecto en config.js.</p></div>`;
  } else {
    c.innerHTML = `<div><b>No se pudo abrir el gestor</b><p class="hint m0">${esc(S.falla || '')}</p></div>
    <div class="actions"><button class="btn primary" data-ing="reintentar">Reintentar</button></div>`;
  }
}

function errorIngreso(texto) { const e = $('#i_error'); if (e) { e.textContent = texto; e.hidden = !texto; } }

function claveValida(a, b) {
  if (a.length < CLAVE_MIN) return `La contraseña tiene que tener ${CLAVE_MIN} caracteres o más`;
  if (a !== b) return 'Las dos contraseñas no coinciden';
  return '';
}

async function conBoton(boton, textoOcupado, tarea) { // evita dobles envíos y muestra que está trabajando
  if (S.ocupado) return;
  S.ocupado = true;
  const antes = boton ? boton.textContent : '';
  if (boton) { boton.disabled = true; boton.textContent = textoOcupado; }
  try { await tarea(); } finally {
    S.ocupado = false;
    if (boton && boton.isConnected) { boton.disabled = false; boton.textContent = antes; }
  }
}

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'fChat') { const t = $('#chatTexto'), texto = t.value; if (texto.trim() && !S.chat?.enviando) { t.value = ''; ajustarAlto(t); await enviarChat(texto); } return; }
  const boton = e.target.querySelector('[type=submit]');
  if (e.target.id === 'fIngreso') {
    const email = $('#i_email').value.trim(), clave = $('#i_clave').value;
    if (!email || !clave) { errorIngreso('Completá el email y la contraseña'); return; }
    errorIngreso('');
    await conBoton(boton, 'Ingresando…', async () => {
      try { mostrar(await entrar(email, clave)); } catch (err) { errorIngreso(mensaje(err, 'no se pudo ingresar')); }
    });
  } else if (e.target.id === 'fClave' || e.target.id === 'fClaveMenu') {
    const a = $('#n_clave').value, problema = claveValida(a, $('#n_clave2').value);
    if (problema) { errorIngreso(problema); return; }
    errorIngreso('');
    await conBoton(boton, 'Guardando…', async () => {
      try {
        const pantalla = await cambiarClave(a);
        if (e.target.id === 'fClaveMenu') { closeDrawer(); toast('Contraseña guardada'); } else mostrar(pantalla);
      } catch (err) { errorIngreso(mensaje(err, 'no se pudo guardar la contraseña')); }
    });
  }
});

async function reintentar(boton) {
  await conBoton(boton, 'Conectando…', async () => {
    try { mostrar(await reconectar()); } catch (err) { console.error(err); S.falla = mensaje(err, 'no se pudo abrir'); mostrar('error'); }
  });
}

// ───────────────────────── Listado ─────────────────────────

// Filtros rápidos: u: ubicación, c: etiqueta cautelar.
const CHIPS = [{ k: 'u:Casillero', l: 'Casillero' }, { k: 'u:A despacho', l: 'A despacho' }, { k: 'c:Embargo de sueldo', l: 'Embargos de sueldo' }, { k: 'c:Vehículo secuestrado', l: 'Vehículos secuestrados' }];
function chipMatch(c, k) { const v = k.slice(2); return (k[0] === 'u' ? c.ubicacion : c.cautelar) === v; }

function filtered() {
  const q = S.q.trim().toLowerCase();
  const r = D.causas.filter((c) => {
    if (S.estado && (c.estado || '(sin estado)') !== S.estado) return false;
    if (S.nom && String(c.nom) !== S.nom) return false;
    if (S.tag && !chipMatch(c, S.tag)) return false;
    if (S.quick === 'stale' && !isStale(c)) return false;
    if (S.quick === 'due' && dueState(c) !== 'late') return false;
    if (S.quick === 'next' && !c.proxima) return false;
    if (S.quick !== 'arch' && isArch(c)) return false;
    if (S.quick === 'arch' && !isArch(c)) return false;
    if (S.quick === 'acu' && !isAcu(c)) return false;
    if (S.quick === 'sac' && !agendaAbierta(c.expte).length) return false;
    if (S.quick !== 'acu' && isAcu(c)) return false;
    if (q) { const h = [c.actor, c.demandado, c.tipo, c.expte, c.ultima, c.proxima, c.oficina, c.notas, c.ubicacion, c.estado, c.cautelar].join(' ').toLowerCase(); if (!h.includes(q)) return false; }
    return true;
  });
  const { k, dir } = S.sort;
  const val = (c) => (k === 'dias' ? (days(c.fecha) ?? 99999) : k === 'vence' ? (c.proxima && c.vence) || '9999' : k === 'nom' ? Number(c.nom) || 0 : k === 'demandado' ? titulo(c).toLowerCase() : String(c[k] || '').toLowerCase());
  r.sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
  return r;
}

function renderStats() {
  const act = D.causas.filter((c) => !isArch(c) && !isAcu(c)), acu = D.causas.filter(isAcu);
  const items = [
    { id: '', n: act.length, l: 'Causas activas' },
    { id: 'stale', n: act.filter(isStale).length, l: `Sin movimiento +${STALE} días o sin fecha`, cls: 'alert' },
    { id: 'due', n: act.filter((c) => dueState(c) === 'late').length, l: 'Vencidas', cls: 'alert' },
    { id: 'next', n: act.filter((c) => c.proxima).length, l: 'Con próxima acción anotada' },
    { id: 'acu', n: acu.length, l: 'Con acuerdo' },
    { id: 'arch', n: D.causas.filter(isArch).length, l: 'Archivadas' }];
  // Escritos para el SAC: solo aparece si hay alguno, y en rojo si alguno no se pudo presentar.
  const sac = D.causas.filter((c) => agendaAbierta(c.expte).length);
  if (sac.length || S.quick === 'sac') items.push({ id: 'sac', n: sac.length, l: 'Con escritos para el SAC', cls: D.agenda.some((a) => a.estado === 'error') ? 'alert' : '' });
  $('#stats').innerHTML = items.map((i) => `<button class="stat ${i.cls || ''}" data-q="${i.id}" aria-pressed="${S.quick === i.id}"><b>${i.n}</b><span>${i.l}</span></button>`).join('');
}

function renderFilters() {
  const est = [...new Set([...ESTADOS, ...D.causas.map((c) => c.estado || '(sin estado)')])];
  const noms = [...new Set(D.causas.map((c) => String(c.nom || '')).filter(Boolean))].sort();
  $('#fEstado').innerHTML = '<option value="">Todos los estados</option>' + est.map((e) => `<option ${S.estado === e ? 'selected' : ''}>${esc(e)}</option>`).join('');
  $('#fNom').innerHTML = '<option value="">Todas las nominaciones</option>' + noms.map((n) => `<option value="${esc(n)}" ${S.nom === n ? 'selected' : ''}>${esc(n)}° Nom.</option>`).join('');
  const orden = `${S.sort.k}:${S.sort.dir}`;
  $('#fOrden').value = [...$('#fOrden').options].some((o) => o.value === orden) ? orden : '';
  const usados = (S.estado ? 1 : 0) + (S.nom ? 1 : 0) + (orden !== 'dias:-1' ? 1 : 0);
  $('#btnFiltros').textContent = usados ? `Filtros · ${usados}` : 'Filtros';
  const live = D.causas.filter((c) => !isArch(c) && !isAcu(c));
  $('#chips').innerHTML = `<button class="chip" data-t="" aria-pressed="${!S.tag}">Todas · ${live.length}</button>` + CHIPS.map((t) => `<button class="chip" data-t="${esc(t.k)}" aria-pressed="${S.tag === t.k}">${esc(t.l)} · ${live.filter((c) => chipMatch(c, t.k)).length}</button>`).join('');
  $('#vAgenda').setAttribute('aria-pressed', S.view === 'agenda'); $('#vAcuerdos').setAttribute('aria-pressed', S.view === 'acuerdos'); $('#vLista').setAttribute('aria-pressed', S.view === 'lista'); $('#vTablero').setAttribute('aria-pressed', S.view === 'tablero');
  // Insignias de las vistas: lo de la agenda que es para hoy o venció (en coral si algo venció) y
  // las cuotas de acuerdos que esperan confirmación. Sin búsqueda: cuentan todo, no lo filtrado.
  const hoy = iso(today()), urgentes = itemsAgenda('').filter((x) => x.fecha && x.fecha <= hoy), cuotas = cuotasPorPreguntar().length;
  insignia('#nAgenda', urgentes.length, urgentes.some((x) => x.fecha < hoy) ? 'urg' : '', urgentes.length === 1 ? 'para hoy o vencida' : 'para hoy o vencidas');
  insignia('#nAcuerdos', cuotas, 'pend', cuotas === 1 ? 'cuota por confirmar' : 'cuotas por confirmar');
}
function insignia(sel, n, clase, texto) {
  const b = $(sel);
  b.hidden = !n; b.className = 'badge' + (clase ? ' ' + clase : '');
  b.innerHTML = n ? `${n}<span class="vh"> ${texto}</span>` : '';
}

function ageHtml(c) { const n = days(c.fecha); if (n === null) return '<span class="age old">sin fecha</span>'; return `<span class="age ${n > STALE ? 'old' : ''}">${fmt(c.fecha)} · hace ${n} d</span>`; }
/** Etiquetas debajo de la carátula: la cautelar (si tiene), acuerdo o archivada, y los escritos para el SAC. */
function tagsHtml(c, antes = '') {
  const ts = antes ? [antes] : [];
  if (CAUTELAR_CLASE[c.cautelar]) ts.push(`<span class="tag ${CAUTELAR_CLASE[c.cautelar]}">${esc(c.cautelar)}</span>`);
  if (isAcu(c)) ts.push('<span class="tag t-acu">Acuerdo</span>');
  if (isArch(c)) ts.push('<span class="tag">Archivada</span>');
  for (const a of agendaAbierta(c.expte)) {
    ts.push(a.estado === 'error' ? '<span class="tag t-sacerr">SAC: no se presentó</span>'
      : a.estado === 'borrador' ? '<span class="tag">Escrito sin confirmar</span>'
        : a.estado === 'presentando' ? '<span class="tag t-sac">SAC: presentándose</span>'
          : a.ahora ? '<span class="tag t-sac">SAC: listo para presentar</span>'
            : `<span class="tag t-sac">SAC ${esc(fmtDia(a.fecha))}</span>`);
  }
  return ts.length ? `<div class="tags">${ts.join('')}</div>` : '';
}

function renderList(rows) {
  if (movil.matches) return renderFilas(rows);
  const th = (k, l) => `<th data-k="${k}">${l}${S.sort.k === k ? (S.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
  return `<div class="tablebox"><table><thead><tr>${th('demandado', 'Carátula')}${th('expte', 'Expte.')}${th('nom', 'Nom. / Oficina')}${th('ubicacion', 'Ubicación')}${th('ultima', 'Última acción')}${th('dias', 'Fecha')}${th('proxima', 'Próxima acción')}${th('vence', 'Vence')}</tr></thead><tbody>` +
    rows.map((c) => `<tr data-id="${esc(c.expte)}" tabindex="0"><td class="car"><b>${esc(titulo(c))}</b><small>${esc(bajada(c))}</small>${tagsHtml(c, etapaHtml(c))}</td>
   <td class="mono">${esc(c.expte)}</td><td>${c.nom ? esc(c.nom) + '°' : ''} ${esc(c.oficina)}</td>
   <td>${ubiHtml(c) || '<span class="hint">—</span>'}</td>
   <td>${esc(c.ultima) || '<span class="hint">—</span>'}</td><td>${ageHtml(c)}</td>
   <td class="next ${c.proxima ? '' : 'none'}">${esc(c.proxima) || '—'}${c.proxima ? `<div><button class="btn small donebtn" data-done="${esc(c.expte)}">✓ Realizada</button></div>` : ''}</td>
   <td>${c.vence && c.proxima ? `<span class="due ${dueState(c)}">${fmt(c.vence)}</span>` : '<span class="hint">—</span>'}</td></tr>`).join('') + `</tbody></table></div>`;
}

// En pantallas chicas, cada causa es una tarjeta: se lee de arriba abajo sin deslizar de costado.
function renderFilas(rows) {
  return `<div class="filas">` + rows.map((c) => `<article class="fila" data-id="${esc(c.expte)}" tabindex="0" role="button" aria-label="Abrir la ficha de ${esc(titulo(c))}">
    <div class="fila-top"><b>${esc(titulo(c))}</b>${ubiHtml(c)}</div>
    <div class="mono">${esc(c.expte)} · ${c.nom ? esc(c.nom) + '° ' : ''}${esc(c.oficina)}${c.tipo ? ' · ' + esc(c.tipo) : ''}</div>
    ${tagsHtml(c, etapaHtml(c))}
    <div class="fila-ult"><span>${esc(c.ultima) || '<span class="hint">Sin acción cargada</span>'}</span>${ageHtml(c)}</div>
    ${c.proxima ? `<div class="fila-prox"><div><span class="next">${esc(c.proxima)}</span>${c.vence ? `<div class="due ${dueState(c)}">Vence el ${fmt(c.vence)}</div>` : ''}</div><button class="btn small donebtn" data-done="${esc(c.expte)}">✓ Realizada</button></div>` : ''}
  </article>`).join('') + `</div>`;
}

function renderBoard(rows) {
  // Una columna por etapa del juicio, en orden; las causas sin estado, al final.
  const cols = [...ESTADOS, ...(rows.some((c) => !c.estado) ? ['(sin estado)'] : [])];
  return `<div class="board">` + cols.map((e) => {
    const cs = rows.filter((c) => (c.estado || '(sin estado)') === e);
    if (!cs.length && movil.matches) return ''; // en el celular, las columnas vacías no ocupan pantalla
    return `<section class="col"><h3><span>${esc(e)}</span><span>${cs.length}</span></h3>` + cs.map((c) => `<button class="card" data-id="${esc(c.expte)}"><div class="card-top"><b>${esc(titulo(c))}</b>${ubiHtml(c)}</div><div class="mono">${esc(c.expte)} · ${c.nom ? esc(c.nom) + '° ' : ''}${esc(c.oficina)}</div>${tagsHtml(c)}<p>${esc(c.ultima || 'Sin acción cargada')}</p>${ageHtml(c)}${c.proxima ? `<p><b>→</b> ${esc(c.proxima)}</p>` : ''}</button>`).join('') + `</section>`;
  }).join('') + `</div>`;
}

// Agenda: todo lo que hay que hacer, de todas las causas en trámite, en orden de fecha. Junta
// las próximas acciones (con su vencimiento) y los escritos para el SAC que siguen abiertos.
function itemsAgenda(q = S.q.trim().toLowerCase()) {
  const r = [];
  for (const c of D.causas) {
    if (isArch(c)) continue;
    if ((c.proxima || '').trim()) r.push({ c, fecha: c.vence || '', texto: c.proxima, sac: null });
    for (const a of agendaAbierta(c.expte)) r.push({ c, fecha: a.fecha || '', texto: a.titulo, sac: a });
  }
  const busca = (x) => !q || [x.texto, x.c.actor, x.c.demandado, x.c.expte, x.c.tipo].join(' ').toLowerCase().includes(q);
  return r.filter(busca).sort((x, y) => (x.fecha || '9999').localeCompare(y.fecha || '9999') || titulo(x.c).localeCompare(titulo(y.c)));
}

function renderAgenda(items) {
  const hoy = iso(today()), manana = iso(new Date(today().getTime() + 864e5));
  const grupo = (f) => (!f ? 'Sin fecha' : f < hoy ? 'Vencidas' : f === hoy ? `Hoy · ${fmtLargo(f)}` : f === manana ? `Mañana · ${fmtLargo(f)}` : fmtLargo(f));
  const grupos = new Map();
  for (const x of items) { const g = grupo(x.fecha); if (!grupos.has(g)) grupos.set(g, []); grupos.get(g).push(x); }
  const fila = ({ c, fecha, texto, sac }) => {
    const [estado, clase] = sac ? estadoAg(sac) : [];
    const tarde = fecha && fecha < hoy;
    return `<article class="fila agitem" data-id="${esc(c.expte)}" tabindex="0" role="button" aria-label="Abrir la ficha de ${esc(titulo(c))}">
    <div class="fila-top"><span class="next">${esc(texto)}</span>${sac ? `<span class="pill ${clase}">SAC · ${esc(estado)}</span>` : ''}</div>
    <div class="agcausa"><b>${esc(titulo(c))}</b> <span class="mono">${esc(c.expte)}${c.nom ? ' · ' + esc(c.nom) + '°' : ''}${c.oficina ? ' ' + esc(c.oficina) : ''}</span></div>
    <div class="fila-ult">${fecha ? `<span class="due ${tarde ? 'late' : fecha === hoy ? 'soon' : ''}">${sac ? 'Para el' : 'Vence el'} ${fmt(fecha)}</span>` : '<span class="hint">Sin fecha</span>'}${sac ? '' : `<button class="btn small donebtn" data-done="${esc(c.expte)}">✓ Realizada</button>`}</div>
  </article>`;
  };
  return `<div class="agenda">` + [...grupos].map(([g, xs]) => `<section class="agdia ${g === 'Vencidas' ? 'tarde' : ''}"><h3><span>${esc(g)}</span><span>${xs.length}</span></h3><div class="filas">${xs.map(fila).join('')}</div></section>`).join('') + `</div>`;
}

function renderFranja() {
  let h = '';
  if (!D.enLinea) {
    const detalle = D.deCache && D.leido ? `Estás viendo lo guardado en este dispositivo ${cuando(D.leido)}. ` : '';
    h = `<div class="franja"><div><b>Sin conexión.</b> ${detalle}Para guardar cambios hace falta conexión.</div><button class="btn small" id="btnReintentar">Reintentar</button></div>`;
  }
  $('#franja').innerHTML = h;
}

function subtitulo(texto) {
  const partes = [esc(texto)];
  if (D.leido && D.enLinea) partes.push('actualizado ' + hora(D.leido));
  $('#sub').innerHTML = partes.join(' · ') + (D.enVivo && D.enLinea ? ' · <span class="vivo">en vivo</span>' : '');
}

function render() {
  if (S.pantalla !== 'listo') return;
  guardarFormsAcu(); // lo que se esté escribiendo en un formulario de acuerdos vuelve igual después de redibujar
  // Si se redibuja mientras se escribe en el listado (formularios de acuerdos), el foco y el cursor vuelven a su lugar.
  conFoco($('#main'), dibujar);
}
function dibujar() {
  renderStats(); renderFilters(); renderAvisos(); renderFranja();
  const inicial = (D.acceso?.nombre || D.usuario?.email || '?').trim().charAt(0).toUpperCase();
  $('#btnCuenta').textContent = inicial;
  const main = $('#main'), isAc = S.view === 'acuerdos', isAg = S.view === 'agenda';
  ['#stats', '#chips', '#btnFiltros', '#filtros', '#fabNew'].forEach((k) => { $(k).hidden = isAc || isAg; });
  $('#toolbar').hidden = isAc; // en Acuerdos no hay qué buscar ni filtrar
  $('#tVista').textContent = { tablero: 'Tablero', agenda: 'Agenda', acuerdos: 'Acuerdos' }[S.view] || 'Causas'; // título en la computadora, con la barra lateral
  if (!D.cargado) {
    main.innerHTML = `<div class="empty"><b>Cargando tus causas…</b>Acá vas a ver el listado de juicios con su estado, última acción y próxima acción.</div>`;
    subtitulo('Cargando causas…');
  } else if (isAc) {
    main.innerHTML = renderAcuerdos(); subtitulo(`${D.acuerdos.length} ${D.acuerdos.length === 1 ? 'acuerdo' : 'acuerdos'} de pago`);
  } else if (isAg) {
    const items = itemsAgenda();
    subtitulo(`${items.length} ${items.length === 1 ? 'acción pendiente' : 'acciones pendientes'}`);
    main.innerHTML = items.length ? renderAgenda(items) : S.q.trim()
      ? `<div class="empty"><b>Ninguna acción coincide con la búsqueda</b>Probá con otra palabra.</div>`
      : `<div class="empty"><b>No hay acciones pendientes</b>Acá aparecen las próximas acciones de cada causa y los escritos para el SAC, ordenados por fecha.</div>`;
  } else if (!D.causas.length) {
    main.innerHTML = `<div class="empty"><b>Todavía no hay causas cargadas</b>Usá “+ Nueva causa” para agregar la primera.</div>`; subtitulo('0 causas');
  } else {
    const rows = filtered();
    subtitulo(`${rows.length} de ${D.causas.length} causas`);
    main.innerHTML = rows.length ? (S.view === 'tablero' ? renderBoard(rows) : renderList(rows)) : `<div class="empty"><b>Ninguna causa coincide con los filtros</b>Probá con otra búsqueda o quitá algún filtro.</div>`;
  }
}

function applyDone(c) {
  const t = (c.proxima || '').trim(); if (!t) return false;
  // Queda con la fecha en que vencía; si todavía no venció (se hizo antes), con la de hoy: un
  // movimiento con fecha futura taparía la causa en "sin movimiento" y en "última acción".
  const hoy = iso(today()), fecha = c.vence && c.vence < hoy ? c.vence : hoy;
  c.historial = [...(c.historial || []), { fecha, texto: t, hecha: true }];
  Object.assign(c, ultimaDe(c.historial)); c.proxima = ''; c.vence = ''; return true;
}

async function quickDone(id) {
  const o = D.causas.find((c) => c.expte === id); if (!o) return;
  const c = copia(o); if (!applyDone(c)) return;
  try {
    const r = await actualizarCausa(id, o.rev, { historial: c.historial, ultima: c.ultima, fecha: c.fecha, proxima: '', vence: '' });
    toast(r.conflicto ? 'La causa cambió recién. Revisala y probá de nuevo' : 'Acción realizada: quedó en los movimientos');
  } catch (e) { toast(mensaje(e)); }
}

// ───────────────────────── Ficha ─────────────────────────

function blank() { return { expte: '', actor: 'AMB', demandado: '', tipo: 'EJECUTIVO', nom: '', oficina: 'OEP', ubicacion: 'Casillero', estado: '0. Iniciamos', cautelar: 'Sin Cautelar', situacion: 'En trámite', proxima: '', vence: '', ultima: '', fecha: '', notas: '', historial: [], demandados: [], titulos: [] }; }
/** Abre una causa, o una nueva (en blanco, o `pre`: ya armada, por ejemplo desde un deudor de Cobranzas). */
function openCausa(id, pre = null, pase = null) {
  S.open = id ? copia(D.causas.find((c) => c.expte === id) || blank()) : (pre || blank());
  S.base = copia(S.open); // la causa como se abrió: para saber qué se cambió en la ficha
  S.isNew = !id; S.confirmDel = false; S.choque = null; S.tpl = false; S.clave = false; S.tpSel = '';
  S.planilla = false; S.liqSucia = false; S.cau = null; S.pase = !id && pase ? pase : null;
  cerrarFormsFicha();
  renderDrawer(true);
}
function closeDrawer() {
  S.open = null; S.tpl = false; S.clave = false; S.tpSel = ''; S.tplDel = ''; S.choque = null; S.confirmDel = false;
  S.planilla = false; S.liqSucia = false; S.cau = null; S.pase = null;
  cerrarFormsFicha();
  $('#drawer').hidden = true; $('#drawer').innerHTML = ''; document.body.style.overflow = '';
}

// ───────────────────────── Pase a juicio desde Cobranzas ─────────────────────────
// El botón "Pasar a juicio" de Cobranzas abre el gestor con #desde-deudor=<id>: la ficha de una causa
// nueva, ya completa con los datos del deudor. Falta solo el N° de expediente del SAC. Al crearla, la
// base deja al deudor "En juicio" con ese expediente (disparador pase_a_juicio, migración 0016).
// Las cuentas son las de Cobranzas (sus módulos se cargan recién acá: el gestor abre sin ellos).

/** Un título por operación, con el saldo de sus cuotas vencidas, como los que se cargan a mano. */
function tituloDeOperacion(op, cs, fecha, calc, txt) {
  const tipo = !op ? 'pagare' : /prenda/i.test(op.tipo || '') ? 'prenda' : /cheque/i.test(op.tipo || '') ? 'cheque' : 'pagare';
  const monto = Math.round(cs.reduce((a, c) => a + c.saldo, 0) * 100) / 100;
  const p = cs[0], cuando = p.vto ? txt.fmtLargo(p.vto) : ''; // vienen en orden de vencimiento
  const desde = p.n == null ? (cuando ? `el ${cuando}` : '') : `${p.de == null ? 'el saldo de la cuota' : 'la cuota'} ${p.n}${cuando ? ` (${cuando})` : ''}`;
  const partes = [];
  if (op) {
    const nombreOp = tipo === 'prenda' ? 'Contrato de prenda' : (op.tipo || 'Operación');
    partes.push(`${nombreOp}${op.numero ? ' N° ' + op.numero : ''}${op.fecha ? ' del ' + txt.fmtLargo(op.fecha) : ''}.`);
    if (+op.cuotas) partes.push(`${op.cuotas} cuotas${+op.importe ? ' de ' + pesos(+op.importe) : ''}.`);
  }
  partes.push(`${desde ? 'Mora desde ' + desde + ': se' : 'Se'} reclaman ${calc.detalleCuotas({ fecha, cuotas: cs })}.`);
  return { tipo, monto, vence: p.vto || '', descripcion: partes.join(' '), vehiculo: tipo === 'prenda' ? txt.vehiculoTexto(op.vehiculo) : '' };
}

/** La causa nueva armada con los datos del deudor: demandado, títulos y un primer movimiento. */
function causaDesdeDeudor(d, calc, txt) {
  const hoy = iso(today()), liq = calc.liquidar(d, hoy);
  const opDe = new Map((d.cuotas || []).map((q) => [String(q.id ?? ''), String(q.op ?? '')]));
  const grupos = new Map(); // operación → sus cuotas vencidas con saldo
  for (const c of liq.cuotas.filter((x) => x.saldo > 0 && (!x.vto || x.vto <= hoy))) {
    const op = opDe.get(c.id) || '';
    if (!grupos.has(op)) grupos.set(op, []);
    grupos.get(op).push(c);
  }
  const ops = d.operaciones || [];
  const titulos = [...grupos].map(([id, cs]) => tituloDeOperacion(ops.find((o) => String(o.id) === id) || null, cs, hoy, calc, txt));
  const prendario = ops.some((o) => /prenda/i.test(o.tipo || '') || o.vehiculo);
  const c = {
    ...blank(),
    actor: /mutual\s+bell/i.test(d.acreedor || '') ? 'AMB' : (d.acreedor || blank().actor),
    demandado: d.nombre || '',
    tipo: prendario ? 'PRENDARIO' : 'EJECUTIVO',
    historial: [{ fecha: hoy, texto: 'Inicio del juicio: pasó desde Cobranzas' }],
    demandados: [{
      nombre: d.nombre || '', dni: d.dni || '', domicilio: d.domicilio || '', notas: d.socio ? `Socio N° ${d.socio}` : '',
      telefono: (d.telefonos || []).map((t) => t.numero).filter(Boolean).join(' / '),
    }],
    titulos,
    deudor: d.id,
  };
  Object.assign(c, ultimaDe(c.historial));
  return { causa: c, aVencer: liq.capital_a_vencer > 0 };
}

async function abrirDesdeDeudor(id) {
  let d;
  try { d = await leerDeudor(id); } catch (e) { toast(mensaje(e, 'no se pudo leer el deudor')); return; }
  if (!d) { toast('No encontré ese deudor en Cobranzas'); return; }
  if (d.expte) {
    if (D.causas.some((c) => c.expte === d.expte)) { openCausa(d.expte); toast('Ese deudor ya está en juicio: esta es su causa'); } else toast(`Ese deudor ya figura en juicio, con el expte. ${d.expte}`);
    return;
  }
  let calc, txt;
  try { [calc, txt] = await Promise.all([import('./cobranzas/calculo.js'), import('./cobranzas/textos.js')]); } catch { toast('Sin conexión: no se pudo armar la causa'); return; }
  const { causa, aVencer } = causaDesdeDeudor(d, calc, txt);
  openCausa(null, causa, { nombre: d.nombre, titulos: causa.titulos.length, aVencer, existe: '' });
  if (matchMedia('(pointer: fine)').matches) $('#c_expte')?.focus(); // en la PC, listo para escribir el número (en el celular no abre el teclado solo)
}

/** El aviso de arriba de una causa nueva que viene de Cobranzas (o el de un expediente que ya existe). */
function paseHtml() {
  const p = S.pase, c = S.open;
  if (p.existe) {
    const x = D.causas.find((k) => k.expte === p.existe);
    if (x?.deudor && x.deudor !== c.deudor) return `<div class="nota choque" role="alert"><p><b>El expediente ${esc(p.existe)} ya es una causa del gestor</b>, unida a otro deudor de Cobranzas: ${esc(caratula(x))}.</p><div class="actions"><button class="btn small" data-act="pase-revisar">Corregir el número</button></div></div>`;
    return `<div class="nota choque" role="alert"><p><b>El expediente ${esc(p.existe)} ya es una causa del gestor</b>${x ? ': ' + esc(caratula(x)) : ''}.</p>
      <p>Si es el juicio de ${esc(p.nombre)}, vinculala: la causa queda como está y el deudor pasa a “En juicio” en Cobranzas.</p>
      <div class="actions"><button class="btn small primary" data-act="pase-vincular">Vincular con esa causa</button><button class="btn small" data-act="pase-revisar">Corregir el número</button></div></div>`;
  }
  const tits = p.titulos === 1 ? 'Se cargó un título' : `Se cargaron ${p.titulos} títulos`;
  return `<div class="nota" role="status"><p><b>Viene de Cobranzas: ${esc(p.nombre)}.</b> Escribí el N° de expediente del SAC y revisá los datos antes de crearla.</p>
    <p class="hint">${p.titulos ? `${tits} con las cuotas vencidas e impagas.` : 'No tiene cuotas vencidas para cargar como título.'}${p.aVencer ? ' Las cuotas a vencer no están incluidas: si reclamás el total, ajustá el monto.' : ''} Al crear la causa, el deudor queda “En juicio” en Cobranzas.</p></div>`;
}

/** Enlaces desde las otras apps: #causa=<expte> abre esa causa; #desde-deudor=<id>, una nueva armada con ese deudor. */
function seguirEnlace() {
  const m = /^#(?:causa=(\d+)|desde-deudor=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))$/i.exec(location.hash || '');
  if (!m || S.pantalla !== 'listo' || !D.cargado) return;
  history.replaceState(null, '', location.pathname + location.search); // que no se repita al volver a cargar
  if (m[2]) { abrirDesdeDeudor(m[2].toLowerCase()); return; }
  if (D.causas.some((c) => c.expte === m[1])) openCausa(m[1]); else toast(`No encontré la causa ${m[1]}`);
}
window.addEventListener('hashchange', seguirEnlace);

// ───────────────────────── Liquidación ─────────────────────────
// En la ficha queda un resumen y el botón "Abrir planilla". La planilla ocupa toda la pantalla
// y se maneja como una hoja de Excel: los rubros en filas y cada orden de pago en una columna.

function liqHtml(c) {
  const l = c.liquidacion, h = '<h4>Liquidación y órdenes de pago</h4>';
  if (S.isNew) return `<div class="sec">${h}<p class="hint m0">La planilla de liquidación se carga una vez creada la causa.</p></div>`;
  if (!l) return `<div class="sec" id="secLiq">${h}<div class="liqpie"><span class="hint">Sin liquidación cargada.</span><button class="btn small primary" data-act="planilla">Cargar planilla</button></div></div>`;
  const k = liqCalc(l), n = l.pagos.length, emb = +l.embargo || 0;
  return `<div class="sec" id="secLiq">${h}
   <dl class="cifras"><div><dt>Total</dt><dd>${pesos(k.tot)}</dd></div><div><dt>Cobrado</dt><dd>${pesos(k.pag)}</dd></div><div><dt>Saldo</dt><dd>${pesos(k.saldo)}</dd></div></dl>
   ${emb && k.dif < 0 ? `<p class="malo m0">Faltante sobre el embargo: ${pesos(-k.dif)}. Pedir ampliación.</p>` : ''}
   ${S.liqSucia ? '<p class="sucio m0"><b>La planilla tiene cambios sin guardar.</b> Se guardan con “Guardar cambios”.</p>' : ''}
   <div class="liqpie"><span class="hint">${l.fecha ? 'Planilla del ' + fmt(l.fecha) + ' · ' : ''}${n ? n + (n === 1 ? ' orden de pago' : ' órdenes de pago') : 'Sin órdenes de pago'}</span><button class="btn small primary" data-act="planilla">Abrir planilla</button></div></div>`;
}

function totalesHtml(l) {
  const k = liqCalc(l), emb = +l.embargo || 0;
  return `<div><span>Total planilla</span><b>${pesos(k.tot)}</b></div><div><span>Cobrado por OP</span><b>${pesos(k.pag)}</b></div><div><span>Saldo pendiente</span><b>${pesos(k.saldo)}</b></div>` +
    (emb ? `<div class="${k.dif < 0 ? 'neg' : 'pos'}"><span>${k.dif < 0 ? 'Faltante: pedir ampliación de embargo' : 'Excedente sobre planilla'}</span><b>${pesos(Math.abs(k.dif))}</b></div>` : '<div><span>Embargo trabado</span><b>Sin cargar</b></div>');
}

function planillaHtml(c, entra) {
  const l = c.liquidacion, P = l.pagos, k = liqCalc(l);
  // Celda de importe: se escribe como en el expediente ("150.000" o "1.234,50"); Enter baja de fila.
  const celda = (id, v, r, col, nombre, extra = '') => `<input class="celda num" id="${id}" value="${esc(enCelda(v))}" inputmode="decimal" autocomplete="off" data-importe data-r="${r}" data-c="${col}" aria-label="${esc(nombre)}"${extra}>`;
  const cab = P.map((p, j) => `<th scope="col" class="opcol"><div class="opcab"><span class="oplbl" aria-hidden="true">OP N°</span><input class="celda op" id="pl_o${j}" value="${esc(p.op)}" placeholder="N° de OP" inputmode="numeric" autocomplete="off" aria-label="N° de la orden de pago ${j + 1}"><button class="x" data-act="pagdel" data-i="${j}" aria-label="Quitar la orden de pago ${esc(p.op || j + 1)}">×</button></div><input class="celda fecha" type="date" id="pl_f${j}" value="${esc(p.fecha)}" aria-label="Fecha de la orden de pago ${j + 1}"></th>`).join('');
  const filas = l.rubros.map((r, i) => {
    const nombre = r.rubro || `rubro ${i + 1}`, saldo = (+r.monto || 0) - (+r.pagado || 0);
    return `<tr><th scope="row" class="rub"><div class="rubcab"><input class="celda txt" id="pl_r${i}" value="${esc(r.rubro)}" placeholder="Nombre del rubro" autocomplete="off" data-r="${i}" data-c="r" aria-label="Rubro ${i + 1}"><button class="x" data-act="rubdel" data-i="${i}" aria-label="Quitar ${esc(nombre)}">×</button></div></th>
     <td>${celda('pl_m' + i, r.monto, i, 'm', 'Monto de ' + nombre, ' placeholder="0"')}</td><td class="calc" id="pl_c${i}">${pesos(r.pagado)}</td><td class="calc${saldo < 0 ? ' neg' : ''}" id="pl_s${i}">${pesos(saldo)}</td>
     ${P.map((p, j) => `<td>${celda(`pl_i${i}_${j}`, p.imp[r.id], i, j, `${p.op ? 'OP N° ' + p.op : 'Orden de pago ' + (j + 1)}: imputado a ${nombre}`)}</td>`).join('')}</tr>`;
  }).join('');
  return `<div class="scrim"></div><aside class="panel max plan${entra ? ' entra' : ''}" role="dialog" aria-modal="true" aria-label="Planilla de liquidación">
  <div class="phead"><div><div class="hint">Planilla de liquidación · Expte. ${esc(c.expte)}</div><h2>${esc(caratula(c))}</h2></div>
   <div class="btns"><button class="btn small" data-act="plexcel">Descargar en Excel</button><button class="btn small" data-act="plvolver">Volver a la ficha</button></div></div>
  <div id="nota">${notaHtml()}</div>
  <div class="sec">
   <div class="grid2 plcampos"><label class="f">Fecha de la liquidación<input type="date" id="pl_fecha" value="${esc(l.fecha)}"></label><label class="f">Embargo trabado ($)<input id="pl_emb" value="${esc(enCelda(l.embargo))}" placeholder="0" inputmode="decimal" autocomplete="off" data-importe></label></div>
   <div class="hoja" id="pl_hoja"><table class="planilla"><thead><tr><th scope="col" class="rub">Rubro</th><th scope="col">Monto</th><th scope="col">Cobrado</th><th scope="col">Saldo</th>${cab}</tr></thead>
    <tbody>${filas}</tbody>
    <tfoot><tr><th scope="row" class="rub">Total</th><td class="calc" id="pl_tm">${pesos(k.tot)}</td><td class="calc" id="pl_tc">${pesos(k.pag)}</td><td class="calc" id="pl_ts">${pesos(k.saldo)}</td>${P.map((p, j) => `<td class="calc" id="pl_t${j}">${pesos(totalPago(p))}</td>`).join('')}</tr></tfoot></table></div>
   <div class="actions"><button class="btn small" data-act="rubadd">+ Rubro</button><button class="btn small" data-act="pagadd">+ Orden de pago</button>${P.length ? '' : '<span class="hint">Todavía no hay órdenes de pago: cada una se agrega como una columna.</span>'}</div>
   <p class="hint m0">Escribí los importes como en el expediente (150.000 o 1.234,50). Cobrado, saldo y totales se calculan solos. Enter baja a la fila de abajo.</p>
   <div class="totals" id="pl_totales">${totalesHtml(l)}</div>
  </div>
  <div class="ppie"><button class="btn primary" data-act="plsave">Guardar planilla</button><button class="btn" data-act="plvolver">Volver a la ficha</button><span class="hint">Se guarda en el gestor. El Excel es una copia para abrir, imprimir o mandar.</span></div>
  </aside>`;
}

/** Pasa lo que está escrito en la planilla a la liquidación de la causa abierta. */
function leerPlanilla(l) {
  const el = (id) => document.getElementById(id);
  if (el('pl_fecha')) l.fecha = el('pl_fecha').value;
  if (el('pl_emb')) l.embargo = importe(el('pl_emb').value);
  l.rubros.forEach((r, i) => {
    if (el('pl_r' + i)) r.rubro = el('pl_r' + i).value.trim();
    if (el('pl_m' + i)) r.monto = importe(el('pl_m' + i).value);
  });
  l.pagos.forEach((p, j) => {
    if (el('pl_o' + j)) p.op = el('pl_o' + j).value.trim();
    if (el('pl_f' + j)) p.fecha = el('pl_f' + j).value;
    const imp = {};
    l.rubros.forEach((r, i) => { const v = el(`pl_i${i}_${j}`); const n = v ? Math.max(0, importe(v.value)) : (+p.imp[r.id] || 0); if (n) imp[r.id] = n; });
    p.imp = imp;
  });
  l.rubros.forEach((r) => { r.pagado = cobradoRubro(l, r.id); });
}

/** Recalcula cobrado, saldo y totales mientras se escribe, sin redibujar (no se pierde el cursor). */
function recalcPlanilla() {
  const l = S.open?.liquidacion; if (!S.planilla || !l) return;
  leerPlanilla(l); S.liqSucia = true;
  const poner = (id, n) => { const e = document.getElementById(id); if (e) { e.textContent = pesos(n); e.classList.toggle('neg', n < 0); } };
  l.rubros.forEach((r, i) => { poner('pl_c' + i, r.pagado); poner('pl_s' + i, (+r.monto || 0) - (+r.pagado || 0)); });
  l.pagos.forEach((p, j) => poner('pl_t' + j, totalPago(p)));
  const k = liqCalc(l); poner('pl_tm', k.tot); poner('pl_tc', k.pag); poner('pl_ts', k.saldo);
  const t = document.getElementById('pl_totales'); if (t) t.innerHTML = totalesHtml(l);
}

function abrirPlanilla() {
  const c = S.open;
  if (!c.liquidacion) { c.liquidacion = nuevaLiquidacion(iso(today())); S.liqSucia = true; }
  S.planilla = true; renderDrawer(true); $('.panel').scrollTop = 0;
}
function volverAFicha() {
  S.planilla = false; renderDrawer();
  $('#secLiq')?.scrollIntoView({ block: 'center' });
}

const CAMPOS_FICHA = ['actor', 'demandado', 'tipo', 'nom', 'oficina', 'ubicacion', 'estado', 'cautelar', 'situacion', 'proxima', 'vence', 'ultima', 'fecha', 'notas', 'historial', 'demandados', 'titulos'];
/**
 * Guarda solo la liquidación, sin cerrar: la planilla sigue abierta para seguir cargando.
 * Con `forzar` (la persona eligió guardarla aunque la causa haya cambiado desde otro lado) pisa
 * la liquidación y nada más: lo que Claude haya cambiado en el resto de la causa se conserva.
 */
async function guardarPlanilla(boton, forzar = false) {
  const c = S.open; leerPlanilla(c.liquidacion);
  await conBoton(boton, 'Guardando…', async () => {
    try {
      const r = await actualizarCausa(c.expte, forzar ? null : c.rev, { liquidacion: c.liquidacion });
      if (r.conflicto) { S.choque = { actual: r.actual }; rerenderDrawer(); $('.panel').scrollTop = 0; return; }
      // La causa queda como está en la base, más lo que se haya cambiado en la ficha y todavía no se guardó.
      const nueva = copia(r.fila);
      CAMPOS_FICHA.forEach((k) => { if (JSON.stringify(c[k] ?? null) !== JSON.stringify(S.base?.[k] ?? null)) nueva[k] = c[k]; });
      nueva.liquidacion = c.liquidacion;
      S.open = nueva; S.base = copia(r.fila); S.liqSucia = false; S.choque = null;
      const n = $('#nota'); if (n) n.innerHTML = notaHtml();
      toast('Planilla guardada');
    } catch (e) { toast(mensaje(e)); }
  });
}

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function descargarPlanilla() {
  const c = S.open; if (!c?.liquidacion) return;
  const nombre = ['liquidacion', c.expte, slug(titulo(c)), iso(today())].filter(Boolean).join('-') + '.xlsx';
  let archivo;
  try { archivo = planillaExcel({ caratula: caratula(c), expte: c.expte, nom: c.nom, oficina: c.oficina, liquidacion: c.liquidacion }, iso(today())); } catch (e) { console.error(e); toast('No se pudo armar el Excel'); return; }
  entregar(archivo, nombre).then((ok) => { if (ok) toast('Archivo listo: ' + nombre); }, () => toast('No se pudo descargar el archivo en este dispositivo'));
}

/**
 * En el celular abre el menú de compartir (Excel, Drive, WhatsApp…); en la computadora lo
 * descarga. Devuelve false si la persona cerró el menú sin elegir nada.
 */
async function entregar(blob, nombre) {
  const archivo = typeof File === 'function' ? new File([blob], nombre, { type: blob.type }) : null;
  if (movil.matches && archivo && navigator.canShare?.({ files: [archivo] })) {
    try { await navigator.share({ files: [archivo], title: nombre }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}


// ───────────────────────── Demandados y monto reclamado ─────────────────────────

const TASA_MENSUAL = 0.05; // interés judicial simple: 5% del capital por cada 30 días desde el vencimiento
const DEM_VACIO = () => ({ nombre: '', dni: '', telefono: '', domicilio: '', notas: '' });
const TIT_VACIO = (tipo = 'pagare') => ({ tipo, monto: 0, vence: '', descripcion: '', vehiculo: '' });
/** Capital + interés simple por título, a la fecha de hoy. Sin vencimiento o aún no vencido: sin interés. */
function reclamo(c) {
  const filas = (c.titulos || []).map((t) => {
    const capital = +t.monto || 0, dias = Math.max(0, days(t.vence) ?? 0);
    const interes = Math.round(capital * TASA_MENSUAL * dias / 30 * 100) / 100;
    return { capital, dias, interes, total: capital + interes };
  });
  const suma = (k) => filas.reduce((a, f) => a + f[k], 0);
  return { filas, capital: suma('capital'), interes: suma('interes'), total: suma('total') };
}
/** Número para wa.me: sin signos, con 54 9 delante si es un celular argentino escrito con el código de área. */
function numWhatsapp(tel) {
  let n = String(tel || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!n) return '';
  if (n.startsWith('549')) return n;
  if (n.startsWith('54')) return '549' + n.slice(2);
  return n.length <= 10 ? '549' + n : n;
}
function demandadosHtml(c) {
  const lista = c.demandados || [];
  return `<div class="sec"><h4>Demandados</h4>
   ${lista.length ? lista.map((d, i) => { const wa = numWhatsapp(d.telefono); return `<div class="tarjeta" data-i="${i}">
     <div class="grid2">
      <label class="f ancho">Nombre<input id="d_nombre${i}" value="${esc(d.nombre)}"></label>
      <label class="f">DNI / CUIT<input id="d_dni${i}" value="${esc(d.dni)}"></label>
      <label class="f">Teléfono / WhatsApp<input id="d_telefono${i}" inputmode="tel" value="${esc(d.telefono)}" placeholder="Con código de área, sin 0 ni 15"></label>
      <label class="f ancho">Domicilio<input id="d_domicilio${i}" value="${esc(d.domicilio)}"></label>
      <label class="f ancho">Notas<input id="d_notas${i}" value="${esc(d.notas)}"></label>
     </div>
     <div class="actions">${wa ? `<a class="btn small" href="https://wa.me/${wa}" target="_blank" rel="noopener">Abrir WhatsApp</a>` : ''}<button class="btn small danger" data-act="demdel" data-i="${i}">Quitar</button></div>
    </div>`; }).join('') : '<p class="hint m0">Sin demandados cargados.</p>'}
   <div><button class="btn small" data-act="demadd">+ Demandado</button></div></div>`;
}
function titulosHtml(c) {
  const lista = c.titulos || [], k = reclamo(c);
  return `<div class="sec"><h4>Títulos y monto reclamado</h4>
   ${lista.length ? lista.map((t, i) => { const f = k.filas[i]; return `<div class="tarjeta" data-i="${i}">
     <div class="grid2">
      <label class="f">Tipo<select id="t_tipo${i}" data-i="${i}"><option value="pagare" ${t.tipo === 'pagare' ? 'selected' : ''}>Pagaré</option><option value="cheque" ${t.tipo === 'cheque' ? 'selected' : ''}>Cheque</option><option value="prenda" ${t.tipo === 'prenda' ? 'selected' : ''}>Prenda</option></select></label>
      <label class="f">Monto ($)<input type="number" min="0" id="t_monto${i}" value="${+t.monto || 0}"></label>
      <label class="f">Vencimiento<input type="date" id="t_vence${i}" value="${esc(t.vence)}"></label>
      <label class="f ancho">Detalle<input id="t_descripcion${i}" value="${esc(t.descripcion)}" placeholder="${t.tipo === 'prenda' ? 'Ej.: Prenda N° …' : t.tipo === 'cheque' ? 'Ej.: Cheque N° …, Banco …' : 'Ej.: Pagaré N° 1'}"></label>
      ${t.tipo === 'prenda' ? `<label class="f ancho">Vehículo<input id="t_vehiculo${i}" value="${esc(t.vehiculo)}" placeholder="Marca, modelo, dominio"></label>` : ''}
     </div>
     <div class="resumen"><span>${f.dias ? f.dias + ' días de mora' : t.vence ? 'No vencido' : 'Sin vencimiento'}</span><span>Interés <b>${money(f.interes)}</b></span><span>Con interés <b>${money(f.total)}</b></span>
      <button class="btn small danger" data-act="titdel" data-i="${i}">Quitar</button></div>
    </div>`; }).join('') : '<p class="hint m0">Sin títulos cargados.</p>'}
   <div class="actions"><button class="btn small" data-act="titadd" data-t="pagare">+ Pagaré</button><button class="btn small" data-act="titadd" data-t="cheque">+ Cheque</button><button class="btn small" data-act="titadd" data-t="prenda">+ Prenda</button></div>
   ${lista.length ? `<div class="totals"><div><span>Capital</span><b>${money(k.capital)}</b></div><div><span>Intereses al ${fmt(iso(today()))} (${Math.round(TASA_MENSUAL * 100)}% mensual simple)</span><b>${money(k.interes)}</b></div><div><span>Total reclamado</span><b>${money(k.total)}</b></div></div>` : ''}</div>`;
}

// ───────────────────────── Acción cautelar ─────────────────────────
// Desde la ficha: embargo de haberes o secuestro automotor. La app completa el oficio (un modelo de
// la biblioteca de plantillas) y el escrito "Solicita…" con los datos de la causa, y pide en un
// formulario lo que la causa no tiene. Al confirmar, el escrito queda en la agenda agendado para
// hoy, con el oficio adjunto: se presenta recién cuando la persona toca «Presentar ahora» y la
// tarea de Claude lo sube al SAC junto con el oficio. Ver docs/oficio.js y la migración 0013.

/** El modelo de la biblioteca (la persona lo puede corregir en Plantillas) o, si lo borró, el original. */
const modeloDe = (id) => { const p = D.plantillas.find((x) => x.id === id); return p ? { titulo: p.titulo, cuerpo: p.cuerpo } : MODELOS[id]; };

// Campos del formulario: [campo, etiqueta, clase, ayuda, teclado]
const CAMPOS_CAU = {
  embargo: [
    ['persona', 'Demandado (como va en el oficio)', 'ancho'], ['dni', 'DNI'],
    ['empleador', 'Empleador', 'ancho', 'Ej.: EMPRESA SRL'], ['cuit_empleador', 'CUIT del empleador', '', 'Opcional', 'numerico'],
    ['domicilio_empleador', 'Domicilio del empleador', 'ancho', 'Opcional'],
    ['monto', 'Hasta cubrir la suma de ($)', '', '', 'importe'], ['cuenta_judicial', 'Cuenta judicial N°', '', 'Ej.: 305/1234567'],
    ['cbu', 'CBU de la cuenta judicial', 'ancho', '22 números', 'numerico'],
  ],
  secuestro: [
    ['persona', 'Demandado (como va en el oficio)', 'ancho'], ['dni', 'DNI'],
    ['calle', 'Calle del domicilio'], ['numero', 'Número'], ['localidad', 'Ciudad'],
    ['marca', 'Marca'], ['dominio', 'Dominio'], ['anio_vehiculo', 'Año', '', 'Opcional', 'numerico'], ['modelo', 'Modelo', 'ancho'],
    ['motor', 'N° de motor'], ['chasis', 'N° de chasis'],
    ['sede_oficial', 'Sede del oficial de justicia', 'ancho', 'Opcional: si queda vacío, el oficio no lleva esa línea'],
  ],
  comunes: [['autos', 'Autos (actor c/ demandado)', 'ancho'], ['tipo_oficio', 'Tipo de juicio'], ['nom', 'Nominación', '', '', 'numerico'], ['ciudad', 'Ciudad de la fecha']],
};
// Lo que se repite de una vez a la otra en la misma causa: se propone lo último que se usó.
const RECORDAR = { embargo: ['empleador', 'cuit_empleador', 'domicilio_empleador', 'cuenta_judicial', 'cbu'], secuestro: ['sede_oficial'] };

/** Los datos del último oficio de ese modelo en la causa (si ya se pidió antes). */
function ultimosDatos(expte, modelo) {
  const previos = D.agenda.filter((a) => a.expte === expte && a.estado !== 'cancelado')
    .flatMap((a) => (a.adjuntos || []).filter((x) => x.modelo === modelo).map((x) => ({ creado: a.creado || '', datos: x.datos || {} })))
    .sort((a, b) => b.creado.localeCompare(a.creado));
  return previos[0]?.datos || {};
}

/** Monto propuesto para el embargo: el total de la planilla si hay; si no, el reclamado con intereses al día. */
function montoEmbargo(c) {
  if (c.liquidacion) { const k = liqCalc(liqNormal(copia(c.liquidacion))); if (k.tot > 0) return { monto: k.tot, base: `Total de la planilla de liquidación: ${pesos(k.tot)}` }; }
  const r = reclamo(c);
  return r.total > 0 ? { monto: Math.round(r.total), base: `Capital ${money(r.capital)} + intereses al ${fmt(iso(today()))} ${money(r.interes)}` } : { monto: 0, base: '' };
}

let fuentesOficio = null, cargandoFuentes = null;
/** Las tipografías del oficio se bajan una vez, cuando hacen falta (y quedan guardadas para usar sin conexión). */
function cargarFuentes() {
  if (fuentesOficio) return Promise.resolve(fuentesOficio);
  if (!cargandoFuentes) {
    cargandoFuentes = Promise.all(['eb-garamond-400', 'eb-garamond-700', 'caladea-400'].map((n) => fetch(`fonts/${n}.ttf`).then((r) => { if (!r.ok) throw new Error(n); return r.arrayBuffer(); })))
      .then(([a, b, c]) => (fuentesOficio = { cuerpo: new Uint8Array(a), negrita: new Uint8Array(b), encabezado: new Uint8Array(c) }))
      .finally(() => { cargandoFuentes = null; });
  }
  return cargandoFuentes;
}

/** Arma el PDF y lo entrega (menú de compartir en el celular, descarga en la computadora). */
async function verPdf(doc, nombre) {
  let f = fuentesOficio;
  if (!f) { try { f = await cargarFuentes(); } catch { toast('No se pudo armar el PDF: faltan las tipografías del oficio. Revisá la conexión'); return; } }
  let pdf;
  try { pdf = pdfOficio(doc, f, { titulo: nombre.replace(/\.pdf$/i, '') }); } catch (e) { console.error(e); toast('No se pudo armar el PDF del oficio'); return; }
  entregar(new Blob([pdf], { type: 'application/pdf' }), nombre).then((ok) => { if (ok) toast('PDF listo: ' + nombre); }, () => toast('No se pudo abrir el PDF en este dispositivo'));
}

function abrirCautelar(tipo = '') {
  S.cau = { tipo: '' };
  cargarFuentes().catch(() => { /* se reintenta al ver el PDF */ });
  if (ACCIONES[tipo]) elegirCautelar(tipo, true); else renderDrawer(true);
}

/** Elige la acción y completa el formulario con lo que sale de la causa (y lo último que se usó en ella). */
function elegirCautelar(tipo, entra = false) {
  const c = S.open, def = ACCIONES[tipo];
  const base = datosDeCausa(c, 0);
  const campos = { ...base };
  const antes = ultimosDatos(c.expte, def.oficio);
  for (const k of RECORDAR[tipo]) if (antes[k]) campos[k] = antes[k];
  let enervar = false, baseMonto = '';
  if (tipo === 'embargo') {
    const m = montoEmbargo(c);
    campos.monto = m.monto ? enCelda(m.monto) : '';
    baseMonto = m.base;
  } else {
    campos.monto = base.monto_prenda ? enCelda(base.monto_prenda) : '';
    enervar = !!base.monto_prenda;
  }
  delete campos.monto_prenda;
  S.cau = { tipo, dem: 0, campos, enervar, baseMonto, tocado: false, faltan: [] };
  const e = escritoCau();
  S.cau.titulo = e.titulo; S.cau.cuerpo = e.cuerpo;
  renderDrawer(entra);
  $('.panel').scrollTop = 0;
}

/** Cambia el demandado elegido: trae su nombre, DNI y (para el secuestro) su domicilio. */
function elegirDemandado(i) {
  const k = S.cau, d = (S.open.demandados || [])[i];
  if (!d) return;
  k.dem = i;
  Object.assign(k.campos, { persona: String(d.nombre || '').trim().toLocaleUpperCase('es'), dni: dniOficio(d.dni) });
  if (k.tipo === 'secuestro') Object.assign(k.campos, partirDomicilio(d.domicilio));
  if (!k.tocado) Object.assign(k, escritoCau());
  rerenderDrawer();
}

/** Los datos para completar el oficio y el escrito, con el monto escrito en números y en letras. */
function datosCau() {
  const k = S.cau, v = { ...k.campos }, c = S.open;
  v.nom_ordinal = ordinal(v.nom);
  const n = importe(v.monto);
  const usar = k.tipo !== 'secuestro' || k.enervar;
  v.monto = usar && n > 0 ? cifra(n) : '';
  v.monto_letras = usar && n > 0 ? enLetras(n) : '';
  // Los campos de siempre de las plantillas, por si el escrito los usa.
  return { caratula: caratula(c), actor: c.actor, demandado: c.demandado, tipo: c.tipo, nominacion: c.nom ? c.nom + '°' : '', oficina: c.oficina, ...v, expediente: c.expte };
}
const oficioCau = (marcar = false) => rellenar(modeloDe(ACCIONES[S.cau.tipo].oficio).cuerpo, datosCau(), { marcar });
function escritoCau() {
  const m = modeloDe(ACCIONES[S.cau.tipo].escrito), v = datosCau();
  return { titulo: rellenar(m.titulo, v).texto.trim(), cuerpo: rellenar(m.cuerpo, v).texto.replace(/\s+$/, '') };
}

/** Lo que dice el formulario pasa a S.cau (sin redibujar: no se pierde el foco). */
function leerCautelar() {
  const k = S.cau; if (!k?.tipo) return;
  for (const [campo] of [...CAMPOS_CAU[k.tipo], ...CAMPOS_CAU.comunes]) { const el = document.getElementById('cau_' + campo); if (el) k.campos[campo] = el.value; }
  const m = document.getElementById('cau_monto'); if (m) k.campos.monto = m.value;
  const en = document.getElementById('cau_enervar'); if (en) k.enervar = en.checked;
  const t = document.getElementById('cau_tit'), cu = document.getElementById('cau_cue');
  if (t) k.titulo = t.value; if (cu) k.cuerpo = cu.value;
}

function faltanHtml(faltan) {
  return faltan.length
    ? `<span class="malo">Falta completar: ${esc(faltan.map((f) => CAMPOS_OFICIO[f] || f).join(', '))}.</span>`
    : 'Está todo: el oficio se ve como va a quedar en el PDF.';
}

/** Vista previa, aviso de lo que falta y escrito (si la persona no lo tocó), mientras se escribe. */
function refrescarCautelar() {
  const k = S.cau; if (!k?.tipo) return;
  const of = oficioCau(true);
  k.faltan = of.faltan;
  const vista = $('#cau_vista'); if (vista) vista.innerHTML = htmlOficio(of.texto);
  const f = $('#cau_faltan'); if (f) f.innerHTML = faltanHtml(of.faltan);
  document.querySelectorAll('.cautelar input.falta').forEach((el) => { if (el.value.trim()) el.classList.remove('falta'); });
  if (!k.tocado) {
    const e = escritoCau(); k.titulo = e.titulo; k.cuerpo = e.cuerpo;
    const t = $('#cau_tit'), cu = $('#cau_cue');
    if (t && t !== document.activeElement) t.value = e.titulo;
    if (cu && cu !== document.activeElement) cu.value = e.cuerpo;
  }
}

function cautelarHtml(c, entra) {
  const k = S.cau, def = ACCIONES[k.tipo];
  const cab = (titulo) => `<div class="phead"><div><div class="hint">Acción cautelar · Expte. ${esc(c.expte)}</div><h2>${esc(titulo)}</h2></div><div class="btns"><button class="btn small" data-cau="volver">Volver a la ficha</button></div></div>`;
  if (!def) {
    return `<div class="scrim"></div><aside class="panel cautelar${entra ? ' entra' : ''}" role="dialog" aria-modal="true" aria-label="Acción cautelar">
     ${cab(caratula(c))}
     <div class="sec"><h4>¿Qué acción cautelar querés pedir?</h4>
      <div class="opciones">
       <button class="opcion" data-cau="elegir" data-tipo="embargo"><b>1. ${esc(ACCIONES.embargo.pregunta)}</b><span>Oficio al empleador del demandado, para que retenga del sueldo la parte que permite la ley.</span></button>
       <button class="opcion" data-cau="elegir" data-tipo="secuestro"><b>2. ${esc(ACCIONES.secuestro.pregunta)}</b><span>Oficio al oficial de justicia, para secuestrar el vehículo prendado y dejarlo al martillero.</span></button>
      </div>
      <p class="hint m0">La app arma el oficio y el escrito con los datos de la causa; lo que falte, te lo pide. Al confirmar, el escrito queda listo para presentar en el SAC con el oficio adjunto.</p>
     </div><div class="pfin"></div></aside>`;
  }
  const campo = ([id, etiqueta, clase = '', ayuda = '', teclado = ''], extra = '') => `<label class="f${clase ? ' ' + clase : ''}">${esc(etiqueta)}<input id="cau_${id}" value="${esc(k.campos[id] ?? '')}"${ayuda ? ` placeholder="${esc(ayuda)}"` : ''}${teclado === 'importe' ? ' inputmode="decimal" data-importe' : teclado === 'numerico' ? ' inputmode="numeric"' : ''} autocomplete="off"${extra}></label>`;
  const dems = c.demandados || [];
  const elegir = dems.length > 1 ? `<label class="f ancho">¿A cuál de los demandados?<select id="cau_dem">${dems.map((d, i) => `<option value="${i}" ${i === k.dem ? 'selected' : ''}>${esc(d.nombre || 'Demandado ' + (i + 1))}${d.dni ? ' · ' + esc(d.dni) : ''}</option>`).join('')}</select></label>` : '';
  let monto = '';
  if (k.tipo === 'secuestro') {
    monto = `<label class="chk ancho"><input type="checkbox" id="cau_enervar" ${k.enervar ? 'checked' : ''}><span>El demandado puede enervar el secuestro pagando una suma (el capital reclamado de la prenda)</span></label>
     ${k.enervar ? campo(['monto', 'Suma para enervar el secuestro ($)', '', '', 'importe']) : ''}`;
  }
  const lista = CAMPOS_CAU[k.tipo].map((x) => campo(x)).join('');
  const of = oficioCau(true);
  k.faltan = of.faltan;
  const repetido = agendaAbierta(c.expte).find((a) => a.titulo.trim().toLowerCase() === String(k.titulo || '').trim().toLowerCase());
  return `<div class="scrim"></div><aside class="panel max cautelar${entra ? ' entra' : ''}" role="dialog" aria-modal="true" aria-label="${esc(def.titulo)}">
   ${cab(def.titulo)}
   <p class="hint m0">${esc(caratula(c))}</p>
   ${repetido ? `<p class="sucio m0">Esta causa ya tiene “${esc(repetido.titulo)}” en Escritos para el SAC (${esc(estadoAg(repetido)[0].toLowerCase())}). Si confirmás, queda otro.</p>` : ''}
   <div class="caugrid">
    <div class="caucol">
     <div class="sec"><h4>Datos del oficio</h4>
      <div class="grid2">${elegir}${lista}${monto}</div>
      ${k.tipo === 'embargo' && k.baseMonto ? `<p class="hint m0">Propuesto: ${esc(k.baseMonto)}. Cambialo si corresponde otro monto.</p>` : ''}
      <details class="caumas"><summary>Carátula, nominación y fecha del oficio</summary><div class="grid2">${CAMPOS_CAU.comunes.map((x) => campo(x)).join('')}</div></details>
     </div>
     <div class="sec"><h4>Escrito para el SAC</h4>
      <label class="f">Título<input id="cau_tit" value="${esc(k.titulo)}"></label>
      <label class="f">Texto del escrito<textarea id="cau_cue" rows="11">${esc(k.cuerpo)}</textarea></label>
      <p class="hint m0">Sale de la plantilla “${esc(modeloDe(def.escrito).titulo)}”. El encabezado (“Señor/a Juez: …”) lo pone el SAC.${k.tocado ? ' <button class="btn small" data-cau="rehacer">Volver a armarlo con los datos</button>' : ''}</p>
     </div>
    </div>
    <div class="sec cauvista"><h4>Vista previa del oficio</h4>
     <div class="ofmarco" id="cau_vista">${htmlOficio(of.texto)}</div>
     <p class="hint m0" id="cau_faltan">${faltanHtml(of.faltan)}</p>
     <div class="actions"><button class="btn small" data-cau="pdf">Ver el oficio en PDF</button></div>
    </div>
   </div>
   <div class="ppie"><button class="btn primary" data-cau="confirmar">Confirmar solicitud</button><button class="btn" data-cau="otra">Elegir otra acción</button><span class="hint">Queda en “Escritos para el SAC” con el oficio adjunto. Para presentarlo, tocás “Presentar ahora”.</span></div>
  </aside>`;
}

/** Lo que falta para confirmar: los campos del oficio, la suma (si puede enervar) y el CBU de 22 números. */
function problemasCautelar() {
  const k = S.cau, of = oficioCau(false), faltan = [...of.faltan];
  if (k.tipo === 'secuestro' && k.enervar && !(importe(k.campos.monto) > 0) && !faltan.includes('monto')) faltan.push('monto');
  const avisos = [];
  if (faltan.length) avisos.push('Falta completar: ' + faltan.map((f) => CAMPOS_OFICIO[f] || f).join(', '));
  const cbu = String(k.campos.cbu || '').replace(/\D/g, '');
  if (k.tipo === 'embargo' && cbu && cbu.length !== 22) avisos.push('El CBU tiene que tener 22 números');
  if (!String(k.titulo || '').trim() || !String(k.cuerpo || '').trim()) avisos.push('Falta el título o el texto del escrito');
  return { faltan, avisos, doc: of.texto };
}

async function confirmarCautelar(boton) {
  leerCautelar();
  const k = S.cau, c = S.open, def = ACCIONES[k.tipo];
  const p = problemasCautelar();
  if (p.avisos.length) {
    p.faltan.forEach((f) => document.getElementById('cau_' + f)?.classList.add('falta'));
    if (p.faltan.some((f) => CAMPOS_CAU.comunes.some(([x]) => x === f))) { const d = $('.caumas'); if (d) d.open = true; }
    toast(p.avisos.join('. '));
    return;
  }
  // Se guardan los datos de esta acción (para proponerlos la próxima vez), no todo lo que salió de la causa.
  const datos = Object.fromEntries([...CAMPOS_CAU[k.tipo], ...CAMPOS_CAU.comunes].map(([x]) => [x, k.campos[x] ?? '']));
  datos.monto = k.campos.monto ?? '';
  if (k.tipo === 'secuestro') datos.enervar = k.enervar;
  const fila = {
    expte: c.expte, titulo: k.titulo.trim(), cuerpo: k.cuerpo.replace(/\s+$/, ''), fecha: iso(today()), estado: 'pendiente', realizar: '',
    adjuntos: [{ nombre: nombreArchivo(def.archivo, c.expte), modelo: def.oficio, doc: p.doc, datos }],
  };
  await conBoton(boton, 'Guardando…', async () => {
    try {
      await crearEscrito(fila);
      S.cau = null;
      renderDrawer();
      $('#agendaFicha')?.scrollIntoView({ block: 'center' });
      toast(`Listo: “${fila.titulo}” quedó en Escritos para el SAC con el oficio adjunto. Para presentarlo, tocá “Presentar ahora”`);
    } catch (e) { toast(mensaje(e)); }
  });
}

async function cauAct(b) {
  const a = b.dataset.cau;
  if (a === 'volver') { S.cau = null; renderDrawer(); $('#secCautelar')?.scrollIntoView({ block: 'center' }); return; }
  if (a === 'otra') { S.cau = { tipo: '' }; renderDrawer(); $('.panel').scrollTop = 0; return; }
  if (a === 'elegir') { elegirCautelar(b.dataset.tipo); return; }
  leerCautelar();
  if (a === 'rehacer') { S.cau.tocado = false; Object.assign(S.cau, escritoCau()); rerenderDrawer(); return; }
  if (a === 'pdf') {
    const p = problemasCautelar();
    if (p.faltan.length) { toast('Para ver el PDF, completá: ' + p.faltan.map((f) => CAMPOS_OFICIO[f] || f).join(', ')); return; }
    await verPdf(p.doc, nombreArchivo(ACCIONES[S.cau.tipo].archivo, S.open.expte));
    return;
  }
  if (a === 'confirmar') await confirmarCautelar(b);
}

// Aviso dentro de la ficha cuando la causa cambió desde otro lado (Claude, otro dispositivo).
function notaHtml() {
  const c = S.open;
  if (c && S.isNew && S.pase) return paseHtml();
  if (!c || S.isNew) return '';
  if (S.choque) {
    if (!S.choque.actual) return `<div class="nota choque" role="alert"><p><b>Esta causa fue eliminada desde otro lugar</b> mientras la tenías abierta.</p>
      <div class="actions"><button class="btn small" data-act="choque-crear">Volver a crearla con estos datos</button><button class="btn small" data-act="close">Cerrar sin guardar</button></div></div>`;
    const a = S.choque.actual;
    return `<div class="nota choque" role="alert"><p><b>No se guardó:</b> ${esc(a.actualizado_por || 'alguien')} modificó esta causa ${a.actualizado ? cuando(new Date(a.actualizado)) : 'recién'}, mientras la editabas.</p>
      <div class="actions"><button class="btn small" data-act="choque-ver">Ver la versión actual (descarta lo mío)</button><button class="btn small" data-act="choque-pisar">${S.planilla ? 'Guardar mi planilla igual' : 'Guardar lo mío igual'}</button></div></div>`;
  }
  const actual = D.causas.find((x) => x.expte === c.expte);
  if (!actual) return `<div class="nota" role="status"><p><b>Esta causa fue eliminada desde otro lugar.</b></p></div>`;
  if (actual.rev !== c.rev) return `<div class="nota" role="status"><p><b>${esc(actual.actualizado_por || 'Alguien')} actualizó esta causa</b> ${actual.actualizado ? cuando(new Date(actual.actualizado)) : 'recién'}. Lo que ves acá es la versión anterior.</p>
      <div class="actions"><button class="btn small" data-act="choque-ver">Ver la versión actual</button></div></div>`;
  return '';
}

function renderDrawer(entra = false) {
  const c = S.open, d = $('#drawer'); d.hidden = false; document.body.style.overflow = 'hidden';
  if (c.liquidacion) liqNormal(c.liquidacion);
  if (S.planilla && c.liquidacion) { d.innerHTML = planillaHtml(c, entra); return; }
  S.planilla = false;
  if (S.cau && !S.isNew) { d.innerHTML = cautelarHtml(c, entra); return; }
  S.cau = null;
  const hist =(c.historial || []).map((h, i) => ({ ...h, i })).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || b.i - a.i);
  const meta = !S.isNew && c.actualizado ? ` · último cambio ${cuando(new Date(c.actualizado))}${c.actualizado_por ? ' (' + esc(c.actualizado_por) + ')' : ''}` : '';
  d.innerHTML = `<div class="scrim" data-act="close"></div><aside class="panel${entra ? ' entra' : ''}${S.maxi ? ' max' : ''}" role="dialog" aria-modal="true" aria-label="Ficha de la causa">
  <div class="phead"><div><div class="hint">${S.isNew ? 'Nueva causa' : 'Expte. ' + esc(c.expte) + meta}${!S.isNew && c.deudor ? ` · <a href="cobranzas/#deudor=${esc(c.deudor)}" target="_blank" rel="noopener">Ver en Cobranzas</a>` : ''}</div><h2>${esc(S.isNew && !c.demandado ? 'Nueva causa' : caratula(c))}</h2></div><div class="btns"><button class="btn small" data-act="maxi" aria-pressed="${!!S.maxi}">${S.maxi ? 'Restaurar' : 'Maximizar'}</button><button class="btn small" data-act="close">Cerrar</button></div></div>
  <div id="nota">${notaHtml()}</div>

  <div class="sec"><h4>Datos de la causa</h4><div class="grid2">
   <label class="f">Actor<input id="c_actor" value="${esc(c.actor)}"></label>
   <label class="f">Demandado<input id="c_demandado" value="${esc(c.demandado)}" placeholder="Puede ir vacío"></label>
   <label class="f">Tipo<input id="c_tipo" list="tipos" value="${esc(c.tipo)}"></label>
   <label class="f">N° de expediente<input id="c_expte" inputmode="numeric" value="${esc(c.expte)}" ${S.isNew ? '' : 'readonly'}></label>
   <label class="f">Nominación<input id="c_nom" value="${esc(c.nom)}"></label>
   <label class="f">Oficina / juzgado<input id="c_oficina" list="oficinas" value="${esc(c.oficina)}"></label>
   <label class="f">Ubicación${selector('c_ubicacion', UBICACIONES, c.ubicacion)}</label>
   <label class="f">Estado${selector('c_estado', ESTADOS, c.estado, '(sin estado)')}</label>
   <label class="f">Etiqueta Cautelar${selector('c_cautelar', CAUTELARES, c.cautelar)}</label>
   <label class="f">Situación${selector('c_situacion', SITUACIONES, c.situacion)}</label>
  </div>
  <datalist id="tipos"><option>EJECUTIVO<option>PRENDARIO<option>TERCERIA<option>ABREVIADO</datalist>
  <datalist id="oficinas"><option>OEP<option>OEP VM<option>CRUZ DEL EJE</datalist></div>

  <div class="sec"><h4>Próxima acción</h4><div class="grid2">
   <label class="f ancho">Qué hay que hacer<input id="c_proxima" value="${esc(c.proxima)}" placeholder="Ej.: Pedir embargo de la garantía"></label>
   <label class="f">Vence / recordar el<input type="date" id="c_vence" value="${esc(c.vence)}"></label></div>
   ${S.isNew ? '' : `<div><button class="btn small donebtn" data-act="done">✓ Marcar como realizada</button> <span class="hint">Pasa a los movimientos con su fecha de vencimiento (o la de hoy, si no tiene o todavía no venció) y se guarda.</span></div>`}</div>

  ${S.isNew ? '' : `<div class="sec" id="secCautelar"><h4>Acción cautelar</h4><div class="liqpie"><span class="hint">Embargo de haberes o secuestro del vehículo: la app arma el oficio y el escrito con los datos de la causa, para presentarlos en el SAC.</span><button class="btn small primary" data-act="cautelar">Acción cautelar</button></div></div>`}

  <div id="acuerdoFicha">${acuerdoFichaHtml(c)}</div>

  <div class="sec"><h4>Movimientos</h4>
   <div class="addrow"><input type="date" id="h_fecha" value="${iso(today())}" aria-label="Fecha"><input id="h_texto" placeholder="Ej.: Dimos cédula a Franco" aria-label="Acción realizada"><button class="btn small primary" data-act="histadd">Registrar</button></div>
   <p class="hint m0">La acción más reciente pasa a ser la “última acción” de la causa.</p>
   ${hist.length ? `<ul class="hist">${hist.map((h) => `<li><span class="mono">${fmt(h.fecha)}</span><span>${h.hecha ? '<span class="tag t-acu">✓ realizada</span> ' : ''}${esc(h.texto)}</span><button class="x" data-act="histdel" data-i="${h.i}" aria-label="Borrar movimiento">×</button></li>`).join('')}</ul>` : '<p class="hint m0">Sin movimientos registrados.</p>'}
  </div>

  ${demandadosHtml(c)}

  ${titulosHtml(c)}

  ${liqHtml(c)}

  ${S.isNew ? '' : tplHtml(c)}

  <div id="agendaFicha">${agendaFichaHtml(c)}</div>

  <div class="sec"><h4>Notas</h4><label class="f"><textarea id="c_notas" rows="3" placeholder="Datos del martillero, teléfonos…" aria-label="Notas">${esc(c.notas)}</textarea></label></div>

  ${S.isNew ? '' : `<div class="actions"><button class="btn danger" data-act="del">Eliminar causa</button></div>`}
  ${S.confirmDel ? `<div class="confirm"><span>¿Eliminar definitivamente ${esc(titulo(c))}? Si terminó, mejor marcala como “Archivada” en Situación.</span><button class="btn small danger" data-act="delyes">Sí, eliminar</button><button class="btn small" data-act="delno">Cancelar</button></div>` : ''}
  <div class="ppie"><button class="btn primary" data-act="save">${S.isNew ? 'Crear causa' : 'Guardar cambios'}</button><button class="btn" data-act="close">Cancelar</button>${S.isNew ? '' : '<button class="btn" data-act="claude" aria-label="Consultar a Claude sobre esta causa">Claude</button>'}</div>
  </aside>`;
}

/** Un desplegable de valores fijos. Un valor que no está en la lista (o vacío, con `vacio`) se muestra igual, para no perderlo al guardar. */
function selector(id, valores, actual, vacio = '') {
  const v = actual || '', opciones = valores.includes(v) || (!v && !vacio) ? valores : [v, ...valores];
  return `<select id="${id}">${opciones.map((x) => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(x || vacio)}</option>`).join('')}</select>`;
}

function rerenderDrawer() {
  const p = $('.panel'), sc = p ? p.scrollTop : 0, h = $('#pl_hoja'), sx = h ? h.scrollLeft : 0;
  renderDrawer();
  if (sc) $('.panel').scrollTop = sc;
  if (sx && $('#pl_hoja')) $('#pl_hoja').scrollLeft = sx; // la planilla queda en la misma columna
}

function readForm() {
  guardarFormsAcu(); // el acuerdo que se esté cargando en la ficha
  const c = S.open;
  ['actor', 'demandado', 'tipo', 'expte', 'nom', 'oficina', 'ubicacion', 'estado', 'cautelar', 'situacion', 'proxima', 'vence', 'notas'].forEach((k) => { const el = $('#c_' + k); if (el) c[k] = el.value.trim(); });
  (c.demandados || []).forEach((d, i) => ['nombre', 'dni', 'telefono', 'domicilio', 'notas'].forEach((k) => { const el = $('#d_' + k + i); if (el) d[k] = el.value.trim(); }));
  (c.titulos || []).forEach((t, i) => {
    const g = (k) => $('#t_' + k + i);
    if (g('tipo')) t.tipo = g('tipo').value;
    if (g('monto')) t.monto = Math.max(0, +g('monto').value || 0);
    if (g('vence')) t.vence = g('vence').value;
    if (g('descripcion')) t.descripcion = g('descripcion').value.trim();
    t.vehiculo = t.tipo === 'prenda' && g('vehiculo') ? g('vehiculo').value.trim() : (t.tipo === 'prenda' ? t.vehiculo || '' : '');
  });
  if (S.planilla && c.liquidacion) leerPlanilla(c.liquidacion);
  return c;
}

async function save({ forzar = false, recrear = false } = {}) {
  const c = readForm();
  if (!c.demandado && !c.actor) { toast('Falta el actor o el demandado'); return; } // sin demandado se nombra por el actor
  if (!/^\d+$/.test(c.expte)) { toast('El N° de expediente debe ser numérico'); return; }
  if (S.isNew && D.causas.some((x) => x.expte === c.expte)) {
    if (S.pase) { S.pase.existe = c.expte; rerenderDrawer(); $('.panel').scrollTop = 0; return; } // viene de Cobranzas: ofrecer vincularla
    toast('Ya existe una causa con ese expediente'); return;
  }
  await conBoton($('.ppie [data-act=save]'), 'Guardando…', async () => {
    try {
      if (S.isNew || recrear) { await crearCausa(c); toast(S.isNew && c.deudor ? 'Causa creada: el deudor quedó en juicio en Cobranzas' : 'Causa creada'); closeDrawer(); return; }
      const r = await guardarCausa(c, { forzar });
      if (r.conflicto) { S.choque = { actual: r.actual }; rerenderDrawer(); $('.panel').scrollTop = 0; return; }
      toast('Cambios guardados'); closeDrawer();
    } catch (e) { toast(e.code === '23505' ? 'Ya existe una causa con ese expediente' : mensaje(e)); }
  });
}

// ───────────────────────── Acuerdos ─────────────────────────
// Un acuerdo de pago tiene tres rubros (RUBROS_ACU) y cada rubro sus propias cuotas. En la base las
// cuotas son una sola lista (acuerdos.cuotas) y cada una dice su `rubro`; las cargadas antes de que
// hubiera rubros no lo dicen y son de capital. El acuerdo se ve en la ficha de su causa y en la
// vista Acuerdos, donde cada uno es una fila con el nombre de la causa que se despliega al tocarla.
// Crear, marcar, corregir o agregar cuotas se guarda en el momento, sin "Guardar cambios".

const rubroDe = (q) => (RUBROS_ACU.some(([k]) => k === q?.rubro) ? q.rubro : 'capital');
const nombreRubro = (r) => (RUBROS_ACU.find(([k]) => k === r) || RUBROS_ACU[0])[1];
const ordenRubro = (r) => RUBROS_ACU.findIndex(([k]) => k === r);
const acuerdosDe = (expte) => (expte ? D.acuerdos.filter((a) => a.expte === expte) : []);
const causaDe = (a) => (a.expte ? D.causas.find((c) => c.expte === a.expte) || null : null);
/** Un acuerdo se nombra por su causa, como en el listado; sin causa, por el deudor. */
const tituloAcuerdo = (a) => { const c = causaDe(a); return c ? titulo(c) : a.deudor || '(sin deudor)'; };
const sumaMontos = (qs) => qs.reduce((x, q) => x + (+q.monto || 0), 0);
function cuentaCuotas(qs) {
  const pagadas = qs.filter((q) => q.estado === 'pagada');
  return { n: qs.length, pagadas: pagadas.length, impagas: qs.filter((q) => q.estado === 'impaga').length, total: sumaMontos(qs), cobrado: sumaMontos(pagadas) };
}
/** Las cuotas de un rubro, cada una con su lugar en la lista completa (`i`): es el que usan los botones. */
const cuotasDeRubro = (a, r) => (a.cuotas || []).map((q, i) => ({ q, i })).filter((x) => rubroDe(x.q) === r);
/** "Cuota 2 de 12" se cuenta dentro de su rubro. */
function nroCuota(a, i) { const xs = cuotasDeRubro(a, rubroDe(a.cuotas[i])); return { n: xs.findIndex((x) => x.i === i) + 1, de: xs.length }; }

function addPeriodo(d0, i, cada) { const d = new Date(d0); if (cada === 'mes') { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + i); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); } else d.setDate(d.getDate() + i * (cada === 'quincena' ? 15 : 7)); return iso(d); }
/** La frecuencia de las dos últimas cuotas de un rubro, para que las que se agreguen sigan igual. */
function frecuenciaDe(xs) {
  const a = parse(xs[xs.length - 2]?.q.vence), b = parse(xs[xs.length - 1]?.q.vence);
  const d = a && b ? Math.round((b - a) / 864e5) : 0;
  return d >= 5 && d <= 9 ? 'semana' : d >= 12 && d <= 17 ? 'quincena' : 'mes';
}
/** Las cuotas de un plan (cantidad, monto de cada una, 1er vencimiento y frecuencia), o el error para mostrar. */
function cuotasDePlan(r, pl) {
  const cant = Number(String(pl.n ?? '').trim()), monto = importe(pl.monto), nombre = nombreRubro(r);
  if (!Number.isInteger(cant) || cant < 1 || cant > 120) return { error: `Indicá la cantidad de cuotas de ${nombre} (de 1 a 120)` };
  if (!(monto > 0)) return { error: `Indicá el monto de cada cuota de ${nombre}` };
  if (!parse(pl.fecha)) return { error: `Indicá cuándo vence la 1ª cuota de ${nombre}` };
  const d0 = parse(pl.fecha);
  return { cuotas: Array.from({ length: cant }, (_, j) => ({ rubro: r, vence: addPeriodo(d0, j, pl.cada), monto, estado: 'pendiente', pago: '' })) };
}
const planVacio = (pl) => !String(pl.n ?? '').trim() && !String(pl.monto ?? '').trim() && !pl.fecha;
/** Las cuotas de todos los rubros de un acuerdo nuevo. El rubro que quedó vacío no suma ninguna. */
function cuotasDePlanes(planes) {
  const cuotas = [];
  for (const [r] of RUBROS_ACU) {
    const pl = planes[r] || PLAN_VACIO();
    if (planVacio(pl)) continue;
    const x = cuotasDePlan(r, pl);
    if (x.error) return x;
    cuotas.push(...x.cuotas);
  }
  return cuotas.length ? { cuotas } : { error: 'Cargá las cuotas de al menos un rubro' };
}
/** Para "+ Varias cuotas": siguen a la última del rubro, con su monto y su frecuencia. */
function planSiguiente(a, r) {
  const xs = cuotasDeRubro(a, r), ult = xs[xs.length - 1]?.q;
  if (!ult || !parse(ult.vence)) return PLAN_VACIO();
  const cada = frecuenciaDe(xs);
  return { n: '', monto: enCelda(+ult.monto || 0), fecha: addPeriodo(parse(ult.vence), 1, cada), cada };
}
/** Agrega cuotas a un rubro, después de las que ya tiene: la lista queda ordenada por rubro. */
function insertarEnRubro(cuotas, r, nuevas) {
  let pos = 0;
  cuotas.forEach((q, j) => { if (ordenRubro(rubroDe(q)) <= ordenRubro(r)) pos = j + 1; });
  cuotas.splice(pos, 0, ...nuevas);
  return cuotas;
}

function cuotasPorPreguntar() { const r = []; D.acuerdos.forEach((a) => (a.cuotas || []).forEach((q, i) => { const n = days(q.vence); if ((q.estado || 'pendiente') === 'pendiente' && n !== null && n >= GRACIA) r.push({ a, q, i }); })); return r.sort((x, y) => x.q.vence.localeCompare(y.q.vence)); }
function renderAvisos() {
  $('#avisos').innerHTML = cuotasPorPreguntar().map(({ a, q, i }) => {
    const k = nroCuota(a, i);
    return `<div class="aviso"><div><b>¿Pagó ${esc(a.deudor)} su cuota del acuerdo?</b><small>${esc(nombreRubro(rubroDe(q)))} · cuota ${k.n} de ${k.de} · vencía el ${fmt(q.vence)} · ${pesos(q.monto)}</small></div>
   <div class="actions"><button class="btn small primary" data-ac="pay" data-id="${esc(a.id)}" data-i="${i}" data-v="pagada">Sí, pagó</button><button class="btn small danger" data-ac="pay" data-id="${esc(a.id)}" data-i="${i}" data-v="impaga">No pagó</button></div></div>`;
  }).join('');
}

// Los formularios (un acuerdo nuevo, "cargar cuotas" de un rubro) guardan lo escrito en S: cada campo
// dice dónde en `data-guarda`. Así un redibujo —un cambio que llega de la base, otro botón— no lo borra.
function guardarFormsAcu() {
  document.querySelectorAll('[data-guarda]').forEach((el) => {
    const ruta = el.dataset.guarda.split('.'), campo = ruta.pop();
    let o = S;
    for (const p of ruta) o = o?.[p];
    if (o && typeof o === 'object') o[campo] = el.value;
  });
}
/** Un formulario que ya se usó o se cerró: lo que quedó escrito en la pantalla no vuelve a S. */
function soltar(prefijo) { document.querySelectorAll('[data-guarda]').forEach((el) => { if (el.dataset.guarda.startsWith(prefijo)) el.removeAttribute('data-guarda'); }); }
function cerrarFormsFicha() {
  soltar('naf.'); S.naf = null; S.acDel = '';
  for (const k of Object.keys(S.pq)) if (k.startsWith('f_')) { soltar(`pq.${k}.`); delete S.pq[k]; }
}

/** Los cuatro datos de un plan de cuotas. `idp`: comienzo de los id; `ruta`: dónde se guarda lo escrito. */
function camposPlan(idp, ruta, pl, nombre) {
  return `<div class="acplan">
    <label class="f">Cantidad de cuotas<input id="${idp}_n" data-guarda="${ruta}.n" type="number" min="1" max="120" inputmode="numeric" value="${esc(pl.n)}" aria-label="Cantidad de cuotas de ${esc(nombre)}"></label>
    <label class="f">Monto de cada cuota ($)<input id="${idp}_monto" data-guarda="${ruta}.monto" inputmode="decimal" autocomplete="off" data-importe placeholder="0" value="${esc(pl.monto)}" aria-label="Monto de cada cuota de ${esc(nombre)}"></label>
    <label class="f">Vence la 1ª cuota<input id="${idp}_fecha" data-guarda="${ruta}.fecha" type="date" value="${esc(pl.fecha)}" aria-label="Vencimiento de la 1ª cuota de ${esc(nombre)}"></label>
    <label class="f">Frecuencia<select id="${idp}_cada" data-guarda="${ruta}.cada" aria-label="Frecuencia de las cuotas de ${esc(nombre)}">${FRECUENCIAS.map(([v, l]) => `<option value="${v}" ${pl.cada === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  </div>`;
}

/** Un acuerdo nuevo: en la vista ('v') se elige la causa; en la ficha ('f') es la causa abierta. */
function formAcuerdoHtml(donde) {
  const enVista = donde === 'v', p = enVista ? 'na' : 'naf', f = enVista ? S.na : S.naf;
  if (!f) return '';
  const causas = D.causas.filter((c) => !isArch(c)).sort((a, b) => titulo(a).localeCompare(titulo(b)));
  return `<div class="acform">${enVista ? '<h4>Nuevo acuerdo</h4>' : ''}
   <div class="grid2">
    <label class="f${enVista ? '' : ' ancho'}">Deudor<input id="${p}_deudor" data-guarda="${p}.deudor" value="${esc(f.deudor)}" placeholder="Apellido y nombre"></label>
    ${enVista ? `<label class="f">Causa (opcional)<select id="na_expte" data-guarda="na.expte"><option value="">Sin vincular a una causa</option>${causas.map((c) => `<option value="${esc(c.expte)}" ${f.expte === c.expte ? 'selected' : ''}>${esc(titulo(c))} · ${esc(c.expte)}</option>`).join('')}</select></label>` : ''}
    <label class="f ancho">Notas<input id="${p}_notas" data-guarda="${p}.notas" value="${esc(f.notas)}" placeholder="Ej.: paga por transferencia"></label>
   </div>
   ${RUBROS_ACU.map(([r, nombre]) => `<div class="tarjeta"><b class="acrubtit">${esc(nombre)}</b>${camposPlan(`${p}_${r}`, `${p}.planes.${r}`, f.planes[r], nombre)}</div>`).join('')}
   <p class="hint m0">Cada rubro lleva sus cuotas. El que no entre en el acuerdo dejalo vacío: se puede cargar después. A los ${GRACIA} días de vencida cada cuota, el gestor pregunta si se pagó.</p>
   <div class="actions"><button class="btn primary" data-ac="${enVista ? 'create' : 'createf'}">Crear acuerdo</button><button class="btn" data-ac="${enVista ? 'nuevo' : 'cancelarf'}">Cancelar</button></div>
  </div>`;
}

function pillCuota(q) {
  const e = q.estado || 'pendiente';
  if (e === 'pagada') return `<span class="pill s-sentencia">Pagada${q.pago ? ' ' + fmt(q.pago) : ''}</span>`;
  if (e === 'impaga') return '<span class="pill s-subasta">No pagó</span>';
  return days(q.vence) > 0 ? '<span class="pill s-notificando">Vencida sin confirmar</span>' : '<span class="pill">Pendiente</span>';
}
/**
 * Una cuota, en un renglón: vencimiento y monto se corrigen ahí mismo y los botones la marcan o la
 * quitan. Si no entra a lo ancho (la ficha, el celular), el estado y los botones bajan al renglón de abajo.
 */
function filaCuota(a, { q, i }, j, donde) {
  const k = esc(a.id), nombre = esc(nombreRubro(rubroDe(q))), e = q.estado || 'pendiente', id = (c) => `cq_${donde}_${c}_${k}_${i}`;
  const marcar = (v, texto, clase = '') => `<button class="btn small ${clase}" data-ac="pay" data-id="${k}" data-i="${i}" data-v="${v}">${texto}</button>`;
  const vencio = (days(q.vence) ?? -1) >= 0; // "No pagó" recién desde el día del vencimiento
  const botones = e === 'pagada' ? marcar('pendiente', 'Deshacer')
    : marcar('pagada', 'Pagó', 'donebtn m0') + (e === 'impaga' || !vencio ? '' : marcar('impaga', 'No pagó', 'danger'));
  return `<div class="cuota"><span class="nro">${j + 1}</span>
   <input type="date" id="${id('f')}" data-acf="vence" data-id="${k}" data-i="${i}" value="${esc(q.vence)}" aria-label="Vencimiento de la cuota ${j + 1} de ${nombre}">
   <input id="${id('m')}" data-acf="monto" data-id="${k}" data-i="${i}" value="${esc(enCelda(q.monto))}" inputmode="decimal" autocomplete="off" data-importe placeholder="0" aria-label="Monto de la cuota ${j + 1} de ${nombre}">
   <span class="cuoest">${pillCuota(q)}${botones}<button class="x" data-ac="delq" data-id="${k}" data-i="${i}" aria-label="Quitar la cuota ${j + 1} de ${nombre}">×</button></span></div>`;
}
function rubroHtml(a, r, nombre, donde) {
  const xs = cuotasDeRubro(a, r), t = cuentaCuotas(xs.map((x) => x.q)), k = esc(a.id), clave = `${donde}_${a.id}_${r}`, kc = esc(clave), plan = S.pq[clave];
  const res = xs.length
    ? `${t.pagadas} de ${t.n} pagadas${t.impagas ? ` · <span class="malo">${t.impagas} ${t.impagas === 1 ? 'impaga' : 'impagas'}</span>` : ''} · cobrado ${pesos(t.cobrado)} de ${pesos(t.total)}`
    : 'Sin cuotas cargadas';
  const tabla = xs.length ? `<div class="cuotas"><div class="cuota cab" aria-hidden="true"><span class="nro">N°</span><span class="cvence">Vence</span><span class="cmonto">Monto ($)</span></div>
    ${xs.map((x, j) => filaCuota(a, x, j, donde)).join('')}</div>` : '';
  const pie = plan
    ? `<div class="tarjeta">${camposPlan(`pq_${clave}`, `pq.${clave}`, plan, nombre)}<div class="actions"><button class="btn small primary" data-ac="planok" data-clave="${kc}">Cargar cuotas</button><button class="btn small" data-ac="plan" data-clave="${kc}">Cancelar</button></div></div>`
    : `<div class="actions">${xs.length ? `<button class="btn small" data-ac="addq" data-id="${k}" data-rubro="${r}">+ Cuota</button><button class="btn small" data-ac="plan" data-clave="${kc}">+ Varias cuotas</button>` : `<button class="btn small" data-ac="plan" data-clave="${kc}">Cargar cuotas</button>`}</div>`;
  return `<div class="acrub" data-rubro="${r}"><div class="acrubcab"><b>${esc(nombre)}</b><span class="hint">${res}</span></div>${tabla}${pie}</div>`;
}
/** El desarrollo de un acuerdo: sus rubros con sus cuotas y los totales. `donde`: 'v' (vista Acuerdos) o 'f' (ficha). */
function acuerdoHtml(a, donde) {
  const k = esc(a.id), t = cuentaCuotas(a.cuotas || []), c = causaDe(a);
  const datos = [a.deudor && (!c || a.deudor !== titulo(c)) ? `Deudor: ${esc(a.deudor)}` : '', a.creado ? `Cargado el ${fmt(a.creado)}` : '', esc(a.notas)].filter(Boolean);
  const borrar = S.acDel === a.id
    ? `<button class="btn small danger" data-ac="delyes" data-id="${k}">Sí, eliminar el acuerdo</button><button class="btn small" data-ac="delno">Cancelar</button>`
    : `<button class="btn small danger" data-ac="del" data-id="${k}">Eliminar acuerdo</button>`;
  return `<div class="acdet">${datos.length ? `<p class="hint m0">${datos.join(' · ')}</p>` : ''}
   ${RUBROS_ACU.map(([r, nombre]) => rubroHtml(a, r, nombre, donde)).join('')}
   <dl class="cifras"><div><dt>Total del acuerdo</dt><dd>${pesos(t.total)}</dd></div><div><dt>Cobrado</dt><dd>${pesos(t.cobrado)}</dd></div><div><dt>Saldo</dt><dd>${pesos(t.total - t.cobrado)}</dd></div></dl>
   <div class="actions">${donde === 'v' && c ? `<button class="btn small" data-ac="abrir" data-id="${k}">Abrir la causa</button>` : ''}${borrar}</div>
  </div>`;
}

// Vista Acuerdos: una fila por acuerdo, con el nombre de la causa; al tocarla se despliega.
function renderAcuerdos() {
  const lista = [...D.acuerdos].sort((x, y) => tituloAcuerdo(x).localeCompare(tituloAcuerdo(y)) || x.id.localeCompare(y.id));
  const porConfirmar = cuotasPorPreguntar();
  const nuevo = S.naAbierto ? `<div class="sec">${formAcuerdoHtml('v')}</div>` : '<div><button class="btn primary" data-ac="nuevo">+ Nuevo acuerdo</button></div>';
  const vacio = '<div class="empty"><b>Todavía no cargaste ningún acuerdo</b>Se carga desde la ficha de la causa, en “Acuerdo de pago”, o acá con “+ Nuevo acuerdo”.</div>';
  return `<div class="acgrid">${nuevo}${lista.map((a) => filaAcuerdo(a, porConfirmar.filter((x) => x.a.id === a.id).length)).join('') || (S.naAbierto ? '' : vacio)}</div>`;
}
function filaAcuerdo(a, porConfirmar) {
  const abierto = S.acVer === a.id, k = esc(a.id), t = cuentaCuotas(a.cuotas || []);
  const sub = `${a.expte ? 'Expte. ' + esc(a.expte) : 'Sin causa vinculada'} · ${t.pagadas} de ${t.n} cuotas pagadas`;
  const alerta = porConfirmar ? `<span class="pill s-notificando">${porConfirmar} por confirmar</span>`
    : t.impagas ? `<span class="pill s-subasta">${t.impagas} ${t.impagas === 1 ? 'impaga' : 'impagas'}</span>` : '';
  return `<div class="sec acitem${abierto ? ' abierto' : ''}" data-acuerdo="${k}">
   <button class="acfila" data-ac="ver" data-id="${k}" aria-expanded="${abierto}"><span class="acnom"><b>${esc(tituloAcuerdo(a))}</b><span class="hint">${sub}</span></span>${alerta}<span class="chev" aria-hidden="true"></span></button>
   ${abierto ? acuerdoHtml(a, 'v') : ''}
  </div>`;
}

// En la ficha: el acuerdo de la causa, o el botón para cargarlo.
function acuerdoFichaHtml(c) {
  if (S.isNew) return '';
  const xs = acuerdosDe(c.expte), cab = '<h4>Acuerdo de pago</h4>';
  if (xs.length) return `<div class="sec" id="secAcuerdo">${cab}${xs.map((a) => (xs.length > 1 ? `<b class="acrubtit">Acuerdo del ${fmt(a.creado)}</b>` : '') + acuerdoHtml(a, 'f')).join('<hr class="acsep">')}
    <p class="hint m0">Lo que cambies en el acuerdo se guarda en el momento, sin “Guardar cambios”.</p></div>`;
  if (S.naf) return `<div class="sec" id="secAcuerdo">${cab}${formAcuerdoHtml('f')}</div>`;
  return `<div class="sec" id="secAcuerdo">${cab}<div class="liqpie"><span class="hint">Sin acuerdo cargado.</span><button class="btn small primary" data-ac="cargarf">Cargar acuerdo</button></div></div>`;
}
/** Redibuja solo el acuerdo de la ficha: lo demás que se esté editando en la ficha no se toca. */
function refrescarAcuerdoFicha() {
  const caja = $('#acuerdoFicha'); if (!caja || !S.open) return;
  guardarFormsAcu();
  conFoco(caja, () => { caja.innerHTML = acuerdoFichaHtml(S.open); });
}
/** Los acuerdos pueden estar a la vista en dos lugares a la vez: la vista Acuerdos y la ficha abierta. */
function redibujarAcuerdos() { render(); refrescarAcuerdoFicha(); }

const CAMBIO_ACUERDO = 'El acuerdo cambió recién. Revisalo y probá de nuevo';
/** Guarda las cuotas; cada una queda con su rubro escrito (las de antes de los rubros, "capital"). */
async function cambiarCuotas(a, cuotas, ok) {
  const r = await actualizarAcuerdo(a.id, a.rev, { cuotas: cuotas.map((q) => ({ ...q, rubro: rubroDe(q) })) });
  toast(r.conflicto ? CAMBIO_ACUERDO : ok);
  return !r.conflicto;
}
async function acAct(b) {
  const k = b.dataset.ac, id = b.dataset.id || '', i = +b.dataset.i, clave = b.dataset.clave || '';
  guardarFormsAcu();
  // Lo que solo cambia lo que se ve
  if (k === 'nuevo') { soltar('na.'); S.naAbierto = !S.naAbierto; if (!S.naAbierto) S.na = NA_VACIO(); redibujarAcuerdos(); if (S.naAbierto) $('#na_deudor')?.focus(); return; }
  if (k === 'ver') { S.acVer = S.acVer === id ? '' : id; redibujarAcuerdos(); return; }
  if (k === 'abrir') { const a = D.acuerdos.find((x) => x.id === id); if (a && causaDe(a)) openCausa(a.expte); return; }
  if (k === 'cargarf') { if (!S.open) return; S.naf = NA_VACIO(S.open.demandado || S.open.actor || ''); refrescarAcuerdoFicha(); $('#naf_deudor')?.focus(); return; }
  if (k === 'cancelarf') { soltar('naf.'); S.naf = null; refrescarAcuerdoFicha(); return; }
  if (k === 'plan') {
    soltar(`pq.${clave}.`);
    if (S.pq[clave]) delete S.pq[clave];
    else { const [, aid, r] = clave.split('_'), a = D.acuerdos.find((x) => x.id === aid); S.pq[clave] = a ? planSiguiente(a, r) : PLAN_VACIO(); }
    redibujarAcuerdos();
    if (S.pq[clave]) document.getElementById(`pq_${clave}_n`)?.focus();
    return;
  }
  if (k === 'del') { S.acDel = id; redibujarAcuerdos(); return; }
  if (k === 'delno') { S.acDel = ''; redibujarAcuerdos(); return; }
  try {
    if (k === 'create' || k === 'createf') {
      const enVista = k === 'create', f = enVista ? S.na : S.naf;
      if (!f) return;
      const expte = enVista ? f.expte : S.open?.expte || '';
      if (!f.deudor.trim()) { toast('Falta el deudor'); return; }
      const x = cuotasDePlanes(f.planes); if (x.error) { toast(x.error); return; }
      await conBoton(b, 'Creando…', async () => {
        const fila = await crearAcuerdo({ deudor: f.deudor.trim(), expte, notas: f.notas.trim(), cuotas: x.cuotas, creado: iso(today()) });
        // Recién guardado se cierra el formulario: si algo falla, queda con lo escrito.
        if (enVista) { soltar('na.'); S.na = NA_VACIO(); S.naAbierto = false; S.acVer = fila?.id || ''; } // queda desplegado, para ver cómo quedó
        else if (S.naf === f) { soltar('naf.'); S.naf = null; }
        redibujarAcuerdos();
        toast('Acuerdo creado');
      });
      return;
    }
    if (k === 'delyes') { await borrarAcuerdo(id); S.acDel = ''; if (S.acVer === id) S.acVer = ''; toast('Acuerdo eliminado'); return; }
    if (k === 'planok') {
      const [, aid, r] = clave.split('_'), a = D.acuerdos.find((x) => x.id === aid), pl = S.pq[clave];
      if (!a || !pl) return;
      const x = cuotasDePlan(r, pl); if (x.error) { toast(x.error); return; }
      const ok = x.cuotas.length === 1 ? `Cuota cargada en ${nombreRubro(r)}` : `${x.cuotas.length} cuotas cargadas en ${nombreRubro(r)}`;
      await conBoton(b, 'Guardando…', async () => {
        if (!await cambiarCuotas(a, insertarEnRubro(copia(a.cuotas || []), r, x.cuotas), ok)) return; // cambió desde otro lado: el formulario queda
        soltar(`pq.${clave}.`); delete S.pq[clave]; redibujarAcuerdos();
      });
      return;
    }
    const a = D.acuerdos.find((x) => x.id === id); if (!a) return; const cuotas = copia(a.cuotas || []);
    if (k === 'pay') {
      if (!cuotas[i]) return;
      const v = b.dataset.v; cuotas[i].estado = v; cuotas[i].pago = v === 'pagada' ? iso(today()) : '';
      await cambiarCuotas(a, cuotas, v === 'pagada' ? 'Cuota marcada como pagada' : v === 'impaga' ? 'Cuota marcada como no pagada' : 'Cuota vuelta a pendiente'); return;
    }
    if (k === 'addq') {
      const r = RUBROS_ACU.some(([x]) => x === b.dataset.rubro) ? b.dataset.rubro : 'capital', xs = cuotasDeRubro(a, r), ult = xs[xs.length - 1]?.q;
      const vence = ult && parse(ult.vence) ? addPeriodo(parse(ult.vence), 1, frecuenciaDe(xs)) : iso(today());
      await cambiarCuotas(a, insertarEnRubro(cuotas, r, [{ rubro: r, vence, monto: ult ? +ult.monto || 0 : 0, estado: 'pendiente', pago: '' }]), 'Cuota agregada'); return;
    }
    if (k === 'delq') { if (!cuotas[i]) return; cuotas.splice(i, 1); await cambiarCuotas(a, cuotas, 'Cuota quitada'); }
  } catch (e) { toast(mensaje(e)); }
}
document.addEventListener('change', async (e) => {
  const t = e.target; if (!t.dataset || !t.dataset.acf) return; const a = D.acuerdos.find((x) => x.id === t.dataset.id); if (!a) return;
  const cuotas = copia(a.cuotas || []), q = cuotas[+t.dataset.i]; if (!q) return;
  q[t.dataset.acf] = t.dataset.acf === 'monto' ? Math.max(0, importe(t.value)) : t.value;
  try { await cambiarCuotas(a, cuotas, 'Cuota actualizada'); } catch (err) { toast(mensaje(err)); }
});

// ───────────────────────── Plantillas ─────────────────────────

const CAMPOS = ['caratula', 'expediente', 'actor', 'demandado', 'tipo', 'nominacion', 'oficina'];
function fill(t, c) {
  const m = { caratula: caratula(c), expediente: c.expte, actor: c.actor, demandado: c.demandado, tipo: c.tipo, nominacion: c.nom ? c.nom + '°' : '', oficina: c.oficina };
  return String(t || '').replace(/\{\{\s*([a-záéíóúñ]+)\s*\}\}/gi, (x, k) => { k = k.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); return k in m ? (m[k] || '') : x; });
}
function tplHtml(c) {
  // Los modelos de oficio no son escritos: los completa la ficha desde "Acción cautelar".
  const ps = D.plantillas.filter((x) => !esModeloOficio(x.id)), p = ps.find((x) => x.id === S.tpSel);
  const cau = p && Object.entries(ACCIONES).find(([, d]) => d.escrito === p.id);
  return `<div class="sec"><h4>Escritos</h4>${ps.length ? `<label class="f">Plantilla<select id="tp_sel"><option value="">Elegí una plantilla…</option>${ps.map((x) => `<option value="${esc(x.id)}" ${x.id === S.tpSel ? 'selected' : ''}>${esc(x.titulo)}</option>`).join('')}</select></label>` : '<p class="hint m0">Todavía no hay plantillas. Creá la primera desde “Plantillas”.</p>'}
  ${cau ? `<div class="sucio liqpie"><span>Este escrito va con su oficio adjunto: armalo completo desde Acción cautelar.</span><button class="btn small" data-act="cautelar" data-tipo="${cau[0]}">Armarlo ahí</button></div>` : ''}
  ${p ? `<label class="f">Título / sumario<input id="tp_tit" readonly value="${esc(fill(p.titulo, c))}"></label>
   <label class="f">Cuerpo<textarea id="tp_cue" rows="12" readonly>${esc(fill(p.cuerpo, c))}</textarea></label>
   <div class="actions"><button class="btn small" data-tp="copy" data-src="tp_tit">Copiar título</button><button class="btn small primary" data-tp="copy" data-src="tp_cue">Copiar cuerpo</button></div>` : ''}</div>`;
}
function renderTpl(entra = false) {
  const d = $('#drawer'), sc = entra ? 0 : ($('.panel')?.scrollTop || 0); d.hidden = false; document.body.style.overflow = 'hidden';
  // Las cuatro de las acciones cautelares se pueden corregir; si algo se rompe, vuelven al texto original.
  const original = (x) => (MODELOS[x.id] && (x.titulo !== MODELOS[x.id].titulo || x.cuerpo !== MODELOS[x.id].cuerpo)
    ? `<button class="btn small" data-tp="original" data-id="${esc(x.id)}">Volver al texto original</button>` : '');
  const item = (x) => `<div class="sec"><h4>${x.id ? (esModeloOficio(x.id) ? 'Modelo de oficio' : 'Plantilla') : 'Nueva plantilla'}</h4>
    <label class="f">Título<input id="pt_${esc(x.id || 'new')}" value="${esc(x.titulo || '')}" placeholder="Ej.: Solicita aprobación de liquidación y designa martillero"></label>
    <label class="f">Cuerpo<textarea id="pc_${esc(x.id || 'new')}" rows="${x.id ? (esModeloOficio(x.id) ? 16 : 10) : 6}" placeholder="Texto del escrito…">${esc(x.cuerpo || '')}</textarea></label>
    <div class="actions"><button class="btn small primary" data-tp="save" data-id="${esc(x.id || '')}">${x.id ? 'Guardar cambios' : 'Crear plantilla'}</button>${x.id ? original(x) : ''}
    ${x.id ? (S.tplDel === x.id ? `<button class="btn small danger" data-tp="delyes" data-id="${esc(x.id)}">Sí, eliminar</button><button class="btn small" data-tp="delno">Cancelar</button>` : `<button class="btn small danger" data-tp="del" data-id="${esc(x.id)}">Eliminar</button>`) : ''}</div></div>`;
  const escritos = D.plantillas.filter((x) => !esModeloOficio(x.id)), oficios = D.plantillas.filter((x) => esModeloOficio(x.id));
  d.innerHTML = `<div class="scrim" data-act="close"></div><aside class="panel${entra ? ' entra' : ''}" role="dialog" aria-modal="true" aria-label="Plantillas de escritos">
   <div class="phead"><div><div class="hint">Biblioteca</div><h2>Plantillas de escritos</h2></div><button class="btn small" data-act="close">Cerrar</button></div>
   <p class="hint m0">Podés usar campos que se completan con los datos de cada causa: ${CAMPOS.map((k) => '{{' + k + '}}').join(', ')}. Los escritos de Acción cautelar usan además los del formulario: {{persona}}, {{dni}}, {{empleador}}, {{monto}}, {{monto_letras}}, {{marca}}, {{modelo}}, {{dominio}}…</p>
   ${escritos.map(item).join('') || '<p class="hint">Todavía no hay plantillas guardadas.</p>'}${item({})}
   <h3 class="tplgrupo">Modelos de oficio · Acción cautelar</h3>
   <p class="hint m0">La ficha los completa con los datos de la causa y del formulario. Marcas: el primer bloque es el encabezado (un renglón por línea); los párrafos van separados por una línea en blanco; “&gt;” al empezar un párrafo le pone sangría y “&gt;&gt;”, el lugar de la despedida; **texto** va en negrita; lo que está entre [[ y ]] va solo si sus campos tienen dato. Campos: ${Object.keys(CAMPOS_OFICIO).map((k) => '{{' + k + '}}').join(', ')}.</p>
   ${oficios.map(item).join('') || '<p class="hint m0">No hay modelos de oficio en la biblioteca: la ficha usa los originales.</p>'}
   <div class="pfin"></div></aside>`;
  if (sc) $('.panel').scrollTop = sc;
}
// Redibuja las plantillas porque cambió algo en la base, sin perder lo que se esté escribiendo en otra.
function refrescarTpl() {
  const escrito = [...document.querySelectorAll('.panel [id^="pt_"], .panel [id^="pc_"]')]
    .filter((el) => el.value !== el.defaultValue).map((el) => [el.id, el.value]);
  renderTpl();
  for (const [id, valor] of escrito) { const el = document.getElementById(id); if (el) el.value = valor; }
}
async function tplAct(b) {
  const a = b.dataset.tp, id = b.dataset.id || '';
  if (a === 'copy') { const el = document.getElementById(b.dataset.src); try { await navigator.clipboard.writeText(el.value); toast('Copiado'); } catch (e) { el.focus(); el.select(); toast('Seleccionado: copialo con Ctrl+C'); } return; }
  if (a === 'del') { S.tplDel = id; renderTpl(); return; }
  if (a === 'delno') { S.tplDel = ''; renderTpl(); return; }
  try {
    if (a === 'delyes') { await borrarPlantilla(id); S.tplDel = ''; toast('Plantilla eliminada'); return; }
    if (a === 'original') {
      const m = MODELOS[id], p = D.plantillas.find((x) => x.id === id);
      if (!m || !p) return;
      const r = await guardarPlantilla(id, p.rev, { titulo: m.titulo, cuerpo: m.cuerpo });
      toast(r.conflicto ? 'La plantilla cambió recién. Revisala y probá de nuevo' : 'Volvió al texto original');
      return;
    }
    if (a === 'save') {
      const t = document.getElementById('pt_' + (id || 'new')).value.trim(), c = document.getElementById('pc_' + (id || 'new')).value; if (!t || !c.trim()) { toast('Completá título y cuerpo'); return; }
      if (!id) {
        const poner = (titulo, cuerpo) => { const pt = document.getElementById('pt_new'), pc = document.getElementById('pc_new'); if (pt) pt.value = titulo; if (pc) pc.value = cuerpo; };
        poner('', ''); // ya se manda: el formulario queda libre para la próxima
        try { await crearPlantilla({ titulo: t, cuerpo: c }); } catch (e) { poner(t, c); throw e; } // si falla, no se pierde lo escrito
        toast('Plantilla creada'); return;
      }
      const p = D.plantillas.find((x) => x.id === id);
      const r = await guardarPlantilla(id, p ? p.rev : null, { titulo: t, cuerpo: c });
      toast(r.conflicto ? 'La plantilla cambió recién. Revisala y probá de nuevo' : 'Plantilla guardada');
    }
  } catch (e) { toast(mensaje(e)); }
}

// ───────────────────────── Escritos para el SAC (agenda) ─────────────────────────
// El chat deja cada escrito como borrador; la persona lo revisa y toca «Ahora» (es la única
// aprobación que vale para presentar): queda listo y se abre la tarea de Claude, donde toca
// "Ejecutar ahora". "Agendar" solo lo deja en la agenda para un día: nada se presenta solo.
// Ver supabase/migrations/0005 y 0006.

const ESTADO_AG = {
  borrador: ['Sin confirmar', 's-notificando'], pendiente: ['Agendado', 's-despacho'], presentando: ['Presentándose', 's-casillero'],
  presentado: ['Presentado', 's-sentencia'], error: ['No se presentó', 's-subasta'], cancelado: ['Cancelado', ''],
};
/** El estado que se muestra: lo pedido «Ahora» que la tarea todavía no tomó tiene el suyo. */
const estadoAg = (a) => (a.estado === 'pendiente' && a.ahora ? ['Listo para presentar', 's-casillero'] : ESTADO_AG[a.estado] || [a.estado, '']);
const DEMORA_PRESENTANDO = 30; // minutos sin noticias de la corrida que lo tomó: se puede dejar como no presentado
const minutosDesde = (s) => (Date.now() - Date.parse(s)) / 6e4;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const fmtDia = (s) => { const d = parse(s); return d ? d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) : ''; };
const fmtLargo = (s) => { const d = parse(s); return d ? `${DIAS[d.getDay()]} ${fmtDia(s)}` : ''; };
/** Escritos que todavía piden algo: confirmarlos, esperar a que se presenten o resolver un error. */
const agendaAbierta = (expte) => D.agenda.filter((a) => a.expte === expte && ['borrador', 'pendiente', 'presentando', 'error'].includes(a.estado));
/**
 * Abre la tarea de Claude que presenta en el SAC. Con `vacia`, abre la pestaña ya (dentro del
 * toque: si se abriera después de guardar, el navegador la bloquearía) y la devuelve para
 * llevarla a la tarea cuando el escrito quedó listo.
 */
function abrirTarea(vacia = false) {
  if (!vacia) { window.open(TAREA_SAC, '_blank', 'noopener'); return null; }
  const w = window.open('about:blank', '_blank');
  if (w) w.opener = null; // la pestaña nueva no puede tocar el gestor
  return w;
}

/** Copias de los borradores que trajo el chat, por si la lectura de la base todavía no los trae. */
function escritoDe(id) {
  const base = D.agenda.find((a) => a.id === id), copia = Object.values(S.chat?.extras || {}).map((x) => x.copias?.[id]).find(Boolean);
  return base ? { ...copia, ...base } : copia || null; // de la copia quedan los avisos del chat, que la base no guarda
}

function tarjetaAgenda(a, donde) {
  const c = D.causas.find((x) => x.expte === a.expte), [estado, clase] = estadoAg(a), k = esc(a.id);
  const cab = `<div class="agcab"><span class="pill ${clase}">${esc(estado)}</span><span class="hint">Expte. ${esc(a.expte)}${c ? ' · ' + esc(caratula(c)) : ''}</span></div>`;
  const id = (campo) => `ag_${donde}_${campo}_${k}`;
  if (a.estado === 'borrador') {
    return `<div class="sec agcard borrador" data-ag-id="${k}">${cab}
     <label class="f">Título<input id="${id('t')}" value="${esc(a.titulo)}"></label>
     <label class="f">Texto del escrito<textarea id="${id('c')}" rows="8">${esc(a.cuerpo)}</textarea></label>
     <div class="agfecha"><label class="f">Agendarlo para el<input type="date" id="${id('f')}" value="${esc(a.fecha)}" min="${iso(today())}"></label><button class="btn" data-ag="ahora" data-id="${k}" data-donde="${donde}">Ahora</button></div>
     ${a.realizar ? `<label class="chk"><input type="checkbox" id="${id('r')}" checked><span>Al presentarlo, dar por realizada la próxima acción: <b>${esc(a.realizar)}</b></span></label>` : ''}
     ${(a.avisos || []).map((t) => `<p class="sucio m0">${esc(t)}</p>`).join('')}
     <p class="hint m0">Con “Ahora” se abre la tarea de Claude: tocá “Ejecutar ahora” y Claude lo presenta en el SAC con tu Chrome, donde tenés abierta la sesión, y deja la causa “A despacho”. Con “Agendar” queda en la agenda para ese día, pero no se presenta solo.</p>
     <div class="actions"><button class="btn small primary" data-ag="agendar" data-id="${k}" data-donde="${donde}">Agendar</button><button class="btn small" data-ag="descartar" data-id="${k}" data-donde="${donde}">Descartar</button></div>
    </div>`;
  }
  const hhmm = (s) => (s ? hora(new Date(s)) : '');
  const realizar = (a.adjuntos?.length ? ' Va con el oficio adjunto.' : '') + (a.realizar ? ` Al presentarlo, da por realizada “${esc(a.realizar)}”.` : '');
  const ahora = (clase = '') => `<button class="btn small ${clase}" data-ag="ahora" data-id="${k}">Presentar ahora</button>`;
  const cancelar = `<button class="btn small danger" data-ag="cancelar" data-id="${k}">Cancelar</button>`;
  let detalle = 'No se va a presentar.', botones = '';
  if (a.estado === 'pendiente' && a.ahora) {
    // Listo para presentar: falta que la persona toque "Ejecutar ahora" en la tarea de Claude.
    detalle = `Lo pediste a las ${hhmm(a.ahora)}. Si todavía no lo hiciste, abrí la tarea y tocá “Ejecutar ahora”: Claude lo presenta en el SAC.${realizar}`;
    botones = `<button class="btn small primary" data-ag="tarea" data-id="${k}">Abrir la tarea en Claude</button>${cancelar}`;
  } else if (a.estado === 'pendiente') {
    detalle = `Agendado para el ${esc(fmtLargo(a.fecha))}. No se presenta solo: cuando quieras presentarlo, tocá “Presentar ahora”.${realizar}`;
    botones = ahora() + cancelar;
  } else if (a.estado === 'presentando') {
    // Ya lo tomó una corrida: no se cancela. Si no avisa cómo terminó, se puede dejar como no presentado.
    const colgado = minutosDesde(a.actualizado) > DEMORA_PRESENTANDO;
    detalle = colgado
      ? `Claude empezó a presentarlo a las ${hhmm(a.actualizado)} y no avisó cómo terminó. Fijate en el SAC si quedó presentado.`
      : `Claude lo está presentando en el SAC (empezó a las ${hhmm(a.actualizado)}).`;
    if (colgado) botones = `<button class="btn small" data-ag="nopresentado" data-id="${k}">Marcar como no presentado</button>`;
  } else if (a.estado === 'presentado') {
    detalle = `${esc(a.resultado || 'Presentado en el SAC')}${a.presentado ? ` · ${esc(cuando(new Date(a.presentado)))}` : ''}`;
  } else if (a.estado === 'error') {
    detalle = esc(a.resultado || 'No se pudo presentar.');
    botones = ahora('primary') + cancelar;
  }
  const ahoraClase = a.estado === 'pendiente' && a.ahora ? ' ahora' : '';
  return `<div class="sec agcard ${esc(a.estado)}${ahoraClase}" data-ag-id="${k}">${cab}<b>${esc(a.titulo)}</b>${adjuntosHtml(a)}<p class="m0 ${a.estado === 'error' ? 'malo' : 'hint'}">${detalle}</p>${botones ? `<div class="actions">${botones}</div>` : ''}</div>`;
}

/** Los oficios que van adjuntos al escrito (acciones cautelares), con el botón para verlos en PDF. */
function adjuntosHtml(a) {
  const xs = a.adjuntos || [];
  if (!xs.length) return '';
  cargarFuentes().catch(() => { /* se reintenta al tocar "Ver PDF" */ }); // así el PDF sale en el toque (el menú de compartir lo exige)
  return `<div class="adjuntos">${xs.map((x, n) => `<div class="adj"><span class="adjnom">Adjunto: ${esc(x.nombre)}</span><button class="btn small" data-ag="oficio" data-id="${esc(a.id)}" data-n="${n}">Ver PDF</button></div>`).join('')}</div>`;
}

function agendaFichaHtml(c) {
  if (S.isNew) return '';
  const abiertos = agendaAbierta(c.expte);
  const hechos = D.agenda.filter((a) => a.expte === c.expte && a.estado === 'presentado').sort((a, b) => (b.presentado || '').localeCompare(a.presentado || '')).slice(0, 3);
  if (!abiertos.length && !hechos.length) return '';
  return `<div class="sec"><h4>Escritos para el SAC</h4>${[...abiertos, ...hechos].map((a) => tarjetaAgenda(a, 'ficha')).join('')}</div>`;
}

/** Lo escrito en las tarjetas (y en el chat) que todavía no se guardó, para no perderlo al redibujar. */
function guardarEscrito(raiz) {
  return [...(raiz?.querySelectorAll('input[id^="ag_"], textarea[id^="ag_"], #chatTexto') || [])]
    .filter((el) => (el.type === 'checkbox' ? el.checked !== el.defaultChecked : el.value !== el.defaultValue))
    .map((el) => [el.id, el.type === 'checkbox' ? el.checked : el.value]);
}
function devolverEscrito(lista) {
  for (const [id, v] of lista) { const el = document.getElementById(id); if (el) { if (el.type === 'checkbox') el.checked = v; else el.value = v; } }
}

function refrescarAgendaFicha() {
  const caja = $('#agendaFicha'); if (!caja || !S.open) return;
  const escrito = guardarEscrito(caja);
  caja.innerHTML = agendaFichaHtml(S.open);
  devolverEscrito(escrito);
}

async function agAct(b) {
  const id = b.dataset.id, a = escritoDe(id);
  if (!a) { toast('Ese escrito ya no está en la agenda'); return; }
  const campo = (k) => document.getElementById(`ag_${b.dataset.donde}_${k}_${id}`);
  const anotar = (texto) => { if (S.chat) { S.chat.notas.push(texto); guardarEstadoChat(); } };
  try {
    let r;
    if (b.dataset.ag === 'agendar') {
      const titulo = campo('t').value.trim(), cuerpo = campo('c').value.replace(/\s+$/, ''), fecha = campo('f').value;
      if (!titulo || !cuerpo.trim()) { toast('Completá el título y el texto del escrito'); return; }
      if (!fecha) { toast('Elegí el día para agendarlo'); return; }
      if (fecha < iso(today())) { toast('Ese día ya pasó: elegí hoy o más adelante'); return; }
      const realizar = campo('r')?.checked ? a.realizar : '';
      r = await actualizarAgenda(id, a.rev, { titulo, cuerpo, fecha, realizar, estado: 'pendiente' });
      if (!r.conflicto) {
        anotar(`Confirmaste y quedó agendado "${titulo}" en la causa ${a.expte} para el ${fmt(fecha)}${titulo !== a.titulo || cuerpo !== a.cuerpo ? ' (con cambios tuyos en el texto)' : ''}. No se presenta solo.`);
        toast(`Agendado para el ${fmtLargo(fecha)}. Ese día tocá “Presentar ahora”`);
      }
    } else if (b.dataset.ag === 'ahora') {
      // «Ahora»: el escrito queda listo para presentar (con lo que diga la tarjeta, si era un
      // borrador) y se abre la tarea de Claude, donde la persona toca "Ejecutar ahora".
      let campos = {}, cambiado = false;
      if (a.estado === 'borrador') {
        const titulo = campo('t').value.trim(), cuerpo = campo('c').value.replace(/\s+$/, '');
        if (!titulo || !cuerpo.trim()) { toast('Completá el título y el texto del escrito'); return; }
        campos = { titulo, cuerpo, realizar: campo('r')?.checked ? a.realizar : '' };
        cambiado = titulo !== a.titulo || cuerpo !== a.cuerpo;
      }
      const pestaña = abrirTarea(true);
      try {
        r = await actualizarAgenda(id, a.rev, { ...campos, estado: 'pendiente', fecha: iso(today()), ahora: new Date().toISOString(), resultado: '' });
      } catch (e) { pestaña?.close(); throw e; }
      if (r.conflicto) { pestaña?.close(); } else {
        if (pestaña) pestaña.location.href = TAREA_SAC; else abrirTarea();
        anotar(`${a.estado === 'borrador' ? 'Confirmaste' : 'Pediste presentar'} "${campos.titulo || a.titulo}" de la causa ${a.expte} para presentarlo ahora${cambiado ? ' (con cambios tuyos en el texto)' : ''}: quedó listo y se abrió la tarea de Claude para tocar "Ejecutar ahora".`);
        toast('Listo. En Claude tocá “Ejecutar ahora” y Claude lo presenta en el SAC');
      }
    } else if (b.dataset.ag === 'tarea') {
      abrirTarea();
      return;
    } else if (b.dataset.ag === 'oficio') {
      const x = (a.adjuntos || [])[+b.dataset.n];
      if (x) await verPdf(x.doc, x.nombre);
      return;
    } else if (b.dataset.ag === 'nopresentado') {
      r = await actualizarAgenda(id, a.rev, { estado: 'error', resultado: `Se interrumpió mientras se presentaba (empezó a las ${a.actualizado ? hora(new Date(a.actualizado)) : '?'}). Antes de volver a mandarlo, fijate en el SAC si quedó presentado.` });
      if (!r.conflicto) { anotar(`Marcaste como no presentado "${a.titulo}" de la causa ${a.expte}: se había interrumpido mientras se presentaba.`); toast('Marcado como no presentado'); }
    } else if (b.dataset.ag === 'descartar') {
      r = await actualizarAgenda(id, a.rev, { estado: 'cancelado' });
      if (!r.conflicto) { anotar(`Descartaste el borrador "${a.titulo}" de la causa ${a.expte}: no se presenta.`); toast('Borrador descartado'); }
    } else if (b.dataset.ag === 'cancelar') {
      r = await actualizarAgenda(id, a.rev, { estado: 'cancelado' });
      if (!r.conflicto) { anotar(`Cancelaste "${a.titulo}" de la causa ${a.expte}: no se presenta.`); toast('Escrito cancelado: no se presenta'); }
    }
    if (r?.conflicto) toast('El escrito cambió recién. Revisalo y probá de nuevo');
  } catch (e) { toast(mensaje(e)); }
}

// ───────────────────────── Chat con Claude ─────────────────────────
// La conversación va y viene entera (supabase/functions/chat): la app guarda lo que devuelve la
// función tal cual, sin tocarlo, porque la API de Claude rechaza una conversación alterada.

const chatVacio = () => ({ abierto: false, cargado: false, mensajes: [], extras: {}, notas: [], enviando: false, pendiente: null, error: null });

function estadoChat() {
  if (!S.chat) S.chat = chatVacio();
  if (!S.chat.cargado && D.usuario) {
    const g = leerChat();
    if (g) Object.assign(S.chat, { mensajes: g.mensajes, extras: g.extras || {}, notas: g.notas || [] });
    S.chat.cargado = true;
  }
  return S.chat;
}
function guardarEstadoChat() {
  const c = S.chat; if (!c) return;
  guardarChat({ mensajes: c.mensajes, extras: c.extras, notas: c.notas });
}

/** El texto que se ve de un mensaje (sin la fecha ni las notas que agrega la función, sin herramientas). */
function textoVisible(m) {
  const textos = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text || '');
  if (!textos.length) return '';
  return m.role === 'user' ? textos.join('\n').replace(/^(\[[^\]\n]*\]\n)+/, '') : textos.join('\n\n').trim();
}

/** Lo que escribe Claude, con negritas y listas. Se escapa todo antes: se muestra, nunca se ejecuta. */
function enriquecer(t) {
  const linea = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  let html = '', lista = '', parrafo = [];
  const cerrarParrafo = () => { if (parrafo.length) html += `<p>${parrafo.map(linea).join('<br>')}</p>`; parrafo = []; };
  const cerrarLista = () => { if (lista) html += `</${lista}>`; lista = ''; };
  for (const l of t.split('\n')) {
    const item = /^\s*(?:([-•*])|\d+[.)])\s+(.*)$/.exec(l);
    if (item) {
      cerrarParrafo();
      const tipo = item[1] ? 'ul' : 'ol';
      if (lista !== tipo) { cerrarLista(); html += `<${tipo}>`; lista = tipo; }
      html += `<li>${linea(item[2])}</li>`;
    } else if (!l.trim()) { cerrarParrafo(); cerrarLista(); } else { cerrarLista(); parrafo.push(l); }
  }
  cerrarParrafo(); cerrarLista();
  return html;
}

function bienvenidaHtml() {
  const ejemplos = ['¿Qué tengo pendiente esta semana?', '¿Qué causas están a despacho?', 'Presentá la aprobación de planilla en la causa … el día … y marcá la acción como realizada'];
  return `<div class="bienvenida">
   <p class="m0"><b>Pedile a Claude lo que necesites del gestor.</b> Lee y actualiza las causas, te dice qué hay pendiente y deja escritos de la biblioteca listos para presentar en el SAC.</p>
   <div class="sugerencias">${ejemplos.map((e) => `<button class="chip" data-chat="ejemplo">${esc(e)}</button>`).join('')}</div>
   <p class="hint m0">Cada escrito lo confirmás vos en una tarjeta. Con “Ahora” se abre la tarea de Claude: tocás “Ejecutar ahora” y Claude lo presenta en el SAC.</p>
  </div>`;
}

function charlaHtml() {
  const c = S.chat;
  if (!c.mensajes.length && !c.pendiente) return bienvenidaHtml();
  let h = '';
  c.mensajes.forEach((m, i) => {
    const t = textoVisible(m);
    if (t) h += m.role === 'user' ? `<div class="msj yo">${esc(t).replace(/\n/g, '<br>')}</div>` : `<div class="msj claude">${enriquecer(t)}</div>`;
    const x = c.extras[i];
    if (x?.acciones?.length) h += `<ul class="hecho" aria-label="Cambios en el gestor">${x.acciones.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`;
    for (const id of x?.borradores || []) { const a = escritoDe(id); if (a) h += tarjetaAgenda(a, 'chat'); }
  });
  if (c.pendiente) h += `<div class="msj yo${c.error ? ' fallido' : ''}">${esc(c.pendiente).replace(/\n/g, '<br>')}</div>`;
  if (c.enviando) h += '<div class="msj claude pensando" role="status">Claude está trabajando…</div>';
  if (c.error) {
    h += `<div class="msj aviso-chat" role="alert"><p class="m0">${esc(c.error.mensaje)}</p><div class="actions">
      ${c.error.reintentar ? '<button class="btn small primary" data-chat="reintentar">Reintentar</button>' : ''}
      ${c.error.codigo === 'larga' ? '<button class="btn small" data-chat="nueva">Nueva conversación</button>' : ''}
      ${['sin_clave', 'claude'].includes(c.error.codigo) ? '<button class="btn small" data-chat="claudeai">Abrir en la app de Claude</button>' : ''}</div></div>`;
  }
  return h;
}

function chatHtml() {
  return `<div class="scrim" data-chat="cerrar"></div>
  <aside class="panel chat entra" role="dialog" aria-modal="true" aria-label="Chat con Claude">
   <div class="phead"><div><div class="hint">Asistente del gestor</div><h2>Claude</h2></div>
    <div class="btns"><button class="btn small" data-chat="nueva" id="chatNueva">Nueva conversación</button><button class="btn small" data-chat="cerrar">Cerrar</button></div></div>
   <div class="charla" id="charla" aria-live="polite"></div>
   <form class="chatpie" id="fChat" novalidate>
    <textarea id="chatTexto" rows="1" placeholder="Escribile a Claude…" aria-label="Mensaje para Claude" enterkeyhint="send"></textarea>
    <button class="btn primary" type="submit" id="chatEnviar">Enviar</button>
   </form>
  </aside>`;
}

/** Redibuja la conversación sin tocar lo que se está escribiendo; baja al final si ya estaba abajo. */
function refrescarCharla(bajar = false) {
  const ch = $('#charla'); if (!ch || !S.chat) return;
  const abajo = bajar || ch.scrollHeight - ch.scrollTop - ch.clientHeight < 60, pos = ch.scrollTop;
  const escrito = guardarEscrito(ch);
  ch.innerHTML = charlaHtml();
  devolverEscrito(escrito);
  ch.scrollTop = abajo ? ch.scrollHeight : pos;
  $('#chatNueva').hidden = !S.chat.mensajes.length;
  $('#chatEnviar').disabled = S.chat.enviando;
}

function abrirChat(causa) {
  const c = estadoChat();
  if (!c.abierto) {
    c.abierto = true; S.menu = false; renderMenu();
    const caja = $('#chat'); caja.hidden = false; caja.innerHTML = chatHtml();
    document.body.style.overflow = 'hidden'; document.body.classList.add('con-chat');
  }
  refrescarCharla(true);
  const t = $('#chatTexto');
  if (causa?.expte && !t.value.trim()) t.value = `Sobre la causa ${causa.expte} (${partes(causa)}): `;
  ajustarAlto(t);
  if (!movil.matches || causa) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
}
function cerrarChat() {
  if (S.chat) S.chat.abierto = false;
  const caja = $('#chat'); if (!caja || caja.hidden) return;
  caja.hidden = true; caja.innerHTML = ''; document.body.classList.remove('con-chat');
  if ($('#drawer').hidden) document.body.style.overflow = '';
}
function ajustarAlto(t) { if (!t) return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 168) + 'px'; }

async function enviarChat(texto) {
  const c = S.chat;
  texto = String(texto || '').trim();
  if (!c || c.enviando || !texto) return;
  const notas = c.notas.splice(0);
  Object.assign(c, { enviando: true, error: null, pendiente: texto });
  refrescarCharla(true);
  try {
    const r = await preguntarAClaude({ historial: c.mensajes, texto, notas });
    c.mensajes.push(...r.nuevos);
    if (r.acciones?.length || r.borradores?.length) {
      c.extras[c.mensajes.length - 1] = {
        acciones: r.acciones || [], borradores: (r.borradores || []).map((b) => b.id),
        copias: Object.fromEntries((r.borradores || []).map((b) => [b.id, b])),
      };
    }
    c.pendiente = null;
  } catch (e) {
    c.notas.unshift(...notas); // no llegaron: van con el próximo mensaje
    const final = ['larga', 'sin_clave', 'sin_acceso', 'clave_temporal', 'pedido'].includes(e.codigo);
    c.error = { mensaje: e.sinSesion ? 'La sesión venció: volvé a ingresar.' : e.message || 'No se pudo enviar el mensaje', codigo: e.codigo, reintentar: !final && !e.sinSesion };
    if (final) { $('#chatTexto').value = $('#chatTexto').value || texto; c.pendiente = null; }
  } finally {
    c.enviando = false;
    guardarEstadoChat();
    if (c.abierto) refrescarCharla(true);
  }
}

function chatAct(b) {
  const a = b.dataset.chat, c = S.chat;
  if (a === 'cerrar') { cerrarChat(); return; }
  if (a === 'nueva') {
    if (c.enviando) return;
    Object.assign(c, { mensajes: [], extras: {}, pendiente: null, error: null });
    guardarEstadoChat(); refrescarCharla(true); $('#chatTexto').focus(); return;
  }
  if (a === 'ejemplo') { const t = $('#chatTexto'); t.value = b.textContent.replace(/…/g, '').replace(/\s{2,}/g, ' '); ajustarAlto(t); t.focus(); return; }
  if (a === 'reintentar') { const t = c.pendiente; c.pendiente = null; c.error = null; enviarChat(t); return; }
  if (a === 'claudeai') hablarConClaude(S.open);
}

// ───────────────────────── Cuenta ─────────────────────────

const instalada = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function renderMenu() {
  const m = $('#menu'); m.hidden = !S.menu; $('#btnCuenta')?.setAttribute('aria-expanded', S.menu);
  if (!S.menu) { m.innerHTML = ''; return; }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !instalada();
  const sinc = !D.enLinea ? 'Sin conexión' : D.enVivo ? 'Sincronizado en vivo' : D.leido ? 'Actualizado ' + cuando(D.leido) : 'Conectando…';
  m.innerHTML = `<div class="scrim claro" data-m="cerrar"></div>
  <div class="menu" role="menu" aria-label="Cuenta y opciones">
   <div class="menu-quien"><b>${esc(D.acceso?.nombre || 'Mi cuenta')}</b><span class="hint">${esc(D.usuario?.email || '')}</span></div>
   <button class="op solo-movil" role="menuitem" data-m="plantillas">Plantillas de escritos</button>
   <button class="op solo-movil" role="menuitem" data-m="exportar">Exportar a Excel (CSV)</button>
   <a class="op" role="menuitem" href="${COBRANZAS}" target="_blank" rel="noopener">Abrir la app de cobranzas</a>
   ${S.instalar ? '<button class="op" role="menuitem" data-m="instalar">Instalar la app en este dispositivo</button>' : ''}
   ${ios ? '<div class="menu-pie hint">Para instalarla en el iPhone: abrila en Safari, tocá Compartir y después “Agregar a inicio”.</div>' : ''}
   <button class="op" role="menuitem" data-m="clave">Cambiar contraseña</button>
   <button class="op" role="menuitem" data-m="salir">Cerrar sesión</button>
   <div class="menu-pie hint">${sinc}. Al cerrar sesión se borra la copia guardada en este dispositivo.<br>Versión ${VERSION}</div>
  </div>`;
}
function renderClave() {
  const d = $('#drawer'); d.hidden = false; document.body.style.overflow = 'hidden';
  d.innerHTML = `<div class="scrim" data-act="close"></div><aside class="panel entra" role="dialog" aria-modal="true" aria-label="Cambiar contraseña">
   <div class="phead"><div><div class="hint">${esc(D.usuario?.email || '')}</div><h2>Cambiar contraseña</h2></div><button class="btn small" data-act="close">Cerrar</button></div>
   <form id="fClaveMenu" class="sec" novalidate>
    <input type="email" autocomplete="username" value="${esc(D.usuario?.email || '')}" hidden>
    <label class="f">Contraseña nueva<input id="n_clave" type="password" autocomplete="new-password"></label>
    <label class="f">Repetila<input id="n_clave2" type="password" autocomplete="new-password"></label>
    <p class="hint m0">De ${CLAVE_MIN} caracteres o más. Vale para todos tus dispositivos.</p>
    <p class="malo m0" id="i_error" role="alert" hidden></p>
    <div class="actions"><button class="btn primary" type="submit">Guardar contraseña</button><button class="btn" type="button" data-act="close">Cancelar</button></div>
   </form><div class="pfin"></div></aside>`;
  $('#n_clave').focus();
}
async function menuAct(b) {
  const a = b.dataset.m; S.menu = false; renderMenu();
  if (a === 'plantillas') { abrirPlantillas(); return; }
  if (a === 'exportar') { exportar(); return; }
  if (a === 'clave') { S.open = null; S.tpl = false; S.clave = true; renderClave(); return; }
  if (a === 'instalar' && S.instalar) { const ev = S.instalar; S.instalar = null; ev.prompt(); return; }
  if (a === 'salir') { await salir(); mostrar('ingreso'); toast('Sesión cerrada'); }
}

function abrirPlantillas() { S.open = null; S.clave = false; S.tpl = true; renderTpl(true); }

function exportar() {
  const cols = ['Actor', 'Demandado', 'Tipo', 'Expediente', 'Nominación', 'Oficina', 'Ubicación', 'Estado', 'Etiqueta Cautelar', 'Situación', 'Última acción', 'Fecha última acción', 'Próxima acción', 'Vence', 'Notas', 'Capital reclamado', 'Intereses', 'Total reclamado'];
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = '\ufeff' + cols.join(';') + '\n' + filtered().map((c) => [c.actor, c.demandado, c.tipo, c.expte, c.nom, c.oficina, c.ubicacion, c.estado, c.cautelar, c.situacion, c.ultima, c.fecha, c.proxima, c.vence, c.notas, ...(() => { const k = reclamo(c); return [k.capital, k.interes, k.total]; })()].map(q).join(';')).join('\n');
  try {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `juicios-${iso(today())}.csv` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast('Archivo listo: juicios-' + iso(today()) + '.csv');
  } catch (e) {
    navigator.clipboard.writeText(csv).then(() => toast('Copiado al portapapeles: pegalo en Excel'), () => toast('No se pudo exportar desde este dispositivo'));
  }
}

// ───────────────────────── Eventos ─────────────────────────

// Un botón que guarda no se puede volver a apretar hasta que termine.
async function unaVez(boton, tarea) {
  if (boton.disabled) return;
  boton.disabled = true;
  try { await tarea(boton); } finally { if (boton.isConnected) boton.disabled = false; }
}

document.addEventListener('click', async (e) => {
  const ing = e.target.closest('[data-ing]');
  if (ing) { if (ing.dataset.ing === 'salir') { await salir(); mostrar('ingreso'); } else await reintentar(ing); return; }
  if (e.target.closest('#btnReintentar')) { await reintentar(e.target.closest('#btnReintentar')); if (D.enLinea) toast('Conexión recuperada'); return; }
  // Un enlace del menú abre la otra app en otra pestaña; el menú se cierra después de seguirlo.
  if (e.target.closest('.menu a.op')) { setTimeout(() => { S.menu = false; renderMenu(); }); return; }
  const mn = e.target.closest('[data-m]'); if (mn) { if (mn.dataset.m === 'cerrar') { S.menu = false; renderMenu(); } else await menuAct(mn); return; }
  const cb = e.target.closest('[data-chat]'); if (cb) { chatAct(cb); return; }
  const cu = e.target.closest('[data-cau]'); if (cu) { if (S.open && S.cau) await unaVez(cu, cauAct); return; }
  const ag = e.target.closest('[data-ag]'); if (ag) { await unaVez(ag, agAct); return; }
  const tp = e.target.closest('[data-tp]'); if (tp) { await unaVez(tp, tplAct); return; }
  const acb = e.target.closest('[data-ac]'); if (acb) { await unaVez(acb, acAct); return; }
  const st = e.target.closest('.stat'); if (st) { S.quick = S.quick === st.dataset.q ? '' : st.dataset.q; render(); return; }
  const ch = e.target.closest('#chips .chip'); if (ch) { S.tag = ch.dataset.t; render(); return; }
  const th = e.target.closest('th[data-k]'); if (th) { const k = th.dataset.k; S.sort = { k, dir: S.sort.k === k ? -S.sort.dir : 1 }; render(); return; }
  const dn = e.target.closest('[data-done]'); if (dn) { e.stopPropagation(); await unaVez(dn, (b) => quickDone(b.dataset.done)); return; }
  const row = e.target.closest('#main tr[data-id], #main .card[data-id], #main .fila[data-id]'); if (row) { openCausa(row.dataset.id); return; }
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act, c = S.open;
  if (act === 'close') { closeDrawer(); return; }
  if (act === 'claude') { abrirChat(S.open); return; }
  if (!c) return;
  if (act === 'choque-ver') { const actual = D.causas.find((x) => x.expte === c.expte); if (!actual) { closeDrawer(); return; } S.open = copia(actual); S.base = copia(actual); S.choque = null; S.confirmDel = false; S.liqSucia = false; renderDrawer(); return; }
  readForm();
  if (act === 'choque-pisar' && S.planilla && S.choque?.actual) { await guardarPlanilla(a, true); return; }
  if (act === 'plexcel') { descargarPlanilla(); return; } // antes de cualquier espera: el menú de compartir del celular lo exige
  if (act === 'planilla') { abrirPlanilla(); return; }
  if (act === 'cautelar') { abrirCautelar(a.dataset.tipo || ''); return; }
  if (act === 'plvolver') { volverAFicha(); return; }
  if (act === 'plsave') { await guardarPlanilla(a); return; }
  if (act === 'choque-pisar') { S.choque = null; await save({ forzar: true }); return; }
  if (act === 'choque-crear') { S.choque = null; await save({ recrear: true }); return; }
  if (act === 'pase-revisar' && S.pase) { S.pase.existe = ''; rerenderDrawer(); $('#c_expte')?.focus(); return; }
  if (act === 'pase-vincular' && S.pase) {
    // La causa queda como está: solo se le anota el deudor, y la base lo pasa a juicio.
    const x = D.causas.find((k) => k.expte === S.pase.existe); if (!x) { toast('No encontré esa causa'); return; }
    await conBoton(a, 'Vinculando…', async () => {
      try {
        const r = await actualizarCausa(x.expte, x.rev, { deudor: c.deudor });
        if (r.conflicto) { toast('La causa cambió recién: probá de nuevo'); return; }
        toast('Causa vinculada: el deudor quedó en juicio en Cobranzas'); openCausa(x.expte);
      } catch (err) { toast(mensaje(err)); }
    });
    return;
  }
  if (act === 'histadd') {
    const f = $('#h_fecha').value, t = $('#h_texto').value.trim(); if (!t) { toast('Escribí la acción realizada'); return; }
    c.historial = [...(c.historial || []), { fecha: f, texto: t }]; Object.assign(c, ultimaDe(c.historial));
  }
  if (act === 'histdel') { c.historial.splice(+a.dataset.i, 1); Object.assign(c, ultimaDe(c.historial)); }
  if (act === 'demadd') { c.demandados = [...(c.demandados || []), DEM_VACIO()]; }
  if (act === 'demdel') { c.demandados.splice(+a.dataset.i, 1); }
  if (act === 'titadd') { c.titulos = [...(c.titulos || []), TIT_VACIO(a.dataset.t)]; }
  if (act === 'titdel') { c.titulos.splice(+a.dataset.i, 1); }
  if (act === 'rubadd') { c.liquidacion.rubros.push({ id: idNuevo(), rubro: '', monto: 0, pagado: 0 }); S.liqSucia = true; }
  if (act === 'rubdel') { const [quitado] = c.liquidacion.rubros.splice(+a.dataset.i, 1); c.liquidacion.pagos.forEach((p) => delete p.imp[quitado.id]); S.liqSucia = true; }
  if (act === 'pagadd') { c.liquidacion.pagos.push({ id: idNuevo(), fecha: iso(today()), op: '', imp: {} }); S.liqSucia = true; }
  if (act === 'pagdel') { c.liquidacion.pagos.splice(+a.dataset.i, 1); S.liqSucia = true; }
  if (act === 'maxi') { S.maxi = !S.maxi; try { localStorage.setItem('gj.maxi', S.maxi ? '1' : '0'); } catch { /* sin almacenamiento */ } }
  if (act === 'done') { if (!applyDone(c)) { toast('No hay próxima acción anotada'); return; } $('#c_proxima').value = ''; $('#c_vence').value = ''; await save(); return; }
  if (act === 'del') { S.confirmDel = true; }
  if (act === 'delno') { S.confirmDel = false; }
  if (act === 'delyes') { try { await borrarCausa(c.expte); toast('Causa eliminada'); closeDrawer(); } catch (err) { toast(mensaje(err, 'no se eliminó')); } return; }
  if (act === 'save') { await save(); return; }
  rerenderDrawer();
  if (act === 'del') $('.confirm')?.scrollIntoView({ block: 'nearest' });
  if (act === 'histadd') toast('Movimiento agregado. Tocá “Guardar cambios”.');
  if (act === 'pagadd') { const h = $('#pl_hoja'); if (h) h.scrollLeft = h.scrollWidth; $('#pl_o' + (c.liquidacion.pagos.length - 1))?.focus(); }
  if (act === 'rubadd') $('#pl_r' + (c.liquidacion.rubros.length - 1))?.focus();
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'chatTexto') { ajustarAlto(e.target); return; }
  if (/^pl_/.test(e.target.id)) { recalcPlanilla(); return; }
  if (/^cau_/.test(e.target.id) && S.cau) {
    leerCautelar();
    if (e.target.id === 'cau_tit' || e.target.id === 'cau_cue') S.cau.tocado = true; // desde acá, el escrito no se rehace solo
    refrescarCautelar();
    return;
  }
  if (/^t_(monto|vence)\d+$/.test(e.target.id)) { // recalcular los totales sin perder el foco
    clearTimeout(S.lt); S.lt = setTimeout(() => { if (!S.open) return; const id = document.activeElement?.id; readForm(); rerenderDrawer(); if (id) { const el = document.getElementById(id); if (el) el.focus(); } }, 700);
  }
});
// Celdas de importe de la planilla: al entrar se selecciona lo escrito (como en Excel, escribir
// lo reemplaza) y al salir queda con el formato de miles y centavos.
document.addEventListener('focusin', (e) => { if (e.target.matches?.('input[data-importe]')) e.target.select(); });
document.addEventListener('focusout', (e) => { if (e.target.matches?.('input[data-importe]')) e.target.value = enCelda(importe(e.target.value)); });
document.addEventListener('keydown', (e) => {
  // En la planilla, Enter y las flechas verticales pasan a la celda de abajo o de arriba
  if (e.target.matches?.('.planilla input[data-r]') && (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const sube = e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey);
    document.querySelector(`.planilla input[data-r="${+e.target.dataset.r + (sube ? -1 : 1)}"][data-c="${e.target.dataset.c}"]`)?.focus();
    return;
  }
  if (e.key === 'Escape') {
    if (S.chat?.abierto) { cerrarChat(); return; }
    if (S.menu) { S.menu = false; renderMenu(); } else if (S.planilla && S.open) { readForm(); volverAFicha(); } else if (S.cau && S.open) { S.cau = null; renderDrawer(); } else if (S.open || S.tpl || S.clave) closeDrawer();
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-id], .fila[data-id]')) { e.preventDefault(); openCausa(e.target.dataset.id); }
  if (e.key === 'Enter' && e.target.id === 'h_texto') document.querySelector('[data-act="histadd"]').click();
  if (e.key === 'Enter' && e.target.id === 'chatTexto' && !e.shiftKey && !movil.matches && !e.isComposing) { e.preventDefault(); $('#fChat').requestSubmit(); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'cau_dem' && S.cau) { leerCautelar(); elegirDemandado(+e.target.value); return; }
  if (e.target.id === 'cau_enervar' && S.cau) { leerCautelar(); if (!S.cau.tocado) Object.assign(S.cau, escritoCau()); rerenderDrawer(); return; }
  if (/^t_tipo\d+$/.test(e.target.id)) { readForm(); rerenderDrawer(); return; }
  if (e.target.id === 'tp_sel') { readForm(); S.tpSel = e.target.value; rerenderDrawer(); }
});
$('#q').addEventListener('input', (e) => { S.q = e.target.value; render(); });
$('#fEstado').addEventListener('change', (e) => { S.estado = e.target.value; render(); });
$('#fNom').addEventListener('change', (e) => { S.nom = e.target.value; render(); });
$('#fOrden').addEventListener('change', (e) => { const [k, dir] = e.target.value.split(':'); if (k) { S.sort = { k, dir: +dir }; render(); } });
const verVista = (v) => () => { S.view = v; try { localStorage.setItem('gj.view', v); } catch { /* sin almacenamiento */ } render(); };
$('#vLista').onclick = verVista('lista'); $('#vAgenda').onclick = verVista('agenda'); $('#vAcuerdos').onclick = verVista('acuerdos'); $('#vTablero').onclick = verVista('tablero');
$('#btnNew').onclick = $('#fabNew').onclick = () => openCausa(null);
$('#btnTpl').onclick = abrirPlantillas;
$('#btnExport').onclick = exportar;
// Para lo que el chat de la app no hace (por ejemplo presentar un escrito con archivos adjuntos):
// una conversación nueva en la app de Claude, con la causa ya nombrada.
function hablarConClaude(c) {
  const texto = c?.expte
    ? `Sobre el gestor de juicios, causa ${c.expte} (${partes(c)}): `
    : 'Sobre el gestor de juicios: ';
  window.open('https://claude.ai/new?q=' + encodeURIComponent(texto), '_blank', 'noopener');
}
$('#btnChat').onclick = () => abrirChat(null);
// Botón SAC. En el iPhone, el gestor instalado abre los enlaces de otros sitios en una vista de
// Safari propia, y ahí no se puede entrar a las causas: va a Chrome, con la dirección que Chrome
// registra para eso (https → googlechromes). Sin target: se abre la otra app y el gestor queda igual.
// En la PC (y si el gestor ya está abierto en Chrome) sigue el enlace común, en otra pestaña.
{
  const ua = navigator.userAgent;
  const iphone = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  if (iphone && !/CriOS/.test(ua)) {
    const sac = $('#btnSac');
    sac.href = sac.href.replace(/^https:/, 'googlechromes:');
    sac.removeAttribute('target');
    sac.title = 'Abrir el SAC en Chrome';
  }
}
$('#btnCuenta').onclick = () => { S.menu = !S.menu; renderMenu(); };
$('#btnFiltros').onclick = (e) => { const abierto = $('#toolbar').classList.toggle('abierto'); e.currentTarget.setAttribute('aria-expanded', abierto); };
movil.addEventListener('change', () => render());

// Cambios que llegan de la base: los propios, los de Claude o los de otro dispositivo.
alCambiar((que, detalle) => {
  if (que === 'sesion') { if (detalle !== S.pantalla) mostrar(detalle); else if (detalle === 'listo') render(); return; }
  if (S.pantalla !== 'listo') return;
  if (que === 'estado') { renderFranja(); if (D.cargado && S.view !== 'acuerdos' && S.view !== 'agenda') subtitulo(`${filtered().length} de ${D.causas.length} causas`); if (S.menu) renderMenu(); return; }
  render();
  seguirEnlace(); // un enlace que llegó antes de que estuvieran los datos
  if (S.tpl) refrescarTpl();
  if (S.open && !S.isNew) { const n = $('#nota'); if (n) n.innerHTML = notaHtml(); refrescarAgendaFicha(); refrescarAcuerdoFicha(); } // sin tocar lo que se está escribiendo
  if (S.chat?.abierto) refrescarCharla();
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.instalar = e; if (S.menu) renderMenu(); });
window.addEventListener('appinstalled', () => { S.instalar = null; toast('App instalada'); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => { /* la app funciona igual sin él */ });

(async () => {
  try { mostrar(await iniciar()); } catch (e) { console.error(e); S.falla = mensaje(e, 'no se pudo abrir'); mostrar('error'); }
})();

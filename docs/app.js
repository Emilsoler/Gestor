// Interfaz del gestor. Los datos y la red viven en datos.js.
import {
  D, iniciar, reconectar, entrar, salir, cambiarClave, alCambiar, mensaje, ultimaDe,
  crearCausa, guardarCausa, actualizarCausa, borrarCausa,
  crearAcuerdo, actualizarAcuerdo, borrarAcuerdo,
  crearPlantilla, guardarPlantilla, borrarPlantilla,
  actualizarAgenda, preguntarAClaude, leerChat, guardarChat,
} from './datos.js';
import { idNuevo, nuevaLiquidacion, cobradoRubro, totalPago, liqNormal, liqCalc, importe, pesos, enCelda, planillaExcel } from './liquidacion.js';

const VERSION = '1.4';

const TAGS = [
  { k: 'En trámite', c: '' }, { k: 'Embargo de sueldo', c: 't-emb' }, { k: 'Secuestro / subasta', c: 't-sec' },
  { k: 'Acuerdo', c: 't-acu' }, { k: 'Martillero', c: 't-mar' }, { k: 'OP solicitada', c: 't-op' }];
const ESTADOS = ['Iniciar', 'Notificando', 'Casillero', 'A despacho', 'Sentencia', 'Tramites p/ subasta', 'Acuerdo', 'Archivada'];
const STALE = 30; // días sin movimiento para marcar una causa
const GRACIA = 5; // días después del vencimiento de una cuota antes de preguntar si se pagó
const CLAVE_MIN = 10;
// A qué hora corre, de lunes a viernes, la tarea de Claude que presenta en el SAC. Está también en
// supabase/functions/chat/instrucciones.ts y en la tarea programada: si cambia, cambia en los tres.
const HORA_SAC = '10:15';

const S = {
  pantalla: 'arranque',
  q: '', estado: '', nom: '', tag: '', quick: '', view: 'lista', sort: { k: 'dias', dir: -1 },
  open: null, isNew: false, confirmDel: false, choque: null, // ficha abierta
  planilla: false, liqSucia: false, // la planilla de liquidación está a la vista / tiene cambios sin guardar
  tpl: false, tpSel: '', tplDel: '', clave: false, // otros paneles
  na: { deudor: '', expte: '', n: '', monto: '', fecha: '', cada: 'mes', notas: '' }, acDel: '',
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
const sClass = (e) => { e = (e || '').toLowerCase(); return e.includes('casillero') ? 's-casillero' : e.includes('despacho') ? 's-despacho' : e.includes('sentencia') ? 's-sentencia' : e.includes('acuerdo') ? 's-acuerdo' : e.includes('notific') ? 's-notificando' : e.includes('subasta') ? 's-subasta' : ''; };
const tagClass = (t) => (TAGS.find((x) => x.k === t) || {}).c || '';
const movil = window.matchMedia('(max-width: 720px)');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 3200);
}

function dueState(c) { const d = parse(c.vence); if (!d || !(c.proxima || '').trim()) return ''; const n = Math.round((d - today()) / 864e5); return n < 0 ? 'late' : n <= 7 ? 'soon' : ''; }
function isAcu(c) { return c.estado !== 'Archivada' && (c.estado === 'Acuerdo' || (c.etiquetas || []).includes('Acuerdo')); }
function isStale(c) { if ((c.estado || '') === 'Archivada' || isAcu(c)) return false; const n = days(c.fecha); return n === null || n > STALE; }

// ───────────────────────── Pantallas de ingreso ─────────────────────────

function mostrar(pantalla) {
  S.pantalla = pantalla;
  const enApp = pantalla === 'listo';
  $('#vArranque').hidden = true;
  $('#vApp').hidden = !enApp;
  $('#vIngreso').hidden = enApp;
  if (enApp) { $('#ingresoCuerpo').innerHTML = ''; render(); return; } // no dejar el formulario (ni la clave) en la página
  closeDrawer(); cerrarChat(); S.chat = null; S.menu = false; renderMenu();
  for (const k of ['#main', '#stats', '#chips', '#avisos', '#franja', '#fEstado', '#fNom']) $(k).innerHTML = ''; // ni los datos, al salir
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

const CHIPS = [{ k: 'e:Casillero', l: 'Casillero' }, { k: 'e:A despacho', l: 'A despacho' }, { k: 't:Embargo de sueldo', l: 'Embargos de sueldo' }, { k: 't:Secuestro / subasta', l: 'Secuestrados' }];
function chipMatch(c, k) { const v = k.slice(2); return k[0] === 'e' ? (c.estado || '').trim().toLowerCase() === v.toLowerCase() : (c.etiquetas || []).includes(v); }

function filtered() {
  const q = S.q.trim().toLowerCase();
  const r = D.causas.filter((c) => {
    if (S.estado && (c.estado || '(sin estado)') !== S.estado) return false;
    if (S.nom && String(c.nom) !== S.nom) return false;
    if (S.tag && !chipMatch(c, S.tag)) return false;
    if (S.quick === 'stale' && !isStale(c)) return false;
    if (S.quick === 'due' && dueState(c) !== 'late') return false;
    if (S.quick === 'next' && !c.proxima) return false;
    if (S.quick !== 'arch' && !S.estado && c.estado === 'Archivada') return false;
    if (S.quick === 'arch' && c.estado !== 'Archivada') return false;
    if (S.quick === 'acu' && !isAcu(c)) return false;
    if (S.quick === 'sac' && !agendaAbierta(c.expte).length) return false;
    if (S.quick !== 'acu' && S.estado !== 'Acuerdo' && S.tag !== 'Acuerdo' && isAcu(c)) return false;
    if (q) { const h = [c.actor, c.demandado, c.tipo, c.expte, c.ultima, c.proxima, c.oficina, c.notas, ...(c.etiquetas || [])].join(' ').toLowerCase(); if (!h.includes(q)) return false; }
    return true;
  });
  const { k, dir } = S.sort;
  const val = (c) => (k === 'dias' ? (days(c.fecha) ?? 99999) : k === 'vence' ? (c.proxima && c.vence) || '9999' : k === 'nom' ? Number(c.nom) || 0 : k === 'demandado' ? titulo(c).toLowerCase() : String(c[k] || '').toLowerCase());
  r.sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
  return r;
}

function renderStats() {
  const act = D.causas.filter((c) => c.estado !== 'Archivada' && !isAcu(c)), acu = D.causas.filter(isAcu);
  const items = [
    { id: '', n: act.length, l: 'Causas activas' },
    { id: 'stale', n: act.filter(isStale).length, l: `Sin movimiento +${STALE} días o sin fecha`, cls: 'alert' },
    { id: 'due', n: act.filter((c) => dueState(c) === 'late').length, l: 'Vencidas', cls: 'alert' },
    { id: 'next', n: act.filter((c) => c.proxima).length, l: 'Con próxima acción anotada' },
    { id: 'acu', n: acu.length, l: 'Con acuerdo' },
    { id: 'arch', n: D.causas.filter((c) => c.estado === 'Archivada').length, l: 'Archivadas' }];
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
  const live = D.causas.filter((c) => c.estado !== 'Archivada' && !isAcu(c));
  $('#chips').innerHTML = `<button class="chip" data-t="" aria-pressed="${!S.tag}">Todas · ${live.length}</button>` + CHIPS.map((t) => `<button class="chip" data-t="${esc(t.k)}" aria-pressed="${S.tag === t.k}">${esc(t.l)} · ${live.filter((c) => chipMatch(c, t.k)).length}</button>`).join('');
  $('#vAcuerdos').setAttribute('aria-pressed', S.view === 'acuerdos'); $('#vLista').setAttribute('aria-pressed', S.view === 'lista'); $('#vTablero').setAttribute('aria-pressed', S.view === 'tablero');
}

function ageHtml(c) { const n = days(c.fecha); if (n === null) return '<span class="age old">sin fecha</span>'; return `<span class="age ${n > STALE ? 'old' : ''}">${fmt(c.fecha)} · hace ${n} d</span>`; }
function tagsHtml(c) {
  const ts = (c.etiquetas || []).map((t) => `<span class="tag ${tagClass(t)}">${esc(t)}</span>`);
  for (const a of agendaAbierta(c.expte)) {
    ts.push(a.estado === 'error' ? '<span class="tag t-sacerr">SAC: no se presentó</span>'
      : a.estado === 'borrador' ? '<span class="tag">Escrito sin confirmar</span>'
        : `<span class="tag t-sac">SAC ${esc(fmtDia(a.fecha))}</span>`);
  }
  return ts.length ? `<div class="tags">${ts.join('')}</div>` : '';
}

function renderList(rows) {
  if (movil.matches) return renderFilas(rows);
  const th = (k, l) => `<th data-k="${k}">${l}${S.sort.k === k ? (S.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
  return `<div class="tablebox"><table><thead><tr>${th('demandado', 'Carátula')}${th('expte', 'Expte.')}${th('nom', 'Nom. / Oficina')}${th('estado', 'Estado')}${th('ultima', 'Última acción')}${th('dias', 'Fecha')}${th('proxima', 'Próxima acción')}${th('vence', 'Vence')}</tr></thead><tbody>` +
    rows.map((c) => `<tr data-id="${esc(c.expte)}" tabindex="0"><td class="car"><b>${esc(titulo(c))}</b><small>${esc(bajada(c))}</small>${tagsHtml(c)}</td>
   <td class="mono">${esc(c.expte)}</td><td>${c.nom ? esc(c.nom) + '°' : ''} ${esc(c.oficina)}</td>
   <td>${c.estado ? `<span class="pill ${sClass(c.estado)}">${esc(c.estado)}</span>` : '<span class="hint">—</span>'}</td>
   <td>${esc(c.ultima) || '<span class="hint">—</span>'}</td><td>${ageHtml(c)}</td>
   <td class="next ${c.proxima ? '' : 'none'}">${esc(c.proxima) || '—'}${c.proxima ? `<div><button class="btn small donebtn" data-done="${esc(c.expte)}">✓ Realizada</button></div>` : ''}</td>
   <td>${c.vence && c.proxima ? `<span class="due ${dueState(c)}">${fmt(c.vence)}</span>` : '<span class="hint">—</span>'}</td></tr>`).join('') + `</tbody></table></div>`;
}

// En pantallas chicas, cada causa es una tarjeta: se lee de arriba abajo sin deslizar de costado.
function renderFilas(rows) {
  return `<div class="filas">` + rows.map((c) => `<article class="fila" data-id="${esc(c.expte)}" tabindex="0" role="button" aria-label="Abrir la ficha de ${esc(titulo(c))}">
    <div class="fila-top"><b>${esc(titulo(c))}</b>${c.estado ? `<span class="pill ${sClass(c.estado)}">${esc(c.estado)}</span>` : ''}</div>
    <div class="mono">${esc(c.expte)} · ${c.nom ? esc(c.nom) + '° ' : ''}${esc(c.oficina)}${c.tipo ? ' · ' + esc(c.tipo) : ''}</div>
    ${tagsHtml(c)}
    <div class="fila-ult"><span>${esc(c.ultima) || '<span class="hint">Sin acción cargada</span>'}</span>${ageHtml(c)}</div>
    ${c.proxima ? `<div class="fila-prox"><div><span class="next">${esc(c.proxima)}</span>${c.vence ? `<div class="due ${dueState(c)}">Vence el ${fmt(c.vence)}</div>` : ''}</div><button class="btn small donebtn" data-done="${esc(c.expte)}">✓ Realizada</button></div>` : ''}
  </article>`).join('') + `</div>`;
}

function renderBoard(rows) {
  const cols = [...new Set([...ESTADOS.filter((e) => e !== 'Archivada' || S.quick === 'arch'), ...rows.map((c) => c.estado || '(sin estado)')])];
  return `<div class="board">` + cols.map((e) => {
    const cs = rows.filter((c) => (c.estado || '(sin estado)') === e);
    if (!cs.length && (movil.matches || !ESTADOS.includes(e))) return ''; // en el celular, las columnas vacías no ocupan pantalla
    return `<section class="col"><h3><span>${esc(e)}</span><span>${cs.length}</span></h3>` + cs.map((c) => `<button class="card" data-id="${esc(c.expte)}"><b>${esc(titulo(c))}</b><div class="mono">${esc(c.expte)} · ${c.nom ? esc(c.nom) + '° ' : ''}${esc(c.oficina)}</div>${tagsHtml(c)}<p>${esc(c.ultima || 'Sin acción cargada')}</p>${ageHtml(c)}${c.proxima ? `<p><b>→</b> ${esc(c.proxima)}</p>` : ''}</button>`).join('') + `</section>`;
  }).join('') + `</div>`;
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
  // Si se redibuja mientras se escribe en el listado (formulario de acuerdos), el foco y el cursor vuelven a su lugar.
  const activo = document.activeElement, idActivo = activo && $('#main').contains(activo) ? activo.id : '';
  let cursor = null; try { if (idActivo && activo.selectionStart != null) cursor = [activo.selectionStart, activo.selectionEnd]; } catch { /* tipos sin selección */ }
  renderStats(); renderFilters(); renderAvisos(); renderFranja();
  const inicial = (D.acceso?.nombre || D.usuario?.email || '?').trim().charAt(0).toUpperCase();
  $('#btnCuenta').textContent = inicial;
  const main = $('#main'), isAc = S.view === 'acuerdos';
  ['#stats', '#chips', '#q', '#btnFiltros', '#filtros', '#fabNew'].forEach((k) => { $(k).hidden = isAc; });
  if (!D.cargado) {
    main.innerHTML = `<div class="empty"><b>Cargando tus causas…</b>Acá vas a ver el listado de juicios con su estado, última acción y próxima acción.</div>`;
    subtitulo('Cargando causas…');
  } else if (isAc) {
    keepNa(); main.innerHTML = renderAcuerdos(); subtitulo(`${D.acuerdos.length} acuerdos con plan de cuotas`);
  } else if (!D.causas.length) {
    main.innerHTML = `<div class="empty"><b>Todavía no hay causas cargadas</b>Usá “+ Nueva causa” para agregar la primera.</div>`; subtitulo('0 causas');
  } else {
    const rows = filtered();
    subtitulo(`${rows.length} de ${D.causas.length} causas`);
    main.innerHTML = rows.length ? (S.view === 'tablero' ? renderBoard(rows) : renderList(rows)) : `<div class="empty"><b>Ninguna causa coincide con los filtros</b>Probá con otra búsqueda o quitá algún filtro.</div>`;
  }
  if (idActivo) {
    const el = document.getElementById(idActivo);
    if (el && el !== document.activeElement) { el.focus(); if (cursor) try { el.setSelectionRange(cursor[0], cursor[1]); } catch { /* tipos sin selección */ } }
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

function blank() { return { expte: '', actor: 'AMB', demandado: '', tipo: 'EJECUTIVO', nom: '', oficina: 'OEP', estado: 'Iniciar', proxima: '', vence: '', ultima: '', fecha: '', etiquetas: ['En trámite'], notas: '', historial: [], demandados: [], titulos: [] }; }
function openCausa(id) {
  S.open = id ? copia(D.causas.find((c) => c.expte === id) || blank()) : blank();
  S.base = copia(S.open); // la causa como se abrió: para saber qué se cambió en la ficha
  S.isNew = !id; S.confirmDel = false; S.choque = null; S.tpl = false; S.clave = false; S.tpSel = '';
  S.planilla = false; S.liqSucia = false;
  renderDrawer(true);
}
function closeDrawer() {
  S.open = null; S.tpl = false; S.clave = false; S.tpSel = ''; S.tplDel = ''; S.choque = null; S.confirmDel = false;
  S.planilla = false; S.liqSucia = false;
  $('#drawer').hidden = true; $('#drawer').innerHTML = ''; document.body.style.overflow = '';
}

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

const CAMPOS_FICHA = ['actor', 'demandado', 'tipo', 'nom', 'oficina', 'estado', 'etiquetas', 'proxima', 'vence', 'ultima', 'fecha', 'notas', 'historial', 'demandados', 'titulos'];
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
      <label class="f">Detalle<input id="t_descripcion${i}" value="${esc(t.descripcion)}" placeholder="${t.tipo === 'prenda' ? 'Ej.: Prenda N° …' : t.tipo === 'cheque' ? 'Ej.: Cheque N° …, Banco …' : 'Ej.: Pagaré N° 1'}"></label>
      ${t.tipo === 'prenda' ? `<label class="f ancho">Vehículo<input id="t_vehiculo${i}" value="${esc(t.vehiculo)}" placeholder="Marca, modelo, dominio"></label>` : ''}
     </div>
     <div class="resumen"><span>${f.dias ? f.dias + ' días de mora' : t.vence ? 'No vencido' : 'Sin vencimiento'}</span><span>Interés <b>${money(f.interes)}</b></span><span>Con interés <b>${money(f.total)}</b></span>
      <button class="btn small danger" data-act="titdel" data-i="${i}">Quitar</button></div>
    </div>`; }).join('') : '<p class="hint m0">Sin títulos cargados.</p>'}
   <div class="actions"><button class="btn small" data-act="titadd" data-t="pagare">+ Pagaré</button><button class="btn small" data-act="titadd" data-t="cheque">+ Cheque</button><button class="btn small" data-act="titadd" data-t="prenda">+ Prenda</button></div>
   ${lista.length ? `<div class="totals"><div><span>Capital</span><b>${money(k.capital)}</b></div><div><span>Intereses al ${fmt(iso(today()))} (${Math.round(TASA_MENSUAL * 100)}% mensual simple)</span><b>${money(k.interes)}</b></div><div><span>Total reclamado</span><b>${money(k.total)}</b></div></div>` : ''}</div>`;
}

// Aviso dentro de la ficha cuando la causa cambió desde otro lado (Claude, otro dispositivo).
function notaHtml() {
  const c = S.open;
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
  const hist =(c.historial || []).map((h, i) => ({ ...h, i })).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || b.i - a.i);
  const meta = !S.isNew && c.actualizado ? ` · último cambio ${cuando(new Date(c.actualizado))}${c.actualizado_por ? ' (' + esc(c.actualizado_por) + ')' : ''}` : '';
  d.innerHTML = `<div class="scrim" data-act="close"></div><aside class="panel${entra ? ' entra' : ''}${S.maxi ? ' max' : ''}" role="dialog" aria-modal="true" aria-label="Ficha de la causa">
  <div class="phead"><div><div class="hint">${S.isNew ? 'Nueva causa' : 'Expte. ' + esc(c.expte) + meta}</div><h2>${esc(S.isNew && !c.demandado ? 'Nueva causa' : caratula(c))}</h2></div><div class="btns"><button class="btn small" data-act="maxi" aria-pressed="${!!S.maxi}">${S.maxi ? 'Restaurar' : 'Maximizar'}</button><button class="btn small" data-act="close">Cerrar</button></div></div>
  <div id="nota">${notaHtml()}</div>

  <div class="sec"><h4>Datos de la causa</h4><div class="grid2">
   <label class="f">Actor<input id="c_actor" value="${esc(c.actor)}"></label>
   <label class="f">Demandado<input id="c_demandado" value="${esc(c.demandado)}" placeholder="Puede ir vacío"></label>
   <label class="f">Tipo<input id="c_tipo" list="tipos" value="${esc(c.tipo)}"></label>
   <label class="f">N° de expediente<input id="c_expte" inputmode="numeric" value="${esc(c.expte)}" ${S.isNew ? '' : 'readonly'}></label>
   <label class="f">Nominación<input id="c_nom" value="${esc(c.nom)}"></label>
   <label class="f">Oficina / juzgado<input id="c_oficina" list="oficinas" value="${esc(c.oficina)}"></label>
   <label class="f">Estado<select id="c_estado">${[...new Set([...ESTADOS, c.estado || ''])].map((e) => `<option ${e === (c.estado || '') ? 'selected' : ''} value="${esc(e)}">${esc(e || '(sin estado)')}</option>`).join('')}</select></label>
  </div>
  <div><div class="hint mb4">Etiquetas</div><div class="chips">${TAGS.map((t) => `<button class="chip" data-act="tag" data-t="${esc(t.k)}" aria-pressed="${(c.etiquetas || []).includes(t.k)}">${esc(t.k)}</button>`).join('')}</div></div>
  <datalist id="tipos"><option>EJECUTIVO<option>PRENDARIO<option>TERCERIA<option>ABREVIADO</datalist>
  <datalist id="oficinas"><option>OEP<option>OEP VM<option>CRUZ DEL EJE</datalist></div>

  <div class="sec"><h4>Próxima acción</h4><div class="grid2">
   <label class="f ancho">Qué hay que hacer<input id="c_proxima" value="${esc(c.proxima)}" placeholder="Ej.: Pedir embargo de la garantía"></label>
   <label class="f">Vence / recordar el<input type="date" id="c_vence" value="${esc(c.vence)}"></label></div>
   ${S.isNew ? '' : `<div><button class="btn small donebtn" data-act="done">✓ Marcar como realizada</button> <span class="hint">Pasa a los movimientos con su fecha de vencimiento (o la de hoy, si no tiene o todavía no venció) y se guarda.</span></div>`}</div>

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

  <div class="sec"><h4>Notas</h4><label class="f"><textarea id="c_notas" rows="3" placeholder="Datos del martillero, montos del acuerdo, teléfonos…" aria-label="Notas">${esc(c.notas)}</textarea></label></div>

  ${S.isNew ? '' : `<div class="actions"><button class="btn danger" data-act="del">Eliminar causa</button></div>`}
  ${S.confirmDel ? `<div class="confirm"><span>¿Eliminar definitivamente ${esc(titulo(c))}? Si terminó, mejor pasala a “Archivada”.</span><button class="btn small danger" data-act="delyes">Sí, eliminar</button><button class="btn small" data-act="delno">Cancelar</button></div>` : ''}
  <div class="ppie"><button class="btn primary" data-act="save">${S.isNew ? 'Crear causa' : 'Guardar cambios'}</button><button class="btn" data-act="close">Cancelar</button>${S.isNew ? '' : '<button class="btn" data-act="claude" aria-label="Consultar a Claude sobre esta causa">Claude</button>'}</div>
  </aside>`;
}

function rerenderDrawer() {
  const p = $('.panel'), sc = p ? p.scrollTop : 0, h = $('#pl_hoja'), sx = h ? h.scrollLeft : 0;
  renderDrawer();
  if (sc) $('.panel').scrollTop = sc;
  if (sx && $('#pl_hoja')) $('#pl_hoja').scrollLeft = sx; // la planilla queda en la misma columna
}

function readForm() {
  const c = S.open;
  ['actor', 'demandado', 'tipo', 'expte', 'nom', 'oficina', 'estado', 'proxima', 'vence', 'notas'].forEach((k) => { const el = $('#c_' + k); if (el) c[k] = el.value.trim(); });
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
  if (S.isNew && D.causas.some((x) => x.expte === c.expte)) { toast('Ya existe una causa con ese expediente'); return; }
  await conBoton($('.ppie [data-act=save]'), 'Guardando…', async () => {
    try {
      if (S.isNew || recrear) { await crearCausa(c); toast('Causa creada'); closeDrawer(); return; }
      const r = await guardarCausa(c, { forzar });
      if (r.conflicto) { S.choque = { actual: r.actual }; rerenderDrawer(); $('.panel').scrollTop = 0; return; }
      toast('Cambios guardados'); closeDrawer();
    } catch (e) { toast(e.code === '23505' ? 'Ya existe una causa con ese expediente' : mensaje(e)); }
  });
}

// ───────────────────────── Acuerdos ─────────────────────────

function keepNa() { Object.keys(S.na).forEach((k) => { const el = document.getElementById('na_' + k); if (el) S.na[k] = el.value; }); }
function addPeriodo(d0, i, cada) { const d = new Date(d0); if (cada === 'mes') { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + i); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); } else d.setDate(d.getDate() + i * (cada === 'quincena' ? 15 : 7)); return iso(d); }
function cuotasPorPreguntar() { const r = []; D.acuerdos.forEach((a) => (a.cuotas || []).forEach((q, i) => { const n = days(q.vence); if ((q.estado || 'pendiente') === 'pendiente' && n !== null && n >= GRACIA) r.push({ a, q, i }); })); return r.sort((x, y) => x.q.vence.localeCompare(y.q.vence)); }
function renderAvisos() {
  $('#avisos').innerHTML = cuotasPorPreguntar().map(({ a, q, i }) => `<div class="aviso"><div><b>¿Pagó ${esc(a.deudor)} su cuota del acuerdo?</b><small>Cuota ${i + 1} de ${a.cuotas.length} · vencía el ${fmt(q.vence)} · ${money(q.monto)}</small></div>
   <div class="actions"><button class="btn small primary" data-ac="pay" data-id="${esc(a.id)}" data-i="${i}" data-v="pagada">Sí, pagó</button><button class="btn small danger" data-ac="pay" data-id="${esc(a.id)}" data-i="${i}" data-v="impaga">No pagó</button></div></div>`).join('');
}
function renderAcuerdos() {
  const n = S.na, cs = D.causas.filter((c) => c.estado !== 'Archivada').sort((a, b) => titulo(a).localeCompare(titulo(b)));
  const form = `<div class="sec"><h4>Nuevo acuerdo</h4><div class="grid2">
    <label class="f">Deudor<input id="na_deudor" value="${esc(n.deudor)}" placeholder="Apellido y nombre"></label>
    <label class="f">Causa (opcional)<select id="na_expte"><option value="">Sin vincular a una causa</option>${cs.map((c) => `<option value="${esc(c.expte)}" ${n.expte === c.expte ? 'selected' : ''}>${esc(titulo(c))} · ${esc(c.expte)}</option>`).join('')}</select></label>
    <label class="f">Cantidad de cuotas<input id="na_n" type="number" min="1" max="120" value="${esc(n.n)}"></label>
    <label class="f">Monto de cada cuota ($)<input id="na_monto" type="number" min="0" value="${esc(n.monto)}"></label>
    <label class="f">Vence la 1ª cuota<input id="na_fecha" type="date" value="${esc(n.fecha)}"></label>
    <label class="f">Frecuencia<select id="na_cada">${[['mes', 'Mensual'], ['quincena', 'Cada 15 días'], ['semana', 'Semanal']].map(([v, l]) => `<option value="${v}" ${n.cada === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="f ancho">Notas<input id="na_notas" value="${esc(n.notas)}" placeholder="Ej.: paga por transferencia, incluye honorarios…"></label></div>
    <div><button class="btn primary" data-ac="create">Crear plan de cuotas</button> <span class="hint">Después podés corregir la fecha y el monto de cada cuota.</span></div></div>`;
  const pill = (q) => { const e = q.estado || 'pendiente'; return e === 'pagada' ? `<span class="pill s-sentencia">Pagada${q.pago ? ' ' + fmt(q.pago) : ''}</span>` : e === 'impaga' ? '<span class="pill s-subasta">No pagó</span>' : (days(q.vence) > 0 ? '<span class="pill s-notificando">Vencida sin confirmar</span>' : '<span class="pill">Pendiente</span>'); };
  const list = D.acuerdos.map((a) => {
    const qs = a.cuotas || [], pag = qs.filter((q) => q.estado === 'pagada'), tot = qs.reduce((x, q) => x + (+q.monto || 0), 0), cob = pag.reduce((x, q) => x + (+q.monto || 0), 0), imp = qs.filter((q) => q.estado === 'impaga').length;
    return `<div class="sec"><div class="achead"><div><b>${esc(a.deudor)}</b>${a.expte ? ` <span class="mono hint">· expte. ${esc(a.expte)}</span>` : ''}${a.notas ? `<div class="hint">${esc(a.notas)}</div>` : ''}</div>
     <div class="hint">${pag.length} de ${qs.length} pagadas${imp ? ` · <span class="malo">${imp} impaga${imp > 1 ? 's' : ''}</span>` : ''} · cobrado ${money(cob)} de ${money(tot)}</div></div>
     <div class="scrollx"><table class="cuo"><thead><tr><th>N°</th><th>Vence</th><th>Monto ($)</th><th>Estado</th><th></th></tr></thead><tbody>
     ${qs.map((q, i) => `<tr><td class="mono">${i + 1}</td><td><input type="date" id="cq_f_${esc(a.id)}_${i}" data-acf="vence" data-id="${esc(a.id)}" data-i="${i}" value="${esc(q.vence)}" aria-label="Vencimiento de la cuota ${i + 1}"></td><td><input type="number" id="cq_m_${esc(a.id)}_${i}" data-acf="monto" data-id="${esc(a.id)}" data-i="${i}" value="${+q.monto || 0}" aria-label="Monto de la cuota ${i + 1}"></td><td>${pill(q)}</td>
      <td class="num">${(q.estado || 'pendiente') === 'pagada' ? `<button class="btn small" data-ac="pay" data-id="${esc(a.id)}" data-i="${i}" data-v="pendiente">Deshacer</button>` : `<button class="btn small donebtn m0" data-ac="pay" data-id="${esc(a.id)}" data-i="${i}" data-v="pagada">Pagó</button>${q.estado === 'impaga' ? '' : ` <button class="btn small danger" data-ac="pay" data-id="${esc(a.id)}" data-i="${i}" data-v="impaga">No pagó</button>`}`} <button class="x" data-ac="delq" data-id="${esc(a.id)}" data-i="${i}" aria-label="Quitar cuota">×</button></td></tr>`).join('')}
     </tbody></table></div>
     <div class="actions"><button class="btn small" data-ac="addq" data-id="${esc(a.id)}">+ Cuota</button>${S.acDel === a.id ? `<button class="btn small danger" data-ac="delyes" data-id="${esc(a.id)}">Sí, eliminar el acuerdo</button><button class="btn small" data-ac="delno">Cancelar</button>` : `<button class="btn small danger" data-ac="del" data-id="${esc(a.id)}">Eliminar acuerdo</button>`}</div></div>`;
  }).join('');
  return `<div class="acgrid">${form}${list || '<div class="empty"><b>Todavía no cargaste ningún acuerdo</b>Completá el formulario de arriba para crear el primer plan de cuotas. A los ' + GRACIA + ' días de vencida cada cuota, el gestor te va a preguntar si el deudor pagó.</div>'}</div>`;
}

const CAMBIO_ACUERDO = 'El acuerdo cambió recién. Revisalo y probá de nuevo';
async function cambiarCuotas(a, cuotas, ok) {
  const r = await actualizarAcuerdo(a.id, a.rev, { cuotas });
  toast(r.conflicto ? CAMBIO_ACUERDO : ok);
}
async function acAct(b) {
  const k = b.dataset.ac, id = b.dataset.id || '', i = +b.dataset.i;
  if (k === 'del') { S.acDel = id; render(); return; }
  if (k === 'delno') { S.acDel = ''; render(); return; }
  try {
    if (k === 'create') {
      keepNa(); const n = S.na, cant = parseInt(n.n, 10), monto = +n.monto || 0;
      if (!n.deudor.trim()) { toast('Falta el deudor'); return; } if (!(cant >= 1 && cant <= 120)) { toast('Indicá la cantidad de cuotas'); return; } if (!n.fecha) { toast('Indicá el vencimiento de la 1ª cuota'); return; }
      const d0 = parse(n.fecha), cuotas = Array.from({ length: cant }, (_, j) => ({ vence: addPeriodo(d0, j, n.cada), monto, estado: 'pendiente', pago: '' }));
      S.na = { deudor: '', expte: '', n: '', monto: '', fecha: '', cada: 'mes', notas: '' };
      const pedido = { deudor: n.deudor.trim(), expte: n.expte, notas: n.notas.trim(), cuotas, creado: iso(today()) };
      try { await crearAcuerdo(pedido); } catch (e) { S.na = n; render(); throw e; } // si falla, el formulario no se pierde
      toast('Plan de cuotas creado'); return;
    }
    if (k === 'delyes') { await borrarAcuerdo(id); S.acDel = ''; toast('Acuerdo eliminado'); return; }
    const a = D.acuerdos.find((x) => x.id === id); if (!a) return; const cuotas = copia(a.cuotas || []);
    if (k === 'pay') { const v = b.dataset.v; cuotas[i].estado = v; cuotas[i].pago = v === 'pagada' ? iso(today()) : ''; await cambiarCuotas(a, cuotas, v === 'pagada' ? 'Cuota marcada como pagada' : v === 'impaga' ? 'Cuota marcada como no pagada' : 'Cuota vuelta a pendiente'); return; }
    if (k === 'addq') { const last = cuotas[cuotas.length - 1]; cuotas.push({ vence: last ? addPeriodo(parse(last.vence), 1, 'mes') : iso(today()), monto: last ? last.monto : 0, estado: 'pendiente', pago: '' }); await cambiarCuotas(a, cuotas, 'Cuota agregada'); return; }
    if (k === 'delq') { cuotas.splice(i, 1); await cambiarCuotas(a, cuotas, 'Cuota quitada'); }
  } catch (e) { toast(mensaje(e)); }
}
document.addEventListener('change', async (e) => {
  const t = e.target; if (!t.dataset || !t.dataset.acf) return; const a = D.acuerdos.find((x) => x.id === t.dataset.id); if (!a) return;
  const cuotas = copia(a.cuotas || []); cuotas[+t.dataset.i][t.dataset.acf] = t.dataset.acf === 'monto' ? (+t.value || 0) : t.value;
  try { await cambiarCuotas(a, cuotas, 'Cuota actualizada'); } catch (err) { toast(mensaje(err)); }
});

// ───────────────────────── Plantillas ─────────────────────────

const CAMPOS = ['caratula', 'expediente', 'actor', 'demandado', 'tipo', 'nominacion', 'oficina'];
function fill(t, c) {
  const m = { caratula: caratula(c), expediente: c.expte, actor: c.actor, demandado: c.demandado, tipo: c.tipo, nominacion: c.nom ? c.nom + '°' : '', oficina: c.oficina };
  return String(t || '').replace(/\{\{\s*([a-záéíóúñ]+)\s*\}\}/gi, (x, k) => { k = k.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); return k in m ? (m[k] || '') : x; });
}
function tplHtml(c) {
  const ps = D.plantillas, p = ps.find((x) => x.id === S.tpSel);
  return `<div class="sec"><h4>Escritos</h4>${ps.length ? `<label class="f">Plantilla<select id="tp_sel"><option value="">Elegí una plantilla…</option>${ps.map((x) => `<option value="${esc(x.id)}" ${x.id === S.tpSel ? 'selected' : ''}>${esc(x.titulo)}</option>`).join('')}</select></label>` : '<p class="hint m0">Todavía no hay plantillas. Creá la primera desde “Plantillas”.</p>'}
  ${p ? `<label class="f">Título / sumario<input id="tp_tit" readonly value="${esc(fill(p.titulo, c))}"></label>
   <label class="f">Cuerpo<textarea id="tp_cue" rows="12" readonly>${esc(fill(p.cuerpo, c))}</textarea></label>
   <div class="actions"><button class="btn small" data-tp="copy" data-src="tp_tit">Copiar título</button><button class="btn small primary" data-tp="copy" data-src="tp_cue">Copiar cuerpo</button></div>` : ''}</div>`;
}
function renderTpl(entra = false) {
  const d = $('#drawer'), sc = entra ? 0 : ($('.panel')?.scrollTop || 0); d.hidden = false; document.body.style.overflow = 'hidden';
  const item = (x) => `<div class="sec"><h4>${x.id ? 'Plantilla' : 'Nueva plantilla'}</h4>
    <label class="f">Título<input id="pt_${esc(x.id || 'new')}" value="${esc(x.titulo || '')}" placeholder="Ej.: Solicita aprobación de liquidación y designa martillero"></label>
    <label class="f">Cuerpo<textarea id="pc_${esc(x.id || 'new')}" rows="${x.id ? 10 : 6}" placeholder="Texto del escrito…">${esc(x.cuerpo || '')}</textarea></label>
    <div class="actions"><button class="btn small primary" data-tp="save" data-id="${esc(x.id || '')}">${x.id ? 'Guardar cambios' : 'Crear plantilla'}</button>
    ${x.id ? (S.tplDel === x.id ? `<button class="btn small danger" data-tp="delyes" data-id="${esc(x.id)}">Sí, eliminar</button><button class="btn small" data-tp="delno">Cancelar</button>` : `<button class="btn small danger" data-tp="del" data-id="${esc(x.id)}">Eliminar</button>`) : ''}</div></div>`;
  d.innerHTML = `<div class="scrim" data-act="close"></div><aside class="panel${entra ? ' entra' : ''}" role="dialog" aria-modal="true" aria-label="Plantillas de escritos">
   <div class="phead"><div><div class="hint">Biblioteca</div><h2>Plantillas de escritos</h2></div><button class="btn small" data-act="close">Cerrar</button></div>
   <p class="hint m0">Podés usar campos que se completan con los datos de cada causa: ${CAMPOS.map((k) => '{{' + k + '}}').join(', ')}.</p>
   ${D.plantillas.map(item).join('') || '<p class="hint">Todavía no hay plantillas guardadas.</p>'}${item({})}<div class="pfin"></div></aside>`;
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
// El chat deja cada escrito como borrador; la persona lo revisa y toca "Agendar" (es la única
// aprobación que vale), y la tarea programada de Claude lo presenta ese día desde la compu del
// estudio. Ver supabase/migrations/0005.

const ESTADO_AG = {
  borrador: ['Sin confirmar', 's-notificando'], pendiente: ['Agendado', 's-despacho'], presentado: ['Presentado', 's-sentencia'],
  error: ['No se presentó', 's-subasta'], cancelado: ['Cancelado', ''],
};
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const fmtDia = (s) => { const d = parse(s); return d ? d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) : ''; };
const fmtLargo = (s) => { const d = parse(s); return d ? `${DIAS[d.getDay()]} ${fmtDia(s)}` : ''; };
/** Escritos que todavía piden algo: confirmarlos, esperar a que se presenten o resolver un error. */
const agendaAbierta = (expte) => D.agenda.filter((a) => a.expte === expte && ['borrador', 'pendiente', 'error'].includes(a.estado));
/** Cuándo corre la próxima tarea del SAC: hoy si es día hábil y todavía no son las 10:15; si no, el próximo día hábil. */
function proximaCorrida() {
  const d = today(), ahora = hora(new Date());
  if (d.getDay() % 6 === 0 || ahora >= HORA_SAC) do d.setDate(d.getDate() + 1); while (d.getDay() % 6 === 0);
  return iso(d);
}
/** La corrida que toma un escrito agendado para `fecha`: ese día si es hábil y no pasó; si no, la siguiente. */
function corridaPara(fecha) {
  const p = proximaCorrida(); if (fecha <= p) return p;
  const d = parse(fecha); while (d.getDay() % 6 === 0) d.setDate(d.getDate() + 1);
  return iso(d);
}

/** Copias de los borradores que trajo el chat, por si la lectura de la base todavía no los trae. */
function escritoDe(id) {
  const base = D.agenda.find((a) => a.id === id), copia = Object.values(S.chat?.extras || {}).map((x) => x.copias?.[id]).find(Boolean);
  return base ? { ...copia, ...base } : copia || null; // de la copia quedan los avisos del chat, que la base no guarda
}

function tarjetaAgenda(a, donde) {
  const c = D.causas.find((x) => x.expte === a.expte), [estado, clase] = ESTADO_AG[a.estado] || [a.estado, ''], k = esc(a.id);
  const cab = `<div class="agcab"><span class="pill ${clase}">${esc(estado)}</span><span class="hint">Expte. ${esc(a.expte)}${c ? ' · ' + esc(caratula(c)) : ''}</span></div>`;
  const id = (campo) => `ag_${donde}_${campo}_${k}`;
  if (a.estado === 'borrador') {
    return `<div class="sec agcard borrador" data-ag-id="${k}">${cab}
     <label class="f">Título<input id="${id('t')}" value="${esc(a.titulo)}"></label>
     <label class="f">Texto del escrito<textarea id="${id('c')}" rows="8">${esc(a.cuerpo)}</textarea></label>
     <label class="f">Presentarlo el<input type="date" id="${id('f')}" value="${esc(a.fecha)}" min="${iso(today())}"></label>
     ${a.realizar ? `<label class="chk"><input type="checkbox" id="${id('r')}" checked><span>Al presentarlo, dar por realizada la próxima acción: <b>${esc(a.realizar)}</b></span></label>` : ''}
     ${(a.avisos || []).map((t) => `<p class="sucio m0">${esc(t)}</p>`).join('')}
     <p class="hint m0">Cuando lo agendes, la tarea de Claude lo presenta en el SAC ese día desde las ${HORA_SAC}, desde la compu del estudio, y deja la causa “A despacho”. Si la compu está apagada, te avisa y queda para reintentar.</p>
     <div class="actions"><button class="btn small primary" data-ag="agendar" data-id="${k}" data-donde="${donde}">Agendar</button><button class="btn small" data-ag="descartar" data-id="${k}" data-donde="${donde}">Descartar</button></div>
    </div>`;
  }
  const sale = a.estado === 'pendiente' ? corridaPara(a.fecha) : '';
  const detalle = a.estado === 'pendiente' ? `Se presenta el ${esc(fmtLargo(sale))} desde las ${HORA_SAC}${sale !== a.fecha ? ` (estaba para el ${esc(fmtDia(a.fecha))})` : ''}${a.realizar ? `; da por realizada “${esc(a.realizar)}”` : ''}.`
    : a.estado === 'presentado' ? `${esc(a.resultado || 'Presentado en el SAC')}${a.presentado ? ` · ${esc(cuando(new Date(a.presentado)))}` : ''}`
      : a.estado === 'error' ? esc(a.resultado || 'No se pudo presentar.')
        : 'No se va a presentar.';
  const botones = a.estado === 'pendiente' ? `<button class="btn small danger" data-ag="cancelar" data-id="${k}">Cancelar</button>`
    : a.estado === 'error' ? `<button class="btn small primary" data-ag="reagendar" data-id="${k}">Volver a agendar</button><button class="btn small danger" data-ag="cancelar" data-id="${k}">Cancelar</button>` : '';
  return `<div class="sec agcard ${esc(a.estado)}" data-ag-id="${k}">${cab}<b>${esc(a.titulo)}</b><p class="m0 ${a.estado === 'error' ? 'malo' : 'hint'}">${detalle}</p>${botones ? `<div class="actions">${botones}</div>` : ''}</div>`;
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
      if (!fecha) { toast('Elegí el día en que se presenta'); return; }
      if (fecha < iso(today())) { toast('Ese día ya pasó: elegí hoy o más adelante'); return; }
      const realizar = campo('r')?.checked ? a.realizar : '';
      r = await actualizarAgenda(id, a.rev, { titulo, cuerpo, fecha, realizar, estado: 'pendiente' });
      if (!r.conflicto) {
        anotar(`Confirmaste y quedó agendado "${titulo}" en la causa ${a.expte} para el ${fmt(fecha)}${titulo !== a.titulo || cuerpo !== a.cuerpo ? ' (con cambios tuyos en el texto)' : ''}.`);
        const sale = corridaPara(fecha);
        toast(sale === fecha ? `Agendado: se presenta el ${fmtLargo(fecha)} desde las ${HORA_SAC}` : `Agendado: sale en la corrida del ${fmtLargo(sale)}, a las ${HORA_SAC}`);
      }
    } else if (b.dataset.ag === 'descartar') {
      r = await actualizarAgenda(id, a.rev, { estado: 'cancelado' });
      if (!r.conflicto) { anotar(`Descartaste el borrador "${a.titulo}" de la causa ${a.expte}: no se presenta.`); toast('Borrador descartado'); }
    } else if (b.dataset.ag === 'cancelar') {
      r = await actualizarAgenda(id, a.rev, { estado: 'cancelado' });
      if (!r.conflicto) { anotar(`Cancelaste "${a.titulo}" de la causa ${a.expte}: no se presenta.`); toast('Escrito cancelado: no se presenta'); }
    } else if (b.dataset.ag === 'reagendar') {
      const fecha = proximaCorrida();
      r = await actualizarAgenda(id, a.rev, { estado: 'pendiente', fecha, resultado: '' });
      if (!r.conflicto) { anotar(`Volviste a agendar "${a.titulo}" de la causa ${a.expte} para el ${fmt(fecha)}.`); toast(`Agendado de nuevo: sale el ${fmtLargo(fecha)} desde las ${HORA_SAC}`); }
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
   <p class="hint m0">Cada escrito lo confirmás vos en una tarjeta. Después, una tarea de Claude lo presenta el día indicado desde las ${HORA_SAC} (de lunes a viernes), desde la compu del estudio.</p>
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
  const cols = ['Actor', 'Demandado', 'Tipo', 'Expediente', 'Nominación', 'Oficina', 'Estado', 'Etiquetas', 'Última acción', 'Fecha última acción', 'Próxima acción', 'Vence', 'Notas', 'Capital reclamado', 'Intereses', 'Total reclamado'];
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = '\ufeff' + cols.join(';') + '\n' + filtered().map((c) => [c.actor, c.demandado, c.tipo, c.expte, c.nom, c.oficina, c.estado, (c.etiquetas || []).join(', '), c.ultima, c.fecha, c.proxima, c.vence, c.notas, ...(() => { const k = reclamo(c); return [k.capital, k.interes, k.total]; })()].map(q).join(';')).join('\n');
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
  const mn = e.target.closest('[data-m]'); if (mn) { if (mn.dataset.m === 'cerrar') { S.menu = false; renderMenu(); } else await menuAct(mn); return; }
  const cb = e.target.closest('[data-chat]'); if (cb) { chatAct(cb); return; }
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
  if (act === 'plvolver') { volverAFicha(); return; }
  if (act === 'plsave') { await guardarPlanilla(a); return; }
  if (act === 'choque-pisar') { S.choque = null; await save({ forzar: true }); return; }
  if (act === 'choque-crear') { S.choque = null; await save({ recrear: true }); return; }
  if (act === 'tag') { const t = a.dataset.t; c.etiquetas = (c.etiquetas || []).includes(t) ? c.etiquetas.filter((x) => x !== t) : [...(c.etiquetas || []), t]; }
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
    if (S.menu) { S.menu = false; renderMenu(); } else if (S.planilla && S.open) { readForm(); volverAFicha(); } else if (S.open || S.tpl || S.clave) closeDrawer();
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-id], .fila[data-id]')) { e.preventDefault(); openCausa(e.target.dataset.id); }
  if (e.key === 'Enter' && e.target.id === 'h_texto') document.querySelector('[data-act="histadd"]').click();
  if (e.key === 'Enter' && e.target.id === 'chatTexto' && !e.shiftKey && !movil.matches && !e.isComposing) { e.preventDefault(); $('#fChat').requestSubmit(); }
});
document.addEventListener('change', (e) => {
  if (/^t_tipo\d+$/.test(e.target.id)) { readForm(); rerenderDrawer(); return; }
  if (e.target.id === 'tp_sel') { readForm(); S.tpSel = e.target.value; rerenderDrawer(); }
});
$('#q').addEventListener('input', (e) => { S.q = e.target.value; render(); });
$('#fEstado').addEventListener('change', (e) => { S.estado = e.target.value; render(); });
$('#fNom').addEventListener('change', (e) => { S.nom = e.target.value; render(); });
$('#fOrden').addEventListener('change', (e) => { const [k, dir] = e.target.value.split(':'); if (k) { S.sort = { k, dir: +dir }; render(); } });
const verVista = (v) => () => { S.view = v; try { localStorage.setItem('gj.view', v); } catch { /* sin almacenamiento */ } render(); };
$('#vLista').onclick = verVista('lista'); $('#vAcuerdos').onclick = verVista('acuerdos'); $('#vTablero').onclick = verVista('tablero');
$('#btnNew').onclick = $('#fabNew').onclick = () => openCausa(null);
$('#btnTpl').onclick = abrirPlantillas;
$('#btnExport').onclick = exportar;
// Para lo que el chat de la app no hace (por ejemplo presentar algo ya mismo en el SAC): una
// conversación nueva en la app de Claude, con la causa ya nombrada.
function hablarConClaude(c) {
  const texto = c?.expte
    ? `Sobre el gestor de juicios, causa ${c.expte} (${partes(c)}): `
    : 'Sobre el gestor de juicios: ';
  window.open('https://claude.ai/new?q=' + encodeURIComponent(texto), '_blank', 'noopener');
}
$('#btnChat').onclick = () => abrirChat(null);
$('#btnCuenta').onclick = () => { S.menu = !S.menu; renderMenu(); };
$('#btnFiltros').onclick = (e) => { const abierto = $('#toolbar').classList.toggle('abierto'); e.currentTarget.setAttribute('aria-expanded', abierto); };
movil.addEventListener('change', () => render());

// Cambios que llegan de la base: los propios, los de Claude o los de otro dispositivo.
alCambiar((que, detalle) => {
  if (que === 'sesion') { if (detalle !== S.pantalla) mostrar(detalle); else if (detalle === 'listo') render(); return; }
  if (S.pantalla !== 'listo') return;
  if (que === 'estado') { renderFranja(); if (D.cargado && S.view !== 'acuerdos') subtitulo(`${filtered().length} de ${D.causas.length} causas`); if (S.menu) renderMenu(); return; }
  render();
  if (S.tpl) refrescarTpl();
  if (S.open && !S.isNew) { const n = $('#nota'); if (n) n.innerHTML = notaHtml(); refrescarAgendaFicha(); } // sin tocar lo que se está escribiendo
  if (S.chat?.abierto) refrescarCharla();
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.instalar = e; if (S.menu) renderMenu(); });
window.addEventListener('appinstalled', () => { S.instalar = null; toast('App instalada'); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => { /* la app funciona igual sin él */ });

(async () => {
  try { mostrar(await iniciar()); } catch (e) { console.error(e); S.falla = mensaje(e, 'no se pudo abrir'); mostrar('error'); }
})();

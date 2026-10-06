// Interfaz del gestor. Los datos y la red viven en datos.js.
import {
  D, iniciar, reconectar, entrar, salir, cambiarClave, alCambiar, mensaje, ultimaDe,
  crearCausa, guardarCausa, actualizarCausa, borrarCausa,
  crearAcuerdo, actualizarAcuerdo, borrarAcuerdo,
  crearPlantilla, guardarPlantilla, borrarPlantilla,
} from './datos.js';

const VERSION = '1.1';

const TAGS = [
  { k: 'En trámite', c: '' }, { k: 'Embargo de sueldo', c: 't-emb' }, { k: 'Secuestro / subasta', c: 't-sec' },
  { k: 'Acuerdo', c: 't-acu' }, { k: 'Martillero', c: 't-mar' }, { k: 'OP solicitada', c: 't-op' }];
const ESTADOS = ['Iniciar', 'Notificando', 'Casillero', 'A despacho', 'Sentencia', 'Tramites p/ subasta', 'Acuerdo', 'Archivada'];
const RUBROS = ['Honorarios', 'Intereses honorarios', 'Auto honorarios x ejec.', 'Gastos', 'Capital', 'Intereses capital'];
const STALE = 30; // días sin movimiento para marcar una causa
const GRACIA = 5; // días después del vencimiento de una cuota antes de preguntar si se pagó
const CLAVE_MIN = 10;

const S = {
  pantalla: 'arranque',
  q: '', estado: '', nom: '', tag: '', quick: '', view: 'lista', sort: { k: 'dias', dir: -1 },
  open: null, isNew: false, confirmDel: false, choque: null, // ficha abierta
  tpl: false, tpSel: '', tplDel: '', clave: false, // otros paneles
  na: { deudor: '', expte: '', n: '', monto: '', fecha: '', cada: 'mes', notas: '' }, acDel: '',
  menu: false, instalar: null, ocupado: false,
};
try { S.view = localStorage.getItem('gj.view') || 'lista'; } catch { /* sin almacenamiento */ }

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
const caratula = (c) => `${c.actor || 'AMB'} c/ ${c.demandado || '…'}${c.tipo ? ' – ' + c.tipo : ''}`;
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
  closeDrawer(); S.menu = false; renderMenu();
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
    if (S.quick !== 'acu' && S.estado !== 'Acuerdo' && S.tag !== 'Acuerdo' && isAcu(c)) return false;
    if (q) { const h = [c.actor, c.demandado, c.tipo, c.expte, c.ultima, c.proxima, c.oficina, c.notas, ...(c.etiquetas || [])].join(' ').toLowerCase(); if (!h.includes(q)) return false; }
    return true;
  });
  const { k, dir } = S.sort;
  const val = (c) => (k === 'dias' ? (days(c.fecha) ?? 99999) : k === 'vence' ? (c.proxima && c.vence) || '9999' : k === 'nom' ? Number(c.nom) || 0 : String(c[k] || '').toLowerCase());
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
function tagsHtml(c) { return (c.etiquetas || []).length ? `<div class="tags">${c.etiquetas.map((t) => `<span class="tag ${tagClass(t)}">${esc(t)}</span>`).join('')}</div>` : ''; }

function renderList(rows) {
  if (movil.matches) return renderFilas(rows);
  const th = (k, l) => `<th data-k="${k}">${l}${S.sort.k === k ? (S.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
  return `<div class="tablebox"><table><thead><tr>${th('demandado', 'Carátula')}${th('expte', 'Expte.')}${th('nom', 'Nom. / Oficina')}${th('estado', 'Estado')}${th('ultima', 'Última acción')}${th('dias', 'Fecha')}${th('proxima', 'Próxima acción')}${th('vence', 'Vence')}</tr></thead><tbody>` +
    rows.map((c) => `<tr data-id="${esc(c.expte)}" tabindex="0"><td class="car"><b>${esc(c.demandado)}</b><small>${esc(c.actor)} c/ … ${esc(c.tipo)}</small>${tagsHtml(c)}</td>
   <td class="mono">${esc(c.expte)}</td><td>${c.nom ? esc(c.nom) + '°' : ''} ${esc(c.oficina)}</td>
   <td>${c.estado ? `<span class="pill ${sClass(c.estado)}">${esc(c.estado)}</span>` : '<span class="hint">—</span>'}</td>
   <td>${esc(c.ultima) || '<span class="hint">—</span>'}</td><td>${ageHtml(c)}</td>
   <td class="next ${c.proxima ? '' : 'none'}">${esc(c.proxima) || '—'}${c.proxima ? `<div><button class="btn small donebtn" data-done="${esc(c.expte)}">✓ Realizada</button></div>` : ''}</td>
   <td>${c.vence && c.proxima ? `<span class="due ${dueState(c)}">${fmt(c.vence)}</span>` : '<span class="hint">—</span>'}</td></tr>`).join('') + `</tbody></table></div>`;
}

// En pantallas chicas, cada causa es una tarjeta: se lee de arriba abajo sin deslizar de costado.
function renderFilas(rows) {
  return `<div class="filas">` + rows.map((c) => `<article class="fila" data-id="${esc(c.expte)}" tabindex="0" role="button" aria-label="Abrir la ficha de ${esc(c.demandado)}">
    <div class="fila-top"><b>${esc(c.demandado) || '(sin demandado)'}</b>${c.estado ? `<span class="pill ${sClass(c.estado)}">${esc(c.estado)}</span>` : ''}</div>
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
    return `<section class="col"><h3><span>${esc(e)}</span><span>${cs.length}</span></h3>` + cs.map((c) => `<button class="card" data-id="${esc(c.expte)}"><b>${esc(c.demandado)}</b><div class="mono">${esc(c.expte)} · ${c.nom ? esc(c.nom) + '° ' : ''}${esc(c.oficina)}</div>${tagsHtml(c)}<p>${esc(c.ultima || 'Sin acción cargada')}</p>${ageHtml(c)}${c.proxima ? `<p><b>→</b> ${esc(c.proxima)}</p>` : ''}</button>`).join('') + `</section>`;
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

function blank() { return { expte: '', actor: 'AMB', demandado: '', tipo: 'EJECUTIVO', nom: '', oficina: 'OEP', estado: 'Iniciar', proxima: '', vence: '', ultima: '', fecha: '', etiquetas: ['En trámite'], notas: '', historial: [] }; }
function openCausa(id) {
  S.open = id ? copia(D.causas.find((c) => c.expte === id) || blank()) : blank();
  S.isNew = !id; S.confirmDel = false; S.choque = null; S.tpl = false; S.clave = false; S.tpSel = '';
  renderDrawer(true);
}
function closeDrawer() {
  S.open = null; S.tpl = false; S.clave = false; S.tpSel = ''; S.tplDel = ''; S.choque = null; S.confirmDel = false;
  $('#drawer').hidden = true; $('#drawer').innerHTML = ''; document.body.style.overflow = '';
}
function liqCalc(l) { const tot = l.rubros.reduce((a, r) => a + (+r.monto || 0), 0), pag = l.rubros.reduce((a, r) => a + (+r.pagado || 0), 0); return { tot, pag, saldo: tot - pag, dif: (+l.embargo || 0) - tot }; }
function liqHtml(c) {
  const l = c.liquidacion;
  if (!l) return `<div class="sec"><h4>Liquidación y órdenes de pago</h4><p class="hint m0">Sin liquidación cargada.</p><div><button class="btn small" data-act="liqnew">Cargar liquidación</button></div></div>`;
  const k = liqCalc(l);
  return `<div class="sec"><h4>Liquidación y órdenes de pago</h4>
   <div class="grid2"><label class="f">Fecha liquidación<input type="date" id="l_fecha" value="${esc(l.fecha)}"></label><label class="f">Embargo trabado ($)<input type="number" id="l_emb" value="${+l.embargo || 0}"></label></div>
   <div class="scrollx"><table class="liq"><thead><tr><th>Rubro</th><th class="num">Monto</th><th class="num">Pagado (OP)</th><th class="num">Saldo</th><th></th></tr></thead><tbody>
   ${l.rubros.map((r, i) => `<tr><td><input class="lbl" id="lr_r${i}" data-i="${i}" data-f="rubro" value="${esc(r.rubro)}" aria-label="Rubro"></td><td><input type="number" id="lr_m${i}" data-i="${i}" data-f="monto" value="${+r.monto || 0}" aria-label="Monto"></td><td><input type="number" id="lr_p${i}" data-i="${i}" data-f="pagado" value="${+r.pagado || 0}" aria-label="Pagado"></td><td class="num">${money((+r.monto || 0) - (+r.pagado || 0))}</td><td><button class="x" data-act="rubdel" data-i="${i}" aria-label="Quitar rubro">×</button></td></tr>`).join('')}
   </tbody></table></div>
   <div><button class="btn small" data-act="rubadd">+ Rubro</button></div>
   <div class="totals"><div><span>Total planilla</span><b>${money(k.tot)}</b></div><div><span>Cobrado por OP</span><b>${money(k.pag)}</b></div><div><span>Saldo pendiente</span><b>${money(k.saldo)}</b></div>
   <div class="${k.dif < 0 ? 'neg' : 'pos'}"><span>${k.dif < 0 ? 'Faltante: pedir ampliación de embargo' : 'Excedente sobre planilla'}</span><b>${money(Math.abs(k.dif))}</b></div></div></div>`;
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
      <div class="actions"><button class="btn small" data-act="choque-ver">Ver la versión actual (descarta lo mío)</button><button class="btn small" data-act="choque-pisar">Guardar lo mío igual</button></div></div>`;
  }
  const actual = D.causas.find((x) => x.expte === c.expte);
  if (!actual) return `<div class="nota" role="status"><p><b>Esta causa fue eliminada desde otro lugar.</b></p></div>`;
  if (actual.rev !== c.rev) return `<div class="nota" role="status"><p><b>${esc(actual.actualizado_por || 'Alguien')} actualizó esta causa</b> ${actual.actualizado ? cuando(new Date(actual.actualizado)) : 'recién'}. Lo que ves acá es la versión anterior.</p>
      <div class="actions"><button class="btn small" data-act="choque-ver">Ver la versión actual</button></div></div>`;
  return '';
}

function renderDrawer(entra = false) {
  const c = S.open, d = $('#drawer'); d.hidden = false; document.body.style.overflow = 'hidden';
  const hist = (c.historial || []).map((h, i) => ({ ...h, i })).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || b.i - a.i);
  const meta = !S.isNew && c.actualizado ? ` · último cambio ${cuando(new Date(c.actualizado))}${c.actualizado_por ? ' (' + esc(c.actualizado_por) + ')' : ''}` : '';
  d.innerHTML = `<div class="scrim" data-act="close"></div><aside class="panel${entra ? ' entra' : ''}" role="dialog" aria-modal="true" aria-label="Ficha de la causa">
  <div class="phead"><div><div class="hint">${S.isNew ? 'Nueva causa' : 'Expte. ' + esc(c.expte) + meta}</div><h2>${esc(S.isNew && !c.demandado ? 'Nueva causa' : caratula(c))}</h2></div><button class="btn small" data-act="close">Cerrar</button></div>
  <div id="nota">${notaHtml()}</div>

  <div class="sec"><h4>Datos de la causa</h4><div class="grid2">
   <label class="f">Actor<input id="c_actor" value="${esc(c.actor)}"></label>
   <label class="f">Demandado<input id="c_demandado" value="${esc(c.demandado)}"></label>
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

  ${liqHtml(c)}

  ${S.isNew ? '' : tplHtml(c)}

  <div class="sec"><h4>Notas</h4><label class="f"><textarea id="c_notas" rows="3" placeholder="Datos del martillero, montos del acuerdo, teléfonos…" aria-label="Notas">${esc(c.notas)}</textarea></label></div>

  ${S.isNew ? '' : `<div class="actions"><button class="btn danger" data-act="del">Eliminar causa</button></div>`}
  ${S.confirmDel ? `<div class="confirm"><span>¿Eliminar definitivamente ${esc(c.demandado)}? Si terminó, mejor pasala a “Archivada”.</span><button class="btn small danger" data-act="delyes">Sí, eliminar</button><button class="btn small" data-act="delno">Cancelar</button></div>` : ''}
  <div class="ppie"><button class="btn primary" data-act="save">${S.isNew ? 'Crear causa' : 'Guardar cambios'}</button><button class="btn" data-act="close">Cancelar</button>${S.isNew ? '' : '<button class="btn" data-act="claude" aria-label="Consultar a Claude sobre esta causa">Claude</button>'}</div>
  </aside>`;
}

function rerenderDrawer() { const p = $('.panel'), sc = p ? p.scrollTop : 0; renderDrawer(); if (sc) $('.panel').scrollTop = sc; }

function readForm() {
  const c = S.open;
  ['actor', 'demandado', 'tipo', 'expte', 'nom', 'oficina', 'estado', 'proxima', 'vence', 'notas'].forEach((k) => { const el = $('#c_' + k); if (el) c[k] = el.value.trim(); });
  if (c.liquidacion) {
    const l = c.liquidacion; l.fecha = $('#l_fecha').value; l.embargo = +$('#l_emb').value || 0;
    document.querySelectorAll('.liq input[data-f]').forEach((el) => { const r = l.rubros[+el.dataset.i]; r[el.dataset.f] = el.dataset.f === 'rubro' ? el.value : (+el.value || 0); });
  }
  return c;
}

async function save({ forzar = false, recrear = false } = {}) {
  const c = readForm();
  if (!c.demandado) { toast('Falta el demandado'); return; }
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
  const n = S.na, cs = D.causas.filter((c) => c.estado !== 'Archivada').sort((a, b) => (a.demandado || '').localeCompare(b.demandado || ''));
  const form = `<div class="sec"><h4>Nuevo acuerdo</h4><div class="grid2">
    <label class="f">Deudor<input id="na_deudor" value="${esc(n.deudor)}" placeholder="Apellido y nombre"></label>
    <label class="f">Causa (opcional)<select id="na_expte"><option value="">Sin vincular a una causa</option>${cs.map((c) => `<option value="${esc(c.expte)}" ${n.expte === c.expte ? 'selected' : ''}>${esc(c.demandado)} · ${esc(c.expte)}</option>`).join('')}</select></label>
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
  const cols = ['Actor', 'Demandado', 'Tipo', 'Expediente', 'Nominación', 'Oficina', 'Estado', 'Etiquetas', 'Última acción', 'Fecha última acción', 'Próxima acción', 'Vence', 'Notas'];
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = '\ufeff' + cols.join(';') + '\n' + filtered().map((c) => [c.actor, c.demandado, c.tipo, c.expte, c.nom, c.oficina, c.estado, (c.etiquetas || []).join(', '), c.ultima, c.fecha, c.proxima, c.vence, c.notas].map(q).join(';')).join('\n');
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
  if (act === 'claude') { hablarConClaude(S.open); return; }
  if (!c) return;
  if (act === 'choque-ver') { const actual = D.causas.find((x) => x.expte === c.expte); if (!actual) { closeDrawer(); return; } S.open = copia(actual); S.choque = null; S.confirmDel = false; renderDrawer(); return; }
  readForm();
  if (act === 'choque-pisar') { S.choque = null; await save({ forzar: true }); return; }
  if (act === 'choque-crear') { S.choque = null; await save({ recrear: true }); return; }
  if (act === 'tag') { const t = a.dataset.t; c.etiquetas = (c.etiquetas || []).includes(t) ? c.etiquetas.filter((x) => x !== t) : [...(c.etiquetas || []), t]; }
  if (act === 'histadd') {
    const f = $('#h_fecha').value, t = $('#h_texto').value.trim(); if (!t) { toast('Escribí la acción realizada'); return; }
    c.historial = [...(c.historial || []), { fecha: f, texto: t }]; Object.assign(c, ultimaDe(c.historial));
  }
  if (act === 'histdel') { c.historial.splice(+a.dataset.i, 1); Object.assign(c, ultimaDe(c.historial)); }
  if (act === 'liqnew') { c.liquidacion = { fecha: iso(today()), embargo: 0, rubros: RUBROS.map((r) => ({ rubro: r, monto: 0, pagado: 0 })) }; }
  if (act === 'rubadd') { c.liquidacion.rubros.push({ rubro: '', monto: 0, pagado: 0 }); }
  if (act === 'rubdel') { c.liquidacion.rubros.splice(+a.dataset.i, 1); }
  if (act === 'done') { if (!applyDone(c)) { toast('No hay próxima acción anotada'); return; } $('#c_proxima').value = ''; $('#c_vence').value = ''; await save(); return; }
  if (act === 'del') { S.confirmDel = true; }
  if (act === 'delno') { S.confirmDel = false; }
  if (act === 'delyes') { try { await borrarCausa(c.expte); toast('Causa eliminada'); closeDrawer(); } catch (err) { toast(mensaje(err, 'no se eliminó')); } return; }
  if (act === 'save') { await save(); return; }
  rerenderDrawer();
  if (act === 'del') $('.confirm')?.scrollIntoView({ block: 'nearest' });
  if (act === 'histadd') toast('Movimiento agregado. Tocá “Guardar cambios”.');
});

document.addEventListener('input', (e) => {
  if (e.target.closest('.liq') || e.target.id === 'l_emb') { // recalcular los totales sin perder el foco
    clearTimeout(S.lt); S.lt = setTimeout(() => { if (!S.open) return; const id = document.activeElement?.id; readForm(); rerenderDrawer(); if (id) { const el = document.getElementById(id); if (el) el.focus(); } }, 700);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (S.menu) { S.menu = false; renderMenu(); } else if (S.open || S.tpl || S.clave) closeDrawer(); }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-id], .fila[data-id]')) { e.preventDefault(); openCausa(e.target.dataset.id); }
  if (e.key === 'Enter' && e.target.id === 'h_texto') document.querySelector('[data-act="histadd"]').click();
});
document.addEventListener('change', (e) => {
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
// Claude no vive dentro de la app: se abre una conversación nueva con la causa ya nombrada.
// Los cambios los hace Claude con el conector de la base y la app los muestra en vivo.
function hablarConClaude(c) {
  const texto = c?.expte
    ? `Sobre el gestor de juicios, causa ${c.expte} (${c.actor} c/ ${c.demandado}): `
    : 'Sobre el gestor de juicios: ';
  window.open('https://claude.ai/new?q=' + encodeURIComponent(texto), '_blank', 'noopener');
}
$('#btnChat').onclick = () => hablarConClaude(null);
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
  if (S.open && !S.isNew) { const n = $('#nota'); if (n) n.innerHTML = notaHtml(); } // sin tocar lo que se está escribiendo
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.instalar = e; if (S.menu) renderMenu(); });
window.addEventListener('appinstalled', () => { S.instalar = null; toast('App instalada'); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => { /* la app funciona igual sin él */ });

(async () => {
  try { mostrar(await iniciar()); } catch (e) { console.error(e); S.falla = mensaje(e, 'no se pudo abrir'); mostrar('error'); }
})();

// Panel máster del cotizador: lo que la Mutual administra (solicitudes y su aprobación, Formulario 03 y contratos de prenda,
// agencias, chats, parámetros, cotizaciones y estadísticas). Vive en el cotizador porque es parte del otorgamiento de créditos
// (pedido de la persona del 27/11/2026). Entra solo un miembro de la Mutual: lo controla la base, no esta pantalla.
// La base (../../cobranzas/datos.js, con su sesión) y los estilos se comparten con Créditos y Cobros.
import {
  D, modoPanel, iniciar, reconectar, entrar, salir, cambiarClave, alCambiar, mensaje,
  leerAgencias, leerConectadas, contarSolicitudes, guardarAjustesAgencias, altaAgencia, crearAgencia, crearVendedor, activarVendedor, activarAgencia, resolverSolicitud, documentosSolicitud, leerDocumentos, eliminarSolicitud, eliminarCotizaciones, estadisticasAgencias,
  chatsAgencias, chatResumen, verChat, responderChat, cerrarChat, eliminarChat, iniciarChat, claveAvisos, registrarAvisos, quitarAvisos, probarAvisos,
} from '../../cobranzas/datos.js';
import { htmlAgencias, htmlConectadas, htmlFaltanGen, parametrosEnTexto, leerParametros, TABS_AGENCIAS } from './panel.js?v=20261127i';
import { htmlRapida, nuevaRapida, calcularRapida, textoRapida } from './mostrador.js?v=20261127i';
import { datosDeSolicitud, textoVencimientos, armarFormularios, conDomicilioDelDeudor, aplicarLectura } from './prendaforms.js';
import { armarAsentimiento } from './asentimiento.js?v=20261127g';
import { esc, hoy, cuantos } from '../../cobranzas/textos.js';

const CLAVE_MIN = 10;
const agVacio = () => ({
  rap: nuevaRapida(),
  est: { dias: 30, filas: null, error: '' },
  datos: null, cargando: false, error: '', tab: 'solicitudes', msg: '', docs: new Map(), notas: {}, p: {}, alta: {}, vend: {}, pend: 0, conx: { filas: null, abierto: false }, borrar: '', borrarCot: '', selCot: new Set(), gen: null, nueva: null,
  chat: { lista: [], atencion: 0, espera: 0, error: '', hilo: null, mensajes: [], texto: '', enviando: false, push: 'cargando', pushMsg: '' },
});
modoPanel();
const S = { pantalla: 'arranque', vista: 'agencias', falla: '', ag: agVacio() };
// «Nuevo crédito» no se recuerda: es otra pantalla (nuevo.html), la misma de las agencias.
const esSolapa = (t) => t !== 'nuevo' && TABS_AGENCIAS.some(([k]) => k === t);
try { const t = localStorage.getItem('cb.agTab'); if (esSolapa(t)) S.ag.tab = t; } catch { /* sin almacenamiento */ }

const $ = (s) => document.querySelector(s);
const movil = window.matchMedia('(max-width: 720px)');
const vacio = (titulo, texto) => `<div class="empty"><b>${esc(titulo)}</b>${esc(texto)}</div>`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, Math.min(12000, Math.max(3200, msg.length * 55)));
}
const subtitulo = (texto) => { $('#sub').textContent = texto; };
/** Lo que se escribe en los formularios vive en S (data-k="ag.alta.nombre"), así sobrevive a los redibujos. */
function poner(ruta, v) {
  const ks = ruta.split('.'); let o = S;
  for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  o[ks[ks.length - 1]] = v;
}
function guardarFoco(caja) {
  const a = document.activeElement;
  if (!a || !caja.contains(a) || !(a.dataset?.k || a.id)) return null;
  let sel = null; try { if (a.selectionStart != null) sel = [a.selectionStart, a.selectionEnd]; } catch { /* sin selección */ }
  return { k: a.dataset.k, id: a.id, sel };
}
function devolverFoco(f) {
  if (!f) return;
  const el = f.k ? document.querySelector(`[data-k="${CSS.escape(f.k)}"]`) : document.getElementById(f.id);
  if (!el || el === document.activeElement) return;
  el.focus({ preventScroll: true });
  if (f.sel) try { el.setSelectionRange(f.sel[0], f.sel[1]); } catch { /* tipos sin selección */ }
}
function copiar(texto) {
  navigator.clipboard.writeText(texto).then(() => toast('Copiado'), () => toast('No se pudo copiar en este dispositivo'));
}
// `otros` ([{blob, archivo}]) salen junto con el primero: en el celular se comparten todos de una vez, porque el
// teléfono no deja abrir «compartir» dos veces con un solo toque.
async function entregar(blob, archivo, otros = []) {
  const todos = [{ blob, archivo }, ...otros];
  const fs = typeof File === 'function' ? todos.map((x) => new File([x.blob], x.archivo, { type: x.blob.type })) : null;
  if (movil.matches && fs && navigator.canShare?.({ files: fs })) {
    try { await navigator.share({ files: fs, title: archivo }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  for (const x of todos) {
    const url = URL.createObjectURL(x.blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: x.archivo });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return true;
}
const verVista = () => render();

function render() {
  if (S.pantalla !== 'listo') return;
  const main = $('#main'), foco = guardarFoco(main);
  main.innerHTML = vistaAgencias();
  // Las barras se dibujan sin estilos en línea (la política de seguridad no los deja): el ancho va después.
  main.querySelectorAll('[data-ancho]').forEach((el) => { el.style.width = Math.max(0, Math.min(100, +el.dataset.ancho || 0)) + '%'; });
  const n = S.ag.pend + (S.ag.chat.atencion || 0);
  document.title = `${n ? `(${n}) ` : ''}Panel máster · Mutual Bell`;
  devolverFoco(foco);
}

function mostrar(pantalla) {
  S.pantalla = pantalla;
  const enApp = pantalla === 'listo';
  $('#vApp').hidden = !enApp;
  $('#vIngreso').hidden = enApp;
  $('#cabDer').hidden = !enApp;
  if (enApp) { $('#vIngreso').innerHTML = ''; render(); cargarAgencias(); cargarConectadas(); return; }
  const tab = S.ag.tab;
  $('#main').innerHTML = ''; $('#sub').textContent = '';
  $('#toast').hidden = true; $('#toast').textContent = ''; // el aviso puede nombrar a un cliente
  S.ag = { ...agVacio(), tab }; // al salir no queda nada de otra sesión
  renderIngreso();
}

function renderIngreso() {
  const c = $('#vIngreso'), email = esc(D.usuario?.email || '');
  const error = '<p class="error" id="i_error" role="alert" hidden></p>';
  const caja = (h) => { c.innerHTML = `<section class="card ingreso">${h}</section>`; };
  if (S.pantalla === 'ingreso') {
    caja(`<h2>Acceso de la Mutual</h2><form id="fIngreso" novalidate>
      <label class="f">Email<input id="i_email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false"></label>
      <label class="f">Contraseña<input id="i_clave" type="password" autocomplete="current-password"></label>
      ${error}<button class="btn primary" type="submit">Ingresar</button></form>
      <p class="hint">Entrá con tu usuario de la Mutual. <a href="../">Volver al cotizador</a></p>`);
    $('#i_email').focus();
  } else if (S.pantalla === 'clave-temporal') {
    caja(`<h2>Elegí tu contraseña</h2><form id="fClave" novalidate>
      <input type="email" autocomplete="username" value="${email}" hidden>
      <label class="f">Contraseña nueva (${CLAVE_MIN} caracteres o más)<input id="n_clave" type="password" autocomplete="new-password"></label>
      <label class="f">Repetila<input id="n_clave2" type="password" autocomplete="new-password"></label>
      ${error}<button class="btn primary" type="submit">Guardar contraseña</button></form>`);
  } else if (S.pantalla === 'sin-acceso') {
    caja(`<h2>Esta cuenta no es de la Mutual</h2><p class="hint">Ingresaste como ${email}. El panel máster es solo para la Mutual.</p>
      <div class="actions"><button class="btn" data-ing="salir">Cerrar sesión</button><a class="btn" href="../">Ir al cotizador</a></div>`);
  } else if (S.pantalla === 'sin-red') {
    caja('<h2>No se pudo conectar</h2><p class="hint">Revisá tu conexión a internet.</p><button class="btn primary" data-ing="reintentar">Reintentar</button>');
  } else caja(`<h2>No se pudo abrir el panel</h2><p class="hint">${esc(S.falla || 'Probá de nuevo desde su propia pestaña.')}</p>`);
}
const errorIngreso = (t) => { const e = $('#i_error'); if (e) { e.textContent = t; e.hidden = false; } };

function vistaAgencias() {
  const G = S.ag;
  if (!G.datos && !G.cargando && !G.error) setTimeout(cargarAgencias); // fuera del dibujo: cargar vuelve a dibujar
  if (!G.datos) {
    subtitulo('Cotizador para agencias');
    return G.error ? `${vacio('No se pudo abrir', G.error)}<div class="actions"><button class="btn" data-a="ag-recargar">Probar de nuevo</button></div>`
      : vacio('Cargando las solicitudes…', 'Las solicitudes de crédito que mandan las agencias, con el informe del BCRA y los documentos.');
  }
  const pend = G.datos.solicitudes.filter((x) => x.estado === 'pendiente' || x.estado === 'en_analisis').length;
  subtitulo(`${pend ? cuantos(pend, 'solicitud pendiente', 'solicitudes pendientes') : 'Sin solicitudes pendientes'} · el cotizador está ${G.datos.ajustes?.habilitado ? 'habilitado' : 'apagado'}`);
  return htmlConectadas(G.conx) + htmlAgencias(G.datos, { ...G, vistas: { rapida: htmlRapida } });
}

async function cargarAgencias() {
  const G = S.ag;
  if (G.cargando) return;
  G.cargando = true; G.error = '';
  try {
    G.datos = await leerAgencias();
    G.p = parametrosEnTexto(G.datos.ajustes || {});
    G.pend = G.datos.solicitudes.filter((x) => x.estado === 'pendiente' || x.estado === 'en_analisis').length;
    await cargarChats(false);
  } catch (e) {
    G.error = /PGRST205|42P01|does not exist/i.test(`${e.code} ${e.message}`) ? 'Falta activar el cotizador de agencias en la base. Avisale a Claude.' : mensaje(e, 'no se pudo leer');
  }
  G.cargando = false;
  render();
  if (G.tab === 'estadisticas') cargarEstadisticas(); // la solapa se recuerda: si se abrió en esa, se calcula al entrar
}

async function cargarEstadisticas() {
  const E = S.ag.est, dias = E.dias;
  E.filas = null; E.error = ''; render();
  try { const f = await estadisticasAgencias(dias); if (E.dias === dias) E.filas = f; }
  catch (e) { E.error = /PGRST202|42883|does not exist/i.test(`${e.code} ${e.message}`) ? 'Falta activar las estadísticas en la base. Avisale a Claude.' : mensaje(e, 'no se pudieron calcular las estadísticas'); }
  render();
}

/** Cuántas solicitudes esperan respuesta: el aviso de la solapa y de Inicio. Si cambió, se redibuja. */
async function contarPendientes() {
  if (S.pantalla !== 'listo') return;
  const [n, r] = await Promise.all([contarSolicitudes(), chatResumen()]);
  const atencion = r ? r.atencion || 0 : S.ag.chat.atencion;
  if (n === S.ag.pend && atencion === S.ag.chat.atencion) return;
  const nuevoChat = atencion !== S.ag.chat.atencion, nuevasSol = n !== S.ag.pend;
  S.ag.pend = n; S.ag.chat.atencion = atencion;
  if (S.vista === 'agencias' && nuevasSol) cargarAgencias(); // solicitudes nuevas: se vuelve a leer todo
  else if (S.vista === 'agencias' && S.ag.tab === 'chats' && nuevoChat) { await cargarChats(true); render(); }
  else render();
}

// ── Chats de las agencias ──
/** La lista de conversaciones (y, si hay una abierta, sus mensajes). Un error no tira abajo el resto de la vista. */
async function cargarChats(silencioso) {
  const C = S.ag.chat;
  try {
    const r = await chatsAgencias();
    C.lista = r.chats || []; C.atencion = r.atencion || 0; C.espera = r.espera || 0; C.error = '';
    if (C.hilo) {
      const v = await verChat(C.hilo.id);
      C.hilo = v.chat; C.mensajes = v.mensajes || [];
    }
  } catch (e) {
    if (!silencioso) C.error = e.codigo === 'accion' || e.status === 400 ? 'El chat todavía no está publicado en la función. Avisale a Claude.' : mensaje(e, 'no se pudo leer el chat');
  }
  if (S.ag.tab === 'chats' && C.push === 'cargando') revisarAvisos();
}

async function abrirHiloAgencia(id) {
  const C = S.ag.chat;
  try {
    const v = await verChat(id);
    C.hilo = v.chat; C.mensajes = v.mensajes || []; C.texto = ''; C.error = ''; C.borrar = false;
  } catch (e) { C.error = mensaje(e, 'no se pudo abrir la conversación'); }
  await contarPendientes();
  render();
  const m = $('#agMsgs'); if (m) m.scrollTop = m.scrollHeight;
}

// ── Avisos al celular (Web Push). El service worker (sw.js) los muestra; la función los manda. ──
const deB64u = (x) => Uint8Array.from(atob(String(x).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(x).length % 4)) % 4)), (c) => c.charCodeAt(0));
const sePuedeAvisar = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
/** El service worker puede no quedar listo nunca (si no se pudo registrar): se espera un rato y se avisa, sin quedarse «revisando». */
const swListo = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error('sin service worker')), 8000))]);
/** Al entrar a Chats, aunque el panel haya abierto en otra solapa: las conversaciones al día y cómo están los avisos. */
async function entrarAChats() {
  revisarAvisos();
  await cargarChats(true);
  if (S.ag.tab === 'chats') render();
}
/** Mira cómo está este dispositivo: no puede, bloqueado, sin activar o activado. */
async function revisarAvisos() {
  const C = S.ag.chat;
  let estado = 'no';
  try {
    if (sePuedeAvisar()) {
      if (Notification.permission === 'denied') estado = 'denegado';
      else estado = (await (await swListo()).pushManager.getSubscription()) ? 'activo' : 'inactivo';
    }
  } catch { estado = 'error'; }
  if (C.push !== estado) { C.push = estado; render(); }
}
async function activarAvisos() {
  const C = S.ag.chat;
  C.pushMsg = '';
  try {
    if ((await Notification.requestPermission()) !== 'granted') { C.pushMsg = 'No diste el permiso: los avisos quedaron apagados.'; await revisarAvisos(); render(); return; }
    const reg = await swListo();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: deB64u(await claveAvisos()) });
    await registrarAvisos(sub.toJSON(), navigator.userAgent);
    C.push = 'activo'; C.pushMsg = 'Listo: avisos activados. Probalos con «Mandarme un aviso de prueba».';
  } catch (e) { C.pushMsg = mensaje(e, 'no se pudieron activar los avisos'); await revisarAvisos(); }
  render();
}
async function quitarAvisosAca() {
  const C = S.ag.chat;
  try {
    const sub = await (await swListo()).pushManager.getSubscription();
    if (sub) { await quitarAvisos(sub.endpoint).catch(() => {}); await sub.unsubscribe(); }
    C.push = 'inactivo'; C.pushMsg = 'Avisos desactivados en este dispositivo.';
  } catch (e) { C.pushMsg = mensaje(e, 'no se pudieron desactivar'); }
  render();
}
async function probarAvisosAca() {
  const C = S.ag.chat;
  try {
    const r = await probarAvisos();
    C.pushMsg = r.enviados ? 'Aviso enviado: tendría que llegarte en unos segundos.' : r.celulares ? 'No se pudo entregar el aviso. Desactivá y volvé a activar los avisos en este celular.' : 'Esta cuenta no tiene celulares registrados todavía.';
  } catch (e) { C.pushMsg = mensaje(e, 'no se pudo mandar el aviso de prueba'); }
  render();
}

/** «Descargar todo en un PDF»: los documentos de la solicitud, con enlaces recién pedidos, en un solo archivo. */
async function pdfDeSolicitud(id) {
  const sol = S.ag.datos?.solicitudes.find((x) => x.id === id);
  if (!sol) return;
  toast('Armando el PDF con los documentos…');
  try {
    const archivos = await documentosSolicitud(id);
    const bajarArchivo = async (url) => {
      if (!url) throw new Error('sin enlace');
      const r = await fetch(url);
      if (!r.ok) throw new Error('archivo ' + r.status);
      return new Uint8Array(await r.arrayBuffer());
    };
    const { pdfSolicitud } = await import('./unirpdf.js');
    const { bytes, problemas } = await pdfSolicitud(sol, archivos, bajarArchivo, { hoy: hoy() });
    const nombre = String(sol.denominacion || sol.cuit || 'cliente').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    const archivo = `${hoy().slice(2).replace(/-/g, '')} - Solicitud de crédito - ${nombre}.pdf`;
    if (!(await entregar(new Blob([bytes], { type: 'application/pdf' }), archivo))) return;
    toast(problemas.length ? `PDF listo, pero no se pudo incluir: ${problemas.join(', ')}` : `PDF listo: ${archivo}`);
  } catch (e) { console.error(e); toast(mensaje(e, 'no se pudo armar el PDF')); }
}

// ---- Documentación del Registro del Automotor: Formulario 03 y contratos de prenda (solo los datos, sobre papel oficial) ----
const AJUSTE_PRENDA = 'cb.prendaAjuste';
function abrirGenerar(id, tipo) {
  const sol = S.ag.datos?.solicitudes.find((x) => x.id === id);
  if (!sol) return;
  if (S.ag.gen && S.ag.gen.id === id && S.ag.gen.tipo === tipo) { S.ag.gen = null; render(); return; }
  let aj = {}; try { aj = JSON.parse(localStorage.getItem(AJUSTE_PRENDA) || '{}'); } catch { /* sin almacenamiento */ }
  S.ag.gen = { id, tipo, p: datosDeSolicitud(sol, hoy()), dx: aj.dx ?? '', dy: aj.dy ?? '', sinOriginal: false, sinCopia: false };
  render();
  document.querySelector('.ag-gen-panel')?.scrollIntoView({ block: 'nearest' });
}
/** «Leer documentos»: la función lee el título y el DNI de la solicitud; lo leído completa los campos vacíos y queda para revisar. */
async function leerDocumentosGen() {
  const g = S.ag.gen; if (!g || g.leyendo) return;
  const sol = S.ag.datos?.solicitudes.find((x) => x.id === g.id);
  g.leyendo = true; g.lecturaError = ''; render();
  try {
    const l = await leerDocumentos(g.id);
    if (S.ag.gen === g) g.lectura = aplicarLectura(g.p, l, sol);
  } catch (e) { g.lecturaError = mensaje(e, 'no se pudieron leer los documentos'); }
  g.leyendo = false; render();
}
const mm = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
function datosListos(g) {
  const p = conDomicilioDelDeudor(g.p);
  for (const k of ['monto', 'cuotas', 'cuota', 'tna']) {
    if (k === 'tna' && String(p[k] ?? '').trim() === '-') continue; // el guion se imprime tal cual
    p[k] = Number(String(p[k] ?? '').replace(',', '.')) || 0;
  }
  if (!p.vencimientos) p.vencimientos = textoVencimientos(p);
  if (p.fecha) p.fecha = String(p.fecha);
  return p;
}
async function generarFormularios() {
  const g = S.ag.gen; if (!g) return;
  const cuales = g.tipo === 'prenda' ? ['f03'] : g.sinOriginal && !g.sinCopia ? ['b'] : g.sinCopia && !g.sinOriginal ? ['a'] : ['a', 'b'];
  try {
    localStorage.setItem(AJUSTE_PRENDA, JSON.stringify({ dx: g.dx, dy: g.dy }));
  } catch { /* sin almacenamiento */ }
  try {
    const { bytes } = await armarFormularios(datosListos(g), { dx: mm(g.dx), dy: mm(g.dy), hoy: hoy(), cuales });
    const nombre = String(g.p.deudor?.nombre || 'deudor').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    const etiqueta = g.tipo === 'prenda' ? 'Formulario 03' : cuales.length === 2 ? 'Contratos de prenda' : cuales[0] === 'a' ? 'Contrato de prenda' : 'Contrato de prenda copia no negociable';
    const archivo = `${hoy().slice(2).replace(/-/g, '')} - ${etiqueta} - ${nombre}.pdf`;
    // Deudor casado/a: con la PRENDA sale también el asentimiento conyugal, en un PDF aparte porque va en papel común.
    const otros = g.tipo === 'prenda' && g.p.deudor?.estadoCivil === 'casado'
      ? [{ blob: new Blob([await armarAsentimiento(datosListos(g))], { type: 'application/pdf' }), archivo: `${hoy().slice(2).replace(/-/g, '')} - Asentimiento conyugal - ${nombre}.pdf` }] : [];
    if (!(await entregar(new Blob([bytes], { type: 'application/pdf' }), archivo, otros))) return;
    toast(otros.length ? `Listos dos PDF: el Formulario 03 (va sobre el formulario oficial en blanco) y el asentimiento conyugal (papel común).` : `PDF listo: ${archivo}. Imprimilo sobre los formularios oficiales en blanco.`);
  } catch (e) { console.error(e); toast('No se pudo armar el PDF'); }
}

async function accionAgencias(act, b) {
  const G = S.ag, id = b.dataset.id;
  if (act === 'ag-recargar') { G.error = ''; await cargarAgencias(); return; }
  if (act === 'ag-ir-chats') { G.tab = 'chats'; G.chat.hilo = null; verVista('agencias'); return; }
  if (act === 'ag-chat-abrir') { await abrirHiloAgencia(id); return; }
  if (act === 'ag-chat-volver') { G.chat.hilo = null; G.chat.borrar = false; G.chat.error = ''; await cargarChats(true); render(); return; }
  if (act === 'ag-chat-nuevo') { const C = G.chat; C.nuevo = C.nuevo ? null : { vendedor: '', texto: '', enviando: false, error: '' }; render(); return; }
  if (act === 'ag-chat-iniciar') {
    const N = G.chat.nuevo, texto = String(N?.texto || '').trim();
    if (!N) return;
    if (!N.vendedor) { N.error = 'Elegí a quién escribirle.'; render(); return; }
    if (!texto) { N.error = 'Escribí el mensaje.'; render(); return; }
    N.enviando = true; N.error = ''; render();
    try {
      const r = await iniciarChat(N.vendedor, texto);
      G.chat.nuevo = null; toast('Mensaje enviado');
      await abrirHiloAgencia(r.chat);
    } catch (e) { N.error = mensaje(e, 'no se pudo iniciar la conversación'); N.enviando = false; render(); }
    return;
  }
  if (act === 'ag-chat-borrar-fila-preguntar' || act === 'ag-chat-borrar-fila-no') { G.chat.borrarFila = act === 'ag-chat-borrar-fila-preguntar' ? id : ''; render(); return; }
  if (act === 'ag-chat-borrar-fila') {
    try { await eliminarChat(id); } catch (e) { G.chat.error = mensaje(e, 'no se pudo eliminar la conversación'); G.chat.borrarFila = ''; render(); return; }
    G.chat.borrarFila = ''; G.chat.error = ''; toast('Conversación eliminada');
    await cargarChats(true); await contarPendientes(); render(); return;
  }
  if (act === 'ag-chat-enviar') {
    const C = G.chat, texto = String(C.texto || '').trim();
    if (!texto) { C.error = 'Escribí la respuesta.'; render(); return; }
    C.enviando = true; C.error = ''; render();
    try {
      await responderChat(id, texto);
      C.texto = '';
      const v = await verChat(id); C.hilo = v.chat; C.mensajes = v.mensajes || [];
      toast('Respuesta enviada');
    } catch (e) { C.error = mensaje(e, 'no se pudo enviar la respuesta'); }
    C.enviando = false;
    await contarPendientes();
    render();
    const m = $('#agMsgs'); if (m) m.scrollTop = m.scrollHeight;
    return;
  }
  if (act === 'ag-chat-cerrar') {
    try { await cerrarChat(id); } catch (e) { G.chat.error = mensaje(e, 'no se pudo cerrar'); render(); return; }
    G.chat.hilo = null; G.chat.texto = ''; toast('Conversación cerrada');
    await cargarChats(true); await contarPendientes(); render(); return;
  }
  if (act === 'ag-chat-borrar-preguntar' || act === 'ag-chat-borrar-no') { G.chat.borrar = act === 'ag-chat-borrar-preguntar'; render(); return; }
  if (act === 'ag-chat-borrar') {
    try { await eliminarChat(id); } catch (e) { G.chat.error = mensaje(e, 'no se pudo eliminar la conversación'); G.chat.borrar = false; render(); return; }
    G.chat.hilo = null; G.chat.texto = ''; G.chat.borrar = false; G.chat.error = ''; toast('Conversación eliminada');
    await cargarChats(true); await contarPendientes(); render(); return;
  }
  if (act === 'ag-push-activar') { await activarAvisos(); return; }
  if (act === 'ag-push-quitar') { await quitarAvisosAca(); return; }
  if (act === 'ag-push-probar') { await probarAvisosAca(); return; }
  if (act === 'ag-conx') { G.conx.abierto = !G.conx.abierto; pintarConectadas(); return; }
  if (act === 'ag-tab') {
    if (b.dataset.tab === 'nuevo') { location.assign('nuevo.html'); return; }
    G.tab = b.dataset.tab; G.msg = ''; G.nueva = null; G.borrarCot = ''; G.verCot = ''; G.selCot.clear(); G.chat.hilo = null; G.chat.error = '';
    try { localStorage.setItem('cb.agTab', G.tab); } catch { /* sin almacenamiento */ }
    render(); if (G.tab === 'estadisticas') cargarEstadisticas(); if (G.tab === 'chats') entrarAChats(); return;
  }
  if (act === 'ag-est-dias') { G.est.dias = b.dataset.dias === '' ? null : Number(b.dataset.dias); cargarEstadisticas(); return; }
  if (act === 'ag-docs') {
    G.docs.set(id, { cargando: true }); render();
    try { G.docs.set(id, { lista: await documentosSolicitud(id) }); } catch (e) { G.docs.set(id, { error: mensaje(e, 'no se pudieron buscar los documentos') }); }
    render(); return;
  }
  if (act === 'ag-pdf') { await pdfDeSolicitud(id); return; }
  if (act === 'ag-gen-abrir') { await abrirGenerar(id, b.dataset.tipo); return; }
  if (act === 'ag-gen-cerrar') { G.gen = null; render(); return; }
  if (act === 'ag-gen-leer') { await leerDocumentosGen(); return; }
  if (act === 'ag-gen-pdf') { await generarFormularios(); return; }
  if (act === 'ag-borrar-preguntar' || act === 'ag-borrar-no') { G.borrar = act === 'ag-borrar-preguntar' ? id : ''; render(); return; }
  if (act === 'ag-borrar') {
    try { await eliminarSolicitud(id); } catch (e) { toast(mensaje(e, 'no se pudo eliminar la solicitud')); return; }
    G.borrar = ''; G.docs.delete(id); delete G.notas[id];
    toast('Solicitud eliminada');
    await cargarAgencias(); return;
  }
  if (act === 'ag-cot-ver' || act === 'ag-cot-ver-no') { G.verCot = act === 'ag-cot-ver' ? id : ''; render(); return; }
  if (act === 'ag-cot-preguntar' || act === 'ag-cot-no') { G.borrarCot = act === 'ag-cot-preguntar' ? id : ''; render(); return; }
  // Casilleros de la lista: uno por fila y uno arriba que tilda o destilda todas (las 200 que se ven).
  if (act === 'ag-cot-sel') { if (G.selCot.has(id)) G.selCot.delete(id); else G.selCot.add(id); G.borrarCot = ''; render(); return; }
  if (act === 'ag-cot-sel-todas') {
    const ids = (G.datos?.cotizaciones || []).map((x) => String(x.id));
    if (ids.length && ids.every((i) => G.selCot.has(i))) G.selCot.clear(); else ids.forEach((i) => G.selCot.add(i));
    G.borrarCot = ''; render(); return;
  }
  if (act === 'ag-cot-borrar') {
    // «sel»: solo las tildadas (y que sigan en la lista).
    const existentes = new Set((G.datos?.cotizaciones || []).map((x) => String(x.id)));
    const elegidas = [...G.selCot].filter((i) => existentes.has(i));
    if (id === 'sel' && !elegidas.length) { G.borrarCot = ''; render(); return; }
    try { await eliminarCotizaciones(id === 'todas' ? null : id === 'sel' ? elegidas : id); } catch (e) { toast(mensaje(e, 'no se pudieron eliminar las cotizaciones')); return; }
    G.borrarCot = ''; G.selCot.clear();
    toast(id === 'todas' ? 'Cotizaciones eliminadas' : id === 'sel' ? (elegidas.length === 1 ? 'Cotización eliminada' : `${elegidas.length} cotizaciones eliminadas`) : 'Cotización eliminada');
    await cargarAgencias(); return;
  }
  if (act === 'ag-resolver') {
    const estado = b.dataset.estado;
    try { await resolverSolicitud(id, estado, String(G.notas[id] || '').trim()); } catch (e) { toast(mensaje(e)); return; }
    delete G.notas[id];
    toast(estado === 'aprobada' ? 'Solicitud aprobada' : estado === 'rechazada' ? 'Solicitud rechazada' : estado === 'en_analisis' ? 'Solicitud en análisis: la agencia ya lo ve' : 'La solicitud volvió a recibida');
    await cargarAgencias(); return;
  }
  if (act === 'ag-activa') {
    const activa = b.dataset.valor === '1';
    try { await activarAgencia(id, activa); } catch (e) { G.msg = mensaje(e); render(); return; }
    G.msg = ''; toast(activa ? 'Agencia activada' : 'Agencia pausada: ya no puede cotizar');
    await cargarAgencias(); return;
  }
  if (act === 'ag-param-guardar') {
    const r = leerParametros(G.p);
    if (r.error) { G.msg = r.error; render(); return; }
    try { await guardarAjustesAgencias(r.fila); } catch (e) { G.msg = mensaje(e); render(); return; }
    G.msg = ''; toast('Parámetros guardados');
    await cargarAgencias(); return;
  }
  if (act === 'ag-crear') {
    const al = G.alta, email = String(al.email || '').trim(), nombre = String(al.nombre || '').trim();
    if (!email || !nombre) { G.msg = 'Completá el nombre y el email.'; render(); return; }
    let r;
    try { r = await crearAgencia(nombre, email, String(al.notas || '').trim()); } catch (e) { G.msg = mensaje(e); render(); return; }
    // La clave solo vive en esta pantalla: no se guarda en el dispositivo y desaparece al cambiar de solapa.
    G.alta = {}; G.msg = ''; G.nueva = { nombre, email: r.email || email, clave: r.clave };
    toast('Agencia creada');
    await cargarAgencias(); return;
  }
  if (act === 'ag-vend-crear') {
    const v = G.vend || {}, email = String(v.email || '').trim(), nombre = String(v.nombre || '').trim(), agencia = String(v.agencia || '');
    if (!agencia) { G.msg = 'Elegí la agencia.'; render(); return; }
    if (!email || !nombre) { G.msg = 'Completá el nombre y el email del vendedor.'; render(); return; }
    let r;
    try { r = await crearVendedor(agencia, nombre, email); } catch (e) { G.msg = mensaje(e); render(); return; }
    const ag = (G.datos?.agencias || []).find((x) => x.id === agencia);
    G.vend = { agencia }; G.msg = ''; G.nueva = { nombre: `${nombre} (${ag?.nombre || 'agencia'})`, email: r.email || email, clave: r.clave, vendedor: true };
    toast('Vendedor creado');
    await cargarAgencias(); return;
  }
  if (act === 'ag-vend-activo') {
    const activo = b.dataset.valor === '1';
    try { await activarVendedor(id, activo); } catch (e) { G.msg = mensaje(e); render(); return; }
    G.msg = ''; toast(activo ? 'Vendedor activado' : 'Vendedor pausado: ya no puede cotizar');
    await cargarAgencias(); return;
  }
  if (act === 'ag-copiar-acceso') {
    const n = G.nueva; if (!n) return;
    // Sin el enlace: la persona se lo manda a la agencia con el QR (pedido del 19/11/2026).
    copiar(`Cotizador de créditos prendarios · Mutual Bell\nUsuario: ${n.email}\nContraseña provisoria: ${n.clave}\nLa primera vez que entres, el cotizador te va a pedir que elijas tu propia contraseña.`);
    return;
  }
  if (act === 'ag-listo') { G.nueva = null; render(); return; }
  if (act === 'ag-alta') {
    const al = G.alta, email = String(al.email || '').trim(), nombre = String(al.nombre || '').trim();
    if (!email || !nombre) { G.msg = 'Completá el nombre y el email.'; render(); return; }
    try { await altaAgencia(email, nombre, String(al.notas || '').trim()); } catch (e) { G.msg = mensaje(e); render(); return; }
    G.alta = {}; G.msg = ''; toast('Agencia habilitada');
    await cargarAgencias();
  }
}



// ───────────────────────── Cotización rápida ─────────────────────────
function accionRapida(act) {
  const R = S.ag.rap, a = S.ag.datos?.ajustes || {};
  if (act === 'mr-calcular') {
    const r = calcularRapida(R, a);
    R.res = r.res || null; R.error = r.error || ''; render();
    $('#mrResultado')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (R.res && act === 'mr-copiar') copiar(textoRapida(R.res, a));
  else if (R.res && act === 'mr-whatsapp') window.open(`https://wa.me/?text=${encodeURIComponent(textoRapida(R.res, a))}`, '_blank', 'noopener');
}

// ───────────────────────── Eventos ─────────────────────────
async function unaVez(boton, tarea) {
  if (boton.disabled) return;
  boton.disabled = true;
  try { await tarea(boton); } finally { if (boton.isConnected) boton.disabled = false; }
}

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, b = f.querySelector('button[type="submit"]');
  if (f.id === 'fIngreso') {
    await unaVez(b, async () => {
      try { mostrar(await entrar($('#i_email').value, $('#i_clave').value)); } catch (err) { errorIngreso(mensaje(err, 'no se pudo ingresar')); }
    });
  } else if (f.id === 'fClave') {
    const a = $('#n_clave').value, r = $('#n_clave2').value;
    if (a.length < CLAVE_MIN) { errorIngreso(`La contraseña tiene que tener al menos ${CLAVE_MIN} caracteres.`); return; }
    if (a !== r) { errorIngreso('Las dos contraseñas no coinciden.'); return; }
    await unaVez(b, async () => { try { mostrar(await cambiarClave(a)); } catch (err) { errorIngreso(mensaje(err)); } });
  }
});

document.addEventListener('click', async (e) => {
  const ing = e.target.closest('[data-ing]');
  if (ing) {
    if (ing.dataset.ing === 'salir') { await salir(); mostrar('ingreso'); }
    else { try { mostrar(await reconectar()); } catch (err) { S.falla = mensaje(err, 'no se pudo abrir'); mostrar('error'); } }
    return;
  }
  if (e.target.closest('#btnSalir')) { await salir(); mostrar('ingreso'); return; }
  const a = e.target.closest('[data-a]');
  const act = a?.dataset.a || '';
  if (act.startsWith('ag-')) await unaVez(a, (b) => accionAgencias(act, b));
  else if (act.startsWith('mr-')) accionRapida(act);
});

function escrito(el) {
  const k = el.dataset?.k;
  if (!k?.startsWith('ag.')) return null;
  poner(k, el.type === 'checkbox' ? el.checked : el.value);
  return k;
}
document.addEventListener('input', (e) => {
  const k = escrito(e.target);
  if (k?.startsWith('ag.gen.')) { const f = $('#genFaltan'); if (f && S.ag.gen) f.innerHTML = htmlFaltanGen(S.ag.gen); }
});
document.addEventListener('change', (e) => {
  const k = escrito(e.target);
  if (!k) return;
  // Se redibuja un instante después: si el toque que sacó el foco del campo cayó en un botón, ese botón recibe el clic.
  if (e.target.dataset.re) setTimeout(render, e.target.tagName === 'SELECT' ? 0 : 150);
});
document.addEventListener('toggle', (e) => { if (e.target.matches?.('details[data-est]')) S.ag.est.abierto = e.target.open; }, true);

alCambiar((que, detalle) => {
  if (que === 'sesion') { if (detalle !== S.pantalla) mostrar(detalle); }
});

// Avisos al celular propios del panel: tocar uno abre acá los chats.
const abrirChats = () => { S.ag.tab = 'chats'; S.ag.chat.hilo = null; render(); cargarAgencias(); };
function seguirEnlace() {
  const h = location.hash.slice(1), ver = h.startsWith('ver-') ? h.slice(4) : '';
  if ((h !== 'chats' && h !== 'aprobado' && !esSolapa(ver)) || S.pantalla !== 'listo') return;
  history.replaceState(null, '', location.pathname + location.search);
  if (h === 'chats' || ver === 'chats') { abrirChats(); return; }
  S.ag.tab = h === 'aprobado' ? 'solicitudes' : ver;
  if (h === 'aprobado') avisarAprobado();
  render();
  if (S.ag.tab === 'estadisticas' && S.ag.datos) cargarEstadisticas();
}
/** Al volver de «Nuevo crédito»: el crédito ya está en Solicitudes, para sacar la prenda y los contratos. */
function avisarAprobado() {
  let fallaron = [];
  try { fallaron = JSON.parse(sessionStorage.getItem('panel.aprobado') || '[]'); sessionStorage.removeItem('panel.aprobado'); } catch { /* sin aviso de archivos */ }
  toast(fallaron.length ? `Crédito aprobado, pero no se pudo guardar: ${fallaron.join(', ')}` : 'Crédito aprobado. Ya podés generar la prenda y los contratos.');
}
window.addEventListener('hashchange', seguirEnlace);
// Al volver de los ajustes del teléfono, el permiso pudo haber cambiado.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.pantalla === 'listo' && S.ag.tab === 'chats') revisarAvisos(); });
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* el panel funciona igual sin él */ });
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.abrir === 'chats' && S.pantalla === 'listo') abrirChats(); });
}

// Con una conversación abierta, se mira cada 10 s si la agencia contestó (sin pisar lo que se está escribiendo).
setInterval(async () => {
  const C = S.ag.chat;
  if (document.visibilityState !== 'visible' || S.pantalla !== 'listo' || S.ag.tab !== 'chats' || !C.hilo || C.enviando) return;
  const antes = C.mensajes.length ? C.mensajes[C.mensajes.length - 1].id : 0;
  await cargarChats(true);
  if ((C.mensajes.length ? C.mensajes[C.mensajes.length - 1].id : 0) !== antes) { render(); const m = $('#agMsgs'); if (m) m.scrollTop = m.scrollHeight; }
}, 10_000);

/** Repinta solo el cartel «agencias conectadas», sin tocar lo que se esté escribiendo en la pantalla. */
function pintarConectadas() {
  const el = document.getElementById('agConx');
  if (el) el.outerHTML = htmlConectadas(S.ag.conx);
}

/** Lee quiénes tienen el cotizador abierto. Si el cartel ya está en pantalla lo repinta en el lugar; si no estaba, dibuja. */
async function cargarConectadas() {
  if (S.pantalla !== 'listo') return;
  const f = await leerConectadas();
  if (f === null || S.pantalla !== 'listo') return; // sin la función o sin red: queda lo último que se vio
  const antes = !!S.ag.conx.filas;
  S.ag.conx.filas = f;
  if (document.getElementById('agConx')) pintarConectadas();
  else if (!antes && (S.vista === 'inicio' || S.vista === 'agencias')) render();
}

setInterval(() => { if (document.visibilityState === 'visible') contarPendientes(); }, 60_000);
setInterval(() => { if (document.visibilityState === 'visible') cargarConectadas(); }, 30_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { contarPendientes(); cargarConectadas(); } });

(async () => {
  try { mostrar(await iniciar()); seguirEnlace(); } catch (e) { console.error(e); S.falla = mensaje(e, 'no se pudo abrir'); mostrar('error'); }
})();

// Chat con Claude dentro de cobranzas. La conversación va y viene entera (supabase/functions/chat):
// se guarda tal cual la devuelve la función, sin tocarla, porque la API de Claude rechaza una
// conversación alterada. Claude lee deudores y liquidaciones, anota gestiones y registra pagos
// dictados; los mensajes de WhatsApp los envía la persona desde la ficha.
import { D, preguntarAClaude, leerChat, guardarChat } from './datos.js';
import { esc } from './textos.js';

const $ = (s) => document.querySelector(s);
const movil = window.matchMedia('(max-width: 720px)');
const chatVacio = () => ({ abierto: false, cargado: false, mensajes: [], notas: [], enviando: false, pendiente: null, error: null, acciones: {} });
let C = null;

function estado() {
  if (!C) C = chatVacio();
  if (!C.cargado && D.usuario) {
    const g = leerChat();
    if (g) Object.assign(C, { mensajes: g.mensajes, acciones: g.acciones || {}, notas: g.notas || [] });
    C.cargado = true;
  }
  return C;
}
const guardar = () => { if (C) guardarChat({ mensajes: C.mensajes, acciones: C.acciones, notas: C.notas }); };

/** El texto que se ve de un mensaje (sin la fecha que agrega la función, sin herramientas). */
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

const EJEMPLOS = ['¿A quién tengo que llamar hoy?', '¿Cuánto debe …?', 'Anotá que … prometió pagar el viernes $ …'];

function bienvenida() {
  return `<div class="bienvenida">
   <p class="m0"><b>Pedile a Claude lo que necesites de cobranzas.</b> Busca deudores, te dice cuánto debe cada uno a hoy, qué hay pendiente, anota gestiones y registra los pagos que le dictes.</p>
   <div class="sugerencias">${EJEMPLOS.map((e) => `<button class="chip" data-chat="ejemplo">${esc(e)}</button>`).join('')}</div>
   <p class="hint m0">Los mensajes de WhatsApp los redacta, pero los enviás vos desde la ficha del deudor.</p>
  </div>`;
}

function charla() {
  const c = C;
  if (!c.mensajes.length && !c.pendiente) return bienvenida();
  let h = '';
  c.mensajes.forEach((m, i) => {
    const t = textoVisible(m);
    if (t) h += m.role === 'user' ? `<div class="msj yo">${esc(t).replace(/\n/g, '<br>')}</div>` : `<div class="msj claude">${enriquecer(t)}</div>`;
    const a = c.acciones[i];
    if (a?.length) h += `<ul class="hecho" aria-label="Cambios en cobranzas">${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  });
  if (c.pendiente) h += `<div class="msj yo${c.error ? ' fallido' : ''}">${esc(c.pendiente).replace(/\n/g, '<br>')}</div>`;
  if (c.enviando) h += '<div class="msj claude pensando" role="status">Claude está trabajando…</div>';
  if (c.error) {
    h += `<div class="msj aviso-chat" role="alert"><p class="m0">${esc(c.error.mensaje)}</p><div class="actions">
      ${c.error.reintentar ? '<button class="btn small primary" data-chat="reintentar">Reintentar</button>' : ''}
      ${c.error.codigo === 'larga' ? '<button class="btn small" data-chat="nueva">Nueva conversación</button>' : ''}</div></div>`;
  }
  return h;
}

function panelHtml() {
  return `<div class="scrim" data-chat="cerrar"></div>
  <aside class="panel chat entra" role="dialog" aria-modal="true" aria-label="Chat con Claude">
   <div class="phead"><div><div class="hint">Asistente de cobranzas</div><h2>Claude</h2></div>
    <div class="btns"><button class="btn small" data-chat="nueva" id="chatNueva">Nueva conversación</button><button class="btn small" data-chat="cerrar">Cerrar</button></div></div>
   <div class="charla" id="charla" aria-live="polite"></div>
   <form class="chatpie" id="fChat" novalidate>
    <textarea id="chatTexto" rows="1" placeholder="Escribile a Claude…" aria-label="Mensaje para Claude" enterkeyhint="send"></textarea>
    <button class="btn primary" type="submit" id="chatEnviar">Enviar</button>
   </form>
  </aside>`;
}

function ajustarAlto(t) { if (!t) return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 168) + 'px'; }

/** Redibuja la conversación; baja al final si ya estaba abajo. Lo que se escribe no se toca (está fuera). */
function refrescar(bajar = false) {
  const ch = $('#charla'); if (!ch || !C) return;
  const abajo = bajar || ch.scrollHeight - ch.scrollTop - ch.clientHeight < 60, pos = ch.scrollTop;
  ch.innerHTML = charla();
  ch.scrollTop = abajo ? ch.scrollHeight : pos;
  $('#chatNueva').hidden = !C.mensajes.length;
  $('#chatEnviar').disabled = C.enviando;
}

/** Abre el chat; con un deudor, deja escrito el comienzo del mensaje sobre él. */
export function abrirChat(deudor) {
  const c = estado();
  if (!c.abierto) {
    c.abierto = true;
    const caja = $('#chat'); caja.hidden = false; caja.innerHTML = panelHtml();
    document.body.style.overflow = 'hidden'; document.body.classList.add('con-chat');
  }
  refrescar(true);
  const t = $('#chatTexto');
  if (deudor?.nombre && !t.value.trim()) t.value = `Sobre ${deudor.nombre}: `;
  ajustarAlto(t);
  if (!movil.matches || deudor) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
}

export function cerrarChat() {
  if (C) C.abierto = false;
  const caja = $('#chat'); if (!caja || caja.hidden) return;
  caja.hidden = true; caja.innerHTML = ''; document.body.classList.remove('con-chat');
  if ($('#drawer').hidden) document.body.style.overflow = '';
}
export const chatAbierto = () => !!C?.abierto;

async function enviar(texto) {
  const c = C;
  texto = String(texto || '').trim();
  if (!c || c.enviando || !texto) return;
  const notas = c.notas.splice(0);
  Object.assign(c, { enviando: true, error: null, pendiente: texto });
  refrescar(true);
  try {
    const r = await preguntarAClaude({ historial: c.mensajes, texto, notas });
    c.mensajes.push(...r.nuevos);
    if (r.acciones?.length) c.acciones[c.mensajes.length - 1] = r.acciones;
    c.pendiente = null;
  } catch (e) {
    c.notas.unshift(...notas); // no llegaron: van con el próximo mensaje
    const final = ['larga', 'sin_clave', 'sin_acceso', 'clave_temporal', 'pedido'].includes(e.codigo);
    c.error = { mensaje: e.sinSesion ? 'La sesión venció: volvé a ingresar.' : e.message || 'No se pudo enviar el mensaje', codigo: e.codigo, reintentar: !final && !e.sinSesion };
    if (final) { const t = $('#chatTexto'); if (t) t.value = t.value || texto; c.pendiente = null; }
  } finally {
    c.enviando = false;
    guardar();
    if (c.abierto) refrescar(true);
  }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-chat]'); if (!b) return;
  const a = b.dataset.chat, c = C;
  if (a === 'cerrar') { cerrarChat(); return; }
  if (!c) return;
  if (a === 'nueva') {
    if (c.enviando) return;
    Object.assign(c, { mensajes: [], acciones: {}, pendiente: null, error: null });
    guardar(); refrescar(true); $('#chatTexto').focus(); return;
  }
  if (a === 'ejemplo') { const t = $('#chatTexto'); t.value = b.textContent.replace(/…/g, '').replace(/\s{2,}/g, ' '); ajustarAlto(t); t.focus(); return; }
  if (a === 'reintentar') { const t = c.pendiente; c.pendiente = null; c.error = null; enviar(t); }
});
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'fChat') return;
  e.preventDefault();
  const t = $('#chatTexto'), txt = t.value.trim();
  if (!txt || C?.enviando) return;
  t.value = ''; ajustarAlto(t);
  enviar(txt);
});
document.addEventListener('input', (e) => { if (e.target.id === 'chatTexto') ajustarAlto(e.target); });
document.addEventListener('keydown', (e) => {
  if (!C?.abierto) return;
  if (e.key === 'Escape') { e.stopImmediatePropagation(); cerrarChat(); return; }
  // En la computadora Enter envía y Mayús+Enter baja de línea; en el celular, Enter es salto de línea.
  if (e.target.id === 'chatTexto' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && !movil.matches) { e.preventDefault(); $('#fChat').requestSubmit(); }
}, true);

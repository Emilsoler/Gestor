// Chat de la agencia con la Mutual: el botón flotante «M» del cotizador (pedido de la persona del 21/11/2026).
//
// Le contesta primero un asistente automático (con la hoja de respuestas de la Mutual). Si la agencia lo pide, el
// chat pasa a una persona de la Mutual: la conversación queda «en espera» y se le avisa. Todo va por la función
// `agencias` (acciones chat_*). El asistente no conoce valores de vehículos: acá tampoco llegan.
//
// El chat vive aparte del resto de la pantalla (#chat): el cotizador redibuja #main entero y esto no se tiene que
// perder (ni lo que se está escribiendo). Sin estilos en línea (CSP): todo va por clases de styles.css.

const SALUDO = 'Hola, soy el asistente de la Mutual. Contame qué duda tenés sobre el cotizador o la solicitud de un crédito. Si preferís hablar con una persona, tocá «Hablar con un representante».';
const ESTADOS = {
  bot: 'Te responde el asistente automático de la Mutual',
  espera: 'Esperando a una persona de la Mutual · te responde acá mismo',
  humano: 'Hablás con la Mutual',
};
const CADA_ABIERTO = 5000, CADA_CERRADO = 30000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hora = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }); };

const C = { fn: null, activo: false, abierto: false, id: '', estado: 'bot', items: [], ultimo: 0, sinLeer: false, enviando: false, esperandoBot: false, error: '', derivar: false, borrador: '', timer: 0 };
const $ = (s) => document.querySelector(s);

/** Se llama al entrar a la app: `fn` pide a la función `agencias`; `activo` es lo que dijo `yo` (chat habilitado). */
export function iniciarChat(fn, activo) {
  C.fn = fn;
  apagarChat();
  if (!activo) return;
  C.activo = true;
  dibujar();
  cargar(false);
  programar();
}

/** Al salir de la cuenta o si el chat no está habilitado: se borra todo lo del chat. */
export function apagarChat() {
  clearTimeout(C.timer);
  Object.assign(C, { activo: false, abierto: false, id: '', estado: 'bot', items: [], ultimo: 0, sinLeer: false, enviando: false, esperandoBot: false, error: '', derivar: false, borrador: '', timer: 0 });
  const r = $('#chat');
  if (r) r.innerHTML = '';
}

function programar() {
  clearTimeout(C.timer);
  if (!C.activo) return;
  C.timer = setTimeout(async () => {
    // Solo hay algo que esperar si ya hay una persona en la conversación: con el asistente, la respuesta llega sola.
    if (!document.hidden && C.id && C.estado !== 'bot' && !C.enviando) await cargar(C.abierto);
    programar();
  }, C.abierto ? CADA_ABIERTO : CADA_CERRADO);
}

async function cargar(leido) {
  try {
    const r = await C.fn({ accion: 'chat_leer', desde: C.ultimo, leido: !!leido });
    if (!C.activo) return;
    if (r.chat) { C.id = r.chat.id; C.estado = r.chat.estado; C.sinLeer = !!r.chat.sin_leer && !C.abierto; }
    else if (C.id) { C.id = ''; C.estado = 'bot'; C.sinLeer = false; } // la Mutual cerró la conversación: la próxima consulta abre otra
    sumar(r.mensajes || []);
    dibujar();
  } catch { /* sin conexión: se vuelve a intentar en el próximo ciclo */ }
}

function sumar(xs) {
  for (const m of xs) {
    if (m.id > C.ultimo) { C.items.push(m); C.ultimo = m.id; }
  }
}

async function enviar() {
  const campo = $('#chatTexto');
  const texto = (campo?.value || '').trim();
  if (!texto || C.enviando) return;
  C.enviando = true; C.error = ''; C.derivar = false; C.borrador = '';
  const provisorio = { id: -1, de: 'agencia', texto, momento: new Date().toISOString() };
  C.items.push(provisorio);
  C.esperandoBot = C.estado === 'bot';
  dibujar(true);
  try {
    const r = await C.fn({ accion: 'chat_enviar', texto });
    C.items = C.items.filter((m) => m !== provisorio);
    if (r.chat) { C.id = r.chat.id; C.estado = r.chat.estado; }
    sumar(r.mensajes || []);
    C.derivar = !!r.derivar && C.estado === 'bot';
  } catch (e) {
    C.items = C.items.filter((m) => m !== provisorio);
    C.borrador = texto; // no se pierde lo escrito
    C.error = e?.message || 'No se pudo enviar. Probá de nuevo.';
  }
  C.enviando = false; C.esperandoBot = false;
  dibujar(true);
}

async function pedirRepresentante() {
  if (C.enviando) return;
  C.enviando = true; C.error = '';
  dibujar();
  try {
    const r = await C.fn({ accion: 'chat_representante' });
    if (r.chat) { C.id = r.chat.id; C.estado = r.chat.estado; }
    sumar(r.mensajes || []);
    C.derivar = false;
  } catch (e) { C.error = e?.message || 'No se pudo avisar a la Mutual. Probá de nuevo.'; }
  C.enviando = false;
  dibujar(true);
}

async function nuevaConversacion() {
  if (C.enviando) return;
  try { await C.fn({ accion: 'chat_cerrar' }); } catch (e) { C.error = e?.message || 'No se pudo cerrar la conversación.'; dibujar(); return; }
  Object.assign(C, { id: '', estado: 'bot', items: [], ultimo: 0, error: '', derivar: false, borrador: '' });
  dibujar(true);
}

function abrir() {
  C.abierto = true; C.sinLeer = false;
  dibujar(true);
  if (C.id) cargar(true);
  programar();
  $('#chatTexto')?.focus();
}

function cerrar() {
  C.abierto = false;
  dibujar();
  $('#btnM')?.focus();
  programar();
}

function burbuja(m) {
  const quien = m.de === 'agencia' ? 'yo' : m.de === 'mutual' ? 'mutual' : 'bot';
  const etiqueta = m.de === 'mutual' ? 'Mutual' : m.de === 'bot' ? 'Asistente' : '';
  return `<div class="msg ${quien}">${etiqueta ? `<span class="msg-de">${etiqueta}</span>` : ''}<p>${esc(m.texto)}</p><time>${hora(m.momento)}</time></div>`;
}

function dibujar(alFinal = false) {
  const raiz = $('#chat');
  if (!raiz || !C.activo) return;
  // Lo que se está escribiendo (C.borrador, al día con cada tecla) sobrevive a cada redibujado.
  const tieneConsulta = C.items.some((m) => m.de === 'agencia');
  const puedeRep = C.estado === 'bot' && tieneConsulta;
  const cuerpo = `<div class="msg bot"><span class="msg-de">Asistente</span><p>${esc(SALUDO)}</p></div>` + C.items.map(burbuja).join('')
    + (C.esperandoBot ? '<div class="msg bot escribiendo" aria-label="El asistente está escribiendo"><p><i></i><i></i><i></i></p></div>' : '');
  raiz.innerHTML = `
    <button type="button" id="btnM" class="btn-m" aria-label="Chatear con la Mutual" aria-expanded="${C.abierto}" aria-controls="chatPanel"${C.abierto ? ' hidden' : ''}>M${C.sinLeer ? '<span class="punto" aria-label="Mensaje nuevo"></span>' : ''}</button>
    ${C.abierto ? `<section class="chat-panel" id="chatPanel" role="dialog" aria-label="Chat con la Mutual">
      <header class="chat-cab">
        <div><b>Mutual Bell</b><small>${esc(ESTADOS[C.estado] || ESTADOS.bot)}</small></div>
        <div class="chat-cab-botones">
          ${C.items.length ? '<button type="button" class="btn chico" id="chatNueva">Nueva conversación</button>' : ''}
          <button type="button" class="chat-x" id="chatCerrar" aria-label="Cerrar el chat">×</button>
        </div>
      </header>
      <div class="chat-msgs" id="chatMsgs" role="log" aria-live="polite">${cuerpo}</div>
      ${C.error ? `<p class="chat-error" role="alert">${esc(C.error)}</p>` : ''}
      ${puedeRep ? `<div class="chat-rep"><button type="button" class="btn${C.derivar ? ' primario' : ''}" id="chatRep"${C.enviando ? ' disabled' : ''}>Hablar con un representante</button></div>` : ''}
      <form class="chat-form" id="chatForm" autocomplete="off">
        <textarea id="chatTexto" rows="1" maxlength="1500" placeholder="Escribí tu consulta" aria-label="Tu mensaje"></textarea>
        <button type="submit" class="btn primario" id="chatEnviar"${C.enviando ? ' disabled' : ''}>Enviar</button>
      </form>
    </section>` : ''}`;
  const campo = $('#chatTexto');
  if (campo) {
    campo.value = C.borrador;
    ajustarAlto(campo);
    if (!C.enviando && document.activeElement === document.body && C.abierto) campo.focus();
  }
  const msgs = $('#chatMsgs');
  if (msgs && alFinal) msgs.scrollTop = msgs.scrollHeight;
}

function ajustarAlto(t) { t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 120)}px`; }

const raiz = () => $('#chat');
document.addEventListener('click', (e) => {
  if (!raiz()?.contains(e.target)) return;
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'btnM') abrir();
  else if (t.id === 'chatCerrar') cerrar();
  else if (t.id === 'chatRep') pedirRepresentante();
  else if (t.id === 'chatNueva') nuevaConversacion();
});
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'chatForm') return;
  e.preventDefault();
  enviar();
});
document.addEventListener('input', (e) => { if (e.target.id === 'chatTexto') { C.borrador = e.target.value; ajustarAlto(e.target); } });
document.addEventListener('keydown', (e) => {
  if (!C.abierto) return;
  if (e.key === 'Escape') cerrar();
  else if (e.target.id === 'chatTexto' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); enviar(); }
});

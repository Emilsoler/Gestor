// Chat de la agencia con la Mutual: el botón flotante «M» del cotizador (pedido de la persona del 21/11/2026).
//
// Le contesta primero un asistente automático (con la hoja de respuestas de la Mutual). Si la agencia lo pide, el
// chat pasa a una persona de la Mutual: la conversación queda «en espera» y se le avisa. Todo va por la función
// `agencias` (acciones chat_*). El asistente no conoce valores de vehículos: acá tampoco llegan.
//
// Voz (pedido de la persona del 22/11/2026, migración 0040):
//   * «Escuchar» en cada mensaje del asistente y de la Mutual: lo lee en voz alta la voz del celular o de la computadora
//     (speechSynthesis del navegador: no se graba ni se manda nada, es gratis).
//   * Mensajes de voz de la agencia: solo cuando ya hay una persona de la Mutual en la conversación (el asistente no
//     escucha audios). Se graban con el micrófono (MediaRecorder), hasta 2 minutos, y se suben a la función.
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
const MAX_SEG = 120; // lo mismo que MAX_AUDIO_SEG de la función
const TIPOS_AUDIO = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hora = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }); };

const SEGUN = () => ({ grab: null, hablando: '', sonando: '', cargandoAudio: '' });
const C = { fn: null, activo: false, abierto: false, id: '', estado: 'bot', items: [], ultimo: 0, sinLeer: false, enviando: false, esperandoBot: false, error: '', derivar: false, borrador: '', timer: 0, ...SEGUN(), urls: new Map(), reproductor: null, cartelOculto: false };
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
  quietarVoz();
  for (const u of C.urls.values()) URL.revokeObjectURL(u);
  C.urls.clear();
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
  quietarVoz();
  Object.assign(C, { id: '', estado: 'bot', items: [], ultimo: 0, error: '', derivar: false, borrador: '' });
  dibujar(true);
}

// ───────────────────────── Escuchar (voz del dispositivo) ─────────────────────────
function textoDe(clave) {
  if (clave === 'saludo') return SALUDO;
  return C.items.find((m) => String(m.id) === clave)?.texto || '';
}
function elegirVoz() {
  const voces = window.speechSynthesis.getVoices?.() || [];
  return voces.find((v) => /^es[-_]AR/i.test(v.lang)) || voces.find((v) => /^es[-_]/i.test(v.lang)) || null;
}
function leerEnVoz(clave) {
  if (!hayVoz()) return;
  const habla = C.hablando === clave;
  window.speechSynthesis.cancel();
  C.hablando = '';
  if (!habla) {
    const t = textoDe(clave);
    if (t) {
      const u = new SpeechSynthesisUtterance(t);
      u.lang = 'es-AR'; u.rate = 0.98;
      const v = elegirVoz(); if (v) u.voice = v;
      const fin = () => { if (C.hablando === clave) { C.hablando = ''; dibujar(); } };
      u.onend = fin; u.onerror = fin;
      C.hablando = clave;
      window.speechSynthesis.speak(u);
    }
  }
  dibujar();
}
/** Frena la voz, el audio que suene y una grabación a medio hacer (al cerrar el chat o la conversación). */
function quietarVoz() {
  if (hayVoz()) window.speechSynthesis.cancel();
  C.hablando = '';
  if (C.reproductor) { C.reproductor.pause(); C.reproductor = null; }
  C.sonando = ''; C.cargandoAudio = '';
  if (C.grab) soltarGrabacion(C.grab);
  C.grab = null;
}

// ───────────────────────── Mensajes de voz de la agencia ─────────────────────────
function tipoGrabable() {
  return TIPOS_AUDIO.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
}
function soltarGrabacion(g) {
  clearInterval(g.timer);
  g.cancelada = true;
  try { if (g.rec.state !== 'inactive') g.rec.stop(); } catch { /* ya estaba parado */ }
  g.stream.getTracks().forEach((t) => t.stop());
}

async function empezarGrabacion() {
  if (C.grab || C.enviando || C.estado === 'bot') return;
  C.error = '';
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {
    C.error = 'No pudimos usar el micrófono. Dale permiso desde el navegador (o desde Ajustes) y probá de nuevo.';
    dibujar(true); return;
  }
  let rec;
  const tipo = tipoGrabable();
  try { rec = tipo ? new MediaRecorder(stream, { mimeType: tipo }) : new MediaRecorder(stream); } catch {
    stream.getTracks().forEach((t) => t.stop());
    C.error = 'Este navegador no puede grabar audios. Escribí tu mensaje.';
    dibujar(true); return;
  }
  const g = { rec, stream, chunks: [], t0: Date.now(), seg: 0, timer: 0, cancelada: false, tipo: rec.mimeType || tipo || '' };
  rec.ondataavailable = (e) => { if (e.data?.size) g.chunks.push(e.data); };
  g.timer = setInterval(() => {
    g.seg = Math.floor((Date.now() - g.t0) / 1000);
    const t = $('#chatGrabT'); if (t) t.textContent = mmss(g.seg);
    if (g.seg >= MAX_SEG) enviarGrabacion(); // llegó a los 2 minutos: se manda lo grabado
  }, 250);
  C.grab = g;
  rec.start();
  dibujar();
}

function cancelarGrabacion() {
  if (!C.grab) return;
  soltarGrabacion(C.grab);
  C.grab = null;
  dibujar(true);
}

async function enviarGrabacion() {
  const g = C.grab;
  if (!g || C.enviando) return;
  C.grab = null; C.enviando = true; C.error = '';
  clearInterval(g.timer);
  // Se espera al último pedazo que entrega el grabador al parar.
  const parado = new Promise((ok) => { g.rec.onstop = ok; });
  try { if (g.rec.state !== 'inactive') g.rec.stop(); } catch { /* ya estaba parado */ }
  await parado;
  g.stream.getTracks().forEach((t) => t.stop());
  const seg = Math.min(MAX_SEG, Math.max(1, Math.round((Date.now() - g.t0) / 1000)));
  const blob = new Blob(g.chunks, { type: g.tipo || g.chunks[0]?.type || 'audio/webm' });
  if (blob.size < 800) { C.enviando = false; C.error = 'No se escuchó nada. Probá grabar de nuevo.'; dibujar(true); return; }
  const local = URL.createObjectURL(blob);
  const provisorio = { id: -1, de: 'agencia', texto: 'Mensaje de voz', audio_seg: seg, momento: new Date().toISOString() };
  C.items.push(provisorio);
  dibujar(true);
  try {
    const ext = /mp4/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
    const fd = new FormData();
    fd.append('accion', 'chat_audio'); fd.append('seg', String(seg)); fd.append('audio', blob, `audio.${ext}`);
    const r = await C.fn(fd);
    C.items = C.items.filter((m) => m !== provisorio);
    if (r.chat) { C.id = r.chat.id; C.estado = r.chat.estado; }
    for (const m of r.mensajes || []) if (m.audio_seg) C.urls.set(String(m.id), local); // el mismo audio, sin volver a bajarlo
    sumar(r.mensajes || []);
  } catch (e) {
    C.items = C.items.filter((m) => m !== provisorio);
    URL.revokeObjectURL(local);
    C.error = e?.message || 'No se pudo enviar el audio. Probá de nuevo.';
  }
  C.enviando = false;
  dibujar(true);
}

/** Escuchar un audio ya enviado: se trae de la función (base64) una sola vez y queda en el dispositivo hasta cerrar la sesión. */
async function reproducirAudio(clave) {
  if (C.sonando === clave) { quietarSonido(); dibujar(); return; }
  quietarSonido();
  let url = C.urls.get(clave);
  if (!url) {
    C.cargandoAudio = clave; dibujar();
    try {
      const r = await C.fn({ accion: 'chat_audio_ver', mensaje: Number(clave) });
      const bytes = Uint8Array.from(atob(r.datos), (c) => c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: r.tipo }));
      C.urls.set(clave, url);
    } catch (e) { C.cargandoAudio = ''; C.error = e?.message || 'No se pudo traer el audio.'; dibujar(); return; }
    C.cargandoAudio = '';
  }
  const a = new Audio(url);
  const fin = () => { if (C.reproductor === a) { C.reproductor = null; C.sonando = ''; dibujar(); } };
  a.onended = fin; a.onerror = fin;
  C.reproductor = a; C.sonando = clave;
  dibujar();
  try { await a.play(); } catch { fin(); }
}
function quietarSonido() {
  if (C.reproductor) { C.reproductor.pause(); C.reproductor = null; }
  C.sonando = '';
}

function abrir() {
  C.abierto = true; C.sinLeer = false; C.cartelOculto = true; // el aviso ya cumplió: no vuelve en esta visita
  dibujar(true);
  if (C.id) cargar(true);
  programar();
  $('#chatTexto')?.focus();
}

function cerrar() {
  quietarVoz();
  C.abierto = false;
  dibujar();
  $('#btnM')?.focus();
  programar();
}

const hayVoz = () => typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function';
const hayMicrofono = () => !!(navigator.mediaDevices?.getUserMedia) && typeof window.MediaRecorder === 'function';
const mmss = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;

function burbuja(m) {
  const quien = m.de === 'agencia' ? 'yo' : m.de === 'mutual' ? 'mutual' : 'bot';
  const etiqueta = m.de === 'mutual' ? 'Mutual' : m.de === 'bot' ? 'Asistente' : '';
  const clave = String(m.id);
  const cuerpo = m.audio_seg
    ? `<button type="button" class="btn chico chat-audio" data-audio="${esc(clave)}" aria-label="${C.sonando === clave ? 'Detener el audio' : 'Escuchar tu mensaje de voz'}"${m.id < 0 || C.cargandoAudio === clave ? ' disabled' : ''}>${C.sonando === clave ? 'Detener' : C.cargandoAudio === clave ? 'Cargando…' : 'Escuchar audio'} · ${mmss(m.audio_seg)}</button>`
    : `<p>${esc(m.texto)}</p>`;
  return `<div class="msg ${quien}">${etiqueta ? `<span class="msg-de">${etiqueta}</span>` : ''}${cuerpo}${escuchar(clave, quien)}<time>${hora(m.momento)}</time></div>`;
}

/** El botón «Escuchar» de los mensajes que no son de la agencia (si el navegador sabe hablar). */
function escuchar(clave, quien) {
  if (quien === 'yo' || !hayVoz()) return '';
  const habla = C.hablando === clave;
  return `<button type="button" class="chat-voz" data-voz="${esc(clave)}" aria-label="${habla ? 'Detener la lectura' : 'Escuchar este mensaje en voz alta'}">${habla ? 'Detener' : 'Escuchar'}</button>`;
}

function dibujar(alFinal = false) {
  const raiz = $('#chat');
  if (!raiz || !C.activo) return;
  // Lo que se está escribiendo (C.borrador, al día con cada tecla) sobrevive a cada redibujado.
  const tieneConsulta = C.items.some((m) => m.de === 'agencia');
  const puedeRep = C.estado === 'bot' && tieneConsulta;
  // Los audios son para hablar con una persona: con el asistente todavía no.
  const puedeAudio = C.estado !== 'bot' && hayMicrofono();
  const cuerpo = `<div class="msg bot"><span class="msg-de">Asistente</span><p>${esc(SALUDO)}</p>${escuchar('saludo', 'bot')}</div>` + C.items.map(burbuja).join('')
    + (C.esperandoBot ? '<div class="msg bot escribiendo" aria-label="El asistente está escribiendo"><p><i></i><i></i><i></i></p></div>' : '');
  raiz.innerHTML = `
    ${C.abierto || C.cartelOculto ? '' : `<div class="cartel-m"><p>Pregúntale a <b>M</b>, nuestro asesor virtual, tus dudas</p><button type="button" id="cartelX" class="cartel-x" aria-label="Ocultar este aviso">×</button><svg class="cartel-flecha" viewBox="0 0 48 64" aria-hidden="true" focusable="false"><defs><linearGradient id="oroM" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff1a8"/><stop offset=".45" stop-color="#e8b21e"/><stop offset="1" stop-color="#9a6a05"/></linearGradient></defs><path d="M10 2c9 2 14 10 14 22v14H14l14 22 14-22H32V24C32 8 24 0 10 2z" fill="url(#oroM)" stroke="#7a5204" stroke-width="1.5" stroke-linejoin="round"/></svg></div>`}
    <button type="button" id="btnM" class="btn-m" aria-label="Chatear con la Mutual" aria-expanded="${C.abierto}" aria-controls="chatPanel"${C.abierto ? ' hidden' : ''}><img src="img/m.png" alt="" width="68" height="70">${C.sinLeer ? '<span class="punto" aria-label="Mensaje nuevo"></span>' : ''}</button>
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
      ${C.grab ? `<div class="chat-grab" role="status" aria-label="Grabando un mensaje de voz">
        <span class="chat-rec-punto" aria-hidden="true"></span><b id="chatGrabT">${mmss(C.grab.seg)}</b>
        <button type="button" class="btn" id="chatGrabCancelar">Cancelar</button>
        <button type="button" class="btn primario" id="chatGrabEnviar">Enviar audio</button>
      </div>` : `<form class="chat-form" id="chatForm" autocomplete="off">
        <textarea id="chatTexto" rows="1" maxlength="1500" placeholder="Escribí tu consulta" aria-label="Tu mensaje"></textarea>
        ${puedeAudio ? `<button type="button" class="btn chat-mic" id="chatMic" aria-label="Grabar un mensaje de voz"${C.enviando ? ' disabled' : ''}><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg></button>` : ''}
        <button type="submit" class="btn primario" id="chatEnviar"${C.enviando ? ' disabled' : ''}>Enviar</button>
      </form>`}
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
  else if (t.id === 'cartelX') { C.cartelOculto = true; dibujar(); }
  else if (t.id === 'chatCerrar') cerrar();
  else if (t.id === 'chatRep') pedirRepresentante();
  else if (t.id === 'chatNueva') nuevaConversacion();
  else if (t.id === 'chatMic') empezarGrabacion();
  else if (t.id === 'chatGrabCancelar') cancelarGrabacion();
  else if (t.id === 'chatGrabEnviar') enviarGrabacion();
  else if (t.dataset.voz) leerEnVoz(t.dataset.voz);
  else if (t.dataset.audio) reproducirAudio(t.dataset.audio);
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

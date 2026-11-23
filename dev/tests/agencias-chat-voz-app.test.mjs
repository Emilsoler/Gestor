// La voz del chat «M» en un navegador real (docs/agencias/chat.js y la solapa «Chats» de docs/cobranzas): el botón «Escuchar»,
// grabar y mandar un mensaje de voz a una persona de la Mutual, escucharlo después de recargar y que la Mutual lo escuche.
// Requiere `dev/stack.sh up` y `node dev/serve.mjs`. Chrome corre con un micrófono falso (--use-fake-device-for-media-stream);
// la voz del sistema se reemplaza por un registro de lo que se pidió leer, porque en un servidor no hay voces.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { sql, crearCuenta, limpiar, servicio } from './helpers.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8080/';
const CLAUDE = 'http://127.0.0.1:54340';
const EMI = 'voz-emi@test.local', CLAVE = 'Clave-voz-emi-2026';
const AG = 'salon-voz@test.local', AG_CLAVE = 'Agencia-voz-2026';
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
const guion = (pasos) => fetch(`${CLAUDE}/__guion`, { method: 'POST', body: JSON.stringify(pasos) });

let browser;
const errores = [];

// Se instala antes de que cargue la página: registra lo que se manda a leer y lo que se reproduce.
const INSTRUMENTAR = () => {
  window.__hablado = []; window.__sonados = [];
  const voz = window.speechSynthesis;
  voz.speak = (u) => { window.__hablado.push({ texto: u.text, lang: u.lang }); setTimeout(() => u.onend && u.onend(), 40); };
  voz.cancel = () => {};
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__sonados.push(this.src); return play.call(this); };
};

async function pagina(nombre, viewport) {
  const c = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', viewport, permissions: ['microphone'] });
  await c.addInitScript(INSTRUMENTAR);
  const p = await c.newPage();
  p.on('pageerror', (e) => errores.push(`[${nombre}] ${e.message}`));
  // Un bloqueo de la política de seguridad (por ejemplo, de los audios) aparece como error de consola.
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|realtime|Failed to load resource/i.test(m.text())) errores.push(`[${nombre}] ${m.text()}`); });
  return p;
}
async function entrarAgencia(p) {
  await p.goto(BASE + 'agencias/');
  await p.waitForSelector('#fIngreso');
  await p.fill('#fIngreso [name=email]', AG); await p.fill('#fIngreso [name=clave]', AG_CLAVE);
  await p.click('#fIngreso button[type=submit]');
  await p.waitForSelector('.tabs');
}
async function entrarCobranzas(p) {
  await p.goto(BASE + 'cobranzas/');
  await p.waitForSelector('#fIngreso');
  await p.fill('#i_email', EMI); await p.fill('#i_clave', CLAVE);
  await p.click('#fIngreso button[type=submit]');
  await p.waitForSelector('#vApp:not([hidden])');
}

before(async () => {
  limpiar();
  sql(`delete from public.avisos_push; delete from public.chats_agencia; delete from public.cotizaciones_agencia; delete from public.solicitudes_credito; delete from public.agencias;
       update public.ajustes_agencias set habilitado = true, chat_habilitado = true, ayuda = 'Hoja base.', relacion_max = 45, plazos = '{12,24}', contacto = '';`);
  await fetch('http://127.0.0.1:54344/__objetos', { method: 'DELETE' });
  await crearCuenta(EMI, CLAVE, 'Emi');
  const { error } = await servicio().auth.admin.createUser({ email: AG, password: AG_CLAVE, email_confirm: true });
  assert.ifError(error);
  sql(`select gestor.autorizar_agencia('${AG}', 'Salón Voz', gestor.hoy()); update public.agencias set clave_temporal = false`);
  const exe = process.env.CHROME || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
  browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
});
after(async () => { await browser?.close(); });

test('«Escuchar»: el asistente y la Mutual se leen en voz alta; lo que escribe la agencia, no', async () => {
  const p = await pagina('agencia', { width: 390, height: 780 });
  await entrarAgencia(p);
  await p.click('#btnM');
  await p.waitForSelector('#chatPanel');
  // El saludo ya se puede escuchar.
  const saludo = p.locator('.msg.bot [data-voz="saludo"]');
  assert.equal(norm(await saludo.textContent()), 'Escuchar');
  await saludo.click();
  const dicho = await p.evaluate(() => window.__hablado);
  assert.equal(dicho.length, 1);
  assert.match(dicho[0].texto, /^Hola, soy el asistente de la Mutual/);
  assert.equal(dicho[0].lang, 'es-AR');
  await p.waitForFunction(() => document.querySelector('[data-voz="saludo"]')?.textContent.trim() === 'Escuchar'); // al terminar vuelve a «Escuchar»

  await guion([{ texto: 'Escribí el CUIT del cliente y tocá «Consultar BCRA».' }]);
  await p.fill('#chatTexto', '¿Cómo empiezo?');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.msg.bot:has-text("Consultar BCRA")');
  assert.equal(await p.locator('.msg.yo [data-voz]').count(), 0, 'sus propios mensajes no llevan «Escuchar»');
  await p.locator('.msg.bot:has-text("Consultar BCRA") [data-voz]').click();
  assert.match((await p.evaluate(() => window.__hablado)).at(-1).texto, /Consultar BCRA/);
  // Con el asistente todavía no hay micrófono: los audios son para una persona.
  assert.equal(await p.locator('#chatMic').count(), 0);
  await p.close();
});

test('mensaje de voz: grabar, cancelar, enviar, escucharlo y escucharlo de nuevo al recargar', async () => {
  const p = await pagina('agencia', { width: 390, height: 780 });
  await entrarAgencia(p);
  await p.click('#btnM');
  await p.waitForSelector('#chatPanel');
  await p.waitForSelector('#chatRep'); // la conversación del test anterior sigue abierta
  assert.equal(await p.locator('#chatMic').count(), 0, 'con el asistente no hay micrófono');
  await p.click('#chatRep');
  await p.waitForSelector('.msg.bot:has-text("avisé a la Mutual")');
  await p.waitForSelector('#chatMic');
  assert.equal(await p.getAttribute('#chatMic', 'aria-label'), 'Grabar un mensaje de voz');

  // Grabar y cancelar: no se manda nada.
  await p.click('#chatMic');
  await p.waitForSelector('.chat-grab');
  assert.equal(await p.locator('#chatForm').count(), 0, 'mientras graba se reemplaza el campo de texto');
  await p.click('#chatGrabCancelar');
  await p.waitForSelector('#chatForm');
  assert.equal(sql('select count(*) from public.mensajes_agencia where audio_path is not null'), '0');

  // Grabar de verdad (micrófono falso) y mandar.
  await p.click('#chatMic');
  await p.waitForSelector('.chat-grab');
  await p.waitForFunction(() => document.querySelector('#chatGrabT')?.textContent.trim() !== '0:00', null, { timeout: 5000 });
  await p.screenshot({ path: '/tmp/voz-grabando-celular.png' });
  await p.click('#chatGrabEnviar');
  await p.waitForSelector('.msg.yo .chat-audio');
  await p.waitForFunction(() => !document.querySelector('.chat-audio')?.disabled, null, { timeout: 8000 });
  assert.match(norm(await p.textContent('.msg.yo .chat-audio')), /^Escuchar audio · 0:0\d$/);
  assert.equal(sql('select count(*) from public.mensajes_agencia where audio_path is not null'), '1');
  // El navegador elige el formato (mp4 si puede, que es lo que se reproduce en el iPhone; si no, webm).
  assert.match(sql(`select audio_tipo from public.mensajes_agencia where audio_path is not null`), /^audio\/(mp4|webm)$/);
  assert.equal(await p.locator('.msg.yo [data-voz]').count(), 0);

  // Escucharlo (el mismo audio, sin volver a bajarlo).
  await p.click('.msg.yo .chat-audio');
  await p.waitForFunction(() => window.__sonados.length === 1);
  assert.match((await p.evaluate(() => window.__sonados))[0], /^blob:/);
  await p.waitForFunction(() => /^Escuchar audio/.test(document.querySelector('.chat-audio')?.textContent.trim() || ''), null, { timeout: 10000 }); // termina solo
  await p.screenshot({ path: '/tmp/voz-mensaje-celular.png' });

  // Al recargar, el audio sale del servidor.
  await p.reload();
  await p.waitForSelector('#btnM');
  await p.click('#btnM');
  await p.waitForSelector('.msg.yo .chat-audio');
  await p.click('.msg.yo .chat-audio');
  await p.waitForFunction(() => window.__sonados.length === 1);
  assert.match((await p.evaluate(() => window.__sonados))[0], /^blob:/);
  await p.close();
});

test('la Mutual ve el audio en el chat, lo escucha y le contesta; la agencia lo puede leer en voz alta', async () => {
  const p = await pagina('mutual', { width: 1280, height: 900 });
  await entrarCobranzas(p);
  await p.evaluate(() => { location.hash = '#agencias-chats'; });
  await p.waitForSelector('.ag-chat-fila');
  assert.match(norm(await p.textContent('.ag-chat-fila')), /Mensaje de voz/, 'el último mensaje de la lista');
  await p.click('.ag-chat-fila');
  await p.waitForSelector('[data-a="ag-chat-audio"]');
  assert.match(norm(await p.textContent('[data-a="ag-chat-audio"]')), /^Escuchar audio · 0:0\d$/);
  await p.click('[data-a="ag-chat-audio"]');
  await p.waitForFunction(() => window.__sonados.length === 1);
  assert.match((await p.evaluate(() => window.__sonados))[0], /^blob:/);
  await p.waitForFunction(() => /^Escuchar audio/.test(document.querySelector('[data-a="ag-chat-audio"]')?.textContent.trim() || ''), null, { timeout: 10000 });
  await p.screenshot({ path: '/tmp/voz-mutual.png' });
  await p.fill('#agChatTexto', 'Hola, te escucho. Mandame el CUIT por acá.');
  await p.click('[data-a="ag-chat-enviar"]');
  await p.waitForSelector('.ag-msg.mutual:has-text("Mandame el CUIT")');
  await p.close();

  // La respuesta de la Mutual también se puede escuchar.
  const a = await pagina('agencia', { width: 390, height: 780 });
  await entrarAgencia(a);
  await a.click('#btnM');
  await a.waitForSelector('.msg.mutual:has-text("Mandame el CUIT")');
  await a.locator('.msg.mutual [data-voz]').click();
  assert.match((await a.evaluate(() => window.__hablado)).at(-1).texto, /Mandame el CUIT/);
  await a.close();
});

test('sin micrófono ni voz en el navegador, el chat sigue andando solo con texto', async () => {
  const c = await browser.newContext({ locale: 'es-AR', viewport: { width: 390, height: 780 } });
  await c.addInitScript(() => {
    delete window.MediaRecorder;
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
  });
  const p = await c.newPage();
  p.on('pageerror', (e) => errores.push(`[sin-voz] ${e.message}`));
  await entrarAgencia(p);
  await p.click('#btnM');
  await p.waitForSelector('#chatPanel');
  assert.equal(await p.locator('[data-voz]').count(), 0, 'sin voz no hay «Escuchar»');
  assert.equal(await p.locator('#chatMic').count(), 0, 'sin micrófono no hay botón de audio');
  assert.equal(await p.locator('#chatForm').count(), 1);
  await c.close();
});

test('no hubo errores de consola ni bloqueos de seguridad', () => {
  assert.deepEqual(errores, []);
});

// El chat de las agencias en un navegador real: el botón «M» y su ventana en el cotizador (docs/agencias/chat.js) y la
// solapa «Chats» de Créditos y Cobros (docs/cobranzas/agencias.js), en celular y en compu, hablando con la función
// `agencias` de verdad (con un doble de Claude).
// Requiere `dev/stack.sh up` y `node dev/serve.mjs` (las apps en http://127.0.0.1:8080/). Con un Chrome del sistema:
// CHROME=/usr/bin/google-chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { sql, crearCuenta, limpiar, env, servicio } from './helpers.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8080/';
const CLAUDE = 'http://127.0.0.1:54340';
const EMI = 'chat-emi@test.local', CLAVE = 'Clave-chat-emi-2026';
const AG = 'salon-chat@test.local', AG_CLAVE = 'Agencia-chat-2026';
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

let browser;
const errores = [];
const guion = (pasos) => fetch(`${CLAUDE}/__guion`, { method: 'POST', body: JSON.stringify(pasos) });

async function pagina(nombre, viewport, contexto = null) {
  const c = contexto || await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', viewport });
  const p = await c.newPage();
  p.on('pageerror', (e) => errores.push(`[${nombre}] ${e.message}`));
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
const toast = (p, texto) => p.waitForFunction((t) => { const e = document.querySelector('#toast'); return e && !e.hidden && e.textContent.includes(t); }, texto, { timeout: 8000 });

before(async () => {
  limpiar();
  sql(`delete from public.avisos_push; delete from public.chats_agencia; delete from public.cotizaciones_agencia; delete from public.solicitudes_credito; delete from public.agencias;
       update public.ajustes_agencias set habilitado = true, chat_habilitado = true, ayuda = 'Hoja base. SEMÁFORO DEL BCRA: verde, amarillo, rojo.', relacion_max = 45, plazos = '{12,24}', contacto = '';`);
  await crearCuenta(EMI, CLAVE, 'Emi');
  const { error } = await servicio().auth.admin.createUser({ email: AG, password: AG_CLAVE, email_confirm: true });
  assert.ifError(error);
  sql(`select gestor.autorizar_agencia('${AG}', 'Salón Prueba', gestor.hoy()); update public.agencias set clave_temporal = false`);
  const exe = process.env.CHROME || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
});
after(async () => { await browser?.close(); });

let agenciaPag, contextoAg;

test('la agencia ve la «M», chatea con el asistente y pide un representante (celular)', async () => {
  contextoAg = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', viewport: { width: 390, height: 780 } });
  agenciaPag = await pagina('agencia', null, contextoAg);
  const p = agenciaPag;
  await entrarAgencia(p);
  await p.waitForSelector('#btnM');
  assert.equal(await p.locator('#btnM img[src="img/m.png"]').count(), 1); // el botón es la imagen de la Mutual
  assert.equal(await p.getAttribute('#btnM', 'aria-expanded'), 'false');
  await p.click('#btnM');
  await p.waitForSelector('#chatPanel');
  assert.match(norm(await p.textContent('.chat-msgs')), /soy el asistente de la Mutual/);
  assert.equal(await p.evaluate(() => document.activeElement?.id), 'chatTexto', 'el cursor queda en el campo');
  // Todavía no escribió nada: no hay a quién derivar.
  assert.equal(await p.locator('#chatRep').count(), 0);

  await guion([{ texto: 'Escribí el CUIT del cliente y tocá «Consultar BCRA».' }]);
  await p.fill('#chatTexto', '¿Cómo empiezo?');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.msg.bot:has-text("Consultar BCRA")');
  assert.equal(await p.inputValue('#chatTexto'), '', 'el campo se vacía al enviar');
  assert.match(norm(await p.textContent('.msg.yo')), /¿Cómo empiezo\?/);
  assert.match(norm(await p.textContent('.chat-cab small')), /asistente automático/);
  await p.waitForSelector('#chatRep');

  // El resto de la pantalla se redibuja y el chat sigue ahí, con lo que se estaba escribiendo.
  await p.fill('#chatTexto', 'borrador sin enviar');
  await p.evaluate(() => document.querySelector('[data-vista="solicitudes"]').click());
  await p.waitForSelector('.tabs [aria-selected="true"]:has-text("Mis solicitudes")');
  assert.equal(await p.inputValue('#chatTexto'), 'borrador sin enviar');
  await p.fill('#chatTexto', '');

  await p.click('#chatRep');
  await p.waitForSelector('.msg.bot:has-text("avisé a la Mutual")');
  assert.match(norm(await p.textContent('.chat-cab small')), /Esperando a una persona/);
  assert.equal(await p.locator('#chatRep').count(), 0, 'una vez pedido, el botón desaparece');
  // En el celular la ventana ocupa toda la pantalla.
  const caja = await p.locator('#chatPanel').boundingBox();
  assert.ok(caja.width >= 388 && caja.height >= 770, JSON.stringify(caja));
  await p.screenshot({ path: '/tmp/chat-agencia-celular.png' });
});

test('la Mutual ve la conversación en espera en Créditos y Cobros, la abre y responde', async () => {
  const p = await pagina('mutual', { width: 1280, height: 900 });
  await entrarCobranzas(p);
  await p.evaluate(() => { location.hash = '#agencias-chats'; });
  await p.waitForSelector('.ag-chat-fila');
  assert.match(norm(await p.textContent('.tabs [aria-selected="true"]')), /Chats \(1\)/);
  const fila = norm(await p.textContent('.ag-chat-fila'));
  assert.match(fila, /Salón Prueba/);
  assert.match(fila, /Esperando tu respuesta/);
  assert.match(norm(await p.textContent('#nAgencias')), /^1/, 'la insignia de la solapa');
  // En un navegador sin permiso ni celular instalado, la tarjeta de avisos lo explica.
  assert.match(norm(await p.textContent('#main')), /Avisos al celular/);
  await p.screenshot({ path: '/tmp/chat-mutual-lista.png' });

  await p.click('.ag-chat-fila');
  await p.waitForSelector('#agChatTexto');
  assert.match(norm(await p.textContent('.ag-msgs')), /¿Cómo empiezo\?/);
  assert.match(norm(await p.textContent('.ag-msgs')), /avisé a la Mutual/);
  await p.fill('#agChatTexto', 'Hola, soy Emi. ¿En qué te ayudo?');
  await p.click('[data-a="ag-chat-enviar"]');
  await toast(p, 'Respuesta enviada');
  assert.match(norm(await p.textContent('.ag-msg.mutual')), /soy Emi/);
  assert.match(norm(await p.textContent('.ag-hilo h3')), /En conversación/);
  assert.equal(await p.inputValue('#agChatTexto'), '', 'el campo se vacía');
  await p.screenshot({ path: '/tmp/chat-mutual-hilo.png' });

  // Vuelve a la lista: ya no pide atención.
  await p.click('[data-a="ag-chat-volver"]');
  await p.waitForSelector('.ag-chat-fila');
  assert.match(norm(await p.textContent('.tabs [aria-selected="true"]')), /^Chats$/);
  await p.context().close();
});

test('la agencia recibe la respuesta sin hacer nada y puede seguir escribiendo', async () => {
  const p = agenciaPag;
  await p.waitForSelector('.msg.mutual:has-text("soy Emi")', { timeout: 15000 });
  assert.match(norm(await p.textContent('.chat-cab small')), /Hablás con la Mutual/);
  assert.equal(await p.locator('#chatRep').count(), 0);
  await p.fill('#chatTexto', 'Quería consultar por una solicitud');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.msg.yo:has-text("una solicitud")');
  assert.equal(await p.locator('.msg.escribiendo').count(), 0, 'con una persona no hay «escribiendo» del asistente');
});

test('cerrar el chat, el punto de mensaje nuevo y «Nueva conversación»', async () => {
  const p = agenciaPag;
  await p.click('#chatCerrar');
  await p.waitForSelector('#btnM:not([hidden])');
  assert.equal(await p.locator('#chatPanel').count(), 0);
  // La Mutual contesta con el chat cerrado: aparece el punto en la «M».
  const jwt = await (async () => {
    const { entrar } = await import('./helpers.mjs');
    return (await entrar(EMI, CLAVE)).sesion.access_token;
  })();
  const [c] = (await (await fetch(`${env.SUPABASE_URL}/functions/v1/agencias`, { method: 'POST', headers: { apikey: env.ANON_KEY, 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ accion: 'chats' }) })).json()).chats;
  await fetch(`${env.SUPABASE_URL}/functions/v1/agencias`, { method: 'POST', headers: { apikey: env.ANON_KEY, 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ accion: 'chat_responder', chat: c.id, texto: 'Te escribo con el chat cerrado' }) });
  await p.waitForSelector('#btnM .punto', { timeout: 40000 });
  await p.click('#btnM');
  await p.waitForSelector('.msg.mutual:has-text("chat cerrado")');
  assert.equal(await p.locator('#btnM .punto').count(), 0);
  await p.click('#chatNueva');
  await p.waitForFunction(() => document.querySelectorAll('.msg.yo').length === 0);
  assert.match(norm(await p.textContent('.chat-cab small')), /asistente automático/);
  assert.equal(sql(`select count(*) from public.chats_agencia where estado <> 'cerrado'`), '0');
});

test('con el chat apagado la agencia no ve la «M»; y la Mutual lo prende desde Parámetros con la hoja de respuestas', async () => {
  sql(`update public.ajustes_agencias set chat_habilitado = false`);
  const p = await pagina('agencia2', { width: 1100, height: 800 });
  await entrarAgencia(p);
  await p.waitForTimeout(500);
  assert.equal(await p.locator('#btnM').count(), 0);
  assert.equal(await p.locator('#chat').innerHTML(), '');
  await p.context().close();

  const m = await pagina('mutual2', { width: 1280, height: 900 });
  await entrarCobranzas(m);
  await m.evaluate(() => { location.hash = '#agencias'; });
  await m.waitForSelector('.ag .tabs');
  await m.click('.tabs [data-tab="parametros"]');
  await m.waitForSelector('[data-k="ag.p.ayuda"]');
  assert.match(await m.inputValue('[data-k="ag.p.ayuda"]'), /SEMÁFORO DEL BCRA/);
  assert.equal(await m.isChecked('[data-k="ag.p.chat_habilitado"]'), false);
  await m.check('[data-k="ag.p.chat_habilitado"]');
  await m.fill('[data-k="ag.p.ayuda"]', 'HOJA NUEVA DE LA MUTUAL: atendemos de lunes a viernes.');
  await m.click('[data-a="ag-param-guardar"]');
  await toast(m, 'Parámetros guardados');
  assert.equal(sql('select chat_habilitado from public.ajustes_agencias'), 't');
  assert.match(sql('select ayuda from public.ajustes_agencias'), /HOJA NUEVA/);
  // Y la hoja nueva es la que usa el asistente.
  await fetch(`${CLAUDE}/__pedidos`, { method: 'DELETE' });
  await guion([{ texto: 'Atendemos de lunes a viernes.' }]);
  const p2 = await pagina('agencia3', { width: 390, height: 780 });
  await entrarAgencia(p2);
  await p2.click('#btnM');
  await p2.fill('#chatTexto', '¿Qué días atienden?');
  await p2.click('#chatEnviar');
  await p2.waitForSelector('.msg.bot:has-text("lunes a viernes")');
  const [pedido] = await (await fetch(`${CLAUDE}/__pedidos`)).json();
  assert.match(pedido.cuerpo.system, /HOJA NUEVA DE LA MUTUAL/);
  await p2.context().close();
  await m.context().close();
});

test('sin errores en la consola de ninguna de las dos apps (la política de seguridad no bloqueó nada)', () => {
  assert.deepEqual(errores, []);
});

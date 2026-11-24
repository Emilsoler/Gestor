// Logo de las agencias en el cotizador (migración 0039): la función entrega a cada agencia solo el suyo, la tabla está cerrada a
// la API, la base no acepta lo que no sea una imagen, y la pantalla lo muestra en el encabezado y en la hoja que se imprime.
// Requiere `dev/stack.sh up` y `node dev/serve.mjs`. Con un Chrome del sistema: CHROME=/usr/bin/google-chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { sql, sqlFalla, limpiar, crearCuenta, entrar, env, servicio } from './helpers.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8080/';
const FN = `${env.SUPABASE_URL}/functions/v1/agencias`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const EMI = 'logo-emi@test.local', CLAVE = 'Clave-logo-emi-2026';
const CON = 'con-logo@test.local', SIN = 'sin-logo@test.local', AG_CLAVE = 'Agencia-logo-2026';

let browser, emi, con, sin;
const errores = [];

async function pedir(jwt, cuerpo) {
  const r = await fetch(FN, {
    method: 'POST',
    headers: { apikey: env.ANON_KEY, 'content-type': 'application/json', origin: 'http://127.0.0.1:8080', authorization: `Bearer ${jwt}` },
    body: JSON.stringify(cuerpo),
  });
  return { status: r.status, datos: await r.json() };
}
async function entrarAgencia(email, ancho = 390) {
  const c = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', viewport: { width: ancho, height: 780 } });
  const p = await c.newPage();
  p.on('pageerror', (e) => errores.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|realtime|Failed to load resource/i.test(m.text())) errores.push(m.text()); });
  await p.goto(BASE + 'agencias/');
  await p.waitForSelector('#fIngreso');
  await p.fill('#fIngreso [name=email]', email); await p.fill('#fIngreso [name=clave]', AG_CLAVE);
  await p.click('#fIngreso button[type=submit]');
  await p.waitForSelector('.tabs');
  return p;
}

before(async () => {
  limpiar();
  sql(`delete from public.logos_agencia; delete from public.chats_agencia; delete from public.cotizaciones_agencia; delete from public.solicitudes_credito; delete from public.agencias;
       update public.ajustes_agencias set habilitado = true, chat_habilitado = false, plazos = '{12,24}', contacto = '';`);
  await crearCuenta(EMI, CLAVE, 'Emi');
  emi = (await entrar(EMI, CLAVE)).sesion.access_token;
  for (const email of [CON, SIN]) {
    const { error } = await servicio().auth.admin.createUser({ email, password: AG_CLAVE, email_confirm: true });
    assert.ifError(error);
  }
  sql(`select gestor.autorizar_agencia('${CON}', 'Salón Con Logo', gestor.hoy()); select gestor.autorizar_agencia('${SIN}', 'Salón Sin Logo', gestor.hoy());
       update public.agencias set clave_temporal = false, simulacion_rapida = (email = '${CON}')`);
  con = (await entrar(CON, AG_CLAVE)).sesion.access_token;
  sin = (await entrar(SIN, AG_CLAVE)).sesion.access_token;
  const exe = process.env.CHROME || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
});
after(async () => { await browser?.close(); });

test('cada agencia recibe solo su logo; sin logo, o desde la vista previa de la Mutual, viene vacío', async () => {
  assert.equal((await pedir(con, { accion: 'yo' })).datos.logo, '');
  assert.match(sql(`select gestor.poner_logo('${CON}', '${PNG}')`), /Logo de Salón Con Logo guardado/);
  assert.equal((await pedir(con, { accion: 'yo' })).datos.logo, PNG);
  assert.equal((await pedir(sin, { accion: 'yo' })).datos.logo, '', 'la otra agencia no ve el logo ajeno');
  assert.equal((await pedir(emi, { accion: 'yo' })).datos.logo, '', 'la vista previa de la Mutual no tiene logo');
  // Cambiarlo reemplaza; vaciarlo lo quita.
  sql(`select gestor.poner_logo('${CON}', '${PNG}')`);
  assert.equal(sql(`select count(*) from public.logos_agencia`), '1');
  assert.match(sql(`select gestor.poner_logo('${CON}', '')`), /quitado/);
  assert.equal((await pedir(con, { accion: 'yo' })).datos.logo, '');
  sql(`select gestor.poner_logo('${CON}', '${PNG}')`);
});

test('una agencia pausada deja de recibir el logo, y al reactivarla lo recupera', async () => {
  sql(`select gestor.pausar_agencia('${CON}')`);
  assert.equal(sql(`select public.agencia_logo((select user_id from public.agencias where email = '${CON}'))`), '');
  sql(`update public.agencias set activa = true where email = '${CON}'`);
  assert.equal(sql(`select left(public.agencia_logo((select user_id from public.agencias where email = '${CON}')), 22)`), 'data:image/png;base64,');
});

test('la base solo guarda imágenes (png, jpeg o webp) y de tamaño razonable', async () => {
  assert.match(sqlFalla(`select gestor.poner_logo('${CON}', 'data:text/html;base64,PGgxPg==')`), /logos_agencia_imagen_check|check/i);
  assert.match(sqlFalla(`select gestor.poner_logo('${CON}', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')`), /check/i);
  assert.match(sqlFalla(`select gestor.poner_logo('${CON}', '"><script>alert(1)</script>')`), /check/i);
  assert.match(sqlFalla(`select gestor.poner_logo('${CON}', 'data:image/png;base64,' || repeat('A', 60000))`), /check/i);
  assert.match(sqlFalla(`select gestor.poner_logo('nadie@test.local', '${PNG}')`), /No hay una agencia/);
  assert.equal(sql(`select left(imagen, 22) from public.logos_agencia`), 'data:image/png;base64,', 'lo rechazado no pisó el logo guardado');
});

test('la tabla de logos está cerrada a la API, para una agencia y para la persona', async () => {
  for (const jwt of [con, emi]) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/logos_agencia?select=*`, { headers: { apikey: env.ANON_KEY, authorization: `Bearer ${jwt}` } });
    assert.ok(r.status >= 400, `la API no debe dar el logo (dio ${r.status})`);
    assert.ok(!(await r.text()).includes('data:image'), 'y no debe aparecer ninguna imagen');
  }
  const f = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/agencia_logo`, { method: 'POST', headers: { apikey: env.ANON_KEY, authorization: `Bearer ${con}`, 'content-type': 'application/json' }, body: JSON.stringify({ p_user: '00000000-0000-0000-0000-000000000000' }) });
  assert.ok(f.status >= 400, 'la función de la base tampoco es para la API');
});

test('en el celular el logo se ve arriba de las solapas, sin desbordar, y la otra agencia no lo tiene', async () => {
  const p = await entrarAgencia(CON);
  await p.waitForSelector('.banda-ag .logo-ag');
  assert.equal(await p.getAttribute('.banda-ag .logo-ag', 'src'), PNG);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'la banda no debe desbordar el ancho del celular');
  assert.equal(await p.evaluate(() => document.querySelector('.cab .btn').getBoundingClientRect().right <= window.innerWidth), true, 'el botón Salir queda a la vista');
  await p.context().close();
  const q = await entrarAgencia(SIN);
  assert.equal(await q.locator('.banda-ag .logo-ag').count(), 0);
  await q.context().close();
});

test('la hoja que se imprime lleva el logo al lado del escudo', async () => {
  const p = await entrarAgencia(CON, 1100);
  await p.click('[data-vista=rapida]');
  await p.fill('[data-rap=capital]', '5000000');
  await p.click('#btnRapida');
  await p.waitForSelector('#resultado .hoja-imprimir', { state: 'attached' }); // en pantalla está oculta: solo se ve al imprimir
  assert.equal(await p.getAttribute('.hoja-imprimir .hoja-logo-ag', 'src'), PNG);
  assert.equal(await p.locator('.hoja-cabeza img').count(), 2, 'escudo y logo');
  await p.context().close();
});

test('sin errores en la consola', () => { assert.deepEqual(errores, []); });

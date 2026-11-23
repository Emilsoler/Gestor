// El cotizador de agencias en un navegador real: cotizar por «cuota que quiere pagar» y con precio y anticipo.
// Requiere `dev/stack.sh up` y `node dev/serve.mjs` (las apps en http://127.0.0.1:8080/). Con un Chrome del sistema: CHROME=/usr/bin/google-chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { sql, limpiar, servicio } from './helpers.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8080/';
const AG = 'salon-cotiza@test.local', CLAVE = 'Agencia-cotiza-2026';
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
let browser;
const errores = [];

before(async () => {
  limpiar();
  sql(`delete from public.cotizaciones_agencia; delete from public.solicitudes_credito; delete from public.agencias;
       update public.ajustes_agencias set habilitado = true, pct_financiable = 50, redondeo = 50000, plazos = '{12,18,24,36}', tasas = '[]', anio_minimo = null, antiguedad_max = null,
         tasa_mensual = 7, monto_minimo = 0, monto_maximo = null, tope_diario = 300, contacto = '';`);
  const { error } = await servicio().auth.admin.createUser({ email: AG, password: CLAVE, email_confirm: true });
  assert.ifError(error);
  sql(`select gestor.autorizar_agencia('${AG}', 'Salón Cotiza', gestor.hoy()); update public.agencias set clave_temporal = false`);
  const exe = process.env.CHROME || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
});
after(async () => { await browser?.close(); });

test('cotizar por la cuota que quiere pagar y con precio y anticipo (celular)', async () => {
  const c = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', viewport: { width: 390, height: 800 } });
  const p = await c.newPage();
  p.on('pageerror', (e) => errores.push(e.message));
  await p.goto(BASE + 'agencias/');
  await p.waitForSelector('#fIngreso');
  await p.fill('#fIngreso [name=email]', AG); await p.fill('#fIngreso [name=clave]', CLAVE);
  await p.click('#fIngreso button[type=submit]');
  await p.waitForSelector('#fCliente');
  await p.fill('#inCuit', '20-12345678-6');
  await p.click('#fCliente button[type=submit]');
  await p.click('#btnContinuar');
  await p.waitForSelector('#selMarca:not([disabled])');
  await p.selectOption('#selMarca', { label: 'MARCA UNO' });
  await p.waitForSelector('#selModelo:not([disabled])');
  await p.waitForFunction(() => document.querySelector('#selModelo option[value="10"]'));
  await p.selectOption('#selModelo', '10');
  await p.waitForFunction(() => document.querySelector('#selAnio') && !document.querySelector('#selAnio').disabled && document.querySelectorAll('#selAnio option').length > 1);
  await p.selectOption('#selAnio', { index: 1 });
  await p.waitForSelector('#inVersion:not([disabled])');
  await p.click('#inVersion');
  await p.keyboard.press('ArrowDown');
  await p.click('#listaVersiones [data-ver]');
  await p.waitForSelector('#btnCotizar:not([disabled])');
  await p.click('[data-plazo="24"]');

  // 1) Cuota deseada: se escribe con puntos y la tabla muestra el monto de cada plazo.
  await p.fill('#inCuotaMax', '1000000');
  assert.equal(await p.inputValue('#inCuotaMax'), '1.000.000');
  await p.click('#btnCotizar');
  await p.waitForSelector('#resultado .cuota-grande');
  const tabla = norm(await p.textContent('#resultado'));
  assert.match(tabla, /Con una cuota de hasta \$\s?1\.000\.000/);
  assert.equal(await p.locator('#resultado table:has(th:has-text("Con una cuota de hasta")) tbody tr').count(), 4);
  const cuota = Number(norm(await p.textContent('#resultado .cuota-grande b:last-child')).replace(/[^\d]/g, ''));
  assert.ok(cuota > 0 && cuota <= 1_000_000, `la cuota ${cuota} no pasa de lo pedido`);
  await p.screenshot({ path: '/tmp/cuota-deseada.png', fullPage: true });

  // 2) Precio y anticipo: el monto solicitado se completa solo y se explica cuánto pone el cliente.
  await p.fill('#inCuotaMax', '');
  await p.fill('#inPrecio', '20000000');
  await p.fill('#inAnticipo', '12000000');
  assert.equal(await p.inputValue('#inMonto'), '8.000.000');
  await p.click('#btnCotizar');
  await p.waitForFunction(() => /el cliente pone de anticipo/.test(document.querySelector('#resultado')?.textContent || ''));
  let t = norm(await p.textContent('#resultado'));
  assert.match(t, /Crédito de \$\s?8\.000\.000/);
  assert.match(t, /Precio \$\s?20\.000\.000 − crédito \$\s?8\.000\.000 = el cliente pone de anticipo al menos \$\s?12\.000\.000/);

  // 3) Anticipo chico: pide más de lo que financia la Mutual y se le avisa.
  await p.fill('#inAnticipo', '1000000');
  await p.click('#btnCotizar');
  await p.waitForFunction(() => /la Mutual financia hasta/.test(document.querySelector('#resultado')?.textContent || ''));
  t = norm(await p.textContent('#resultado'));
  assert.match(t, /Pediste \$\s?19\.000\.000, pero la Mutual financia hasta/);
  assert.match(t, /el cliente pone de anticipo al menos/);
  await p.screenshot({ path: '/tmp/anticipo.png', fullPage: true });
  assert.deepEqual(errores, []);
  await c.close();
});

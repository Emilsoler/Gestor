// «Descuento de cheques» (Créditos y Cobros → Créditos) de punta a punta, en un navegador real contra la base local.
// Requiere `dev/stack.sh up` y `node dev/serve.mjs`. La lista de bancos del BCRA se contesta acá (sin la función bcra).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { sql, crearCuenta } from './helpers.mjs';

const BASE = (process.env.BASE || 'http://127.0.0.1:8080/') + 'cobranzas/';
const EMAIL = 'descuento-app@test.local', CLAVE = 'Clave-descuento-app-2026';
const BANCOS = [{ codigo: 11, nombre: 'BANCO DE LA NACION ARGENTINA' }, { codigo: 20, nombre: 'BANCO DE LA PROVINCIA DE CORDOBA S.A.' }];
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ');
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const enDias = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

let browser, page;
const errores = [];
async function nuevaPagina(opciones = {}) {
  const c = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', viewport: { width: 1366, height: 900 }, ...opciones });
  await c.route('**/functions/v1/bcra', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entidades: BANCOS }) }));
  const p = await c.newPage();
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|realtime|Failed to load resource/i.test(m.text())) errores.push(m.text()); });
  p.on('pageerror', (e) => errores.push(e.message));
  await p.goto(BASE);
  await p.waitForSelector('#fIngreso');
  await p.fill('#i_email', EMAIL); await p.fill('#i_clave', CLAVE);
  await p.click('#fIngreso button[type=submit]');
  await p.waitForSelector('#vApp:not([hidden])');
  await p.click('#v_creditos');
  await p.click('[data-cr-modo="descuento"]');
  await p.waitForSelector('#crDescuento');
  return p;
}
const toast = (p, texto) => p.waitForFunction((t) => { const e = document.querySelector('#toast'); return e && !e.hidden && e.textContent.includes(t); }, texto, { timeout: 8000 });

before(async () => {
  sql(`delete from public.descuentos_cheques; delete from auth.users where email = '${EMAIL}';`);
  await crearCuenta(EMAIL, CLAVE, 'Emi');
  browser = await chromium.launch();
  page = await nuevaPagina();
});
after(async () => { await browser?.close(); });

test('liquidar: se cargan cliente, condiciones y dos cheques; la liquidación se ve al escribir y se guarda', async () => {
  assert.match(await page.textContent('#crDescuento'), /Cargá el importe y la fecha de pago/);
  await page.fill('#dc_cliente', 'Pérez Juan');
  await page.fill('#dc_cuit', '20-12345678-6');
  await page.fill('#dc_tasa', '4');
  await page.fill('#dc_comision', '1');
  await page.fill('#dc_sellado', '1,2');
  await page.fill('#dc_gastos', '500');
  await page.fill('#dc_cheques_0_importe', '1.000.000');
  await page.fill('[data-k="cred.dc.f.cheques.0.vence"]', enDias(30));
  await page.fill('[data-k="cred.dc.f.cheques.0.banco"]', 'BANCO DE LA NACION ARGENTINA');
  await page.fill('#dc_cheques_0_numero', '00012345');
  await page.fill('#dc_cheques_0_librador', 'ACME SA');
  await page.click('[data-a="dc-cheque-mas"]');
  await page.fill('#dc_cheques_1_importe', '500.000');
  await page.fill('[data-k="cred.dc.f.cheques.1.vence"]', enDias(0));
  const t = norm(await page.textContent('#dcResultado'));
  // 1.000.000 × 4% / 30 × 30 = 40.000; comisión 10.000; sellado 12.000; gastos 500 → neto 937.500. El de hoy: 0 días.
  assert.match(t, /\$ 937\.500/);
  assert.match(t, /\$ 1\.500\.000/); // valor de los cheques
  assert.match(t, /Se le paga al cliente ?\$ 1\.426\.000/); // 937.500 + (500.000 − 5.000 − 6.000 − 500)
  await page.click('[data-a="dc-guardar"]');
  await toast(page, 'Operación guardada: se le pagan $');
  const fila = JSON.parse(sql(`select to_jsonb(d) from public.descuentos_cheques d`));
  assert.equal(fila.cliente, 'Pérez Juan');
  assert.equal(fila.cuit, '20123456786');
  assert.deepEqual([+fila.tasa, +fila.comision, +fila.sellado, +fila.gastos], [4, 1, 1.2, 500]);
  assert.equal(fila.cheques.length, 2);
  assert.deepEqual([fila.cheques[0].entidad, fila.cheques[0].numero, fila.cheques[0].estado], [11, '12345', 'cartera']);
  assert.equal(fila.actualizado_por, 'Emi');
  // Ya guardada: se ofrecen guardar cambios y eliminar.
  await page.waitForSelector('[data-a="dc-confirmar"]');
});

test('cartera: los cheques por fecha, marcar cobrado y rechazado; el rechazado lleva al BCRA', async () => {
  await page.click('[data-a="dc-sub"][data-sub="cartera"]');
  const filas = page.locator('.dc-fila');
  assert.equal(await filas.count(), 2);
  assert.match(norm(await filas.nth(0).textContent()), /se cobra hoy/);
  assert.match(norm(await filas.nth(1).textContent()), /ACME SA.*en 30 días/);
  await filas.nth(0).locator('[data-a="dc-cobrado"]').click();
  await toast(page, 'Cheque cobrado');
  await page.locator('.dc-fila [data-a="dc-rechazado"]').first().click();
  await toast(page, 'Cheque rechazado');
  assert.equal(sql(`select string_agg(c->>'estado', ',' order by (c->>'importe')::numeric) from public.descuentos_cheques, jsonb_array_elements(cheques) c`), 'cobrado,rechazado');
  assert.match(await page.textContent('#crDescuento'), /No hay cheques por cobrar/);
  await page.click('.rf-casos summary');
  assert.equal(await page.locator('[data-a="dc-denunciado"]').count(), 1, 'tiene banco del BCRA y número: se puede consultar si está denunciado');
  await page.click('[data-a="dc-cartera"]');
  await toast(page, 'volvió a la cartera');
  assert.equal(await page.locator('.dc-fila').count(), 1);
});

test('operaciones: la lista abre la operación para editarla; eliminar pide confirmación', async () => {
  await page.click('[data-a="dc-sub"][data-sub="operaciones"]');
  assert.match(norm(await page.textContent('#crDescuento')), /Pérez Juan.*2 cheques · 1 en cartera.*\$ 1\.426\.000/);
  await page.click('.cr-fila[data-a="dc-abrir"]');
  assert.equal(await page.inputValue('#dc_cliente'), 'Pérez Juan');
  assert.match(await page.textContent('.dc-cheque'), /En cartera|Cheque 1/);
  await page.fill('#dc_notas', 'Entregó en ventanilla');
  await page.click('[data-a="dc-guardar"]');
  await toast(page, 'Cambios guardados');
  assert.equal(sql('select notas from public.descuentos_cheques'), 'Entregó en ventanilla');
  // Una operación nueva arranca con las condiciones de la última.
  await page.click('[data-a="dc-nueva"]');
  assert.equal(await page.inputValue('#dc_tasa'), '4');
  assert.equal(await page.inputValue('#dc_sellado'), '1,2');
  assert.equal(await page.inputValue('#dc_cliente'), '');
  await page.click('[data-a="dc-sub"][data-sub="operaciones"]');
  await page.click('.cr-fila[data-a="dc-abrir"]');
  const bajas = () => +sql(`select count(*) from gestor.cambios where tabla = 'descuentos_cheques' and operacion = 'baja'`), antes = bajas();
  await page.click('[data-a="dc-confirmar"]');
  await page.click('[data-a="dc-borrar"]');
  await toast(page, 'Operación eliminada');
  assert.equal(sql('select count(*) from public.descuentos_cheques'), '0');
  assert.equal(bajas(), antes + 1, 'queda en el historial de cambios (se puede deshacer)');
});

test('sin datos completos no se guarda y se dice qué falta', async () => {
  await page.click('[data-a="dc-sub"][data-sub="liquidar"]');
  await page.fill('#dc_cheques_0_importe', '1000');
  assert.match(await page.textContent('#dcResultado'), /Falta el nombre del cliente/);
  await page.click('[data-a="dc-guardar"]');
  await toast(page, 'Falta el nombre del cliente');
  assert.equal(sql('select count(*) from public.descuentos_cheques'), '0');
});

test('celular: todo entra a lo ancho', async () => {
  const p = await nuevaPagina({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await p.fill('#dc_cheques_0_importe', '250.000');
  await p.fill('[data-k="cred.dc.f.cheques.0.vence"]', enDias(15));
  const ancho = await p.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(ancho <= 390, `la página mide ${ancho}px`);
  await p.context().close();
});

test('banco: al escribir se despliega la lista debajo del campo y al tocar uno queda elegido con su código', async () => {
  await page.click('[data-a="dc-sub"][data-sub="liquidar"]');
  await page.click('[data-a="dc-limpiar"]');
  await page.fill('#dc_banco_0', 'cordoba');
  await page.waitForSelector('#dcSug0:not([hidden])');
  const ops = await page.locator('#dcSug0 .dc-sug-op').allTextContents();
  assert.deepEqual(ops, ['BANCO DE LA PROVINCIA DE CORDOBA S.A.']);
  await page.fill('#dc_banco_0', 'banco');
  assert.equal(await page.locator('#dcSug0 .dc-sug-op').count(), 2);
  await page.locator('#dcSug0 .dc-sug-op', { hasText: 'CORDOBA' }).click();
  assert.equal(await page.inputValue('#dc_banco_0'), 'BANCO DE LA PROVINCIA DE CORDOBA S.A.');
  assert.equal(await page.isHidden('#dcSug0'), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'dc_cheques_0_numero', 'sigue en el N° de cheque');
  await page.fill('#dc_cliente', 'Prueba'); await page.fill('#dc_cheques_0_importe', '1000'); await page.fill('[data-k="cred.dc.f.cheques.0.vence"]', enDias(10));
  await page.click('[data-a="dc-guardar"]');
  await toast(page, 'Operación guardada');
  assert.equal(sql(`select cheques->0->>'entidad' from public.descuentos_cheques where cliente = 'Prueba'`), '20');
});

test('sin errores en la consola', () => { assert.deepEqual(errores, []); });

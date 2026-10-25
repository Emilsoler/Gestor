// La app Prenda de punta a punta, en un navegador real: ingreso, mapa, la barrera del
// consentimiento y una consulta de ubicación que queda en la bitácora. Usa el stack local
// (dev/stack.sh up) y la app servida (dev/serve.mjs) en http://127.0.0.1:8080/prenda/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { servicio, entrar, crearCuenta, sql } from './helpers.mjs';

const BASE = (process.env.BASE || 'http://127.0.0.1:8080/') + 'prenda/';
const EMAIL = 'prenda.app@test', CLAVE = 'Clave-de-prueba-2026';
let browser, ctx, page;

const VEH = [
  { dominio: 'MORA11AA', marca: 'Fiat', modelo: 'Cronos', anio: 2021, deudor: 'Lucía Benítez', operacion: '0412', situacion: 'mora',
    consentimiento: { fecha: '2025-11-04', version: 'v1.0', archivo: '', informado: true, copia: true }, sim: { modo: 'quieto', pos: [-32.6352, -62.6795] } },
  { dominio: 'SINCON22', marca: 'Peugeot', modelo: '208', anio: 2023, deudor: 'Ramiro Ledesma', operacion: '0431', situacion: 'al_dia',
    consentimiento: null, sim: { modo: 'quieto', pos: [-32.6241, -62.6731] } },
];

before(async () => {
  sql(`delete from public.ubicaciones; delete from public.vehiculos;
       update public.ajustes_prenda set politica='mora', zona_km=20 where id=1;`);
  await crearCuenta(EMAIL, CLAVE, 'Emi').catch(() => {});
  const svc = servicio();
  await svc.from('vehiculos').insert(VEH.map((v) => ({ expte: '', equipo: 'Teltonika FMC920', notas: '', dni: '', telefono: '', imei: '', instalado: null, zona_km: 0, traccar_id: '', ...v })));
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 1200, height: 820 }, locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba' });
  page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForSelector('#vIngreso:not([hidden])');
  await page.fill('#i_email', EMAIL); await page.fill('#i_clave', CLAVE);
  await page.click('#fIngreso button[type=submit]');
  await page.waitForSelector('#vApp:not([hidden])', { timeout: 15000 });
});
after(async () => { await browser?.close(); sql(`delete from public.ubicaciones; delete from public.vehiculos;`); });

test('el mapa se dibuja', async () => {
  await page.click('#v_mapa');
  await page.waitForSelector('#mapaCanvas .mapa-svg');
  assert.ok(await page.$('.mapa-svg .m-road'), 'hay rutas dibujadas');
});

test('sin consentimiento la ubicación queda oculta; al registrarlo, aparece', async () => {
  await page.click('#v_vehiculos');
  await page.waitForSelector('.vlist');
  await page.click('button.vrow:has-text("SINCON22")');
  await page.waitForSelector('.dr-pane');
  assert.ok(await page.$('.card.punteada .lock'), 'muestra el candado de "falta consentimiento"');
  await page.click('.dr-body [data-act=consent]');
  await page.waitForSelector('#fCon');
  await page.check('#cInfo'); await page.check('#cCopia');
  await page.click('#fCon button[type=submit]');
  await page.waitForSelector('.dr-pane .donde-big', { timeout: 8000 });
  const txt = await page.textContent('.dr-pane');
  assert.ok(/Zona aproximada|Última posición/.test(txt), 'ya se ve la ubicación (zona, por estar al día)');
});

test('ubicar un vehículo en mora queda registrado en la bitácora', async () => {
  await page.click('[data-cerrar]'); // cerrar ficha
  await page.click('#v_vehiculos');
  await page.waitForSelector('.vlist');
  await page.click('button.vrow:has-text("MORA11AA")');
  await page.waitForSelector('.dr-pane [data-act=locate]');
  await page.click('.dr-pane [data-act=locate]');
  await page.waitForSelector('#fMot');
  await page.click('#fMot button[type=submit]'); // motivo por defecto ya marcado (mora)
  await page.waitForSelector('#toast:not([hidden])', { timeout: 10000 });
  await page.click('[data-cerrar]');
  await page.click('#v_bitacora');
  await page.waitForSelector('.loglist');
  const txt = await page.textContent('.loglist');
  assert.ok(txt.includes('MORA11AA'), 'la consulta figura en la bitácora');
  assert.ok(txt.includes('Control de la garantía por mora'), 'con su motivo');
});

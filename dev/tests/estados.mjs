// Capturas de los estados que no se ven en un recorrido normal: error de ingreso,
// aviso de cambio hecho por Claude, choque al guardar, sin conexión y filtros del celular.
//   node tests/estados.mjs <email> <clave> [carpeta]     (la cuenta ya debe tener clave definitiva)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { sql, env } from './helpers.mjs';

const [email, clave, dir = '/tmp/gestor-estados'] = process.argv.slice(2);
const BASE = process.env.BASE || 'http://127.0.0.1:8080/';
mkdirSync(dir, { recursive: true });
const caido = (v) => fetch(`${env.SUPABASE_URL}/__caido`, { method: 'POST', body: JSON.stringify({ caido: v }) });

const browser = await chromium.launch();
const abrir = async (viewport, extra = {}) => {
  const ctx = await browser.newContext({ viewport, locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', ...extra });
  return { ctx, page: await ctx.newPage() };
};
const ingresar = async (page) => {
  await page.goto(BASE); await page.waitForSelector('#fIngreso');
  await page.fill('#i_email', email); await page.fill('#i_clave', clave);
  await page.click('#fIngreso button[type=submit]');
  await page.waitForSelector('#main .tablebox, #main .filas');
};

{ // error de ingreso
  const { ctx, page } = await abrir({ width: 1280, height: 720 });
  await page.goto(BASE); await page.waitForSelector('#fIngreso');
  await page.fill('#i_email', email); await page.fill('#i_clave', 'equivocada');
  await page.click('#fIngreso button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#i_error').hidden);
  await page.screenshot({ path: `${dir}/1-ingreso-error.png` });
  await ctx.close();
}
{ // aviso de cambio externo y choque al guardar
  const { ctx, page } = await abrir({ width: 1280, height: 820 });
  await ingresar(page);
  const expte = await page.locator('#main tbody tr').first().getAttribute('data-id');
  await page.click(`#main tr[data-id="${expte}"] td.car`); await page.waitForSelector('.panel');
  await page.fill('#c_notas', 'una nota mía');
  sql(`select gestor.presentacion('${expte}', 'Solicita aprobación de liquidación')`);
  await page.waitForSelector('#nota .nota', { timeout: 10000 });
  await page.evaluate(() => { document.querySelector('.panel').scrollTop = 0; });
  await page.screenshot({ path: `${dir}/2-aviso-cambio-claude.png` });
  await page.click('.ppie [data-act=save]'); await page.waitForSelector('#nota .nota.choque');
  await page.screenshot({ path: `${dir}/3-choque-al-guardar.png` });
  await page.click('[data-act=choque-ver]'); await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/4-version-actual.png` });
  await page.keyboard.press('Escape');
  // sin conexión
  await caido(true);
  await page.waitForSelector('#franja .franja', { timeout: 15000 });
  await page.screenshot({ path: `${dir}/5-sin-conexion.png` });
  await caido(false);
  sql(`select gestor.deshacer((select max(id) from gestor.cambios where tabla='causas' and clave='${expte}'))`);
  await ctx.close();
}
{ // celular: filtros abiertos y ficha con aviso
  const { ctx, page } = await abrir({ width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ingresar(page);
  await page.tap('#btnFiltros'); await page.selectOption('#fEstado', 'Casillero'); await page.waitForTimeout(150);
  await page.screenshot({ path: `${dir}/6-cel-filtros.png` });
  await page.tap('#vTablero'); await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/7-cel-tablero.png` });
  await ctx.close();
}
await browser.close();
console.log('capturas en', dir);

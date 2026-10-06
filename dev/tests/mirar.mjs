// Recorre la app en un navegador real y guarda capturas para revisarla a ojo.
//   node tests/mirar.mjs <email> <clave> [carpeta]
// Si la clave es temporal, define `Clave-de-prueba-2026` como definitiva.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [email, clave, dir = '/tmp/gestor-capturas'] = process.argv.slice(2);
const BASE = process.env.BASE || 'http://127.0.0.1:8080/';
const NUEVA = 'Clave-de-prueba-2026';
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch();
const errores = [];

async function sesion(nombre, viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', ...extra });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errores.push(`[${nombre}] ${m.text()}`); });
  page.on('pageerror', (e) => errores.push(`[${nombre}] ${e.message}`));
  const foto = (n, opts = {}) => page.screenshot({ path: `${dir}/${nombre}-${n}.png`, ...opts });
  return { ctx, page, foto };
}

async function ingresar(page, foto) {
  await page.goto(BASE);
  await page.waitForSelector('#fIngreso');
  await foto('01-ingreso');
  await page.fill('#i_email', email);
  await page.fill('#i_clave', clave);
  await page.click('#fIngreso button[type=submit]');
  await page.waitForSelector('#fClave, #vApp:not([hidden])');
  if (await page.$('#fClave')) {
    await foto('02-clave-temporal');
    await page.fill('#n_clave', NUEVA); await page.fill('#n_clave2', NUEVA);
    await page.click('#fClave button[type=submit]');
  }
  await page.waitForSelector('#main .tablebox, #main .filas, #main .board, #main .empty');
}

// Escritorio
{
  const { ctx, page, foto } = await sesion('pc', { width: 1280, height: 820 });
  await ingresar(page, foto);
  await page.waitForTimeout(400);
  await foto('03-lista');
  await foto('03-lista-completa', { fullPage: true });
  await page.click('#vTablero'); await page.waitForTimeout(200); await foto('04-tablero');
  await page.click('#vAcuerdos'); await page.waitForTimeout(200); await foto('05-acuerdos');
  await page.click('#vLista');
  await page.click('#main tbody tr >> nth=0'); await page.waitForSelector('.panel'); await page.waitForTimeout(300);
  await foto('06-ficha');
  await page.evaluate(() => { document.querySelector('.panel').scrollTop = 99999; }); await page.waitForTimeout(150);
  await foto('07-ficha-final');
  await page.keyboard.press('Escape');
  await page.click('#btnTpl'); await page.waitForSelector('.panel'); await page.waitForTimeout(200); await foto('08-plantillas');
  await page.keyboard.press('Escape');
  await page.click('#btnCuenta'); await page.waitForSelector('.menu'); await foto('09-menu');
  await ctx.close();
}

// Celular (ya con la clave definitiva)
{
  const { ctx, page, foto } = await sesion('cel', { width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(BASE);
  await page.waitForSelector('#fIngreso');
  await foto('01-ingreso');
  await page.fill('#i_email', email); await page.fill('#i_clave', NUEVA);
  await page.click('#fIngreso button[type=submit]');
  await page.waitForSelector('#main .filas');
  await page.waitForTimeout(400);
  await foto('03-lista');
  await page.click('#vTablero'); await page.waitForTimeout(200); await foto('04-tablero');
  await page.click('#vAcuerdos'); await page.waitForTimeout(200); await foto('05-acuerdos');
  await page.click('#vLista');
  await page.click('#main .fila >> nth=0'); await page.waitForSelector('.panel'); await page.waitForTimeout(300);
  await foto('06-ficha');
  await page.evaluate(() => { document.querySelector('.panel').scrollTop = 700; }); await page.waitForTimeout(150);
  await foto('07-ficha-medio');
  await page.keyboard.press('Escape');
  await page.click('#btnCuenta'); await page.waitForSelector('.menu'); await foto('09-menu');
  await ctx.close();
}

// Modo oscuro, escritorio
{
  const { ctx, page, foto } = await sesion('oscuro', { width: 1280, height: 820 }, { colorScheme: 'dark' });
  await page.goto(BASE);
  await page.waitForSelector('#fIngreso');
  await foto('01-ingreso');
  await page.fill('#i_email', email); await page.fill('#i_clave', NUEVA);
  await page.click('#fIngreso button[type=submit]');
  await page.waitForSelector('#main .tablebox');
  await page.waitForTimeout(400);
  await foto('03-lista');
  await ctx.close();
}

await browser.close();
console.log(errores.length ? 'ERRORES EN CONSOLA:\n' + errores.join('\n') : 'sin errores en consola');
console.log('capturas en', dir);

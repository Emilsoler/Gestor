// El certificado de ARCA (menú de la cuenta → «Certificado de ARCA»): la app de cobranzas arma en el
// navegador la clave y la solicitud (.csr). Se bajan los dos archivos y OpenSSL los revisa: la firma, el
// sujeto que pide ARCA y que la clave sea la de la solicitud. También: que la clave no quede guardada en
// el dispositivo y que se olvide al cerrar el panel.
// Requiere `dev/stack.sh up` y `node dev/serve.mjs` (la app en http://127.0.0.1:8080/cobranzas/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { crearCuenta, limpiar, sql } from './helpers.mjs';
import { PERSONAS_ARCA } from './casos-bcra.mjs';

const BASE = (process.env.BASE || 'http://127.0.0.1:8080/') + 'cobranzas/';
const EMAIL = 'arca-app@test.local', CLAVE = 'Clave-arca-app-2026';
const ARCA = 'http://127.0.0.1:54343';
const sinArca = () => sql(`update gestor.arca set certificado = '', ticket = null`);
const ssl = (...args) => execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let browser, dir;
const errores = [];

async function nuevaPagina(opciones = {}) {
  const c = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', viewport: { width: 1366, height: 900 }, acceptDownloads: true, ...opciones });
  const p = await c.newPage();
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|realtime|Failed to load resource/i.test(m.text())) errores.push(m.text()); });
  p.on('pageerror', (e) => errores.push(e.message));
  await p.goto(BASE);
  await p.waitForSelector('#fIngreso');
  await p.fill('#i_email', EMAIL); await p.fill('#i_clave', CLAVE);
  await p.click('#fIngreso button[type=submit]');
  await p.waitForSelector('#vApp:not([hidden])');
  return { c, p };
}
const toast = (p, texto) => p.waitForFunction((t) => { const e = document.querySelector('#toast'); return e && !e.hidden && e.textContent.includes(t); }, texto, { timeout: 8000 });
async function abrir(p) {
  await p.click('#btnCuenta');
  await p.click('[data-m="arca"]');
  await p.waitForSelector('#fArca');
}
async function bajar(p, sel) {
  const [d] = await Promise.all([p.waitForEvent('download'), p.click(sel)]);
  const ruta = join(dir, d.suggestedFilename());
  await d.saveAs(ruta);
  return { nombre: d.suggestedFilename(), ruta };
}

before(async () => {
  limpiar();
  await crearCuenta(EMAIL, CLAVE, 'Emi');
  dir = mkdtempSync(join(tmpdir(), 'arca-'));
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

test('con un dato que no sirve no se genera nada', async () => {
  const { c, p } = await nuevaPagina();
  await abrir(p);
  assert.equal(await p.inputValue('#arca_alias'), 'CobranzasSoler');
  await p.fill('#arca_cuit', '20-11111111-3');
  assert.match(await p.textContent('#arca_aviso'), /no existe/);
  await p.fill('#arca_nombre', 'Persona de Prueba');
  await p.click('#arca_ir');
  await toast(p, 'Ese CUIT no existe');
  await p.fill('#arca_cuit', '20-11111111-2');
  assert.equal(await p.textContent('#arca_aviso'), '20-11111111-2');
  await p.fill('#arca_alias', 'Con espacio');
  await p.click('#arca_ir');
  await toast(p, 'solo con letras y números');
  await p.fill('#arca_alias', 'CobranzasSoler');
  await p.fill('#arca_nombre', '   ');
  await p.click('#arca_ir');
  await toast(p, 'Escribí el nombre');
  assert.equal(await p.locator('[data-a="arca-csr"]').count(), 0);
  await c.close();
});

test('arma la solicitud y la clave en el navegador, y OpenSSL las da por buenas', async () => {
  const { c, p } = await nuevaPagina();
  await abrir(p);
  await p.fill('#arca_cuit', '20111111112');
  await p.fill('#arca_nombre', 'Persona de Prueba Ñandú');
  await p.click('#arca_ir');
  await p.waitForSelector('[data-a="arca-csr"]');
  assert.equal(await p.isDisabled('#arca_cuit'), true, 'una vez generados, los datos quedan fijos');
  const csr = await bajar(p, '[data-a="arca-csr"]');
  assert.equal(csr.nombre, 'CobranzasSoler.csr');
  await toast(p, 'Solicitud descargada');
  const key = await bajar(p, '[data-a="arca-clave"]');
  assert.equal(key.nombre, 'CobranzasSoler.key');

  // Lo que pide ARCA: firma válida, sujeto C, O, CN y serialNumber, RSA de 2048 y SHA-256.
  const r = spawnSync('openssl', ['req', '-in', csr.ruta, '-noout', '-verify', '-subject', '-nameopt', 'RFC2253,-esc_msb'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /verify OK/);
  assert.match(r.stdout, /subject=serialNumber=CUIT 20111111112,CN=CobranzasSoler,O=Persona de Prueba Ñandú,C=AR/);
  const texto = ssl('req', '-in', csr.ruta, '-noout', '-text');
  assert.match(texto, /Public-Key: \(2048 bit\)/);
  assert.match(texto, /Signature Algorithm: sha256WithRSAEncryption/);
  // La clave es la de la solicitud.
  assert.match(readFileSync(key.ruta, 'utf8'), /^-----BEGIN PRIVATE KEY-----\n/);
  assert.equal(ssl('pkey', '-in', key.ruta, '-pubout'), ssl('req', '-in', csr.ruta, '-noout', '-pubkey'));

  // Con los dos archivos bajados, el panel dice qué hacer en ARCA.
  assert.match(await p.textContent('.panel'), /«Agregar alias» → alias CobranzasSoler → elegí el archivo CobranzasSoler\.csr/);
  // La clave no queda en el dispositivo.
  const guardado = await p.evaluate(() => [localStorage, sessionStorage].flatMap((s) => Object.keys(s).map((k) => s.getItem(k))).join('\n'));
  const cuerpo = readFileSync(key.ruta, 'utf8').split('\n')[1];
  assert.ok(!guardado.includes('PRIVATE KEY') && !guardado.includes(cuerpo.slice(0, 40)), 'la clave no está en el almacenamiento del navegador');
  // Al cerrar el panel se olvida: abierto de nuevo, está vacío.
  await p.keyboard.press('Escape');
  await abrir(p);
  assert.equal(await p.locator('[data-a="arca-csr"]').count(), 0);
  assert.equal(await p.inputValue('#arca_cuit'), '');
  await c.close();
});

test('celular: el panel entra a lo ancho', async () => {
  const { c, p } = await nuevaPagina({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await abrir(p);
  await p.fill('#arca_cuit', '20111111112');
  await p.fill('#arca_nombre', 'Persona de Prueba');
  await p.click('#arca_ir');
  await p.waitForSelector('[data-a="arca-csr"]');
  const m = await p.evaluate(() => ({ panel: document.querySelector('.panel').scrollWidth, ancho: document.querySelector('.panel').clientWidth }));
  assert.ok(m.panel <= m.ancho, `nada se sale de costado (${m.panel} > ${m.ancho})`);
  await c.close();
});

test('probar la conexión con ARCA: sin certificado dice qué falta; con el certificado, «Conectado»', async () => {
  sinArca();
  await fetch(`${ARCA}/__pedidos`, { method: 'DELETE' });
  await fetch(`${ARCA}/__casos`, { method: 'POST', body: JSON.stringify({ personas: PERSONAS_ARCA }) });
  const { c, p } = await nuevaPagina();
  await abrir(p);
  await p.click('[data-a="arca-probar"]');
  await p.waitForSelector('.panel .aviso-chico[role=alert]');
  assert.match(await p.textContent('.panel .aviso-chico[role=alert]'), /certificado de ARCA/);
  sql(`select gestor.arca_certificado($c$${readFileSync(`${process.env.STACK || '/home/claude/.stack'}/arca-prueba.crt`, 'utf8')}$c$)`);
  await p.click('[data-a="arca-probar"]');
  await p.waitForSelector('.panel .nota >> text=Conectado');
  const t = (await p.textContent('.panel .nota')).replace(/\s+/g, ' ');
  assert.match(t, /Conectado\. ARCA respondió con los datos de VERDE PERSONA \(CUIT 20-11111111-2\)\./);
  assert.match(t, /Certificado CobranzasPrueba, vence el \d\d\/\d\d\/\d{4}\./);
  assert.equal(await p.locator('.panel .aviso-chico[role=alert]').count(), 0);
  sinArca();
  await c.close();
});

test('sin errores en la consola', () => {
  assert.deepEqual(errores, []);
});

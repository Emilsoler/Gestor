// La vista "Créditos" de la app de cobranzas de punta a punta, en un navegador real contra la base local,
// la función `bcra` y el BCRA falso (casos inventados de casos-bcra.mjs).
// Requiere `dev/stack.sh up` y `node dev/serve.mjs` (la app en http://127.0.0.1:8080/cobranzas/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { sql, crearCuenta, limpiar } from './helpers.mjs';
import { CUIT, CASOS } from './casos-bcra.mjs';

const BASE = (process.env.BASE || 'http://127.0.0.1:8080/') + 'cobranzas/';
const EMAIL = 'creditos-app@test.local', CLAVE = 'Clave-creditos-app-2026';
const FALSO = 'http://127.0.0.1:54341';
// Los importes llevan espacio duro ("$\u00a01.500") y las celdas saltos de rengl\u00f3n: para comparar, espacios comunes.
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ');
const cuantas = () => +sql('select count(*) from public.consultas_bcra');

let browser, page;
const errores = [];
function vigilar(p, nombre) {
  p.on('console', (m) => {
    // Las respuestas de error que las pruebas provocan a propósito (404, 502) el navegador las anota solo.
    if (m.type() === 'error' && !/WebSocket|realtime|Failed to load resource/i.test(m.text())) errores.push(`[${nombre}] ${m.text()}`);
  });
  p.on('pageerror', (e) => errores.push(`[${nombre}] ${e.message}`));
}
async function nuevaPagina(opciones = {}) {
  const c = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', viewport: { width: 1366, height: 900 }, ...opciones });
  const p = await c.newPage();
  vigilar(p, opciones.nombre || 'pc');
  return { c, p };
}
async function ingresar(p) {
  await p.goto(BASE);
  await p.waitForSelector('#fIngreso');
  await p.fill('#i_email', EMAIL); await p.fill('#i_clave', CLAVE);
  await p.click('#fIngreso button[type=submit]');
  await p.waitForSelector('#vApp:not([hidden])');
}
const toast = (p, texto) => p.waitForFunction((t) => { const e = document.querySelector('#toast'); return e && !e.hidden && e.textContent.includes(t); }, texto, { timeout: 8000 });
async function consultar(p, cuit) {
  await p.fill('#cr_cuit', cuit);
  await p.click('#cr_ir');
  await p.waitForFunction(() => !document.querySelector('#cr_ir')?.textContent.includes('Consultando'), null, { timeout: 15000 });
}

before(async () => {
  limpiar();
  sql('delete from public.consultas_bcra; delete from public.deudores;');
  await fetch(`${FALSO}/__pedidos`, { method: 'DELETE' });
  await fetch(`${FALSO}/__casos`, { method: 'POST', body: JSON.stringify(CASOS) });
  await crearCuenta(EMAIL, CLAVE, 'Emi');
  // Un deudor de Cobranzas cuyo DNI está dentro de uno de los CUIT (27-22222222-8).
  sql(`begin; select set_config('gestor.autor', 'Semilla', true);
    insert into public.deudores (nombre, dni, socio, estado) values ('GOMEZ MARIA ESTHER', '22.222.222', '555', 'En gestión');
    commit;`);
  browser = await chromium.launch();
  ({ p: page } = await nuevaPagina());
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
  await ingresar(page);
});
after(async () => { await browser?.close(); });

test('la vista: CUIT mal escrito, CUIT bien escrito y nada guardado todavía', async () => {
  await page.click('#v_creditos');
  await page.waitForSelector('.creditos');
  assert.equal(await page.textContent('#tVista'), 'Aprobación de créditos');
  assert.match(await page.textContent('.cr-historial'), /Las consultas que hagas quedan acá/);
  assert.equal(await page.locator('#fabNuevo').isHidden(), true);
  // Mientras se escribe: cuántos faltan, si no existe y, si está bien, con guiones.
  await page.fill('#cr_cuit', '2012345');
  assert.match(await page.textContent('#cr_aviso'), /Faltan 4 números/);
  assert.equal(await page.isDisabled('#cr_ir'), true);
  await page.fill('#cr_cuit', '20-12345678-9');
  assert.match(await page.textContent('#cr_aviso'), /no existe/);
  assert.equal(await page.isDisabled('#cr_ir'), true);
  await page.fill('#cr_cuit', '20123456786');
  assert.equal(await page.textContent('#cr_aviso'), '20-12345678-6');
  assert.equal(await page.isDisabled('#cr_ir'), false);
  await page.fill('#cr_cuit', '');
});

test('rojo: semáforo, motivos, deudas con sus marcas, 24 meses y cheques', async () => {
  await consultar(page, '20-33333333-4');
  await toast(page, 'Consulta guardada');
  await page.waitForSelector('.cr-resultado .historia');
  const r = norm(await page.textContent('.cr-resultado'));
  assert.match(r, /PERSONA ROJA/);
  assert.match(r, /20-33333333-4/);
  assert.match(await page.textContent('.cr-luz'), /Rojo/);
  const motivos = await page.locator('.motivos li').allTextContents();
  assert.deepEqual(motivos.slice(0, 3), ['Situación 4 en BANCO SANTANDER ARGENTINA S.A.', '1 cheque rechazado sin pagar', '1 cheque rechazado, ya pagado']);
  assert.match(motivos[3], /^En los últimos 24 meses llegó a situación 5 \(\d\d\/\d{4}\)$/);
  assert.equal(motivos.length, 4);
  assert.match(r, /Deuda informada\s*\$ 1\.210\.000/);
  assert.match(r, /4 · Riesgo alto/);
  // Deudas: de peor a mejor, con sus marcas; el nombre que manda el BCRA se muestra como texto.
  const filas = await page.locator('.cr-entidades tbody tr').allTextContents();
  assert.equal(filas.length, 2);
  assert.match(norm(filas[0]), /BANCO SANTANDER ARGENTINA S\.A\..*250 días de atraso.*En proceso judicial.*4 · Riesgo alto.*\$ 1\.200\.000/);
  assert.match(norm(filas[1]), /<b>FINANCIERA<\/b> "X".*1 · Normal.*\$ 10\.000/);
  // 24 meses: una fila, 24 celdas, cada una con su número.
  const celdas = await page.locator('.historia tbody tr td').allTextContents();
  assert.equal(celdas.length, 24);
  assert.ok(celdas.every((c) => /^[1-5]$/.test(c)), celdas.join(','));
  assert.equal(await page.locator('.historia td.h5').count(), 1);
  assert.equal(await page.locator('.historia td.h4').count(), 8);
  assert.match(await page.locator('.historia td.h5').getAttribute('title'), /Situación 5 \(irrecuperable\)/);
  // Cheques: el más nuevo primero; el pagado, apagado.
  const cheques = await page.locator('.cr-cheques tbody tr').allTextContents();
  assert.equal(cheques.length, 2);
  assert.match(norm(cheques[0]), /10\/08\/2026.*87654321.*SIN FONDOS.*\$ 500\.000.*Sin pagar.*multa impaga/);
  assert.match(norm(cheques[1]), /01\/02\/2026.*Pagado el 15\/02\/2026/);
  // Quedó en el historial y se vació el CUIT para la próxima.
  assert.equal(await page.locator('.cr-fila').count(), 1);
  assert.equal(await page.inputValue('#cr_cuit'), '');
  assert.equal(cuantas(), 1);
});

test('amarillo y ya figura en Cobranzas: se abre su ficha', async () => {
  await consultar(page, CUIT.amarillo);
  await page.waitForSelector('.cr-resultado .nota.choque');
  assert.match(await page.textContent('.cr-luz'), /Amarillo/);
  assert.match(norm(await page.textContent('.nota.choque')), /Ya figura en Cobranzas\.\s*Gomez Maria Esther · En gestión/);
  assert.match(norm(await page.textContent('.cr-entidades')), /Refinanciada/);
  await page.click('.nota.choque [data-abrir]');
  await page.waitForSelector('.panel.ficha');
  assert.match(await page.textContent('.panel.ficha h2'), /Gomez Maria Esther/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#drawer', { state: 'hidden' });
  assert.equal(await page.locator('.cr-fila').count(), 2);
  assert.match(await page.locator('.cr-fila').first().textContent(), /PERSONA AMARILLA/, 'la más nueva arriba');
});

test('sin deudas: aviso de que el BCRA no devuelve el nombre', async () => {
  await consultar(page, CUIT.nada);
  await page.waitForSelector('.cr-resultado .aviso-chico');
  assert.match(await page.textContent('.cr-luz'), /Sin deudas/);
  assert.match(await page.textContent('.cr-resultado'), /confirmá que el CUIT sea el de la persona/);
  assert.match(await page.textContent('.cr-resultado h3'), /Sin nombre informado/);
});

test('si el BCRA falla, se avisa y no se guarda nada', async () => {
  const antes = cuantas();
  await consultar(page, CUIT.caido);
  await page.waitForSelector('.cr-consulta .aviso-chico');
  assert.match(await page.textContent('.cr-consulta .aviso-chico'), /El BCRA respondió con un error/);
  assert.equal(await page.inputValue('#cr_cuit'), CUIT.caido, 'el CUIT queda escrito para reintentar');
  assert.equal(cuantas(), antes);
  // Al corregir el CUIT, el aviso se va.
  await page.fill('#cr_cuit', '2011');
  assert.equal(await page.locator('.cr-consulta .aviso-chico').count(), 0);
  await page.fill('#cr_cuit', '');
});

test('una consulta anterior se abre con su detalle, también después de recargar', async () => {
  await page.reload();
  await page.waitForSelector('.creditos'); // la app recuerda la vista
  await page.waitForSelector('.cr-fila');
  await page.click('.cr-fila:has-text("PERSONA ROJA")');
  await page.waitForSelector('.cr-resultado .historia'); // el detalle se leyó de la base
  assert.match(await page.textContent('.cr-resultado h3'), /PERSONA ROJA/);
  assert.equal(await page.getAttribute('.cr-fila:has-text("PERSONA ROJA")', 'aria-pressed'), 'true');
  await page.click('[data-a="cr-copiar"]');
  await toast(page, 'Copiado');
  const copiado = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copiado, /^Consulta BCRA — Central de Deudores\nPERSONA ROJA · CUIT\/CUIL 20-33333333-4\nSemáforo: Rojo/);
  assert.match(copiado, /• Situación 4 en BANCO SANTANDER ARGENTINA S\.A\./);
});

test('volver a consultar guarda otra constancia; eliminar pide confirmación', async () => {
  const antes = cuantas();
  await page.click('[data-a="cr-repetir"]');
  await toast(page, 'Consulta guardada');
  assert.equal(cuantas(), antes + 1);
  await page.click('[data-a="cr-confirmar"]');
  await page.waitForSelector('.cr-resultado .confirm');
  await page.click('[data-a="cr-no"]');
  assert.equal(await page.locator('.cr-resultado .confirm').count(), 0);
  await page.click('[data-a="cr-confirmar"]');
  await page.click('[data-a="cr-borrar"]');
  await toast(page, 'Consulta eliminada');
  assert.equal(cuantas(), antes);
  assert.equal(await page.locator('.cr-resultado.cr-vacio').count(), 1);
  assert.equal(sql(`select count(*) from gestor.cambios where tabla = 'consultas_bcra' and operacion = 'baja' and autor = 'Emi'`), '1', 'la baja queda en el historial de cambios');
});

test('si la base todavía no tiene la tabla, el resto de la app anda igual', async () => {
  const { c, p } = await nuevaPagina({ nombre: 'sin-tabla' });
  await c.route('**/rest/v1/consultas_bcra*', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.consultas_bcra' in the schema cache" }) }));
  await ingresar(p);
  await p.click('#v_deudores');
  await p.waitForSelector('#main [data-abrir]');
  assert.match(await p.textContent('#main'), /Gomez Maria Esther/);
  await p.click('#v_creditos');
  assert.match(await p.textContent('#main'), /Falta activar la aprobación de créditos/);
  await c.close();
});

test('si la función no está publicada, se avisa en palabras', async () => {
  const { c, p } = await nuevaPagina({ nombre: 'sin-funcion' });
  await c.route('**/functions/v1/bcra', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'NOT_FOUND', message: 'Requested function was not found' }) }));
  await ingresar(p);
  await p.click('#v_creditos');
  await consultar(p, CUIT.verde);
  await p.waitForSelector('.cr-consulta .aviso-chico');
  assert.match(await p.textContent('.cr-consulta .aviso-chico'), /todavía no está activada/);
  await c.close();
});

test('celular: todo entra a lo ancho, las tablas se apilan y los 24 meses arrancan en el más reciente', async () => {
  const { c, p } = await nuevaPagina({ nombre: 'celular', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ingresar(p);
  await p.click('#v_creditos');
  await p.waitForSelector('.cr-fila');
  await p.click('.cr-fila:has-text("PERSONA ROJA")');
  await p.waitForSelector('.cr-resultado .historia');
  const medidas = await p.evaluate(() => {
    const caja = document.querySelector('.historia-caja');
    return {
      doc: document.documentElement.scrollWidth, vista: window.innerWidth,
      alFinal: Math.abs(caja.scrollLeft + caja.clientWidth - caja.scrollWidth) <= 2,
      cabecera: getComputedStyle(document.querySelector('.cr-entidades thead')).display,
      monto: document.querySelector('.cr-entidades .num').getBoundingClientRect().right <= window.innerWidth,
    };
  });
  assert.equal(medidas.doc, medidas.vista, 'nada se sale de costado');
  assert.ok(medidas.alFinal, 'los 24 meses se ven desde el más reciente');
  assert.equal(medidas.cabecera, 'none');
  assert.ok(medidas.monto, 'el monto se ve sin correr la tabla');
  await c.close();
});

test('sin errores en la consola', () => {
  assert.deepEqual(errores, []);
});

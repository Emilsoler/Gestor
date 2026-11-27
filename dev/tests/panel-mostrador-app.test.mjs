// Venta de mostrador y cotización rápida en el panel máster, en un navegador, con una cuenta «solo panel».
// Requiere `dev/stack.sh up` y `node dev/serve.mjs`. Con un Chrome del sistema: CHROME=/usr/bin/google-chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { sql, limpiar, servicio } from './helpers.mjs';
import { CASOS, CUIT } from './casos-bcra.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8080/';
const CORREO = 'maca-app@test.local', CLAVE = 'Master-prueba-2026';
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
let browser;

before(async () => {
  limpiar();
  sql(`delete from public.solicitudes_credito; delete from public.cotizaciones_agencia; delete from public.agencias; delete from public.consultas_bcra; delete from gestor.masters;
       update public.ajustes_agencias set habilitado = true, pct_financiable = 40, redondeo = 50000, plazos = '{12,18,24,36}', tasas = '[]', anio_minimo = null, antiguedad_max = null,
         tasa_mensual = 7, monto_minimo = 0, monto_maximo = null, tope_diario = 300, contacto = '',
         gastos = '{"sellado":1.2,"arancel":0.1,"arancelMin":13000,"contratos":20000,"envio":0,"gestoria":0,"redondeo":null,"seguro":0.1,"administrativos":50,"cuotaSocial":200,"igr":3}';`);
  const { error } = await servicio().auth.admin.createUser({ email: CORREO, password: CLAVE, email_confirm: true });
  if (error && !/already/i.test(error.message)) throw new Error(error.message);
  sql(`select gestor.autorizar_master('${CORREO}', 'Maca App', false)`);
  await fetch('http://127.0.0.1:54341/__casos', { method: 'POST', body: JSON.stringify(CASOS) });
  const exe = process.env.CHROME || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
});
after(async () => { await browser?.close(); });

for (const [nombre, viewport] of [['celular', { width: 390, height: 800 }], ['pc', { width: 1280, height: 900 }]]) {
  test(`mostrador de punta a punta y cotización rápida (${nombre})`, async () => {
    sql('delete from public.solicitudes_credito');
    const c = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', viewport });
    const p = await c.newPage();
    const errores = [], pedidos = [];
    p.on('pageerror', (e) => errores.push(e.message));
    p.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/([a-z_/]+)/); if (m) pedidos.push(m[1]); });
    await p.goto(BASE + 'agencias/master/');
    await p.fill('#i_email', CORREO); await p.fill('#i_clave', CLAVE); await p.click('#fIngreso button[type=submit]');
    await p.click('[data-tab="nuevo"]');

    // 1) BCRA
    await p.fill('[data-k="ag.mos.cuit"]', CUIT.verde);
    await p.click('[data-a="mo-bcra"]');
    await p.waitForSelector('[data-a="mo-otro"]');
    assert.match(norm(await p.textContent('#main')), /PERSONA VERDE/);
    // 2) Vehículo y crédito
    const elegir = async (k, op) => {
      await p.waitForFunction((k) => { const s = document.querySelector(`[data-k="ag.mos.${k}"]`); return s && !s.disabled && s.options.length > 1; }, k);
      await p.selectOption(`[data-k="ag.mos.${k}"]`, op);
    };
    await elegir('marca', { label: 'MARCA UNO' });
    await elegir('modelo', '10');
    await elegir('anio', { index: 1 });
    await elegir('version', { index: 1 });
    await p.selectOption('[data-k="ag.mos.cuotas"]', '24');
    await p.click('[data-a="mo-ver"]');
    await p.waitForSelector('.mo-cuota');
    const usual = norm(await p.textContent('.mo-cuota'));
    assert.equal(await p.locator('.mo-fuera').count(), 0);
    // Fuera de lo habitual: más monto que el máximo y otra tasa → avisa, no impide.
    await p.fill('[data-k="ag.mos.monto"]', '30000000'); await p.press('[data-k="ag.mos.monto"]', 'Tab');
    await p.waitForSelector('.mo-fuera');
    await p.fill('[data-k="ag.mos.tasa"]', '6.5'); await p.press('[data-k="ag.mos.tasa"]', 'Tab');
    await p.waitForFunction(() => document.querySelectorAll('.mo-fuera').length === 2);
    assert.notEqual(norm(await p.textContent('.mo-cuota')), usual);
    // 3) Aprobar sin datos: dice qué falta y no aprueba.
    await p.click('[data-a="mo-aprobar"]');
    assert.match(norm(await p.textContent('#main')), /Antes de aprobar, falta/);
    const poner = (k, v) => p.fill(`[data-k="ag.mos.datos.${k}"]`, v);
    await poner('nacionalidad', 'Argentina'); await poner('nacimiento', '1980-05-10');
    await poner('dom_calle', 'San Martín'); await poner('dom_numero', '450'); await poner('dom_localidad', 'Bell Ville'); await poner('dom_provincia', 'Córdoba');
    await p.selectOption('[data-k="ag.mos.datos.estado_civil"]', 'soltero');
    await poner('celular', '3534123456'); await p.selectOption('[data-k="ag.mos.datos.asociado"]', 'si');
    writeFileSync('/tmp/doc-mostrador.pdf', '%PDF-1.4\n% prueba\n%%EOF\n');
    await p.setInputFiles('#moArchivos', '/tmp/doc-mostrador.pdf');
    await p.waitForSelector('.mo-lista li');
    await p.screenshot({ path: `/tmp/mostrador-${nombre}.png`, fullPage: true });
    await p.click('[data-a="mo-aprobar"]');
    await p.waitForSelector('[data-a="mo-aprobar-si"]');
    await p.click('[data-a="mo-aprobar-si"]');
    await p.waitForSelector('.ag-sol');
    const tarjeta = norm(await p.textContent('.ag-sol'));
    assert.match(tarjeta, /Mutual Bell · mostrador/); assert.match(tarjeta, /Aprobada/); assert.match(tarjeta, /Maca App/); assert.match(tarjeta, /30\.000\.000/);
    assert.match(tarjeta, /Venta en la Mutual: no se cargan ingresos/);
    assert.equal(sql(`select estado || ' ' || monto::bigint || ' ' || tasa::float || ' ' || jsonb_array_length(archivos) || ' ' || (datos->>'dni') from public.solicitudes_credito`), `aprobada 30000000 6.5 1 11111111`);
    // De ahí salen la prenda y los contratos.
    await p.click('[data-a="ag-gen-abrir"][data-tipo="prenda"]');
    await p.waitForSelector('.ag-gen-panel');
    const [bajada] = await Promise.all([
      viewport.width > 720 ? p.waitForEvent('download') : Promise.resolve(null),
      viewport.width > 720 ? p.click('[data-a="ag-gen-pdf"]') : Promise.resolve(),
    ]);
    if (bajada) assert.match(bajada.suggestedFilename(), /\.pdf$|download/);
    await p.screenshot({ path: `/tmp/mostrador-aprobada-${nombre}.png`, fullPage: true });

    // Cotización rápida
    await p.click('[data-tab="rapida"]');
    await p.click('[data-a="mr-calcular"]');
    assert.match(norm(await p.textContent('#main')), /Escribí el capital/);
    await p.fill('[data-k="ag.rap.capital"]', '5.000.000');
    await p.click('[data-a="mr-calcular"]');
    await p.waitForSelector('#mrResultado');
    await p.evaluate(() => { window.__abierto = ''; window.open = (u) => { window.__abierto = u; return null; }; });
    await p.click('[data-a="mr-whatsapp"]');
    const wa = decodeURIComponent(await p.evaluate(() => window.__abierto));
    assert.match(wa, /Monto del crédito: \$\s?5\.000\.000/); assert.match(wa, /36 cuotas de/); assert.doesNotMatch(wa, /Tasa|Total/i);
    await p.screenshot({ path: `/tmp/rapida-${nombre}.png`, fullPage: true });

    // El panel no pide nada de Cobranzas ni del gestor, ni deja copia en el dispositivo.
    assert.deepEqual(pedidos.filter((x) => /deudores|modelos_mensaje|ajustes_cobranzas|consultas_cheques|casos_refi|descuentos|causas|rpc\/mi_acceso/.test(x)), []);
    assert.equal(await p.evaluate(() => localStorage.getItem('cb.cache')), null);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'sin desborde horizontal');
    // En el gestor y en Cobranzas, la misma sesión no entra.
    await p.goto(BASE + 'cobranzas/');
    await p.waitForFunction(() => /no está autorizada/i.test(document.body.innerText));
    await p.goto(BASE);
    await p.waitForFunction(() => /no está autorizada/i.test(document.body.innerText));
    assert.deepEqual(errores, []);
    await c.close();
  });
}

// La administración del cotizador para agencias, en Créditos y Cobros (solapa «Agencias»), en un navegador real:
// una agencia manda una solicitud con documentos por la función `agencias` y la Mutual la ve, abre los documentos
// y la aprueba desde su app, con su sesión de siempre. Y las dos sesiones (cotizador y apps de la Mutual) conviven
// en el mismo navegador.
// Requiere `dev/stack.sh up` y `node dev/serve.mjs` (las apps en http://127.0.0.1:8080/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { sql, crearCuenta, limpiar, entrar, env, servicio } from './helpers.mjs';
import { CUIT, CASOS } from './casos-bcra.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8080/';
const FN = `${env.SUPABASE_URL}/functions/v1/agencias`;
const EMI = 'admin-ag@test.local', CLAVE = 'Clave-admin-ag-2026';
const AG = 'salon-admin@test.local', AG_CLAVE = 'Agencia-admin-2026';
const PDF = (t) => new TextEncoder().encode(`%PDF-1.4\n% ${t}\n%%EOF\n`);
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ');

let browser, idSolicitud;
const errores = [];

async function pedir(jwt, cuerpo) {
  const r = await fetch(FN, { method: 'POST', headers: { apikey: env.ANON_KEY, 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify(cuerpo) });
  return { status: r.status, datos: await r.json() };
}
async function subir(jwt, id, slot, bytes, nombre = slot) {
  const fd = new FormData();
  fd.append('accion', 'archivo'); fd.append('id', id); fd.append('slot', slot); fd.append('archivo', new Blob([bytes]), `${nombre}.pdf`);
  const r = await fetch(FN, { method: 'POST', headers: { apikey: env.ANON_KEY, authorization: `Bearer ${jwt}` }, body: fd });
  assert.equal(r.status, 200, await r.text());
}
async function pagina(nombre, viewport = { width: 1366, height: 900 }, contexto = null) {
  const c = contexto || await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', viewport });
  const p = await c.newPage();
  p.on('pageerror', (e) => errores.push(`[${nombre}] ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|realtime|Failed to load resource/i.test(m.text())) errores.push(`[${nombre}] ${m.text()}`); });
  return p;
}
async function ingresarCobranzas(p) {
  await p.goto(BASE + 'cobranzas/');
  await p.waitForSelector('#fIngreso');
  await p.fill('#i_email', EMI); await p.fill('#i_clave', CLAVE);
  await p.click('#fIngreso button[type=submit]');
  await p.waitForSelector('#vApp:not([hidden])');
}
const toast = (p, texto) => p.waitForFunction((t) => { const e = document.querySelector('#toast'); return e && !e.hidden && e.textContent.includes(t); }, texto, { timeout: 8000 });

before(async () => {
  limpiar();
  sql(`delete from public.solicitudes_credito; delete from public.cotizaciones_agencia; delete from public.agencias; delete from public.consultas_bcra;
       update public.ajustes_agencias set habilitado = true, pct_financiable = 40, anio_minimo = 2014, antiguedad_max = null, relacion_max = 45,
         plazos = (select array_agg(g) from generate_series(1, 24) g), redondeo = 50000, tope_diario = 300, monto_minimo = 0, monto_maximo = null,
         tasas = '[{"desde":2021,"tasa":5},{"desde":2018,"tasa":6},{"desde":2014,"tasa":7}]'`);
  await fetch('http://127.0.0.1:54344/__objetos', { method: 'DELETE' });
  await fetch('http://127.0.0.1:54341/__casos', { method: 'POST', body: JSON.stringify(CASOS) });
  await crearCuenta(EMI, CLAVE, 'Emi');
  const { error } = await servicio().auth.admin.createUser({ email: AG, password: AG_CLAVE, email_confirm: true });
  assert.ifError(error);
  sql(`select gestor.autorizar_agencia('${AG}', 'Salón Prueba', gestor.hoy()); update public.agencias set clave_temporal = false`);

  // La agencia manda una solicitud completa (amarillo: sujeta a revisión), con sus documentos.
  const jwt = (await entrar(AG, AG_CLAVE)).sesion.access_token;
  const consulta = (await pedir(jwt, { accion: 'bcra', cuit: CUIT.amarillo })).datos.consulta;
  const ref = (await pedir(jwt, { accion: 'versiones', marca: 1, grupo: 10 })).datos.versiones[0].ref;
  const r = await pedir(jwt, {
    accion: 'solicitar', consulta, ref, anio: '2024', cuotas: 24, vehiculo: 'MARCA UNO SEDAN 1.6', ingresos: true, ingreso: 4_000_000, categoria: 'dependencia',
    consentimiento: true, datos: { dni: '22222222', domicilio: 'Bv. Colón 135, Bell Ville', estado_civil: 'soltero', celular: '3534 123456', cbu: '2850590940090418135201', cuenta: 'terceros', cuenta_titular: 'Autos del Sur SA', cuenta_cuit: '30444444440' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  idSolicitud = r.datos.id;
  // Desde el 20/11/2026 los documentos van todos juntos, en un solo casillero.
  for (const nombre of ['recibos', 'dni', 'titulo', 'servicio', 'cbu']) await subir(jwt, idSolicitud, 'documentacion', PDF(nombre), nombre);
  assert.equal((await pedir(jwt, { accion: 'enviar', id: idSolicitud })).status, 200);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); });

test('Créditos y Cobros: la solapa Agencias avisa, muestra la solicitud con sus documentos y la Mutual la aprueba', async () => {
  const p = await pagina('pc');
  await ingresarCobranzas(p);
  // Aviso en la solapa y en Inicio.
  await p.click('#v_inicio');
  await p.waitForSelector('#nAgencias:not([hidden])', { timeout: 10000 });
  await p.waitForSelector('.ag-aviso');
  assert.match(norm(await p.textContent('.ag-aviso')), /Hay 1 solicitud de crédito de una agencia para revisar/);
  await p.click('.ag-aviso [data-ir="agencias"]');
  await p.waitForSelector(`#sol-${idSolicitud}`);
  assert.equal(await p.textContent('#tVista'), 'Agencias');
  const texto = norm(await p.textContent(`#sol-${idSolicitud}`));
  for (const t of ['Salón Prueba', '27-22222222-8', 'MARCA UNO SEDAN 1.6 (2024)', '$ 4.000.000', 'Empleado en relación de dependencia',
    '22.222.222', 'Bv. Colón 135', 'Soltero/a', '3534123456', '2850590940090418135201', 'De un tercero', 'Autos del Sur SA', '30-44444444-0', 'Ver documentos (5)']) {
    assert.ok(texto.includes(t), `falta «${t}» en: ${texto}`);
  }
  // El BCRA se ve solo como un círculo de color, sin «Continuar» ni «Sujeto a revisión».
  assert.ok(await p.$(`#sol-${idSolicitud} .sem-punto.amarillo`), 'falta el círculo amarillo del BCRA');
  assert.ok(!/Sujeto a revisión|Continuar/.test(texto), 'quedó el texto del semáforo');
  // Documentos: enlaces que abren el archivo.
  await p.click(`#sol-${idSolicitud} [data-a="ag-docs"]`);
  await p.waitForSelector(`#sol-${idSolicitud} .ag-docs a`);
  const enlaces = await p.$$eval(`#sol-${idSolicitud} .ag-docs a`, (as) => as.map((a) => [a.textContent, a.href]));
  assert.equal(enlaces.length, 5);
  const [, url] = enlaces.find(([n]) => n === 'titulo.pdf');
  assert.deepEqual(new Uint8Array(await (await fetch(url)).arrayBuffer()), PDF('titulo'));
  // Pasarla a «En análisis»: sigue abierta (con el botón de pasar ya sin mostrarse) y la base no la da por resuelta.
  await p.click(`#sol-${idSolicitud} [data-estado="en_analisis"]`);
  await toast(p, 'Solicitud en análisis');
  assert.equal(sql(`select estado || '/' || coalesce(resuelto::text, 'sin resolver') from public.solicitudes_credito where id = '${idSolicitud}'`), 'en_analisis/sin resolver');
  await p.waitForSelector(`#sol-${idSolicitud}`);
  assert.equal(await p.locator(`#sol-${idSolicitud} [data-estado="en_analisis"]`).count(), 0);
  assert.match(norm(await p.textContent(`#sol-${idSolicitud}`)), /En análisis/);
  // Aprobar con una nota.
  await p.fill(`[data-k="ag.notas.${idSolicitud}"]`, 'Que venga el jueves');
  await p.click(`#sol-${idSolicitud} [data-estado="aprobada"]`);
  await toast(p, 'Solicitud aprobada');
  const s = JSON.parse(sql(`select to_jsonb(s) from public.solicitudes_credito s where id = '${idSolicitud}'`));
  assert.equal(s.estado, 'aprobada');
  assert.equal(s.nota, 'Que venga el jueves');
  assert.equal(s.resuelto_por, 'Emi');
  await p.waitForSelector('#nAgencias[hidden]', { state: 'attached' });
  assert.match(norm(await p.textContent('#main')), /No hay solicitudes pendientes/);
  assert.match(norm(await p.textContent('#main')), /Resueltas/);
  await p.context().close();
});

test('Créditos y Cobros: parámetros del cotizador y agencias, desde la solapa', async () => {
  const p = await pagina('pc');
  await ingresarCobranzas(p);
  await p.click('#v_agencias');
  await p.click('[data-a="ag-tab"][data-tab="parametros"]');
  await p.waitForSelector('[data-k="ag.p.relacion_max"]');
  assert.equal(await p.inputValue('[data-k="ag.p.plazos"]'), '1-24');
  assert.equal(await p.inputValue('[data-k="ag.p.tasas"]'), '2021=5; 2018=6; 2014=7');
  await p.fill('[data-k="ag.p.relacion_max"]', '40');
  await p.click('[data-a="ag-param-guardar"]');
  await toast(p, 'Parámetros guardados');
  assert.equal(sql('select relacion_max::text || \' \' || array_length(plazos, 1) from public.ajustes_agencias'), '40 24');
  sql('update public.ajustes_agencias set relacion_max = 45');
  await p.click('[data-a="ag-tab"][data-tab="agencias"]');
  await p.waitForSelector('[data-a="ag-activa"]');
  assert.match(norm(await p.textContent('#main')), /Salón Prueba/);
  await p.click('[data-a="ag-activa"]');
  await toast(p, 'Agencia pausada');
  assert.equal(sql(`select activa from public.agencias where email = '${AG}'`), 'f');
  await p.click('[data-a="ag-activa"]');
  await toast(p, 'Agencia activada');
  // Crear una agencia desde la solapa: la clave provisoria se ve una sola vez.
  await p.fill('[data-k="ag.alta.nombre"]', 'Salón Botón');
  await p.fill('[data-k="ag.alta.email"]', 'boton@test.local');
  await p.click('[data-a="ag-crear"]');
  await p.waitForSelector('.ag-nueva .ag-acceso');
  const clave = (await p.textContent('.ag-nueva .ag-acceso dd:last-of-type')).trim();
  assert.match(clave, /^[A-HJ-NP-Za-km-z2-9]{12}$/);
  assert.match(norm(await p.textContent('.ag-nueva')), /boton@test\.local/);
  assert.equal(sql(`select activa::text || clave_temporal::text from public.agencias where email = 'boton@test.local'`), 'truetrue');
  assert.equal((await entrar('boton@test.local', clave)).sesion.user.email, 'boton@test.local', 'la clave que se ve es la que sirve');
  // Al cambiar de solapa la clave desaparece de la pantalla y no se puede volver a ver.
  await p.click('[data-a="ag-tab"][data-tab="parametros"]');
  await p.click('[data-a="ag-tab"][data-tab="agencias"]');
  assert.equal(await p.$('.ag-nueva'), null);
  assert.ok(!(await p.content()).includes(clave), 'la clave ya no está en la página');
  await p.context().close();
});

test('Créditos y Cobros: la Mutual elimina cotizaciones, una por una o todas', async () => {
  sql(`delete from public.cotizaciones_agencia;
       insert into public.cotizaciones_agencia (agencia_id, agencia, vehiculo, anio, monto, cuotas, cuota)
       select id, nombre, 'AUTO ' || g, '2022', 1000000, 12, 100000 from public.agencias, generate_series(1, 3) g where email = '${AG}'`);
  const p = await pagina('pc');
  await ingresarCobranzas(p);
  await p.click('#v_agencias');
  await p.click('[data-a="ag-tab"][data-tab="cotizaciones"]');
  await p.waitForSelector('tbody tr [data-a="ag-cot-preguntar"]');
  assert.equal(await p.locator('tbody tr').count(), 3);
  // Una: pregunta antes; «No» la deja.
  await p.locator('tbody tr [data-a="ag-cot-preguntar"]').first().click();
  await p.waitForSelector('[data-a="ag-cot-borrar"]');
  await p.click('[data-a="ag-cot-no"]');
  assert.equal(sql('select count(*) from public.cotizaciones_agencia'), '3');
  await p.locator('tbody tr [data-a="ag-cot-preguntar"]').first().click();
  await p.click('[data-a="ag-cot-borrar"]');
  await toast(p, 'Cotización eliminada');
  assert.equal(sql('select count(*) from public.cotizaciones_agencia'), '2');
  assert.equal(await p.locator('tbody tr').count(), 2);
  // Todas.
  await p.click('[data-a="ag-cot-preguntar"][data-id="todas"]');
  await p.click('[data-a="ag-cot-borrar"]');
  await toast(p, 'Cotizaciones eliminadas');
  assert.equal(sql('select count(*) from public.cotizaciones_agencia'), '0');
  await p.waitForSelector('text=Todavía no hay cotizaciones');
  await p.context().close();
});

// Una agencia no puede borrar el registro de cotizaciones por la API (ni verlo): la puerta es solo de la Mutual.
test('una agencia no puede eliminar cotizaciones', async () => {
  sql(`insert into public.cotizaciones_agencia (agencia_id, agencia, vehiculo, anio, monto, cuotas, cuota) select id, nombre, 'X', '2022', 1, 1, 1 from public.agencias limit 1`);
  const ses = (await entrar(AG, AG_CLAVE)).sesion.access_token;
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/cotizaciones_agencia?id=gte.0`, { method: 'DELETE', headers: { authorization: `Bearer ${ses}`, apikey: env.ANON_KEY } });
  assert.ok(r.status >= 400, `status ${r.status}`);
  assert.equal(sql('select count(*) from public.cotizaciones_agencia'), '1');
  sql('delete from public.cotizaciones_agencia');
});

test('en el mismo navegador conviven la sesión de la agencia (cotizador) y la de la Mutual (sus apps)', async () => {
  const c = await browser.newContext({ locale: 'es-AR', viewport: { width: 390, height: 844 } });
  const p = await pagina('celular', null, c);
  await ingresarCobranzas(p);
  const q = await pagina('cotizador', null, c);
  await q.goto(BASE + 'agencias/');
  await q.waitForSelector('#fIngreso');
  await q.fill('input[name=email]', AG); await q.fill('input[name=clave]', AG_CLAVE);
  await q.click('#fIngreso button[type=submit]');
  await q.waitForSelector('#inCuit');
  const quien = (k) => q.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null')?.user?.email, k);
  assert.equal(await quien('gestor.sesion'), EMI);
  assert.equal(await quien('agencias.sesion'), AG);
  await q.click('#btnSalir');
  await q.waitForSelector('#fIngreso');
  assert.equal(await quien('gestor.sesion'), EMI, 'salir del cotizador no saca de las apps');
  await p.reload();
  await p.waitForSelector('#vApp:not([hidden])');
  // La Mutual en el cotizador: vista previa, sin administración, con el camino a Créditos y Cobros.
  await q.fill('input[name=email]', EMI); await q.fill('input[name=clave]', CLAVE);
  await q.click('#fIngreso button[type=submit]');
  await q.waitForSelector('#inCuit');
  assert.equal(await q.$('[data-vista="admin"]'), null);
  assert.equal(await q.getAttribute('a[href="../cobranzas/#agencias"]', 'href'), '../cobranzas/#agencias');
  await c.close();
});

test('la agencia ve en qué estado va su solicitud y la solapa avisa cuando cambia', async () => {
  const p = await pagina('agencia');
  sql(`update public.solicitudes_credito set estado = 'en_analisis', nota = 'Falta el recibo de este mes' where id = '${idSolicitud}'`);
  await p.goto(BASE + 'agencias/');
  await p.waitForSelector('#fIngreso');
  await p.fill('input[name=email]', AG); await p.fill('input[name=clave]', AG_CLAVE);
  await p.click('#fIngreso button[type=submit]');
  await p.waitForSelector('#inCuit');
  const solapa = () => p.textContent('[data-vista="solicitudes"]');
  await p.waitForFunction(() => /\(1\)/.test(document.querySelector('[data-vista="solicitudes"]')?.textContent || ''), null, { timeout: 8000 });
  assert.equal(norm(await solapa()), 'Mis solicitudes (1)', 'cambió desde la última vez: avisa');
  await p.click('[data-vista="solicitudes"]');
  await p.waitForSelector('.sol');
  const lista = norm(await p.textContent('#main'));
  assert.match(lista, /En análisis/);
  assert.match(lista, /La Mutual la está analizando/);
  assert.match(lista, /Novedad/);
  assert.match(lista, /Falta el recibo de este mes/);
  await p.click('[data-vista="cotizar"]');
  assert.equal(norm(await solapa()), 'Mis solicitudes', 'ya la vio: el aviso se va');
  // Resuelve la Mutual: la solapa se entera sin recargar y sin tocar lo que se estaba escribiendo.
  await p.fill('#inCuit', '20-12345678-6');
  sql(`update public.solicitudes_credito set estado = 'aprobada', nota = 'Que venga a firmar' where id = '${idSolicitud}'`);
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForFunction(() => /\(1\)/.test(document.querySelector('[data-vista="solicitudes"]')?.textContent || ''), null, { timeout: 8000 });
  assert.equal(await p.inputValue('#inCuit'), '20-12345678-6');
  await p.click('[data-vista="solicitudes"]');
  await p.waitForSelector('.sol');
  assert.match(norm(await p.textContent('#main')), /Aprobada/);
  await p.context().close();
});

test('sin errores en la consola', () => { assert.deepEqual(errores, []); });

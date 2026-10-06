// Pruebas de punta a punta: la app en un navegador real contra GoTrue y PostgREST reales.
// Requiere `dev/stack.sh up` y `node dev/serve.mjs` (la app en http://127.0.0.1:8080).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { sql, servicio, limpiar, env, crearCuenta } from './helpers.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8080/';
const EMAIL = 'emi@test.local';
const CLAVE = 'Una-clave-larga-2026';
const hoy = new Date();
const dia = (n) => { const d = new Date(hoy); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

const claveTemporal = 'Provisoria-del-panel-1';
let browser, ctx, page;
const errores = [];

function vigilar(p, nombre) {
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|realtime|503|Failed to load resource/i.test(m.text())) errores.push(`[${nombre}] ${m.text()}`); });
  p.on('pageerror', (e) => errores.push(`[${nombre}] ${e.message}`));
}
async function nuevoContexto(opciones = {}) {
  const c = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', viewport: { width: 1280, height: 860 }, acceptDownloads: true, ...opciones });
  const p = await c.newPage();
  vigilar(p, opciones.nombre || 'pc');
  return { c, p };
}
async function entrar(p, email, clave, consulta = '') {
  await p.goto(BASE + consulta);
  await p.waitForSelector('#fIngreso');
  await p.fill('#i_email', email);
  await p.fill('#i_clave', clave);
  await p.click('#fIngreso button[type=submit]');
}
const caido = (v) => fetch(`${env.SUPABASE_URL}/__caido`, { method: 'POST', body: JSON.stringify({ caido: v }) });
const tiempoReal = (v) => fetch(`${env.SUPABASE_URL}/__realtime`, { method: 'POST', body: JSON.stringify({ activo: v }) });
const toast = (p, texto) => p.waitForFunction((t) => { const e = document.querySelector('#toast'); return e && !e.hidden && e.textContent.includes(t); }, texto, { timeout: 8000 });
const fila = (p, expte) => p.locator(`#main tr[data-id="${expte}"]`);
const abrir = async (p, expte) => { await fila(p, expte).locator('td.car').click(); await p.waitForSelector('.panel'); };
const cerrado = (p) => p.waitForSelector('#drawer', { state: 'hidden' });

before(async () => {
  await caido(false); await tiempoReal(false);
  limpiar();
  await crearCuenta(EMAIL, claveTemporal, 'Emi', true); // creada con una clave provisoria: la app obliga a cambiarla
  sql(`begin; select set_config('gestor.autor', 'Semilla', true);
    insert into public.causas (expte, actor, demandado, tipo, nom, oficina, estado, etiquetas, proxima, vence, ultima, fecha, historial) values
     ('1001','AMB','ALFA ANA','EJECUTIVO','1','OEP','Casillero','{"En trámite"}','Pedir embargo','${dia(-2)}','Dimos cédula','${dia(-40)}','[{"fecha":"${dia(-40)}","texto":"Dimos cédula"}]'),
     ('1002','AMB','BETA BRUNO','PRENDARIO','2','OEP','A despacho','{"Secuestro / subasta"}','',null,'Ejecutamos sentencia','${dia(-5)}','[]'),
     ('1003','AMB','GAMA CARLA','EJECUTIVO','3','OEP VM','Archivada','{}','',null,'Archivo','${dia(-200)}','[]'),
     ('1004','AMB','<img src=x onerror="window.__xss=1"> DELTA','EJECUTIVO','1','OEP','Casillero','{"Embargo de sueldo"}','Enviar cédulas','${dia(3)}','Solicitamos embargo','${dia(-1)}','[]');
    insert into public.plantillas (id, titulo, cuerpo) values ('aprobacion', 'Solicita aprobación', 'En autos {{caratula}}, expediente {{expediente}} de la {{nominacion}} nominación.');
    commit;`);
  browser = await chromium.launch();
  ({ c: ctx, p: page } = await nuevoContexto());
});
after(async () => { await caido(false); await tiempoReal(false); await browser?.close(); });

test('ingreso: clave equivocada, clave temporal y elección de la definitiva', async () => {
  await entrar(page, EMAIL, 'no-es-la-clave');
  await page.waitForFunction(() => document.querySelector('#i_error')?.textContent.includes('Email o contraseña incorrectos'));
  await page.fill('#i_clave', claveTemporal);
  await page.click('#fIngreso button[type=submit]');
  await page.waitForSelector('#fClave');
  // validaciones
  await page.fill('#n_clave', 'corta'); await page.fill('#n_clave2', 'corta'); await page.click('#fClave button[type=submit]');
  assert.match(await page.textContent('#i_error'), /10 caracteres/);
  await page.fill('#n_clave', CLAVE); await page.fill('#n_clave2', CLAVE + 'x'); await page.click('#fClave button[type=submit]');
  assert.match(await page.textContent('#i_error'), /no coinciden/);
  await page.fill('#n_clave2', CLAVE); await page.click('#fClave button[type=submit]');
  await page.waitForSelector('#main .tablebox');
  assert.equal(sql(`select clave_temporal from gestor.miembros where email='${EMAIL}'`), 'f');
  assert.equal(await page.locator('#ingresoCuerpo input').count(), 0, 'la clave no queda en la página');
});

test('listado: activas, archivadas aparte, búsqueda, filtros y vencidas', async () => {
  assert.equal(await page.locator('#main tbody tr').count(), 3); // la archivada no se lista
  assert.match(await page.textContent('#sub'), /3 de 4 causas/);
  assert.equal(await page.textContent('.stat[data-q="due"] b'), '1');   // 1001 venció hace 2 días
  assert.equal(await page.textContent('.stat[data-q="stale"] b'), '1'); // 1001 sin movimiento hace 40 días
  await page.click('.stat[data-q="arch"]');
  assert.equal(await page.locator('#main tbody tr').count(), 1);
  assert.match(await fila(page, '1003').textContent(), /GAMA CARLA/);
  await page.click('.stat[data-q="arch"]');
  await page.fill('#q', 'beta');
  assert.equal(await page.locator('#main tbody tr').count(), 1);
  await page.fill('#q', '');
  await page.selectOption('#fNom', '1');
  assert.equal(await page.locator('#main tbody tr').count(), 2);
  await page.selectOption('#fNom', '');
  await page.click('#chips .chip[data-t="e:A despacho"]');
  assert.equal(await page.locator('#main tbody tr').count(), 1);
  await page.click('#chips .chip[data-t=""]');
  // orden por demandado
  await page.click('th[data-k="demandado"]');
  assert.match(await page.locator('#main tbody tr').first().textContent(), /DELTA/); // "<img…" ordena primero
  await page.click('th[data-k="dias"]'); await page.click('th[data-k="dias"]');
});

test('un dato con HTML se muestra como texto, no se ejecuta', async () => {
  assert.match(await fila(page, '1004').textContent(), /<img src=x onerror=/);
  assert.equal(await page.locator('#main img').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
});

test('la sesión se mantiene al recargar', async () => {
  await page.reload();
  await page.waitForSelector('#main .tablebox');
  assert.equal(await page.locator('#fIngreso').count(), 0);
});

test('nueva causa: validaciones, alta y autoría', async () => {
  await page.click('#btnNew'); await page.waitForSelector('.panel');
  await page.fill('#c_actor', ''); // sin actor ni demandado no hay con qué nombrarla
  await page.click('.ppie [data-act=save]'); await toast(page, 'Falta el actor o el demandado');
  await page.fill('#c_actor', 'AMB');
  await page.fill('#c_demandado', 'OMEGA OSCAR'); await page.fill('#c_expte', '12-A');
  await page.click('.ppie [data-act=save]'); await toast(page, 'numérico');
  await page.fill('#c_expte', '1001');
  await page.click('.ppie [data-act=save]'); await toast(page, 'Ya existe una causa');
  await page.fill('#c_expte', '2001'); await page.fill('#c_nom', '2');
  await page.fill('#c_proxima', 'Notificar'); await page.fill('#c_vence', dia(10));
  await page.click('.panel .chip[data-t="Martillero"]');
  await page.click('.ppie [data-act=save]'); await toast(page, 'Causa creada'); await cerrado(page);
  assert.match(await fila(page, '2001').textContent(), /OMEGA OSCAR/);
  assert.equal(sql(`select demandado || '|' || estado || '|' || array_to_string(etiquetas, ',') || '|' || proxima || '|' || vence || '|' || actualizado_por from public.causas where expte='2001'`),
    `OMEGA OSCAR|Iniciar|En trámite,Martillero|Notificar|${dia(10)}|Emi`);
});

test('causa sin demandado: se guarda, se nombra por el actor y se puede editar', async () => {
  await page.click('#btnNew'); await page.waitForSelector('.panel');
  await page.fill('#c_actor', 'PEREZ PABLO'); await page.fill('#c_tipo', 'DECLARATORIA DE HEREDEROS');
  await page.fill('#c_expte', '3001'); await page.fill('#c_nom', '1'); await page.fill('#c_oficina', 'SECRETARIA 2');
  await page.click('.ppie [data-act=save]'); await toast(page, 'Causa creada'); await cerrado(page);
  assert.equal(sql(`select actor || '|' || demandado || '|' || tipo from public.causas where expte='3001'`), 'PEREZ PABLO||DECLARATORIA DE HEREDEROS');
  // en el listado el nombre es el actor, sin "c/", y ordena entre los demandados
  assert.equal(await fila(page, '3001').locator('td.car b').textContent(), 'PEREZ PABLO');
  assert.equal(await fila(page, '3001').locator('td.car small').textContent(), 'DECLARATORIA DE HEREDEROS');
  await page.click('th[data-k="demandado"]');
  assert.deepEqual((await page.locator('#main tbody td.car b').allTextContents()).slice(-2), ['OMEGA OSCAR', 'PEREZ PABLO']);
  await page.click('th[data-k="dias"]'); await page.click('th[data-k="dias"]');
  // el tablero y la lista de causas de los acuerdos la nombran igual
  await page.click('#vTablero');
  assert.equal(await page.locator('#main .card[data-id="3001"] b').first().textContent(), 'PEREZ PABLO');
  await page.click('#vAcuerdos');
  assert.equal(await page.locator('#na_expte option[value="3001"]').textContent(), 'PEREZ PABLO · 3001');
  await page.click('#vLista');
  // en el celular, la tarjeta también
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector('#main .filas');
  assert.equal(await page.locator('#main .fila[data-id="3001"] .fila-top b').textContent(), 'PEREZ PABLO');
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForSelector('#main .tablebox');
  // la ficha: carátula sin "c/", también en las plantillas y al consultar a Claude; y guarda los cambios
  await abrir(page, '3001');
  assert.equal(await page.textContent('.panel h2'), 'PEREZ PABLO – DECLARATORIA DE HEREDEROS');
  await page.selectOption('#tp_sel', 'aprobacion');
  assert.equal(await page.inputValue('#tp_cue'), 'En autos PEREZ PABLO – DECLARATORIA DE HEREDEROS, expediente 3001 de la 1° nominación.');
  await page.evaluate(() => { window.open = (u) => { window.__abierta = u; }; });
  await page.click('.ppie [data-act=claude]');
  assert.equal(new URL(await page.evaluate(() => window.__abierta)).searchParams.get('q'), 'Sobre el gestor de juicios, causa 3001 (PEREZ PABLO): ');
  await page.fill('#c_notas', 'sin contraparte');
  await page.click('.ppie [data-act=save]'); await toast(page, 'Cambios guardados'); await cerrado(page);
  assert.equal(sql(`select demandado || '|' || notas from public.causas where expte='3001'`), '|sin contraparte');
  // se elimina como cualquier otra (las pruebas que siguen cuentan las causas)
  await abrir(page, '3001');
  await page.click('[data-act=del]');
  assert.match(await page.textContent('.confirm'), /¿Eliminar definitivamente PEREZ PABLO\?/);
  await page.click('[data-act=delyes]'); await toast(page, 'Causa eliminada'); await cerrado(page);
  assert.equal(sql(`select count(*) from public.causas where expte='3001'`), '0');
});

test('ficha: registrar movimientos actualiza la última acción', async () => {
  await abrir(page, '1002');
  await page.fill('#h_fecha', dia(-3)); await page.fill('#h_texto', 'Libramos oficio'); await page.click('[data-act=histadd]');
  await page.fill('#h_fecha', dia(-3)); await page.fill('#h_texto', 'Oficio diligenciado'); await page.keyboard.press('Enter');
  // a igual fecha, el anotado después queda arriba y es la última acción
  assert.match(await page.locator('.hist li').first().textContent(), /Oficio diligenciado/);
  await page.selectOption('#c_estado', 'Sentencia');
  await page.click('.ppie [data-act=save]'); await toast(page, 'Cambios guardados'); await cerrado(page);
  assert.match(await fila(page, '1002').textContent(), /Oficio diligenciado/);
  assert.equal(sql(`select ultima || '|' || fecha || '|' || estado || '|' || jsonb_array_length(historial) from public.causas where expte='1002'`),
    `Oficio diligenciado|${dia(-3)}|Sentencia|2`);
});

test('acción realizada desde el listado: pasa a movimientos con su fecha de vencimiento', async () => {
  await fila(page, '1001').locator('[data-done]').click();
  await toast(page, 'Acción realizada');
  assert.equal(sql(`select proxima || '|' || coalesce(vence::text, '') || '|' || ultima || '|' || fecha || '|' || (historial -> -1 ->> 'hecha') from public.causas where expte='1001'`),
    `||Pedir embargo|${dia(-2)}|true`);
  await page.waitForFunction(() => !document.querySelector('#main tr[data-id="1001"] [data-done]'));
});

test('acción realizada antes de su vencimiento: queda con la fecha de hoy, no con una futura', async () => {
  await fila(page, '1004').locator('[data-done]').click(); // vence dentro de 3 días
  await toast(page, 'Acción realizada');
  assert.equal(sql(`select ultima || '|' || fecha || '|' || (historial -> -1 ->> 'fecha') from public.causas where expte='1004'`),
    `Enviar cédulas|${dia(0)}|${dia(0)}`);
});

test('liquidación: totales, faltante de embargo y guardado', async () => {
  await abrir(page, '1002');
  await page.click('[data-act=liqnew]');
  await page.fill('#l_emb', '1000');
  await page.fill('#lr_m0', '400'); await page.fill('#lr_m4', '900'); await page.fill('#lr_p0', '150');
  await page.waitForFunction(() => /1\.300/.test(document.querySelector('.totals')?.textContent || ''), null, { timeout: 5000 });
  const totales = await page.textContent('.totals');
  assert.match(totales, /Total planilla\$ 1\.300/); assert.match(totales, /Cobrado por OP\$ 150/); assert.match(totales, /Saldo pendiente\$ 1\.150/);
  assert.match(totales, /Faltante: pedir ampliación de embargo\$ 300/);
  await page.click('.ppie [data-act=save]'); await toast(page, 'Cambios guardados'); await cerrado(page);
  assert.equal(sql(`select (liquidacion ->> 'embargo') || '|' || (liquidacion -> 'rubros' -> 0 ->> 'monto') || '|' || (liquidacion -> 'rubros' -> 0 ->> 'pagado') || '|' || jsonb_array_length(liquidacion -> 'rubros') from public.causas where expte='1002'`),
    '1000|400|150|6');
});

test('plantillas: se completan con los datos de la causa; alta, edición y baja', async () => {
  await abrir(page, '1002');
  await page.selectOption('#tp_sel', 'aprobacion');
  assert.equal(await page.inputValue('#tp_cue'), 'En autos AMB c/ BETA BRUNO – PRENDARIO, expediente 1002 de la 2° nominación.');
  await page.keyboard.press('Escape'); await cerrado(page);
  await page.click('#btnTpl'); await page.waitForSelector('.panel');
  await page.fill('#pt_new', 'Pide embargo'); await page.fill('#pc_new', 'Solicito embargo contra {{demandado}}.');
  await page.click('[data-tp=save][data-id=""]'); await toast(page, 'Plantilla creada');
  const id = sql(`select id from public.plantillas where titulo='Pide embargo'`);
  await page.waitForSelector(`#pt_${id}`);
  await page.fill(`#pc_${id}`, 'Solicito embargo sobre los haberes de {{demandado}}.');
  await page.click(`[data-tp=save][data-id="${id}"]`); await toast(page, 'Plantilla guardada');
  assert.match(sql(`select cuerpo from public.plantillas where id='${id}'`), /haberes/);
  await page.click(`[data-tp=del][data-id="${id}"]`); await page.click(`[data-tp=delyes][data-id="${id}"]`); await toast(page, 'Plantilla eliminada');
  assert.equal(sql(`select count(*) from public.plantillas`), '1');
  await page.keyboard.press('Escape'); await cerrado(page);
});

test('acuerdos: plan de cuotas, pago, y aviso de cuota vencida sin confirmar', async () => {
  await page.click('#vAcuerdos');
  await page.fill('#na_deudor', 'ZETA ZOE'); await page.selectOption('#na_expte', '1002');
  await page.fill('#na_n', '3'); await page.fill('#na_monto', '50000'); await page.fill('#na_fecha', dia(-6));
  await page.click('[data-ac=create]'); await toast(page, 'Plan de cuotas creado');
  const id = sql(`select id from public.acuerdos where deudor='ZETA ZOE'`);
  assert.equal(sql(`select jsonb_array_length(cuotas) || '|' || (cuotas -> 0 ->> 'vence') || '|' || (cuotas -> 0 ->> 'monto') || '|' || expte from public.acuerdos where id='${id}'`), `3|${dia(-6)}|50000|1002`);
  // la primera cuota venció hace 6 días: el gestor pregunta
  await page.waitForSelector('#avisos .aviso');
  assert.match(await page.textContent('#avisos'), /¿Pagó ZETA ZOE su cuota del acuerdo\?/);
  await page.click('#avisos [data-v=pagada]'); await toast(page, 'Cuota marcada como pagada');
  await page.waitForFunction(() => !document.querySelector('#avisos .aviso'));
  assert.equal(sql(`select cuotas -> 0 ->> 'estado' from public.acuerdos where id='${id}'`), 'pagada');
  // corregir el monto de la segunda cuota
  await page.fill(`#cq_m_${id}_1`, '45000'); await page.locator(`#cq_m_${id}_1`).blur(); await toast(page, 'Cuota actualizada');
  assert.equal(sql(`select cuotas -> 1 ->> 'monto' from public.acuerdos where id='${id}'`), '45000');
  await page.click(`[data-ac=del][data-id="${id}"]`); await page.click(`[data-ac=delyes][data-id="${id}"]`); await toast(page, 'Acuerdo eliminado');
  await page.click('#vLista');
});

test('exportar: descarga un CSV con lo que se ve', async () => {
  const [descarga] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  assert.match(descarga.suggestedFilename(), /^juicios-\d{4}-\d{2}-\d{2}\.csv$/);
  const s = await descarga.createReadStream(); let csv = ''; for await (const c of s) csv += c;
  assert.ok(csv.startsWith('﻿Actor;Demandado;Tipo;Expediente'));
  assert.equal(csv.trim().split('\n').length, 5); // encabezado + 4 causas activas
});

test('lo que actualiza Claude aparece solo, sin recargar', async () => {
  sql(`select gestor.presentacion('1004', 'Solicita se libre oficio')`);
  await page.waitForFunction(() => /Solicita se libre oficio/.test(document.querySelector('#main tr[data-id="1004"]')?.textContent || ''), null, { timeout: 10000 });
  assert.match(await fila(page, '1004').textContent(), /A despacho/);
});

test('si Claude cambia una causa que tengo abierta: aviso, y al guardar elijo qué hacer', async () => {
  await abrir(page, '2001');
  await page.fill('#c_notas', 'mi nota');
  sql(`select gestor.movimiento('2001', 'Cédula diligenciada', null, 'Notificando')`);
  await page.waitForSelector('#nota .nota', { timeout: 10000 });
  assert.match(await page.textContent('#nota'), /Claude actualizó esta causa/);
  assert.equal(await page.inputValue('#c_notas'), 'mi nota', 'el aviso no borra lo que estaba escribiendo');
  // guardar con la versión vieja: no pisa
  await page.click('.ppie [data-act=save]');
  await page.waitForSelector('#nota .nota.choque');
  assert.match(await page.textContent('#nota'), /No se guardó: Claude modificó esta causa/);
  assert.equal(sql(`select notas || '|' || estado from public.causas where expte='2001'`), '|Notificando');
  // ver la versión actual descarta lo mío
  await page.click('[data-act=choque-ver]');
  assert.equal(await page.inputValue('#c_notas'), '');
  assert.equal(await page.inputValue('#c_estado'), 'Notificando');
  assert.match(await page.textContent('.hist'), /Cédula diligenciada/);
  // segundo choque: guardar lo mío igual
  await page.fill('#c_notas', 'nota definitiva');
  sql(`select gestor.proxima('2001', 'Esperar plazo', '${dia(5)}')`);
  await page.waitForSelector('#nota .nota', { timeout: 10000 });
  await page.click('.ppie [data-act=save]');
  await page.waitForSelector('#nota .nota.choque');
  await page.click('[data-act=choque-pisar]'); await toast(page, 'Cambios guardados'); await cerrado(page);
  assert.equal(sql(`select notas || '|' || proxima from public.causas where expte='2001'`), 'nota definitiva|Notificar');
  assert.equal(sql(`select actualizado_por from public.causas where expte='2001'`), 'Emi');
});

test('si la causa abierta se elimina desde otro lado, se puede volver a crear', async () => {
  await abrir(page, '2001');
  sql(`delete from public.causas where expte='2001'`);
  await page.waitForFunction(() => /fue eliminada/.test(document.querySelector('#nota')?.textContent || ''), null, { timeout: 10000 });
  await page.fill('#c_notas', 'sobrevive');
  await page.click('.ppie [data-act=save]');
  await page.waitForSelector('#nota .nota.choque');
  await page.click('[data-act=choque-crear]'); await toast(page, 'Causa creada'); await cerrado(page);
  assert.equal(sql(`select notas from public.causas where expte='2001'`), 'sobrevive');
});

test('eliminar causa pide confirmación', async () => {
  await abrir(page, '2001');
  await page.click('[data-act=del]');
  await page.waitForSelector('.confirm');
  await page.click('[data-act=delno]');
  assert.equal(await page.locator('.confirm').count(), 0);
  await page.click('[data-act=del]'); await page.click('[data-act=delyes]'); await toast(page, 'Causa eliminada'); await cerrado(page);
  assert.equal(sql(`select count(*) from public.causas where expte='2001'`), '0');
  assert.equal(sql(`select operacion || ':' || autor from gestor.cambios where tabla='causas' and clave='2001' order by id desc limit 1`), 'baja:Emi');
});

test('sin conexión con la base: avisa, no pierde lo escrito y se recupera sola', async () => {
  await caido(true);
  await page.waitForSelector('#franja .franja', { timeout: 10000 });
  assert.match(await page.textContent('#franja'), /Sin conexión/);
  await abrir(page, '1002');
  await page.fill('#c_notas', 'escrito sin red');
  await page.click('.ppie [data-act=save]'); await toast(page, 'Sin conexión: no se guardó');
  assert.equal(await page.inputValue('#c_notas'), 'escrito sin red', 'la ficha sigue abierta con lo escrito');
  await caido(false);
  await page.waitForFunction(() => !document.querySelector('#franja .franja'), null, { timeout: 10000 });
  await page.click('.ppie [data-act=save]'); await toast(page, 'Cambios guardados'); await cerrado(page);
  assert.equal(sql(`select notas from public.causas where expte='1002'`), 'escrito sin red');
});

test('sin internet: la app abre igual y muestra lo último guardado en el dispositivo', async () => {
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null || navigator.serviceWorker.ready.then(() => true), null, { timeout: 10000 });
  await page.reload(); await page.waitForSelector('#main .tablebox'); // ya controlada por el service worker
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('#main .tablebox', { timeout: 15000 });
  assert.match(await page.textContent('#franja'), /Sin conexión\. Estás viendo lo guardado en este dispositivo/);
  assert.match(await fila(page, '1002').textContent(), /BETA BRUNO/);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('h1')).fontFamily.includes('Source Serif 4')), true);
  await ctx.setOffline(false); // al volver la conexión se pone al día sola, sin tocar nada
  await page.waitForFunction(() => !document.querySelector('#franja .franja'), null, { timeout: 15000 });
  assert.match(await page.textContent('#sub'), /actualizado \d\d:\d\d/);
});

test('cambiar la contraseña desde el menú', async () => {
  await page.click('#btnCuenta'); await page.click('[data-m=clave]');
  await page.waitForSelector('#fClaveMenu');
  await page.fill('#n_clave', CLAVE + '-2'); await page.fill('#n_clave2', CLAVE + '-2');
  await page.click('#fClaveMenu button[type=submit]'); await toast(page, 'Contraseña guardada'); await cerrado(page);
  const { c, p } = await nuevoContexto({ nombre: 'otra-sesion' });
  await entrar(p, EMAIL, CLAVE);
  await p.waitForFunction(() => document.querySelector('#i_error')?.textContent.includes('incorrectos'));
  await p.fill('#i_clave', CLAVE + '-2'); await p.click('#fIngreso button[type=submit]');
  await p.waitForSelector('#main .tablebox');
  await c.close();
});

test('celular: tarjetas, filtros plegados y botón de nueva causa', async () => {
  const { c, p } = await nuevoContexto({ nombre: 'cel', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await entrar(p, EMAIL, CLAVE + '-2');
  await p.waitForSelector('#main .filas');
  assert.equal(await p.locator('#main .fila').count(), 3);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'sin desplazamiento horizontal de la página');
  assert.equal(await p.isVisible('#fEstado'), false);
  await p.tap('#btnFiltros');
  assert.equal(await p.isVisible('#fEstado'), true);
  await p.selectOption('#fOrden', 'demandado:1');
  assert.match(await p.locator('#main .fila').first().textContent(), /DELTA/);
  assert.match(await p.textContent('#btnFiltros'), /Filtros · 1/);
  await p.tap('#vTablero');
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'el tablero se desliza dentro de su caja');
  await p.tap('#vLista');
  await p.tap('#main .fila[data-id="1002"] .fila-top');
  await p.waitForSelector('.panel');
  assert.equal(await p.evaluate(() => { const s = document.querySelector('.panel'); return s.scrollWidth <= s.clientWidth; }), true, 'la ficha entra en el ancho');
  await p.tap('.ppie [data-act=close]');
  await p.tap('#fabNew'); await p.waitForSelector('.panel');
  assert.match(await p.textContent('.panel h2'), /Nueva causa/);
  await p.tap('.ppie [data-act=close]');
  await p.tap('#btnCuenta'); await p.waitForSelector('.menu');
  assert.equal(await p.isVisible('[data-m=plantillas]'), true);
  await c.close();
});

test('con tiempo real el cambio de Claude llega al instante; si se corta, sigue con el respaldo', async () => {
  await tiempoReal(true);
  const { c, p } = await nuevoContexto({ nombre: 'vivo' });
  await entrar(p, EMAIL, CLAVE + '-2', '?sondeo=3000');
  await p.waitForSelector('#main .tablebox');
  await p.waitForSelector('#sub .vivo', { timeout: 10000 }); // "en vivo": con el canal abierto solo relee cada 5 minutos
  let t0 = Date.now();
  sql(`select gestor.movimiento('1002', 'Aviso por tiempo real')`);
  await p.waitForFunction(() => /Aviso por tiempo real/.test(document.querySelector('#main tr[data-id="1002"]')?.textContent || ''), null, { timeout: 2500 });
  assert.ok(Date.now() - t0 < 2500, 'llegó por el aviso, no por el sondeo');
  // plantillas y acuerdos también avisan
  sql(`begin; select set_config('gestor.autor', 'Claude', true); update public.plantillas set titulo = 'Solicita aprobación (v2)' where id = 'aprobacion'; commit;`);
  await p.click('#btnTpl');
  await p.waitForFunction(() => document.querySelector('#pt_aprobacion')?.value === 'Solicita aprobación (v2)', null, { timeout: 2500 });
  await p.keyboard.press('Escape');
  // se corta el tiempo real: deja de decir "en vivo" y sigue al día releyendo
  await tiempoReal(false);
  await p.waitForFunction(() => !document.querySelector('#sub .vivo'), null, { timeout: 15000 });
  sql(`select gestor.movimiento('1002', 'Aviso por sondeo', '${dia(1)}')`);
  await p.waitForFunction(() => /Aviso por sondeo/.test(document.querySelector('#main tr[data-id="1002"]')?.textContent || ''), null, { timeout: 12000 });
  await c.close();
});

test('dentro de un marco de otra página la app no arranca', async () => {
  const { c, p } = await nuevoContexto({ nombre: 'marco' });
  // Una página de otro origen (otro puerto) que intenta montar el gestor adentro.
  const trampa = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<iframe src="${BASE}" style="width:900px;height:600px"></iframe>`));
  await new Promise((ok) => trampa.listen(8081, '127.0.0.1', ok));
  try {
    await p.goto('http://127.0.0.1:8081/');
    const marco = p.frameLocator('iframe');
    await marco.locator('#ingresoCuerpo').getByText('no se abre dentro de otra página').waitFor({ timeout: 10000 });
    assert.equal(await marco.locator('#fIngreso').count(), 0);
  } finally { trampa.close(); await c.close(); }
});

test('una cuenta sin autorización no entra', async () => {
  const { error } = await servicio().auth.admin.createUser({ email: 'ajeno@test.local', password: 'Ajeno-12345678', email_confirm: true });
  assert.ifError(error);
  const { c, p } = await nuevoContexto({ nombre: 'ajeno' });
  await entrar(p, 'ajeno@test.local', 'Ajeno-12345678');
  await p.waitForFunction(() => /no está autorizada/.test(document.querySelector('#ingresoCuerpo')?.textContent || ''));
  assert.equal(await p.isVisible('#vApp'), false);
  assert.equal(await p.evaluate(() => localStorage.getItem('gj.cache')), null);
  await p.click('[data-ing=salir]'); await p.waitForSelector('#fIngreso');
  await c.close();
});

test('cerrar sesión borra del dispositivo la sesión y la copia de los datos', async () => {
  assert.ok(await page.evaluate(() => localStorage.getItem('gj.cache')));
  await page.click('#btnCuenta'); await page.click('[data-m=salir]');
  await page.waitForSelector('#fIngreso');
  assert.equal(await page.evaluate(() => localStorage.getItem('gj.cache')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('gestor.sesion')), null);
  assert.equal(await page.locator('#main tr').count(), 0, 'no quedan causas en la página');
});

test('si se le quita el acceso a alguien que está usando la app, deja de ver los datos', async () => {
  await page.fill('#i_email', EMAIL); await page.fill('#i_clave', CLAVE + '-2'); await page.click('#fIngreso button[type=submit]');
  await page.waitForSelector('#main .tablebox');
  sql(`delete from gestor.miembros where email='${EMAIL}'`);
  await page.waitForFunction(() => /no está autorizada/.test(document.querySelector('#ingresoCuerpo')?.textContent || ''), null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('gj.cache')), null);
  assert.equal(await page.locator('#main tr').count(), 0);
});

test('sin errores en la consola durante todo el recorrido', () => {
  assert.deepEqual(errores, []);
});

// Pruebas de punta a punta: la app en un navegador real contra GoTrue y PostgREST reales.
// Requiere `dev/stack.sh up` y `node dev/serve.mjs` (la app en http://127.0.0.1:8080).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
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
const enfocado = (p) => p.evaluate(() => document.activeElement?.id);
async function leer(descarga) { const partes = []; for await (const c of await descarga.createReadStream()) partes.push(c); return Buffer.concat(partes); }
/** Las partes de un .zip guardado sin comprimir, como los .xlsx que arma la app: { nombre: texto }. */
function leerZip(buf) {
  const partes = {};
  for (let i = 0; i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50;) {
    assert.equal(buf.readUInt16LE(i + 8), 0, 'parte sin comprimir');
    const tam = buf.readUInt32LE(i + 18), n = buf.readUInt16LE(i + 26), extra = buf.readUInt16LE(i + 28), desde = i + 30 + n + extra;
    partes[buf.toString('utf8', i + 30, i + 30 + n)] = buf.toString('utf8', desde, desde + tam);
    i = desde + tam;
  }
  return partes;
}

before(async () => {
  await caido(false); await tiempoReal(false);
  limpiar();
  await crearCuenta(EMAIL, claveTemporal, 'Emi', true); // creada con una clave provisoria: la app obliga a cambiarla
  sql(`begin; select set_config('gestor.autor', 'Semilla', true);
    insert into public.causas (expte, actor, demandado, tipo, nom, oficina, ubicacion, estado, cautelar, situacion, proxima, vence, ultima, fecha, historial) values
     ('1001','AMB','ALFA ANA','EJECUTIVO','1','OEP','Casillero','1.1 Demanda','Sin Cautelar','En trámite','Pedir embargo','${dia(-2)}','Dimos cédula','${dia(-40)}','[{"fecha":"${dia(-40)}","texto":"Dimos cédula"}]'),
     ('1002','AMB','BETA BRUNO','PRENDARIO','2','OEP','A despacho','4. Ejecución de Sentencia','Vehículo secuestrado','En trámite','',null,'Ejecutamos sentencia','${dia(-5)}','[]'),
     ('1003','AMB','GAMA CARLA','EJECUTIVO','3','OEP VM','Casillero','3. Sentencia','Sin Cautelar','Archivada','',null,'Archivo','${dia(-200)}','[]'),
     ('1004','AMB','<img src=x onerror="window.__xss=1"> DELTA','EJECUTIVO','1','OEP','Casillero','2. No oposición de excepciones','Embargo de sueldo','En trámite','Enviar cédulas','${dia(3)}','Solicitamos embargo','${dia(-1)}','[]');
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
  const ids = () => page.locator('#main tbody tr').evaluateAll((rs) => rs.map((r) => r.dataset.id).sort());
  await page.click('#chips .chip[data-t="u:A despacho"]');
  assert.deepEqual(await ids(), ['1002']);
  await page.click('#chips .chip[data-t="u:Casillero"]');
  assert.deepEqual(await ids(), ['1001', '1004'], 'la archivada tampoco aparece en el casillero');
  await page.click('#chips .chip[data-t="c:Embargo de sueldo"]');
  assert.deepEqual(await ids(), ['1004']);
  assert.match(await page.textContent('#chips .chip[data-t="c:Vehículo secuestrado"]'), /Vehículos secuestrados · 1/);
  await page.click('#chips .chip[data-t=""]');
  await page.selectOption('#fEstado', '1.1 Demanda');
  assert.deepEqual(await ids(), ['1001']);
  await page.selectOption('#fEstado', '');
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
  // una causa nueva arranca en la primera etapa, en el casillero, sin cautelar y en trámite
  assert.deepEqual([await page.inputValue('#c_ubicacion'), await page.inputValue('#c_estado'), await page.inputValue('#c_cautelar'), await page.inputValue('#c_situacion')],
    ['Casillero', '0. Iniciamos', 'Sin Cautelar', 'En trámite']);
  await page.selectOption('#c_cautelar', 'Embargo de sueldo');
  await page.click('.ppie [data-act=save]'); await toast(page, 'Causa creada'); await cerrado(page);
  assert.match(await fila(page, '2001').textContent(), /OMEGA OSCAR/);
  assert.equal(sql(`select concat_ws('|', demandado, ubicacion, estado, cautelar, situacion, proxima, vence, actualizado_por) from public.causas where expte='2001'`),
    `OMEGA OSCAR|Casillero|0. Iniciamos|Embargo de sueldo|En trámite|Notificar|${dia(10)}|Emi`);
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
  await page.click('.ppie [data-act=claude]'); // el chat se abre encima, con la causa nombrada
  assert.equal(await page.inputValue('#chatTexto'), 'Sobre la causa 3001 (PEREZ PABLO): ');
  await page.fill('#chatTexto', '');
  await page.keyboard.press('Escape'); await page.waitForSelector('#chat', { state: 'hidden' });
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
  await page.selectOption('#c_estado', '5. Martillero Designado');
  await page.selectOption('#c_ubicacion', 'Casillero');
  await page.click('.ppie [data-act=save]'); await toast(page, 'Cambios guardados'); await cerrado(page);
  assert.match(await fila(page, '1002').textContent(), /Oficio diligenciado/);
  assert.equal(sql(`select concat_ws('|', ultima, fecha, estado, ubicacion, jsonb_array_length(historial)) from public.causas where expte='1002'`),
    `Oficio diligenciado|${dia(-3)}|5. Martillero Designado|Casillero|2`);
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

test('liquidación: un botón de la ficha abre la planilla; totales, faltante de embargo y guardado', async () => {
  await abrir(page, '1002');
  assert.match(await page.textContent('#secLiq'), /Sin liquidación cargada/);
  await page.click('#secLiq [data-act=planilla]'); await page.waitForSelector('.panel.plan');
  assert.equal(await page.locator('.planilla tbody tr').count(), 6, 'arranca con los rubros de siempre');
  await page.fill('#pl_emb', '1.000'); // con punto de miles, como en el expediente
  await page.fill('#pl_m0', '400'); await page.fill('#pl_m4', '900');
  await page.click('[data-act=pagadd]');
  assert.equal(await enfocado(page), 'pl_o0', 'la orden de pago nueva queda lista para escribir su N°');
  await page.keyboard.type('4321');
  await page.fill('#pl_i0_0', '150');
  // se recalcula mientras se escribe
  assert.equal(await page.textContent('#pl_c0'), '$ 150'); assert.equal(await page.textContent('#pl_s0'), '$ 250');
  assert.equal(await page.textContent('#pl_t0'), '$ 150'); assert.equal(await page.textContent('#pl_tm'), '$ 1.300');
  const totales = await page.textContent('#pl_totales');
  assert.match(totales, /Total planilla\$ 1\.300/); assert.match(totales, /Cobrado por OP\$ 150/); assert.match(totales, /Saldo pendiente\$ 1\.150/);
  assert.match(totales, /Faltante: pedir ampliación de embargo\$ 300/);
  await page.click('[data-act=plsave]'); await toast(page, 'Planilla guardada');
  assert.equal(await page.locator('.panel.plan').count(), 1, 'la planilla sigue abierta para seguir cargando');
  assert.equal(sql(`select (liquidacion ->> 'embargo') || '|' || (liquidacion -> 'rubros' -> 0 ->> 'monto') || '|' || (liquidacion -> 'rubros' -> 0 ->> 'pagado') || '|' || jsonb_array_length(liquidacion -> 'rubros') from public.causas where expte='1002'`),
    '1000|400|150|6');
  assert.equal(sql(`select liquidacion -> 'pagos' -> 0 ->> 'op' || '|' || (liquidacion -> 'pagos' -> 0 -> 'imp' ->> ((liquidacion -> 'rubros' -> 0 ->> 'id'))) from public.causas where expte='1002'`), '4321|150');
  // en la ficha queda el resumen
  await page.click('.ppie [data-act=plvolver]'); await page.waitForSelector('#secLiq .cifras');
  const resumen = await page.textContent('#secLiq');
  assert.match(resumen, /Total\$ 1\.300/); assert.match(resumen, /Saldo\$ 1\.150/); assert.match(resumen, /1 orden de pago/);
  assert.match(resumen, /Faltante sobre el embargo: \$ 300/);
  assert.equal(await page.locator('#secLiq .sucio').count(), 0, 'no quedan cambios sin guardar');
  await page.click('.ppie [data-act=close]'); await cerrado(page);
});

test('planilla: celdas como en Excel, cambios sin guardar y descarga del .xlsx', async () => {
  await abrir(page, '1002');
  await page.click('#secLiq [data-act=planilla]'); await page.waitForSelector('.panel.plan');
  assert.equal(await page.inputValue('#pl_o0'), '4321'); assert.equal(await page.inputValue('#pl_m4'), '900');
  // Enter baja a la celda de abajo; al salir, el importe queda con miles y centavos
  await page.click('#pl_m1'); await page.keyboard.type('1234,5'); await page.keyboard.press('Enter');
  assert.equal(await enfocado(page), 'pl_m2');
  assert.equal(await page.inputValue('#pl_m1'), '1.234,50');
  assert.equal(await page.textContent('#pl_s1'), '$ 1.234,50');
  // una segunda orden de pago, imputada a Capital
  await page.click('[data-act=pagadd]'); await page.keyboard.type('5555'); await page.fill('#pl_i4_1', '200.000');
  assert.equal(await page.textContent('#pl_c4'), '$ 200.000'); assert.equal(await page.textContent('#pl_s4'), '-$ 199.100');
  // el Excel: rubros en filas desde la 8, las órdenes de pago desde la columna E, cobrado y saldo con fórmula y resultado
  const [descarga] = await Promise.all([page.waitForEvent('download'), page.click('[data-act=plexcel]')]);
  assert.match(descarga.suggestedFilename(), /^liquidacion-1002-beta-bruno-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const partes = leerZip(await leer(descarga));
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) assert.ok(partes[p], 'falta ' + p);
  const hoja = partes['xl/worksheets/sheet1.xml'];
  assert.match(hoja, /OP N° 4321/); assert.match(hoja, /OP N° 5555/); assert.match(hoja, /AMB c\/ BETA BRUNO – PRENDARIO/);
  assert.match(hoja, /<c r="C12" s="7"><f>SUM\(E12:F12\)<\/f><v>200000<\/v><\/c>/, 'cobrado de Capital');
  assert.match(hoja, /<c r="D9" s="7"><f>B9-C9<\/f><v>1234.5<\/v><\/c>/, 'saldo de Intereses honorarios');
  assert.match(hoja, /<c r="B14" s="9"><f>SUM\(B8:B13\)<\/f><v>2534.5<\/v><\/c>/, 'total de la planilla');
  // volver sin guardar: la ficha avisa, y "Guardar cambios" guarda también la planilla
  await page.click('.ppie [data-act=plvolver]');
  assert.match(await page.textContent('#secLiq .sucio'), /cambios sin guardar/);
  await page.click('.ppie [data-act=save]'); await toast(page, 'Cambios guardados'); await cerrado(page);
  assert.equal(sql(`select (liquidacion -> 'rubros' -> 1 ->> 'monto') || '|' || (liquidacion -> 'pagos' -> 1 ->> 'op') || '|' || (liquidacion -> 'rubros' -> 4 ->> 'pagado') from public.causas where expte='1002'`),
    '1234.5|5555|200000');
});

test('planilla: si Claude cambió la causa no se pisa, y guardarla igual conserva lo de Claude', async () => {
  await abrir(page, '1002');
  await page.click('#secLiq [data-act=planilla]'); await page.waitForSelector('.panel.plan');
  await page.fill('#pl_m5', '50.000');
  sql(`select gestor.movimiento('1002', 'Se libró oficio')`);
  await page.waitForSelector('#nota .nota', { timeout: 10000 });
  assert.equal(await page.inputValue('#pl_m5'), '50.000', 'el aviso no borra lo que estaba escribiendo');
  await page.click('[data-act=plsave]');
  await page.waitForSelector('#nota .nota.choque');
  assert.equal(sql(`select liquidacion -> 'rubros' -> 5 ->> 'monto' from public.causas where expte='1002'`), '0', 'no se guardó encima');
  await page.click('[data-act=choque-pisar]'); await toast(page, 'Planilla guardada');
  assert.equal(sql(`select (liquidacion -> 'rubros' -> 5 ->> 'monto') || '|' || ultima from public.causas where expte='1002'`), '50000|Se libró oficio');
  await page.click('.ppie [data-act=plvolver]');
  assert.match(await page.textContent('.hist'), /Se libró oficio/, 'la ficha ya muestra el movimiento de Claude');
  await page.click('.ppie [data-act=save]'); await toast(page, 'Cambios guardados'); await cerrado(page);
  assert.equal(sql(`select ultima from public.causas where expte='1002'`), 'Se libró oficio', 'guardar la ficha después tampoco lo borra');
});

test('ficha: se puede maximizar y restaurar', async () => {
  await abrir(page, '1002');
  assert.equal(await page.locator('.panel.max').count(), 0);
  await page.click('.panel [data-act=maxi]');
  assert.equal(await page.locator('.panel.max').count(), 1, 'la barra ocupa todo el ancho');
  await page.click('.panel [data-act=maxi]');
  assert.equal(await page.locator('.panel.max').count(), 0, 'vuelve al ancho normal');
  await page.click('.ppie [data-act=close]'); await cerrado(page);
});

test('demandados y títulos: ficha de contacto, WhatsApp y monto reclamado con interés simple', async () => {
  await abrir(page, '1001');
  await page.click('[data-act=demadd]');
  await page.fill('#d_nombre0', 'Ana Alfa'); await page.fill('#d_telefono0', '03534-123456'); await page.fill('#d_domicilio0', 'Bv. Colón 135');
  await page.click('.panel [data-act=demadd]'); // se guardan los campos al agregar otro
  assert.equal(await page.inputValue('#d_nombre0'), 'Ana Alfa');
  await page.click('[data-act=demdel][data-i="1"]');
  assert.equal(await page.getAttribute('.tarjeta a.btn', 'href'), 'https://wa.me/5493534123456');
  await page.click('[data-act=titadd][data-t=pagare]');
  await page.fill('#t_monto0', '100000'); await page.fill('#t_vence0', dia(-60));
  await page.click('[data-act=titadd][data-t=prenda]');
  await page.fill('#t_monto1', '200000'); await page.fill('#t_vence1', dia(-30)); await page.fill('#t_vehiculo1', 'Ford Fiesta AA123BB');
  await page.waitForFunction(() => /320\.000/.test(document.querySelector('.panel .totals')?.textContent || ''), null, { timeout: 5000 });
  const t = await page.textContent('.panel .totals');
  assert.match(t, /Capital\$ 300\.000/); assert.match(t, /\$ 20\.000/); assert.match(t, /Total reclamado\$ 320\.000/);
  assert.equal(await page.locator('#t_vehiculo0').count(), 0, 'el pagaré no pide vehículo');
  await page.selectOption('#t_tipo0', 'prenda');
  assert.equal(await page.locator('#t_vehiculo0').count(), 1, 'al pasar a prenda aparece el vehículo');
  await page.selectOption('#t_tipo0', 'pagare');
  await page.click('.ppie [data-act=save]'); await toast(page, 'Cambios guardados'); await cerrado(page);
  assert.equal(sql(`select (select count(*) from jsonb_array_elements(demandados))::text || '|' || (demandados -> 0 ->> 'telefono') || '|' || (titulos -> 1 ->> 'vehiculo') || '|' || (titulos -> 0 ->> 'tipo') || '|' || (titulos -> 0 ->> 'vehiculo') from public.causas where expte='1001'`),
    '1|03534-123456|Ford Fiesta AA123BB|pagare|');
  // la función de Claude calcula lo mismo que la pantalla
  assert.equal(sql(`select (gestor.reclamado('1001') ->> 'total')::numeric`), '320000.00');
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
  assert.equal(await page.textContent('#nAcuerdos'), '1 cuota por confirmar', 'la insignia de Acuerdos cuenta las cuotas por confirmar');
  await page.click('#avisos [data-v=pagada]'); await toast(page, 'Cuota marcada como pagada');
  await page.waitForFunction(() => !document.querySelector('#avisos .aviso'));
  assert.equal(await page.isHidden('#nAcuerdos'), true);
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
  assert.ok(csv.startsWith('﻿Actor;Demandado;Tipo;Expediente;Nominación;Oficina;Ubicación;Estado;Etiqueta Cautelar;Situación;'));
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
  sql(`select gestor.movimiento('2001', 'Cédula diligenciada', null, '1.1 Demanda')`);
  await page.waitForSelector('#nota .nota', { timeout: 10000 });
  assert.match(await page.textContent('#nota'), /Claude actualizó esta causa/);
  assert.equal(await page.inputValue('#c_notas'), 'mi nota', 'el aviso no borra lo que estaba escribiendo');
  // guardar con la versión vieja: no pisa
  await page.click('.ppie [data-act=save]');
  await page.waitForSelector('#nota .nota.choque');
  assert.match(await page.textContent('#nota'), /No se guardó: Claude modificó esta causa/);
  assert.equal(sql(`select notas || '|' || estado from public.causas where expte='2001'`), '|1.1 Demanda');
  // ver la versión actual descarta lo mío
  await page.click('[data-act=choque-ver]');
  assert.equal(await page.inputValue('#c_notas'), '');
  assert.equal(await page.inputValue('#c_estado'), '1.1 Demanda');
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
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('h1')).fontFamily.includes('IBM Plex Sans')), true);
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
  await p.tap('#secLiq [data-act=planilla]'); await p.waitForSelector('.panel.plan');
  assert.equal(await p.evaluate(() => { const s = document.querySelector('.panel'); return s.scrollWidth <= s.clientWidth; }), true, 'la planilla entra en el ancho');
  assert.equal(await p.evaluate(() => { const h = document.querySelector('#pl_hoja'); return h.scrollWidth > h.clientWidth; }), true, 'las columnas se deslizan dentro de la hoja');
  await p.tap('.ppie [data-act=plvolver]'); await p.waitForSelector('#secLiq');
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

// ───────── Chat con Claude y escritos para el SAC ─────────
// La función `chat` corre en local (stack.sh) contra un doble de la API de Claude que contesta
// lo que cada prueba le guiona (dev/claude-falso.mjs).
const FALSO = 'http://127.0.0.1:54340';
const guion = (pasos) => fetch(`${FALSO}/__guion`, { method: 'POST', body: JSON.stringify(pasos) });
const pedidosAClaude = async () => (await fetch(`${FALSO}/__pedidos`)).json();
const habil = () => sql(`select d::date from generate_series(gestor.hoy() + 1, gestor.hoy() + 7, '1 day') d where extract(isodow from d) < 6 limit 1`);
const respuestaDeClaude = (p, texto) => p.waitForFunction((t) => [...document.querySelectorAll('#charla .msj.claude')].some((m) => m.textContent.includes(t)), texto, { timeout: 15000 });

test('chat: Claude responde dentro de la app y lo que cambia se ve al toque', async () => {
  await fetch(`${FALSO}/__pedidos`, { method: 'DELETE' });
  await guion([
    { herramientas: [{ name: 'registrar_movimiento', input: { expte: '1002', texto: 'Decreto: autos (desde el chat)' } }] },
    { texto: 'Anotado en **Beta**.\n\nQuedó así:\n- uno\n- dos <img src=x onerror="window.__xss2=1">' },
  ]);
  await page.click('#btnChat'); await page.waitForSelector('#charla .bienvenida');
  await page.fill('#chatTexto', 'Anotá el decreto en Beta');
  await page.keyboard.press('Enter'); // en la computadora, Enter envía
  await respuestaDeClaude(page, 'Anotado en');
  assert.equal(await page.textContent('#charla .msj.yo'), 'Anotá el decreto en Beta', 'la fecha que agrega la función no se ve');
  assert.equal(await page.locator('#charla .msj.claude b').first().textContent(), 'Beta');
  assert.equal(await page.locator('#charla .msj.claude li').count(), 2);
  assert.equal(await page.locator('#charla img').count(), 0, 'lo que escribe Claude se muestra como texto');
  assert.equal(await page.evaluate(() => window.__xss2), undefined);
  assert.match(await page.textContent('#charla .hecho'), /Causa 1002: movimiento anotado/);
  assert.equal(sql(`select actualizado_por from public.causas where expte='1002'`), 'Claude');
  // queda guardada en el dispositivo: al cerrar y abrir sigue ahí
  await page.keyboard.press('Escape'); await page.waitForSelector('#chat', { state: 'hidden' });
  await page.click('#btnChat');
  assert.equal(await page.locator('#charla .msj.yo').count(), 1);
  await page.keyboard.press('Escape');
  // la ficha ya tiene el movimiento, sin recargar
  await abrir(page, '1002');
  await page.waitForFunction(() => /desde el chat/.test(document.querySelector('.hist')?.textContent || ''));
  await page.keyboard.press('Escape'); await cerrado(page);
  await page.click('#btnChat');
});

test('chat: un escrito para el SAC queda en borrador hasta tocar Agendar, con lo que corrija la persona', async () => {
  const dia = habil();
  sql(`select gestor.proxima('1001', 'Solicitar aprobación', gestor.hoy() + 1)`);
  await guion([
    { herramientas: [{ name: 'preparar_presentacion', input: { expte: '1001', fecha: dia, plantilla_id: 'aprobacion', dar_por_realizada: true } }] },
    { texto: 'Te dejé el escrito: revisalo y tocá Agendar.' },
  ]);
  await page.fill('#chatTexto', `Presentá la aprobación en Alfa el ${dia} y marcá la acción como realizada`);
  await page.click('#chatEnviar');
  const tarjeta = page.locator('#charla .agcard.borrador');
  await tarjeta.waitFor();
  assert.equal(sql(`select estado from public.agenda`), 'borrador', 'todavía no está agendado');
  assert.match(await tarjeta.textContent(), /Al presentarlo, dar por realizada la próxima acción: Solicitar aprobación/);
  assert.match(await tarjeta.locator('textarea').inputValue(), /En autos AMB c\/ ALFA ANA – EJECUTIVO, expediente 1001/);
  assert.match(await fila(page, '1001').textContent(), /Escrito sin confirmar/);
  await tarjeta.locator('textarea').fill('Texto corregido por Emi.');
  await tarjeta.locator('[data-ag=agendar]').click();
  await page.waitForSelector('#charla .agcard.pendiente');
  assert.equal(sql(`select estado || '|' || cuerpo || '|' || fecha || '|' || realizar || '|' || actualizado_por from public.agenda`),
    `pendiente|Texto corregido por Emi.|${dia}|Solicitar aprobación|Emi`);
  // la confirmación viaja con el próximo mensaje, para que Claude sepa qué pasó
  await guion([{ texto: 'Perfecto.' }]);
  await page.fill('#chatTexto', 'Gracias'); await page.click('#chatEnviar');
  await respuestaDeClaude(page, 'Perfecto.');
  const ultimo = (await pedidosAClaude()).at(-1).cuerpo.messages.at(-1).content[0].text;
  assert.match(ultimo, /\[Nota del gestor: Confirmaste y quedó agendado "Solicita aprobación \(v2\)" en la causa 1001 para el .+ \(con cambios tuyos en el texto\)\. No se presenta solo\.\]\nGracias$/);
  // en el listado y en la ficha
  await page.keyboard.press('Escape');
  assert.match(await fila(page, '1001').textContent(), /SAC \d\d\/\d\d/);
  await abrir(page, '1001');
  assert.match(await page.textContent('#agendaFicha'), /Agendado.*Agendado para el .+\. No se presenta solo: cuando quieras presentarlo, tocá “Presentar ahora”/);
  // la tarea del SAC lo presenta (acá, a mano): la ficha y el listado lo muestran solos
  sql(`update public.agenda set fecha = gestor.hoy()`);
  sql(`select gestor.agenda_presentada((select id from public.agenda))`);
  await page.waitForFunction(() => /Presentado en el SAC/.test(document.querySelector('#agendaFicha')?.textContent || ''), null, { timeout: 8000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => /A despacho/.test(document.querySelector('#main tr[data-id="1001"]')?.textContent || ''));
  assert.equal(sql(`select proxima from public.causas where expte='1001'`), '');
});

// «Ahora» abre la tarea de Claude que presenta en el SAC: en las pruebas se anota en vez de abrirse.
const TAREA = 'https://claude.ai/scheduled-task/trig_01AFgigkwo8pfvJccpFYUx3n';
const espiarPestañas = (p) => p.evaluate(() => {
  window.__pestañas = [];
  window.open = (url, destino, opciones) => {
    const w = { url, opciones, cerrada: false, opener: window, close() { this.cerrada = true; } };
    w.location = { set href(v) { w.url = v; } };
    window.__pestañas.push(w);
    return w;
  };
});
const pestañas = (p) => p.evaluate(() => window.__pestañas.map((w) => ({ url: w.url, cerrada: w.cerrada, aislada: w.opener === null || w.opciones === 'noopener' })));

test('escritos para el SAC: uno que no se pudo presentar se ve, se vuelve a pedir o se cancela', async () => {
  sql(`delete from public.agenda`);
  const id = sql(`insert into public.agenda (expte, titulo, cuerpo, fecha, estado) values ('1002', 'Acompaña cédula', 'Texto', gestor.hoy(), 'pendiente') returning id`);
  sql(`select gestor.agenda_fallida('${id}', 'La compu del estudio estaba apagada')`);
  await page.waitForFunction(() => /SAC: no se presentó/.test(document.querySelector('#main tr[data-id="1002"]')?.textContent || ''), null, { timeout: 8000 });
  assert.equal(await page.textContent('.stat[data-q="sac"] b'), '1');
  assert.match(await page.getAttribute('.stat[data-q="sac"]', 'class'), /alert/);
  await abrir(page, '1002');
  assert.match(await page.textContent('#agendaFicha'), /La compu del estudio estaba apagada/);
  await espiarPestañas(page);
  await page.click('#agendaFicha [data-ag=ahora]');
  await toast(page, 'Listo. En Claude tocá “Ejecutar ahora”');
  assert.equal(sql(`select estado || '|' || resultado || '|' || (ahora is not null) from public.agenda where id='${id}'`), 'pendiente||true');
  assert.deepEqual(await pestañas(page), [{ url: TAREA, cerrada: false, aislada: true }]);
  await page.click('#agendaFicha [data-ag=cancelar]');
  await toast(page, 'Escrito cancelado');
  assert.equal(sql(`select estado from public.agenda where id='${id}'`), 'cancelado');
  assert.equal(await page.locator('#agendaFicha .agcard').count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.stat[data-q="sac"]').count(), 0, 'sin escritos pendientes, el resumen no lo muestra');
});

const borradorDeClaude = (expte, titulo, fecha) => sql(`begin; select set_config('gestor.autor', 'Claude', true);
  insert into public.agenda (expte, titulo, cuerpo, fecha, estado) values ('${expte}', '${titulo}', 'Texto de Claude', ${fecha}, 'borrador') returning id; commit;`)
  .split('\n').find((l) => /^[0-9a-f-]{36}$/.test(l));
const enFicha = (p, re) => p.waitForFunction((r) => new RegExp(r).test(document.querySelector('#agendaFicha')?.textContent || ''), re.source, { timeout: 8000 });

test('escritos para el SAC: «Ahora» deja el borrador listo, con lo que corrigió la persona, y abre la tarea en Claude', async () => {
  sql(`delete from public.agenda`);
  await espiarPestañas(page);
  const id = borradorDeClaude('1002', 'Designa martillero', `'${habil()}'`);
  await page.waitForFunction(() => /Escrito sin confirmar/.test(document.querySelector('#main tr[data-id="1002"]')?.textContent || ''), null, { timeout: 8000 });
  await abrir(page, '1002');
  const tarjeta = page.locator('#agendaFicha .agcard.borrador');
  assert.match(await tarjeta.textContent(), /Con “Ahora” se abre la tarea de Claude: tocá “Ejecutar ahora”/);
  assert.match(await tarjeta.textContent(), /Con “Agendar” queda en la agenda para ese día, pero no se presenta solo/);
  assert.doesNotMatch(await tarjeta.textContent(), /10:15/);
  await tarjeta.locator('textarea').fill('Texto corregido por Emi.');
  await tarjeta.locator('.agfecha [data-ag=ahora]').click(); // al lado de la fecha
  await toast(page, 'Listo. En Claude tocá “Ejecutar ahora” y Claude lo presenta en el SAC');
  assert.equal(sql(`select estado || '|' || cuerpo || '|' || (fecha = gestor.hoy()) || '|' || (ahora is not null) || '|' || actualizado_por from public.agenda where id = '${id}'`),
    'pendiente|Texto corregido por Emi.|true|true|Emi', 'listo para presentar hoy, confirmado por la persona');
  assert.deepEqual(await pestañas(page), [{ url: TAREA, cerrada: false, aislada: true }], 'se abrió la tarea, sin acceso al gestor');
  await page.waitForSelector('#agendaFicha .agcard.ahora');
  assert.match(await page.textContent('#agendaFicha'), /Listo para presentar.*Lo pediste a las \d\d:\d\d\. Si todavía no lo hiciste, abrí la tarea y tocá “Ejecutar ahora”/);
  assert.match(await fila(page, '1002').textContent(), /SAC: listo para presentar/);
  // si el navegador no abrió la pestaña, el botón de la tarjeta la abre
  await page.click('#agendaFicha .agcard.ahora [data-ag=tarea]');
  assert.deepEqual((await pestañas(page)).at(-1), { url: TAREA, cerrada: false, aislada: true });
  // "Ejecutar ahora": la corrida lo toma y lo presenta (acá, a mano); la ficha lo va mostrando sola
  assert.equal(sql(`select id from gestor.agenda_tomar(true)`), id);
  await enFicha(page, /Presentándose.*Claude lo está presentando en el SAC/);
  assert.equal(await page.locator('#agendaFicha .agcard.presentando [data-ag]').count(), 0, 'lo que se está presentando ya no se cancela');
  sql(`select gestor.agenda_presentada('${id}', 'Presentado en el SAC a las 11:40')`);
  await enFicha(page, /Presentado en el SAC a las 11:40/);
  await page.keyboard.press('Escape'); await cerrado(page);
  assert.equal(sql(`select ubicacion || '|' || (historial -> -1 ->> 'texto') from public.causas where expte = '1002'`), 'A despacho|Designa martillero');
});

test('escritos para el SAC: «Agendar» no presenta solo; «Presentar ahora» lo deja listo; si no se pudo guardar, no abre nada', async () => {
  sql(`delete from public.agenda`);
  await espiarPestañas(page);
  const id = borradorDeClaude('1001', 'Solicita oficio', `'${habil()}'`);
  await page.waitForFunction(() => /Escrito sin confirmar/.test(document.querySelector('#main tr[data-id="1001"]')?.textContent || ''), null, { timeout: 8000 });
  await abrir(page, '1001');
  await page.click('#agendaFicha [data-ag=agendar]');
  await toast(page, 'Ese día tocá “Presentar ahora”');
  await page.waitForSelector('#agendaFicha .agcard.pendiente:not(.ahora)');
  assert.match(await page.textContent('#agendaFicha'), /Agendado para el .+\. No se presenta solo: cuando quieras presentarlo, tocá “Presentar ahora”/);
  assert.equal(sql(`select estado || '|' || (ahora is null) from public.agenda where id = '${id}'`), 'pendiente|true');
  assert.deepEqual(await pestañas(page), [], 'agendar no abre la tarea');
  // sin conexión: no queda listo y la pestaña que se abrió se cierra
  await caido(true);
  await page.click('#agendaFicha [data-ag=ahora]');
  await toast(page, 'Sin conexión');
  assert.deepEqual((await pestañas(page)).map((w) => w.cerrada), [true]);
  await caido(false);
  assert.equal(sql(`select estado || '|' || (ahora is null) from public.agenda where id = '${id}'`), 'pendiente|true');
  // ahora sí
  await page.click('#agendaFicha [data-ag=ahora]');
  await toast(page, 'Listo. En Claude tocá');
  assert.equal(sql(`select estado || '|' || (ahora is not null) || '|' || (fecha = gestor.hoy()) from public.agenda where id = '${id}'`), 'pendiente|true|true');
  assert.deepEqual((await pestañas(page)).at(-1), { url: TAREA, cerrada: false, aislada: true });
  await page.waitForSelector('#agendaFicha .agcard.ahora');
  await page.click('#agendaFicha [data-ag=cancelar]');
  await toast(page, 'Escrito cancelado');
  assert.equal(sql(`select estado from public.agenda where id = '${id}'`), 'cancelado');
  await page.keyboard.press('Escape'); await cerrado(page);
});

test('escritos para el SAC: uno que se cortó mientras se presentaba se puede marcar como no presentado', async () => {
  sql(`delete from public.agenda`);
  const id = sql(`insert into public.agenda (expte, titulo, cuerpo, fecha, estado, ahora) values ('1002', 'Pide embargo', 'Texto', gestor.hoy(), 'pendiente', now()) returning id`);
  sql(`select id from gestor.agenda_tomar(true)`);
  await page.waitForFunction(() => /SAC: presentándose/.test(document.querySelector('#main tr[data-id="1002"]')?.textContent || ''), null, { timeout: 8000 });
  await abrir(page, '1002');
  assert.match(await page.textContent('#agendaFicha'), /Claude lo está presentando en el SAC \(empezó a las \d\d:\d\d\)/);
  assert.equal(await page.locator('#agendaFicha [data-ag=nopresentado]').count(), 0, 'mientras está en curso, nada');
  // pasó media hora sin noticias de la corrida (sin el sello, que pondría la hora de ahora)
  execFileSync('psql', ['-X', '-q', '-h', '127.0.0.1', '-p', '54322', '-U', 'supabase_admin', '-d', 'postgres', '-c',
    `set session_replication_role = replica; update public.agenda set actualizado = now() - interval '40 minutes' where id = '${id}'`]);
  await enFicha(page, /no avisó cómo terminó\. Fijate en el SAC si quedó presentado/);
  await page.click('#agendaFicha [data-ag=nopresentado]');
  await toast(page, 'Marcado como no presentado');
  assert.match(sql(`select estado || '|' || resultado from public.agenda where id = '${id}'`), /^error\|Se interrumpió mientras se presentaba \(empezó a las \d\d:\d\d\)\. Antes de volver a mandarlo, fijate en el SAC/);
  await page.waitForSelector('#agendaFicha .agcard.error [data-ag=ahora]');
  await page.keyboard.press('Escape'); await cerrado(page);
  sql(`delete from public.agenda`);
});

test('agenda: próximas acciones y escritos de todas las causas, por fecha; se abre la causa y se marca realizada', async () => {
  sql(`delete from public.agenda`);
  sql(`begin; select set_config('gestor.autor', 'Semilla', true);
    update public.causas set proxima = '', vence = null where proxima <> '';
    update public.causas set proxima = 'Pedir embargo', vence = '${dia(-2)}' where expte = '1001';
    update public.causas set proxima = 'Enviar cédulas', vence = '${dia(5)}' where expte = '1004';
    update public.causas set proxima = 'Ver archivo', vence = '${dia(1)}' where expte = '1003';
    update public.causas set proxima = 'Llamar al martillero', vence = null where expte = '1002';
    commit;`);
  sql(`insert into public.agenda (expte, titulo, cuerpo, fecha, estado) values ('1002', 'Solicita aprobación', 'Texto', gestor.hoy(), 'pendiente')`);
  await page.click('#vAgenda');
  try {
  await page.waitForFunction(() => document.querySelectorAll('#main .agitem').length === 4, null, { timeout: 8000 });
  assert.deepEqual(await page.locator('#main .agitem .fila-top .next').allTextContents(),
    ['Pedir embargo', 'Solicita aprobación', 'Enviar cédulas', 'Llamar al martillero'], 'en orden de fecha, sin las archivadas, lo que no tiene fecha al final');
  const grupos = await page.locator('#main .agdia h3 span:first-child').allTextContents();
  assert.equal(grupos.length, 4);
  assert.equal(grupos[0], 'Vencidas'); assert.match(grupos[1], /^Hoy · /); assert.equal(grupos[3], 'Sin fecha');
  assert.match(await page.locator('#main .agitem', { hasText: 'Solicita aprobación' }).textContent(), /SAC · Agendado/);
  assert.equal(await page.locator('#main .agitem', { hasText: 'Solicita aprobación' }).locator('[data-done]').count(), 0, 'los escritos se cierran solos al presentarse');
  assert.equal(await page.locator('#stats').isHidden(), true);
  // la insignia de Agenda cuenta lo que es para hoy o venció, en coral si algo venció
  assert.equal(await page.textContent('#nAgenda'), '2 para hoy o vencidas');
  assert.match(await page.getAttribute('#nAgenda', 'class'), /\burg\b/);
  // la búsqueda filtra la agenda, no la insignia
  await page.fill('#q', 'beta');
  await page.waitForFunction(() => document.querySelectorAll('#main .agitem').length === 2);
  assert.equal(await page.textContent('#nAgenda'), '2 para hoy o vencidas');
  await page.fill('#q', ''); await page.waitForFunction(() => document.querySelectorAll('#main .agitem').length === 4);
  // tocar una acción abre la ficha de su causa
  await page.locator('#main .agitem[data-id="1004"] .agcausa').click();
  await page.waitForSelector('.panel');
  await page.keyboard.press('Escape'); await cerrado(page);
  // y "Realizada" la pasa a movimientos, como en el listado
  await page.locator('#main .agitem[data-id="1001"] [data-done]').click();
  await toast(page, 'Acción realizada');
  await page.waitForFunction(() => document.querySelectorAll('#main .agitem').length === 3);
  assert.equal(sql(`select proxima || '|' || (historial -> -1 ->> 'texto') || '|' || (historial -> -1 ->> 'fecha') from public.causas where expte='1001'`), `|Pedir embargo|${dia(-2)}`);
  assert.equal(await page.textContent('#nAgenda'), '1 para hoy o vencida'); // queda el escrito de hoy, que no está vencido
  assert.doesNotMatch(await page.getAttribute('#nAgenda', 'class'), /\burg\b/);
  } finally {
    sql(`delete from public.agenda`);
    sql(`begin; select set_config('gestor.autor', 'Semilla', true); update public.causas set proxima = '', vence = null where expte in ('1002','1003','1004'); commit;`);
    await page.click('#vLista');
  }
});

test('chat: si falla, el mensaje no se pierde y se puede reintentar', async () => {
  await guion([{ error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } }, { error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } }, { texto: 'Ahora sí.' }]);
  await page.click('#btnChat');
  await page.fill('#chatTexto', 'Hola de nuevo'); await page.click('#chatEnviar');
  await page.waitForSelector('#charla .aviso-chat');
  assert.match(await page.textContent('#charla .aviso-chat'), /saturado/);
  assert.match(await page.locator('#charla .msj.yo').last().textContent(), /Hola de nuevo/);
  // para lo que el chat no puede, queda la app de Claude a mano
  await page.evaluate(() => { window.open = (u) => { window.__abierta = u; }; });
  await page.click('#charla [data-chat=claudeai]');
  assert.equal(new URL(await page.evaluate(() => window.__abierta)).searchParams.get('q'), 'Sobre el gestor de juicios: ');
  await page.click('#charla [data-chat=reintentar]');
  await respuestaDeClaude(page, 'Ahora sí.');
  assert.equal(await page.locator('#charla .aviso-chat').count(), 0);
  assert.equal(await page.locator('#charla .msj.yo', { hasText: 'Hola de nuevo' }).count(), 1, 'no queda repetido');
  await page.click('[data-chat=nueva]');
  await page.waitForSelector('#charla .bienvenida');
  await page.keyboard.press('Escape');
});

test('chat desde la ficha: se abre encima, con la causa nombrada, sin perder lo que se estaba editando', async () => {
  await abrir(page, '1002');
  await page.fill('#c_notas', 'nota sin guardar');
  await page.click('.ppie [data-act=claude]');
  await page.waitForSelector('#charla');
  assert.equal(await page.inputValue('#chatTexto'), 'Sobre la causa 1002 (AMB c/ BETA BRUNO): ');
  await page.keyboard.press('Escape');
  assert.equal(await page.inputValue('#c_notas'), 'nota sin guardar');
  await page.keyboard.press('Escape');
  await cerrado(page);
});

test('cheques: la ficha los muestra y los guarda como cheque', async () => {
  sql(`select gestor.agregar_titulo('1002', 'cheque', 250000, null, 'Cheque N° 123')`);
  await page.waitForTimeout(2500); // el sondeo trae el cambio
  await abrir(page, '1002');
  assert.equal(await page.inputValue('#t_tipo0'), 'cheque');
  await page.fill('#c_notas', 'guardado con un cheque');
  await page.click('.ppie [data-act=save]'); await toast(page, 'Cambios guardados');
  assert.equal(sql(`select titulos -> 0 ->> 'tipo' from public.causas where expte='1002'`), 'cheque');
});

test('ubicación, estado, etiqueta cautelar y situación: se ven, se filtran, se guardan, y archivar saca la causa del listado', async () => {
  const ESTADOS = ['0. Iniciamos', '1.1 Demanda', '1.2 Contestación', '2. No oposición de excepciones', '3. Sentencia', '4. Ejecución de Sentencia', '5. Martillero Designado'];
  sql(`begin; select set_config('gestor.autor', 'Semilla', true);
    update public.causas set ubicacion = 'A despacho', estado = '5. Martillero Designado', cautelar = 'Vehículo secuestrado', situacion = 'En trámite' where expte = '1002';
    update public.causas set ubicacion = 'Casillero', estado = '', cautelar = 'Sin Cautelar', situacion = 'En trámite' where expte = '1001';
    commit;`);
  await page.waitForFunction(() => /5\. Martillero Designado/.test(document.querySelector('#main tr[data-id="1002"]')?.textContent || ''), null, { timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector('#main tr[data-id="1001"] .tag.etapa'), null, { timeout: 8000 });
  // en el listado: la ubicación en su columna; la etapa y la cautelar como etiquetas debajo de la carátula (sin cautelar, ninguna)
  assert.deepEqual(await fila(page, '1002').locator('.pill').allTextContents(), ['A despacho']);
  assert.deepEqual((await fila(page, '1002').locator('td.car .tag').allTextContents()).slice(0, 2), ['5. Martillero Designado', 'Vehículo secuestrado']);
  assert.ok(!(await fila(page, '1001').locator('.tag').allTextContents()).some((t) => /cautelar|trámite/i.test(t)));
  assert.equal(await page.evaluate(() => { const b = document.querySelector('.tablebox'); return b.scrollWidth <= b.clientWidth; }), true, 'la tabla entra en 1280 px, sin deslizar');
  // tablero: una columna por etapa, en orden, y la de las causas sin estado al final
  await page.click('#vTablero');
  assert.deepEqual(await page.locator('#main .col h3 span:first-child').allTextContents(), [...ESTADOS, '(sin estado)']);
  assert.equal(await page.locator('#main .col').nth(6).locator('.card[data-id="1002"]').count(), 1);
  assert.equal(await page.textContent('#main .card[data-id="1002"] .card-top .pill'), 'A despacho');
  assert.equal(await page.locator('#main .col').nth(7).locator('.card[data-id="1001"]').count(), 1);
  await page.click('#vLista');
  // la ficha: un desplegable por dato, con sus valores fijos
  await abrir(page, '1001');
  assert.deepEqual(await page.locator('#c_ubicacion option').allTextContents(), ['Casillero', 'A despacho']);
  assert.deepEqual(await page.locator('#c_estado option').allTextContents(), ['(sin estado)', ...ESTADOS]);
  assert.deepEqual(await page.locator('#c_cautelar option').allTextContents(), ['Sin Cautelar', 'Embargo de sueldo', 'Vehículo secuestrado']);
  assert.deepEqual(await page.locator('#c_situacion option').allTextContents(), ['En trámite', 'Acuerdo', 'Archivada']);
  assert.equal(await page.locator('.panel .chip').count(), 0, 'ya no hay etiquetas sueltas');
  await page.selectOption('#c_ubicacion', 'A despacho');
  await page.selectOption('#c_estado', '1.2 Contestación');
  await page.selectOption('#c_cautelar', 'Embargo de sueldo');
  await page.selectOption('#c_situacion', 'Archivada');
  await page.click('.ppie [data-act=save]'); await toast(page, 'Cambios guardados'); await cerrado(page);
  assert.equal(sql(`select concat_ws('|', ubicacion, estado, cautelar, situacion, actualizado_por) from public.causas where expte = '1001'`), 'A despacho|1.2 Contestación|Embargo de sueldo|Archivada|Emi');
  // archivada: sale del listado y queda en Archivadas, con su etiqueta
  assert.equal(await fila(page, '1001').count(), 0);
  await page.click('.stat[data-q="arch"]');
  assert.match(await fila(page, '1001').textContent(), /Archivada/);
  await page.click('.stat[data-q="arch"]');
  sql(`begin; select set_config('gestor.autor', 'Semilla', true); update public.causas set situacion = 'En trámite' where expte = '1001'; commit;`);
  await page.waitForFunction(() => !!document.querySelector('#main tr[data-id="1001"]'), null, { timeout: 8000 });
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
  assert.ok(await page.evaluate(() => localStorage.getItem('gj.chat')), 'la conversación con Claude también estaba guardada');
  await page.click('#btnCuenta'); await page.click('[data-m=salir]');
  await page.waitForSelector('#fIngreso');
  assert.equal(await page.evaluate(() => localStorage.getItem('gj.cache')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('gestor.sesion')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('gj.chat')), null);
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

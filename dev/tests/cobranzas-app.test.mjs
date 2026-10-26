// La app de cobranzas de punta a punta, en un navegador real contra GoTrue y PostgREST reales.
// Requiere `dev/stack.sh up` y `node dev/serve.mjs` (la app en http://127.0.0.1:8080/cobranzas/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { sql, crearCuenta, limpiar } from './helpers.mjs';

const BASE = (process.env.BASE || 'http://127.0.0.1:8080/') + 'cobranzas/';
const EMAIL = 'cobra-app@test.local', CLAVE = 'Clave-cobranzas-app-2026';
// Las fechas como las ve la app: en Córdoba.
const enCordoba = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' });
const HOY = enCordoba(new Date());
const dia = (n) => { const [y, m, d] = HOY.split('-').map(Number); return enCordoba(new Date(Date.UTC(y, m - 1, d + n, 15))); };
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const json = (o) => q(JSON.stringify(o));
const corta = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`; // como fmt de la app: 28/09/26

let browser, ctx, page;
const errores = [];
function vigilar(p, nombre) {
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|realtime|503|Failed to load resource/i.test(m.text())) errores.push(`[${nombre}] ${m.text()}`); });
  p.on('pageerror', (e) => errores.push(`[${nombre}] ${e.message}`));
}
async function nuevoContexto(opciones = {}) {
  const c = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Cordoba', viewport: { width: 1366, height: 900 }, acceptDownloads: true, ...opciones });
  await c.route('https://wa.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>WhatsApp</p>' }));
  const p = await c.newPage();
  vigilar(p, opciones.nombre || 'pc');
  return { c, p };
}
// Los importes llevan espacio duro ("$\u00a01.500"): para comparar se pasa a espacio común.
const norm = (t) => String(t ?? '').replace(/\u00a0/g, ' ');
const toast = (p, texto) => p.waitForFunction((t) => { const e = document.querySelector('#toast'); return e && !e.hidden && e.textContent.replace(/\u00a0/g, ' ').includes(t); }, texto, { timeout: 8000 });
/** Espera a que el total de la liquidación sea `valor` ("$ 330.000"). */
const totalEs = (p, valor) => p.waitForFunction((v) => document.querySelector('.tabla.rubros tfoot td:last-child')?.textContent.replace(/\u00a0/g, ' ') === v, valor);
const deudorDe = (nombre) => JSON.parse(sql(`select to_jsonb(d) from public.deudores d where nombre = ${q(nombre)}`));
const tab = async (p, t) => { await p.click(`[data-tab-ir="${t}"]`); await p.waitForSelector(`[data-tab-ir="${t}"][aria-selected="true"]`); };
async function abrir(p, nombre) {
  await p.click('#v_deudores');
  await p.fill('#q', nombre.toLowerCase());
  assert.equal(await p.locator('#main [data-abrir]').count(), 1, `un solo deudor se llama ${nombre}`);
  await p.locator('#main [data-abrir]').first().click();
  await p.waitForSelector('.panel.ficha');
}
const cerrar = async (p) => { await p.keyboard.press('Escape'); await p.waitForSelector('#drawer', { state: 'hidden' }); };

before(async () => {
  limpiar();
  sql('delete from public.deudores');
  await crearCuenta(EMAIL, CLAVE, 'Emi');
  const cuotas = (pref, vtos, importe, de) => vtos.map((v, i) => ({ id: pref + i, n: i + 1, de, vto: v, importe }));
  const filas = [
    { nombre: 'PRUEBA PAGADOR', socio: '101', tasa: 5, hon_pct: 0, telefonos: [{ numero: '3537000111', nota: '' }, { numero: '03537-400100', nota: 'fijo' }],
      operaciones: [{ id: 'op1', tipo: 'Ayuda económica con prenda', numero: '900123', ultimo_pago: dia(-100), vehiculo: { marca: 'FIAT', modelo: 'UNO', anio: '2010', dominio: 'ZZZ999' } }],
      cuotas: cuotas('a', [dia(-90), dia(-60), dia(-30), dia(30)], 100000, 4) },
    { nombre: 'PRUEBA PLANES', socio: '102', tasa: 4, hon_pct: 10, telefonos: [{ numero: '3537111222', nota: '' }], operaciones: [], cuotas: cuotas('b', [dia(-45), dia(-15)], 200000, 2) },
    { nombre: '<img src=x onerror="window.__xss=1"> XSS', socio: '103', tasa: 5, hon_pct: 0, telefonos: [], operaciones: [], cuotas: cuotas('c', [dia(-200)], 50000, 1) },
  ];
  sql(`begin; select set_config('gestor.autor', 'Semilla', true);
    insert into public.deudores (nombre, socio, tasa, hon_pct, telefonos, operaciones, cuotas)
    select x.nombre, x.socio, x.tasa, x.hon_pct, x.telefonos, x.operaciones, x.cuotas
      from jsonb_to_recordset(${json(filas)}::jsonb) x(nombre text, socio text, tasa numeric, hon_pct numeric, telefonos jsonb, operaciones jsonb, cuotas jsonb);
    update public.ajustes_cobranzas set tasa = 5, contado_pct = 80, firma = 'Dr. Emiliano Soler · Abogado' where id = 1;
    update public.modelos_mensaje set titulo = 'Aviso de deuda' where id = 'aviso'; -- lo cambia una prueba
    commit;`);
  browser = await chromium.launch();
  ({ c: ctx, p: page } = await nuevoContexto());
});
after(async () => { await browser?.close(); });

test('ingreso y tablero de inicio', async () => {
  await page.goto(BASE);
  await page.waitForSelector('#fIngreso');
  await page.fill('#i_email', EMAIL); await page.fill('#i_clave', CLAVE);
  await page.click('#fIngreso button[type=submit]');
  await page.waitForSelector('#vApp:not([hidden])');
  await page.click('#v_inicio');
  await page.waitForSelector('.kpis');
  const kpis = await page.locator('.kpi').allTextContents();
  assert.match(kpis[0], /Deuda en gestión/);
  assert.match(kpis[0], /3 deudores activos/);
  assert.match(kpis[2], /En mora, sin plan\s*3/);
  // Las barras de antigüedad: el de 200 días cae en "Más de 180", los otros dos en "61 a 90" y "31 a 60".
  const tramos = await page.locator('.tramo').evaluateAll((xs) => xs.map((x) => [x.dataset.tramo, x.querySelector('.tramo-c').textContent]));
  assert.deepEqual(tramos, [['t30', ''], ['t60', '1'], ['t90', '1'], ['t180', ''], ['tmas', '1']]);
  const ancho = await page.locator('.tramo[data-tramo="tmas"] .tramo-b i').evaluate((el) => el.style.width);
  assert.ok(parseFloat(ancho) > 0, 'la barra tiene ancho');
  // Una sola deuda, la de la app: el saldo según el sistema de la Mutual ya no aparece (0009).
  assert.doesNotMatch(norm(await page.locator('#main').textContent()), /sistema de la Mutual|capitalizable/);
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'el nombre no se ejecuta como HTML');
  // Un clic en la barra lleva al listado filtrado por antigüedad.
  await page.click('.tramo[data-tramo="tmas"]');
  await page.waitForSelector('#chips .chip.quitar');
  assert.equal(await page.locator('#main tbody tr').count(), 1);
  await page.click('#chips .chip.quitar');
  assert.equal(await page.locator('#main tbody tr').count(), 3);
});

test('listado: búsqueda, filtros y orden', async () => {
  await page.click('#v_deudores');
  await page.fill('#q', 'ZZZ999'); // por dominio del vehículo
  assert.equal(await page.locator('#main tbody tr').count(), 1);
  const fila = norm(await page.locator('#main tbody tr').textContent());
  assert.match(fila, /Pagador/);
  // El último pago que traía el listado de la Mutual: solo la fecha, sin "en la Mutual".
  assert.ok(fila.includes(corta(dia(-100))), fila);
  assert.doesNotMatch(fila, /Mutual/);
  await page.fill('#q', '');
  await page.selectOption('#fOrden', 'deuda'); // venía ordenado por mora (lo dejó así el filtro por antigüedad)
  const nombres = await page.locator('#main tbody tr td.car b').allTextContents();
  assert.equal(nombres[0], 'Prueba Planes'); // la deuda más grande primero
  await page.click('[data-chip="plan"]');
  await page.waitForSelector('#main .empty');
  await page.click('[data-chip="activos"]');
});

test('liquidación: fecha, cuotas a vencer y tasa', async () => {
  await abrir(page, 'PRUEBA PAGADOR');
  // El resumen muestra una sola deuda: las cuotas vencidas más sus intereses, sin el saldo de la Mutual.
  const cifras = await page.locator('.ficha .cifras.grandes dt').allTextContents();
  assert.match(cifras[0], /^Deuda al /);
  assert.ok(!cifras.some((t) => /Mutual/.test(t)), cifras.join(' · '));
  assert.match(norm(await page.locator('.ficha .tabcuerpo').textContent()), /La deuda es el saldo de las cuotas vencidas más sus intereses, al 5% mensual simple\./);
  // Último pago: la fecha sola, sin "(Mutual)", en el resumen y en los datos de la operación.
  const ultimo = norm(await page.locator('.ficha .cifras.grandes div', { hasText: 'Último pago' }).textContent());
  assert.equal(ultimo, `Último pago${corta(dia(-100))}`);
  await tab(page, 'datos');
  const datos = norm(await page.locator('.ficha .tabcuerpo').textContent());
  assert.ok(datos.includes(`Último pago${corta(dia(-100))}`), datos);
  assert.doesNotMatch(datos, /pago en la Mutual/);
  await tab(page, 'liquidacion');
  // 3 cuotas vencidas de $ 100.000 al 5% mensual: 90, 60 y 30 días → $ 30.000 de intereses.
  await totalEs(page, '$ 330.000');
  assert.doesNotMatch(norm(await page.locator('.ficha .tabcuerpo').textContent()), /sistema de la Mutual|capitalizable/);
  const [excel] = await Promise.all([page.waitForEvent('download'), page.click('[data-a="excel-liq"]')]);
  const trozos = []; for await (const c of await excel.createReadStream()) trozos.push(c);
  const xl = Buffer.concat(trozos);
  assert.ok(xl.includes(Buffer.from('Liquidación de deuda')), 'el Excel se lee sin comprimir');
  assert.ok(!xl.includes(Buffer.from('sistema de la Mutual')), 'el Excel no trae el saldo de la Mutual');
  await page.check('[data-k="f.liq.aVencer"]');
  await totalEs(page, '$ 430.000');
  await page.uncheck('[data-k="f.liq.aVencer"]');
  await page.fill('[data-k="f.liq.fecha"]', dia(-30));
  await totalEs(page, '$ 315.000');
  await page.fill('[data-k="f.liq.fecha"]', HOY);
  await page.fill('#f_tasa', '4');
  await page.locator('#f_tasa').blur();
  await toast(page, 'Tasa guardada');
  assert.equal(deudorDe('PRUEBA PAGADOR').tasa, 4);
  await totalEs(page, '$ 324.000');
});

test('gastos: se agregan y son un rubro más', async () => {
  await page.click('[data-a="gasto-nuevo"]');
  await page.fill('[data-k="f.gasto.concepto"]', 'Tasa de justicia');
  await page.fill('[data-k="f.gasto.monto"]', '5.000');
  await page.click('[data-a="gasto-guardar"]');
  await toast(page, 'Gasto agregado');
  const d = deudorDe('PRUEBA PAGADOR');
  assert.equal(d.gastos.length, 1);
  assert.equal(d.gastos[0].monto, 5000);
  assert.ok(await page.locator('.tabla.rubros td', { hasText: 'Tasa de justicia' }).count());
});

test('pagos: imputación a mano por rubro, validación y registro', async () => {
  await tab(page, 'pagos');
  await page.click('[data-a="pago-nuevo"]');
  await page.fill('[data-k="f.pago.monto"]', '150.000');
  await page.fill('[data-k="f.pago.recibo"]', 'R-0001');
  await page.selectOption('[data-k="f.pago.medio"]', 'Transferencia');
  await page.fill('[data-k="f.pago.imp.intereses"]', '20.000');
  // "Completar" en capital pone lo que falta del pago (130.000), sin pasar el saldo del rubro.
  await page.click('[data-a="pago-completar"][data-id="capital"]');
  assert.equal(await page.inputValue('[data-k="f.pago.imp.capital"]'), '130.000');
  assert.match(await page.textContent('#pagoPie'), /completo/);
  // Si la imputación no suma el monto, no se guarda.
  await page.fill('[data-k="f.pago.imp.capital"]', '100.000');
  await page.click('[data-a="pago-guardar"]');
  await toast(page, 'La imputación suma $ 120.000 y el pago es de $ 150.000');
  assert.equal(deudorDe('PRUEBA PAGADOR').pagos.length, 0);
  await page.fill('[data-k="f.pago.imp.capital"]', '125.000');
  const gasto = deudorDe('PRUEBA PAGADOR').gastos[0].id;
  await page.fill(`[data-k="f.pago.imp.${gasto}"]`, '5.000');
  await page.click('[data-a="pago-guardar"]');
  await toast(page, 'Pago de $ 150.000 registrado');
  const p = deudorDe('PRUEBA PAGADOR').pagos;
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].imp, { intereses: 20000, capital: 125000, [gasto]: 5000 });
  assert.equal(p[0].recibo, 'R-0001');
  assert.equal(p[0].medio, 'Transferencia');
  assert.equal(p[0].fecha, HOY);
  // Ofrece mandar la confirmación (tiene celular).
  await page.waitForSelector('[data-a="ir-recibo"]');
  await page.click('[data-a="tras-pago-no"]');
  assert.match(norm(await page.locator('.pagos li').first().textContent()), /\$ 150\.000/);
});

test('plan de pagos: simulación, propuesta por WhatsApp, guardado, pago del plan y caída', async () => {
  await cerrar(page);
  await abrir(page, 'PRUEBA PLANES');
  await tab(page, 'plan');
  await page.click('[data-a="plan-nuevo"]');
  await page.fill('[data-k="f.plan.quitaPct"]', '10');
  await page.fill('[data-k="f.plan.anticipo"]', '50.000');
  await page.fill('[data-k="f.plan.n"]', '3');
  await page.fill('[data-k="f.plan.primerVto"]', dia(30));
  const vista = await page.textContent('#planVista');
  assert.match(vista, /un anticipo de \$\s50\.000 y 3 cuotas mensuales/);
  // La propuesta va al mensaje sin guardar el plan.
  await page.click('[data-a="plan-whatsapp"]');
  await page.waitForSelector('[data-tab-ir="mensaje"][aria-selected="true"]');
  assert.match(await page.inputValue('#msgTexto'), /le propongo un plan de pagos: un anticipo de \$\s50\.000 y 3 cuotas mensuales/);
  assert.equal(deudorDe('PRUEBA PLANES').planes.length, 0);
  await tab(page, 'plan');
  await page.click('[data-a="plan-guardar"]');
  await toast(page, 'Plan guardado');
  let d = deudorDe('PRUEBA PLANES');
  assert.equal(d.planes.length, 1);
  const plan = d.planes[0];
  assert.equal(plan.estado, 'vigente');
  assert.equal(plan.cuotas.length, 3);
  assert.equal(plan.anticipo, 50000);
  assert.ok(plan.quita > 0);
  assert.ok(Math.abs(plan.cuotas.reduce((a, c) => a + c.importe, 0) + plan.anticipo + plan.quita - plan.deuda) < 1, 'cuotas + anticipo + quita = deuda (al peso)');
  assert.ok(plan.cuotas.every((c) => Number.isInteger(c.importe)), 'las cuotas van en pesos enteros');
  assert.match(d.gestiones.at(-1).texto, /Plan de pagos acordado/);
  // Pago del anticipo, "repartido como el plan".
  await page.click('[data-a="ir-pago-plan"]');
  await page.waitForSelector('[data-k="f.pago.plan"]:checked');
  assert.equal(await page.inputValue('[data-k="f.pago.monto"]'), '50.000');
  await page.click('[data-a="pago-como-plan"]');
  assert.match(await page.textContent('#pagoPie'), /completo/);
  await page.click('[data-a="pago-guardar"]');
  await toast(page, 'registrado');
  d = deudorDe('PRUEBA PLANES');
  assert.equal(d.pagos[0].plan, plan.id);
  assert.ok(d.pagos[0].imp.honorarios > 0, 'el reparto incluye honorarios (10%)');
  // En la vista de planes aparece al día, con el anticipo pagado.
  await cerrar(page);
  await page.click('#v_planes');
  await page.waitForSelector('.plan-card');
  assert.match(await page.textContent('.plan-card'), /Al día/);
  assert.match(await page.textContent('.plan-card'), /Cuota 1 de 3/);
  // Se da por caído: vuelve la deuda original.
  await page.click('.plan-card .enlace');
  await page.waitForSelector('[data-tab-ir="plan"][aria-selected="true"]');
  await page.click('[data-a="confirmar"][data-que="caer"]');
  await page.click('[data-a="plan-caer"]');
  await toast(page, 'Plan dado por caído');
  d = deudorDe('PRUEBA PLANES');
  assert.equal(d.planes[0].estado, 'caido');
  assert.match(await page.textContent('.ficha .phead'), /En mora/);
  await cerrar(page);
});

test('gestiones: promesa de pago para hoy y próxima acción en el tablero', async () => {
  await abrir(page, 'PRUEBA PAGADOR');
  await tab(page, 'gestiones');
  await page.selectOption('[data-k="f.gest.tipo"]', 'Promesa de pago');
  await page.waitForSelector('[data-k="f.gest.pfecha"]');
  await page.fill('[data-k="f.gest.pfecha"]', HOY);
  await page.fill('[data-k="f.gest.pmonto"]', '80.000');
  await page.fill('[data-k="f.gest.texto"]', 'Dice que transfiere hoy');
  await page.click('[data-a="gestion-guardar"]');
  await toast(page, 'Gestión anotada');
  await page.fill('[data-k="f.prox.texto"]', 'Llamar para confirmar la transferencia');
  await page.fill('[data-k="f.prox.vence"]', HOY);
  await page.click('[data-a="prox-guardar"]');
  await toast(page, 'Próxima acción guardada');
  const d = deudorDe('PRUEBA PAGADOR');
  assert.equal(d.gestiones.at(-1).promesa_monto, 80000);
  assert.equal(d.proxima, 'Llamar para confirmar la transferencia');
  await cerrar(page);
  await page.click('#v_inicio');
  assert.match(await page.locator('.kpi').nth(4).textContent(), /Promesas para hoy\s*1/);
  const pend = (await page.locator('.pitem').allTextContents()).map(norm);
  assert.ok(pend.some((t) => /Prometió pagar \$ 80\.000/.test(t)), pend.join(' | '));
  assert.ok(pend.some((t) => /Llamar para confirmar/.test(t)), pend.join(' | '));
  // ✓ Realizada: pasa al historial.
  await page.locator('.pitem', { hasText: 'Llamar para confirmar' }).click();
  await page.waitForSelector('[data-tab-ir="gestiones"][aria-selected="true"]');
  await page.click('[data-a="prox-hecha"]');
  await toast(page, 'Acción realizada');
  const e = deudorDe('PRUEBA PAGADOR');
  assert.equal(e.proxima, '');
  assert.equal(e.gestiones.at(-1).hecha, true);
});

test('WhatsApp: el mensaje se arma con los datos, el enlace lleva número y texto, y queda anotado', async () => {
  await tab(page, 'mensaje');
  await page.selectOption('[data-k="f.msg.modelo"]', 'aviso');
  const texto = await page.inputValue('#msgTexto');
  assert.match(texto, /Hola Prueba Pagador, le escribo del Estudio Soler, en representación de Asociación Mutual Bell/);
  // El pago a capital canceló la cuota 1 y parte de la 2 (en orden de vencimiento).
  assert.match(texto, /su ayuda económica con garantía prendaria N° 900123 tiene las cuotas 2 y 3 de 4 sin pagar/);
  assert.match(texto, /Dr\. Emiliano Soler · Abogado/);
  // Solo el celular: el fijo (03537-…) no tiene WhatsApp.
  assert.deepEqual(await page.locator('[data-k="f.msg.numero"] option').evaluateAll((os) => os.map((o) => o.value)), ['5493537000111']);
  await page.fill('#msgTexto', texto + '\nSaludos.');
  const href = await page.getAttribute('#msgAbrir', 'href');
  assert.ok(href.startsWith('https://wa.me/5493537000111?text='));
  assert.match(decodeURIComponent(href.split('text=')[1]), /Saludos\.$/);
  const nueva = ctx.waitForEvent('page');
  await page.click('#msgAbrir');
  const pestaña = await nueva; await pestaña.close();
  await toast(page, 'Mensaje anotado');
  const g = deudorDe('PRUEBA PAGADOR').gestiones.at(-1);
  assert.equal(g.tipo, 'WhatsApp');
  assert.match(g.texto, /Aviso de deuda \(a 3537000111\)/);
});

test('datos: edición con generador de cuotas, sin pisar lo que cambió Claude mientras tanto', async () => {
  await tab(page, 'datos');
  await page.click('[data-a="editar"]');
  await page.fill('[data-k="f.edit.trato"]', 'Juan');
  await page.click('[data-a="tel-agregar"]');
  await page.fill('[data-k="f.edit.telefonos.2.numero"]', '3534 15 123456');
  await page.fill('[data-k="f.edit.gen.n0"]', '5'); await page.fill('[data-k="f.edit.gen.de"]', '6');
  await page.fill('[data-k="f.edit.gen.cant"]', '2'); await page.fill('[data-k="f.edit.gen.vto"]', dia(60));
  await page.fill('[data-k="f.edit.gen.importe"]', '100.000');
  await page.click('[data-a="cuotas-generar"]');
  await toast(page, '2 cuotas agregadas');
  // Mientras tanto, Claude anota algo en el mismo deudor.
  sql(`begin; select set_config('gestor.autor', 'Claude', true); update public.deudores set notas = 'Nota de Claude' where nombre = 'PRUEBA PAGADOR'; commit;`);
  await page.click('[data-a="editar-guardar"]');
  await toast(page, 'Cambios guardados');
  const d = deudorDe('PRUEBA PAGADOR');
  assert.equal(d.trato, 'Juan');
  assert.equal(d.notas, 'Nota de Claude', 'lo de Claude se conserva');
  assert.equal(d.telefonos.length, 3);
  assert.equal(d.cuotas.length, 6);
  assert.deepEqual(d.cuotas.slice(-2).map((c) => [c.n, c.de, c.importe]), [[5, 6, 100000], [6, 6, 100000]]);
  await tab(page, 'mensaje');
  // El texto se había editado a mano: queda como estaba hasta que se pide volver al modelo.
  assert.match(await page.inputValue('#msgTexto'), /Saludos\.$/);
  await page.click('[data-a="msg-regenerar"]');
  assert.match(await page.inputValue('#msgTexto'), /^Hola Juan,/);
  assert.equal(await page.locator('[data-k="f.msg.numero"] option').count(), 2); // el 3534 15 … también es celular
  await cerrar(page);
});

test('lo que registra Claude por SQL aparece solo en la ficha abierta', async () => {
  await abrir(page, 'PRUEBA PLANES');
  await tab(page, 'pagos');
  const id = sql(`select id from public.deudores where nombre = 'PRUEBA PLANES'`);
  sql(`select gestor.registrar_pago('${id}', '${HOY}', '{"intereses": 1234}', 'C-9', 'Efectivo')`);
  await page.waitForFunction(() => [...document.querySelectorAll('.pagos li')].some((li) => li.textContent.includes('1.234')), null, { timeout: 15000 });
  await cerrar(page);
});

test('cobros del mes y descarga en Excel', async () => {
  await page.click('#v_cobros');
  await page.waitForSelector('table.cobros');
  assert.equal(await page.locator('table.cobros tbody tr').count(), 3);
  const pie = await page.locator('table.cobros tfoot td').allTextContents();
  assert.equal(norm(pie.at(-1)), '$ 201.234');
  const [descarga] = await Promise.all([page.waitForEvent('download'), page.click('[data-a="excel-cobros"]')]);
  assert.match(descarga.suggestedFilename(), /^cobros-\d{4}-\d{2}\.xlsx$/);
  const partes = []; for await (const c of await descarga.createReadStream()) partes.push(c);
  const buf = Buffer.concat(partes);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'es un zip (xlsx)');
  assert.ok(buf.includes(Buffer.from('PRUEBA PAGADOR')));
  // El listado de deudores en Excel, sin la columna del saldo según la Mutual.
  await page.click('#btnCuenta');
  const [lista] = await Promise.all([page.waitForEvent('download'), page.click('[data-m="exportar"]')]);
  assert.match(lista.suggestedFilename(), /^deudores-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const trozos = []; for await (const c of await lista.createReadStream()) trozos.push(c);
  const xl = Buffer.concat(trozos);
  assert.ok(xl.includes(Buffer.from('Saldo exigible')));
  assert.ok(!xl.includes(Buffer.from('Según la Mutual')));
});

test('nuevo deudor con sus cuotas impagas', async () => {
  await page.click('#btnNuevo');
  await page.fill('[data-k="nuevo.nombre"]', 'Nuevo Deudor De Prueba');
  await page.fill('[data-k="nuevo.socio"]', '999');
  await page.fill('[data-k="nuevo.telefono"]', '3537 123456');
  await page.fill('[data-k="nuevo.numero"]', '777');
  await page.fill('[data-k="nuevo.n0"]', '3'); await page.fill('[data-k="nuevo.de"]', '6');
  await page.fill('[data-k="nuevo.vto"]', dia(-40));
  await page.fill('[data-k="nuevo.importe"]', '10.000');
  assert.match(await page.textContent('#nuevoVista'), /Se cargan 4 cuotas \(3 a 6 de 6\): 2 vencidas y 2 a vencer/);
  await page.click('[data-a="nuevo-crear"]');
  await toast(page, 'Deudor creado');
  await page.waitForSelector('.panel.ficha');
  const d = deudorDe('NUEVO DEUDOR DE PRUEBA');
  assert.equal(d.cuotas.length, 4);
  assert.equal(d.operaciones[0].numero, '777');
  assert.equal(d.tasa, 5);
  assert.equal(d.actualizado_por, 'Emi');
  // Eliminar, con confirmación.
  await tab(page, 'datos');
  await page.click('[data-a="confirmar"][data-que="borrar"]');
  await page.click('[data-a="borrar"]');
  await toast(page, 'Deudor eliminado');
  assert.equal(sql(`select count(*) from public.deudores where nombre = 'NUEVO DEUDOR DE PRUEBA'`), '0');
});

test('modelos de mensaje y ajustes', async () => {
  await page.click('#btnMensajes');
  await page.waitForSelector('[data-k="modelos.aviso.titulo"]');
  assert.doesNotMatch(await page.locator('.campos').textContent(), /deuda_sistema/);
  await page.fill('[data-k="modelos.aviso.titulo"]', 'Aviso de deuda (1)');
  await page.click('[data-a="modelo-guardar"][data-id="aviso"]');
  await toast(page, 'Modelo guardado');
  assert.equal(sql(`select titulo from public.modelos_mensaje where id = 'aviso'`), 'Aviso de deuda (1)');
  await cerrar(page);
  await page.click('#btnAjustes');
  await page.waitForSelector('[data-k="aj.contado_pct"]');
  assert.equal(await page.locator('[data-k="aj.tasa_sistema"]').count(), 0, 'sin la tasa del sistema de la Mutual');
  await page.fill('[data-k="aj.contado_pct"]', '75');
  await page.click('[data-a="ajustes-guardar"]');
  await toast(page, 'Ajustes guardados');
  assert.equal(sql(`select contado_pct from public.ajustes_cobranzas`), '75.0000');
});

test('acceso al gestor de juicios: al pie de la barra y en el menú; abre el gestor ya adentro', async () => {
  const GESTOR = new URL('../', BASE).href;
  const enlace = page.locator('.lateral .otra-app');
  assert.deepEqual(await enlace.evaluate((a) => [a.href, a.target, a.getAttribute('aria-label')]), [GESTOR, '_blank', 'Abrir el gestor de juicios']);
  const [otra] = await Promise.all([page.context().waitForEvent('page'), enlace.click()]);
  await otra.waitForSelector('#vApp:not([hidden])'); // la misma sesión: no pide ingresar
  await otra.close();
  // Desde el menú de la cuenta; al seguir el enlace, el menú se cierra.
  await page.click('#btnCuenta'); await page.waitForSelector('.menu');
  const op = page.locator('.menu a.op', { hasText: 'Abrir el gestor de juicios' });
  const [otra2] = await Promise.all([page.context().waitForEvent('page'), op.click()]);
  await otra2.waitForURL(GESTOR); await otra2.close();
  await page.waitForSelector('#menu', { state: 'hidden' });
});

test('celular: tarjetas, ficha a pantalla completa y nada se sale de costado', async () => {
  const { c, p } = await nuevoContexto({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, nombre: 'celular' });
  await p.goto(BASE);
  await p.waitForSelector('#fIngreso, #vApp:not([hidden])');
  if (await p.$('#fIngreso')) { await p.fill('#i_email', EMAIL); await p.fill('#i_clave', CLAVE); await p.click('#fIngreso button[type=submit]'); }
  await p.waitForSelector('#vApp:not([hidden])');
  for (const v of ['inicio', 'deudores', 'planes', 'cobros']) {
    await p.click('#v_' + v); await p.waitForTimeout(100);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `la vista ${v} no se sale de costado`);
  }
  await p.click('#v_deudores');
  await p.locator('#main .fila').first().click();
  await p.waitForSelector('.panel.ficha');
  for (const t of ['resumen', 'liquidacion', 'pagos', 'plan', 'gestiones', 'mensaje', 'datos']) {
    await p.click(`[data-tab-ir="${t}"]`);
    assert.ok(await p.evaluate(() => { const pn = document.querySelector('.panel'); return pn.scrollWidth <= pn.clientWidth + 1; }), `la pestaña ${t} entra en el ancho del celular`);
  }
  await c.close();
});

test('sin errores en la consola', () => {
  assert.deepEqual(errores, []);
});

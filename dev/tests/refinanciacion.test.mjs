// Estado de Deuda y Refinanciación (docs/cobranzas/refinanciacion.js): las cuentas de la planilla del estudio
// con las funciones de la app. No necesita el stack. El caso es el de la planilla "CALCULO_INTERESES":
// cuota de $ 1.127.150, 3 % mensual de interés, 5 % de honorarios, cuotas 1 a 4 impagas desde el 10/10/2025.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nuevaRefi as formNuevo, estadoRefi, htmlRefi, htmlEstadoRefi, htmlPlanRefi, deudorManual, vto1Efectivo } from '../../docs/cobranzas/refinanciacion.js';
import { liquidar } from '../../docs/cobranzas/calculo.js';
import { TASA_MENSUAL } from '../../docs/cobranzas/vehiculos.js';

// Casi todas las pruebas son de las cuentas del plan: parten con el plan abierto (formNuevo es el formulario de verdad).
const nuevaRefi = (t) => ({ ...formNuevo(t), plan: true });
const cerca = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const HOY = '2026-11-04';
const deudor = (extra = {}) => ({
  id: 'd1', tasa: 3, hon_pct: 5, pagos: [], gastos: [], planes: [],
  cuotas: [
    ...['2025-10-10', '2025-11-10', '2025-12-10', '2026-01-10'].map((vto, i) => ({ id: 'c' + i, n: i + 1, de: 24, vto, importe: 1127150 })),
    ...['2027-01-10', '2027-02-10'].map((vto, i) => ({ id: 'f' + i, n: 21 + i, de: 24, vto, importe: 1050000 })), // a vencer: 2.100.000
  ],
  ...extra,
});

test('la deuda vencida da lo mismo que la planilla de Excel', () => {
  const e = estadoRefi(deudor(), nuevaRefi(), HOY);
  const r = (id) => e.liq.rubros.find((x) => x.id === id).saldo;
  cerca(r('capital'), 4_508_600);
  cerca(r('intereses'), 1_550_958.4);
  cerca(r('honorarios'), 302_977.92);
  cerca(e.deuda, 6_362_536.32);
  assert.equal(e.liq.vencidas, 4);
});

test('con gastos, cuotas a vencer, intereses a vencer y entrega sale el saldo a financiar de la planilla', () => {
  const R = { ...nuevaRefi(), justicia: '400.000', martillero: '1.200.000', abogado: '2.500.000', aVencer: true, iVencer: '50.000', entrega: '100.000' };
  const e = estadoRefi(deudor(), R, HOY);
  cerca(e.deuda, 6_362_536.32 + 400_000 + 1_200_000 + 2_500_000 + 2_100_000 - 50_000);
  cerca(e.plan.financiado, e.deuda - 100_000);
  assert.equal(e.entrega, 100_000);
});

test('las cuotas a vencer y sus intereses solo cuentan si se las incluye', () => {
  const R = { ...nuevaRefi(), iVencer: '50.000' };
  assert.equal(estadoRefi(deudor(), R, HOY).iVencer, 0);
  const sin = estadoRefi(deudor(), R, HOY).deuda;
  cerca(estadoRefi(deudor(), { ...R, aVencer: true }, HOY).deuda, sin + 2_100_000 - 50_000);
});

test('el plan: cuota fija sobre saldo con la tasa de los créditos prendarios, editable', () => {
  assert.equal(nuevaRefi().tasa, String(TASA_MENSUAL));
  const R = { ...nuevaRefi(), cuotas: '12', primerVto: '2026-12-10' };
  const e = estadoRefi(deudor(), R, HOY), i = TASA_MENSUAL / 100;
  const esperada = e.plan.financiado * i / (1 - (1 + i) ** -12);
  cerca(e.plan.cuota, esperada, 100); // las cuotas van en pesos redondeados a la centena
  assert.equal(e.plan.cuotas.length, 12);
  assert.equal(e.plan.cuotas[0].vto, '2026-12-10');
  assert.equal(e.plan.cuotas[11].vto, '2027-11-10');
  const otra = estadoRefi(deudor(), { ...R, tasa: '3' }, HOY);
  assert.ok(otra.plan.cuota < e.plan.cuota, 'con menos tasa, menos cuota');
  const sinInteres = estadoRefi(deudor(), { ...R, tasa: '0' }, HOY);
  cerca(sinInteres.plan.total, sinInteres.plan.financiado, 100);
});

test('sin primer vencimiento escrito, vence un mes después de la fecha de cálculo; las cuotas se limitan', () => {
  assert.equal(estadoRefi(deudor(), nuevaRefi(), HOY).primerVto, '2026-12-04');
  assert.equal(estadoRefi(deudor(), { ...nuevaRefi(), fecha: '2026-01-31' }, HOY).primerVto, '2026-02-28');
  assert.equal(estadoRefi(deudor(), { ...nuevaRefi(), cuotas: '999' }, HOY).n, 120);
  assert.equal(estadoRefi(deudor(), { ...nuevaRefi(), cuotas: '' }, HOY).n, 1);
});

test('los pagos que ya hizo se descuentan (lo mismo que su liquidación)', () => {
  const d = deudor({ pagos: [{ id: 'p1', fecha: '2026-08-10', imp: { capital: 250000 } }] });
  const e = estadoRefi(d, nuevaRefi(), HOY), liq = liquidar(d, HOY);
  cerca(e.deuda, liq.total.saldo);
  assert.ok(e.deuda < estadoRefi(deudor(), nuevaRefi(), HOY).deuda);
});

test('sin deuda o con una entrega que la cubre no hay nada para financiar', () => {
  const sin = estadoRefi(deudor({ cuotas: [] }), nuevaRefi(), HOY);
  assert.equal(sin.deuda, 0);
  assert.match(htmlRefi(sin), /No hay deuda para refinanciar/);
  const cubre = estadoRefi(deudor(), { ...nuevaRefi(), entrega: '99.000.000' }, HOY);
  assert.equal(cubre.plan.financiado, 0);
  assert.ok(cubre.sobra);
  assert.match(htmlRefi(cubre), /no queda nada para financiar/);
  assert.ok(estadoRefi(null, nuevaRefi(), HOY).manual, 'sin deudor, lo cargado a mano');
});

test('lo cargado por la persona se escapa antes de mostrarse', () => {
  const d = deudor({ gastos: [{ id: 'g1', concepto: '<img src=x onerror=alert(1)>', monto: 1000, fecha: '2026-01-01' }] });
  const html = htmlRefi(estadoRefi(d, nuevaRefi(), HOY));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('el resultado muestra el estado, la cuota y el cronograma', () => {
  const html = htmlRefi(estadoRefi(deudor(), { ...nuevaRefi(), entrega: '100.000', cuotas: '6', primerVto: '2026-12-10' }, HOY));
  for (const t of ['Estado de deuda al 04/11/26', 'Intereses moratorios (3% mensual)', 'Honorarios (5%)', 'Deuda a refinanciar', '(−) Entrega inicial', 'Saldo a financiar', '6 cuotas mensuales de', '10/12/26', '10/05/27']) assert.ok(html.includes(t), t);
});

// ── Cargado a mano, como la planilla: 4 cuotas de $ 1.127.150 desde el 10/10/2025, todas vencidas ──
const PLANILLA = { ...nuevaRefi('3'), cuota: '1.127.150', cantCuotas: '4', vto1: '2025-10-10', hon: '5' };

test('a mano da lo mismo que la planilla de Excel y que el mismo caso cargado como deudor', () => {
  const e = estadoRefi(null, PLANILLA, HOY);
  assert.equal(e.manual, true);
  assert.equal(e.liq.cuotas.length, 4);
  cerca(e.deuda, 6_362_536.32);
  cerca(e.deuda, estadoRefi(deudor({ cuotas: deudor().cuotas.slice(0, 4) }), nuevaRefi(), HOY).deuda);
});

test('a mano: un pago parcial baja la deuda desde su fecha y se puede imputar a otro rubro', () => {
  const sin = estadoRefi(null, PLANILLA, HOY).deuda;
  const con = estadoRefi(null, { ...PLANILLA, pagos: [{ fecha: '2026-08-10', monto: '250.000', imp: 'capital' }] }, HOY);
  assert.ok(con.deuda < sin - 250_000, 'baja más que el pago: deja de correr el interés');
  const aInt = estadoRefi(null, { ...PLANILLA, pagos: [{ fecha: '2026-08-10', monto: '250.000', imp: 'intereses' }] }, HOY);
  cerca(aInt.deuda, sin - 250_000);
  const incompleto = estadoRefi(null, { ...PLANILLA, pagos: [{ fecha: '', monto: '250.000', imp: 'capital' }] }, HOY);
  cerca(incompleto.deuda, sin); // un pago sin fecha no cuenta todavía
});

test('a mano: las cuotas que no vencieron son "a vencer" y solo entran si se las incluye', () => {
  const R = { ...PLANILLA, cantCuotas: '24', mora: '5' }; // en mora desde la 5 a la 24: hoy vencieron la 5 a la 13
  const e = estadoRefi(null, R, HOY);
  assert.equal(e.liq.vencidas, 9);
  cerca(e.liq.capital_a_vencer, 11 * 1_127_150);
  cerca(estadoRefi(null, { ...R, aVencer: true }, HOY).deuda, e.deuda + 11 * 1_127_150);
});

test('a mano: gastos, entrega y plan salen como con un deudor', () => {
  const R = { ...PLANILLA, justicia: '400.000', martillero: '1.200.000', abogado: '2.500.000', otros: '10.000', entrega: '100.000', cuotas: '12', primerVto: '2026-12-10' };
  const e = estadoRefi(null, R, HOY);
  cerca(e.deuda, 6_362_536.32 + 400_000 + 1_200_000 + 2_500_000 + 10_000);
  cerca(e.plan.financiado, e.deuda - 100_000);
  assert.match(htmlRefi(e), /Otros gastos/);
  assert.match(htmlRefi(e), /Cuotas que faltan pagar/);
});

test('a mano sin datos no inventa una deuda y pide completar', () => {
  const e = estadoRefi(null, nuevaRefi(), HOY);
  assert.equal(e.deuda, 0);
  assert.match(htmlRefi(e), /Completá la cuota/);
  assert.equal(deudorManual({ ...nuevaRefi(), cuota: '1000', cantCuotas: '3' }).cuotas.length, 0, 'sin primer vencimiento no hay cuotas');
  assert.equal(deudorManual({ ...nuevaRefi(), cuota: '1000', cantCuotas: '999', vto1: '2026-01-31' }).cuotas.length, 120);
});

// ───────────────────────── Casos guardados ─────────────────────────
import { datosCaso, restaurarCaso } from '../../docs/cobranzas/refinanciacion.js';

test('datosCaso: sin buscador y sin fecha de cálculo (un caso siempre se calcula a hoy)', () => {
  const R = formNuevo('5'); R.q = 'perez'; R.cuota = '100.000'; R.fecha = '2026-10-01';
  const d = datosCaso(R);
  assert.equal('q' in d, false);
  assert.equal('fecha' in d, false);
  assert.equal(d.cuota, '100.000');
  assert.equal(R.q, 'perez', 'no toca el original');
});

test('restaurarCaso: ida y vuelta da el mismo formulario (menos el buscador)', () => {
  const R = formNuevo('5');
  Object.assign(R, { cuota: '50.000', cantCuotas: '24', vto1: '2026-03-10', moraTipo: 'cuota', mora: '3', hon: '8', aVencer: true, cada: 'quincena', entrega: '200.000',
    pagos: [{ fecha: '2026-05-01', monto: '30.000', imp: 'intereses' }] });
  const vuelta = restaurarCaso(JSON.parse(JSON.stringify(datosCaso(R))), '5');
  assert.deepEqual(vuelta, R);
  const a = estadoRefi(null, R, '2026-11-04'), b = estadoRefi(null, vuelta, '2026-11-04');
  assert.equal(b.deuda, a.deuda);
  assert.deepEqual(b.plan.cuotas, a.plan.cuotas);
});

test('restaurarCaso: datos vacíos, rotos o de otra forma no rompen nada', () => {
  assert.deepEqual(restaurarCaso({}, '5'), formNuevo('5'));
  assert.deepEqual(restaurarCaso(null, '5'), formNuevo('5'));
  assert.deepEqual(restaurarCaso([1, 2], '7'), formNuevo('7'));
  const r = restaurarCaso({ fuente: 'deudor', aVencer: 'si', cada: 'siglo', cuota: { x: 1 }, pagos: [null, 3, { imp: 'otro', monto: 5 }], inventado: 1 }, '5');
  assert.equal(r.fuente, 'mano', 'un deudor sin id vuelve a mano');
  assert.equal(r.aVencer, false);
  assert.equal(r.cada, 'mes');
  assert.equal(r.cuota, '');
  assert.deepEqual(r.pagos, [{ fecha: '', monto: '5', imp: 'capital' }]);
  assert.equal('inventado' in r, false);
  assert.equal(restaurarCaso({ fuente: 'deudor', id: 'abc' }, '5').fuente, 'deudor');
});

// ───────────────────────── Mora y plan abierto con un botón ─────────────────────────
// El crédito: 24 cuotas de $ 1.127.150, la 1ª el 10/10/2025. HOY = 04/11/2026: vencieron la 1 a la 13.
const CREDITO = { ...formNuevo('3'), cuota: '1.127.150', cantCuotas: '24', vto1: '2025-10-10', hon: '5' };
const numeros = (R) => deudorManual(R).cuotas.map((c) => c.n);

test('mora desde un N° de cuota: las anteriores se toman como pagadas', () => {
  assert.equal(numeros(CREDITO).length, 24, 'sin dato de mora, cuenta desde la cuota 1');
  assert.deepEqual(numeros({ ...CREDITO, moraTipo: 'cuota', mora: '22' }), [22, 23, 24]);
  assert.deepEqual(numeros({ ...CREDITO, mora: '1' }).length, 24);
  assert.equal(numeros({ ...CREDITO, mora: '30' }).length, 0, 'más allá de la última: nada que cobrar');
});

test('mora desde una fecha: cuentan las cuotas que vencen en esa fecha o después', () => {
  const R = { ...CREDITO, moraTipo: 'fecha', mora: '2026-03-10' };
  assert.deepEqual(numeros(R).slice(0, 2), [6, 7], 'la cuota 6 vence el 10/03/2026');
  assert.equal(numeros({ ...R, mora: '2026-03-11' })[0], 7);
  assert.equal(numeros({ ...R, mora: 'cualquier cosa' }).length, 24, 'una fecha inválida no filtra');
  assert.equal(numeros({ ...CREDITO, moraTipo: 'fecha', mora: '5' }).length, 24, 'el N° de cuota no se usa como fecha');
});

test('mora por cuota o por fecha dan la misma deuda si apuntan al mismo punto', () => {
  const a = estadoRefi(null, { ...CREDITO, mora: '5' }, HOY), b = estadoRefi(null, { ...CREDITO, moraTipo: 'fecha', mora: '2026-02-10' }, HOY);
  assert.equal(a.deuda, b.deuda);
  assert.equal(a.liq.vencidas, 9, 'vencidas la 5 a la 13');
});

test('el plan de refinanciación no se arma solo', () => {
  const cerrado = { ...CREDITO, mora: '5', aVencer: true, iVencer: '50.000', entrega: '100.000' }; // plan: false
  const e = estadoRefi(null, cerrado, HOY);
  assert.equal(e.conPlan, false);
  assert.equal(e.aVencer, 0, 'las cuotas a vencer son del plan');
  assert.equal(e.iVencer, 0);
  assert.equal(e.entrega, 0);
  assert.equal(e.deuda, estadoRefi(null, { ...CREDITO, mora: '5' }, HOY).deuda);
  assert.match(htmlEstadoRefi(e), /Total adeudado/);
  assert.doesNotMatch(htmlRefi(e), /Refinanciación|Deuda a refinanciar|cuotas mensuales/);
  const abierto = estadoRefi(null, { ...cerrado, plan: true }, HOY);
  assert.ok(abierto.deuda > e.deuda, 'abierto, suma las cuotas a vencer');
  assert.match(htmlRefi(abierto), /Refinanciación/);
  assert.match(htmlEstadoRefi(abierto), /Deuda a refinanciar/);
  assert.match(htmlPlanRefi(abierto), /cuotas mensuales de/);
});

test('un caso guardado conserva la mora y si el plan estaba abierto', () => {
  const R = { ...CREDITO, moraTipo: 'fecha', mora: '2026-03-10', plan: true };
  const v = restaurarCaso(JSON.parse(JSON.stringify(datosCaso(R))), '3');
  assert.equal(v.moraTipo, 'fecha'); assert.equal(v.mora, '2026-03-10'); assert.equal(v.plan, true);
  assert.equal(restaurarCaso({ moraTipo: 'otra', plan: 'si' }, '3').moraTipo, 'cuota');
  assert.equal(restaurarCaso({ plan: 'si' }, '3').plan, false);
});

test('sin vto. de la cuota 1: sale de la cuota en mora y su vencimiento', () => {
  const B = { ...formNuevo('3'), cuota: '1000', cantCuotas: '12', moraTipo: 'cuota', mora: '5', moraVto: '2026-05-10' };
  assert.equal(vto1Efectivo(B), '2026-01-10');
  const c = deudorManual(B).cuotas;
  assert.deepEqual(c.map((x) => x.n), [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(c[0].vto, '2026-05-10');
  assert.equal(vto1Efectivo({ ...B, vto1: '2026-02-10' }), '2026-02-10', 'si se escribió, vale lo escrito');
  assert.equal(vto1Efectivo({ ...B, moraTipo: 'fecha' }), '', 'con fecha de mora no alcanza');
  assert.equal(vto1Efectivo({ ...B, mora: '' }), '');
  assert.equal(vto1Efectivo({ ...B, mora: '3', moraVto: '2026-03-31' }), '2026-01-31');
});

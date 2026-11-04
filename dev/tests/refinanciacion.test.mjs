// Estado de Deuda y Refinanciación (docs/cobranzas/refinanciacion.js): las cuentas de la planilla del estudio
// con las funciones de la app. No necesita el stack. El caso es el de la planilla "CALCULO_INTERESES":
// cuota de $ 1.127.150, 3 % mensual de interés, 5 % de honorarios, cuotas 1 a 4 impagas desde el 10/10/2025.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nuevaRefi, estadoRefi, htmlRefi } from '../../docs/cobranzas/refinanciacion.js';
import { liquidar } from '../../docs/cobranzas/calculo.js';
import { TASA_MENSUAL } from '../../docs/cobranzas/vehiculos.js';

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
  assert.equal(estadoRefi(null, nuevaRefi(), HOY), null);
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

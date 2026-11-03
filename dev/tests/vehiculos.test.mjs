// Cotización de vehículos (docs/cobranzas/vehiculos.js): lo que se arma con las respuestas de InfoAuto.
// No necesita el stack. Las respuestas son las de la demo de InfoAuto (precios en miles de pesos).
import test from 'node:test';
import assert from 'node:assert/strict';
import { modeloSimple, preciosPorAnio, enPesos, filaModelo, fichaVehiculo, simularCredito, gastosDe, GASTOS_DEFECTO } from '../../docs/cobranzas/vehiculos.js';

const MODELO = { prices_from: 2019, prices_to: 2026, prices: true, list_price: true, codia: 120567, description: 'ONIX 1.4 JOY BLACK            L/19', brand: { id: 12, name: 'CHEVROLET' }, group: { id: 66, name: 'ONIX' }, features: [1, 2] };
const PRECIOS = [{ year: 2019, price: 770 }, { year: 2026, price: 1400 }, { year: 2024, price: 1150 }];

test('un modelo: espacios de más fuera y solo los datos que se usan', () => {
  const m = modeloSimple(MODELO);
  assert.equal(m.descripcion, 'ONIX 1.4 JOY BLACK L/19');
  assert.deepEqual([m.codia, m.marca, m.grupo, m.desde, m.hasta, m.tiene0km], [120567, 'CHEVROLET', 'ONIX', 2019, 2026, true]);
  assert.equal(modeloSimple({ description: 'sin codia' }), null);
});

test('los precios vienen en miles de pesos y salen del año más nuevo al más viejo', () => {
  assert.equal(enPesos(1500), 1_500_000);
  assert.deepEqual(preciosPorAnio(PRECIOS).map((p) => [p.anio, p.pesos]), [[2026, 1_400_000], [2024, 1_150_000], [2019, 770_000]]);
  assert.deepEqual(preciosPorAnio(null), []);
  assert.deepEqual(preciosPorAnio([{ year: 'x', price: 5 }, { year: 2020, price: 0 }]), []);
});

test('lo que viene de InfoAuto se escapa antes de mostrarse', () => {
  const m = modeloSimple({ ...MODELO, description: '<img src=x onerror=alert(1)>' });
  assert.ok(!filaModelo(m, false).includes('<img'));
  assert.ok(!fichaVehiculo(m, PRECIOS, { list_price: 1500 }, '').includes('<img'));
});

test('la ficha muestra el 0km, los años y resalta el elegido', () => {
  const html = fichaVehiculo(modeloSimple(MODELO), PRECIOS, { list_price: 1500 }, '2024');
  assert.match(html, /Precio 0km/);
  assert.match(html, /1\.500\.000/);
  assert.match(html, /<tr class="fuerte"><td class="mono">2024<\/td>/);
  assert.match(fichaVehiculo(modeloSimple({ ...MODELO, list_price: false }), [], null, ''), /Sin precio 0km informado[\s\S]*no informa precios usados/);
});

const G = gastosDe(GASTOS_DEFECTO);
test('simulador: cuota fija al 6% sobre saldo con los gastos de inscripción financiados', () => {
  const r = simularCredito({ capital: 10000000, cuotas: 24, g: G });
  assert.equal(r.financiado, r.capital + r.gastos);
  assert.equal(r.totalCredito, r.cuota * 24);
  assert.equal(r.sellado, Math.round(r.totalCredito * 0.012));
  assert.equal(r.arancel, 13000); // el mínimo
  assert.equal(r.gastos, r.sellado + 13000 + 20000 + 20000 + 29000 + r.redondeo);
  assert.equal(r.gastos % 1000, 0); // redondeo automático
  assert.ok(r.redondeo >= 0 && r.redondeo < 1000);
  const pmt = r.financiado * 0.06 / (1 - 1.06 ** -24); // la cuota francesa del total financiado
  assert.ok(Math.abs(r.cuota - pmt) <= 1);
});
test('simulador: gastos editables, arancel proporcional y datos inválidos', () => {
  const grande = simularCredito({ capital: 400000000, cuotas: 12, g: G });
  assert.equal(grande.arancel, Math.round(grande.totalCredito * 0.0001));
  assert.ok(grande.arancel > 13000);
  const sin = simularCredito({ capital: 10000000, cuotas: 24, g: { ...G, gestoria: 0, envio: 0 } });
  assert.equal(sin.gestoria, 0);
  const red = simularCredito({ capital: 10000000, cuotas: 24, g: { ...G, redondeo: -500 } });
  assert.equal(red.redondeo, -500); // manual
  assert.equal(simularCredito({ capital: 10000000, cuotas: 24, g: { ...G, redondeo: 0 } }).redondeo, 0);
  for (const c of [5e5, 3.3e6, 7.77e6, 2.5e7]) assert.equal(simularCredito({ capital: c, cuotas: 18, g: G }).gastos % 1000, 0);
  assert.equal(simularCredito({ capital: 0, cuotas: 24, g: G }), null);
  assert.equal(simularCredito({ capital: 1000, cuotas: 0, g: G }), null);
});

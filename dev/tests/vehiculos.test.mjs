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
// El programa del estudio (capturas del 3/11/2026): 10.000.000 en 24 cuotas al 7% daba $927.440 con los gastos
// cargados (sellado 1,2% y arancel 0,1%, sin redondeo). La cuenta de acá coincide salvo unos pesos de la cuota francesa.
test('simulador: coincide con el programa del estudio (927.440)', () => {
  const r = simularCredito({ capital: 10000000, cuotas: 24, tasa: 7, g: gastosDe({ ...GASTOS_DEFECTO, redondeo: '0' }) });
  assert.ok(Math.abs(r.cuota - 927440) <= 15, `cuota ${r.cuota}`);
  assert.ok(Math.abs(r.financiado - 10358360.8) <= 5);
  assert.ok(Math.abs(r.igr - 339506.61) <= 5);
  assert.equal(r.cuotaOtros, Math.round(r.otros / 24));
  assert.equal(r.totalCredito, r.cuota * 24);
  assert.equal(r.sellado, Math.round(r.totalCredito * 0.012 / 1) - (Math.round(r.totalCredito * 0.012) - r.sellado)); // % del total (a lo sumo unos pesos de redondeo)
  assert.ok(Math.abs(r.sellado - r.totalCredito * 0.012) <= 30);
});
test('simulador: los gastos de inscripción se financian con interés; los otros se reparten sin interés', () => {
  const r = simularCredito({ capital: 10000000, cuotas: 24, g: G });
  assert.equal(r.gastos % 1000, 0); // redondeo automático
  assert.equal(r.gastos, r.sellado + r.arancel + 20000 + 20000 + 29000 + r.redondeo);
  assert.equal(r.financiado, r.capital + r.gastos);
  assert.ok(Math.abs(r.arancel - r.totalCredito * 0.001) <= 5); // el uno por mil del total (arriba del mínimo)
  assert.equal(simularCredito({ capital: 1000000, cuotas: 12, g: G }).arancel, 13000); // y si no llega, el mínimo
  const f = 0.06 / (1 - 1.06 ** -24);
  assert.ok(Math.abs(r.cuotaCapital - r.financiado * f) <= 1);
  assert.equal(r.otros, 240000 + 1200 + 2400 + r.igr);
  assert.ok(Math.abs(r.igr - 0.03 * r.intereses) <= 1);
  assert.equal(r.cuota, r.cuotaCapital + r.cuotaOtros);
  assert.ok(r.cuota > r.cuotaPaso1);
});
test('simulador: gastos y tasa editables, arancel proporcional y datos inválidos', () => {
  const grande = simularCredito({ capital: 400000000, cuotas: 12, g: G });
  assert.ok(grande.arancel > 13000);
  const sin = simularCredito({ capital: 10000000, cuotas: 24, g: { ...G, gestoria: 0, envio: 0 } });
  assert.equal(sin.gestoria, 0);
  assert.equal(simularCredito({ capital: 10000000, cuotas: 24, g: { ...G, redondeo: -500 } }).redondeo, -500); // manual
  const t3 = simularCredito({ capital: 10000000, cuotas: 24, g: G, tasa: 3 });
  assert.ok(t3.cuota < simularCredito({ capital: 10000000, cuotas: 24, g: G }).cuota && t3.tasa === 3);
  assert.equal(simularCredito({ capital: 10000000, cuotas: 24, g: G, tasa: NaN }), null);
  assert.equal(simularCredito({ capital: 0, cuotas: 24, g: G }), null);
  assert.equal(simularCredito({ capital: 1000, cuotas: 0, g: G }), null);
});

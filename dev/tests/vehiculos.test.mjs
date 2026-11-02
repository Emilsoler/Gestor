// Cotización de vehículos (docs/cobranzas/vehiculos.js): lo que se arma con las respuestas de InfoAuto.
// No necesita el stack. Las respuestas son las de la demo de InfoAuto (precios en miles de pesos).
import test from 'node:test';
import assert from 'node:assert/strict';
import { modeloSimple, preciosPorAnio, enPesos, filaModelo, fichaVehiculo } from '../../docs/cobranzas/vehiculos.js';

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

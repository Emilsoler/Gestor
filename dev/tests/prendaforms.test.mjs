// Formulario 03 y contratos de prenda: solo datos, sin el dibujo del formulario. Sin stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from '../../docs/vendor/pdf-lib.js';
import { datosDeSolicitud, textoVencimientos, faltanFormularios, armarFormularios, hojaDePrueba, MUTUAL } from '../../docs/cobranzas/prendaforms.js';

const sol = { denominacion: 'PEREZ JUAN CARLOS', cuit: '20123456786', monto: 4200000, cuotas: 24, cuota: 301500.5, tasa: 5, vehiculo: 'FIAT CRONOS 1.3 DRIVE', anio: 2021,
  datos: { dni: '12345678', domicilio: 'San Martín 450, Bell Ville', estado_civil: 'casado', actividad: 'Comerciante' } };

test('los datos de la solicitud se pasan sin inventar nada', () => {
  const p = datosDeSolicitud(sol, '2026-11-24');
  assert.equal(p.tna, 60);
  assert.equal(p.deudor.calle, 'San Martín'); assert.equal(p.deudor.numero, '450'); assert.equal(p.deudor.localidad, 'Bell Ville');
  assert.equal(p.deudor.estadoCivil, 'casado');
  assert.equal(p.vehiculo.dominio, ''); assert.equal(p.vehiculo.motor, '');
  assert.equal(p.acreedor.nombre, MUTUAL.nombre);
  assert.equal(p.punitorioAnual, ''); assert.equal(p.autorizado.nombre, '');
});

test('vencimientos: solo si se sabe la primera cuota', () => {
  const p = datosDeSolicitud(sol, '2026-11-24');
  assert.equal(textoVencimientos(p), '');
  p.primerVto = '2026-12-24';
  assert.match(textoVencimientos(p), /^24 cuotas mensuales y consecutivas de \$ 301\.500,50 cada una, venciendo la primera el 24\/12\/2026$/);
});

test('el Formulario 03 no pide lo de los contratos', () => {
  const p = datosDeSolicitud(sol, '2026-11-24');
  assert.ok(!faltanFormularios(p, { soloF03: true }).includes('Lugar de pago'));
  assert.ok(faltanFormularios(p).includes('Lugar de pago'));
  assert.ok(!faltanFormularios(p).includes('Interés punitorio (contrato A)'));
});

test('el PDF tiene una hoja por cada hoja oficial y sin escaneo de fondo', async () => {
  const p = datosDeSolicitud(sol, '2026-11-24');
  const todo = await armarFormularios(p, {});
  const solo03 = await armarFormularios(p, { cuales: ['f03'] });
  const copia = await armarFormularios(p, { cuales: ['b'] });
  const hojas = async (b) => (await PDFDocument.load(b)).getPageCount();
  assert.equal(await hojas(todo.bytes), 5); assert.equal(await hojas(solo03.bytes), 1); assert.equal(await hojas(copia.bytes), 2);
  assert.ok(!/\/Subtype\s*\/Image/.test(Buffer.from(todo.bytes).toString('latin1')), 'no lleva imágenes');
  assert.ok((await hojaDePrueba({})).length > 500);
});

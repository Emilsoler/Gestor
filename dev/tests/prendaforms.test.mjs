// Formulario 03 y contratos de prenda: solo datos, sin el dibujo del formulario. Sin stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from '../../docs/vendor/pdf-lib.js';
import { datosDeSolicitud, textoVencimientos, faltanFormularios, armarFormularios, hojaDePrueba, conDomicilioDelDeudor, sumarDias, MUTUAL } from '../../docs/cobranzas/prendaforms.js';

const sol = { denominacion: 'PEREZ JUAN CARLOS', cuit: '20123456786', monto: 4200000, cuotas: 24, cuota: 301500.5, tasa: 5, vehiculo: 'FIAT CRONOS 1.3 DRIVE', anio: 2021,
  datos: { dni: '12345678', domicilio: 'San Martín 450, Bell Ville', estado_civil: 'casado', actividad: 'Comerciante' } };
const solCasado = { ...sol, datos: { ...sol.datos, conyuge_nombre: 'GOMEZ MARIA', conyuge_dni: '22333444', conyuge_nacionalidad: 'Argentina', conyuge_domicilio: 'San Martín 450, Bell Ville', conyuge_nacimiento: '1985-05-10' } };

test('los datos de la solicitud se pasan sin inventar nada', () => {
  const p = datosDeSolicitud(sol, '2026-11-24');
  assert.equal(p.tna, 60);
  assert.equal(p.deudor.calle, 'San Martín'); assert.equal(p.deudor.numero, '450'); assert.equal(p.deudor.localidad, 'Bell Ville');
  assert.equal(p.deudor.estadoCivil, 'casado');
  assert.equal(p.vehiculo.dominio, ''); assert.equal(p.vehiculo.motor, '');
  assert.equal(p.acreedor.nombre, MUTUAL.nombre);
  assert.equal(p.autorizado.nombre, '');
});

test('condiciones fijas ya cargadas (pedido del 24/11/2026)', () => {
  const p = datosDeSolicitud(sol, '2026-11-24');
  assert.equal(p.primerVto, '2026-12-31');
  assert.equal(p.clase, 'fija'); assert.equal(p.pagares, 'sin'); assert.equal(p.concepto, 'Préstamo de dinero');
  assert.equal(p.lugarPago, 'Bv. Colón 135 Bell Ville'); assert.equal(p.inspeccion, 'Amplios'); assert.equal(p.gravamenes, 'Ninguno de ninguna índole');
  assert.equal(p.punitorioAnual, '-'); assert.equal(p.punitorioMensual, '-'); assert.equal(p.basePct, '-');
  assert.equal(sumarDias('2026-12-01', 37), '2027-01-07');
  assert.ok(Object.values(p.seguro).every((v) => v === '-'));
});

test('los bienes y el domicilio constituido salen del domicilio del deudor, y lo escrito manda', () => {
  const p = datosDeSolicitud(sol, '2026-11-24');
  const q = conDomicilioDelDeudor(p);
  assert.equal(q.ubicacion.calle, 'San Martín'); assert.equal(q.ubicacion.numero, '450'); assert.equal(q.ubicacion.ciudad, 'Bell Ville');
  assert.equal(q.domicilioLegal.ciudad, 'Bell Ville');
  p.ubicacion.calle = 'Otra';
  assert.equal(conDomicilioDelDeudor(p).ubicacion.calle, 'Otra');
  assert.equal(p.domicilioLegal.ciudad, '', 'no cambia el original');
});

test('cónyuge: con guion si el deudor no es casado, a completar si lo es', () => {
  const casado = conDomicilioDelDeudor(datosDeSolicitud(sol, '2026-11-24'));
  assert.equal(casado.conyuge.nombre, ''); assert.equal(casado.conyuge.dni, '');
  const soltero = conDomicilioDelDeudor(datosDeSolicitud({ ...sol, datos: { ...sol.datos, estado_civil: 'soltero' } }, '2026-11-24'));
  for (const v of Object.values(soltero.conyuge)) assert.equal(v, '-');
  assert.ok(faltanFormularios(casado).includes('Cónyuge: nombre y apellido'));
});

test('el cónyuge se toma de lo que cargó la agencia', () => {
  const p = conDomicilioDelDeudor(datosDeSolicitud(solCasado, '2026-11-24'));
  assert.equal(p.conyuge.nombre, 'GOMEZ MARIA'); assert.equal(p.conyuge.dni, '22333444'); assert.equal(p.conyuge.edad, '41');
  assert.equal(p.conyuge.nacionalidad, 'Argentina'); assert.equal(p.conyuge.estadoCivil, 'casado');
  assert.ok(!faltanFormularios(p).includes('Cónyuge: nombre y apellido'));
});

test('vencimientos: solo si se sabe la primera cuota', () => {
  const p = datosDeSolicitud(sol, '2026-11-24');
  p.primerVto = '';
  assert.equal(textoVencimientos(p), '');
  p.primerVto = '2026-12-24';
  assert.match(textoVencimientos(p), /^24 cuotas mensuales y consecutivas de \$ 301\.500,50 cada una, venciendo la primera el 24\/12\/2026$/);
});

test('el Formulario 03 no pide lo de los contratos', () => {
  const p = datosDeSolicitud(sol, '2026-11-24');
  assert.ok(!faltanFormularios(p, { soloF03: true }).includes('Lugar de pago'));
  p.lugarPago = '';
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

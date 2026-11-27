// Asentimiento conyugal y código postal por localidad. Sin stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { PDFDocument } from '../../docs/vendor/pdf-lib.js';
import { datosDeSolicitud } from '../../docs/agencias/master/prendaforms.js';
import { armarAsentimiento, datosAsentimiento, faltanAsentimiento, fechaConDia, textoAsentimiento } from '../../docs/agencias/master/asentimiento.js';
import { cpDe, completarCP } from '../../docs/agencias/cp.js';

// Datos inventados.
const sol = { denominacion: 'PEREZ JUAN CARLOS', monto: 15242800, cuotas: 24, cuota: 1000000, vehiculo: 'FORD ECOSPORT 1.6 L 4X2 XL PLUS', anio: 2010,
  datos: { dni: '12345678', estado_civil: 'casado', matrimonio_lugar: 'Bell Ville', matrimonio_fecha: '2010-05-10', matrimonio_nupcias: '1',
    conyuge_nombre: 'GOMEZ MARIA ROSA', conyuge_dni: '22333444', conyuge_domicilio: 'San Martín 450, Bell Ville', conyuge_nacionalidad: 'Argentina', conyuge_nacimiento: '1985-05-10' } };

test('el asentimiento toma lo que cargó la agencia y deja en blanco lo que no está', () => {
  const p = datosDeSolicitud(sol, '2026-11-27');
  const x = datosAsentimiento(p);
  assert.equal(x.monto, '$15.242.800,00'); assert.equal(x.dni, '22.333.444'); assert.equal(x.fecha, 'lunes, 10 de mayo de 2010');
  assert.equal(textoAsentimiento(x).comparece, 'En mi carácter de cónyuge en 1° nupcias de PEREZ JUAN CARLOS, por matrimonio contraído en Bell Ville, en el día lunes, 10 de mayo de 2010.');
  assert.ok(faltanAsentimiento(p).includes('N° de contrato de prenda'));
  assert.ok(!faltanAsentimiento(p).includes('lugar del matrimonio'));
  const viejo = datosDeSolicitud({ ...sol, datos: { estado_civil: 'casado' } }, '2026-11-27');
  assert.ok(faltanAsentimiento(viejo).includes('nupcias'));
  assert.match(textoAsentimiento(datosAsentimiento(viejo)).comparece, /en \.{6} nupcias/);
  assert.equal(fechaConDia(''), '');
});

test('el asentimiento es una sola hoja, también con datos largos o vacíos', async () => {
  const p = datosDeSolicitud(sol, '2026-11-27');
  Object.assign(p.vehiculo, { dominio: 'AB123CD', motor: 'R59AB0000000', chasis: '9BFZE00N000000000', marcaMotor: 'FORD', marcaChasis: 'FORD' });
  p.asentimiento.contrato = '12345';
  const bytes = await armarAsentimiento(p);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  if (process.env.GUARDAR_PDF) writeFileSync(`${process.env.GUARDAR_PDF}/asentimiento.pdf`, bytes);
  p.deudor.nombre = 'APELLIDO MUY LARGO '.repeat(8); p.vehiculo.modelo = 'MODELO LARGUISIMO '.repeat(10); p.conyuge.domicilio = '';
  assert.equal((await PDFDocument.load(await armarAsentimiento(p))).getPageCount(), 1);
});

test('código postal: se completa en Córdoba, no se inventa y no pisa lo escrito a mano', () => {
  assert.equal(cpDe('Bell Ville'), '2550');
  assert.equal(cpDe('  VILLA MARÍA ', 'Córdoba'), '5900');
  assert.equal(cpDe('Ordoñez', 'cordoba'), '2555');
  assert.equal(cpDe('Bell Ville', 'Santa Fe'), '');
  assert.equal(cpDe('Pueblo Inventado'), '');
  assert.equal(cpDe('constructor'), '');
  // al terminar de escribir se completa; si la provincia resulta ser otra, se borra
  let x = completarCP('', '', 'Pilar', ''); assert.deepEqual(x, { cp: '5972', puesto: '5972' });
  x = completarCP(x.cp, x.puesto, 'Pilar', 'Buenos Aires'); assert.deepEqual(x, { cp: '', puesto: '' });
  assert.deepEqual(completarCP('1629', '', 'Pilar', ''), { cp: '1629', puesto: '' });
});

// Documentos de Drive por escrito y tipo de cada movimiento (docs/seguimiento.js). No necesita el stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requisitos, documentos, tipoMovimiento } from '../../docs/seguimiento.js';

test('qué adjuntos pide cada escrito, según la próxima acción', () => {
  assert.deepEqual(requisitos({ proxima: 'Acompañar tasa y comprobante', tipo: 'EJECUTIVO' }), ['tasa', 'comprobante']);
  assert.deepEqual(requisitos({ proxima: 'Acompañar tasa', tipo: 'PRENDARIO' }), ['tasa', 'comprobante', 'oficio de secuestro']);
  assert.deepEqual(requisitos({ proxima: 'Solicitar no oposición de excepciones del demandado X' }), ['Cédula', 'AFIP']);
  assert.deepEqual(requisitos({ proxima: 'Ejecutar sentencia' }), ['Cédula Sentencia', 'liquidación']);
  assert.equal(requisitos({ proxima: 'Ejecutar sentencia sin fianza art 563' }), null, 'sin regla dictada: no se inventa');
  assert.deepEqual(requisitos({ proxima: 'Solicitar aprobación de liquidación y designar martillero' }), []);
  assert.deepEqual(requisitos({ proxima: 'Solicitar pase a fallo' }), []);
  assert.equal(requisitos({ proxima: 'Llamar a Franco' }), null);
  assert.equal(requisitos({ proxima: '' }), null);
});

test('cruza lo que pide el escrito con la carpeta de Drive', () => {
  const drive = {
    revisado: '2026-11-17T13:40:00Z', carpeta: 'Pérez',
    archivos: ['261020-Cédula.pdf', '261105-Cédula.pdf', '261110 - Cédula Sentencia.pdf', '261111 - Cédula Registro.pdf', '261101 tasa.pdf'],
    constancias: ['AFIP.pdf'],
  };
  let d = documentos({ proxima: 'Solicitar no oposición de excepciones', drive });
  assert.deepEqual(d.lista, [{ nombre: 'Cédula', archivo: '261105-Cédula.pdf' }, { nombre: 'AFIP', archivo: 'AFIP.pdf' }], 'la cédula más nueva, que no sea de sentencia ni del Registro');
  assert.deepEqual(d.faltan, []);
  d = documentos({ proxima: 'Ejecutar sentencia', drive });
  assert.deepEqual(d.faltan, ['liquidación']);
  d = documentos({ proxima: 'Acompañar tasa', tipo: 'EJECUTIVO', drive: { ...drive, archivos: ['261101 comprobante de pago.pdf'] } });
  assert.deepEqual(d.faltan, ['tasa']);
  // sin revisión de Drive no se informa nada como faltante
  d = documentos({ proxima: 'Ejecutar sentencia', drive: null });
  assert.equal(d.revisado, null);
  assert.deepEqual(d.faltan, []);
});

test('tipo de cada movimiento', () => {
  const casos = {
    'Acompañamos tasa y oficio': 'escrito', 'Solicitamos OP': 'escrito', 'Ejecutamos sentencia': 'escrito', 'Designamos martillero': 'escrito',
    'Solicita no oposición de excepciones (escrito N° 1), con cédula de demanda y AFIP': 'escrito', 'Contestamos demanda': 'escrito',
    'Sentencia': 'decreto', 'Se designa martillero': 'decreto', 'Certificado de no oposición de excepciones': 'decreto',
    'Dimos cedula a Franco': 'cedula', 'Notificamos vista de la liquidación': 'cedula', 'Se notificó Sentencia el 07/09/26': 'cedula',
    'Ultima cuota': 'pago', 'Pago parcial OP 1182': 'pago',
    'Contestaron demanda': 'otro', 'Embargo trabado': 'otro', 'Se realizó constatación del campo': 'otro',
  };
  for (const [t, tipo] of Object.entries(casos)) assert.equal(tipoMovimiento(t), tipo, t);
});

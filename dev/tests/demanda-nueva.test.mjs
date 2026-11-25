// «Hacer demanda» de Nueva causa (docs/demanda-nueva.js y supabase/functions/leer-demanda/leer.js). No necesita el stack.
// El caso de pagarés es el de la demanda ejemplo del estudio (3 demandados, 9 pagarés de $ 350.000).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  esPendiente, expteTxt, expteProvisorio, numEs, revisarArchivos, formularioPrendaria, datosDocumentos, renglonPagare, faltanDocumentos,
  causaDeLectura, armarDemanda, nombreWord, CAMPOS_DOCUMENTOS,
} from '../../docs/demanda-nueva.js';
import { estadoDemanda, datosDemanda } from '../../docs/cobranzas/demanda.js';
import { leerZip, expandirParrafos } from '../../docs/cobranzas/acuerdo.js';
import { limpiarLectura, hayDatos, elegirArchivos, extraerJson, INSTRUCCIONES, importeValido } from '../../supabase/functions/leer-demanda/leer.js';

const modelo = (n) => new Uint8Array(readFileSync(new URL(`../../docs/cobranzas/modelos/${n}.docx`, import.meta.url)));
const texto = async (blob) => {
  const partes = await leerZip(new Uint8Array(await blob.arrayBuffer()));
  return new TextDecoder().decode(partes.find((p) => p.nombre === 'word/document.xml').datos).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
};
const HOY = new Date('2026-11-25T12:00:00Z');

const pagares9 = ['2025-09-15', '2025-10-15', '2025-11-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15', '2026-07-15']
  .map((v) => ({ libramiento: '2025-07-14', monto: 350000, vencimiento: v }));
const dem3 = [
  { nombre: 'Pérez Juan Carlos', dni: '20111222', calle: 'Calle Uno 100', ciudad: 'Bell Ville' },
  { nombre: 'Gómez María Laura', dni: '20333444', calle: 'Calle Dos 200', ciudad: 'Bell Ville' },
  { nombre: 'Díaz Roberto Luis', dni: '20555666', calle: 'Calle Tres 300', ciudad: 'Bell Ville' },
];
const lecturaDocs = { tipo: 'documentos', demandados: dem3, pagares: pagares9, avisos: [] };
const lecturaPrenda = {
  tipo: 'prendaria', avisos: [],
  demandados: [{ nombre: 'Soto Ramón Ángel', dni: '20777888', calle: 'Calle Cuatro 400', ciudad: 'Bell Ville' }],
  contrato: { fecha: '2025-05-28', montoPrenda: 17516280, registro: 'Bell Ville N°1', inscripcion: '2025-05-29', cuotas: 12, importeCuota: 1459690.5, primerVencimiento: '2025-06-30' },
  vehiculo: { marca: 'Volkswagen', modelo: 'Amarok 2.0L TDI 122 CV S22', dominio: 'KMN065', motor: 'CDB012416', chasis: '8AWDD42H1CA001746' },
};

// ───────── Expediente pendiente ─────────
test('el expediente pendiente se reconoce, se muestra como «pendiente» y la clave provisoria no se repite', () => {
  assert.ok(esPendiente('PEND-3'));
  assert.ok(!esPendiente('14000001') && !esPendiente('') && !esPendiente(undefined) && !esPendiente('PEND-'));
  assert.equal(expteTxt('PEND-7'), 'pendiente');
  assert.equal(expteTxt('14000001'), '14000001');
  assert.equal(expteProvisorio([]), 'PEND-1');
  assert.equal(expteProvisorio([{ expte: 'PEND-1' }, { expte: '123' }, { expte: 'PEND-2' }]), 'PEND-3');
  assert.equal(expteProvisorio([{ expte: 'PEND-2' }]), 'PEND-1');
});

// ───────── Archivos ─────────
test('los archivos se controlan antes de mandarlos', () => {
  assert.match(revisarArchivos([]), /Adjuntá/);
  assert.equal(revisarArchivos([{ size: 1000 }]), '');
  assert.match(revisarArchivos([{ size: 13 * 1024 * 1024 }]), /pesan demasiado/);
  assert.match(revisarArchivos(Array.from({ length: 13 }, () => ({ size: 1 }))), /hasta 12/);
});

// ───────── Demanda prendaria ─────────
test('prendaria: lo leído llena el formulario de «haz DP» y las cuentas dan lo reclamado', () => {
  const F = formularioPrendaria(lecturaPrenda, '3');
  assert.equal(F.cuota, '1459690,5'); // coma decimal, como lo lee demanda.js
  assert.equal(F.prendaMonto, '17516280');
  const e = estadoDemanda(F);
  assert.equal(e.impagas, 10);
  assert.equal(e.reclamado, 14596905);
  assert.equal(e.moraFecha, '2025-08-30');
  const v = datosDemanda(F);
  assert.equal(v.dominio, 'KMN065');
  assert.match(v.demandados, /^SOTO RAMÓN ÁNGEL, DNI Nº 20.777.888 con domicilio en calle Calle Cuatro nro\. 400 de la ciudad de Bell Ville/);
});

test('prendaria: el Word sale con el modelo del estudio y sin campos sin completar; sin la cuota en mora avisa', async () => {
  const hoy = '2026-11-25';
  const ok = await armarDemanda('prendaria', lecturaPrenda, modelo('demanda-prendaria'), { moraN: '3', hoy });
  const t = await texto(ok.blob);
  assert.ok(!t.includes('{{'));
  assert.ok(!/\[[^\]]+\]/.test(t), 'quedó algún dato entre corchetes: ' + t.match(/\[[^\]]+\]/));
  assert.match(t, /DEMANDA\n/);
  assert.match(t, /automotor marca VOLKSWAGEN dominio KMN065/);
  assert.deepEqual(ok.faltan, []);
  assert.equal(ok.nombre, '261125 - Demanda Ejecutiva Prendaria - Soto Ramón Ángel.docx'.replace('Soto Ramón Ángel', 'SOTO RAMÓN ÁNGEL'));
  const sin = await armarDemanda('prendaria', lecturaPrenda, modelo('demanda-prendaria'), { moraN: '', hoy });
  assert.ok(sin.faltan.includes('cuota en que empezó la mora'));
  assert.match(await texto(sin.blob), /\[cuota en que empezó la mora\]/);
});

// ───────── Demanda de documentos ─────────
test('documentos: los datos salen como en la demanda ejemplo del estudio', () => {
  const { valores, renglones, total } = datosDocumentos(lecturaDocs);
  assert.equal(total, 3150000);
  assert.equal(valores.monto, '3.150.000');
  assert.equal(valores.monto_letras, 'Tres Millones Ciento Cincuenta Mil');
  assert.equal(valores.titulos_intro, '9 (nueve) pagarés suscriptos por los demandados');
  assert.equal(valores.sea_condenado, 'sean condenados solidariamente');
  assert.equal(valores.al_demandado, 'a los demandados');
  assert.match(valores.demandados, /^PÉREZ JUAN CARLOS, DNI Nº 20.111.222 con domicilio en calle Calle Uno nro\. 100 de la ciudad de Bell Ville, Provincia de Córdoba; GÓMEZ MARÍA LAURA/);
  assert.equal(renglones.length, 9);
  assert.equal(renglones[0], '- 1) Pagaré con fecha de libramiento el día 14 de julio de 2025 por la suma de Pesos Trescientos Cincuenta Mil ($ 350.000) con vencimiento el día 15 de septiembre de 2025.');
  assert.equal(renglones[3], '- 4) Pagaré con fecha de libramiento el día 14 de julio de 2025 por la suma de Pesos Trescientos Cincuenta Mil ($ 350.000) con vencimiento el día 15 de febrero de 2026.');
});

test('documentos: un solo pagaré y un solo demandado van en singular', () => {
  const { valores } = datosDocumentos({ tipo: 'documentos', demandados: [dem3[0]], pagares: [pagares9[0]] });
  assert.equal(valores.titulos_intro, '1 (un) pagaré suscripto por el demandado');
  assert.equal(valores.sea_condenado, 'sea condenado');
  assert.equal(valores.al_demandado, 'al demandado');
});

test('documentos: el modelo usa solo campos conocidos y el Word repite un renglón por pagaré', async () => {
  const xml = new TextDecoder().decode((await leerZip(modelo('demanda-documentos'))).find((p) => p.nombre === 'word/document.xml').datos);
  const campos = new Set([...xml.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
  for (const k of campos) assert.ok(k in CAMPOS_DOCUMENTOS, `campo sin describir: ${k}`);
  for (const k of Object.keys(CAMPOS_DOCUMENTOS)) assert.ok(campos.has(k), `campo que el modelo no usa: ${k}`);
  const r = await armarDemanda('documentos', lecturaDocs, modelo('demanda-documentos'), { hoy: '2026-11-25' });
  const t = await texto(r.blob);
  assert.ok(!t.includes('{{'));
  assert.ok(!/\[[^\]]+\]/.test(t));
  assert.equal([...t.matchAll(/Pagaré con fecha de libramiento/g)].length, 9);
  assert.match(t, /vengo a promover demanda ejecutiva en contra de PÉREZ JUAN CARLOS/);
  assert.match(t, /Que se pretende ejecutar 9 \(nueve\) pagarés suscriptos por los demandados que se describen a continuación:/);
  assert.match(t, /sean condenados solidariamente al pago de la suma de Pesos Tres Millones Ciento Cincuenta Mil \(\$ 3\.150\.000\) con más intereses y costas\./);
  assert.match(t, /cite y emplace a los demandados a estar a derecho/);
  assert.deepEqual(r.faltan, []);
  // el orden: el renglón 1 antes que el 9, y todos antes del juramento
  assert.ok(t.indexOf('- 1) Pagaré') < t.indexOf('- 9) Pagaré') && t.indexOf('- 9) Pagaré') < t.indexOf('Se declara bajo fe de juramento'));
  assert.equal(r.nombre, '261125 - Demanda Ejecutiva Pagarés - PÉREZ JUAN CARLOS y GÓMEZ MARÍA LAURA y DÍAZ ROBERTO LUIS.docx');
});

test('documentos: lo que no se leyó queda entre corchetes y se avisa por su nombre', async () => {
  const l = { tipo: 'documentos', demandados: [{ nombre: 'Perez Juan', dni: null, calle: null, ciudad: null }], pagares: [{ libramiento: null, monto: 1000, vencimiento: null }], avisos: [] };
  const r = await armarDemanda('documentos', l, modelo('demanda-documentos'), { hoy: '2026-11-25' });
  const t = await texto(r.blob);
  assert.match(t, /\[fecha de libramiento\]/);
  assert.match(t, /\[fecha de vencimiento\]/);
  assert.match(t, /\[DNI del demandado\]/);
  assert.ok(r.faltan.includes('datos de algún demandado') && r.faltan.includes('fecha de libramiento del pagaré 1') && r.faltan.includes('vencimiento del pagaré 1'));
  assert.ok(faltanDocumentos({ tipo: 'documentos', demandados: [], pagares: [] }).includes('pagarés'));
});

test('un texto con «$&» en un dato no rompe el Word (el reemplazo no interpreta patrones)', () => {
  const xml = '<w:p><w:r><w:t>{{x}}</w:t></w:r></w:p>';
  assert.equal(expandirParrafos(xml, 'x', ['a $& b', 'c']), '<w:p><w:r><w:t>a $&amp; b</w:t></w:r></w:p><w:p><w:r><w:t>c</w:t></w:r></w:p>');
  assert.equal(expandirParrafos(xml, 'x', []), xml);
  assert.equal(expandirParrafos(xml, 'otro', ['a']), xml);
});

// ───────── La causa ─────────
test('la causa toma lo leído sin pisar lo que la persona ya escribió', () => {
  const ficha = { demandado: '', tipo: 'EJECUTIVO', demandados: [], titulos: [] };
  const pr = causaDeLectura('prendaria', lecturaPrenda, ficha, { moraN: '3' });
  assert.equal(pr.demandado, 'SOTO RAMÓN ÁNGEL');
  assert.equal(pr.tipo, 'PRENDARIO');
  assert.equal(pr.titulos[0].tipo, 'prenda');
  assert.equal(pr.titulos[0].monto, 14596905);
  assert.equal(pr.titulos[0].vence, '2025-08-30');
  assert.match(pr.titulos[0].descripcion, /Contrato de prenda del 28 de mayo de 2025\. 12 cuotas de \$ 1\.459\.690,50\. Mora desde la cuota 3/);
  assert.equal(pr.titulos[0].vehiculo, 'Volkswagen Amarok 2.0L TDI 122 CV S22 KMN065');
  assert.equal(pr.demandados[0].dni, '20777888');
  const dd = causaDeLectura('documentos', lecturaDocs, ficha);
  assert.equal(dd.demandado, 'PÉREZ JUAN CARLOS y GÓMEZ MARÍA LAURA y DÍAZ ROBERTO LUIS');
  assert.equal(dd.tipo, 'EJECUTIVO');
  assert.equal(dd.titulos.length, 9);
  assert.deepEqual(dd.titulos[0], { tipo: 'pagare', monto: 350000, vence: '2025-09-15', descripcion: 'Pagaré 1 librado el 14 de julio de 2025', vehiculo: '' });
  // lo escrito a mano manda
  const mano = causaDeLectura('prendaria', lecturaPrenda, { demandado: 'LOPEZ', tipo: 'TERCERIA', demandados: [{ nombre: 'x' }], titulos: [{ tipo: 'pagare' }] }, { moraN: '3' });
  assert.deepEqual(mano, {});
});

// ───────── La función de lectura ─────────
test('leer.js: cada dato que no pasa su control queda en null y se avisa', () => {
  const l = limpiarLectura('prendaria', {
    demandados: [{ apellido_nombre: 'PEREZ JUAN', dni: '1234', calle_numero: 'Mitre 10', ciudad: 'Bell Ville' }, { apellido_nombre: 'LOPEZ ANA', dni: '12.345.678' }, { apellido_nombre: 'LOPEZ ANA', dni: '12345678' }],
    contrato: { fecha: '2025-02-30', monto_prenda: '17516280', registro: 'Bell Ville N° 1', inscripcion: '2025-05-29', cuotas: 12, importe_cuota: -5, primer_vencimiento: '2025-06-30' },
    vehiculo: { marca: 'VW', modelo: 'Amarok', dominio: 'XXXX', motor: 'CDB012416', chasis: 'ab' },
  }, HOY);
  assert.equal(l.demandados.length, 2); // el segundo LOPEZ ANA es el mismo DNI
  assert.equal(l.demandados[0].dni, null);
  assert.equal(l.demandados[1].dni, '12345678');
  assert.equal(l.contrato.fecha, null);
  assert.equal(l.contrato.montoPrenda, 17516280);
  assert.equal(l.contrato.importeCuota, null);
  assert.equal(l.vehiculo.dominio, null);
  assert.equal(l.vehiculo.motor, 'CDB012416');
  assert.equal(l.vehiculo.chasis, null);
  assert.ok(l.avisos.length >= 5, l.avisos.join(' | '));
  assert.ok(hayDatos(l));
});

test('leer.js: pagarés', () => {
  const l = limpiarLectura('documentos', {
    demandados: [{ apellido_nombre: 'PEREZ JUAN', dni: '20123456', calle_numero: 'Mitre 10', ciudad: 'Bell Ville' }],
    pagares: [{ libramiento: '2025-07-14', monto: 350000, vencimiento: '2025-09-15' }, { libramiento: 'ayer', monto: '120000.5', vencimiento: null }, { libramiento: null, monto: null, vencimiento: null }, 'x'],
  }, HOY);
  assert.equal(l.pagares.length, 2);
  assert.equal(l.pagares[1].libramiento, null);
  assert.equal(l.pagares[1].monto, 120000.5);
  assert.equal(importeValido('abc'), null);
  assert.equal(importeValido(0), null);
  assert.ok(!hayDatos(limpiarLectura('documentos', {}, HOY)));
  assert.ok(!hayDatos(limpiarLectura('prendaria', { contrato: 'x' }, HOY)));
});

test('leer.js: los archivos y la respuesta del modelo', () => {
  const b64 = (n) => 'A'.repeat(Math.ceil(n * 4 / 3));
  const { usar, omitidos } = elegirArchivos([
    { nombre: 'a.pdf', tipo: 'application/pdf', base64: b64(1000) }, { nombre: 'b.png', tipo: 'image/png', base64: 'AAAA' },
    { nombre: 'c.pdf', tipo: 'application/pdf', base64: b64(13 * 1024 * 1024) }, { nombre: 'd.pdf', tipo: 'application/pdf', base64: '' },
  ]);
  assert.deepEqual(usar.map((x) => x.nombre), ['a.pdf']);
  assert.equal(omitidos, 1);
  assert.deepEqual(extraerJson('Acá va:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extraerJson('sin json'), null);
  assert.ok(INSTRUCCIONES.prendaria.includes('Certificado de Prenda') && INSTRUCCIONES.documentos.includes('pagarés'));
  assert.equal(numEs(143110.5), '143110,5');
  assert.equal(numEs(null), '');
  assert.equal(nombreWord('prendaria', [], '2026-11-25'), '261125 - Demanda Ejecutiva Prendaria - demandado.docx');
  assert.equal(renglonPagare({ libramiento: null, monto: null, vencimiento: null }, 0), '- 1) Pagaré con fecha de libramiento el día [fecha de libramiento] por la suma de Pesos [importe] con vencimiento el día [fecha de vencimiento].');
});

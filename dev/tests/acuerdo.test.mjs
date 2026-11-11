// Exportar la refinanciación (docs/cobranzas/acuerdo.js): el convenio en Word a partir del modelo del estudio y la planilla de Excel.
// No necesita el stack. El caso es el del modelo: 17 cuotas impagas de $ 707.170 (cuotas 8 a 24 de 24), plan en 24 cuotas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nuevaRefi, estadoRefi } from '../../docs/cobranzas/refinanciacion.js';
import { datosAcuerdo, avisosAcuerdo, armarAcuerdo, leerZip, hojasRefinanciacion, fechaLarga, dniConPuntos, CAMPOS_ACUERDO } from '../../docs/cobranzas/acuerdo.js';
import { xlsx } from '../../docs/excel.js';
import { fmtLargo } from '../../docs/cobranzas/textos.js';

const MODELO = new Uint8Array(readFileSync(new URL('../../docs/cobranzas/modelos/acuerdo-refinanciacion.docx', import.meta.url)));
const HOY = '2026-11-05';
const formulario = () => ({ ...nuevaRefi('0'), plan: true, aVencer: true, cuota: '707170', cantCuotas: '24', vto1: '2025-10-10', mora: '8', tasaMora: '0', hon: '0', cuotas: '24', tasa: '0',
  dniDeudor: '12.533.695', calle: 'San Luis N° 730', prestamo: '2025-09-16', primerVto: '2026-12-10' });
const texto = async (blob) => {
  const partes = await leerZip(new Uint8Array(await blob.arrayBuffer()));
  return new TextDecoder().decode(partes.find((p) => p.nombre === 'word/document.xml').datos).replace(/<[^>]+>/g, '');
};

test('el modelo trae todos los campos y todos son conocidos', async () => {
  const xml = new TextDecoder().decode((await leerZip(MODELO)).find((p) => p.nombre === 'word/document.xml').datos);
  const campos = new Set([...xml.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
  assert.ok(campos.size >= 20);
  for (const k of campos) assert.ok(k in CAMPOS_ACUERDO, `campo sin describir: ${k}`);
});

test('los datos del convenio salen de la deuda y del plan', () => {
  const R = formulario(), e = estadoRefi(null, R, HOY), v = datosAcuerdo(e, R, null, HOY, 'Juan Pérez');
  assert.equal(v.cuotas_impagas, '17');
  assert.equal(v.cuotas_impagas_letras, 'diecisiete');
  assert.equal(v.deuda_total, '$12.021.890');
  assert.equal(v.deuda_total_letras, 'DOCE MILLONES VEINTIÚN MIL OCHOCIENTOS NOVENTA');
  assert.equal(v.cuota_orig_monto, '$707.170');
  assert.equal(v.cuotas_orig_cant, '24');
  assert.equal(v.cuotas_orig_cant_letras, 'veinticuatro');
  assert.equal(v.cuota_orig_primer_venc, '10 de octubre de 2025');
  assert.equal(v.mora_cuota_nro, '8');
  assert.equal(v.mora_fecha, '10 de mayo de 2026');
  assert.equal(v.refi_cuotas, '24');
  assert.equal(v.refi_cuota_monto, '$500.912');
  assert.equal(v.refi_primer_venc, '10 de diciembre de 2026');
  assert.equal(v.prestamo_fecha, '16 de septiembre de 2025');
  assert.deepEqual([v.dia_firma, v.mes_firma, v.anio_firma], ['5', 'noviembre', '2026']);
  assert.equal(v.deudor_ciudad, 'Bell Ville');
});

test('el Word sale sin campos sin completar y con los datos puestos', async () => {
  const R = formulario(), e = estadoRefi(null, R, HOY);
  const { blob, faltan } = await armarAcuerdo(MODELO, datosAcuerdo(e, R, null, HOY, 'Juan Pérez'));
  assert.deepEqual(faltan, []);
  const xml = await texto(blob);
  assert.ok(!/\{\{/.test(xml));
  for (const s of ['Juan Pérez', '12.533.695', 'San Luis N° 730', 'DOCE MILLONES VEINTIÚN MIL OCHOCIENTOS NOVENTA', '$12.021.890', 'diecisiete', '10 de mayo de 2026', 'veinticuatro (24) pagarés', '5 días del mes de noviembre de 2026'])
    assert.ok(xml.includes(s), `falta: ${s}`);
  // el resto del documento no cambia
  const antes = await leerZip(MODELO), despues = await leerZip(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(despues.map((p) => p.nombre), antes.map((p) => p.nombre));
});

test('lo que falta queda entre corchetes para completar a mano', async () => {
  const R = { ...formulario(), dniDeudor: '', prestamo: '' }, e = estadoRefi(null, R, HOY);
  const { blob, faltan } = await armarAcuerdo(MODELO, datosAcuerdo(e, R, null, HOY));
  assert.deepEqual(faltan.sort(), ['deudor_dni', 'deudor_nombre', 'prestamo_fecha']);
  const xml = await texto(blob);
  assert.ok(xml.includes('[nombre del deudor]') && xml.includes('[DNI del deudor]') && xml.includes('[fecha del préstamo]'));
});

test('con un deudor de la app toma sus datos y escapa lo que no es XML', async () => {
  const d = { id: 'd1', nombre: 'Pérez & Hijos <SRL>', dni: '30-1', domicilio: 'Mitre 10', socio: '55', tasa: 0, hon_pct: 0, pagos: [], gastos: [], planes: [], operaciones: [{ fecha: '2025-09-16' }],
    cuotas: ['2026-05-10', '2026-06-10'].map((vto, i) => ({ id: 'c' + i, n: 8 + i, de: 24, vto, importe: 1000 })) };
  const R = { ...nuevaRefi('0'), plan: true, fuente: 'deudor', id: 'd1', cuotas: '2', tasa: '0', primerVto: '2026-12-10' }, e = estadoRefi(d, R, HOY), v = datosAcuerdo(e, R, d, HOY);
  assert.equal(v.deudor_nombre, 'Pérez & Hijos <SRL>');
  assert.equal(datosAcuerdo(e, R, d, HOY, 'Nombre del caso').deudor_nombre, 'Nombre del caso'); // el nombre del caso manda
  assert.equal(v.cuota_orig_primer_venc, '10 de octubre de 2025'); // la cuota 8 vence el 10/05/2026
  assert.equal(v.prestamo_fecha, '16 de septiembre de 2025');
  const { blob } = await armarAcuerdo(MODELO, v);
  assert.ok((await texto(blob)).includes('Pérez &amp; Hijos &lt;SRL&gt;'));
});

test('avisa lo que el modelo no contempla', () => {
  const R = { ...formulario(), tasa: '3', justicia: '100000' }, e = estadoRefi(null, R, HOY);
  const av = avisosAcuerdo(e);
  assert.ok(av.some((x) => /valor nominal/.test(x)));
  assert.ok(!avisosAcuerdo(estadoRefi(null, formulario(), HOY)).some((x) => /valor nominal/.test(x)));
});

test('la planilla de Excel tiene el resumen y las cuotas, con fórmulas', async () => {
  const R = formulario(), e = estadoRefi(null, R, HOY);
  const hojas = hojasRefinanciacion(e, R, null, HOY, fmtLargo);
  assert.deepEqual(hojas.map((h) => h.nombre), ['Refinanciación', 'Cuotas']);
  assert.equal(hojas[1].filas.length, 24 + 2); // cabecera + 24 cuotas + total
  const blob = xlsx(hojas), partes = await leerZip(new Uint8Array(await blob.arrayBuffer()));
  const hoja2 = new TextDecoder().decode(partes.find((p) => p.nombre === 'xl/worksheets/sheet2.xml').datos);
  assert.ok(hoja2.includes('<f>SUM(C2:C25)</f>'));
  const hoja1 = new TextDecoder().decode(partes.find((p) => p.nombre === 'xl/worksheets/sheet1.xml').datos);
  assert.ok(hoja1.includes('<f>SUM(Cuotas!C2:C25)</f>'));
  assert.equal(fechaLarga('nada'), '');
});

test('el DNI va con puntos en los miles y lo que no es un DNI queda como se escribió', () => {
  assert.equal(dniConPuntos('12345678'), '12.345.678');
  assert.equal(dniConPuntos(' 9876543 '), '9.876.543');
  assert.equal(dniConPuntos('12.345.678'), '12.345.678');
  assert.equal(dniConPuntos('PAS 123'), 'PAS 123');
  assert.equal(dniConPuntos(''), '');
});

test('el DNI sale con puntos en el Word y las firmas siguen al final', async () => {
  const R = { ...formulario(), dniDeudor: '12345678' };
  const e = estadoRefi(null, R, HOY);
  const { blob } = await armarAcuerdo(MODELO, datosAcuerdo(e, R, null, HOY, 'JUAN PEREZ'));
  const xml = await texto(blob);
  assert.ok(xml.includes('DNI N° 12.345.678') || xml.includes('12.345.678'));
  assert.equal(xml.includes('12345678'), false);
  assert.ok(xml.indexOf('JUAN PEREZ', xml.indexOf('ANEXO I')) < xml.indexOf('SOLER CARLOS EMILIANO'));
});

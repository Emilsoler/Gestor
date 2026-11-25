// La demanda en PDF con firma (docs/demanda-pdf.js). No necesita el stack ni la firma real: se usa una imagen de prueba.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { armarDemanda } from '../../docs/demanda-nueva.js';
import { parrafosDeDocx, pdfDeDemanda, pdfDesdeWord } from '../../docs/demanda-pdf.js';

const modelo = (n) => new Uint8Array(readFileSync(new URL(`../../docs/cobranzas/modelos/${n}.docx`, import.meta.url)));
const lectura = {
  tipo: 'prendaria', avisos: [],
  demandados: [{ nombre: 'Soto Ramón Ángel', dni: '20777888', calle: 'Calle Cuatro 400', ciudad: 'Bell Ville' }],
  contrato: { fecha: '2025-05-28', montoPrenda: 17516280, registro: 'Bell Ville N°1', inscripcion: '2025-05-29', cuotas: 12, importeCuota: 1459690.5, primerVencimiento: '2025-07-01' },
  vehiculo: { marca: 'Volkswagen', modelo: 'Amarok', dominio: 'KMN065', motor: 'CDB012416', chasis: '8AWDD42H1CA001746' },
};
// JPEG mínimo válido de prueba (1x1), no es la firma real.
const JPEG_1X1 = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));

test('los párrafos del Word se leen con su formato y el PDF los escribe todos', async () => {
  const r = await armarDemanda('prendaria', lectura, modelo('demanda-prendaria'), { moraN: '3', hoy: '2026-11-25' });
  const ps = await parrafosDeDocx(new Uint8Array(await r.blob.arrayBuffer()));
  assert.ok(ps.length >= 20);
  assert.equal(ps[0].tramos.map((t) => t.t).join(''), 'DEMANDA');
  assert.ok(ps[0].tramos[0].b && ps[0].tramos[0].u && ps[0].alinea === 'center');
  assert.ok(ps.some((p) => p.alinea === 'both' && p.primera > 100)); // párrafos con sangría de primera línea
  const pdf = await pdfDesdeWord(r.blob, null, { titulo: 'Prueba' });
  assert.equal(Buffer.from(pdf.subarray(0, 5)).toString(), '%PDF-');
  const conFirma = await pdfDesdeWord(r.blob, JPEG_1X1);
  assert.ok(conFirma.length > pdf.length, 'la firma suma una imagen');
  if (process.env.GUARDAR_PDF) { mkdirSync(process.env.GUARDAR_PDF, { recursive: true }); writeFileSync(process.env.GUARDAR_PDF + '/prueba.pdf', conFirma); }
});

test('una firma ilegible no corta el PDF', async () => {
  const pdf = await pdfDeDemanda([{ alinea: 'left', primera: 0, izq: 0, tramos: [{ t: 'Texto con ñ, “comillas” y €', b: false, i: false, u: false }] }], Uint8Array.from([1, 2, 3]));
  assert.equal(Buffer.from(pdf.subarray(0, 5)).toString(), '%PDF-');
});

test('la carpeta de Drive es «APELLIDO NOMBRE» del primer demandado y el PDF se llama como el Word', async () => {
  const { carpetaDemandado, nombrePdf } = await import('../../docs/demanda-nueva.js');
  assert.equal(carpetaDemandado(lectura), 'SOTO RAMÓN ÁNGEL');
  assert.equal(carpetaDemandado({ demandados: [{ nombre: '  ' }, { nombre: 'Pérez / Juan: Carlos' }, { nombre: 'Otro' }] }), 'PÉREZ JUAN CARLOS');
  assert.equal(carpetaDemandado({ demandados: [] }), '');
  assert.equal(nombrePdf('261125 - Demanda Ejecutiva Prendaria - SOTO.docx'), '261125 - Demanda Ejecutiva Prendaria - SOTO.pdf');
});

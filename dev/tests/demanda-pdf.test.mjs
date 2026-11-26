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
  assert.equal(nombrePdf('261125- DEMANDA Soto.docx'), '261125- DEMANDA Soto.pdf');
});

test('nombres: «AAMMDD- DEMANDA Apellido» y la documental aparte', async () => {
  const { apellidoDe, nombreDocumental } = await import('../../docs/demanda-nueva.js');
  assert.equal(apellidoDe('SOTO RAMÓN ÁNGEL'), 'Soto');
  assert.equal(apellidoDe('DE LA TORRE ANA'), 'De La Torre');
  assert.equal(apellidoDe("O'CONNOR, Juan"), "O'Connor");
  assert.equal(nombreDocumental('prendaria', '2026-11-26'), '261126- PRENDA.pdf');
  assert.equal(nombreDocumental('documentos', '2026-11-26'), '261126- PAGARES.pdf');
});

test('la demanda entra en 2 fojas y la documental sigue desde la 3, también en hojas giradas', async () => {
  const { foliarPdf, contarPaginas, foliarWord, enHoja } = await import('../../docs/foja.js');
  const { leerZip } = await import('../../docs/cobranzas/acuerdo.js');
  const { PDFDocument, degrees } = await import('../../docs/vendor/pdf-lib.js');
  const r = await armarDemanda('prendaria', lectura, modelo('demanda-prendaria'), { moraN: '3', hoy: '2026-11-26' });
  assert.equal(await contarPaginas(await pdfDesdeWord(r.blob, null)), 2);
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]); doc.addPage([842, 595]).setRotation(degrees(90));
  const f = await foliarPdf(await doc.save(), null, 3);
  assert.equal(f.paginas, 2);
  const caja = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(enHoja(90, caja, 590, 790), { x: 10, y: 590 }); // arriba a la derecha de como se ve
  assert.deepEqual(enHoja(270, caja, 590, 790), { x: 790, y: 10 });
  const w = await leerZip(new Uint8Array(await (await foliarWord(r.blob, Uint8Array.from([137, 80, 78, 71]))).arrayBuffer()));
  const txt = (n) => new TextDecoder().decode(w.find((p) => p.nombre === n).datos);
  assert.match(txt('word/document.xml'), /<w:headerReference w:type="default" r:id="rIdFoja"\/>/);
  assert.match(txt('word/header-foja.xml'), / PAGE /);
  assert.match(txt('[Content_Types].xml'), /header-foja\.xml/);
  assert.match(txt('[Content_Types].xml'), /Extension="png"/);
});

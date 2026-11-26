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
// PNG mínimo de prueba (1x1), no es la firma real.
const PNG_1X1 = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

test('los párrafos del Word se leen con su formato y el PDF los escribe todos', async () => {
  const r = await armarDemanda('prendaria', lectura, modelo('demanda-prendaria'), { moraN: '3', hoy: '2026-11-25' });
  const ps = await parrafosDeDocx(new Uint8Array(await r.blob.arrayBuffer()));
  assert.ok(ps.length >= 20);
  assert.equal(ps[0].tramos.map((t) => t.t).join(''), 'DEMANDA');
  assert.ok(ps[0].tramos[0].b && ps[0].tramos[0].u && ps[0].alinea === 'center');
  assert.ok(ps.some((p) => p.alinea === 'both' && p.primera > 100)); // párrafos con sangría de primera línea
  const pdf = await pdfDesdeWord(r.blob, { titulo: 'Prueba' });
  assert.equal(Buffer.from(pdf.subarray(0, 5)).toString(), '%PDF-');
  const conFirma = await pdfDesdeWord(r.blob, { sello: PNG_1X1 });
  assert.ok(conFirma.length > pdf.length, 'la firma suma una imagen');
  if (process.env.GUARDAR_PDF) { mkdirSync(process.env.GUARDAR_PDF, { recursive: true }); writeFileSync(process.env.GUARDAR_PDF + '/prueba.pdf', conFirma); }
});

test('sin sello el PDF sale igual', async () => {
  const pdf = await pdfDeDemanda([{ alinea: 'left', primera: 0, izq: 0, tramos: [{ t: 'Texto con ñ, “comillas” y €', b: false, i: false, u: false }] }], { sello: null });
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

test('la demanda ocupa una hoja (2 páginas) y la documental sigue desde la 2, también en hojas giradas', async () => {
  const { foliarPdf, contarPaginas, hojas, enHoja } = await import('../../docs/foja.js');
  const { PDFDocument, degrees } = await import('../../docs/vendor/pdf-lib.js');
  const r = await armarDemanda('prendaria', lectura, modelo('demanda-prendaria'), { moraN: '3', hoy: '2026-11-26' });
  const paginas = await contarPaginas(await pdfDesdeWord(r.blob));
  assert.equal(paginas, 2);
  assert.equal(hojas(paginas), 1);
  assert.deepEqual([1, 2, 3, 4, 5].map(hojas), [1, 1, 2, 2, 3]);
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]); doc.addPage([842, 595]).setRotation(degrees(90)); doc.addPage([595, 842]);
  const f = await foliarPdf(await doc.save(), null, 2);
  assert.equal(f.paginas, 3);
  // Solo se escribe en el frente: la página 2 (dorso) queda sin contenido.
  const escritas = (await PDFDocument.load(f.bytes)).getPages().map((p) => !!p.node.Contents());
  assert.deepEqual(escritas, [true, false, true]);
  const caja = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(enHoja(90, caja, 590, 790), { x: 10, y: 590 }); // arriba a la derecha de como se ve
  assert.deepEqual(enHoja(270, caja, 590, 790), { x: 790, y: 10 });
});

test('el Word numera solo el frente de cada hoja, sin círculo', async () => {
  const { foliarWord } = await import('../../docs/foja.js');
  const { leerZip } = await import('../../docs/cobranzas/acuerdo.js');
  for (const [nombre, tipo] of [['demanda-prendaria', 'prendaria'], ['demanda-documentos', 'documentos']]) {
    const r = tipo === 'prendaria' ? await armarDemanda(tipo, lectura, modelo(nombre), { moraN: '3', hoy: '2026-11-26' }) : { blob: modelo(nombre) };
    const w = await leerZip(new Uint8Array(await (await foliarWord(r.blob, Uint8Array.from([137, 80, 78, 71]))).arrayBuffer()));
    const txt = (n) => new TextDecoder().decode(w.find((p) => p.nombre === n).datos);
    const documento = txt('word/document.xml');
    for (const t of ['first', 'even', 'default']) assert.ok(documento.includes(`<w:headerReference w:type="${t}"`), t);
    assert.match(documento, /<w:titlePg\/>(<w:docGrid[^>]*\/>)?<\/w:sectPr>/);
    assert.match(txt('word/settings.xml'), /<w:defaultTabStop[^>]*\/><w:evenAndOddHeaders\/>/);
    assert.match(txt('word/header-foja.xml'), /<w:t>1<\/w:t>/);
    assert.doesNotMatch(txt('word/header-foja.xml'), /fldChar|v:oval/);
    assert.match(txt('word/header-frente.xml'), /<w:t>2<\/w:t>/);
    assert.doesNotMatch(txt('word/header-frente.xml'), /fldChar/);
    assert.doesNotMatch(txt('word/header-frente.xml'), /v:oval/);
    assert.doesNotMatch(txt('word/header-dorso.xml'), /<w:r>/); // el dorso no lleva nada
    for (const p of ['header-foja', 'header-dorso', 'header-frente']) assert.ok(txt('[Content_Types].xml').includes(`/word/${p}.xml`), p);
    assert.match(txt('[Content_Types].xml'), /Extension="png"/);
  }
});

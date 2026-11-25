// Fotos del celular → PDF (docs/fotos.js): las cuentas de tamaño y de página, y el PDF armado con pdf-lib. No necesita el stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { achicar, paginar, pdfDeJpegs, LADO_MAX } from '../../docs/fotos.js';

const JPG = new Uint8Array(readFileSync(new URL('../../docs/img/plantillas.jpg', import.meta.url)));

test('una foto grande se achica sin deformarse y una chica no se agranda', () => {
  assert.deepEqual(achicar(4000, 3000), { ancho: LADO_MAX, alto: 1200 });
  assert.deepEqual(achicar(3000, 4000), { ancho: 1200, alto: LADO_MAX });
  assert.deepEqual(achicar(800, 600), { ancho: 800, alto: 600 });
});

test('cada foto va entera y centrada en una hoja A4, vertical u horizontal según la foto', () => {
  const v = paginar(1200, 1600), h = paginar(1600, 1200);
  assert.ok(v.pagina[1] > v.pagina[0] && h.pagina[0] > h.pagina[1]);
  for (const p of [v, h]) {
    assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= p.pagina[0] && p.y + p.h <= p.pagina[1]);
    assert.ok(Math.abs(p.x - (p.pagina[0] - p.x - p.w)) < 1e-6, 'centrada a lo ancho');
  }
  assert.ok(Math.abs(v.w / v.h - 0.75) < 1e-9, 'sin deformar');
});

test('el PDF tiene una hoja por foto', async () => {
  const bytes = await pdfDeJpegs([{ bytes: JPG, ancho: 1200, alto: 1600 }, { bytes: JPG, ancho: 1600, alto: 1200 }]);
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), '%PDF-');
  const { PDFDocument } = await import('../../docs/vendor/pdf-lib.js');
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 2);
});

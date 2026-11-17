// «Descargar todo en un PDF» de una solicitud de agencia (Créditos y Cobros → Agencias → Solicitudes): junta en un
// solo PDF los documentos que subió la agencia, ordenados por casillero, con una carátula que dice qué hay y qué
// falta. Los PDF entran con sus páginas tal cual; cada foto (JPG) va en una página A4, achicada para que entre.
//
// Lo arma el navegador con pdf-lib (docs/vendor/pdf-lib.js, copiada por dev/vendor.mjs; MIT), que se carga recién al
// tocar el botón. Nada sale de la app: los archivos se bajan con los mismos enlaces de 15 minutos de «Ver documentos».
import { DOCS, docsRequeridos } from '../agencias/solicitud.js';

let lib = null;
const cargarLib = async () => (lib ||= await import('../vendor/pdf-lib.js'));

const A4 = [595.28, 841.89];
const MARGEN = 36;

/** Lo que la tipografía estándar (WinAnsi) no puede escribir se cambia por «?», para que un nombre raro no corte todo. */
function seguro(fuente, t) {
  let out = '';
  for (const c of String(t ?? '')) {
    try { fuente.encodeText(c); out += c; } catch { out += '?'; }
  }
  return out;
}

/** Corta un texto en renglones que entren en `ancho`. */
function renglones(fuente, t, tam, ancho) {
  const out = [];
  let linea = '';
  for (const p of seguro(fuente, t).split(/\s+/).filter(Boolean)) {
    const prueba = linea ? `${linea} ${p}` : p;
    if (fuente.widthOfTextAtSize(prueba, tam) <= ancho || !linea) linea = prueba;
    else { out.push(linea); linea = p; }
  }
  if (linea) out.push(linea);
  return out;
}

/**
 * El PDF de una solicitud. `sol`: la fila de solicitudes_credito; `archivos`: lo que devuelve documentosSolicitud
 * ([{slot, nombre, tipo, url}]); `bajar(url)`: Uint8Array del archivo. Devuelve { bytes, problemas: [nombre…] }.
 */
export async function pdfSolicitud(sol, archivos, bajar, { hoy = '' } = {}) {
  const { PDFDocument, StandardFonts, rgb } = await cargarLib();
  const doc = await PDFDocument.create();
  doc.setTitle(`Solicitud de crédito - ${sol.denominacion || sol.cuit || ''}`);
  doc.setProducer('Créditos y Cobros');
  const normal = await doc.embedFont(StandardFonts.Helvetica), negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  const orden = Object.keys(DOCS);
  const lista = [...archivos].sort((a, b) => orden.indexOf(a.slot) - orden.indexOf(b.slot));

  // Carátula: quién, qué crédito, qué documentos vienen y cuáles faltan.
  const caratula = doc.addPage(A4);
  let y = A4[1] - MARGEN - 10;
  const escribir = (t, { tam = 10, f = normal, gris = false, sangria = 0 } = {}) => {
    for (const r of renglones(f, t, tam, A4[0] - 2 * MARGEN - sangria)) {
      if (y < MARGEN) return;
      caratula.drawText(r, { x: MARGEN + sangria, y, size: tam, font: f, color: gris ? rgb(0.35, 0.35, 0.35) : rgb(0, 0, 0) });
      y -= tam * 1.45;
    }
  };
  escribir('Solicitud de aprobación de crédito', { tam: 16, f: negrita }); y -= 4;
  escribir(`${sol.denominacion || ''} · CUIT ${sol.cuit || ''}`, { tam: 12, f: negrita });
  escribir(`Agencia: ${sol.agencia || ''} · Vehículo: ${sol.vehiculo || ''} (${sol.anio || ''})`);
  escribir(`Crédito: $ ${Number(sol.monto || 0).toLocaleString('es-AR')} en ${sol.cuotas} cuotas de $ ${Number(sol.cuota || 0).toLocaleString('es-AR')}`);
  if (hoy) escribir(`Armado el ${hoy.split('-').reverse().join('/')} desde Créditos y Cobros.`, { gris: true });
  y -= 10;
  escribir('Documentos', { tam: 12, f: negrita });
  const vacios = docsRequeridos(sol.categoria, sol.anio).filter((k) => !lista.some((a) => a.slot === k));
  for (const k of orden) {
    const xs = lista.filter((a) => a.slot === k);
    if (!xs.length) continue;
    escribir(`${DOCS[k].titulo}: ${xs.length} ${xs.length === 1 ? 'archivo' : 'archivos'}`, { sangria: 8 });
  }
  if (!lista.length) escribir('La agencia no adjuntó documentos.', { sangria: 8 });
  if (vacios.length) { y -= 6; escribir(`Sin adjuntar: ${vacios.map((k) => DOCS[k]?.titulo || k).join('; ')}.`, { gris: true }); }

  // Cada documento, con un rótulo arriba de la página que dice de qué casillero es.
  const rotulo = (pag, a) => {
    const t = seguro(normal, `${DOCS[a.slot]?.titulo || a.slot} · ${a.nombre}`).slice(0, 140);
    const [w, h] = [pag.getWidth(), pag.getHeight()];
    pag.drawRectangle({ x: 0, y: h - 16, width: w, height: 16, color: rgb(1, 1, 1), opacity: 0.85 });
    pag.drawText(t, { x: 8, y: h - 11, size: 7.5, font: normal, color: rgb(0.25, 0.25, 0.25) });
  };
  const problemas = [];
  for (const a of lista) {
    try {
      const bytes = await bajar(a.url);
      const esPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
      if (esPdf) {
        const otro = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pags = await doc.copyPages(otro, otro.getPageIndices());
        pags.forEach((p, i) => { doc.addPage(p); if (i === 0) rotulo(p, a); });
      } else {
        const img = await doc.embedJpg(bytes);
        const pag = doc.addPage(A4);
        const esc = Math.min((A4[0] - 2 * MARGEN) / img.width, (A4[1] - 2 * MARGEN - 16) / img.height, 1);
        const w = img.width * esc, h = img.height * esc;
        pag.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - 16 - h) / 2, width: w, height: h });
        rotulo(pag, a);
      }
    } catch (e) {
      console.error('pdfSolicitud', a.slot, e);
      problemas.push(a.nombre);
      const pag = doc.addPage(A4);
      rotulo(pag, a);
      pag.drawText(seguro(normal, `No se pudo incluir «${a.nombre}». Abrilo aparte desde «Ver documentos».`), { x: MARGEN, y: A4[1] / 2, size: 11, font: normal });
    }
  }
  return { bytes: await doc.save(), problemas };
}

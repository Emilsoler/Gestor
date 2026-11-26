// Fotos del celular → un solo PDF liviano (botón «Hacer demanda» de Nueva causa).
// El celular saca las fotos en JPG pesados (varios MB cada una, y a veces rotadas): acá se enderezan, se achican y se
// juntan en un PDF, que es lo que lee la función `leer-demanda`. Todo pasa en el dispositivo: las fotos no van a ningún
// sitio de terceros. pdf-lib (docs/vendor/pdf-lib.js, MIT) se carga recién al usarlo.

export const LADO_MAX = 1600;   // px del lado más largo: alcanza para leer un documento y pesa unos 200-400 KB por foto
export const CALIDAD = 0.72;    // calidad JPEG al recomprimir
const A4 = [595.28, 841.89];    // en puntos
const MARGEN = 18;

let lib;
const cargarLib = async () => (lib ||= await import('./vendor/pdf-lib.js'));

/** Medida final de una foto: el lado más largo no pasa de `max` y no se agranda nunca. */
export function achicar(ancho, alto, max = LADO_MAX) {
  const k = Math.min(1, max / Math.max(ancho, alto));
  return { ancho: Math.max(1, Math.round(ancho * k)), alto: Math.max(1, Math.round(alto * k)) };
}

/** La hoja y el lugar de una foto: A4 vertical u horizontal según la foto, con margen, entera y centrada. */
export function paginar(ancho, alto) {
  const [pw, ph] = ancho > alto ? [A4[1], A4[0]] : A4;
  const k = Math.min((pw - 2 * MARGEN) / ancho, (ph - 2 * MARGEN) / alto);
  const w = ancho * k, h = alto * k;
  return { pagina: [pw, ph], x: (pw - w) / 2, y: (ph - h) / 2, w, h };
}

/** Arma el PDF con fotos ya recomprimidas: [{ bytes: Uint8Array (JPEG), ancho, alto }]. */
export async function pdfDeJpegs(fotos) {
  const { PDFDocument } = await cargarLib();
  const doc = await PDFDocument.create();
  for (const f of fotos) {
    const img = await doc.embedJpg(f.bytes);
    const p = paginar(f.ancho, f.alto);
    doc.addPage(p.pagina).drawImage(img, { x: p.x, y: p.y, width: p.w, height: p.h });
  }
  return doc.save();
}

/** Una foto del celular → JPEG achicado y enderezado (usa el navegador: no corre en Node). */
async function recomprimir(archivo) {
  const mapa = await createImageBitmap(archivo, { imageOrientation: 'from-image' }); // respeta cómo se sostuvo el celular
  const { ancho, alto } = achicar(mapa.width, mapa.height);
  const lienzo = Object.assign(document.createElement('canvas'), { width: ancho, height: alto });
  const g = lienzo.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, ancho, alto);
  g.drawImage(mapa, 0, 0, ancho, alto);
  mapa.close?.();
  const blob = await new Promise((ok) => lienzo.toBlob(ok, 'image/jpeg', CALIDAD));
  if (!blob) throw new Error('No se pudo achicar la foto');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ancho, alto };
}

/** Las fotos (File[]) pasadas a un solo PDF en el orden en que se eligieron. Devuelve un File «Fotos AAAA-MM-DD.pdf». */
export async function fotosAPdf(archivos, fecha) {
  const fotos = [];
  for (const a of archivos) fotos.push(await recomprimir(a));
  const bytes = await pdfDeJpegs(fotos);
  return new File([bytes], `Fotos${fecha ? ' ' + fecha : ''}.pdf`, { type: 'application/pdf' });
}

/**
 * Junta varios PDF (en el orden dado) en uno solo. Para Drive: la documentación de una demanda queda en un único archivo.
 * Si alguno no se puede leer (por ejemplo, tiene contraseña), tira el error y quien llama deja los archivos sueltos.
 */
export async function unirPdfs(listaBytes) {
  const { PDFDocument } = await cargarLib();
  const salida = await PDFDocument.create();
  for (const bytes of listaBytes) {
    const origen = await PDFDocument.load(bytes);
    const paginas = await salida.copyPages(origen, origen.getPageIndices());
    paginas.forEach((p) => salida.addPage(p));
  }
  return salida.save();
}

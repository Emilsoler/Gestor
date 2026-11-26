// Foliado de la demanda y su documental (pedido de la persona del 26/11/2026). Se numeran las HOJAS, no las páginas: todo se
// imprime frente y dorso y solo el frente (páginas 1, 3, 5…) lleva, en la esquina superior derecha, el número de foja y al lado la
// firma con el sello del abogado. El número va solo, sin círculo, y es lo más cercano a la esquina. La demanda (2 páginas) es la
// foja 1; la prenda o los pagarés siguen desde la 2. Sirve para la cédula que notifica al demandado («Se adjuntan N (…) fojas
// útiles con copia de demanda y documental»).
//
// La firma es una imagen que NO está en el repositorio (es público): vive en `ajustes_firma.trazo`. El sello se dibuja acá.
// Las medidas están en «píxeles de la foto de ejemplo» que mandó la persona y se pasan a puntos con ESCALA.
import { leerZip } from './cobranzas/acuerdo.js';
import { zip } from './excel.js';

let lib;
const cargarLib = async () => (lib ||= await import('./vendor/pdf-lib.js'));

export const SELLO = { lineas: ['EMILIANO SOLER', 'M.P. 3-35383', 'ABOGADO'] };
const BLOQUE = { ancho: 304, alto: 357 };                    // firma + sello (sin el número)
const FIRMA = { x: 3, y: 15, ancho: 213 };
const RENGLONES = [[179, 253.5], [195.3, 278.7], [211.6, 303.9]]; // centro de la línea de base de cada renglón del sello
const GIRO = -33 * Math.PI / 180, LARGO = 265;               // el sello sube hacia la derecha; largo del primer renglón
const NUMERO = { x: 262, y: 30 };                            // centro del número
export const ESCALA = 0.196;                                 // píxel de la foto → punto (el bloque mide unos 2,1 × 2,5 cm)
const NUMERO_LETRA = 12;                                     // pt: no se achica junto con el sello
/** Hojas que ocupan `paginas` páginas impresas frente y dorso. */
export const hojas = (paginas) => Math.ceil(paginas / 2);
export const BORDE = 14;                                     // pt desde el borde de la hoja
/** Alto que ocupa el foliado desde el borde de arriba: el texto de la demanda empieza más abajo. */
export const ALTO_FOJA = BORDE + BLOQUE.alto * ESCALA;

/** Firma + sello en un solo PNG transparente (usa el canvas del navegador: no corre en Node). `firma`: bytes del PNG. */
export async function componerSello(firma, aumento = 3) {
  const mapa = await createImageBitmap(new Blob([firma], { type: 'image/png' }));
  const lienzo = Object.assign(document.createElement('canvas'), { width: BLOQUE.ancho * aumento, height: BLOQUE.alto * aumento });
  const g = lienzo.getContext('2d');
  g.scale(aumento, aumento);
  g.drawImage(mapa, FIRMA.x, FIRMA.y, FIRMA.ancho, FIRMA.ancho * (mapa.height / mapa.width));
  mapa.close?.();
  const letra = (px) => `bold ${px}px Arial, Helvetica, "Liberation Sans", sans-serif`;
  g.font = letra(100);
  const px = (100 * LARGO) / g.measureText(SELLO.lineas[0]).width;
  g.font = letra(px); g.fillStyle = '#17171c'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  SELLO.lineas.forEach((t, i) => {
    g.save(); g.translate(...RENGLONES[i]); g.rotate(GIRO); g.fillText(t, 0, 0); g.restore();
  });
  const blob = await new Promise((ok) => lienzo.toBlob(ok, 'image/png'));
  if (!blob) throw new Error('No se pudo armar el sello');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Dónde cae un punto de la hoja «como se ve» (x desde la izquierda, y desde abajo) en una página que puede estar girada. */
export function enHoja(giro, caja, x, y) {
  const { x: x0, y: y0, width: w, height: h } = caja;
  if (giro === 90) return { x: x0 + w - y, y: y0 + x };
  if (giro === 180) return { x: x0 + w - x, y: y0 + h - y };
  if (giro === 270) return { x: x0 + y, y: y0 + h - x };
  return { x: x0 + x, y: y0 + y };
}

/** Escribe la foja `n` (y el sello, si hay) en una página de pdf-lib. */
function estampar(L, pagina, n, imagen, fuente) {
  const giro = ((pagina.getRotation().angle % 360) + 360) % 360, caja = pagina.getCropBox();
  const acostada = giro === 90 || giro === 270;
  const ancho = acostada ? caja.height : caja.width, alto = acostada ? caja.width : caja.height;
  // Hay escáneres que arman hojas enormes (en píxeles): el foliado acompaña el tamaño de la hoja.
  const k = ESCALA * Math.max(0.5, Math.min(ancho, alto) / 612);
  const borde = BORDE * (k / ESCALA);
  const izq = ancho - borde - BLOQUE.ancho * k, arriba = alto - borde;
  const rotate = L.degrees(giro);
  if (imagen) pagina.drawImage(imagen, { ...enHoja(giro, caja, izq, arriba - BLOQUE.alto * k), width: BLOQUE.ancho * k, height: BLOQUE.alto * k, rotate });
  const cx = izq + NUMERO.x * k, cy = arriba - NUMERO.y * k;
  const tinta = L.rgb(0.1, 0.1, 0.12);
  const texto = String(n), tam = NUMERO_LETRA * (k / ESCALA);
  pagina.drawText(texto, { ...enHoja(giro, caja, cx - fuente.widthOfTextAtSize(texto, tam) / 2, cy - tam * 0.36), size: tam, font: fuente, color: tinta, rotate });
}

/** Folia el frente de cada hoja (páginas 1, 3, 5…) de un documento de pdf-lib ya abierto; `desde`: número de la primera hoja. `sello`: PNG de `componerSello`, o null (solo el número). */
export async function foliarDoc(doc, sello, desde = 1) {
  const L = await cargarLib();
  const imagen = sello ? await doc.embedPng(sello) : null;
  const fuente = await doc.embedFont(L.StandardFonts.HelveticaBold);
  doc.getPages().forEach((p, i) => { if (i % 2 === 0) estampar(L, p, desde + i / 2, imagen, fuente); });
}

/** La documental (un PDF) foliada desde `desde`. Devuelve { bytes, paginas }. */
export async function foliarPdf(bytes, sello, desde) {
  const { PDFDocument } = await cargarLib();
  const doc = await PDFDocument.load(bytes);
  await foliarDoc(doc, sello, desde);
  return { bytes: await doc.save(), paginas: doc.getPageCount() };
}

export async function contarPaginas(bytes) {
  const { PDFDocument } = await cargarLib();
  return (await PDFDocument.load(bytes)).getPageCount();
}

// ───────────────────────── El Word ─────────────────────────
const EMU = 12700; // por punto
const WORD_RENGLON = 264, WORD_ENTRE = 60, WORD_ABAJO = 850; // interlineado 1,1, 3 pt entre párrafos y 1,5 cm abajo (el modelo: 1,5, 8 pt y 2 cm)
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w10="urn:schemas-microsoft-com:office:word"';

/**
 * El encabezado de un frente del Word: la imagen de firma y sello anclada a la hoja y el número de foja, escrito fijo: no todos
 * los visores calculan un campo «(página + 1) / 2» (saldría «32» en vez de «2»).
 */
export function xmlEncabezado(conSello, numero) {
  const w = BLOQUE.ancho * ESCALA, h = BLOQUE.alto * ESCALA, anchoHoja = 612;
  const izq = anchoHoja - BORDE - w;
  const cx = izq + NUMERO.x * ESCALA, cy = BORDE + NUMERO.y * ESCALA;
  const imagen = conSello ? `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(izq * EMU)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(BORDE * EMU)}</wp:posOffset></wp:positionV><wp:extent cx="${Math.round(w * EMU)}" cy="${Math.round(h * EMU)}"/><wp:wrapNone/><wp:docPr id="901" name="Firma y sello"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="901" name="sello.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdSello"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(w * EMU)}" cy="${Math.round(h * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>` : '';
  const letra = `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:color w:val="1A1A1F"/><w:sz w:val="${NUMERO_LETRA * 2}"/><w:szCs w:val="${NUMERO_LETRA * 2}"/></w:rPr>`;
  const campo = `<w:r>${letra}<w:t>${numero}</w:t></w:r>`;
  // El número va en un cuadro de texto sin borde ni relleno, centrado donde lo pone el PDF.
  const n = (v) => Math.round(v * 100) / 100, ancho = 24, alto = 16;
  const cuadro = `<w:r><w:pict><v:rect id="foja" style="position:absolute;margin-left:${n(cx - ancho / 2)}pt;margin-top:${n(cy - alto / 2)}pt;width:${ancho}pt;height:${alto}pt;z-index:2;mso-position-horizontal-relative:page;mso-position-vertical-relative:page;v-text-anchor:middle" filled="f" stroked="f"><v:textbox inset="0,0,0,0"><w:txbxContent><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="0" w:right="0" w:firstLine="0"/><w:jc w:val="center"/></w:pPr>${campo}</w:p></w:txbxContent></v:textbox></v:rect></w:pict></w:r>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>${imagen}${cuadro}</w:p></w:hdr>`;
}

/** El dorso de cada hoja no lleva nada. */
const ENCABEZADO_DORSO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:p></w:hdr>`;
// Foja 1 (primera página), dorsos (páginas pares) y foja 2 (página 3, si la demanda no entra en una hoja). Una demanda de más de
// 2 hojas (4 páginas) repetiría el «2»: harían falta decenas de pagarés, y la app avisa cuando pasa de una hoja.
const ENCABEZADOS = [
  { tipo: 'first', id: 'rIdFoja', parte: 'header-foja.xml' },
  { tipo: 'even', id: 'rIdDorso', parte: 'header-dorso.xml' },
  { tipo: 'default', id: 'rIdFrente', parte: 'header-frente.xml' },
];

/** El Word de la demanda con el foliado en el encabezado de todas las hojas. `word`: Blob o bytes. Devuelve un Blob. */
export async function foliarWord(word, sello) {
  const bytes = word instanceof Uint8Array ? word : new Uint8Array(await word.arrayBuffer());
  const dec = new TextDecoder(), enc = new TextEncoder();
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const cambios = {
    'word/document.xml': (x) => {
      if (!/<w:sectPr[ >]/.test(x)) throw new Error('El Word no tiene la sección de la hoja');
      const refs = ENCABEZADOS.map((h) => `<w:headerReference w:type="${h.tipo}" r:id="${h.id}"/>`).join('');
      let s = x.replace(/<w:sectPr([^>]*)>/, `<w:sectPr$1>${refs}`)
        // «Primera página diferente»: en el orden de la sección, titlePg va antes de docGrid (o al final).
        .replace(/(<w:docGrid\b[^>]*\/>)?<\/w:sectPr>/, (_, grilla = '') => `<w:titlePg/>${grilla}</w:sectPr>`)
        .replace(/(<w:pgMar\b[^>]*?w:top=")(\d+)"/, (_, a, v) => `${a}${Math.max(+v, Math.round((ALTO_FOJA + 4) * 20))}"`);
      if (!/<w:document\b[^>]*xmlns:r=/.test(s)) s = s.replace('<w:document', `<w:document xmlns:r="${R}"`);
      s = s.replace(/(<w:pgMar\b[^>]*?w:bottom=")(\d+)"/, (_, a, v) => `${a}${Math.min(+v, WORD_ABAJO)}"`);
      // El foliado agranda el margen de arriba: para que la demanda siga en una sola hoja (2 páginas) se junta un poco el texto.
      s = s.replace(/<w:spacing w:before="0" w:after="160" w:line="360" w:lineRule="auto"\/>/g, `<w:spacing w:before="0" w:after="${WORD_ENTRE}" w:line="${WORD_RENGLON}" w:lineRule="auto"/>`);
      return s;
    },
    'word/_rels/document.xml.rels': (x) => x.replace('</Relationships>', `${ENCABEZADOS.map((h) => `<Relationship Id="${h.id}" Type="${R}/header" Target="${h.parte}"/>`).join('')}</Relationships>`),
    // Frentes y dorsos distintos.
    // Word exige el orden de su esquema: va después de «defaultTabStop» y antes de «characterSpacingControl» o «compat».
    'word/settings.xml': (x) => {
      if (/<w:evenAndOddHeaders\b/.test(x)) return x;
      for (const [donde, antes] of [[/<w:defaultTabStop\b[^>]*\/>/, false], [/<w:characterSpacingControl\b|<w:compat>/, true], [/<\/w:settings>/, true]]) {
        if (donde.test(x)) return x.replace(donde, (m) => (antes ? `<w:evenAndOddHeaders/>${m}` : `${m}<w:evenAndOddHeaders/>`));
      }
      return x;
    },
    '[Content_Types].xml': (x) => x
      .replace('</Types>', `${ENCABEZADOS.map((h) => `<Override PartName="/word/${h.parte}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`).join('')}</Types>`)
      .replace('<Default ', `${sello && !/Extension="png"/i.test(x) ? '<Default Extension="png" ContentType="image/png"/>' : ''}<Default `),
  };
  const partes = (await leerZip(bytes)).map((p) => (cambios[p.nombre] ? { nombre: p.nombre, datos: enc.encode(cambios[p.nombre](dec.decode(p.datos))) } : p));
  // Sin settings.xml, Word ignoraría los encabezados de dorso: se agrega uno mínimo.
  if (!partes.some((p) => p.nombre === 'word/settings.xml')) {
    partes.push({ nombre: 'word/settings.xml', datos: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${NS}><w:evenAndOddHeaders/></w:settings>`) });
    const tocar = (nombre, f) => { const p = partes.find((x) => x.nombre === nombre); p.datos = enc.encode(f(dec.decode(p.datos))); };
    tocar('word/_rels/document.xml.rels', (x) => x.replace('</Relationships>', `<Relationship Id="rIdAjustes" Type="${R}/settings" Target="settings.xml"/></Relationships>`));
    tocar('[Content_Types].xml', (x) => x.replace('</Types>', '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'));
  }
  const relsSello = enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSello" Type="${R}/image" Target="media/sello-foja.png"/></Relationships>`);
  const xmls = { first: xmlEncabezado(!!sello, 1), even: ENCABEZADO_DORSO, default: xmlEncabezado(!!sello, 2) };
  for (const h of ENCABEZADOS) {
    partes.push({ nombre: `word/${h.parte}`, datos: enc.encode(xmls[h.tipo]) });
    if (sello && h.tipo !== 'even') partes.push({ nombre: `word/_rels/${h.parte}.rels`, datos: relsSello });
  }
  if (sello) partes.push({ nombre: 'word/media/sello-foja.png', datos: sello });
  return zip(partes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

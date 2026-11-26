// La demanda en PDF con la firma del abogado (botón «Hacer demanda» de Nueva causa).
//
// Se arma a partir del mismo Word que se descarga: se leen sus párrafos (alineación, sangría, negrita, subrayado) y se
// vuelven a escribir en una hoja carta con los márgenes del modelo. La firma (imagen JPEG) va debajo del último párrafo.
// La imagen NO está en el repositorio (es público): vive en la tabla privada `ajustes_firma` y la app la pide al armar el PDF.
//
// Tipografía: Times (estándar del PDF, sin archivos extra). El Word usa Garamond, que es más angosta, así que el PDF puede
// ocupar alguna página más; el texto es el mismo. pdf-lib (docs/vendor/pdf-lib.js, MIT) se carga recién al usarlo.
import { leerZip } from './cobranzas/acuerdo.js';
import { foliarDoc, ALTO_FOJA } from './foja.js';

let lib;
const cargarLib = async () => (lib ||= await import('./vendor/pdf-lib.js'));

const PAGINA = { ancho: 612, alto: 792 };                                   // carta
const MARGEN = { izq: 141.75, der: 42.55, sup: ALTO_FOJA + 4, inf: 56.7 };    // los del modelo; arriba, lo que ocupa el foliado
export const FOJAS_DEMANDA = 2;
// La demanda va en las fojas 1 y 2: se prueba con la letra del modelo (12, interlineado 1,5) y, si no entra, se aprieta de a poco.
const AJUSTES = [[12, 20.5, 8], [12, 19, 6], [11.5, 18, 5], [11, 17, 4], [11, 16, 3], [10.5, 15, 3]]; // [letra, renglón, entre párrafos]
const FIRMA_ANCHO = 105;                                                    // pt (unos 3,7 cm)

const xmlDesesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const pt = (twips) => (Number(twips) || 0) / 20;

/**
 * Los párrafos de un .docx: [{ alinea: 'both'|'center'|'left'|'right', primera, izq, tramos: [{ t, b, i, u }] }].
 * Entiende lo que usan los modelos del estudio (texto con negrita, cursiva y subrayado, sangrías y tabulaciones simples).
 */
export async function parrafosDeDocx(bytes) {
  const partes = await leerZip(bytes);
  const doc = partes.find((p) => p.nombre === 'word/document.xml');
  if (!doc) throw new Error('El Word no tiene texto');
  const xml = new TextDecoder().decode(doc.datos);
  const out = [];
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = m[0];
    const ppr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    const jc = (ppr.match(/<w:jc w:val="(\w+)"/) || [])[1];
    const alinea = jc === 'center' ? 'center' : jc === 'right' ? 'right' : jc === 'both' ? 'both' : 'left';
    const ind = ppr.match(/<w:ind\b[^>]*>/)?.[0] || '';
    const attr = (k) => (ind.match(new RegExp(`w:${k}="(-?\\d+)"`)) || [])[1];
    const tramos = [];
    for (const r of p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)) {
      const rpr = (r[0].match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
      const on = (tag) => new RegExp(`<w:${tag}(?: [^>]*)?/>`).test(rpr) && !new RegExp(`<w:${tag} w:val="(0|false)"`).test(rpr);
      const fmt = { b: on('b'), i: on('i'), u: /<w:u w:val="(?!none)/.test(rpr) };
      for (const x of r[0].matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
        const t = x[0] === '<w:tab/>' ? '    ' : x[0] === '<w:br/>' ? '\n' : xmlDesesc(x[1]);
        if (t) tramos.push({ t, ...fmt });
      }
    }
    out.push({ alinea, primera: pt(attr('firstLine')), izq: pt(attr('left') ?? attr('start')), tramos });
  }
  return out;
}

/** Lo que la tipografía estándar (WinAnsi) no puede escribir se cambia por «?»: un carácter raro no debe cortar todo. */
function seguro(fuente, t) {
  let r = '';
  for (const c of String(t ?? '')) { try { fuente.encodeText(c); r += c; } catch { r += '?'; } }
  return r;
}

/**
 * El PDF (Uint8Array) de la demanda. `parrafos` sale de `parrafosDeDocx`; `firma` son los bytes de la imagen JPEG del pie o
 * null (sin firma, el PDF sale igual y la persona lo firma a mano o lo descarta); `sello` es el PNG de `componerSello` para
 * cada foja (sin él, cada hoja lleva solo el número). Si ni apretada entra en 2 fojas (muchos pagarés), sale con la letra
 * del modelo en las que necesite.
 */
export async function pdfDeDemanda(parrafos, firma, { titulo = 'Demanda', sello = null } = {}) {
  let doc = null;
  for (const ajuste of AJUSTES) {
    const prueba = await componer(parrafos, firma, titulo, ajuste);
    if (prueba.getPageCount() <= FOJAS_DEMANDA) { doc = prueba; break; }
  }
  doc ||= await componer(parrafos, firma, titulo, AJUSTES[0]);
  await foliarDoc(doc, sello, 1);
  return doc.save();
}

async function componer(parrafos, firma, titulo, [TAM, RENGLON, ENTRE]) {
  const { PDFDocument, StandardFonts, rgb } = await cargarLib();
  const doc = await PDFDocument.create();
  doc.setTitle(titulo);
  doc.setProducer('Gestor de juicios - Estudio Soler');
  const F = {
    n: await doc.embedFont(StandardFonts.TimesRoman),
    b: await doc.embedFont(StandardFonts.TimesRomanBold),
    i: await doc.embedFont(StandardFonts.TimesRomanItalic),
    bi: await doc.embedFont(StandardFonts.TimesRomanBoldItalic),
  };
  const fuenteDe = (t) => (t.b && t.i ? F.bi : t.b ? F.b : t.i ? F.i : F.n);
  let pagina = doc.addPage([PAGINA.ancho, PAGINA.alto]);
  let y = PAGINA.alto - MARGEN.sup;
  const lugar = (alto) => {
    if (y - alto < MARGEN.inf) { pagina = doc.addPage([PAGINA.ancho, PAGINA.alto]); y = PAGINA.alto - MARGEN.sup; }
  };
  const anchoTexto = PAGINA.ancho - MARGEN.izq - MARGEN.der;

  for (const p of parrafos) {
    // Palabras con su formato: [{ t, f, u }]
    const palabras = [];
    for (const tr of p.tramos) {
      const fuente = fuenteDe(tr);
      for (const parte of tr.t.split(/(\s+)/)) {
        if (!parte) continue;
        if (/^\s+$/.test(parte)) { if (parte.includes('\n')) palabras.push({ salto: true }); else palabras.push({ esp: true, f: fuente }); } else palabras.push({ t: seguro(fuente, parte), f: fuente, u: tr.u });
      }
    }
    // Armar renglones
    const izq = p.izq, lineas = [];
    let linea = [], ocupado = 0, limite = anchoTexto - izq - p.primera, esPrimera = true;
    const cerrar = (ultima) => { lineas.push({ palabras: linea, ocupado, limite, primera: esPrimera, ultima }); linea = []; ocupado = 0; limite = anchoTexto - izq; esPrimera = false; };
    const sp = (f) => f.widthOfTextAtSize(' ', TAM);
    let pendienteEsp = null;
    for (const w of palabras) {
      if (w.salto) { cerrar(true); pendienteEsp = null; continue; }
      if (w.esp) { pendienteEsp = w.f; continue; }
      const ancho = w.f.widthOfTextAtSize(w.t, TAM);
      const suma = (linea.length ? sp(pendienteEsp || w.f) : 0) + ancho;
      if (linea.length && ocupado + suma > limite + 0.01) cerrar(false);
      ocupado += (linea.length ? sp(pendienteEsp || w.f) : 0) + ancho;
      linea.push({ ...w, ancho });
      pendienteEsp = null;
    }
    if (linea.length || !lineas.length) cerrar(true);

    lineas.forEach((ln) => {
      lugar(RENGLON);
      const base = y - TAM * 0.85;
      const n = ln.palabras.length, espacio = n > 1 ? ln.palabras[0].f.widthOfTextAtSize(' ', TAM) : 0;
      const extra = p.alinea === 'both' && !ln.ultima && n > 1 ? (ln.limite - ln.ocupado) / (n - 1) : 0;
      const largo = ln.ocupado;
      let x = MARGEN.izq + izq + (ln.primera ? p.primera : 0);
      if (p.alinea === 'center') x = MARGEN.izq + (anchoTexto - largo) / 2;
      else if (p.alinea === 'right') x = PAGINA.ancho - MARGEN.der - largo;
      ln.palabras.forEach((w) => {
        pagina.drawText(w.t, { x, y: base, size: TAM, font: w.f, color: rgb(0, 0, 0) });
        if (w.u) pagina.drawLine({ start: { x, y: base - 1.6 }, end: { x: x + w.ancho, y: base - 1.6 }, thickness: 0.6, color: rgb(0, 0, 0) });
        x += w.ancho + espacio + extra;
      });
      y -= RENGLON;
    });
    y -= ENTRE;
  }

  if (firma && firma.length) {
    let img = null;
    try { img = await doc.embedJpg(firma); } catch { img = null; }
    if (img) {
      const alto = FIRMA_ANCHO * (img.height / img.width);
      lugar(alto + 6);
      pagina.drawImage(img, { x: PAGINA.ancho - MARGEN.der - FIRMA_ANCHO - 20, y: y - alto, width: FIRMA_ANCHO, height: alto });
      y -= alto;
    }
  }
  return doc;
}

/** Atajo: el PDF a partir del .docx ya armado (Blob o bytes). */
export async function pdfDesdeWord(word, firma, opciones) {
  const bytes = word instanceof Uint8Array ? word : new Uint8Array(await word.arrayBuffer());
  return pdfDeDemanda(await parrafosDeDocx(bytes), firma, opciones);
}

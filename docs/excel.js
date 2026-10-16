// Arma archivos de Excel (.xlsx) en el navegador, sin librerías ni servidores.
//
// Un .xlsx es un .zip con unas pocas hojas XML adentro. Acá se escribe lo justo para una
// planilla: texto, importes, fechas, fórmulas y un puñado de estilos fijos (ESTILOS).
// Las fórmulas viajan con su resultado ya calculado: así se ven bien también en los visores
// del celular, que no calculan; Excel y LibreOffice las vuelven a calcular al abrir.

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
export const TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Estilos de celda disponibles: el número es su posición en `cellXfs` de styles.xml. */
const ESTILOS = { normal: 0, titulo: 1, nota: 2, cab: 3, cabFecha: 4, texto: 5, pesos: 6, calculo: 7, totTexto: 8, totPesos: 9, negrita: 10, fecha: 11 };

// Pesos con separador de miles y centavos; el cero se ve como un guion, como en una planilla contable.
const FMT_PESOS = '"$ "#,##0.00;-"$ "#,##0.00;"-"';
const FMT_FECHA = 'dd/mm/yyyy';
const BORDE = 'FFBFC5BC';

const ESTILOS_XML = XML + `<styleSheet xmlns="${NS}">
<numFmts count="2"><numFmt numFmtId="164" formatCode="${esc(FMT_PESOS)}"/><numFmt numFmtId="165" formatCode="${FMT_FECHA}"/></numFmts>
<fonts count="5">
<font><sz val="10"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="10"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="14"/><name val="Arial"/><family val="2"/></font>
<font><i/><sz val="9"/><color rgb="FF5D6861"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/><family val="2"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F5F5B"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFECEEEA"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="${BORDE}"/></left><right style="thin"><color rgb="${BORDE}"/></right><top style="thin"><color rgb="${BORDE}"/></top><bottom style="thin"><color rgb="${BORDE}"/></bottom><diagonal/></border>
<border><left style="thin"><color rgb="${BORDE}"/></left><right style="thin"><color rgb="${BORDE}"/></right><top style="medium"><color rgb="FF1D2420"/></top><bottom style="thin"><color rgb="${BORDE}"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="165" fontId="4" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function esc(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '') // caracteres que el XML no admite
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Letra de la columna (0 → A, 25 → Z, 26 → AA). */
export function columna(n) {
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const esFecha = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
/** Excel guarda las fechas como días contados desde el 30/12/1899. */
function serial(v) { const [y, m, d] = v.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; }

function celdaXml(c, ref) {
  if (c == null) return '';
  const s = ESTILOS[c.s] || 0, st = s ? ` s="${s}"` : '';
  if (c.f != null) {
    const texto = typeof c.v === 'string';
    return `<c r="${ref}"${st}${texto ? ' t="str"' : ''}><f>${esc(c.f)}</f>${c.v == null ? '' : `<v>${esc(c.v)}</v>`}</c>`;
  }
  if (c.v == null || c.v === '' || (typeof c.v === 'number' && !Number.isFinite(c.v))) return `<c r="${ref}"${st}/>`;
  if (c.fecha && esFecha(c.v)) return `<c r="${ref}"${st}><v>${serial(c.v)}</v></c>`;
  if (typeof c.v === 'number') return `<c r="${ref}"${st}><v>${c.v}</v></c>`;
  const texto = String(c.v), espacios = /^\s|\s$/.test(texto) ? ' xml:space="preserve"' : ''; // si no, Excel los recorta
  return `<c r="${ref}"${st} t="inlineStr"><is><t${espacios}>${esc(texto)}</t></is></c>`;
}

function vistaXml(cg) {
  if (!cg || (!cg.col && !cg.fila)) return '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const celda = `${columna(cg.col || 0)}${(cg.fila || 0) + 1}`;
  const panel = cg.col && cg.fila ? 'bottomRight' : cg.fila ? 'bottomLeft' : 'topRight';
  const x = cg.col ? ` xSplit="${cg.col}"` : '', y = cg.fila ? ` ySplit="${cg.fila}"` : '';
  const otras = panel === 'bottomRight' ? '<selection pane="topRight"/><selection pane="bottomLeft"/>' : '';
  return `<sheetViews><sheetView workbookViewId="0"><pane${x}${y} topLeftCell="${celda}" activePane="${panel}" state="frozen"/>${otras}<selection pane="${panel}" activeCell="${celda}" sqref="${celda}"/></sheetView></sheetViews>`;
}

function hojaXml(h) {
  const filas = h.filas || [];
  const ancho = Math.max(1, ...filas.map((f) => (f ? f.length : 0)));
  const cols = (h.anchos || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const datos = filas.map((f, i) => {
    const celdas = (f || []).map((c, j) => celdaXml(c, columna(j) + (i + 1))).join('');
    return celdas ? `<row r="${i + 1}">${celdas}</row>` : '';
  }).join('');
  return XML + `<worksheet xmlns="${NS}" xmlns:r="${NS_R}">` +
    (h.apaisada ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '') +
    `<dimension ref="A1:${columna(ancho - 1)}${Math.max(1, filas.length)}"/>` +
    vistaXml(h.congelar) +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${datos}</sheetData>` +
    '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
    // A4 apaisada y todo el ancho en una hoja: lista para imprimir o adjuntar
    (h.apaisada ? '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' : '') +
    '</worksheet>';
}

const nombreHoja = (s, i) => String(s || '').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || `Hoja ${i + 1}`;

/**
 * Arma un .xlsx y lo devuelve como Blob.
 *   hojas: [{ nombre, anchos: [ancho de cada columna], filas: [[celda…]…], congelar: { col, fila }, apaisada }]
 *   celda: null | { v, s, f, fecha }
 *     v: texto o número (con `fecha`, una fecha 'aaaa-mm-dd'; con `f`, el resultado ya calculado)
 *     s: nombre de estilo (ver ESTILOS) · f: fórmula, sin el "=" del principio
 */
export function xlsx(hojas) {
  const n = hojas.length;
  const partes = [
    ['[Content_Types].xml', XML + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', XML + `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', XML + `<workbook xmlns="${NS}" xmlns:r="${NS_R}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>` +
      hojas.map((h, i) => `<sheet name="${esc(nombreHoja(h.nombre, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'],
    ['xl/_rels/workbook.xml.rels', XML + `<Relationships xmlns="${NS_PKG}">` +
      hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${n + 1}" Type="${NS_R}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', ESTILOS_XML],
    ...hojas.map((h, i) => [`xl/worksheets/sheet${i + 1}.xml`, hojaXml(h)]),
  ];
  const enc = new TextEncoder();
  return zip(partes.map(([nombre, texto]) => ({ nombre, datos: enc.encode(texto) })));
}

// ───────────────────────── .zip sin comprimir ─────────────────────────
// Excel acepta las partes guardadas tal cual (método "store"): para planillas de pocos KB
// no hace falta comprimir, y así no se depende de nada más del navegador.

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = TABLA_CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function zip(archivos) {
  const enc = new TextEncoder(), d = new Date();
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dia = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locales = [], central = [];
  let pos = 0;
  for (const a of archivos) {
    const nombre = enc.encode(a.nombre), datos = a.datos, crc = crc32(datos);
    const loc = new DataView(new ArrayBuffer(30));
    loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint16(6, 0x0800, true); loc.setUint16(8, 0, true);
    loc.setUint16(10, hora, true); loc.setUint16(12, dia, true); loc.setUint32(14, crc, true);
    loc.setUint32(18, datos.length, true); loc.setUint32(22, datos.length, true); loc.setUint16(26, nombre.length, true); loc.setUint16(28, 0, true);
    locales.push(new Uint8Array(loc.buffer), nombre, datos);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true);
    cen.setUint16(12, hora, true); cen.setUint16(14, dia, true); cen.setUint32(16, crc, true);
    cen.setUint32(20, datos.length, true); cen.setUint32(24, datos.length, true); cen.setUint16(28, nombre.length, true);
    cen.setUint16(30, 0, true); cen.setUint16(32, 0, true); cen.setUint16(34, 0, true); cen.setUint16(36, 0, true); cen.setUint32(38, 0, true);
    cen.setUint32(42, pos, true);
    central.push(new Uint8Array(cen.buffer), nombre);
    pos += 30 + nombre.length + datos.length;
  }
  const tam = central.reduce((a, b) => a + b.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true); fin.setUint16(4, 0, true); fin.setUint16(6, 0, true);
  fin.setUint16(8, archivos.length, true); fin.setUint16(10, archivos.length, true);
  fin.setUint32(12, tam, true); fin.setUint32(16, pos, true); fin.setUint16(20, 0, true);
  return new Blob([...locales, ...central, new Uint8Array(fin.buffer)], { type: TIPO_XLSX });
}

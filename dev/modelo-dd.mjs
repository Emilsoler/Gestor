// Arma docs/cobranzas/modelos/demanda-documentos.docx: el modelo de la demanda ejecutiva de pagarés del estudio ("haz DD",
// botón «Hacer demanda → Documentos» de Nueva causa). El texto es el de las demandas de pagarés del estudio (las de Drive,
// p. ej. «261008- DEMANDA»), al pie de la letra salvo la numeración (los modelos repetían «III» y saltaban el «IV»: acá es
// I, II, III, IV, V); solo los datos variables son {{campos}}. {{pagare}} es un renglón que se repite por cada pagaré.
// Formato: Garamond 12, interlineado 1,5, justificado, fondo lavanda (CCC0D9), sangría de primera línea en los párrafos numerados.
// Se parte del esqueleto del modelo del convenio (estilos, tema, ajustes) y se reemplaza el cuerpo.
//   node dev/modelo-dd.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { leerZip } from '../docs/cobranzas/acuerdo.js';
import { zip } from '../docs/excel.js';

const aqui = (r) => new URL(r, import.meta.url);
const ESQUELETO = aqui('../docs/cobranzas/modelos/acuerdo-refinanciacion.docx');
const SALIDA = aqui('../docs/cobranzas/modelos/demanda-documentos.docx');

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const FUENTE = '<w:rFonts w:ascii="Garamond" w:hAnsi="Garamond" w:cs="Garamond" w:eastAsia="Garamond"/>';
const corrida = (t, { b, u } = {}) => `<w:r><w:rPr>${FUENTE}${b ? '<w:b/><w:bCs/>' : ''}${u ? '<w:u w:val="single"/>' : ''}<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="es-AR"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
/** Un párrafo: segmentos [texto, {b, u}] ; opciones: centro, sangria (primera línea, en twips), izq. */
function parrafo(segs, { centro = false, sangria = 0, izq = 0 } = {}) {
  const ind = sangria ? `<w:ind w:firstLine="${sangria}"/>` : izq ? `<w:ind w:left="${izq}"/>` : '';
  const pPr = `<w:pPr><w:spacing w:before="0" w:after="160" w:line="360" w:lineRule="auto"/>${ind}<w:jc w:val="${centro ? 'center' : 'both'}"/><w:rPr>${FUENTE}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:pPr>`;
  return `<w:p>${pPr}${segs.map((s) => (typeof s === 'string' ? corrida(s) : corrida(s[0], s[1]))).join('')}</w:p>`;
}
const SANGRIA = 2211;
const BU = { b: true, u: true };
const titulo = (t) => parrafo([[t, BU]]);
const num = (...segs) => parrafo(segs, { sangria: SANGRIA });
const raya = (t) => parrafo(['- ' + t], { izq: 708 });

const cuerpo = [
  parrafo([['DEMANDA EJECUTIVA', BU]], { centro: true }),
  parrafo(['Sr. Juez:']),
  num('SOLER, Carlos Emiliano MP 3-35383, constituyendo domicilio procesal en calle Bv. Colón n° 135 de esta ciudad de Bell Ville, ante V.S. comparezco y digo:'),
  titulo('I.- PERSONERÍA'),
  num('Como lo acredito con copia del Poder General para Pleitos que en este acto se acompaña, soy mandatario de la “ASOCIACIÓN MUTUAL BELL”, con domicilio en calle Bv. Colón n° 135 de esta ciudad. En tal carácter solicito se me tenga por parte.'),
  titulo('II.- OBJETO'),
  num('Que siguiendo expresas instrucciones de mi mandante, vengo a promover demanda ejecutiva en contra de {{demandados}}, para que {{sea_condenado}} al pago de la suma de Pesos {{monto_letras}} ($ {{monto}}) con más intereses y costas.'),
  titulo('III.- TÍTULO BASE DE LA ACCIÓN:'),
  num('Que se pretende ejecutar {{titulos_intro}} que se describen a continuación:'),
  parrafo(['{{pagare}}'], { izq: 708 }),
  num('Se declara bajo fe de juramento y en cumplimiento de las reglamentaciones vigentes que los instrumentos acompañados son originales y quedan a disposición del tribunal para la oportunidad que los requiera.'),
  parrafo([['IV.- PRUEBA:', BU], ' Ofrezco la siguiente prueba:']),
  parrafo(['a.- Documental: Títulos descriptos supra.'], { izq: 708 }),
  titulo('V.- PETITUM:'),
  parrafo(['1.- Me tenga por presentado, por parte, en el carácter invocado y con el domicilio constituido.'], { izq: 708 }),
  parrafo(['2.- De a la presente el trámite de ley y cite y emplace {{al_demandado}} a estar a derecho bajo apercibimiento de ley, y de remate para que opongan excepciones legítimas al progreso de la acción.'], { izq: 708 }),
  parrafo(['3.- Por ofrecida la prueba que se expresa.'], { izq: 708 }),
  parrafo(['4.- Oportunamente y previos los trámites previstos por la ley ritual, dicte Sentencia mandando llevar adelante la ejecución por el capital reclamado con más los intereses de ley y costas.'], { izq: 708 }),
  parrafo([['SERÁ JUSTICIA', { b: true }]]),
].join('');

// Hoja carta, con los márgenes de los oficios del estudio.
const SECT = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1531" w:right="851" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>';

const dec = new TextDecoder(), enc = new TextEncoder();
const partes = await leerZip(new Uint8Array(readFileSync(ESQUELETO)));
const salida = partes.map((p) => {
  const txt = () => dec.decode(p.datos);
  if (p.nombre === 'word/document.xml') {
    const xml = txt();
    const cab = xml.slice(0, xml.indexOf('<w:body>'));
    return { nombre: p.nombre, datos: enc.encode(`${cab}<w:background w:color="CCC0D9"/><w:body>${cuerpo}${SECT}</w:body></w:document>`.replace(/(<w:document[^>]*>)(<w:background[^>]*>)/, '$1$2')) };
  }
  if (p.nombre === 'word/styles.xml') {
    return { nombre: p.nombre, datos: enc.encode(txt().replace(/Times New Roman/g, 'Garamond').replace('<w:sz w:val="22"/><w:szCs w:val="22"/>', '<w:sz w:val="24"/><w:szCs w:val="24"/>')) };
  }
  if (p.nombre === 'word/_rels/document.xml.rels') {
    return { nombre: p.nombre, datos: enc.encode(txt().replace(/<Relationship [^>]*relationships\/footer"[^>]*\/>/, '')) };
  }
  if (p.nombre === 'word/footer1.xml' || p.nombre === 'word/webSettings.xml' && false) return null;
  if (p.nombre === '[Content_Types].xml') {
    return { nombre: p.nombre, datos: enc.encode(txt().replace(/<Override PartName="\/word\/footer1.xml"[^>]*\/>/, '')) };
  }
  return p;
}).filter(Boolean);
writeFileSync(SALIDA, Buffer.from(await zip(salida, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').arrayBuffer()));
console.log('Listo:', SALIDA.pathname);

// Arma docs/cobranzas/modelos/demanda-prendaria.docx: el modelo de la demanda ejecutiva prendaria del estudio ("haz DP").
// El texto es el de la demanda del estudio, al pie de la letra; solo los datos variables son {{campos}}.
// Formato: Garamond 12, interlineado 1,5, justificado, fondo lavanda (CCC0D9), sangría de primera línea en los párrafos numerados.
// Se parte del esqueleto del modelo del convenio (estilos, tema, ajustes) y se reemplaza el cuerpo.
//   node dev/modelo-dp.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { leerZip } from '../docs/cobranzas/acuerdo.js';
import { zip } from '../docs/excel.js';

const aqui = (r) => new URL(r, import.meta.url);
const ESQUELETO = aqui('../docs/cobranzas/modelos/acuerdo-refinanciacion.docx');
const SALIDA = aqui('../docs/cobranzas/modelos/demanda-prendaria.docx');

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
  parrafo([['DEMANDA', BU]], { centro: true }),
  parrafo(['Sr. Juez:']),
  num('SOLER, Carlos Emiliano MP 3-35383, constituyendo domicilio procesal en calle Bv. Colón n° 135 de esta ciudad de Bell Ville, ante V.S. comparezco y digo:'),
  titulo('I.- PERSONERÍA'),
  num('Como lo acredito con copia del Poder General para Pleitos que en este acto se acompaña, soy mandatario de la “ASOCIACIÓN MUTUAL BELL”, con domicilio en calle Bv. Colón n° 135 de esta ciudad. En tal carácter solicito se me tenga por parte.'),
  titulo('II.- OBJETO'),
  num('Que siguiendo expresas instrucciones de mi mandante, vengo a promover demanda de ejecución prendaria en contra en contra de {{deudor_nombre}}, DNI Nº {{deudor_dni}} con domicilio en calle {{deudor_calle}} de la ciudad de {{deudor_ciudad}}, Provincia de Córdoba, para que sea condenado al pago de la suma de Pesos {{monto_letras}} ($ {{monto}}) con más intereses y costas.'),
  num(['III.- Préstamo - garantía prendaria:', BU], ' originariamente, con fecha {{prestamo_fecha}} mi mandante otorgó un préstamo de dinero al demandado. En esa fecha se suscribió el contrato de prenda con registro- cuyo certificado acompaño- a favor de la “ASOCIACIÓN MUTUAL BELL”, por el importe de Pesos {{prenda_letras}} ($ {{prenda_monto}}). Dicho contrato fue inscripto en el Registro de la Propiedad del Automotor de {{registro}} con fecha {{inscripcion_fecha}}.'),
  num(['IV.- Bien prendado:', BU], ' Dicho gravamen prendario se constituyó sobre el siguiente bien: automotor marca {{marca}} dominio {{dominio}} modelo {{modelo}}, motor {{motor}}, chasis {{chasis}}.'),
  num(['V.- Cuotas:', BU], ' en el contrato con garantía prendaria se pactaron {{cuotas_cant}} cuotas mensuales, iguales y consecutivas de Pesos {{cuota_letras}} ($ {{cuota_monto}}) cada una, con vencimiento la primera el {{primer_venc}} y las restantes cada treinta días subsiguientes.'),
  num(['VI.- Mora:', BU], ' Que la deuda se encuentra en mora, habiéndose abonado {{cuotas_pagadas}} cuotas. La mora se produjo a partir del vencimiento de la cuota n° {{mora_cuota_nro}}, es decir, el {{mora_fecha}}. El contrato prendario tiene previsto que a falta de pago de cualquiera de las cuotas, produce el automático vencimiento de las restantes pendientes de pago, las que se consideran de plazo vencido y exigibles.'),
  num(['VII.- Secuestro:', BU], ' que sin perjuicio de la citación a juicio y de remate a practicarse, solicito, en mérito de las disposiciones legales que invoco y a lo pactado en el contrato prendario, el secuestro del bien afectado al privilegio prendario, librándose al efecto oficio al Sr. Oficial de Justicia. La diligencia de secuestro del bien prendado, deberá practicarse en el domicilio de los demandados, anteriormente denunciado, o donde el bien se encuentre, inclusive en la vía pública, quedando autorizado para intervenir en el diligenciamiento el martillero DANIELE FRANCO, quien podrá denunciar el lugar donde el bien se encuentre, identificándolo y trasladarlo al lugar de depósito, recabar la colaboración de cerrajeros, autorizando al oficial de justicia para allanar domicilios y requerir el auxilio de la fuerza pública si fuere menester y a realizar el procedimiento en día y hora inhábil si fuere necesario, con facultad de denunciar hasta un domicilio más, en caso de no encontrarse el bien en el denunciado. V.S. se dignará a librar el oficio correspondiente.'),
  num(['VIII.- Trámite:', BU], ' Solicito a V.S. otorgue a la presente el trámite previsto por el art 29 ley 12.962, es decir, “…despache mandamiento de embargo y secuestro… En el mismo decreto en que se dicten las medidas anteriores, se citará de remate al deudor, notificándole que, si no opone excepción legítima en el término de tres días perentorios, se llevará adelante la ejecución y se ordenará la venta de la prenda”.'),
  num('IX.- Declaro bajo juramento que la documental que se incorpora como adjunto al presente escrito es copia fiel de su original y ha sido digitalizada sin omitir ni falsear dato alguno. Los originales se encuentran en mi poder y los pongo a disposición de V.S.'),
  num('X.- Por todo lo expuesto, solicito a V.S:'),
  raya('Téngame por presentado, por parte en el carácter invocado y con domicilio constituido.'),
  raya('Por promovida la presente ejecución en contra de los demandados.'),
  raya('Cite y emplace al demandado a estar a derecho y de remate con las previsiones de ley.'),
  raya('Libre mandamiento de ejecución, embargo y secuestro.'),
  raya('Haga lugar a la demanda, mandando a llevar adelante la ejecución prendaria en contra de los deudores hasta el completo pago de la suma reclamada con más intereses y costas.'),
  raya('Por acompañada la documental.'),
  raya('Imprima trámite a la presente conforme art 29 ley 12.962.'),
  raya('Tenga presente lo declarado respecto de la documental.'),
  parrafo(['ES DE LEY']),
].join('');

// Hoja carta, con los márgenes de los oficios del estudio.
const SECT = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1531" w:right="851" w:bottom="1134" w:left="2835" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>';

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

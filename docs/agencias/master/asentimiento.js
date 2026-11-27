// Asentimiento conyugal (pedido de la persona, 27/11/2026): cuando el deudor es casado/a, sale junto con la PRENDA.
// El texto es el del modelo que usa la Mutual. A diferencia de los formularios del Registro, es una hoja completa
// (texto y datos) que se imprime en papel común. Lo que no se sabe queda como una línea en blanco: no se inventa nada.
// Las firmas (cónyuge y quienes certifican) quedan vacías.
import { fechaLarga } from './prendaforms.js';

let lib = null;
const cargarLib = async () => (lib ||= await import('../../vendor/pdf-lib.js'));
const MM = 72 / 25.4;
const BLANCO = '........................';
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** «lunes, 10 de mayo de 2010» (vacío si la fecha no es válida). */
export function fechaConDia(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  return `${DIAS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]}, ${fechaLarga(iso)}`;
}

const limpio = (v) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t === '-' ? '' : t; };
const conPuntos = (v) => { const d = limpio(v).replace(/\D/g, ''); return d ? Number(d).toLocaleString('es-AR') : ''; };
const importe = (n) => (Number(n) > 0 ? `$${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');

/** Los datos que van en la hoja, a partir de los de la pantalla de revisión de la prenda. */
export function datosAsentimiento(p) {
  const d = p.deudor || {}, c = p.conyuge || {}, v = p.vehiculo || {}, a = p.asentimiento || {};
  return {
    acreedor: limpio(p.acreedor?.nombre), deudor: limpio(d.nombre), monto: importe(p.monto),
    nupcias: limpio(a.nupcias), lugar: limpio(a.lugar), fecha: fechaConDia(a.fecha),
    marca: limpio(v.marca), modelo: limpio(v.modelo), anio: limpio(v.anio), motor: limpio(v.motor), marcaMotor: limpio(v.marcaMotor),
    chasis: limpio(v.chasis), marcaChasis: limpio(v.marcaChasis), dominio: limpio(v.dominio),
    nombre: limpio(c.nombre), dni: conPuntos(c.dni), domicilio: limpio(c.domicilio),
  };
}

/** Lo que va a quedar en blanco, para avisarlo en pantalla. */
export function faltanAsentimiento(p) {
  const x = datosAsentimiento(p);
  return [['nupcias', 'nupcias'], ['lugar', 'lugar del matrimonio'], ['fecha', 'fecha del matrimonio'],
    ['nombre', 'nombre del cónyuge'], ['dni', 'DNI del cónyuge'], ['domicilio', 'domicilio del cónyuge'], ['marcaMotor', 'marca del motor'],
    ['motor', 'N° de motor'], ['marcaChasis', 'marca del chasis'], ['chasis', 'N° de chasis'], ['dominio', 'dominio'], ['anio', 'año']]
    .filter(([k]) => !x[k]).map(([, t]) => t);
}

export function textoAsentimiento(x) {
  const o = (v) => v || BLANCO;
  return {
    comparece: `En mi carácter de cónyuge en ${x.nupcias ? `${x.nupcias}°` : '......'} nupcias de ${o(x.deudor)}, por matrimonio contraído en ${o(x.lugar)}, en el día ${o(x.fecha)}.`,
    asiento: 'Doy mi expreso asentimiento en los términos del art.470 inc. A de Cod.Civ. y Com. (Ley Nro. 26994), para que mi nombrado cónyuge: A) VENDA; B) GRAVE CON DERECHO REAL DE PRENDA CON REGISTROS, del automotor cuyos datos se consignan a continuación:',
    certifica: 'Certificamos que la firma correspondiente al cónyuge del deudor es auténtica.',
  };
}

/** Una sola hoja A4 (entra igual en carta si se imprime «ajustada»). */
export async function armarAsentimiento(p) {
  const { PDFDocument, StandardFonts, rgb } = await cargarLib();
  const doc = await PDFDocument.create();
  const x = datosAsentimiento(p), t = textoAsentimiento(x);
  doc.setTitle(`Asentimiento conyugal - ${x.deudor}`);
  doc.setProducer('Asociación Mutual Bell');
  const fn = await doc.embedFont(StandardFonts.Helvetica), fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 210 * MM, H = 297 * MM, IZQ = 22 * MM, ANCHO = W - 2 * IZQ, negro = rgb(0, 0, 0);
  const pg = doc.addPage([W, H]);
  const seguro = (s) => [...String(s)].map((c) => { try { fn.encodeText(c); return c; } catch { return '?'; } }).join('');
  // Un dato largo achica la letra para no salirse de su lugar.
  const escribir = (s, px, y, { f = fn, tam = 11, max = W - IZQ - px } = {}) => {
    const v = seguro(s); let n = tam;
    while (n > 6 && f.widthOfTextAtSize(v, n) > max) n -= 0.25;
    pg.drawText(v, { x: px, y, size: n, font: f, color: negro });
  };
  const centrado = (s, y, o = {}, medio = W / 2) => { const f = o.f || fn, tam = o.tam || 11; escribir(s, medio - f.widthOfTextAtSize(seguro(s), tam) / 2, y, o); };
  const campo = (rotulo, valor, px, y, sangria, max) => { escribir(rotulo, px, y); escribir(valor || BLANCO, px + sangria, y, { f: valor ? fb : fn, max }); };
  // Párrafo justificado; devuelve la altura donde sigue.
  const parrafo = (texto, y) => {
    const lineas = [[]];
    for (const w of seguro(texto).split(' ')) {
      const l = lineas.at(-1);
      if (l.length && fn.widthOfTextAtSize([...l, w].join(' '), 11) > ANCHO) lineas.push([w]); else l.push(w);
    }
    lineas.forEach((l, i) => {
      const ultima = i === lineas.length - 1;
      const sep = ultima || l.length < 2 ? fn.widthOfTextAtSize(' ', 11) : (ANCHO - l.reduce((a, w) => a + fn.widthOfTextAtSize(w, 11), 0)) / (l.length - 1);
      let px = IZQ;
      for (const w of l) { pg.drawText(w, { x: px, y, size: 11, font: fn, color: negro }); px += fn.widthOfTextAtSize(w, 11) + sep; }
      y -= 17;
    });
    return y;
  };
  const raya = (x1, x2, y) => pg.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.7, color: negro });

  let y = H - 22 * MM;
  const titulo = 'ASENTIMIENTO CONYUGAL', wt = fb.widthOfTextAtSize(titulo, 14);
  centrado(titulo, y, { f: fb, tam: 14 }); raya((W - wt) / 2, (W + wt) / 2, y - 3);
  y -= 34;
  for (const [r, v] of [['Acreedor:', x.acreedor], ['Deudor:', x.deudor], ['Monto:', x.monto]]) {
    campo(r, v, IZQ, y, fn.widthOfTextAtSize(r, 11) + 8); y -= 19;
  }
  y = parrafo(t.comparece, y - 16);
  y = parrafo(t.asiento, y - 10);
  y -= 16;
  const DER = IZQ + 102 * MM;
  const fila = (a, b) => {
    campo(a[0], a[1], IZQ, y, 32 * MM, b ? 66 * MM : ANCHO - 32 * MM);
    if (b) campo(b[0], b[1], DER, y, 32 * MM, W - IZQ - DER - 32 * MM);
    y -= 22;
  };
  fila(['MARCA:', x.marca]);
  fila(['MODELO:', x.modelo]);
  fila(['AÑO:', x.anio]);
  fila(['MOTOR Nro.:', x.motor], ['MARCA MOTOR:', x.marcaMotor]);
  fila(['CHASIS Nro.:', x.chasis], ['MARCA CHASIS:', x.marcaChasis]);
  fila(['DOMINIO:', x.dominio]);
  y -= 62;
  raya(W - IZQ - 70 * MM, W - IZQ, y); centrado('FIRMA', y - 15, { f: fb }, W - IZQ - 35 * MM);
  y -= 46;
  campo('APELLIDO Y NOMBRE:', x.nombre, IZQ, y, 48 * MM); y -= 22;
  campo('TIPO DOCUMENTO:', 'DNI', IZQ, y, 48 * MM, 20 * MM); campo('Nro. Documento:', x.dni, DER - 10 * MM, y, 34 * MM); y -= 22;
  campo('DOMICILIO:', x.domicilio, IZQ, y, 48 * MM);
  y -= 48;
  centrado(t.certifica, y);
  y -= 80;
  raya(IZQ + 4 * MM, IZQ + 70 * MM, y); raya(W - IZQ - 70 * MM, W - IZQ - 4 * MM, y);
  return doc.save();
}

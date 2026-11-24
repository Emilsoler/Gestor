// «Generar documentación» de un crédito prendario aprobado (Créditos y Cobros → Agencias → Solicitudes): completa a
// máquina los formularios OFICIALES del Registro de la Propiedad del Automotor, para imprimirlos sobre el papel en
// blanco: el Formulario 03 (solicitud de inscripción, 2 hojas) y el Contrato de Prenda con Registro en sus dos modelos
// (A: «Ministerio de Educación y Justicia»; B: «Ministerio de Justicia», con la parte del cónyuge). Los dos modelos se
// presentan juntos.
//
// El PDF lleva SOLO los datos, en el lugar de cada casillero: lo que está impreso en el papel no se repite. Las
// posiciones están medidas sobre el escaneo de los formularios (A4, 150 puntos por pulgada, origen arriba a la
// izquierda); `dx` y `dy` (en milímetros) corrigen lo que cada impresora corre el papel. «Hoja de prueba» imprime
// cruces para ajustarlos. Lo que no se sabe queda en blanco: no hay valores por defecto (un dato equivocado va a una
// escritura pública del Registro).
//
// Lo arma el navegador con pdf-lib (docs/vendor/pdf-lib.js; MIT), cargada recién al pedir el PDF. Nada sale de la app.
import { enLetras, cifra, dniOficio, partirDomicilio, partirVehiculo } from '../oficio.js';

let lib = null;
const cargarLib = async () => (lib ||= await import('../vendor/pdf-lib.js'));

const MM = 72 / 25.4;
// Cada hoja oficial tiene su tamaño real (ancho × alto, en mm, medidos por la persona el 24/11/2026). Las posiciones de abajo
// están en píxeles de los escaneos (1240 × 1755), pero el escaneo NO es la hoja entera estirada: tiene márgenes y su propia
// escala. El 24/11/2026 una impresión salió corrida (arriba casi bien, abajo hasta 2 cm más arriba) y se midió sobre una foto
// enderezada del formulario completo: en el 03 (hoja 1) un píxel son 0,189 mm, igual en los dos ejes, y la esquina de la hoja
// está en el píxel (83; 26). Esa relación es la de CAL: mm = px × k + o. Las hojas sin medir (los dos
// contratos) siguen con el supuesto anterior (hoja entera estirada), que se sabe equivocado: hasta medirlas sobre una foto
// del formulario en blanco, no imprimir esas sobre el papel oficial sin probar antes en una hoja común.
const SW = 1240, SH = 1755;
const HOJAS = { f03: [202, 305], a: [214, 328], b: [214, 328] }; // Formulario 03, contrato original, copia no negociable (la copia mide igual que el original: aviso de la persona del 24/11/2026)
const CAL = { f03: [{ k: 0.189, ox: -15.7, oy: -5.0 }, null],
  // contratos (edición «Ministerio de Educación y Justicia», medidos el 24/11/2026 sobre fotos enderezadas de las hojas en blanco)
  a: [{ kx: 0.2002, ky: 0.1966, ox: -16.7, oy: 1.8, xmax: 205 }, null],
  b: [{ kx: 0.2002, ky: 0.1966, ox: -16.7, oy: 0.9, xmax: 205 }, null] }; // por hoja: frente y dorso
const tam = (clave) => HOJAS[clave].map((m) => m * MM);
const calDe = new WeakMap(); // página → su calibración (la pone `nuevaPagina`)
const anchoDe = (pg, c) => {
  const { sx, ox, xmax } = escala(pg), w = (c.w || 9999) * sx;
  return xmax ? Math.min(w, xmax - (c.x * sx + ox)) : w;
};
const nuevaPagina = (doc, clave, i) => { const pg = doc.addPage(tam(clave)); calDe.set(pg, CAL[clave]?.[i] || null); return pg; };
/** De píxeles del escaneo a puntos del PDF: x = px × sx + ox; y (desde arriba) = py × sy + oy. */
const escala = (pg) => {
  const { width, height } = pg.getSize(), c = calDe.get(pg);
  if (c) return { sx: (c.kx || c.k) * MM, sy: (c.ky || c.k) * MM, ox: c.ox * MM, oy: c.oy * MM, H: height, xmax: c.xmax ? c.xmax * MM : null };
  return { sx: width / SW, sy: height / SH, ox: 0, oy: 0, H: height };
};

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const dosCifras = (a) => String(a % 100).padStart(2, '0'); // los casilleros del 03 son de dos cifras para el año
const partes = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? { a: +m[1], m: +m[2], d: +m[3] } : null; };

/**
 * Datos fijos de la Mutual como acreedora (los dio la persona el 24/11/2026). Son institucionales, no de una persona: el
 * CUIT ya está en los modelos de este repositorio. Piso y departamento van con guion: «no tiene».
 */
export const MUTUAL = {
  nombre: 'ASOCIACION MUTUAL BELL', nombre2: 'A. ECONOMICA', inscripcion: '30-62154758-1', cuit: '30-62154758-1',
  personeria: 'INAES', datosInscripcion: 'N° 447', fechaInscripcion: '1987-11-25',
  calle: 'BV. COLON', numero: '135', piso: '-', dep: '-', cp: '2550', localidad: 'BELL VILLE', partido: 'UNION', provincia: 'CORDOBA', domicilio: '',
};

/** Un dato vacío. Las secciones que la solicitud no trae se completan en la pantalla antes de generar. */
export const nuevosDatos = () => ({
  fecha: '', lugar: '',
  monto: 0, cuotas: 0, cuota: 0, tna: 0,
  clase: '', pagares: '', concepto: '', modalidad: 'prestamo', grado: '1', clausula: 'no',
  vencimientos: '', lugarPago: '', inspeccion: '',
  acreedor: { ...MUTUAL },
  deudor: { nombre: '', dni: '', autoridad: '', nacionalidad: '', nacimiento: '', estadoCivil: '', profesion: '', calle: '', numero: '', piso: '', dep: '', cp: '', localidad: '', partido: '', provincia: '', domicilio: '' },
  conyuge: { nombre: '', estadoCivil: '', profesion: '', nacionalidad: '', edad: '', domicilio: '', dni: '' },
  vehiculo: { dominio: '', marca: '', tipo: '', modelo: '', anio: '', marcaMotor: '', motor: '', marcaChasis: '', chasis: '', descripcion: '' },
  ubicacion: { provincia: '', departamento: '', cuartel: '', ciudad: '', calle: '', numero: '' },
  gravamenes: '',
  seguro: { suma: '', contra: '', compania: '', calle: '', numero: '', poliza: '', venceDia: '', venceMes: '', poder: '' },
  punitorioAnual: '', punitorioMensual: '', basePct: '', jurisdiccion: 'Bell Ville', domicilioLegal: { calle: '', numero: '', ciudad: '' },
  autorizado: { nombre: '', tipoDoc: '', numero: '' },
  registroSeccional: '',
});

// ---------------------------------------------------------------------------------------------------------------
// Posiciones. Cada campo: { x, y, w, tam } con x y la BASE del renglón en píxeles del escaneo, w el ancho disponible
// (si el texto no entra, se achica la letra hasta 6 pt). `marca`: centro de un casillero donde va una X.
// ---------------------------------------------------------------------------------------------------------------

// Formulario 03, hoja 1. Columna del acreedor (izquierda) y del deudor (derecha, a +404 px).
const COL = { A: 317, D: 721 };
const F03 = {
  dia: { x: 360, y: 253, w: 24, tam: 8 }, mes: { x: 410, y: 253, w: 24, tam: 8 }, anio: { x: 444, y: 253, w: 24, tam: 8 }, // fecha: 5 mm a la derecha (pedido del 24/11/2026)
  monto: { x: 322, y: 288, w: 185 }, dominio: { x: 548, y: 288, w: 228 },
  inscripcion: { x: 460, y: 379, w: 230 },
  nombre: [{ y: 421 }, { y: 462 }, { y: 491 }],
  calle: { y: 541, w: 372 },
  numero: { dx: 2, y: 582, w: 100 }, piso: { dx: 118, y: 582, w: 62 }, dep: { dx: 198, y: 582, w: 64 }, cp: { dx: 276, y: 582, w: 100 },
  localidad: { y: 621, w: 372 },
  partido: { y: 663, w: 222 }, provincia: { dx: 240, y: 663, w: 132 },
  // personas físicas (deudor)
  docNro: { x: 725, y: 797, w: 130 }, autoridad: { x: 872, y: 797, w: 222 },
  nac: { dia: { x: 724, y: 887, w: 26 }, mes: { x: 768, y: 887, w: 26 }, anio: { x: 808, y: 887, w: 36 } },
  conyuge: { x: 725, y: 926, w: 370 },
  // entes jurídicos (acreedor)
  personeria: { x: 322, y: 977, w: 370 }, datosInsc: { x: 322, y: 1051, w: 222 },
  finsc: { dia: { x: 553, y: 1051, w: 30 }, mes: { x: 598, y: 1051, w: 30 }, anio: { x: 664, y: 1051, w: 34 } }, // 5 mm a la izquierda (pedido del 24/11/2026)
  // G: automotor
  g: {
    dominio: { x: 512, y: 1264, w: 180 }, marca: { x: 382, y: 1301, w: 310 }, tipo: { x: 358, y: 1338, w: 334 },
    modelo: { x: 388, y: 1375, w: 304 }, marcaMotor: { x: 428, y: 1412, w: 264 }, motor: { x: 420, y: 1449, w: 272 },
    marcaChasis: { x: 452, y: 1486, w: 240 }, chasis: { x: 418, y: 1523, w: 274 },
  },
};
// Cajitas de la hoja 1: documento (1 DNI, 2 LE, 3 LC argentinos; 4 DNI, 5 CI, 6 pasaporte extranjeros), estado civil, concepto.
const CAJA_DOC = { 1: [750, 748], 2: [807, 748], 3: [863, 748], 4: [953, 748], 5: [1010, 748], 6: [1064, 748] };
const CAJA_EC = { soltero: [868, 877], casado: [923, 877], viudo: [980, 877], divorciado: [1036, 877] };
const CAJA_CONCEPTO = { saldo: [985, 1490], prestamo: [1045, 1490] };
const CAJA_CLAUSULA = { si: [985, 1425], no: [1045, 1425] };
const CAJA_GRADO = { x: 783, y: 1450, w: 18 };

// Contrato A (modelo «Ministerio de Educación y Justicia»), hoja 1 y 2. Las `y` son la línea de base de cada renglón
// impreso (donde están los puntitos), medida con OCR sobre el escaneo.
const CA = {
  lugar: { x: 794, y: 322, w: 232 }, lugar2: { x: 1066, y: 322, w: 160 },
  suma: { x: 690, y: 404, w: 420 }, sumaLetras: { x: 228, y: 440, w: 452, tam: 8 },
  senor: { x: 812, y: 439, w: 310 }, senor2: { x: 224, y: 464, w: 750 },
  concepto: { x: 310, y: 487, w: 810 }, acreedor: { x: 266, y: 510, w: 510 },
  bienes: [{ x: 282, y: 556, w: 840 }, { x: 224, y: 580, w: 898 }, { x: 224, y: 604, w: 898 }, { x: 224, y: 628, w: 898 }, { x: 224, y: 652, w: 898 }, { x: 224, y: 676, w: 898 }],
  provincia: { x: 500, y: 718, w: 395 }, depto: { x: 902, y: 718, w: 62 },
  cuartel: { x: 868, y: 740, w: 254 }, campo: { x: 545, y: 762, w: 575 },
  ciudad: { x: 338, y: 783, w: 335 }, calle: { x: 714, y: 783, w: 270 }, nro: { x: 1010, y: 783, w: 110 },
  gravamenes: [{ x: 916, y: 805, w: 205 }, { x: 224, y: 828, w: 898 }],
  documentada: { x: 678, y: 847, w: 444 }, vencim: [{ x: 724, y: 890, w: 398 }, { x: 224, y: 913, w: 898 }, { x: 224, y: 936, w: 898 }],
  interes: { x: 545, y: 953, w: 215 }, lugarPago: { x: 348, y: 975, w: 238 }, inspeccion: { x: 916, y: 975, w: 206 },
  segSuma: { x: 797, y: 996, w: 325 }, segContra: { x: 522, y: 1016, w: 258 }, segCompania: { x: 886, y: 1016, w: 236 },
  segCalle: { x: 368, y: 1039, w: 280 }, segNro: { x: 672, y: 1039, w: 95 }, segPoliza: { x: 992, y: 1039, w: 130 },
  segVence: { x: 376, y: 1062, w: 270 }, segVenceMes: { x: 672, y: 1062, w: 95 }, segPoder: { x: 925, y: 1062, w: 197 },
  acr: { insc: { x: 410, y: 1083, w: 240 }, nombre: { x: 348, y: 1106, w: 302 }, ec: { x: 304, y: 1129, w: 135 }, prof: { x: 506, y: 1129, w: 144 }, nac: { x: 308, y: 1152, w: 195 }, edad: { x: 546, y: 1152, w: 75 }, dom: { x: 284, y: 1176, w: 366 }, doc: { x: 342, y: 1198, w: 308 } },
  deu: { nombre: { x: 822, y: 1106, w: 306 }, ec: { x: 780, y: 1129, w: 130 }, prof: { x: 980, y: 1129, w: 148 }, nac: { x: 784, y: 1152, w: 185 }, edad: { x: 1018, y: 1152, w: 75 }, dom: { x: 760, y: 1176, w: 368 }, doc: { x: 818, y: 1198, w: 310 } },
  // rayas sobre «CON»/«SIN» y «FIJA»/«FLOTANTE»: se tacha lo que no corresponde
  tachaPagares: { con: [516, 366, 550, 366], sin: [561, 366, 588, 366] }, // 2 mm más abajo: justo en el medio de la palabra (24/11/2026)
  tachaClase: { fija: [953, 266, 987, 266], flotante: [1000, 266, 1074, 266] },
  p2: { punit: { x: 658, y: 266, w: 40 }, juris: { x: 782, y: 395, w: 178 }, domLegal: { x: 290, y: 433, w: 640 } },
};

// Contrato B (copia no negociable): desde que el Registro entrega la copia en la misma edición que el original, el frente tiene
// exactamente el mismo diseño (medido el 24/11/2026: los renglones coinciden salvo ~1 mm), así que usa las posiciones del frente de A.
// El dorso es propio.
const CB = {
  ...CA,
  p2: {
    punit: { x: 378, y: 166, w: 60 }, base: { x: 934, y: 184, w: 38 },
    domCalle: { x: 280, y: 236, w: 445 }, domNro: { x: 752, y: 235, w: 236 }, domCiudad: { x: 138, y: 258, w: 315 },
    cony: { nombre: { x: 280, y: 379, w: 700 }, ec: { x: 225, y: 401, w: 118 }, prof: { x: 420, y: 399, w: 400 }, nac: { x: 236, y: 424, w: 155 }, edad: { x: 436, y: 421, w: 70 }, dom: { x: 202, y: 446, w: 770 }, doc: { x: 316, y: 468, w: 650 } },
  },
};


// Leyenda de sumisión a los tribunales (texto del estudio), para el espacio libre del contrato B.
const LEYENDA_JURISDICCION = (ciudad) => `A todos los efectos del presente contrato y en especial a los fines de la ejecución de la prenda, las partes se someten voluntariamente a la jurisdicción de los Tribunales Ordinarios de la ciudad de ${ciudad || '[ciudad]'}, renunciando expresamente a cualquier otro que les pudiere corresponder, inclusive el Federal. DISTINTO TIPO DE TINTA Y LETRA "VALE".`;

// Formulario 03, hoja 2.

// ---------------------------------------------------------------------------------------------------------------

const edadDe = (nac, hoy) => {
  const n = partes(nac), h = partes(hoy);
  if (!n || !h) return '';
  return String(h.a - n.a - (h.m < n.m || (h.m === n.m && h.d < n.d) ? 1 : 0));
};
const fechaLarga = (iso) => { const p = partes(iso); return p ? `${p.d} de ${MESES[p.m - 1]} de ${p.a}` : ''; };
const num = (n) => (n === '' || n == null ? '' : String(n));
const pct = (n) => (n === '' || n == null ? '' : `${String(n).replace('.', ',')}`);

/** Lo que falta para que los formularios salgan completos, por su nombre. No bloquea: lo que falta queda en blanco. */
export function faltanFormularios(p, { soloF03 = false } = {}) {
  const f = [];
  const pide = (ok, nombre) => { if (!ok) f.push(nombre); };
  pide(p.fecha, 'Fecha'); pide(p.lugar, 'Lugar');
  pide(p.monto > 0, 'Monto del crédito'); pide(p.modalidad, 'Préstamo o saldo de precio');
  if (!soloF03) {
    pide(p.cuotas > 0, 'Cantidad de cuotas'); pide(p.cuota > 0, 'Valor de la cuota'); pide(p.tna > 0, 'Interés anual (TNA)');
    pide(p.clase, 'Prenda fija o flotante'); pide(p.pagares, 'Con o sin pagarés'); pide(p.concepto, 'Concepto de la deuda');
    pide(p.vencimientos, 'Vencimientos'); pide(p.lugarPago, 'Lugar de pago');
  }
  const a = p.acreedor; pide(a.nombre, 'Acreedor: nombre'); pide(a.inscripcion, 'Acreedor: N° de inscripción'); pide(a.personeria, 'Acreedor: personería otorgada por'); pide(a.datosInscripcion, 'Acreedor: datos de inscripción'); pide(a.domicilio || a.calle, 'Acreedor: domicilio');
  const d = p.deudor; pide(d.nombre, 'Deudor: nombre'); pide(d.dni, 'Deudor: DNI'); pide(d.nacionalidad, 'Deudor: nacionalidad'); pide(d.nacimiento, 'Deudor: fecha de nacimiento'); pide(d.estadoCivil, 'Deudor: estado civil'); pide(d.domicilio || d.calle, 'Deudor: domicilio'); pide(d.localidad, 'Deudor: localidad');
  // La provincia del deudor solo se imprime en el Formulario 03; los contratos no la llevan (la de los bienes va aparte).
  if (soloF03) pide(d.provincia, 'Deudor: provincia');
  if (d.estadoCivil === 'casado') pide(p.conyuge.nombre, 'Cónyuge: nombre y apellido');
  const v = p.vehiculo; pide(v.dominio, 'Vehículo: dominio'); pide(v.marca, 'Vehículo: marca'); pide(v.tipo, 'Vehículo: tipo'); pide(v.modelo, 'Vehículo: modelo'); pide(v.motor, 'Vehículo: N° de motor'); pide(v.chasis, 'Vehículo: N° de chasis');
  // Interés punitorio, base del %, seguro y «autorizado a diligenciar» quedan en blanco a propósito (pedido de la persona,
  // 24/11/2026): se completan a mano o más adelante; por eso no se avisan como faltantes.
  if (!soloF03) pide(p.jurisdiccion, 'Tribunales ordinarios de');
  return f;
};

/** Parte «Calle 123, Ciudad» de un domicilio escrito de corrido, para los renglones de calle y localidad. */
export const domicilioPartido = (s) => partirDomicilio(s);

/**
 * Arma el PDF. `p`: ver nuevosDatos. `opciones`: { dx, dy } en mm (corrimiento de la impresora), `hoy` (ISO, para calcular
 * edades), `fondos` (solo para controlar: { f03: [jpg, jpg], a: [jpg, jpg], b: [jpg, jpg] } con el escaneo debajo de los
 * datos) y `cuales` (cuáles hojas: 'f03', 'a', 'b'; por defecto las tres).
 */
export async function armarFormularios(p, { dx = 0, dy = 0, hoy = '', fondos = null, cuales = ['f03', 'a', 'b'] } = {}) {
  const { PDFDocument, StandardFonts, rgb } = await cargarLib();
  const doc = await PDFDocument.create();
  doc.setTitle(`Prenda - ${p.deudor?.nombre || ''}`);
  doc.setProducer('Créditos y Cobros');
  const fn = await doc.embedFont(StandardFonts.Helvetica), fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const tinta = fondos ? rgb(0.05, 0.1, 0.8) : rgb(0, 0, 0);

  const seguro = (t) => { let o = ''; for (const c of String(t ?? '')) { try { fn.encodeText(c); o += c; } catch { o += '?'; } } return o; };
  const pagina = async (clave, i) => {
    const pg = nuevaPagina(doc, clave, i);
    const img = fondos?.[clave]?.[i];
    if (img) { const im = await doc.embedJpg(img); const { width, height } = pg.getSize(); pg.drawImage(im, { x: 0, y: 0, width, height }); }
    return pg;
  };
  // texto en una posición del escaneo, achicando la letra si no entra
  const T = (pg, c, texto, extra = {}) => {
    const t = seguro(texto).replace(/\s+/g, ' ').trim();
    if (!c) return;
    if (!t) return c.x;
    let tam = c.tam || 9.5;
    const { sx, sy, ox, oy, H } = escala(pg);
    const w = anchoDe(pg, c);
    while (tam > 6 && fn.widthOfTextAtSize(t, tam) > w) tam -= 0.25;
    pg.drawText(t, { x: (c.x + (extra.dx || 0)) * sx + ox + dx * MM, y: H - (c.y * sy + oy) - dy * MM, size: tam, font: fn, color: tinta });
    return c.x + (extra.dx || 0) + fn.widthOfTextAtSize(t, tam) / sx;
  };
  const X = (pg, [cx, cy]) => {
    const { sx, sy, ox, oy, H } = escala(pg), tam = 13, w = fb.widthOfTextAtSize('X', tam);
    pg.drawText('X', { x: cx * sx + ox - w / 2 + dx * MM, y: H - (cy * sy + oy) - tam * 0.35 - dy * MM, size: tam, font: fb, color: tinta });
  };
  const raya = (pg, [x1, y1, x2, y2]) => {
    if (!x2) return;
    const { sx, sy, ox, oy, H } = escala(pg);
    pg.drawLine({ start: { x: x1 * sx + ox + dx * MM, y: H - (y1 * sy + oy) - dy * MM }, end: { x: x2 * sx + ox + dx * MM, y: H - (y2 * sy + oy) - dy * MM }, thickness: 1.2, color: tinta });
  };
  // Lo que no se usa de un renglón se tacha con una raya, de donde termina el texto hasta el final del renglón (pedido del 24/11/2026)
  const tachar = (pg, c, fin) => {
    if (!c || fin == null) return;
    const { sx, sy, ox, oy, H } = escala(pg), x1 = (fin + 4) * sx + ox, x2 = c.x * sx + ox + anchoDe(pg, c);
    if (x2 - x1 < 8) return;
    const y = H - (c.y * sy + oy) - dy * MM;
    pg.drawLine({ start: { x: x1 + dx * MM, y }, end: { x: x2 + dx * MM, y }, thickness: 0.8, color: tinta });
  };
  const llena = (pg, c, texto) => tachar(pg, c, T(pg, c, texto));
  // un texto largo repartido en varios renglones (el vehículo, los vencimientos…)
  const renglones = (pg, lineas, texto) => {
    const palabras = seguro(texto).split(/\s+/).filter(Boolean);
    let k = 0, actual = '';
    for (const pal of palabras) {
      const c = lineas[k];
      const prueba = actual ? `${actual} ${pal}` : pal;
      if (!c || fn.widthOfTextAtSize(prueba, c.tam || 9.5) <= anchoDe(pg, c) || !actual) actual = prueba;
      else { T(pg, c, actual); k++; actual = pal; }
    }
    let fin = null;
    if (actual && lineas[k]) fin = T(pg, lineas[k], actual);
    return { c: lineas[k], fin };
  };

  const ac = p.acreedor || {}, de = p.deudor || {}, v = p.vehiculo || {}, ub = p.ubicacion || {}, sg = p.seguro || {}, cy = p.conyuge || {};
  const hoyISO = hoy || p.fecha;
  const fp = partes(p.fecha);
  const dom = (o) => o.domicilio || [o.calle, o.numero].filter(Boolean).join(' ');
  const dDe = de.calle || de.numero || de.localidad ? de : { ...de, ...partirDomicilio(de.domicilio) };
  const dAc = ac.calle || ac.numero || ac.localidad ? ac : { ...ac, ...partirDomicilio(ac.domicilio) };
  const docCaja = /argentin/i.test(de.nacionalidad || '') ? 1 : de.nacionalidad ? 4 : 0;
  const nac = partes(de.nacimiento), finsc = partes(ac.fechaInscripcion);
  const edad = edadDe(de.nacimiento, hoyISO);
  const descripcionBien = v.descripcion || [v.tipo, v.marca, v.modelo, v.anio && `año ${v.anio}`, v.marcaMotor && `motor ${v.marcaMotor}`, v.motor && `N° ${v.motor}`, v.marcaChasis && `chasis ${v.marcaChasis}`, v.chasis && `N° ${v.chasis}`, v.dominio && `dominio ${v.dominio}`].filter(Boolean).join(', ');
  const montoTxt = p.monto > 0 ? `$ ${cifra(p.monto)}` : '';
  const letras = p.monto > 0 ? `Pesos ${enLetras(p.monto)}` : '';
  const interes = p.tna > 0 ? pct(+(+p.tna).toFixed(2)) : '';
  const lugarDia = p.lugar && fp ? `${p.lugar}, ${fp.d}` : p.lugar || '';
  const mesAnio = fp ? `${MESES[fp.m - 1]} de ${fp.a}` : '';
  const venceSeguro = sg.venceDia ? `${sg.venceDia}` : '';

  // ---- Formulario 03 ----------------------------------------------------------------------------------------
  if (cuales.includes('f03')) {
    const pg = await pagina('f03', 0);
    if (fp) { T(pg, F03.dia, String(fp.d).padStart(2, '0')); T(pg, F03.mes, String(fp.m).padStart(2, '0')); T(pg, F03.anio, dosCifras(fp.a)); }
    T(pg, F03.monto, montoTxt); T(pg, F03.dominio, v.dominio);
    T(pg, F03.inscripcion, ac.inscripcion);
    // acreedor (ente jurídico) y deudor (persona física): mismos renglones, columnas distintas
    const bloque = (x0, o) => {
      const lin = F03.nombre.map((l) => ({ x: x0 + 5, y: l.y, w: 365 }));
      if (o.nombre2) { T(pg, lin[0], o.nombre); T(pg, lin[1], o.nombre2); } else renglones(pg, lin, o.nombre);
      T(pg, { x: x0 + 5, y: F03.calle.y, w: F03.calle.w }, o.calle);
      for (const [k, clave] of [['numero', 'numero'], ['piso', 'piso'], ['dep', 'dep'], ['cp', 'cp']]) T(pg, { x: x0 + F03[k].dx + 3, y: F03[k].y, w: F03[k].w }, o[clave]);
      T(pg, { x: x0 + 5, y: F03.localidad.y, w: F03.localidad.w }, o.localidad);
      T(pg, { x: x0 + 5, y: F03.partido.y, w: F03.partido.w }, o.partido);
      T(pg, { x: x0 + F03.provincia.dx + 4, y: F03.provincia.y, w: F03.provincia.w }, o.provincia);
    };
    bloque(COL.A, dAc); bloque(COL.D, dDe);
    // deudor: documento, nacimiento, estado civil, cónyuge
    if (docCaja) X(pg, CAJA_DOC[docCaja]);
    T(pg, F03.docNro, dniOficio(de.dni)); T(pg, F03.autoridad, de.autoridad);
    if (nac) { T(pg, F03.nac.dia, String(nac.d).padStart(2, '0')); T(pg, F03.nac.mes, String(nac.m).padStart(2, '0')); T(pg, F03.nac.anio, dosCifras(nac.a)); }
    if (CAJA_EC[de.estadoCivil]) X(pg, CAJA_EC[de.estadoCivil]);
    if (de.estadoCivil === 'casado') T(pg, F03.conyuge, cy.nombre);
    // acreedor: ente jurídico
    T(pg, F03.personeria, ac.personeria); T(pg, F03.datosInsc, ac.datosInscripcion);
    if (finsc) { T(pg, F03.finsc.dia, String(finsc.d).padStart(2, '0')); T(pg, F03.finsc.mes, String(finsc.m).padStart(2, '0')); T(pg, F03.finsc.anio, dosCifras(finsc.a)); }
    // automotor y modalidades
    for (const k of Object.keys(F03.g)) T(pg, F03.g[k], v[k]);
    if (CAJA_CONCEPTO[p.modalidad]) X(pg, CAJA_CONCEPTO[p.modalidad]);
    if (CAJA_CLAUSULA[p.clausula]) X(pg, CAJA_CLAUSULA[p.clausula]);
    T(pg, CAJA_GRADO, p.grado);
    // El dorso del 03 (Registro Seccional y autorizado a diligenciar) no se imprime: sale en blanco a propósito (pedido de la persona, 24/11/2026).
  }

  // ---- Contratos de prenda (A y B) ----------------------------------------------------------------------------
  const contrato = async (clave, C) => {
    const pg = await pagina(clave, 0);
    T(pg, C.lugar, lugarDia); T(pg, C.lugar2, mesAnio);
    if (p.pagares === 'con') raya(pg, C.tachaPagares.sin); else if (p.pagares === 'sin') raya(pg, C.tachaPagares.con);
    if (p.clase === 'fija') raya(pg, C.tachaClase.flotante); else if (p.clase === 'flotante') raya(pg, C.tachaClase.fija);
    T(pg, C.suma, montoTxt); if (C.sumaLetras) T(pg, C.sumaLetras, letras);
    T(pg, C.senor, de.nombre);
    T(pg, C.senor2, [de.dni && `DNI ${dniOficio(de.dni)}`, dom(dDe) && `con domicilio en ${dom(dDe)}`, dDe.localidad].filter(Boolean).join(', '));
    llena(pg, C.concepto, p.concepto); llena(pg, C.acreedor, ac.nombre);
    { const r = renglones(pg, C.bienes, descripcionBien); tachar(pg, r.c, r.fin); }
    T(pg, C.provincia, ub.provincia); if (C.depto?.w) T(pg, C.depto, ub.departamento);
    llena(pg, C.cuartel, ub.cuartel); T(pg, C.ciudad, ub.ciudad); T(pg, C.calle, ub.calle); T(pg, C.nro, ub.numero);
    renglones(pg, C.gravamenes, p.gravamenes);
    llena(pg, C.documentada, p.pagares === 'con' ? 'pagarés' : p.pagares === 'sin' ? 'el presente contrato' : '');
    { const r = renglones(pg, C.vencim, p.vencimientos); tachar(pg, r.c, r.fin); }
    T(pg, C.interes, interes); T(pg, C.lugarPago, p.lugarPago); llena(pg, C.inspeccion, p.inspeccion);
    llena(pg, C.segSuma, sg.suma); llena(pg, C.segContra, sg.contra); llena(pg, C.segCompania, sg.compania);
    llena(pg, C.segCalle, sg.calle); llena(pg, C.segNro, sg.numero); llena(pg, C.segPoliza, sg.poliza);
    llena(pg, C.segVence, venceSeguro); llena(pg, C.segVenceMes, sg.venceMes); llena(pg, C.segPoder, sg.poder);
    // el renglón del seguro donde sigue «la suma de», antes de «contra»: no se usa
    tachar(pg, { x: 224, y: C.segContra.y, w: 290 }, 224 - 4);
    T(pg, C.acr.insc, ac.inscripcion); T(pg, C.acr.nombre, ac.nombre); T(pg, C.acr.prof, ac.nombre2); T(pg, C.acr.dom, dom(dAc) + (dAc.localidad ? `, ${dAc.localidad}` : '')); T(pg, C.acr.doc, ac.cuit ? `CUIT ${ac.cuit}` : '');
    llena(pg, C.acr.ec, ''); llena(pg, C.acr.nac, ''); llena(pg, C.acr.edad, '');
    T(pg, C.deu.nombre, de.nombre);
    const ecTxt = de.estadoCivil ? de.estadoCivil.charAt(0).toUpperCase() + de.estadoCivil.slice(1) : '';
    T(pg, C.deu.ec, ecTxt); T(pg, C.deu.prof, de.profesion); T(pg, C.deu.nac, de.nacionalidad); T(pg, C.deu.edad, edad);
    T(pg, C.deu.dom, dom(dDe) + (dDe.localidad ? `, ${dDe.localidad}` : '')); T(pg, C.deu.doc, de.dni ? `DNI ${dniOficio(de.dni)}` : '');
    return pagina(clave, 1);
  };
  if (cuales.includes('a')) {
    const pg2 = await contrato('a', CA);
    T(pg2, CA.p2.punit, pct(p.punitorioAnual)); T(pg2, CA.p2.juris, p.jurisdiccion);
    T(pg2, CA.p2.domLegal, [p.domicilioLegal?.calle, p.domicilioLegal?.numero, p.domicilioLegal?.ciudad].filter(Boolean).join(' '));
  }
  if (cuales.includes('b')) {
    const pg2 = await contrato('b', CB);
    const q = CB.p2;
    T(pg2, q.punit, pct(p.punitorioMensual)); T(pg2, q.base, num(p.basePct));
    T(pg2, q.domCalle, p.domicilioLegal?.calle); T(pg2, q.domNro, p.domicilioLegal?.numero); T(pg2, q.domCiudad, p.domicilioLegal?.ciudad);
    // salvedad que el estudio agrega en el espacio en blanco que queda después de los datos del cónyuge
    renglones(pg2, [0, 1, 2, 3].map((k) => ({ x: 128, y: 520 + k * 27, w: 880 })), LEYENDA_JURISDICCION(p.jurisdiccion));
    if (de.estadoCivil === 'casado') {
      T(pg2, q.cony.nombre, cy.nombre); T(pg2, q.cony.ec, cy.estadoCivil); T(pg2, q.cony.prof, cy.profesion); T(pg2, q.cony.nac, cy.nacionalidad); T(pg2, q.cony.edad, cy.edad);
      T(pg2, q.cony.dom, cy.domicilio); T(pg2, q.cony.doc, cy.dni === '-' ? '-' : cy.dni ? `DNI ${dniOficio(cy.dni)}` : '');
    }
  }
  return { bytes: await doc.save(), faltan: faltanFormularios(p) };
}

/**
 * Hoja de prueba: una cruz a 12 mm de cada borde del papel y otra en el centro, más una regla de 100 mm (horizontal) y otra de
 * 200 mm (vertical) con marcas cada 10 mm. Va en el tamaño real de cada formulario y no depende de ningún escaneo: se imprime
 * sobre el papel oficial en blanco (o sobre una hoja común) y se mide con una regla desde los bordes. Si las cruces están a
 * 12 mm de los bordes y las reglas miden 100 y 200 mm, la impresora no corre nada; si no, la diferencia en milímetros es lo
 * que se carga en «Ajuste de impresión» (o la foto de la hoja con una regla al lado alcanza para calcularlo).
 */
export async function hojaDePrueba({ dx = 0, dy = 0 } = {}) {
  const { PDFDocument, StandardFonts, rgb } = await cargarLib();
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const nombres = { f03: 'Formulario 03', a: 'Contrato de prenda (original)', b: 'Contrato de prenda (copia no negociable)' };
  const negro = rgb(0, 0, 0);
  for (const clave of Object.keys(HOJAS)) { // una hoja de cada tamaño, para probar con cada formulario oficial
    const [w, h] = HOJAS[clave], pg = doc.addPage(tam(clave)), H = h * MM;
    const P = (x, y) => ({ x: x * MM + dx * MM, y: H - y * MM - dy * MM }); // mm desde arriba a la izquierda → puntos
    const linea = (x1, y1, x2, y2, t = 0.6) => pg.drawLine({ start: P(x1, y1), end: P(x2, y2), thickness: t, color: negro });
    for (const [cx, cy] of [[12, 12], [w - 12, 12], [12, h - 12], [w - 12, h - 12], [w / 2, h / 2]]) { linea(cx - 4, cy, cx + 4, cy); linea(cx, cy - 4, cx, cy + 4); }
    linea(30, 30, 130, 30); for (let m = 0; m <= 100; m += 10) linea(30 + m, 30, 30 + m, m % 50 === 0 ? 24 : 27);
    linea(30, 30, 30, 230); for (let m = 0; m <= 200; m += 10) linea(30, 30 + m, m % 50 === 0 ? 24 : 27, 30 + m);
    const texto = (t, x, y, size = 8) => { const q = P(x, y); pg.drawText(t, { x: q.x, y: q.y, size, font: f, color: negro }); };
    texto(`Hoja de prueba: ${nombres[clave]} (${w / 10} x ${h / 10} cm). Imprimir al 100 % (sin "ajustar a la página").`, 40, 40);
    texto('Las cruces de las esquinas están a 12 mm de los bordes del papel. La regla de arriba mide 100 mm y la de la izquierda 200 mm.', 40, 49);
    texto('Medí desde el borde del papel hasta cada cruz y la regla: la diferencia, en mm, es lo que se carga en el ajuste.', 40, 58);
  }
  return doc.save();
}

export { fechaLarga };

/**
 * Los datos de una solicitud aprobada, listos para la pantalla de revisión: lo que la agencia ya cargó (cliente, crédito,
 * domicilio, estado civil) más los datos fijos de la Mutual. Lo que la solicitud no trae (dominio, motor, chasis, fecha
 * de nacimiento…) queda vacío para completarlo a mano o con el título del automotor. No se inventa nada.
 */
export function datosDeSolicitud(x, hoy = '') {
  const p = nuevosDatos(), d = x.datos || {}, dom = partirDomicilio(d.domicilio), v = partirVehiculo(x.vehiculo);
  Object.assign(p, { fecha: hoy, lugar: 'Bell Ville', monto: Number(x.monto) || 0, cuotas: Number(x.cuotas) || 0, cuota: Number(x.cuota) || 0, tna: '', primerVto: '' }); // la TNA queda en blanco a propósito (pedido de la persona, 24/11/2026): se escribe a mano
  Object.assign(p.deudor, {
    nombre: String(x.denominacion || '').trim(), dni: String(d.dni || ''), estadoCivil: d.estado_civil === 'casado' ? 'casado' : d.estado_civil === 'soltero' ? 'soltero' : '',
    profesion: String(d.actividad || ''), calle: dom.calle, numero: dom.numero, localidad: dom.localidad,
  });
  // Desde el 24/11/2026 la agencia carga el domicilio por casilleros, la nacionalidad y el nacimiento: se usan tal cual.
  // Las solicitudes anteriores traen solo el domicilio de corrido (arriba) y lo demás queda para completar.
  if (d.dom_calle !== undefined) {
    Object.assign(p.deudor, { calle: String(d.dom_calle), numero: String(d.dom_numero || ''), piso: String(d.dom_piso || ''), dep: String(d.dom_depto || ''), cp: String(d.dom_cp || ''),
      localidad: String(d.dom_localidad || ''), partido: String(d.dom_departamento || ''), provincia: String(d.dom_provincia || '') });
  }
  if (d.nacionalidad) p.deudor.nacionalidad = String(d.nacionalidad);
  if (d.nacimiento) p.deudor.nacimiento = String(d.nacimiento);
  // Cónyuge: lo que la agencia cargó en la solicitud (solo si el cliente es casado/a). La profesión no se pide: queda para completar.
  if (d.estado_civil === 'casado' && d.conyuge_nombre) {
    const edad = edadDe(d.conyuge_nacimiento, hoy);
    Object.assign(p.conyuge, { nombre: String(d.conyuge_nombre), dni: String(d.conyuge_dni || ''), nacionalidad: String(d.conyuge_nacionalidad || ''), domicilio: String(d.conyuge_domicilio || ''), estadoCivil: 'casado', edad: edad ? String(edad) : '' });
  }
  Object.assign(p.vehiculo, { marca: v.marca, modelo: v.modelo || String(x.vehiculo || ''), anio: x.anio && /^\d{4}$/.test(String(x.anio)) ? String(x.anio) : '', dominio: v.dominio, motor: v.motor, chasis: v.chasis });
  Object.assign(p, DEFECTOS_CONTRATO, { primerVto: sumarDias(hoy, DIAS_PRIMERA_CUOTA) });
  return p;
}

/**
 * Lo que es igual en casi todos los créditos (pedido de la persona, 24/11/2026): sale ya cargado y la pantalla lo
 * muestra plegado. Interés punitorio y base del % van con guion: «no corresponde».
 */
export const DIAS_PRIMERA_CUOTA = 37;
export const DEFECTOS_CONTRATO = {
  clase: 'fija', pagares: 'sin', concepto: 'Préstamo de dinero', lugarPago: 'Bv. Colón 135 Bell Ville', inspeccion: 'Amplios',
  gravamenes: 'Ninguno de ninguna índole', punitorioAnual: '-', punitorioMensual: '-', basePct: '-',
  // Seguro: todo con guion (pedido de la persona, 24/11/2026); se completa a mano si algún día se contrata.
  seguro: { suma: '-', contra: '-', compania: '-', calle: '-', numero: '-', poliza: '-', venceDia: '-', venceMes: '-', poder: '-' },
};

/** «2026-11-24» + n días, en ISO (vacío si la fecha no es válida). */
export function sumarDias(iso, n) {
  const f = partes(iso); if (!f) return '';
  const d = new Date(Date.UTC(f.a, f.m - 1, f.d + n));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * «Dónde están los bienes» y el domicilio constituido salen del domicilio del deudor cuando están vacíos (en el deudor,
 * ciudad y localidad son lo mismo). Devuelve una copia: lo escrito a mano manda.
 */
export function conDomicilioDelDeudor(p) {
  const q = JSON.parse(JSON.stringify(p)), d = q.deudor || {};
  const dd = d.calle || d.numero || d.localidad ? d : { ...d, ...partirDomicilio(d.domicilio) };
  q.ubicacion = q.ubicacion || {}; q.domicilioLegal = q.domicilioLegal || {};
  const u = q.ubicacion, l = q.domicilioLegal;
  u.provincia = u.provincia || d.provincia || 'Córdoba'; u.departamento = u.departamento || d.partido || '';
  u.ciudad = u.ciudad || dd.localidad || ''; u.calle = u.calle || dd.calle || ''; u.numero = u.numero || dd.numero || '';
  l.calle = l.calle || dd.calle || ''; l.numero = l.numero || dd.numero || ''; l.ciudad = l.ciudad || dd.localidad || '';
  // Cónyuge: sin cónyuge todo va con guion; si el deudor es casado/a, queda lo que se escriba (y se avisa si falta).
  if (d.estadoCivil !== 'casado') {
    q.conyuge = q.conyuge || {};
    for (const k of ['nombre', 'estadoCivil', 'profesion', 'nacionalidad', 'edad', 'domicilio', 'dni']) q.conyuge[k] = q.conyuge[k] || '-';
  }
  return q;
}

/** «24 cuotas mensuales y consecutivas de $ 301.500,50 cada una, venciendo la primera el 24/12/2026» (vacío si falta algo). */
export function textoVencimientos(p) {
  const f = partes(p.primerVto);
  if (!(p.cuotas > 0) || !(p.cuota > 0) || !f) return '';
  const imp = Number(p.cuota).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${p.cuotas} cuotas mensuales y consecutivas de $ ${imp} cada una, venciendo la primera el ${String(f.d).padStart(2, '0')}/${String(f.m).padStart(2, '0')}/${f.a}`;
}

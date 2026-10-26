// Acciones cautelares: los modelos de oficio y de escrito, el oficio completado con los datos de
// la causa, su vista previa y su PDF. No toca la pantalla ni la red: lo usan la ficha (app.js),
// la tarea que presenta en el SAC (dev/oficio-pdf.mjs, que arma el mismo PDF) y las pruebas.
//
// Un modelo de oficio es una plantilla de la biblioteca (id "oficio-…") escrita con estas marcas:
//   - El primer bloque, hasta la primera línea en blanco, es el encabezado: un renglón por línea.
//   - Después, cada bloque separado por una línea en blanco es un párrafo del cuerpo.
//     ">" al empezar: con sangría en la primera línea. ">>": la despedida (más corrida).
//   - **texto**: en negrita.
//   - {{campo}}: se completa con los datos de la causa y del formulario (ver CAMPOS_OFICIO).
//   - [[ … ]] (dentro de un mismo renglón): va solo si todos los campos de adentro tienen dato. Si
//     no, no se escribe nada de lo que está entre corchetes, y un renglón que era solo eso desaparece.
// El oficio completado guarda las mismas marcas: lo que se ve, lo que se adjunta en el SAC y lo
// que la tarea vuelve a armar salen del mismo texto.

// ───────────────────────── Modelos ─────────────────────────

/** Textos de las cuatro plantillas de las acciones cautelares (los mismos que carga la migración 0013). */
export const MODELOS = {
  'oficio-embargo-haberes': {
    titulo: 'Oficio de embargo de haberes',
    cuerpo: `{{ciudad}},     de               de {{anio}}
Sr. Titular Empresa {{empleador}}
[[CUIT {{cuit_empleador}}]]
[[{{domicilio_empleador}}]]
S _________ /____________D

>Se hace saber a Ud. que en los autos caratulados **“{{autos}} - {{tipo_oficio}} (Expte. Nº {{expediente}})”**, que tramitan por ante el Juzgado de 1era Instancia y **{{nom_ordinal}}** Nominación en lo Civil y Comercial de esta ciudad, Secretaría a cargo del autorizante Oficina de Ejecuciones Particulares, se ha resuelto librar a Ud. el presente oficio a fin de que una vez recibido y previa formalidades de ley, proceda **A TRABAR EMBARGO** sobre los haberes que percibe **{{persona}} DNI {{dni}}** hasta cubrir la suma de pesos **{{monto_letras}} ($ {{monto}})**. La medida deberá hacerse efectiva tanto sobre los haberes ordinario cuanto sobre las remuneraciones extraordinarias que perciba o a percibir por el demandado, en proporción de ley, ello es, sobre el diez por ciento (10%) sobre lo que exceda del salario mínimo vital y móvil y en tanto no supere el doble de aquél, y en un veinte por ciento (20%) en caso contrario (arts. 147 L.C.T. y Dec. 484/87).

Que los importes que por tal concepto sean retenidos deberán ser depositados a la orden de este Juzgado y para estos autos en cuenta judicial nº {{cuenta_judicial}} CBU {{cbu}} Banco de Córdoba en el plazo de 2 días; de liquidados los haberes, bajo apercibimiento de ley.

Se deja constancia que el Dr. SOLER CARLOS EMILIANO MP 3-35383, y/o quien este designe se encuentra facultado para diligenciar el presente.

Sírvase devolverlo directamente al tribunal con todo lo actuado.

>>Saluda a Ud. atentamente`,
  },
  'oficio-secuestro-automotor': {
    titulo: 'Oficio de secuestro automotor',
    cuerpo: `{{ciudad}},     de               de {{anio}}
Sr. Oficial de Justicia
[[{{sede_oficial}}]]
S____________/_____________D

>Se hace saber a Ud. que en los autos **{{autos}} – {{tipo_oficio}} (Expte. Nº {{expediente}}”**, que tramitan por ante el Juzgado de 1º Instancia y **{{nom}}**° Nominación en lo Civil y Comercial de esta ciudad, Secretaría a cargo del autorizante, Oficina de Ejecuciones Particulares se ha resuelto librar a Ud. el presente oficio a fin de que una vez recibido y previas formalidades de ley, se constituya en el domicilio de la demandado sito en calle {{calle}} Nro. {{numero}} de la ciudad de {{localidad}}, Provincia de Córdoba, y/o vía pública y proceda a **SECUESTRAR** el automotor marca {{marca}} dominio {{dominio}} modelo {{modelo}}[[, año {{anio_vehiculo}}]], motor {{motor}}, chasis {{chasis}} de propiedad del demandado **{{persona}} DNI {{dni}}**[[ pudiendo el ejecutado enervar el secuestro abonando la suma de Pesos **{{monto_letras}} (\${{monto}}) con más intereses y costas**]]**.**

>El martillero Sr. FRANCO DANIELE y/o quien se designe, se encuentra autorizado a correr con el diligenciamiento del presente. Efectuada la medida, deberá poner en posesión del bien secuestrado del Martillero quien deberá aceptar el cargo de depositario judicial en este acto.

>Se lo autoriza a allanar domicilio y hacer uso de la fuerza pública en caso de ser necesario, y se lo faculta de lunes a sábado de 8.00 hs. a 22.00hs. (art. 44 C.P.C.C.). Se abstendrá de realizar la medida para el caso de encontrarse el bien en cuestión retenido por autoridad pública en dependencia oficial.

>Diligenciado que sea el presente, sírvase devolverlo a este Juzgado con todo lo actuado.

>>SALUDO A UD. ATTE.-`,
  },
  'solicita-embargo-haberes': {
    titulo: 'Solicita embargo de haberes',
    cuerpo: `Que vengo a solicitar se trabe embargo sobre los haberes que percibe el demandado {{persona}} DNI {{dni}} como dependiente de {{empleador}}, hasta cubrir la suma de pesos {{monto_letras}} ($ {{monto}}), en la proporción de ley.

Que a tales fines acompaño oficio dirigido al empleador y solicito se libre el mismo.

Por todo ello,
- Ordene el embargo de haberes solicitado.
- Libre oficio de embargo.

ES DE LEY`,
  },
  'solicita-secuestro-automotor': {
    titulo: 'Solicita secuestro de vehículo automotor',
    cuerpo: `Que vengo a solicitar se ordene el secuestro del automotor marca {{marca}} modelo {{modelo}} dominio {{dominio}}, de propiedad del demandado {{persona}} DNI {{dni}}.

Que acompaño oficio de secuestro automotor y solicito se libre el mismo.

Por todo ello,
- Ordene el secuestro del automotor.
- Libre oficio de secuestro.

ES DE LEY`,
  },
};

/** Las dos acciones cautelares: qué oficio y qué escrito usa cada una, y cómo se llama el adjunto. */
export const ACCIONES = {
  embargo: {
    nombre: 'Embargo de haberes', pregunta: '¿Solicitar embargo de haberes?', titulo: 'Solicitar embargo de haberes',
    oficio: 'oficio-embargo-haberes', escrito: 'solicita-embargo-haberes', archivo: 'Oficio embargo de haberes',
  },
  secuestro: {
    nombre: 'Secuestro automotor', pregunta: '¿Solicitar oficio de secuestro automotor?', titulo: 'Solicitar secuestro de vehículo automotor',
    oficio: 'oficio-secuestro-automotor', escrito: 'solicita-secuestro-automotor', archivo: 'Oficio secuestro automotor',
  },
};

/** Los campos que se pueden usar en los modelos, con lo que significa cada uno. */
export const CAMPOS_OFICIO = {
  ciudad: 'ciudad de la fecha (Bell Ville)', anio: 'año de la fecha', autos: 'actor c/ demandado, como en el oficio',
  tipo_oficio: 'tipo de juicio (EJECUTIVO…)', expediente: 'N° de expediente', nom: 'nominación (1, 2, 3)', nom_ordinal: 'nominación (1ra, 2da…)',
  persona: 'demandado al que se le pide la medida', dni: 'su DNI', monto: 'monto en números', monto_letras: 'monto en letras',
  empleador: 'empleador', cuit_empleador: 'CUIT del empleador', domicilio_empleador: 'domicilio del empleador',
  cuenta_judicial: 'N° de cuenta judicial', cbu: 'CBU de la cuenta judicial',
  sede_oficial: 'sede del oficial de justicia', calle: 'calle del domicilio', numero: 'número', localidad: 'ciudad del domicilio',
  marca: 'marca', modelo: 'modelo', anio_vehiculo: 'año del vehículo', dominio: 'dominio', motor: 'N° de motor', chasis: 'N° de chasis',
};

/** Las plantillas de la biblioteca que son modelos de oficio (no escritos). */
export const esModeloOficio = (id) => /^oficio-/.test(String(id || ''));

// ───────────────────────── Completar un modelo ─────────────────────────

const FALTA_A = '\u0001', FALTA_B = '\u0002'; // marcan, en la vista previa, un campo sin dato
/** Un dato no puede traer marcas: no rompe la negrita ni los corchetes. */
const limpio = (v) => String(v ?? '').replace(/\*\*|\[\[|\]\]|\{\{|\}\}|[\u0001\u0002]/g, '').replace(/[\r\n\t]+/g, ' ').trim();

/**
 * Completa un modelo con los datos. Devuelve { texto, faltan }: `faltan` son los campos sin dato
 * que el modelo usa fuera de los corchetes. Con `marcar`, cada uno queda señalado en el texto
 * (para la vista previa); sin `marcar`, queda vacío.
 */
export function rellenar(modelo, datos, { marcar = false } = {}) {
  const faltan = new Set();
  const valor = (k) => limpio(datos[k]);
  // Primero lo opcional: si a un campo de adentro le falta el dato, no va nada de lo que hay entre
  // corchetes. Un renglón que era solo eso se quita entero: si quedara vacío, partiría el bloque
  // (en el encabezado, lo que sigue pasaría a ser un párrafo del cuerpo).
  const lineas = [];
  for (const linea of String(modelo || '').replace(/\r\n?/g, '\n').split('\n')) {
    let quitado = false;
    const l = linea.replace(/\[\[(.*?)\]\]/g, (_, dentro) => {
      const campos = [...dentro.matchAll(/\{\{\s*([a-z_0-9]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase());
      if (campos.length && campos.every((k) => valor(k))) return dentro;
      quitado = true;
      return '';
    });
    if (!(quitado && !l.trim())) lineas.push(l);
  }
  const t = lineas.join('\n').replace(/\{\{\s*([a-z_0-9]+)\s*\}\}/gi, (x, k) => {
    k = k.toLowerCase();
    const v = valor(k);
    if (v) return v;
    faltan.add(k);
    return marcar ? FALTA_A + (CAMPOS_OFICIO[k] || k) + FALTA_B : '';
  });
  return { texto: t, faltan: [...faltan] };
}

// ───────────────────────── Leer el texto con marcas ─────────────────────────

/** "a **b** c" → [{t:'a ', b:false}, {t:'b', b:true}, {t:' c', b:false}] (las marcas sueltas se ignoran). */
function tramos(s) {
  const r = [];
  s.split('**').forEach((t, i) => { if (t) r.push({ t, b: i % 2 === 1 }); });
  return r;
}

/**
 * El oficio en partes: { encabezado: [tramos por renglón], parrafos: [{ tipo, tramos }] }.
 * tipo: 'sangria' (">"), 'cierre' (">>") o 'llano'.
 */
export function analizar(texto) {
  const bloques = String(texto || '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  const enc = (bloques.shift() || '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const parrafos = [];
  for (const b of bloques) {
    let s = b.trim();
    if (!s) continue;
    let tipo = 'llano';
    if (s.startsWith('>>')) { tipo = 'cierre'; s = s.slice(2); } else if (s.startsWith('>')) { tipo = 'sangria'; s = s.slice(1); }
    s = s.replace(/\s+/g, ' ').trim();
    if (s) parrafos.push({ tipo, tramos: tramos(s) });
  }
  // En el encabezado no hay negritas: se escribe en una sola letra, como en el modelo de Word.
  return { encabezado: enc.map((l) => [{ t: l.replace(/\*\*/g, ''), b: false }]), parrafos };
}

// ───────────────────────── Vista previa ─────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function tramosHtml(ts) {
  return ts.map(({ t, b }) => {
    const h = esc(t).replace(/\u0001([^\u0002]*)\u0002/g, '<span class="of-falta">$1</span>');
    return b ? `<b>${h}</b>` : h;
  }).join('');
}
/** La hoja del oficio en HTML (todo escapado), para ver cómo queda antes de confirmarlo. */
export function htmlOficio(texto) {
  const d = analizar(texto);
  return `<div class="of-hoja"><div class="of-enc">${d.encabezado.map((l) => `<p>${tramosHtml(l)}</p>`).join('')}</div>` +
    d.parrafos.map((p) => `<p class="of-p ${p.tipo}">${tramosHtml(p.tramos)}</p>`).join('') + '</div>';
}

// ───────────────────────── Importes y datos ─────────────────────────

const UNI = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce',
  'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro',
  'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DEC = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CEN = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
/** 1 a 999 en palabras. Con `corto`, "uno" queda "un" (delante de mil y de millones: "veintiún mil"). */
function cientos(n, corto) {
  if (!n) return '';
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100), r = n % 100;
  let s = CEN[c];
  if (r) {
    let t = r < 30 ? UNI[r] : DEC[Math.floor(r / 10)] + (r % 10 ? ' y ' + UNI[r % 10] : '');
    if (corto) t = t.endsWith('veintiuno') ? t.slice(0, -9) + 'veintiún' : t.endsWith('uno') ? t.slice(0, -3) + 'un' : t;
    s += (s ? ' ' : '') + t;
  }
  return s;
}
/**
 * El importe en letras, como en los oficios: "Un Millón Setecientos Noventa Mil". Los centavos,
 * si hay, van "con 50/100".
 */
export function enLetras(monto) {
  const total = Math.round(Math.abs(+monto || 0) * 100), enteros = Math.floor(total / 100), cent = total % 100;
  const mill = Math.floor(enteros / 1e6), miles = Math.floor((enteros % 1e6) / 1000), resto = enteros % 1000;
  const partes = [];
  if (mill) {
    const milMill = Math.floor(mill / 1000), m = mill % 1000;
    const t = [milMill ? (milMill === 1 ? '' : cientos(milMill, true) + ' ') + 'mil' : '', cientos(m, true)].filter(Boolean).join(' ');
    partes.push(t + (mill === 1 ? ' millón' : ' millones'));
  }
  if (miles) partes.push(miles === 1 ? 'mil' : cientos(miles, true) + ' mil');
  if (resto) partes.push(cientos(resto, false));
  let s = partes.join(' ') || 'cero';
  if (cent) s += ` con ${String(cent).padStart(2, '0')}/100`;
  return s.split(' ').map((p) => (p === 'y' || p === 'con' ? p : p.charAt(0).toUpperCase() + p.slice(1))).join(' ');
}

/** "1.790.000" o "474.164,50": con puntos de miles y los centavos solo si hay. */
export function cifra(monto) {
  const total = Math.round(Math.abs(+monto || 0) * 100), enteros = Math.floor(total / 100), cent = total % 100;
  const miles = String(enteros).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return cent ? `${miles},${String(cent).padStart(2, '0')}` : miles;
}

/** El DNI con puntos. De un CUIT/CUIL (11 cifras) toma el DNI del medio. */
export function dniOficio(s) {
  const d = String(s || '').replace(/\D/g, '');
  const n = d.length === 11 ? d.slice(2, 10).replace(/^0+/, '') : d;
  if (n.length < 7 || n.length > 8) return String(s || '').trim();
  return n.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** "San Martín 250, Villa María, Córdoba" → { calle: 'San Martín', numero: '250', localidad: 'Villa María' }. */
export function partirDomicilio(s) {
  const partes = String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!partes.length) return { calle: '', numero: '', localidad: '' };
  const m = /^(.*?)\s+(?:n(?:ro|°|º)?\.?\s*)?(\d+\s*[a-z]?|s\/n)$/i.exec(partes[0]);
  return { calle: m ? m[1].trim() : partes[0], numero: m ? m[2].replace(/\s+/g, '') : '', localidad: partes[1] || '' };
}

const TIPO_VEHICULO = /^(motocicleta|moto|cuatriciclo|camión|camion|camioneta|automóvil|automovil|auto|furgón|furgon|utilitario|acoplado|semirremolque|tractor)\s+/i;
const MARCA_DOBLE = /^(mercedes[- ]benz|land rover|alfa romeo|great wall|aston martin|rolls royce|harley davidson)\b/i;
/**
 * El vehículo de la prenda, como se carga en la ficha ("PEUGEOT 208 1.6, dominio AB123CD, motor …,
 * chasis …") en sus datos para el oficio: { marca, modelo, anio_vehiculo, dominio, motor, chasis }.
 */
export function partirVehiculo(s) {
  const r = { marca: '', modelo: '', anio_vehiculo: '', dominio: '', motor: '', chasis: '' };
  let t = String(s || '').trim();
  if (!t) return r;
  const anio = /\(?\s*año\s+(\d{4})\s*\)?/i.exec(t);
  if (anio) { r.anio_vehiculo = anio[1]; t = t.replace(anio[0], ' '); }
  t = t.replace(/\([^)]*\)/g, ' '); // aclaraciones entre paréntesis
  const sacar = (re) => { const m = re.exec(t); if (!m) return ''; t = t.replace(m[0], ' '); return m[1].trim(); };
  r.dominio = sacar(/,?\s*dominio\s+([^,]+)/i);
  r.motor = sacar(/,?\s*motor\s+([^,]+)/i);
  r.chasis = sacar(/,?\s*chasis\s+([^,]+)/i);
  t = t.replace(/[\s,]+/g, ' ').trim().replace(TIPO_VEHICULO, '');
  const doble = MARCA_DOBLE.exec(t), corte = doble ? doble[0].length : t.indexOf(' ');
  r.marca = (corte < 0 ? t : t.slice(0, corte)).trim();
  r.modelo = corte < 0 ? '' : t.slice(corte).trim();
  return r;
}

const ORDINAL = { 1: '1ra', 2: '2da', 3: '3ra', 4: '4ta', 5: '5ta', 6: '6ta', 7: '7ma', 8: '8va', 9: '9na', 10: '10ma' };
/** La nominación como en el oficio de embargo: "2" → "2da". */
export const ordinal = (nom) => { const n = String(nom || '').replace(/\D/g, ''); return ORDINAL[n] || (n ? n + '°' : ''); };
const mayus = (s) => String(s || '').trim().toLocaleUpperCase('es');

/**
 * Los datos que salen de la causa para un oficio. `i` es el demandado elegido (por defecto, el
 * primero). Lo que no sale de la causa (empleador, cuenta judicial…) lo completa la persona.
 */
export function datosDeCausa(c, i = 0, hoy = new Date()) {
  const actor = /^(amb|asociaci[oó]n mutual bell)$/i.test(String(c.actor || '').trim()) ? 'ASOCIACION MUTUAL BELL' : mayus(c.actor);
  const tipo = String(c.tipo || '');
  const dem = (c.demandados || [])[i] || null;
  const nom = String(c.nom || '').replace(/\D/g, '');
  const prenda = (c.titulos || []).find((t) => t.tipo === 'prenda' && String(t.vehiculo || '').trim());
  const oficina = String(c.oficina || '');
  return {
    ciudad: /\bVM\b|villa mar[ií]a/i.test(oficina) ? 'Villa María' : /cruz del eje/i.test(oficina) ? 'Cruz del Eje' : 'Bell Ville',
    anio: String(hoy.getFullYear()),
    autos: c.demandado ? `${actor} C/ ${mayus(c.demandado)}` : actor,
    tipo_oficio: /prend/i.test(tipo) ? 'EJECUCIÓN PRENDARIA' : /ejecutiv/i.test(tipo) ? 'EJECUTIVO' : mayus(tipo),
    expediente: String(c.expte || ''),
    nom, nom_ordinal: ordinal(nom),
    persona: mayus(dem ? dem.nombre : c.demandado),
    dni: dem ? dniOficio(dem.dni) : '',
    ...partirDomicilio(dem ? dem.domicilio : ''),
    ...partirVehiculo(prenda ? prenda.vehiculo : ''),
    // El monto para enervar el secuestro es el capital reclamado de la prenda (cuotas impagas).
    monto_prenda: prenda ? +prenda.monto || 0 : 0,
  };
}

/** Nombre del PDF: sin acentos ni signos, para que el SAC lo acepte sin problemas. */
export function nombreArchivo(base, expte) {
  return `${base} - Expte ${expte}.pdf`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .\-]/g, '');
}

// ───────────────────────── PDF ─────────────────────────
// Un PDF chico escrito a mano, como el .xlsx de excel.js: sin librerías. Tamaño carta y márgenes
// del modelo de Word del estudio; el cuerpo en EB Garamond 12, justificado, con interlineado de
// 1,5; el encabezado en Caladea 11. Las tipografías van adentro del archivo, enteras y sin
// comprimir, y no se anota la fecha: el mismo texto da siempre el mismo PDF, byte por byte, en la
// app y en la tarea del SAC.

const PT = (twips) => twips / 20;
const PAGINA = { ancho: 612, alto: 792 };
const MARGEN = { izq: PT(2835), der: PT(851), sup: PT(1531), inf: PT(1134) };
const CUERPO = { tam: 12, renglon: 21, sangria: PT(2211), entre: 6 };
const ENC = { tam: 11, renglon: 19.3, antes: 6, despues: 14 };
const CIERRE = { izq: PT(708 + 708), antes: 14 };

// Windows-1252 (la codificación "WinAnsi" de los PDF): del 0x80 al 0x9F no es Latin-1.
const W1252 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030,
  0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
const A_BYTE = new Map();
for (let b = 32; b < 256; b++) {
  const u = b >= 0x80 && b < 0xa0 ? W1252[b] : b === 0x7f ? null : b;
  if (u != null) A_BYTE.set(u, b);
}
/** El byte WinAnsi de una letra. Lo que no está ahí va sin acento si se puede, o como "?". */
function aByte(ch) {
  const u = ch.codePointAt(0);
  if (A_BYTE.has(u)) return A_BYTE.get(u);
  if (ch === '\t' || u === 0x202f || u === 0x2007) return 32;
  const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return base.length === 1 && A_BYTE.has(base.codePointAt(0)) ? A_BYTE.get(base.codePointAt(0)) : 63;
}

/** Lo que hace falta de una tipografía TrueType: medidas y el ancho de cada letra WinAnsi. */
export function leerTtf(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), T = {};
  const n = v.getUint16(4);
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16;
    T[String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3))] = v.getUint32(p + 8);
  }
  for (const t of ['head', 'hhea', 'hmtx', 'cmap']) if (T[t] === undefined) throw new Error(`a la tipografía le falta la tabla ${t}`);
  const upem = v.getUint16(T.head + 18), k = 1000 / upem;
  const bbox = [0, 1, 2, 3].map((i) => Math.round(v.getInt16(T.head + 36 + 2 * i) * k));
  const asc = Math.round(v.getInt16(T.hhea + 4) * k), desc = Math.round(v.getInt16(T.hhea + 6) * k), nAnchos = v.getUint16(T.hhea + 34);
  let cap = asc;
  if (T['OS/2'] !== undefined && v.getUint16(T['OS/2']) >= 2) cap = Math.round(v.getInt16(T['OS/2'] + 88) * k);
  const italica = T.post !== undefined ? v.getInt16(T.post + 4) + v.getUint16(T.post + 6) / 65536 : 0;
  // cmap: la tabla (3,1) de formato 4, la de Unicode
  let sub = -1;
  for (let i = 0, ns = v.getUint16(T.cmap + 2); i < ns; i++) {
    const r = T.cmap + 4 + i * 8, off = T.cmap + v.getUint32(r + 4);
    if (v.getUint16(r) === 3 && v.getUint16(r + 2) === 1 && v.getUint16(off) === 4) sub = off;
  }
  if (sub < 0) throw new Error('la tipografía no tiene tabla Unicode');
  const seg2 = v.getUint16(sub + 6), fin = sub + 14, ini = fin + seg2 + 2, delta = ini + seg2, rango = delta + seg2;
  const glifo = (cp) => {
    for (let i = 0; i < seg2 / 2; i++) {
      if (cp > v.getUint16(fin + 2 * i)) continue;
      const desde = v.getUint16(ini + 2 * i);
      if (cp < desde) return 0;
      const d = v.getInt16(delta + 2 * i), ro = v.getUint16(rango + 2 * i);
      if (!ro) return (cp + d) & 0xffff;
      const g = v.getUint16(rango + 2 * i + ro + 2 * (cp - desde));
      return g ? (g + d) & 0xffff : 0;
    }
    return 0;
  };
  const avance = (g) => v.getUint16(T.hmtx + 4 * Math.min(g, nAnchos - 1));
  const anchos = new Array(256).fill(0);
  for (const [u, b] of A_BYTE) { const g = glifo(u); anchos[b] = Math.round(avance(g) * k); }
  // Nombre PostScript (name, id 6), para el PDF
  let nombre = '';
  if (T.name !== undefined) {
    const nn = v.getUint16(T.name + 2), base = T.name + v.getUint16(T.name + 4);
    for (let i = 0; i < nn && !nombre; i++) {
      const r = T.name + 6 + i * 12;
      if (v.getUint16(r + 6) !== 6) continue;
      const pid = v.getUint16(r), len = v.getUint16(r + 8), off = base + v.getUint16(r + 10);
      let s = '';
      if (pid === 3 || pid === 0) for (let j = 0; j < len; j += 2) s += String.fromCharCode(v.getUint16(off + j));
      else if (pid === 1) for (let j = 0; j < len; j++) s += String.fromCharCode(v.getUint8(off + j));
      nombre = s.replace(/[^A-Za-z0-9\-]/g, '');
    }
  }
  return { bytes, bbox, asc, desc, cap, italica, anchos, nombre: nombre || 'Tipografia' };
}

/** El texto en bytes WinAnsi, como string PDF: los bytes de 128 en adelante, en octal. */
function pdfTexto(s) {
  let r = '(';
  for (const ch of s) {
    const b = aByte(ch);
    if (b === 40 || b === 41 || b === 92) r += '\\' + String.fromCharCode(b);
    else if (b < 128) r += String.fromCharCode(b);
    else r += '\\' + b.toString(8).padStart(3, '0');
  }
  return r + ')';
}
const ancho = (s, f, tam) => { let w = 0; for (const ch of s) w += f.anchos[aByte(ch)]; return (w * tam) / 1000; };
const num = (n) => (Math.round(n * 1000) / 1000).toString();

/** Corta un párrafo en renglones del ancho dado. Cada palabra puede mezclar negrita y no negrita. */
function renglones(trs, fuentes, tam, anchoTotal, sangria) {
  const palabras = [];
  let actual = [];
  for (const { t, b } of trs) {
    t.split(/( +)/).forEach((p) => {
      if (!p) return;
      if (/^ +$/.test(p)) { if (actual.length) palabras.push(actual); actual = []; } else actual.push({ t: p, b });
    });
  }
  if (actual.length) palabras.push(actual);
  const espacio = ancho(' ', fuentes.cuerpo, tam);
  const medida = (w) => w.reduce((a, x) => a + ancho(x.t, x.b ? fuentes.negrita : fuentes.cuerpo, tam), 0);
  const lineas = [];
  let linea = [], ocupado = 0, limite = anchoTotal - sangria;
  for (const w of palabras) {
    const m = medida(w), suma = (linea.length ? espacio : 0) + m;
    if (linea.length && ocupado + suma > limite + 0.01) {
      lineas.push({ palabras: linea, natural: ocupado, limite });
      linea = []; ocupado = 0; limite = anchoTotal;
    }
    ocupado += (linea.length ? espacio : 0) + m;
    linea.push(w);
  }
  if (linea.length) lineas.push({ palabras: linea, natural: ocupado, limite, ultima: true });
  return lineas;
}

/** Una línea de texto: los tramos seguidos con la misma letra van juntos. Tw estira los espacios. */
function lineaPdf(palabras, x, y, tam, tw, letra) {
  const runs = [];
  palabras.forEach((w, i) => {
    w.forEach((x2, j) => {
      const f = letra(x2.b), t = (i > 0 && j === 0 ? ' ' : '') + x2.t;
      if (runs.length && runs[runs.length - 1].f === f) runs[runs.length - 1].t += t; else runs.push({ f, t });
    });
  });
  let s = `BT 1 0 0 1 ${num(x)} ${num(y)} Tm ${num(tw)} Tw`;
  let f = '';
  for (const r of runs) { if (r.f !== f) { s += ` /${r.f} ${tam} Tf`; f = r.f; } s += ` ${pdfTexto(r.t)} Tj`; }
  return s + ' ET';
}

/**
 * El oficio en PDF (Uint8Array). `fuentes`: { cuerpo, negrita, encabezado } con los bytes de las
 * tipografías TrueType (docs/fonts/eb-garamond-400.ttf, eb-garamond-700.ttf y caladea-400.ttf).
 */
export function pdfOficio(texto, fuentes, { titulo = 'Oficio' } = {}) {
  const F = { cuerpo: leerTtf(fuentes.cuerpo), negrita: leerTtf(fuentes.negrita), encabezado: leerTtf(fuentes.encabezado) };
  const d = analizar(texto);
  const anchoTexto = PAGINA.ancho - MARGEN.izq - MARGEN.der;
  const paginas = [[]];
  let y = PAGINA.alto - MARGEN.sup;
  const lugar = (alto) => { if (y - alto < MARGEN.inf) { paginas.push([]); y = PAGINA.alto - MARGEN.sup; } };
  const escribir = (s) => paginas[paginas.length - 1].push(s);

  for (const l of d.encabezado) {
    y -= ENC.antes; lugar(ENC.renglon);
    const base = y - ENC.tam * 0.8;
    escribir(`BT 1 0 0 1 ${num(MARGEN.izq)} ${num(base)} Tm 0 Tw /F3 ${ENC.tam} Tf ${pdfTexto(l.map((x) => x.t).join(''))} Tj ET`);
    y -= ENC.renglon;
  }
  y -= ENC.despues;
  d.parrafos.forEach((p, k) => {
    if (k > 0) y -= p.tipo === 'cierre' ? CIERRE.antes : CUERPO.entre;
    const izq = p.tipo === 'cierre' ? CIERRE.izq : 0, sangria = p.tipo === 'sangria' ? CUERPO.sangria : 0;
    const ls = renglones(p.tramos, F, CUERPO.tam, anchoTexto - izq, sangria);
    ls.forEach((ln, i) => {
      lugar(CUERPO.renglon);
      const espacios = ln.palabras.length - 1;
      // Justificado: el último renglón (y la despedida) va sin estirar.
      const tw = !ln.ultima && p.tipo !== 'cierre' && espacios > 0 ? (ln.limite - ln.natural) / espacios : 0;
      const x = MARGEN.izq + izq + (i === 0 ? sangria : 0);
      escribir(lineaPdf(ln.palabras, x, y - CUERPO.tam * 0.8, CUERPO.tam, tw, (b) => (b ? 'F2' : 'F1')));
      y -= CUERPO.renglon;
    });
  });

  // Armado del archivo: objetos numerados y la tabla de posiciones (xref).
  const enc = new TextEncoder(), partes = [], pos = [];
  let largo = 0;
  const poner = (b) => { const u = typeof b === 'string' ? enc.encode(b) : b; partes.push(u); largo += u.length; };
  const objetos = []; // cada uno: string o [cabecera, bytes, cola]
  const nuevo = (contenido) => { objetos.push(contenido); return objetos.length; };
  const catalogo = nuevo(null), arbol = nuevo(null);
  const fuenteObj = (f) => {
    const archivo = nuevo([`<< /Length ${f.bytes.length} /Length1 ${f.bytes.length} >>\nstream\n`, f.bytes, '\nendstream']);
    const desc = nuevo(`<< /Type /FontDescriptor /FontName /${f.nombre} /Flags 34 /FontBBox [${f.bbox.join(' ')}] /ItalicAngle ${num(f.italica)} /Ascent ${f.asc} /Descent ${f.desc} /CapHeight ${f.cap} /StemV 80 /FontFile2 ${archivo} 0 R >>`);
    return nuevo(`<< /Type /Font /Subtype /TrueType /BaseFont /${f.nombre} /FirstChar 32 /LastChar 255 /Widths [${f.anchos.slice(32).join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor ${desc} 0 R >>`);
  };
  const f1 = fuenteObj(F.cuerpo), f2 = fuenteObj(F.negrita), f3 = fuenteObj(F.encabezado);
  const hojas = paginas.map((lineas) => {
    const cont = lineas.join('\n');
    const c = nuevo(`<< /Length ${enc.encode(cont).length} >>\nstream\n${cont}\nendstream`);
    return nuevo(`<< /Type /Page /Parent ${arbol} 0 R /MediaBox [0 0 ${PAGINA.ancho} ${PAGINA.alto}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> /Contents ${c} 0 R >>`);
  });
  objetos[catalogo - 1] = `<< /Type /Catalog /Pages ${arbol} 0 R >>`;
  objetos[arbol - 1] = `<< /Type /Pages /Kids [${hojas.map((h) => h + ' 0 R').join(' ')}] /Count ${hojas.length} >>`;
  const info = nuevo(`<< /Title ${pdfTexto(titulo)} /Producer (Gestor de juicios - Estudio Soler) >>`);

  poner('%PDF-1.4\n');
  poner(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // comentario con bytes altos: avisa que el archivo es binario
  objetos.forEach((o, i) => {
    pos[i] = largo;
    poner(`${i + 1} 0 obj\n`);
    if (Array.isArray(o)) { poner(o[0]); poner(o[1]); poner(o[2]); } else poner(o);
    poner('\nendobj\n');
  });
  const xref = largo;
  poner(`xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n${pos.map((p) => String(p).padStart(10, '0') + ' 00000 n \n').join('')}`);
  poner(`trailer\n<< /Size ${objetos.length + 1} /Root ${catalogo} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const salida = new Uint8Array(largo);
  let o = 0;
  for (const p of partes) { salida.set(p, o); o += p.length; }
  return salida;
}

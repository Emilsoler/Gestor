// Documentos de Drive que pide cada escrito y tipo de cada movimiento del historial.
// Funciones puras (sin DOM ni red): las usa app.js y se prueban en Node.

/** Minúsculas y sin tildes, para comparar textos escritos de distintas maneras. */
export const plano = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Cómo se reconoce cada documento por el nombre del archivo (formato del estudio: «AAMMDD-Tipo»).
// `donde`: 'constancias' es la carpeta «Constancias Emiliano Soler»; si no, la del demandado.
const DOCS = {
  tasa: { re: /\btasa\b/ },
  comprobante: { re: /comprobante|\bpago\b/ },
  'oficio de secuestro': { re: /oficio( de)? secuestro/ },
  'Cédula': { re: /cedula/, no: /sentencia|registro/ },
  'Cédula Sentencia': { re: /cedula.*sentencia/ },
  'liquidación': { re: /liquidacion/ },
  AFIP: { re: /afip/, donde: 'constancias' },
};

/**
 * Qué adjuntos de Drive lleva la próxima acción de la causa, según las reglas del estudio.
 * null: la próxima acción no es uno de los escritos con reglas (no se sabe qué lleva).
 * []: es un escrito que va sin adjuntos.
 */
export function requisitos(c) {
  const p = plano(c && c.proxima);
  if (!p.trim()) return null;
  if (/\btasa\b/.test(p)) {
    return /prendari/.test(plano(c.tipo)) || /oficio/.test(p) ? ['tasa', 'comprobante', 'oficio de secuestro'] : ['tasa', 'comprobante'];
  }
  if (/no oposicion/.test(p)) return ['Cédula', 'AFIP'];
  if (/ejecut\w* (la )?sentencia/.test(p)) return /sin fianza|563/.test(p) ? null : ['Cédula Sentencia', 'liquidación'];
  if (/pase a fallo|aprobacion de (la )?liquidacion|designa\w* martillero/.test(p)) return [];
  return null;
}

/** El archivo más nuevo que corresponde al documento (los nombres empiezan con la fecha AAMMDD). */
function buscar(nombre, drive) {
  const d = DOCS[nombre]; if (!d || !drive) return null;
  const lista = (d.donde === 'constancias' ? drive.constancias : drive.archivos) || [];
  const hay = lista.filter((a) => d.re.test(plano(a)) && !(d.no && d.no.test(plano(a))));
  return hay.sort((a, b) => b.localeCompare(a))[0] || null;
}

/**
 * Estado de los documentos de la causa: { revisado, carpeta, lista: [{nombre, archivo}], faltan, sinReglas, archivos }.
 * Sin revisión de Drive (drive null), `revisado` es null y no se informa nada como faltante.
 */
export function documentos(c) {
  const drive = c && c.drive && typeof c.drive === 'object' ? c.drive : null;
  const req = requisitos(c);
  const lista = drive && req ? req.map((nombre) => ({ nombre, archivo: buscar(nombre, drive) })) : [];
  return {
    revisado: drive ? drive.revisado || null : null,
    carpeta: drive ? drive.carpeta || '' : '',
    archivos: drive ? drive.archivos || [] : [],
    req, lista,
    faltan: lista.filter((x) => !x.archivo).map((x) => x.nombre),
  };
}

// ───────────────────────── Tipo de cada movimiento ─────────────────────────

export const TIPOS_MOV = {
  escrito: { nombre: 'Escrito', plural: 'Escritos', letra: 'E' },
  decreto: { nombre: 'Tribunal', plural: 'Tribunal', letra: 'T' },
  cedula: { nombre: 'Notificación', plural: 'Notificaciones', letra: 'N' },
  pago: { nombre: 'Pago', plural: 'Pagos', letra: '$' },
  otro: { nombre: 'Gestión', plural: 'Gestiones', letra: '•' },
};

// Lo que presenta el estudio: empieza con el verbo del escrito («Solicitamos», «Acompaña», «Ejecutamos»…).
const ESCRITO = /^(solicit|acompa|ejecut|design|contest(amos|a|o)\b|prest\w* conformidad|manifest|present|inici|evacu|interpon|ofrec|impugn|recurr|apel|denunci|impuls|pedi|reiter|adjunt|formul|demanda)|\bescrito\b/;
const CEDULA = /cedula|notific|e-?cedula/;
const DECRETO = /^(sentencia|decreto|auto\b|certificado|resolu|provey|proveido|homolog|admit|se (ordena|designa|admite|declara|resuelve|tiene|corre|aprueba|regula|fija|libra))|sentencia de remate|aprob\w* (la )?liquidacion|regulacion de honorarios/;
const PAGO = /\bop\b|orden de pago|\bpag(o|os|aron|o el)\b|\bcuota\b|deposit|transferencia|cobramos/;

/** Escrito, decreto/resolución del tribunal, notificación, pago u otra gestión, según el texto. */
export function tipoMovimiento(texto) {
  const t = plano(texto).trim();
  if (ESCRITO.test(t)) return 'escrito';
  if (CEDULA.test(t)) return 'cedula';
  if (DECRETO.test(t)) return 'decreto';
  if (PAGO.test(t)) return 'pago';
  return 'otro';
}

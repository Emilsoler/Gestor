// «Hacer demanda» de Nueva causa: pasa lo que Claude leyó de los PDF (función `leer-demanda`) a los datos de la causa y de
// la demanda, y arma el Word con los modelos del estudio:
//   · prendaria  → «HAZ Demanda Prendaria» (haz DP): `cobranzas/modelos/demanda-prendaria.docx`, con las cuentas de `cobranzas/demanda.js`.
//   · documentos → «HAZ Demanda de Documentos» (pagarés): `cobranzas/modelos/demanda-documentos.docx` (lo arma `dev/modelo-dd.mjs`).
// Todo es puro (no toca la pantalla ni la red): la app lo carga recién al tocar «Crear causa» con una demanda elegida.
//
// El texto de los modelos no se modifica: solo se reemplazan datos. Lo que no se pudo leer queda como «[nombre del dato]» en
// el Word y se avisa en pantalla.
import { nuevaDemanda, nuevoDemandado, datosDemanda, faltanDemanda, estadoDemanda, unirDemandados, CAMPOS_DEMANDA } from './cobranzas/demanda.js';
import { armarAcuerdo, fechaLarga } from './cobranzas/acuerdo.js';
import { enLetras, cifra } from './oficio.js';
import { ES_FECHA } from './cobranzas/calculo.js';

export const MODOS = { prendaria: 'Prendaria', documentos: 'Documentos' };
export const MODELOS_WORD = {
  prendaria: './cobranzas/modelos/demanda-prendaria.docx',
  documentos: './cobranzas/modelos/demanda-documentos.docx',
};

// ───────────────────────── Expediente pendiente ─────────────────────────
// Una causa cargada antes de presentar la demanda no tiene N° de expediente: lleva la clave provisoria PEND-<n>
// (migración 0053) y se muestra como «pendiente». Cuando el SAC da el número, la ficha lo reemplaza.

export const PENDIENTE = 'pendiente';
export const esPendiente = (expte) => /^PEND-\d+$/.test(String(expte ?? ''));
/** Cómo se muestra un expediente: el número, o «pendiente». */
export const expteTxt = (expte) => (esPendiente(expte) ? PENDIENTE : String(expte ?? ''));
/** La próxima clave provisoria libre: PEND-1, PEND-2… */
export function expteProvisorio(causas) {
  const usados = new Set((causas || []).map((c) => String(c.expte)));
  let n = 1;
  while (usados.has(`PEND-${n}`)) n++;
  return `PEND-${n}`;
}

// ───────────────────────── Archivos ─────────────────────────
export const MAX_BYTES = 12 * 1024 * 1024; // lo mismo que acepta la función
export const MAX_ARCHIVOS = 12;
/** ¿Es un archivo que la función puede leer (PDF o JPEG)? */
export const esLegible = (f) => f && (f.type === 'application/pdf' || f.type === 'image/jpeg' || /\.(pdf|jpe?g)$/i.test(f.name || ''));
export const tipoDe = (f) => (f.type === 'image/jpeg' || /\.jpe?g$/i.test(f.name || '') ? 'image/jpeg' : 'application/pdf');

/** Controla la lista de archivos: devuelve el texto del problema, o '' si está bien. */
export function revisarArchivos(archivos) {
  if (!archivos.length) return 'Adjuntá los PDF';
  if (archivos.length > MAX_ARCHIVOS) return `Se pueden leer hasta ${MAX_ARCHIVOS} archivos juntos`;
  if (archivos.reduce((a, f) => a + (f.size || 0), 0) > MAX_BYTES) return 'Los archivos pesan demasiado juntos (máximo 12 MB). Adjuntá menos o más livianos';
  return '';
}

// ───────────────────────── Números y textos ─────────────────────────
/** El número como lo escribe `demanda.js` (coma decimal, sin puntos de miles): 143110.5 → "143110,5". */
export const numEs = (n) => (n == null ? '' : String(n).replace('.', ','));
const fechaOVacio = (iso) => (ES_FECHA.test(iso || '') ? iso : '');
const mayus = (t) => String(t ?? '').trim().toUpperCase();

/** El demandado de la lectura como lo pide el formulario de la demanda. */
const aFormulario = (d) => ({ ...nuevoDemandado(), nombre: mayus(d.nombre), dni: d.dni || '', calle: d.calle || '', ciudad: d.ciudad || nuevoDemandado().ciudad });

// ───────────────────────── Demanda prendaria ─────────────────────────
/**
 * El formulario de «haz DP» (`nuevaDemanda`) con lo leído del Formulario 03 y el contrato. `moraN` es la cuota en que empezó
 * la mora (lo único que se pregunta; vacío: queda para completar a mano). Lo que no se leyó queda vacío.
 */
export function formularioPrendaria(lectura, moraN = '') {
  const c = lectura.contrato || {}, v = lectura.vehiculo || {};
  const F = nuevaDemanda();
  if (lectura.demandados?.length) F.demandados = lectura.demandados.map(aFormulario);
  F.prestamo = fechaOVacio(c.fecha);
  F.prendaMonto = numEs(c.montoPrenda);
  F.registro = c.registro || '';
  F.inscripcion = fechaOVacio(c.inscripcion);
  Object.assign(F, { marca: v.marca || '', modelo: v.modelo || '', dominio: v.dominio || '', motor: v.motor || '', chasis: v.chasis || '' });
  F.cuotas = c.cuotas ? String(c.cuotas) : '';
  F.cuota = numEs(c.importeCuota);
  F.vto1 = fechaOVacio(c.primerVencimiento);
  F.moraN = String(moraN ?? '').trim();
  return F;
}

// ───────────────────────── Demanda de documentos (pagarés) ─────────────────────────
export const CAMPOS_DOCUMENTOS = {
  demandados: 'datos de los demandados', sea_condenado: 'condena', al_demandado: 'demandado',
  monto_letras: 'monto reclamado en letras', monto: 'monto reclamado', titulos_intro: 'cantidad de pagarés', pagare: 'pagarés',
};

const NUMEROS = ['', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte'];
/** «9 (nueve)»: la cantidad en cifra y en letras, como en las demandas del estudio. */
const cantidad = (n) => `${n} (${n <= 20 ? NUMEROS[n] : enLetras(n).toLowerCase()})`;

/** El renglón de un pagaré: «- 1) Pagaré con fecha de libramiento el día … por la suma de Pesos … ($ …) con vencimiento el día ….» */
export function renglonPagare(p, i) {
  const libra = fechaLarga(p.libramiento) || '[fecha de libramiento]';
  const monto = p.monto > 0 ? `Pesos ${enLetras(p.monto)} ($ ${cifra(p.monto)})` : 'Pesos [importe]';
  const vto = fechaLarga(p.vencimiento);
  return `- ${i + 1}) Pagaré con fecha de libramiento el día ${libra} por la suma de ${monto} con vencimiento el día ${vto || '[fecha de vencimiento]'}.`;
}

/** Los pagarés como van al Word: los datos de los campos y los renglones de la lista. */
export function datosDocumentos(lectura) {
  const pagares = lectura.pagares || [];
  const xs = lectura.demandados?.length ? lectura.demandados.map(aFormulario) : [nuevoDemandado()], varios = xs.length > 1;
  const total = Math.round(pagares.reduce((a, p) => a + (p.monto > 0 ? Math.round(p.monto * 100) : 0), 0)) / 100;
  const n = pagares.length;
  const valores = {
    demandados: unirDemandados(xs), sea_condenado: varios ? 'sean condenados solidariamente' : 'sea condenado', al_demandado: varios ? 'a los demandados' : 'al demandado',
    monto_letras: total > 0 ? enLetras(total) : '', monto: total > 0 ? cifra(total) : '',
    titulos_intro: n ? `${cantidad(n)} ${n === 1 ? 'pagaré suscripto por el demandado' : `pagarés suscriptos por ${varios ? 'los demandados' : 'el demandado'}`}` : '',
  };
  return { valores, renglones: pagares.map(renglonPagare), total };
}

/** Lo que va a quedar entre corchetes en el Word de pagarés, por sus nombres. */
export function faltanDocumentos(lectura) {
  const { valores } = datosDocumentos(lectura), faltan = [];
  if (/\[[^\]]+\]/.test(valores.demandados)) faltan.push('datos de algún demandado');
  if (!lectura.pagares?.length) faltan.push('pagarés');
  if (!valores.monto) faltan.push('monto reclamado');
  (lectura.pagares || []).forEach((p, i) => {
    if (!p.libramiento) faltan.push(`fecha de libramiento del pagaré ${i + 1}`);
    if (!p.monto) faltan.push(`importe del pagaré ${i + 1}`);
    if (!p.vencimiento) faltan.push(`vencimiento del pagaré ${i + 1}`);
  });
  return faltan;
}

// ───────────────────────── La causa ─────────────────────────
/** Los demandados de la ficha («demandados» de la causa) a partir de los leídos. */
const demandadosDeCausa = (xs) => xs.map((d) => ({ nombre: mayus(d.nombre), dni: d.dni || '', telefono: '', domicilio: [d.calle, d.ciudad].filter(Boolean).join(', '), notas: '' }));

/** «Contrato de prenda del 15 de marzo de 2026. 24 cuotas de $ 150.000. Mora desde la cuota 22.» (como las que carga la persona) */
function descripcionPrenda(F, e) {
  const p = [];
  if (F.prestamo) p.push(`Contrato de prenda del ${fechaLarga(F.prestamo)}.`);
  if (e.total && e.cuota) p.push(`${e.total} cuotas de $ ${cifra(e.cuota)}.`);
  if (e.valida) p.push(`Mora desde la cuota ${e.mora} (${fechaLarga(e.moraFecha) || 's/f'}): se reclaman las cuotas ${e.mora} a ${e.total} de ${e.total}.`);
  return p.join(' ');
}

/**
 * Los datos de la causa que salen de la lectura: demandado, tipo, demandados y títulos reclamados. Lo que la persona ya
 * escribió en la ficha manda (`ficha`): solo se completa lo vacío. El tipo cambia solo si sigue en el de arranque.
 * Devuelve un objeto para mezclar con la causa (`Object.assign(c, …)`).
 */
export function causaDeLectura(modo, lectura, ficha, { moraN = '' } = {}) {
  const xs = lectura.demandados || [];
  const out = {};
  if (!String(ficha.demandado || '').trim() && xs.length) out.demandado = xs.map((d) => mayus(d.nombre)).filter(Boolean).join(' y ');
  if ((!ficha.demandados || !ficha.demandados.length) && xs.length) out.demandados = demandadosDeCausa(xs);
  const tipoActual = String(ficha.tipo || '').trim().toUpperCase();
  const tipo = modo === 'prendaria' ? 'PRENDARIO' : 'EJECUTIVO';
  if (!tipoActual || tipoActual === 'EJECUTIVO' || tipoActual === tipo) out.tipo = tipo;
  if (!ficha.titulos?.length) {
    if (modo === 'prendaria') {
      const F = formularioPrendaria(lectura, moraN), e = estadoDemanda(F);
      const veh = [F.marca, F.modelo, F.dominio].filter(Boolean).join(' ');
      out.titulos = [{ tipo: 'prenda', monto: e.reclamado || 0, vence: e.moraFecha || '', descripcion: descripcionPrenda(F, e), vehiculo: veh }];
    } else {
      out.titulos = (lectura.pagares || []).map((p, i) => ({ tipo: 'pagare', monto: p.monto || 0, vence: p.vencimiento || '', descripcion: `Pagaré ${i + 1}${p.libramiento ? ` librado el ${fechaLarga(p.libramiento)}` : ''}`, vehiculo: '' }));
    }
  }
  return out;
}

// ───────────────────────── El Word ─────────────────────────
/** Nombre del archivo, como los del estudio: «AAMMDD - Demanda Ejecutiva Prendaria - APELLIDO NOMBRE.docx». */
export function nombreWord(modo, demandados, hoy) {
  const quien = (demandados || []).map((d) => String(d.nombre || '').trim()).filter(Boolean).join(' y ') || 'demandado';
  const tipo = modo === 'prendaria' ? 'Demanda Ejecutiva Prendaria' : 'Demanda Ejecutiva Pagarés';
  return `${String(hoy).slice(2).replace(/-/g, '')} - ${tipo} - ${quien}.docx`.replace(/[\\/:*?"<>|]+/g, ' ');
}

/** La carpeta del demandado en Drive: «APELLIDO NOMBRE» del primer demandado (como las que ya hay en «EN TRÁMITE»). */
export function carpetaDemandado(lectura) {
  const n = String((lectura?.demandados || []).map((d) => d?.nombre).find((x) => String(x || '').trim()) || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return mayus(n);
}

/** El nombre del PDF de la demanda: el del Word con otra extensión. */
export const nombrePdf = (nombreDelWord) => String(nombreDelWord || 'Demanda').replace(/\.docx$/i, '') + '.pdf';

/**
 * Arma el Word de la demanda con el modelo del estudio (`modelo`: los bytes del .docx).
 * Devuelve { blob, faltan, nombre }: `faltan` son los nombres, en palabras, de lo que quedó entre corchetes.
 */
export async function armarDemanda(modo, lectura, modelo, { moraN = '', hoy }) {
  if (modo === 'prendaria') {
    const F = formularioPrendaria(lectura, moraN);
    const { blob } = await armarAcuerdo(modelo, datosDemanda(F), CAMPOS_DEMANDA);
    return { blob, faltan: faltanDemanda(F), nombre: nombreWord(modo, F.demandados, hoy) };
  }
  const { valores, renglones } = datosDocumentos(lectura);
  const { blob } = await armarAcuerdo(modelo, valores, CAMPOS_DOCUMENTOS, { pagare: renglones });
  return { blob, faltan: faltanDocumentos(lectura), nombre: nombreWord(modo, (lectura.demandados || []).map((d) => ({ nombre: mayus(d.nombre) })), hoy) };
}

// Exportar la refinanciación: el convenio en Word (a partir del modelo del estudio) y la planilla de Excel.
// Todo se arma en el navegador, sin librerías y sin red (el modelo es un archivo de la app). Las cuentas
// no se hacen acá: llegan hechas (`estadoRefi`, en refinanciacion.js).
//
// El modelo es `modelos/acuerdo-refinanciacion.docx`: un Word común con campos {{así}}. Para cambiar el texto
// legal alcanza con reemplazar ese archivo, cuidando de dejar los campos que se quieran completar (ver CAMPOS_ACUERDO).
import { zip } from '../excel.js';
import { enLetras, cifra } from '../oficio.js';
import { sumarMeses, ES_FECHA } from './calculo.js';
import { vto1Efectivo } from './refinanciacion.js';

export const TIPO_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Cada campo del modelo (el nombre del deudor es el del caso) con cómo se le dice a la persona cuando falta (queda "[DNI del deudor]" en el Word, a completar a mano). */
export const CAMPOS_ACUERDO = {
  deudor_nombre: 'nombre del deudor', deudor_dni: 'DNI del deudor', deudor_calle: 'domicilio del deudor', deudor_ciudad: 'ciudad del deudor',
  dia_firma: 'día', mes_firma: 'mes', anio_firma: 'año',
  deuda_total_letras: 'deuda en letras', deuda_total: 'deuda', prestamo_fecha: 'fecha del préstamo',
  cuotas_orig_cant_letras: 'cuotas originales en letras', cuotas_orig_cant: 'cuotas originales', cuota_orig_letras: 'cuota original en letras',
  cuota_orig_monto: 'cuota original', cuota_orig_primer_venc: 'vencimiento de la cuota 1',
  mora_cuota_nro: 'cuota en que empezó la mora', mora_fecha: 'fecha de la mora', cuotas_impagas_letras: 'cuotas impagas en letras', cuotas_impagas: 'cuotas impagas',
  refi_cuotas_letras: 'cuotas del plan en letras', refi_cuotas: 'cuotas del plan', refi_cuota_letras: 'cuota del plan en letras', refi_cuota_monto: 'cuota del plan',
  refi_primer_venc: 'primer vencimiento del plan',
};

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** "2026-10-10" → "10 de octubre de 2026" ('' si no es una fecha). */
export function fechaLarga(iso) {
  if (!ES_FECHA.test(iso || '')) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} de ${MESES[m - 1]} de ${y}`;
}
const pesosTexto = (n) => '$' + cifra(n);
const letrasMayus = (n) => enLetras(n).toUpperCase();
const cantLetras = (n) => enLetras(n).toLowerCase();

/** Las cuotas que entran en la deuda: las vencidas y, si se tildó, las que faltan vencer. */
const cuotasDeuda = (e) => e.liq.cuotas.filter((c) => c.saldo > 0 && (c.incluida || e.aVencer > 0));

/**
 * Los datos del convenio. `e` es el resultado de estadoRefi, `R` lo escrito en la pantalla, `d` el deudor de la app
 * (o null si se cargó a mano) y `hoy` la fecha de hoy ('aaaa-mm-dd').
 * `deuda_total` es la suma nominal de las cuotas impagas, como dice la cláusula 1.3 del modelo.
 */
export function datosAcuerdo(e, R, d, hoy, nombre = '') {
  const pend = cuotasDeuda(e);
  const primera = pend[0] || null;
  const nominal = Math.round(pend.reduce((a, c) => a + Math.round(c.saldo * 100), 0)) / 100;
  const de = primera?.de ?? (parseInt(R.cantCuotas, 10) || 0);
  const vto1 = d ? (primera?.n && primera.vto ? sumarMeses(primera.vto, -(primera.n - 1)) : '') : vto1Efectivo(R);
  const firma = ES_FECHA.test(R.firma || '') ? R.firma : hoy;
  const [fy, fm, fd] = firma.split('-').map(Number);
  const prestamo = ES_FECHA.test(R.prestamo || '') ? R.prestamo : (d?.operaciones || []).map((o) => o.fecha).find((f) => ES_FECHA.test(f || '')) || '';
  const n = e.n, plan = e.plan;
  const v = {
    deudor_nombre: String(nombre || d?.nombre || '').trim(),
    deudor_dni: (R.dniDeudor || d?.dni || '').trim(),
    deudor_calle: (R.calle || d?.domicilio || '').trim(),
    deudor_ciudad: (R.ciudad || '').trim() || 'Bell Ville',
    dia_firma: String(fd), mes_firma: MESES[fm - 1], anio_firma: String(fy),
    deuda_total_letras: nominal > 0 ? letrasMayus(nominal) : '', deuda_total: nominal > 0 ? pesosTexto(nominal) : '',
    prestamo_fecha: fechaLarga(prestamo),
    cuotas_orig_cant_letras: de ? cantLetras(de) : '', cuotas_orig_cant: de ? String(de) : '',
    cuota_orig_letras: primera ? letrasMayus(primera.importe) : '', cuota_orig_monto: primera ? pesosTexto(primera.importe) : '',
    cuota_orig_primer_venc: fechaLarga(vto1),
    mora_cuota_nro: primera?.n ? String(primera.n) : '', mora_fecha: fechaLarga(primera?.vto || ''),
    cuotas_impagas_letras: pend.length ? cantLetras(pend.length) : '', cuotas_impagas: pend.length ? String(pend.length) : '',
    refi_cuotas_letras: cantLetras(n), refi_cuotas: String(n),
    refi_cuota_letras: plan.cuota > 0 ? letrasMayus(plan.cuota) : '', refi_cuota_monto: plan.cuota > 0 ? pesosTexto(plan.cuota) : '',
    refi_primer_venc: fechaLarga(plan.cuotas[0]?.vto || ''),
  };
  return v;
}

/** Avisos sobre lo que el modelo no contempla, para mostrar antes de bajar el Word. */
export function avisosAcuerdo(e) {
  const av = [];
  const pend = cuotasDeuda(e);
  const nominal = pend.reduce((a, c) => a + c.saldo, 0);
  if (Math.abs(e.deuda - e.entrega - nominal) > 0.5) av.push('La deuda que se refinancia no es solo el valor nominal de las cuotas impagas (suma intereses, honorarios, gastos o una entrega): revisá las cláusulas 1.3 y 2.1');
  if (e.plan.cuotas.length > 1 && e.plan.cuotas.some((q) => q.importe !== e.plan.cuotas[0].importe)) av.push('La última cuota difiere por el redondeo y el modelo dice cuotas iguales');
  if (e.cada !== 'mes') av.push('El modelo habla de cuotas mensuales y el plan es ' + (e.cada === 'quincena' ? 'quincenal' : 'semanal'));
  return av;
}

const xmlEsc = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Reemplaza los {{campos}} de un texto XML. Lo que falta queda como "[nombre del dato]" para completar a mano. Devuelve { xml, faltan }. */
export function rellenarXml(xml, valores, nombres = CAMPOS_ACUERDO) {
  const faltan = new Set();
  const out = xml.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const x = valores[k];
    if (x != null && String(x).trim() !== '') return xmlEsc(x);
    faltan.add(k);
    return xmlEsc(`[${nombres[k] || k}]`);
  });
  return { xml: out, faltan: [...faltan] };
}

// ───────────────────────── Leer un .docx (zip) ─────────────────────────
async function inflar(datos) {
  const flujo = new Blob([datos]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(flujo).arrayBuffer());
}
/** Las partes de un .zip, en su orden: [{ nombre, datos }]. Entiende las guardadas tal cual y las comprimidas (deflate). */
export async function leerZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let fin = buf.length - 22;
  while (fin >= 0 && dv.getUint32(fin, true) !== 0x06054b50) fin--;
  if (fin < 0) throw new Error('El archivo no es un .docx válido');
  const cant = dv.getUint16(fin + 10, true);
  let p = dv.getUint32(fin + 16, true);
  const dec = new TextDecoder(), partes = [];
  for (let i = 0; i < cant; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('El archivo no es un .docx válido');
    const metodo = dv.getUint16(p + 10, true), tam = dv.getUint32(p + 20, true);
    const ln = dv.getUint16(p + 28, true), le = dv.getUint16(p + 30, true), lc = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const nombre = dec.decode(buf.subarray(p + 46, p + 46 + ln));
    const inicio = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const crudo = buf.subarray(inicio, inicio + tam);
    if (metodo !== 0 && metodo !== 8) throw new Error('El .docx usa una compresión que no se puede leer');
    partes.push({ nombre, datos: metodo === 8 ? await inflar(crudo) : crudo.slice() });
    p += 46 + ln + le + lc;
  }
  return partes;
}

/**
 * Completa el modelo Word con los datos y devuelve { blob, faltan }.
 * `modelo` son los bytes del .docx (Uint8Array).
 */
export async function armarAcuerdo(modelo, valores, nombres = CAMPOS_ACUERDO) {
  const partes = await leerZip(modelo), dec = new TextDecoder(), enc = new TextEncoder(), faltan = new Set();
  const salida = partes.map((x) => {
    if (!/^word\/[^/]+\.xml$/.test(x.nombre)) return x;
    const r = rellenarXml(dec.decode(x.datos), valores, nombres);
    r.faltan.forEach((k) => faltan.add(k));
    return { nombre: x.nombre, datos: enc.encode(r.xml) };
  });
  return { blob: zip(salida, TIPO_DOCX), faltan: [...faltan] };
}

// ───────────────────────── Excel ─────────────────────────
/**
 * Las hojas de la planilla de la refinanciación (para `xlsx` de excel.js): el resumen con el estado de deuda y el plan,
 * y una hoja con las cuotas (con fórmulas en los totales).
 */
export function hojasRefinanciacion(e, R, d, hoy, fmtLargo, nombre = '') {
  const plan = e.plan, liq = e.liq;
    const filas = [
    [{ v: 'Refinanciación de deuda', s: 'titulo' }],
    [{ v: String(nombre || d?.nombre || '').trim() || 'Deudor sin nombre', s: 'negrita' }],
    [{ v: [R.dniDeudor || d?.dni ? `DNI ${R.dniDeudor || d.dni}` : '', d?.socio ? `Socio N° ${d.socio}` : ''].filter(Boolean).join(' · ') }],
    [{ v: 'Estado de deuda al' }, { v: e.fecha, fecha: true, s: 'fecha' }],
    [],
    ['Concepto', 'Devengado', 'Pagado', 'Saldo'].map((v) => ({ v, s: 'cab' })),
  ];
  const ini = filas.length + 1;
  const rubros = liq.rubros.filter((x) => x.devengado || x.pagado || x.saldo).map((x) => ({ n: x.nombre, dev: x.devengado, pag: x.pagado }));
  for (const x of e.extras) rubros.push({ n: x.concepto, dev: x.monto, pag: 0 });
  if (e.aVencer) rubros.push({ n: 'Cuotas a vencer', dev: e.aVencer, pag: 0 });
  if (e.iVencer) rubros.push({ n: '(−) Intereses a vencer', dev: -e.iVencer, pag: 0 });
  rubros.forEach((x, i) => filas.push([{ v: x.n, s: 'texto' }, { v: x.dev, s: 'pesos' }, { v: x.pag, s: 'pesos' }, { f: `B${ini + i}-C${ini + i}`, v: Math.round((x.dev - x.pag) * 100) / 100, s: 'calculo' }]));
  const fin = ini + rubros.length - 1;
  filas.push([{ v: 'Deuda a refinanciar', s: 'totTexto' }, { f: `SUM(B${ini}:B${fin})`, v: rubros.reduce((a, x) => a + x.dev, 0), s: 'totPesos' }, { f: `SUM(C${ini}:C${fin})`, v: rubros.reduce((a, x) => a + x.pag, 0), s: 'totPesos' }, { f: `SUM(D${ini}:D${fin})`, v: e.deuda, s: 'totPesos' }]);
  const r1 = filas.length; // fila de la deuda a refinanciar (1 basado)
  filas.push([], [{ v: 'Plan', s: 'negrita' }],
    [{ v: 'Deuda a refinanciar', s: 'texto' }, { f: `D${r1}`, v: e.deuda, s: 'pesos' }],
    [{ v: '(−) Entrega inicial', s: 'texto' }, { v: e.entrega, s: 'pesos' }],
    [{ v: 'Saldo a financiar', s: 'texto' }, { f: `B${r1 + 3}-B${r1 + 4}`, v: plan.financiado, s: 'calculo' }],
    [{ v: 'Tasa de financiación (% mensual)', s: 'texto' }, { v: e.tasa, s: 'texto' }],
    [{ v: 'Cantidad de cuotas', s: 'texto' }, { v: e.n, s: 'texto' }],
    [{ v: 'Importe de la cuota', s: 'texto' }, { v: plan.cuota, s: 'pesos' }],
    [{ v: 'Total a pagar en cuotas', s: 'totTexto' }, { f: `SUM(Cuotas!C2:C${plan.cuotas.length + 1})`, v: plan.total, s: 'totPesos' }],
    [{ v: 'Interés de la financiación', s: 'texto' }, { f: `B${r1 + 9}-B${r1 + 5}`, v: plan.intereses, s: 'calculo' }],
    [],
    [{ v: `Bajada de la app de cobranzas el ${fmtLargo(hoy)}. Simulación con las cuentas de la planilla del estudio: no es una oferta.`, s: 'nota' }]);
  const cuotas = [
    ['Cuota', 'Vence', 'Importe', 'Pagado', 'Saldo'].map((v) => ({ v, s: 'cab' })),
    ...plan.cuotas.map((q, i) => [{ v: q.n, s: 'texto' }, q.vto ? { v: q.vto, fecha: true, s: 'fecha' } : { v: '', s: 'texto' }, { v: q.importe, s: 'pesos' }, { v: 0, s: 'pesos' }, { f: `C${i + 2}-D${i + 2}`, v: q.importe, s: 'calculo' }]),
  ];
  const t = plan.cuotas.length + 1;
  cuotas.push([{ v: 'Total', s: 'totTexto' }, { s: 'totTexto' }, ...['C', 'D', 'E'].map((c) => ({ f: `SUM(${c}2:${c}${t})`, v: c === 'D' ? 0 : plan.total, s: 'totPesos' }))]);
  return [
    { nombre: 'Refinanciación', anchos: [38, 18, 18, 18], filas },
    { nombre: 'Cuotas', anchos: [8, 14, 18, 18, 18], filas: cuotas, congelar: { fila: 1 } },
  ];
}

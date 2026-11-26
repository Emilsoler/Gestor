// Descuento de cheques (Créditos → «Descuento de cheques»): la Mutual le compra cheques a un socio y le paga hoy el
// valor de los cheques menos interés por días, gastos cheque, IIBB, impuesto al cheque y sellado (sin IVA, pedido de la
// persona del 18/11/2026; conceptos del 26/11/2026). Acá están las cuentas, la forma de lo que se guarda (public.descuentos_cheques, migración 0035), la
// cartera de cheques a cobrar, el HTML del resultado y la planilla de Excel. Sin DOM: lo prueban en Node.
import { esc, fmt, fmtLargo, plata, porciento, cuantos } from './textos.js';
import { importe, enCelda, idNuevo, r2 } from '../liquidacion.js';
import { soloDigitos, avisoCuit } from './creditos.js';

export const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;
export const ESTADOS_CHEQUE = { cartera: 'En cartera', cobrado: 'Cobrado', rechazado: 'Rechazado' };
const DIA = 86_400_000;
export const DIAS_EXTRA_MAX = 5;
/** Los porcentajes que fijó la persona (26/11/2026): toda operación nueva arranca con estos; se pueden cambiar. */
export const HABITUALES = { comision: '1,5', iibb: '3', imp_cheque: '1,5' };

/** Días corridos de a hasta b (fechas AAAA-MM-DD, sin husos horarios). */
export const diasEntre = (a, b) => Math.round((Date.UTC(...partes(b)) - Date.UTC(...partes(a))) / DIA);
const partes = (s) => { const [y, m, d] = s.split('-').map(Number); return [y, m - 1, d]; };
/** Un porcentaje escrito a mano («1,5», «2 %»): NaN si no se entiende. Vacío es 0. */
export const pct = (s) => { const t = String(s ?? '').replace(/[%\s]/g, '').replace(',', '.'); if (!t) return 0; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
const num = (s) => (typeof s === 'number' ? s : pct(s));

export const nuevoCheque = () => ({ id: idNuevo(), entidad: '', banco: '', numero: '', librador: '', cuit: '', importe: '', vence: '', estado: 'cartera', fecha_estado: '', nota: '' });

/**
 * El formulario de una operación nueva. Interés, sellado y días extra de clearing arrancan como en la última operación
 * guardada (sin ninguna, vacíos: no se inventan tasas); gastos cheque, IIBB e impuesto al cheque, con HABITUALES.
 */
export function nuevoDescuento(hoy, ultima = null) {
  const c = (x) => (ultima && +ultima[x] ? String(ultima[x]).replace('.', ',') : '');
  return {
    cliente: '', cuit: '', socio: '', fecha: hoy, notas: '',
    tasa: c('tasa'), ...HABITUALES, sellado: c('sellado'), gastos: '',
    dias: ultima && +ultima.dias_extra ? String(ultima.dias_extra) : '',
    cheques: [nuevoCheque()],
  };
}

/** Una operación guardada, para editarla en el formulario (los números como se escriben). */
export function formDeFila(f) {
  const n = (x) => (+x ? String(+x).replace('.', ',') : '');
  return {
    cliente: f.cliente || '', cuit: f.cuit || '', socio: f.socio || '', fecha: f.fecha || '', notas: f.notas || '',
    tasa: n(f.tasa), comision: n(f.comision), sellado: n(f.sellado), iibb: n(f.iibb), imp_cheque: n(f.imp_cheque), gastos: +f.gastos ? enCelda(+f.gastos) : '', dias: +f.dias_extra ? String(f.dias_extra) : '',
    cheques: (Array.isArray(f.cheques) ? f.cheques : []).map((c) => ({ ...nuevoCheque(), ...c, entidad: c.entidad ? String(c.entidad) : '', importe: +c.importe ? enCelda(+c.importe) : '' })),
  };
}

/** Lo que se guarda en la base a partir del formulario (filas vacías afuera). */
export function filaDeForm(F) {
  const cheques = F.cheques.filter((c) => !chequeVacio(c)).map((c) => ({
    id: c.id || idNuevo(), entidad: +c.entidad || null, banco: String(c.banco || '').trim(), numero: soloDigitos(c.numero).replace(/^0+(?=\d)/, ''),
    librador: String(c.librador || '').trim(), cuit: soloDigitos(c.cuit), importe: importe(c.importe), vence: ES_FECHA.test(c.vence || '') ? c.vence : '',
    estado: ESTADOS_CHEQUE[c.estado] ? c.estado : 'cartera', fecha_estado: c.fecha_estado || '', nota: String(c.nota || '').trim(),
  }));
  return {
    cliente: String(F.cliente || '').trim(), cuit: soloDigitos(F.cuit), socio: String(F.socio || '').trim(), fecha: F.fecha,
    tasa: pct(F.tasa), comision: pct(F.comision), sellado: pct(F.sellado), iibb: pct(F.iibb), imp_cheque: pct(F.imp_cheque), gastos: importe(F.gastos), dias_extra: parseInt(F.dias, 10) || 0,
    cheques, notas: String(F.notas || '').trim(),
  };
}
const chequeVacio = (c) => !String(c.numero || '').trim() && !(importe(c.importe) > 0) && !c.vence && !String(c.librador || '').trim();

/**
 * La liquidación de una operación (fila de la base o filaDeForm). Por cada cheque:
 *   días      = de la fecha de la liquidación al vencimiento (0 si ya venció o vence hoy) + días extra de clearing (0 a 5)
 *   interés   = valor × tasa % mensual / 30 × días   (interés simple, adelantado, sobre el valor del cheque)
 *   gastos cheque (columna `comision`) = valor × %
 *   IIBB      = (interés + gastos cheque) × %
 *   impuesto al cheque = valor × %
 *   sellado   = valor × sellado %
 *   gastos    = fijos por cheque: ya no se cargan; quedan en las operaciones guardadas antes del 26/11/2026
 *   neto      = valor − todo lo anterior            → lo que se le paga al cliente por ese cheque
 * Cada concepto se redondea a centavos, cheque por cheque (así suma igual en la pantalla, el Excel y la base).
 */
export function liquidarDescuento(op) {
  const tasa = num(op.tasa) || 0, com = num(op.comision) || 0, sel = num(op.sellado) || 0, gastos = +op.gastos || 0, extra = +op.dias_extra || 0, ib = num(op.iibb) || 0, ic = num(op.imp_cheque) || 0;
  const fecha = ES_FECHA.test(op.fecha || '') ? op.fecha : '';
  const cheques = (op.cheques || []).map((c) => {
    const valor = +c.importe || 0, vence = ES_FECHA.test(c.vence || '') ? c.vence : '';
    const plazo = fecha && vence ? Math.max(0, diasEntre(fecha, vence)) : 0;
    const dias = plazo + extra;
    const interes = r2(valor * tasa / 100 / 30 * dias), comision = r2(valor * com / 100), sellado = r2(valor * sel / 100), g = valor > 0 ? r2(gastos) : 0;
    // IIBB va sobre interés + gastos cheque; el impuesto al cheque, sobre el valor.
    const iibb = r2((interes + comision) * ib / 100), impCheque = r2(valor * ic / 100);
    const descuento = r2(interes + comision + iibb + impCheque + sellado + g);
    return { ...c, importe: valor, vence, plazo, extra, dias, interes, comision, sellado, iibb, impCheque, gastos: g, descuento, neto: r2(valor - descuento) };
  });
  const suma = (k) => r2(cheques.reduce((a, c) => a + c[k], 0));
  const total = { importe: suma('importe'), interes: suma('interes'), comision: suma('comision'), sellado: suma('sellado'), iibb: suma('iibb'), impCheque: suma('impCheque'), gastos: suma('gastos'), descuento: suma('descuento'), neto: suma('neto') };
  // Plazo promedio ponderado por el valor de cada cheque: el «a cuántos días» de la operación.
  const plazo = total.importe > 0 ? Math.round(cheques.reduce((a, c) => a + c.dias * c.importe, 0) / total.importe) : 0;
  return { fecha, tasa, comisionPct: com, selladoPct: sel, iibbPct: ib, impChequePct: ic, gastosFijos: gastos, diasExtra: extra, cheques, total, plazo, problemas: problemasDescuento(op, cheques) };
}

/** Lo que falta o está mal para guardar la operación (lista vacía: se puede guardar). */
function problemasDescuento(op, cheques) {
  const p = [];
  if (!String(op.cliente || '').trim()) p.push('Falta el nombre del cliente');
  if (soloDigitos(op.cuit) && !avisoCuit(op.cuit).ok) p.push('El CUIT del cliente no es válido');
  if (!ES_FECHA.test(op.fecha || '')) p.push('Falta la fecha de la liquidación');
  for (const [k, t] of [['tasa', 'La tasa'], ['comision', 'Gastos cheque'], ['iibb', 'IIBB'], ['imp_cheque', 'El impuesto al cheque'], ['sellado', 'El sellado']]) { const v = num(op[k]); if (!(v >= 0 && v <= 100)) p.push(`${t} tiene que ser un porcentaje de 0 a 100`); }
  // Los días extra son los del clearing (0 a 2, a lo sumo unos pocos), no el plazo del cheque: ese sale de la fecha de pago.
  if (!(+op.dias_extra >= 0 && +op.dias_extra <= DIAS_EXTRA_MAX)) p.push(`Los días extra de clearing van de 0 a ${DIAS_EXTRA_MAX} (el plazo del cheque ya sale de la fecha de pago)`);
  if (!cheques.length) p.push('Cargá al menos un cheque');
  cheques.forEach((c, i) => {
    const n = `Cheque ${i + 1}`;
    if (!(c.importe > 0)) p.push(`${n}: falta el importe`);
    if (!c.vence) p.push(`${n}: falta la fecha de pago`);
    if (soloDigitos(c.cuit) && !avisoCuit(c.cuit).ok) p.push(`${n}: el CUIT del librador no es válido`);
    if (c.importe > 0 && c.neto <= 0) p.push(`${n}: los descuentos se comen todo el cheque`);
  });
  return p;
}

/** Los cheques de todas las operaciones con su operación al lado, del que vence antes al que vence después. */
export function cartera(ops, hoy, estado = 'cartera') {
  const xs = [];
  for (const op of ops) for (const c of op.cheques || []) if (!estado || (c.estado || 'cartera') === estado) {
    const falta = ES_FECHA.test(c.vence || '') ? diasEntre(hoy, c.vence) : null;
    xs.push({ op, c, falta });
  }
  return xs.sort((a, b) => String(a.c.vence || '9').localeCompare(String(b.c.vence || '9')) || String(a.op.cliente).localeCompare(String(b.op.cliente), 'es'));
}

/** Totales de la cartera: cuántos cheques y cuánto, y cuánto vence en los próximos 7 días o ya venció sin cobrarse. */
export function resumenCartera(ops, hoy) {
  const xs = cartera(ops, hoy), suma = (f) => r2(xs.filter(f).reduce((a, x) => a + (+x.c.importe || 0), 0));
  return {
    cant: xs.length, total: suma(() => true),
    semana: suma((x) => x.falta != null && x.falta >= 0 && x.falta <= 7), cantSemana: xs.filter((x) => x.falta != null && x.falta >= 0 && x.falta <= 7).length,
    vencidos: suma((x) => x.falta != null && x.falta < 0), cantVencidos: xs.filter((x) => x.falta != null && x.falta < 0).length,
    rechazados: cartera(ops, hoy, 'rechazado').length,
  };
}

export const cuandoVence = (falta) => (falta == null ? 'sin fecha' : falta === 0 ? 'se cobra hoy' : falta === 1 ? 'mañana' : falta > 0 ? `en ${falta} días` : falta === -1 ? 'venció ayer' : `venció hace ${-falta} días`);
export const bancoDe = (c) => c.banco || (c.entidad ? `Banco ${c.entidad}` : 'Banco sin cargar');

// ───────────────────────── Lo que se ve ─────────────────────────

/** La liquidación en pantalla: un cheque por fila y los totales; abajo, lo que se le paga al cliente. */
export function htmlLiquidacionDescuento(e) {
  const validos = e.cheques.filter((c) => c.importe > 0);
  if (!validos.length) return '<p class="hint m0">Cargá el importe y la fecha de pago de cada cheque para ver la liquidación.</p>';
  const col = (x) => `<td class="num mono">${esc(plata(x))}</td>`;
  const filas = validos.map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.vence ? fmt(c.vence) : '—')}</td><td class="num mono">${c.extra ? `${c.plazo} + ${c.extra}` : c.dias}</td>${col(c.importe)}${col(c.interes)}${col(c.comision)}${col(c.iibb)}${col(c.impCheque)}${col(c.sellado)}${e.total.gastos ? col(c.gastos) : ''}<td class="num mono"><b>${esc(plata(c.neto))}</b></td></tr>`).join('');
  const t = e.total;
  const condiciones = [`interés ${porciento(e.tasa)} mensual`, e.comisionPct ? `gastos cheque ${porciento(e.comisionPct)}` : '', e.iibbPct ? `IIBB ${porciento(e.iibbPct)}` : '', e.impChequePct ? `impuesto al cheque ${porciento(e.impChequePct)}` : '', e.selladoPct ? `sellado ${porciento(e.selladoPct)}` : '', e.gastosFijos ? `gastos ${plata(e.gastosFijos)} por cheque` : '', e.diasExtra ? `${cuantos(e.diasExtra, 'día extra', 'días extra')} de clearing por cheque` : ''].filter(Boolean).join(' · ');
  return `<div class="scrollx"><table class="tabla sim-tabla dc-tabla">
    <thead><tr><th>#</th><th>Vence</th><th class="num">Días</th><th class="num">Valor</th><th class="num">Interés</th><th class="num">Gastos cheque</th><th class="num">IIBB</th><th class="num">Imp. al cheque</th><th class="num">Sellado</th>${e.total.gastos ? '<th class="num">Gastos fijos</th>' : ''}<th class="num">Neto</th></tr></thead>
    <tbody>${filas}</tbody>
    <tfoot><tr><td colspan="3">Total · ${esc(cuantos(validos.length, 'cheque', 'cheques'))}</td>${col(t.importe)}${col(t.interes)}${col(t.comision)}${col(t.iibb)}${col(t.impCheque)}${col(t.sellado)}${t.gastos ? col(t.gastos) : ''}<td class="num mono"><b>${esc(plata(t.neto))}</b></td></tr></tfoot>
  </table></div>
  <dl class="cifras grandes sim-cifras"><div><dt>Valor de los cheques</dt><dd>${esc(plata(t.importe))}</dd></div><div><dt>(−) Descuentos</dt><dd>${esc(plata(t.descuento))}</dd></div></dl>
  <div class="sim-final"><span>Se le paga al cliente</span><b>${esc(plata(t.neto))}</b></div>
  <p class="hint m0">${esc(condiciones)}${e.plazo ? ` · plazo promedio ${esc(cuantos(e.plazo, 'día', 'días'))}` : ''}${e.fecha ? ` · liquidado al ${esc(fmtLargo(e.fecha))}` : ''}.</p>`;
}

/** La planilla para el cliente o para el legajo: condiciones, un cheque por fila con fórmulas y el neto a pagar. */
export function hojaDescuento(op, e, hoy) {
  const cond = (t, v, st = 'texto') => [{ v: t }, { v, s: st }];
  const filas = [
    [{ v: 'Liquidación de descuento de cheques', s: 'titulo' }],
    [{ v: op.cliente || 'Cliente sin nombre', s: 'negrita' }],
    [{ v: [op.cuit ? `CUIT ${op.cuit}` : '', op.socio ? `Socio N° ${op.socio}` : ''].filter(Boolean).join(' · ') }],
    [{ v: 'Fecha de la liquidación' }, e.fecha ? { v: e.fecha, fecha: true, s: 'fecha' } : { v: '' }],
    cond('Interés (% mensual)', e.tasa),           // B5
    cond('Gastos cheque (%)', e.comisionPct),      // B6
    cond('IIBB (% de interés + gastos cheque)', e.iibbPct), // B7
    cond('Impuesto al cheque (%)', e.impChequePct), // B8
    cond('Sellado (%)', e.selladoPct),             // B9
    cond('Gastos fijos por cheque ($)', e.gastosFijos, 'pesos'), // B10
    cond('Días extra de clearing', e.diasExtra),
    [],
    ['Banco', 'N° de cheque', 'Librador', 'CUIT librador', 'Vence', 'Días', 'Valor', 'Interés', 'Gastos cheque', 'IIBB', 'Imp. al cheque', 'Sellado', 'Gastos fijos', 'Neto'].map((v) => ({ v, s: 'cab' })),
  ];
  const cab = filas.length, ini = cab + 1, cs = e.cheques.filter((c) => c.importe > 0);
  cs.forEach((c, i) => {
    const r = ini + i, f = (formula, v) => ({ f: formula, v, s: 'calculo' });
    filas.push([{ v: bancoDe(c), s: 'texto' }, { v: c.numero || '', s: 'texto' }, { v: c.librador || '', s: 'texto' }, { v: c.cuit || '', s: 'texto' },
      c.vence ? { v: c.vence, fecha: true, s: 'fecha' } : { v: '', s: 'texto' }, { v: c.dias, s: 'texto' }, { v: c.importe, s: 'pesos' },
      f(`ROUND(G${r}*$B$5/100/30*F${r},2)`, c.interes), f(`ROUND(G${r}*$B$6/100,2)`, c.comision),
      f(`ROUND((H${r}+I${r})*$B$7/100,2)`, c.iibb), f(`ROUND(G${r}*$B$8/100,2)`, c.impCheque),
      f(`ROUND(G${r}*$B$9/100,2)`, c.sellado), f('$B$10', c.gastos), f(`G${r}-SUM(H${r}:M${r})`, c.neto)]);
  });
  const fin = ini + cs.length - 1, t = e.total;
  filas.push([{ v: 'Total', s: 'totTexto' }, ...Array(5).fill({ s: 'totTexto' }),
    ...[['G', t.importe], ['H', t.interes], ['I', t.comision], ['J', t.iibb], ['K', t.impCheque], ['L', t.sellado], ['M', t.gastos], ['N', t.neto]].map(([k, v]) => ({ f: `SUM(${k}${ini}:${k}${fin})`, v, s: 'totPesos' }))]);
  const rt = filas.length;
  filas.push([], [{ v: 'Valor de los cheques', s: 'texto' }, { f: `G${rt}`, v: t.importe, s: 'pesos' }],
    [{ v: '(−) Descuentos', s: 'texto' }, { f: `SUM(H${rt}:M${rt})`, v: t.descuento, s: 'pesos' }],
    [{ v: 'Neto a pagar al cliente', s: 'totTexto' }, { f: `N${rt}`, v: t.neto, s: 'totPesos' }],
    [], [{ v: `Bajada de Créditos y Cobros el ${fmtLargo(hoy)}. Interés simple por cada 30 días sobre el valor de cada cheque; sin IVA.`, s: 'nota' }]);
  return [{ nombre: 'Descuento', anchos: [36, 14, 26, 15, 12, 7, 15, 14, 14, 12, 14, 12, 12, 16], filas, congelar: { fila: cab }, apaisada: true }];
}

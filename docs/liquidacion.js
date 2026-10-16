// La liquidación de una causa: sus cuentas, los importes escritos a la argentina y la planilla
// en Excel. No toca la pantalla ni la red: la usan la ficha (app.js) y las pruebas.
//
// Forma (columna `liquidacion` de `causas`):
//   { fecha, embargo, rubros: [{ id, rubro, monto, pagado }], pagos: [{ id, fecha, op, imp: { <id del rubro>: monto } }] }
// Cada pago es una orden de pago (`op` es su N°) que reparte su monto entre los rubros, y
// `pagado` de cada rubro es la suma de lo que le imputan los pagos.
import { xlsx, columna } from './excel.js';

export const RUBROS = ['Honorarios', 'Intereses honorarios', 'Auto honorarios x ejec.', 'Gastos', 'Capital', 'Intereses capital'];
export const idNuevo = () => Math.random().toString(36).slice(2, 10);
/** Redondeo al centavo: evita que 0,1 + 0,2 muestre 0,30000000000000004. */
export const r2 = (n) => Math.round((+n || 0) * 100) / 100;

export function nuevaLiquidacion(hoy) {
  return { fecha: hoy, embargo: 0, rubros: RUBROS.map((r) => ({ id: idNuevo(), rubro: r, monto: 0, pagado: 0 })), pagos: [] };
}

/** Lo imputado a un rubro, sumando todos los pagos. */
export function cobradoRubro(l, id) { return r2(l.pagos.reduce((a, p) => a + (+p.imp[id] || 0), 0)); }
export function totalPago(p) { return r2(Object.values(p.imp || {}).reduce((a, v) => a + (+v || 0), 0)); }

/**
 * Completa lo que falte y recalcula `pagado`. Las liquidaciones anteriores tenían `pagado`
 * cargado a mano: pasa a un único pago sin fecha ni OP.
 */
export function liqNormal(l) {
  l.rubros = Array.isArray(l.rubros) ? l.rubros : [];
  l.rubros.forEach((r) => { if (!r.id) r.id = idNuevo(); });
  if (!Array.isArray(l.pagos)) {
    const imp = {};
    l.rubros.forEach((r) => { if (+r.pagado > 0) imp[r.id] = +r.pagado; });
    l.pagos = Object.keys(imp).length ? [{ id: idNuevo(), fecha: '', op: '', imp }] : [];
  }
  l.pagos.forEach((p) => { if (!p.id) p.id = idNuevo(); p.imp = p.imp || {}; p.fecha = p.fecha || ''; p.op = p.op || ''; });
  l.rubros.forEach((r) => { r.pagado = cobradoRubro(l, r.id); });
  return l;
}

/** Totales de la planilla y diferencia con el embargo (negativa: falta embargo). */
export function liqCalc(l) {
  const tot = r2(l.rubros.reduce((a, r) => a + (+r.monto || 0), 0)), pag = r2(l.rubros.reduce((a, r) => a + (+r.pagado || 0), 0));
  return { tot, pag, saldo: r2(tot - pag), dif: r2((+l.embargo || 0) - tot) };
}

// ───────────────────────── Importes ─────────────────────────

const MIL = /^\d{1,3}(\.\d{3})+$/;
/**
 * Lee un importe escrito a mano como se escribe en el expediente: "150.000", "1.234,50",
 * "$ 900", "-2.500". La coma es decimal; el punto separa miles cuando le siguen grupos de
 * tres cifras ("1.500" son mil quinientos) y si no, también es decimal ("1.5", "1234.50").
 */
export function importe(s) {
  let t = String(s ?? '').replace(/[$\s]/g, '');
  if (!t) return 0;
  const neg = t.startsWith('-') || /^\(.+\)$/.test(t);
  t = t.replace(/[-()]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (MIL.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? r2(neg ? -n : n) : 0;
}

const numero = (n) => Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
/** Para leer: "$ 1.300" o "$ 1.234,50" (los centavos, solo si hay). */
export function pesos(n) { n = r2(n); return (n < 0 ? '-$ ' : '$ ') + numero(n); }
/** Para una celda que se edita: sin "$" y vacía si es cero. `importe` la vuelve a leer igual. */
export function enCelda(n) { n = r2(n); return n ? (n < 0 ? '-' : '') + numero(n) : ''; }

// ───────────────────────── Planilla en Excel ─────────────────────────

const dma = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('/') : '');

/**
 * La planilla como archivo .xlsx: rubros en filas, una columna por orden de pago, y cobrado,
 * saldo y totales con fórmulas, para que siga cuadrando si se toca algo en Excel.
 *   c: { caratula, expte, nom, oficina, liquidacion }, hoy: 'aaaa-mm-dd'
 */
export function planillaExcel(c, hoy) {
  const l = liqNormal(JSON.parse(JSON.stringify(c.liquidacion)));
  const R = l.rubros, P = l.pagos, k = liqCalc(l), emb = r2(l.embargo);
  const opCol = (j) => columna(4 + j); // las órdenes de pago van desde la columna E
  const ini = 8, fin = ini + R.length - 1, tot = fin + 1; // filas de Excel (empiezan en 1)
  const suma = (col) => (R.length ? `SUM(${col}${ini}:${col}${fin})` : null);
  const cobrado = (f) => (P.length ? `SUM(${opCol(0)}${f}:${opCol(P.length - 1)}${f})` : null);
  const filas = [
    [{ v: 'Planilla de liquidación', s: 'titulo' }],
    [{ v: c.caratula || '', s: 'negrita' }],
    [{ v: [`Expte. N° ${c.expte}`, c.nom ? `${c.nom}° Nom.` : '', c.oficina || ''].filter(Boolean).join(' · ') }],
    [{ v: 'Fecha de la liquidación' }, l.fecha ? { v: l.fecha, fecha: true, s: 'fecha' } : { v: 'sin fecha' }],
    [],
    [{ v: 'Rubro', s: 'cab' }, { v: 'Monto', s: 'cab' }, { v: 'Cobrado', s: 'cab' }, { v: 'Saldo', s: 'cab' },
      ...P.map((p, j) => ({ v: p.op ? `OP N° ${p.op}` : `Pago ${j + 1}`, s: 'cab' }))],
    [{ v: 'Fecha de pago', s: 'cab' }, { s: 'cab' }, { s: 'cab' }, { s: 'cab' },
      ...P.map((p) => (p.fecha ? { v: p.fecha, fecha: true, s: 'cabFecha' } : { v: 'sin fecha', s: 'cab' }))],
  ];
  R.forEach((r, i) => {
    const f = ini + i, monto = r2(r.monto);
    filas.push([
      { v: r.rubro || '(sin nombre)', s: 'texto' },
      { v: monto, s: 'pesos' },
      { f: cobrado(f), v: r.pagado, s: 'calculo' },
      { f: `B${f}-C${f}`, v: r2(monto - r.pagado), s: 'calculo' },
      ...P.map((p) => ({ v: +p.imp[r.id] || null, s: 'pesos' })),
    ]);
  });
  filas.push([
    { v: 'Total', s: 'totTexto' },
    { f: suma('B'), v: k.tot, s: 'totPesos' }, { f: suma('C'), v: k.pag, s: 'totPesos' }, { f: suma('D'), v: k.saldo, s: 'totPesos' },
    ...P.map((p, j) => ({ f: suma(opCol(j)), v: totalPago(p), s: 'totPesos' })),
  ]);
  const fe = tot + 2; // fila del embargo
  const leyenda = !emb ? 'Sin embargo cargado' : k.dif < 0 ? 'Faltante: pedir ampliación de embargo' : 'Excedente sobre planilla';
  filas.push(
    [],
    [{ v: 'Embargo trabado', s: 'texto' }, { v: emb || null, s: 'pesos' }],
    [{ f: `IF(B${fe}=0,"Sin embargo cargado",IF(B${fe}<B${tot},"Faltante: pedir ampliación de embargo","Excedente sobre planilla"))`, v: leyenda, s: 'texto' },
      { f: `IF(B${fe}=0,0,ABS(B${fe}-B${tot}))`, v: emb ? Math.abs(k.dif) : 0, s: 'calculo' }],
    [],
    [{ v: `Cobrado, saldo y totales se calculan con fórmulas. Planilla bajada del gestor de juicios el ${dma(hoy)}.`, s: 'nota' }],
  );
  return xlsx([{ nombre: 'Liquidación', anchos: [34, 17, 17, 17, ...P.map(() => 17)], filas, congelar: { col: 1, fila: 7 }, apaisada: true }]);
}

// Las cuentas del crédito prendario para el cotizador de agencias.
//
// `simularCredito` es copia exacta de la de docs/cobranzas/vehiculos.js (el simulador interno): las dos
// tienen que dar lo mismo, y dev/tests/agencias.test.mjs las compara. Si se cambia una, cambiar la otra.
// Va copiada porque la función de Supabase no puede importar archivos de docs/.
//
// Lo propio del cotizador: el monto máximo según los parámetros y las tasas para informar (TNA, TEA y CFT).

export const CUOTAS_MAX = 120;
const PASO_REDONDEO = 1000;

/** `g`: porcentajes en % y el resto en pesos (números). Igual que en docs/cobranzas/vehiculos.js. */
export function simularCredito({ capital, cuotas, g, tasa }) {
  const K = Number(capital), n = Math.trunc(Number(cuotas));
  if (!(K > 0) || !(n >= 1) || !(tasa >= 0) || n > CUOTAS_MAX || !g) return null;
  const pos = (x) => Math.max(0, Number(x) || 0);
  const i = tasa / 100, f = i > 0 ? i / (1 - (1 + i) ** -n) : 1 / n; // cuota por cada peso financiado
  const sel = pos(g.sellado) / 100, ar = pos(g.arancel) / 100, min = pos(g.arancelMin), igrPct = pos(g.igr) / 100;
  const seguro = Math.round(K * pos(g.seguro) / 100 * n); // sobre el capital pedido, no sobre el monto con gastos
  const administrativos = pos(g.administrativos) * n, cuotaSocial = pos(g.cuotaSocial) * n; // por cuota
  const otrosFijos = seguro + administrativos + cuotaSocial;
  const contratos = pos(g.contratos), envio = pos(g.envio), gestoria = pos(g.gestoria);
  const calc = (F) => { // un monto financiado F: su cuota, sus intereses, el IGR y lo que se reparte sin interés
    const cuotaF = F * f, intereses = cuotaF * n - F, igr = igrPct * intereses, otros = otrosFijos + igr;
    return { cuotaF, intereses, igr, otros, cuota: cuotaF + otros / n };
  };
  const paso1 = calc(K);
  let T = paso1.cuota * n, r;
  for (let k = 0; k < 100; k++) {
    const sellado = Math.round(T * sel), arancel = Math.max(Math.round(T * ar), min), sub = sellado + arancel + contratos + envio + gestoria;
    const redondeo = g.redondeo == null ? Math.ceil(sub / PASO_REDONDEO) * PASO_REDONDEO - sub : Number(g.redondeo) || 0;
    const gastos = sub + redondeo, financiado = K + gastos, c = calc(financiado);
    r = { sellado, arancel, redondeo, gastos, financiado, c };
    const nuevo = c.cuota * n;
    if (Math.abs(nuevo - T) < 0.01) break;
    T = nuevo;
  }
  const cuotaCapital = Math.round(r.c.cuotaF), cuotaOtros = Math.round(r.c.otros / n), cuota = cuotaCapital + cuotaOtros;
  return { capital: K, cuotas: n, tasa, cuotaPaso1: Math.round(paso1.cuota),
    sellado: r.sellado, arancel: r.arancel, contratos, envio, gestoria, redondeo: r.redondeo, gastos: r.gastos, financiado: r.financiado,
    cuotaCapital, intereses: Math.round(r.c.intereses), seguro, administrativos, cuotaSocial,
    igr: Math.round(r.c.igr), otros: Math.round(r.c.otros), cuotaOtros, cuota, totalCredito: cuota * n };
}

/**
 * El monto máximo a prestar sobre un vehículo: el % financiable de su valor, con el tope de monto máximo,
 * redondeado HACIA ABAJO al paso de `redondeo` (así el máximo no deja leer el valor de InfoAuto con
 * precisión). 0 si no llega al mínimo.
 */
export function montoMaximo(valor, a) {
  const pct = Number(a.pct_financiable) || 0, paso = Math.max(1, Number(a.redondeo) || 1);
  let m = Math.floor((Number(valor) || 0) * pct / 100);
  if (Number(a.monto_maximo) > 0) m = Math.min(m, Number(a.monto_maximo));
  m = Math.floor(m / paso) * paso;
  return m >= (Number(a.monto_minimo) || 0) && m > 0 ? m : 0;
}

/** Tasa mensual de un préstamo: recibe `capital` y paga `cuotas` cuotas de `cuota` (TIR, por bisección). */
export function tasaInterna(capital, cuota, cuotas) {
  if (!(capital > 0) || !(cuota > 0) || !(cuotas >= 1) || cuota * cuotas <= capital) return 0;
  const va = (r) => (r === 0 ? cuota * cuotas : cuota * (1 - (1 + r) ** -cuotas) / r);
  let lo = 0, hi = 1;
  while (va(hi) > capital && hi < 64) hi *= 2;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (va(mid) > capital) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const pct = (x) => Math.round(x * 10000) / 100; // 0,123456 → 12,35 (%)

/**
 * Lo que se informa del crédito. TNA y TEA son las de la tasa de financiación; el CFT es la tasa efectiva
 * anual de lo que el comprador recibe (`capital`) contra todo lo que paga (cuota final × cuotas), es decir
 * con los gastos de inscripción, el seguro, los administrativos, la cuota social y el IGR. Sin IVA.
 */
export function tasasDelCredito(sim) {
  const i = sim.tasa / 100, r = tasaInterna(sim.capital, sim.cuota, sim.cuotas);
  return { tna: pct(i * 12), tea: pct((1 + i) ** 12 - 1), cft: pct((1 + r) ** 12 - 1) };
}

/** El año de modelo más viejo que se financia: el mayor entre `anio_minimo` y el de la antigüedad máxima (0: sin tope). */
export const anioMinimo = (a, anioActual) => Math.max(Number(a.anio_minimo) || 0, a.antiguedad_max == null ? 0 : anioActual - Number(a.antiguedad_max));

/**
 * La tasa mensual según el año del modelo: de `a.tasas` ([{desde, tasa}]), el tramo de mayor `desde` que no
 * supere el año; el 0 km cuenta como el año en curso. Sin tramo que alcance, `a.tasa_mensual`.
 */
export function tasaPara(anio, a, anioActual) {
  const y = anio === '0km' ? anioActual : Math.trunc(Number(anio));
  let mejor = null;
  for (const t of Array.isArray(a.tasas) ? a.tasas : []) {
    const desde = Math.trunc(Number(t?.desde)), tasa = Number(t?.tasa);
    if (!Number.isFinite(desde) || !(tasa >= 0) || desde > y) continue;
    if (!mejor || desde > mejor.desde) mejor = { desde, tasa };
  }
  return mejor ? mejor.tasa : Number(a.tasa_mensual);
}

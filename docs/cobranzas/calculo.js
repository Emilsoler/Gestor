// Las cuentas de la cobranza: liquidación de un deudor a una fecha, planes de pago, promesas y
// la situación de cada deudor. No toca la pantalla ni la red: la usan la app (app.js) y las pruebas.
//
// La liquidación sigue exactamente las mismas reglas que gestor.liquidacion_deudor (migración
// 0008), y devuelve lo mismo: las pruebas comparan las dos con muchos casos.
//   · Interés simple: tasa % mensual por cada 30 días, cuota por cuota desde su vencimiento, sobre
//     el capital que queda de esa cuota (como la planilla de Excel del estudio). Lo imputado a
//     capital cancela las cuotas en orden de vencimiento y, desde la fecha del pago, deja de
//     generar interés.
//   · Honorarios: hon_pct % sobre capital + intereses devengados.
//   · Gastos y honorarios fijos: su importe, si su fecha es hasta la de la liquidación.
//   · Los pagos posteriores a la fecha no cuentan. Todo en centavos, redondeado cuota por cuota.
//   · sistema: lo que daría el sistema de la Mutual (tasa_sistema % mensual capitalizable sobre el
//     saldo de cada cuota vencida), solo para comparar.

export const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const fechaDe = (t) => (typeof t === 'string' && ES_FECHA.test(t) ? t : null);
const utc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
/** Días de `a` a `b` (fechas AAAA-MM-DD). */
export const diasEntre = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
const isoUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
export const sumarDias = (iso, n) => isoUTC(utc(iso) + n * 864e5);
/** El mismo día, k meses después; si ese mes no lo tiene (31, 29 de febrero…), el último del mes. */
export function sumarMeses(iso, k) {
  const [y, m, d] = iso.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1 + k, 1));
  const ultimo = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, ultimo));
  return isoUTC(base.getTime());
}
export const CADAS = { mes: 'Mensual', quincena: 'Cada 15 días', semana: 'Semanal' };
export const sumarPeriodo = (iso, k, cada = 'mes') => (cada === 'quincena' ? sumarDias(iso, 15 * k) : cada === 'semana' ? sumarDias(iso, 7 * k) : sumarMeses(iso, k));

/** Un importe guardado, en centavos (como gestor.centavos: lo que no es un número no negativo cuenta cero). */
export function centavos(x) {
  if (typeof x === 'number' && Number.isFinite(x)) return Math.max(0, Math.round(x * 100));
  if (typeof x === 'string' && /^\s*[0-9]+(\.[0-9]+)?\s*$/.test(x)) return Math.round(Number(x) * 100);
  return 0;
}
const pesos = (c) => c / 100;
/** Redondeo de una división de enteros no negativos, la mitad hacia arriba (como round de Postgres). */
const dividir = (num, den) => (num * 2n + den) / (2n * den);
const entero = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const puntos = (tasa) => BigInt(Math.round((+tasa || 0) * 10000)); // % con cuatro decimales, como numeric(7,4)

/**
 * La liquidación de un deudor a la fecha `fecha` (AAAA-MM-DD).
 * opciones: { aVencer: incluir el capital de las cuotas que todavía no vencieron, tasaSistema: % de la Mutual }
 */
export function liquidar(d, fecha, { aVencer = false, tasaSistema = 9 } = {}) {
  const f = fecha;
  const tasa = +d.tasa || 0, hon = +d.hon_pct || 0;
  const qs = (d.cuotas || []).map((q, i) => ({ q, i, vto: fechaDe(q.vto), n: entero(q.n) }))
    .sort((a, b) => (a.vto === b.vto ? 0 : a.vto === null ? -1 : b.vto === null ? 1 : a.vto < b.vto ? -1 : 1)
      || (a.n === b.n ? 0 : a.n === null ? 1 : b.n === null ? -1 : a.n - b.n) || a.i - b.i)
    .map(({ q, vto, n }) => {
      const imp = centavos(q.importe), de = entero(q.de);
      return { id: q.id == null ? '' : String(q.id), n, de: de === 0 ? null : de, vto, doc: q.doc == null ? '' : String(q.doc), imp, rem: imp, t: vto, acc: 0 };
    });

  let sinCuotas = 0, pagInt = 0, pagHon = 0;
  const pagGasto = {};
  const pagos = (d.pagos || []).map((p, i) => ({ p, i, fecha: fechaDe(p.fecha) }))
    .filter((x) => x.fecha && x.fecha <= f)
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.i - b.i));
  for (const { p, fecha: pf } of pagos) {
    const imp = p.imp && typeof p.imp === 'object' && !Array.isArray(p.imp) ? p.imp : {};
    let resto = centavos(imp.capital);
    for (const c of qs) {
      if (resto <= 0) break;
      if (c.rem <= 0) continue;
      const a = Math.min(c.rem, resto);
      // Lo que corrió hasta el pago, con el capital de antes; desde el pago, con el nuevo.
      if (c.vto && pf > c.t) { c.acc += c.rem * diasEntre(c.t, pf); c.t = pf; }
      c.rem -= a; resto -= a;
    }
    sinCuotas += resto;
    pagInt += centavos(imp.intereses);
    pagHon += centavos(imp.honorarios);
    for (const [k, v] of Object.entries(imp)) if (!['capital', 'intereses', 'honorarios'].includes(k)) pagGasto[k] = (pagGasto[k] || 0) + centavos(v);
  }

  const ts = +tasaSistema || 0, tBp = puntos(tasa);
  let capDev = 0, capSaldo = 0, intDev = 0, aVenc = 0, anticipado = 0, vencidas = 0, diasMora = 0, sisCap = 0, sisTot = 0;
  const cuotas = qs.map((c) => {
    if (c.vto && f > c.t) c.acc += c.rem * diasEntre(c.t, f);
    const interes = Number(dividir(BigInt(c.acc) * tBp, 30000000n));
    const dias = c.vto && c.vto < f ? diasEntre(c.vto, f) : 0;
    const incluida = !c.vto || c.vto <= f || aVencer;
    intDev += interes;
    if (incluida) { capDev += c.imp; capSaldo += c.rem; } else { aVenc += c.rem; anticipado += c.imp - c.rem; }
    if ((!c.vto || c.vto <= f) && c.rem > 0) {
      vencidas++; diasMora = Math.max(diasMora, dias);
      sisCap += c.rem; sisTot += Math.round(c.rem * Math.pow(1 + ts / 100, dias / 30));
    }
    return { id: c.id, n: c.n, de: c.de, vto: c.vto, doc: c.doc, importe: pesos(c.imp), pagado: pesos(c.imp - c.rem), saldo: pesos(c.rem), dias, interes: pesos(interes), incluida };
  });

  const honDev = Number(dividir(BigInt(capDev + intDev) * puntos(hon), 1000000n));
  const rubros = [
    { id: 'capital', nombre: 'Capital', tipo: 'capital', devengado: pesos(capDev), pagado: pesos(capDev - capSaldo), saldo: pesos(capSaldo) },
    { id: 'intereses', nombre: 'Intereses', tipo: 'intereses', devengado: pesos(intDev), pagado: pesos(pagInt), saldo: pesos(intDev - pagInt) },
  ];
  let totDev = capDev + intDev, totPag = capDev - capSaldo + pagInt;
  if (hon > 0 || pagHon > 0) {
    rubros.push({ id: 'honorarios', nombre: 'Honorarios', tipo: 'honorarios', devengado: pesos(honDev), pagado: pesos(pagHon), saldo: pesos(honDev - pagHon) });
    totDev += honDev; totPag += pagHon;
  }
  for (const g of d.gastos || []) {
    const gf = fechaDe(g.fecha);
    if (gf && gf > f) continue;
    const id = g.id == null ? '' : String(g.id), monto = centavos(g.monto), pag = pagGasto[id] || 0;
    rubros.push({ id, nombre: String(g.concepto || '').trim() || 'Gasto', tipo: g.tipo === 'honorarios' ? 'honorarios' : 'gasto', devengado: pesos(monto), pagado: pesos(pag), saldo: pesos(monto - pag) });
    totDev += monto; totPag += pag;
  }

  return {
    fecha: f, tasa, hon_pct: hon, a_vencer: !!aVencer, cuotas, rubros,
    total: { devengado: pesos(totDev), pagado: pesos(totPag), saldo: pesos(totDev - totPag) },
    capital_a_vencer: pesos(aVenc), capital_anticipado: pesos(anticipado), capital_sin_cuotas: pesos(sinCuotas),
    vencidas, dias_mora: diasMora,
    sistema: { tasa: ts, capital: pesos(sisCap), intereses: pesos(sisTot - sisCap), total: pesos(sisTot) },
  };
}

/** Lo que suma un pago (todo lo que imputa). */
export const totalPago = (p) => pesos(Object.values(p?.imp || {}).reduce((a, v) => a + centavos(v), 0));

// ───────────────────────── Planes de pago ─────────────────────────

/**
 * Arma las cuotas de un plan. Importes en pesos; las cuotas van en pesos enteros (el total se
 * redondea al peso) y la última absorbe el redondeo. Con tasa (% mensual) es sistema francés; sin tasa, cuotas iguales.
 *   { deuda, quita, anticipo, n, tasa, primerVto, cada }
 */
export function armarPlan({ deuda = 0, quita = 0, anticipo = 0, n = 1, tasa = 0, primerVto, cada = 'mes' }) {
  const cant = Math.max(1, Math.min(120, Math.round(+n || 1)));
  const financiado = Math.max(0, centavos(+deuda || 0) - centavos(+quita || 0) - centavos(+anticipo || 0));
  const i = (+tasa || 0) / 100 * (cada === 'quincena' ? 0.5 : cada === 'semana' ? 7 / 30 : 1);
  const exacta = i > 0 ? financiado * i / (1 - Math.pow(1 + i, -cant)) : financiado / cant;
  const total = Math.round((i > 0 ? exacta * cant : financiado) / 100) * 100; // en pesos enteros: los centavos no se cobran en cuotas
  const redonda = Math.round(exacta / 100) * 100;
  const cuotas = Array.from({ length: cant }, (_, k) => ({
    n: k + 1,
    vto: primerVto && ES_FECHA.test(primerVto) ? sumarPeriodo(primerVto, k, cada) : '',
    importe: pesos(k < cant - 1 ? redonda : Math.max(0, total - redonda * (cant - 1))),
  }));
  return { financiado: pesos(financiado), cuota: pesos(redonda), total: pesos(total), intereses: pesos(total - financiado), cuotas };
}

/**
 * Cómo va un plan: lo pagado (los pagos que lo nombran) se aplica en orden al anticipo y a las
 * cuotas. Una cuota está atrasada si pasaron más de `gracia` días de su vencimiento sin cubrirla.
 */
export function estadoPlan(plan, pagos, hoy, gracia = 5, caducidadDef = 2) {
  const items = [];
  if (centavos(plan.anticipo) > 0) items.push({ n: 0, vto: fechaDe(plan.anticipo_vto) || fechaDe(plan.fecha) || hoy, importe: centavos(plan.anticipo) });
  for (const q of plan.cuotas || []) items.push({ n: entero(q.n) ?? items.length + 1, vto: fechaDe(q.vto) || '', importe: centavos(q.importe) });
  const delPlan = (pagos || []).filter((p) => p.plan && p.plan === plan.id);
  let resto = delPlan.reduce((a, p) => a + centavos(totalPago(p)), 0);
  const pagado = resto;
  let impagas = 0, atrasado = 0, proxima = null;
  const detalle = items.map((it) => {
    const cubierto = Math.min(it.importe, Math.max(0, resto));
    resto -= cubierto;
    const falta = it.importe - cubierto;
    const tarde = falta > 0 && !!it.vto && diasEntre(it.vto, hoy) > gracia;
    if (tarde) { impagas++; atrasado += falta; }
    if (falta > 0 && !proxima) proxima = { n: it.n, vto: it.vto, importe: pesos(falta) };
    return { n: it.n, vto: it.vto, importe: pesos(it.importe), cubierto: pesos(cubierto), estado: falta === 0 ? 'pagada' : cubierto > 0 ? 'parcial' : 'pendiente', atrasada: tarde };
  });
  const total = items.reduce((a, it) => a + it.importe, 0);
  const caducidad = Math.max(1, entero(plan.caducidad) || caducidadDef);
  const ultimoPago = delPlan.map((p) => fechaDe(p.fecha)).filter(Boolean).sort().pop() || '';
  let situacion = plan.estado || 'vigente';
  if (situacion === 'vigente') situacion = pagado >= total ? 'cumplido' : impagas >= caducidad ? 'para-caer' : impagas > 0 ? 'atrasado' : 'al-dia';
  return {
    items: detalle, total: pesos(total), pagado: pesos(pagado), saldo: pesos(Math.max(0, total - pagado)),
    impagas, atrasado: pesos(atrasado), proxima, caducidad, situacion, ultimoPago,
    pagadas: detalle.filter((x) => x.estado === 'pagada').length,
  };
}
export const planVigente = (d) => (d.planes || []).find((p) => p.estado === 'vigente') || null;

// ───────────────────────── Promesas de pago ─────────────────────────

/**
 * La última promesa de pago anotada y cómo está: 'cumplida' (hubo pagos desde que se anotó y
 * hasta su fecha + gracia que la cubren), 'pendiente' (todavía no llegó la fecha), 'incumplida'
 * (pasó la fecha) o 'seguida' (incumplida, pero ya hubo otra gestión después: no se vuelve a avisar).
 */
export function promesa(d, hoy, gracia = 5) {
  const gs = d.gestiones || [];
  let idx = -1;
  for (let i = gs.length - 1; i >= 0; i--) if (fechaDe(gs[i].promesa_fecha)) { idx = i; break; }
  if (idx < 0) return null;
  const g = gs[idx], pf = g.promesa_fecha, desde = fechaDe(g.fecha) || pf, monto = centavos(g.promesa_monto);
  const hasta = sumarDias(pf, gracia);
  // Cuentan los pagos posteriores a la promesa: del mismo día, solo si se registraron después de anotarla.
  const despues = (p) => p.fecha > desde || (p.fecha === desde && (!p.creado || !g.creado || p.creado > g.creado));
  const pagado = (d.pagos || []).filter((p) => fechaDe(p.fecha) && despues(p) && p.fecha <= hasta).reduce((a, p) => a + centavos(totalPago(p)), 0);
  let estado;
  if (pagado > 0 && pagado >= monto) estado = 'cumplida';
  else if (hoy <= pf) estado = 'pendiente';
  else estado = gs.slice(idx + 1).some((x) => fechaDe(x.fecha) && x.fecha > pf) ? 'seguida' : 'incumplida';
  return { fecha: pf, monto: pesos(monto), anotada: desde, texto: g.texto || '', estado, hoy: pf === hoy };
}

// ───────────────────────── Situación del deudor ─────────────────────────

export const TRAMOS = [
  { id: 't30', desde: 0, hasta: 30, nombre: 'Hasta 30 días' },
  { id: 't60', desde: 31, hasta: 60, nombre: '31 a 60 días' },
  { id: 't90', desde: 61, hasta: 90, nombre: '61 a 90 días' },
  { id: 't180', desde: 91, hasta: 180, nombre: '91 a 180 días' },
  { id: 'tmas', desde: 181, hasta: Infinity, nombre: 'Más de 180 días' },
];
export const tramoDe = (dias) => TRAMOS.find((t) => dias >= t.desde && dias <= t.hasta) || TRAMOS[TRAMOS.length - 1];

/**
 * Todo lo que la app necesita saber de un deudor a la fecha `hoy`: su liquidación, su plan
 * vigente, la promesa de pago y la situación que se muestra (clave + texto).
 */
export function resumen(d, hoy, aj = {}) {
  const liq = liquidar(d, hoy, { tasaSistema: aj.tasa_sistema ?? 9 });
  const plan = planVigente(d);
  const ep = plan ? estadoPlan(plan, d.pagos, hoy, aj.gracia ?? 5, aj.caducidad ?? 2) : null;
  const prom = promesa(d, hoy, aj.gracia ?? 5);
  const saldo = ep ? ep.saldo : Math.max(0, liq.total.saldo);
  const ultimo = (d.pagos || []).filter((p) => fechaDe(p.fecha)).sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0)).pop() || null;
  let clave, texto;
  if (d.estado === 'Cancelado') { clave = 'cancelado'; texto = 'Cancelado'; }
  else if (d.estado === 'Incobrable') { clave = 'incobrable'; texto = 'Incobrable'; }
  else if (d.estado === 'Archivado') { clave = 'archivado'; texto = 'Archivado'; }
  else if (ep) {
    clave = { 'al-dia': 'plan', atrasado: 'plan-atrasado', 'para-caer': 'plan-caer', cumplido: 'plan-cumplido' }[ep.situacion] || 'plan';
    texto = { plan: 'Plan al día', 'plan-atrasado': `Plan atrasado · ${ep.impagas} ${ep.impagas === 1 ? 'cuota' : 'cuotas'}`, 'plan-caer': 'Plan para caer', 'plan-cumplido': 'Plan cumplido' }[clave];
  } else if (d.estado === 'En juicio') { clave = 'juicio'; texto = 'En juicio'; }
  else if (liq.vencidas > 0) { clave = 'mora'; texto = `En mora · ${liq.dias_mora} ${liq.dias_mora === 1 ? 'día' : 'días'}`; }
  else { clave = 'al-dia'; texto = 'Sin cuotas vencidas'; }
  const activo = !['cancelado', 'incobrable', 'archivado'].includes(clave);
  return { liq, plan, ep, prom, saldo, ultimo, clave, texto, activo };
}

// ───────────────────────── Textos ─────────────────────────

const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'do', 'dos', 'das', 'van', 'von', 'di']);
const SIGLAS = new Set(['sa', 'sas', 'srl', 'sh', 'saci', 'sacif', 'sca', 'scs', 'se']);
/** "GOMEZ ANA DE LAS NIEVES" → "Gomez Ana de las Nieves" (las siglas de sociedades quedan en mayúscula). */
export function nombrePropio(s) {
  return String(s || '').toLowerCase().split(/(\s+|-)/).map((w, i) => {
    if (!w.trim() || w === '-') return w;
    const limpio = w.replace(/\./g, '');
    if (SIGLAS.has(limpio)) return w.toUpperCase();
    if (i > 0 && PARTICULAS.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}

const lista = (xs) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' y ' + xs[xs.length - 1]);
/** Números de cuota en tramos: [12, 13, 14, 16] → ["12 a 14", "16"]. */
function tramosDe(ns) {
  const out = []; let ini = null, ant = null;
  for (const n of [...ns].sort((a, b) => a - b)) {
    if (ini === null) { ini = ant = n; continue; }
    if (n === ant + 1) { ant = n; continue; }
    out.push(ini === ant ? `${ini}` : ant === ini + 1 ? `${ini}, ${ant}` : `${ini} a ${ant}`); ini = ant = n;
  }
  if (ini !== null) out.push(ini === ant ? `${ini}` : ant === ini + 1 ? `${ini}, ${ant}` : `${ini} a ${ant}`);
  return out.flatMap((t) => (t.includes(', ') ? t.split(', ') : [t]));
}
/**
 * Las cuotas vencidas e impagas de una liquidación, en palabras:
 * "las cuotas 21 a 24 de 24", "la cuota 13 de 24", "el saldo de la cuota 11 y las cuotas 12 y 13 de 24".
 */
export function detalleCuotas(liq) {
  const venc = liq.cuotas.filter((c) => c.saldo > 0 && (!c.vto || c.vto <= liq.fecha));
  const saldos = venc.filter((c) => c.de == null && c.n != null), comunes = venc.filter((c) => c.de != null && c.n != null);
  const partes = [];
  if (saldos.length) partes.push(saldos.length === 1 ? `el saldo de la cuota ${saldos[0].n}` : `el saldo de las cuotas ${lista(tramosDe(saldos.map((c) => c.n)))}`);
  if (comunes.length) {
    const des = [...new Set(comunes.map((c) => c.de))], de = des.length === 1 ? ` de ${des[0]}` : '';
    partes.push(comunes.length === 1 ? `la cuota ${comunes[0].n}${de}` : `las cuotas ${lista(tramosDe(comunes.map((c) => c.n)))}${de}`);
  }
  const sinNumero = venc.filter((c) => c.n == null).length;
  if (sinNumero) partes.push(sinNumero === 1 ? 'un importe vencido' : `${sinNumero} importes vencidos`);
  return lista(partes) || 'importes vencidos';
}
/**
 * Las mismas cuotas en un solo tramo, para escribir después de "el saldo de": el resto de una cuota
 * pagada en parte va con las demás ("las cuotas 12 a 18 de 24", "la cuota 18 de 24"). Si no, el
 * mensaje diría "el saldo de el saldo de la cuota 12…".
 */
export function cuotasImpagas(liq) {
  const venc = liq.cuotas.filter((c) => c.saldo > 0 && (!c.vto || c.vto <= liq.fecha));
  const ns = [...new Set(venc.filter((c) => c.n != null).map((c) => +c.n))];
  const partes = [];
  if (ns.length) {
    const des = [...new Set(venc.filter((c) => c.n != null && c.de).map((c) => c.de))], de = des.length === 1 ? ` de ${des[0]}` : '';
    partes.push(ns.length === 1 ? `la cuota ${ns[0]}${de}` : `las cuotas ${lista(tramosDe(ns))}${de}`);
  }
  const sinNumero = venc.filter((c) => c.n == null).length;
  if (sinNumero) partes.push(sinNumero === 1 ? 'un importe vencido' : `${sinNumero} importes vencidos`);
  return lista(partes) || 'importes vencidos';
}

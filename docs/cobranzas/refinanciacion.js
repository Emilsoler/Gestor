// "Estado de Deuda y Refinanciación" (vista Créditos): lo que debe un deudor a una fecha y cómo
// quedaría refinanciado. Arma las cuentas y el HTML del resultado (todo dato pasa por esc); no toca
// la pantalla ni la red, y no guarda nada: es una simulación para hablar con el deudor.
//
// Es la planilla de Excel del estudio ("CALCULO_INTERESES"), con las mismas cuentas que ya usa la app.
// Los datos se pueden cargar a mano (cuota, cantidad, vencimiento de la cuota 1, desde cuándo está en mora, tasa, honorarios,
// pagos parciales…) o tomar de un deudor de la app; en los dos casos la cuenta es la misma:
//   · la deuda vencida sale de la liquidación (calculo.js: interés simple por cuota desde su
//     vencimiento, honorarios sobre capital + intereses, gastos cargados y pagos ya imputados);
//   · a eso se le suman los gastos y honorarios de juicio que todavía no estén cargados, y —si se
//     quiere— las cuotas a vencer menos los intereses a vencer;
//   · se resta la entrega inicial y el resto es el SALDO A FINANCIAR, que se divide en cuotas con la
//     tasa de financiación (la misma de los créditos prendarios, editable): armarPlan, cuota fija.
import { liquidar, armarPlan, sumarMeses, detalleCuotas, ES_FECHA, CADAS } from './calculo.js';
import { esc, plata, fmt } from './textos.js';
import { importe, r2 } from '../liquidacion.js';
import { TASA_MENSUAL, CUOTAS_MAX } from './vehiculos.js';

/**
 * Lo que se escribe en la pantalla (textos, como los escribe la persona). `tasaMora` es el interés
 * moratorio mensual de arranque (el de los ajustes de la app); los honorarios arrancan en 0 % (se completan solo si corresponden).
 */
export const nuevaRefi = (tasaMora = '5') => ({
  fuente: 'mano', // 'mano': datos cargados a mano · 'deudor': los de un deudor de la app (`id`)
  id: '', q: '', fecha: '',
  // A mano: el crédito (la cuota, cuántas son y cuándo vence la 1ª), desde cuándo está en mora (`moraTipo`:
  // 'cuota' = N° de cuota o 'fecha'; las anteriores se toman como pagadas), otras cuotas ya pagadas, el interés
  // y los honorarios, y los pagos parciales ({ fecha, monto, imp: 'capital' | 'intereses' | 'honorarios' }).
  cuota: '', cantCuotas: '', vto1: '', moraTipo: 'cuota', mora: '', pagadas: '', tasaMora: String(tasaMora), hon: '0', pagos: [],
  justicia: '', martillero: '', abogado: '', otros: '', // gastos y honorarios de juicio (los de un deudor ya cargados en su ficha se suman aparte)
  plan: false, // el plan de refinanciación no se arma solo: se abre con un botón
  aVencer: false, iVencer: '', entrega: '',
  cuotas: '12', tasa: String(TASA_MENSUAL), cada: 'mes', primerVto: '',
});

// ───────────────────────── Casos guardados ─────────────────────────
// Un caso es el formulario tal cual (sin las cuentas, que se rehacen al abrirlo). Al guardar, la fecha de
// cálculo queda escrita: un caso es una foto de la negociación de ese día, y se cambia desde su campo.

const TEXTOS = ['id', 'fecha', 'cuota', 'cantCuotas', 'vto1', 'mora', 'pagadas', 'tasaMora', 'hon', 'justicia', 'martillero', 'abogado', 'otros', 'iVencer', 'entrega', 'cuotas', 'tasa', 'primerVto'];
const IMPUTACIONES = ['capital', 'intereses', 'honorarios'];

/** Lo que se guarda de un caso: el formulario sin el buscador, con la fecha de cálculo explícita. */
export function datosCaso(R, hoy) {
  const { q, ...resto } = structuredClone(R);
  return { ...resto, fecha: R.fecha || hoy };
}

/** Arma el formulario desde lo guardado. Lo que falte o venga raro queda como en un formulario nuevo. */
export function restaurarCaso(datos, tasaMora = '5') {
  const base = nuevaRefi(tasaMora), d = datos && typeof datos === 'object' && !Array.isArray(datos) ? datos : {};
  for (const k of TEXTOS) if (typeof d[k] === 'string' || typeof d[k] === 'number') base[k] = String(d[k]);
  base.fuente = d.fuente === 'deudor' && base.id ? 'deudor' : 'mano';
  base.aVencer = d.aVencer === true;
  base.plan = d.plan === true;
  base.moraTipo = d.moraTipo === 'fecha' ? 'fecha' : 'cuota';
  base.cada = Object.hasOwn(CADAS, d.cada) ? d.cada : base.cada;
  base.pagos = (Array.isArray(d.pagos) ? d.pagos : []).filter((p) => p && typeof p === 'object').slice(0, 100).map((p) => ({
    fecha: typeof p.fecha === 'string' ? p.fecha : '',
    monto: typeof p.monto === 'string' || typeof p.monto === 'number' ? String(p.monto) : '',
    imp: IMPUTACIONES.includes(p.imp) ? p.imp : 'capital',
  }));
  return base;
}

const FRECUENCIA = { mes: 'mensuales', quincena: 'cada 15 días', semana: 'semanales' };

/** "5-24, 30" o "1 a 4 y 7" → { 5…24, 30 }: los números de cuota que ya se pagaron. */
export function cuotasPagadas(texto) {
  const out = new Set();
  const t = String(texto ?? '');
  for (const m of t.matchAll(/(\d+)\s*(?:-|–|a)\s*(\d+)|(\d+)/g)) {
    if (m[3] != null) { out.add(+m[3]); continue; }
    const a = +m[1], b = +m[2];
    for (let k = Math.min(a, b); k <= Math.max(a, b) && k <= 1000; k++) out.add(k);
  }
  return out;
}

/** Un deudor armado con lo escrito a mano: las cuotas que faltan pagar (las pagadas no se cargan) y los pagos parciales. */
export function deudorManual(R) {
  const cuota = Math.max(0, importe(R.cuota)), cant = Math.max(0, Math.min(CUOTAS_MAX, parseInt(R.cantCuotas, 10) || 0));
  const pagadas = cuotasPagadas(R.pagadas);
  // En mora desde una cuota o una fecha: las anteriores se toman como pagadas. Vacío: desde la cuota 1.
  const moraN = R.moraTipo !== 'fecha' ? parseInt(R.mora, 10) || 0 : 0;
  const moraFecha = R.moraTipo === 'fecha' && ES_FECHA.test(R.mora || '') ? R.mora : '';
  const cuotas = [];
  if (cuota > 0 && ES_FECHA.test(R.vto1 || '')) {
    for (let k = 0; k < cant; k++) {
      const vto = sumarMeses(R.vto1, k);
      if (pagadas.has(k + 1) || k + 1 < moraN || (moraFecha && vto < moraFecha)) continue;
      cuotas.push({ id: 'c' + (k + 1), n: k + 1, de: cant, vto, importe: cuota });
    }
  }
  const pagos = (R.pagos || []).map((p, i) => ({ id: 'p' + i, fecha: p.fecha, monto: Math.max(0, importe(p.monto)), imp: ['intereses', 'honorarios'].includes(p.imp) ? p.imp : 'capital' }))
    .filter((p) => ES_FECHA.test(p.fecha || '') && p.monto > 0).map((p) => ({ id: p.id, fecha: p.fecha, imp: { [p.imp]: p.monto } }));
  return { tasa: Math.max(0, importe(R.tasaMora)), hon_pct: Math.max(0, importe(R.hon)), cuotas, pagos, gastos: [], planes: [] };
}

/**
 * Las cuentas de un deudor `d` según lo escrito en `R`, a la fecha `dia` (hoy) si no se eligió otra.
 * Sin deudor (`d` null) usa lo escrito a mano. Devuelve todo lo que la pantalla muestra.
 */
export function estadoRefi(d, R, dia) {
  const manual = !d;
  if (manual) d = deudorManual(R);
  const fecha = ES_FECHA.test(R.fecha || '') ? R.fecha : dia;
  const liq = liquidar(d, fecha);
  const extras = [['Tasa de justicia', R.justicia], ['Honorarios del martillero', R.martillero], ['Honorarios del abogado', R.abogado], ['Otros gastos', R.otros]]
    .map(([concepto, v]) => ({ concepto, monto: Math.max(0, importe(v)) })).filter((x) => x.monto > 0);
  // Lo que es del plan (cuotas a vencer, intereses a vencer y entrega) cuenta solo si se abrió el plan.
  const conPlan = R.plan === true;
  const aVencer = conPlan && R.aVencer ? liq.capital_a_vencer : 0;
  const iVencer = conPlan && R.aVencer ? Math.max(0, importe(R.iVencer)) : 0;
  const deuda = Math.max(0, r2(liq.total.saldo + extras.reduce((a, x) => a + x.monto, 0) + aVencer - iVencer));
  const entrega = conPlan ? Math.max(0, importe(R.entrega)) : 0;
  const n = Math.max(1, Math.min(CUOTAS_MAX, parseInt(R.cuotas, 10) || 1));
  const tasa = String(R.tasa ?? '').trim() === '' ? 0 : Math.max(0, importe(R.tasa));
  const cada = CADAS[R.cada] ? R.cada : 'mes';
  const primerVto = ES_FECHA.test(R.primerVto || '') ? R.primerVto : sumarMeses(fecha, 1);
  const plan = armarPlan({ deuda, anticipo: entrega, n, tasa, primerVto, cada });
  return { manual, conPlan, pagosCargados: !!d.pagos?.length, fecha, liq, extras, aVencer, iVencer, deuda, entrega, n, tasa, cada, primerVto, plan, sobra: entrega > deuda };
}

// Devengado y pagado se ven en la computadora; en el celular queda el saldo (las columnas `rf-aux` se ocultan).
const fila = (t, dev, pag, saldo, clase = '') => `<tr${clase ? ` class="${clase}"` : ''}><td>${esc(t)}</td><td class="num mono rf-aux">${dev === '' ? '' : esc(plata(dev))}</td><td class="num mono rf-aux">${pag ? esc(plata(pag)) : ''}</td><td class="num mono">${esc(plata(saldo))}</td></tr>`;

const sinDatos = (e) => e.manual && !e.liq.cuotas.length && !e.extras.length && !e.pagosCargados;

/** Estado de deuda a la fecha, con el detalle cuota por cuota. */
export function htmlEstadoRefi(e) {
  const { liq } = e;
  const rubros = liq.rubros.filter((x) => x.devengado || x.pagado || x.saldo);
  const filas = rubros.map((x) => fila(x.tipo === 'intereses' ? `Intereses moratorios (${+liq.tasa}% mensual)` : x.tipo === 'honorarios' && x.id === 'honorarios' ? `Honorarios (${+liq.hon_pct}%)` : x.nombre, x.devengado, x.pagado, x.saldo)).join('')
    + e.extras.map((x) => fila(x.concepto, x.monto, 0, x.monto)).join('')
    + (e.aVencer ? fila('Cuotas a vencer', e.aVencer, 0, e.aVencer) : '')
    + (e.iVencer ? fila('(−) Intereses a vencer', '', 0, -e.iVencer) : '');
  const vencidas = liq.vencidas
    ? `${liq.vencidas === 1 ? '1 cuota vencida' : liq.vencidas + ' cuotas vencidas'}: ${esc(detalleCuotas(liq))}. Mayor atraso: ${liq.dias_mora} ${liq.dias_mora === 1 ? 'día' : 'días'}.`
    : 'No tiene cuotas vencidas a esta fecha.';
  // Como la planilla: una fila por cuota que falta pagar, con sus días de mora y su interés.
  const pend = liq.cuotas.filter((c) => c.saldo > 0);
  const porCuota = pend.length ? `<details class="rf-cuotas"${pend.length <= 12 ? ' open' : ''}><summary>Cuotas que faltan pagar <b class="mono">${pend.length}</b></summary>
    <div class="scrollx"><table class="tabla sim-tabla"><thead><tr><th>N°</th><th>Vence</th><th class="num">Saldo</th><th class="num rf-aux">Días de mora</th><th class="num">Interés</th></tr></thead>
    <tbody>${pend.map((c) => `<tr><td class="mono">${c.n ?? ''}</td><td class="mono">${esc(fmt(c.vto))}</td><td class="num mono">${esc(plata(c.saldo))}</td><td class="num mono rf-aux">${c.dias || ''}</td><td class="num mono">${c.interes ? esc(plata(c.interes)) : '—'}</td></tr>`).join('')}</tbody></table></div></details>` : '';
  if (sinDatos(e)) return `<p class="hint m0">Completá la cuota, cuántas son y cuándo vence la primera (o algún gasto) para ver la deuda.</p>`;
  return `<div class="sim-cuadro"><h4>Estado de deuda al ${esc(fmt(e.fecha))}</h4>
    <p class="hint m0">${vencidas}</p>
    <div class="scrollx"><table class="tabla sim-tabla"><thead><tr><th>Concepto</th><th class="num rf-aux">Devengado</th><th class="num rf-aux">Pagado</th><th class="num">Saldo</th></tr></thead>
      <tbody>${filas || '<tr><td colspan="2" class="hint">Sin importes.</td></tr>'}${fila(e.conPlan ? 'Deuda a refinanciar' : 'Total adeudado', '', 0, e.deuda, 'fuerte')}</tbody></table></div>${porCuota}</div>`;
}

/** La refinanciación: cuánto se financia, la cuota y el cronograma. Solo tiene sentido con el plan abierto. */
export function htmlPlanRefi(e) {
  const { plan } = e;
  if (sinDatos(e)) return '';
  if (!(e.deuda > 0)) return `<p class="hint m0">No hay deuda para refinanciar a esta fecha.</p>`;
  const entrega = e.entrega ? `<div><dt>(−) Entrega inicial</dt><dd>${esc(plata(e.entrega))}</dd></div>` : '';
  const cuotas = plan.cuotas;
  const iguales = cuotas.every((q) => q.importe === cuotas[0].importe);
  const refi = plan.financiado > 0
    ? `<div class="sim-cuadro"><h4>Refinanciación</h4>
      <dl class="cifras grandes sim-cifras"><div><dt>Deuda a refinanciar</dt><dd>${esc(plata(e.deuda))}</dd></div>${entrega}<div><dt>Saldo a financiar</dt><dd>${esc(plata(plan.financiado))}</dd></div></dl>
      <div class="sim-final"><span>${e.n === 1 ? 'Una cuota de' : `${e.n} cuotas ${FRECUENCIA[e.cada]} de`}</span><b class="mono">${esc(plata(plan.cuota))}</b></div>
      <p class="hint m0">Interés de la financiación ${esc(plata(plan.intereses))} (${e.tasa}% mensual sobre saldo). Total a pagar${e.entrega ? ' en cuotas' : ''}: <b class="mono">${esc(plata(plan.total))}</b>${e.entrega ? `, más la entrega de ${esc(plata(e.entrega))}` : ''}.${iguales ? '' : ' La última cuota ajusta el redondeo.'}</p>
      <div class="scrollx"><table class="tabla sim-tabla"><thead><tr><th>Cuota</th><th>Vence</th><th class="num">Importe</th></tr></thead><tbody>${cuotas.map((q) => `<tr><td>${q.n}</td><td class="mono">${esc(fmt(q.vto))}</td><td class="num mono">${esc(plata(q.importe))}</td></tr>`).join('')}</tbody></table></div></div>`
    : `<div class="sim-cuadro"><h4>Refinanciación</h4><p class="m0"><b>La entrega inicial cubre toda la deuda: no queda nada para financiar.</b></p></div>`;
  return `${refi}
    <p class="hint m0">Simulación con las cuentas de la planilla del estudio: interés simple por cuota, honorarios sobre capital e intereses y cuotas fijas sobre saldo. No es una oferta.</p>`;
}

/** Todo junto: el estado de deuda y, si el plan está abierto, la refinanciación. */
export function htmlRefi(e) {
  return `${htmlEstadoRefi(e)}${e.conPlan ? htmlPlanRefi(e) : ''}`;
}

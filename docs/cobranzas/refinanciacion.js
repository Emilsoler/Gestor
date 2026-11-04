// "Estado de Deuda y Refinanciación" (vista Créditos): lo que debe un deudor a una fecha y cómo
// quedaría refinanciado. Arma las cuentas y el HTML del resultado (todo dato pasa por esc); no toca
// la pantalla ni la red, y no guarda nada: es una simulación para hablar con el deudor.
//
// Es la planilla de Excel del estudio ("CALCULO_INTERESES"), con las mismas cuentas que ya usa la app:
//   · la deuda vencida sale de la liquidación del deudor (calculo.js: interés simple por cuota desde su
//     vencimiento, honorarios sobre capital + intereses, gastos cargados y pagos ya imputados);
//   · a eso se le suman los gastos y honorarios de juicio que todavía no estén cargados, y —si se
//     quiere— las cuotas a vencer menos los intereses a vencer;
//   · se resta la entrega inicial y el resto es el SALDO A FINANCIAR, que se divide en cuotas con la
//     tasa de financiación (la misma de los créditos prendarios, editable): armarPlan, cuota fija.
import { liquidar, armarPlan, sumarMeses, detalleCuotas, ES_FECHA, CADAS } from './calculo.js';
import { esc, plata, fmt } from './textos.js';
import { importe, r2 } from '../liquidacion.js';
import { TASA_MENSUAL, CUOTAS_MAX } from './vehiculos.js';

/** Lo que se escribe en la pantalla (textos, como los escribe la persona). */
export const nuevaRefi = () => ({
  id: '', q: '', fecha: '',
  justicia: '', martillero: '', abogado: '', // gastos y honorarios de juicio que no están cargados en la ficha
  aVencer: false, iVencer: '', entrega: '',
  cuotas: '12', tasa: String(TASA_MENSUAL), cada: 'mes', primerVto: '',
});

const FRECUENCIA = { mes: 'mensuales', quincena: 'cada 15 días', semana: 'semanales' };

/**
 * Las cuentas de un deudor `d` según lo escrito en `R`, a la fecha `dia` (hoy) si no se eligió otra.
 * Devuelve todo lo que la pantalla muestra, o null si no hay deudor.
 */
export function estadoRefi(d, R, dia) {
  if (!d) return null;
  const fecha = ES_FECHA.test(R.fecha || '') ? R.fecha : dia;
  const liq = liquidar(d, fecha);
  const extras = [['Tasa de justicia', R.justicia], ['Honorarios del martillero', R.martillero], ['Honorarios del abogado', R.abogado]]
    .map(([concepto, v]) => ({ concepto, monto: Math.max(0, importe(v)) })).filter((x) => x.monto > 0);
  const aVencer = R.aVencer ? liq.capital_a_vencer : 0;
  const iVencer = R.aVencer ? Math.max(0, importe(R.iVencer)) : 0;
  const deuda = Math.max(0, r2(liq.total.saldo + extras.reduce((a, x) => a + x.monto, 0) + aVencer - iVencer));
  const entrega = Math.max(0, importe(R.entrega));
  const n = Math.max(1, Math.min(CUOTAS_MAX, parseInt(R.cuotas, 10) || 1));
  const tasa = String(R.tasa ?? '').trim() === '' ? 0 : Math.max(0, importe(R.tasa));
  const cada = CADAS[R.cada] ? R.cada : 'mes';
  const primerVto = ES_FECHA.test(R.primerVto || '') ? R.primerVto : sumarMeses(fecha, 1);
  const plan = armarPlan({ deuda, anticipo: entrega, n, tasa, primerVto, cada });
  return { fecha, liq, extras, aVencer, iVencer, deuda, entrega, n, tasa, cada, primerVto, plan, sobra: entrega > deuda };
}

// Devengado y pagado se ven en la computadora; en el celular queda el saldo (las columnas `rf-aux` se ocultan).
const fila = (t, dev, pag, saldo, clase = '') => `<tr${clase ? ` class="${clase}"` : ''}><td>${esc(t)}</td><td class="num mono rf-aux">${dev === '' ? '' : esc(plata(dev))}</td><td class="num mono rf-aux">${pag ? esc(plata(pag)) : ''}</td><td class="num mono">${esc(plata(saldo))}</td></tr>`;

/** El resultado: estado de deuda, refinanciación y cronograma. */
export function htmlRefi(e) {
  const { liq, plan } = e;
  const rubros = liq.rubros.filter((x) => x.devengado || x.pagado || x.saldo);
  const filas = rubros.map((x) => fila(x.tipo === 'intereses' ? `Intereses moratorios (${+liq.tasa}% mensual)` : x.tipo === 'honorarios' && x.id === 'honorarios' ? `Honorarios (${+liq.hon_pct}%)` : x.nombre, x.devengado, x.pagado, x.saldo)).join('')
    + e.extras.map((x) => fila(x.concepto, x.monto, 0, x.monto)).join('')
    + (e.aVencer ? fila('Cuotas a vencer', e.aVencer, 0, e.aVencer) : '')
    + (e.iVencer ? fila('(−) Intereses a vencer', '', 0, -e.iVencer) : '');
  const vencidas = liq.vencidas
    ? `${liq.vencidas === 1 ? '1 cuota vencida' : liq.vencidas + ' cuotas vencidas'}: ${esc(detalleCuotas(liq))}. Mayor atraso: ${liq.dias_mora} ${liq.dias_mora === 1 ? 'día' : 'días'}.`
    : 'No tiene cuotas vencidas a esta fecha.';
  const estado = `<div class="sim-cuadro"><h4>1 · Estado de deuda al ${esc(fmt(e.fecha))}</h4>
    <p class="hint m0">${vencidas}</p>
    <div class="scrollx"><table class="tabla sim-tabla"><thead><tr><th>Concepto</th><th class="num rf-aux">Devengado</th><th class="num rf-aux">Pagado</th><th class="num">Saldo</th></tr></thead>
      <tbody>${filas || '<tr><td colspan="2" class="hint">Sin importes.</td></tr>'}${fila('Deuda a refinanciar', '', 0, e.deuda, 'fuerte')}</tbody></table></div></div>`;

  if (!(e.deuda > 0)) return `${estado}<p class="hint m0">No hay deuda para refinanciar a esta fecha.</p>`;
  const entrega = e.entrega ? `<div><dt>(−) Entrega inicial</dt><dd>${esc(plata(e.entrega))}</dd></div>` : '';
  const cuotas = plan.cuotas;
  const iguales = cuotas.every((q) => q.importe === cuotas[0].importe);
  const refi = plan.financiado > 0
    ? `<div class="sim-cuadro"><h4>2 · Refinanciación</h4>
      <dl class="cifras grandes sim-cifras"><div><dt>Deuda a refinanciar</dt><dd>${esc(plata(e.deuda))}</dd></div>${entrega}<div><dt>Saldo a financiar</dt><dd>${esc(plata(plan.financiado))}</dd></div></dl>
      <div class="sim-final"><span>${e.n === 1 ? 'Una cuota de' : `${e.n} cuotas ${FRECUENCIA[e.cada]} de`}</span><b class="mono">${esc(plata(plan.cuota))}</b></div>
      <p class="hint m0">Interés de la financiación ${esc(plata(plan.intereses))} (${e.tasa}% mensual sobre saldo). Total a pagar${e.entrega ? ' en cuotas' : ''}: <b class="mono">${esc(plata(plan.total))}</b>${e.entrega ? `, más la entrega de ${esc(plata(e.entrega))}` : ''}.${iguales ? '' : ' La última cuota ajusta el redondeo.'}</p>
      <div class="scrollx"><table class="tabla sim-tabla"><thead><tr><th>Cuota</th><th>Vence</th><th class="num">Importe</th></tr></thead><tbody>${cuotas.map((q) => `<tr><td>${q.n}</td><td class="mono">${esc(fmt(q.vto))}</td><td class="num mono">${esc(plata(q.importe))}</td></tr>`).join('')}</tbody></table></div></div>`
    : `<div class="sim-cuadro"><h4>2 · Refinanciación</h4><p class="m0"><b>La entrega inicial cubre toda la deuda: no queda nada para financiar.</b></p></div>`;
  return `<div class="sim-cuadros">${estado}${refi}</div>
    <p class="hint m0">Simulación con las cuentas de la planilla del estudio: interés simple por cuota, honorarios sobre capital e intereses y cuotas fijas sobre saldo. No es una oferta.</p>`;
}

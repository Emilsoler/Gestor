// Lo propio de la Mutual: la cotización rápida del panel y las condiciones que solo ella puede cambiar en «Nuevo crédito»
// (monto y tasa fuera de lo habitual: se avisa, no se impide). «Nuevo crédito» es la misma pantalla de las agencias
// (../app.js en modo mostrador, master/nuevo.html; pedido de la persona del 27/11/2026).
import { simularCredito } from '../../cobranzas/vehiculos.js';
import { esc, plata, hoy } from '../../cobranzas/textos.js';

export const nuevaRapida = () => ({ capital: '', cuotas: '', tasa: '', g: null, res: null, error: '' });

/** «1.500.000», «1,2» → número. */
const numAR = (x) => { const n = Number(String(x ?? '').trim().replace(/\s|\$|%/g, '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
/** Una tasa admite el punto como decimal: «6.5» son seis y medio, no sesenta y cinco. */
const tasaAR = (x) => { const t = String(x ?? '').trim().replace('%', '').replace(',', '.'); return t === '' ? null : Number(t); };
const escribir = (n, dec = 2) => (Number(n) || 0).toLocaleString('es-AR', { maximumFractionDigits: dec });
/** La tasa habitual según el año del modelo: la misma regla que la función `agencias` (tasaPara). */
export function tasaHabitual(anio, a, anioActual = Number(hoy().slice(0, 4))) {
  const y = anio === '0km' ? anioActual : Math.trunc(Number(anio));
  let mejor = null;
  for (const t of Array.isArray(a?.tasas) ? a.tasas : []) {
    const desde = Math.trunc(Number(t?.desde)), tasa = Number(t?.tasa);
    if (Number.isFinite(desde) && tasa >= 0 && desde <= y && (!mejor || desde > mejor.desde)) mejor = { desde, tasa };
  }
  return mejor ? mejor.tasa : Number(a?.tasa_mensual) || 0;
}
const plazosDe = (a) => (Array.isArray(a?.plazos) ? a.plazos : []).map(Number).filter((n) => n >= 1 && n <= 120).sort((x, y) => x - y);
const cuotasTxt = (n) => `${n} ${Number(n) === 1 ? 'cuota' : 'cuotas'}`;

/**
 * El crédito con el monto o la tasa que escribió la Mutual. `r` es lo que respondió el cotizador; devuelve la misma forma
 * (así la tabla de plazos, el WhatsApp y la impresión salen iguales), con `avisos` de en qué se aparta de lo habitual.
 */
export function ajustarCredito(r, a, { monto: m, tasa: t } = {}) {
  const monto = numAR(m) || r.monto, habitual = tasaHabitual(r.anio, a);
  const escrita = tasaAR(t), tasa = escrita === null ? habitual : escrita;
  if (!(tasa >= 0 && tasa <= 100)) return { error: 'Revisá la tasa mensual.' };
  const g = a?.gastos || {}, sim = simularCredito({ capital: monto, cuotas: r.cuotas, g, tasa });
  if (!sim) return { error: 'No se pudo calcular el crédito con estos datos.' };
  const pct = r.valor_vehiculo ? Math.round((monto / r.valor_vehiculo) * 1000) / 10 : 0;
  const avisos = [];
  if (r.maximo && monto > r.maximo) avisos.push(`Supera el máximo que ven las agencias (${plata(r.maximo)})${pct ? `: es el ${escribir(pct, 1)} % del valor del vehículo` : ''}.`);
  if (tasa !== habitual) avisos.push(`La tasa habitual para este modelo es ${escribir(habitual)} % mensual.`);
  if (monto === r.monto && tasa === habitual) return { res: r, tasa, pct, avisos };
  const opciones = plazosDe(a).map((n) => ({ cuotas: n, cuota: simularCredito({ capital: monto, cuotas: n, g, tasa })?.cuota })).filter((o) => o.cuota);
  const res = { ...r, monto, cuota: sim.cuota, total: sim.totalCredito, gastos_otorgamiento: sim.gastos, opciones, pidio: 0 };
  delete res.cuota_max;
  return { res, tasa, pct, avisos };
}

const aviso = (t) => (t ? `<p class="aviso-chico m0" role="alert">${esc(t)}</p>` : '');

// ───────────────────────── Cotización rápida ─────────────────────────
const GASTOS = [['sellado', 'Sellado (%)'], ['arancel', 'Arancel del Registro (%)'], ['arancelMin', 'Arancel mínimo ($)'], ['contratos', 'Contratos ($)'], ['envio', 'Envío ($)'], ['gestoria', 'Gestoría ($)'],
  ['seguro', 'Seguro (% por cuota)'], ['administrativos', 'Gastos administrativos ($ por cuota)'], ['cuotaSocial', 'Cuota social ($ por cuota)'], ['igr', 'IGR (% de los intereses)']];
// La lista de lo que tiene que mandar el cliente: el mismo texto (de la persona) que la simulación rápida del cotizador.
const DOCS_RAPIDA = `Recordá que para avanzar en tu crédito debes enviarnos por acá:
1) Foto de DNI (ambos lados)
2) Foto de un impuesto o Servicio para constatar el domicilio
3) A) En caso de ser empleado en relación de dependencia: Últimos 6 recibos de sueldo.
    B) En caso de ser Monotributista: Constancia de Inscripción y últimos 3 pagos.
    C) En caso de ser Responsable Inscripto: Constancia de Inscripción, últimas 3 DDJJ de IVA y Ganancias.
4) Título del automotor.
5) Estado civil; en caso de ser casado/a: menciona el lugar y fecha de matrimonio
6) Nro. de celular
7) CBU dónde se va a depositar el crédito`;

export function textoRapida(r, a = {}) {
  return `Te paso las condiciones del crédito prendario de la Asociación Mutual Bell:\n\nMonto del crédito: ${plata(r.capital)}\n${cuotasTxt(r.cuotas)} de ${plata(r.cuota)}\n\n${DOCS_RAPIDA}\n\n`
    + (a.leyenda ? `${a.leyenda}\n` : '') + (a.contacto ? `${a.contacto}\n` : '');
}

/** Los gastos de la cotización rápida: los de los parámetros, salvo lo que se haya cambiado en pantalla. */
function gastosRapida(R, a) {
  const g = { ...(a.gastos || {}) };
  for (const [k] of GASTOS) if (R.g && R.g[k] !== undefined && String(R.g[k]).trim() !== '') g[k] = k === 'arancelMin' || ['contratos', 'envio', 'gestoria', 'administrativos', 'cuotaSocial'].includes(k) ? numAR(R.g[k]) : tasaAR(R.g[k]) || 0;
  return g;
}

export function calcularRapida(R, a) {
  const plazos = plazosDe(a), capital = numAR(R.capital), cuotas = Math.trunc(numAR(R.cuotas || plazos[plazos.length - 1] || 12));
  const t = tasaAR(R.tasa), tasa = t === null ? tasaHabitual('0km', a) : t;
  if (!(capital > 0)) return { error: 'Escribí el capital.' };
  if (!(cuotas >= 1 && cuotas <= 120)) return { error: 'Las cuotas tienen que ser de 1 a 120.' };
  if (!(tasa >= 0 && tasa <= 100)) return { error: 'Revisá la tasa mensual.' };
  const g = gastosRapida(R, a), sim = simularCredito({ capital, cuotas, g, tasa });
  if (!sim) return { error: 'No se pudo calcular el crédito con estos datos.' };
  const opciones = plazos.map((n) => ({ cuotas: n, cuota: simularCredito({ capital, cuotas: n, g, tasa })?.cuota })).filter((o) => o.cuota);
  return { res: { ...sim, tasa, opciones } };
}

export function htmlRapida(R, A) {
  const a = A.ajustes || {}, plazos = plazosDe(a), r = R.res;
  const c = (k, rotulo, val, pista = '') => `<label class="f">${esc(rotulo)}<input data-k="ag.rap.${k}" value="${esc(val ?? '')}" inputmode="decimal" autocomplete="off" placeholder="${esc(pista)}"></label>`;
  return `<section class="card"><div class="card-cab"><h3>Cotización rápida</h3></div>
    <div class="grid2">${c('capital', 'Capital ($)', R.capital, 'Ej.: 5.000.000')}${c('cuotas', 'Cuotas (1 a 120)', R.cuotas, String(plazos[plazos.length - 1] || 12))}${c('tasa', 'Tasa mensual (%)', R.tasa, escribir(tasaHabitual('0km', a)))}</div>
    <details class="ag-mas"><summary>Gastos (vacío = el de los parámetros)</summary><div class="grid2">${GASTOS.map(([k, t]) => c(`g.${k}`, t, R.g?.[k], escribir(a.gastos?.[k] || 0))).join('')}</div></details>
    ${aviso(R.error)}
    <div class="actions"><button class="btn primary" data-a="mr-calcular">Calcular</button></div></section>
  ${r ? `<section class="card" id="mrResultado"><div class="mo-cuota"><div><span class="hint">Monto</span><b>${plata(r.capital)}</b></div><div><span class="hint">${cuotasTxt(r.cuotas)} de</span><b>${plata(r.cuota)}</b></div><div><span class="hint">Total</span><b>${plata(r.totalCredito)}</b></div></div>
    <p class="hint m0">Tasa ${escribir(r.tasa)} % mensual · gastos de otorgamiento ${plata(r.gastos)} (sellado ${plata(r.sellado)}, arancel ${plata(r.arancel)})</p>
    ${r.opciones.length ? `<details class="ag-mas"><summary>Cuota en cada plazo</summary><div class="ag-tabla"><table class="tabla"><tbody>${r.opciones.map((o) => `<tr><td>${cuotasTxt(o.cuotas)}</td><td class="num">${plata(o.cuota)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    <div class="actions"><button class="btn primary" data-a="mr-whatsapp">Mandar por WhatsApp</button><button class="btn" data-a="mr-copiar">Copiar el mensaje</button></div></section>` : ''}`;
}

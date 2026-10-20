// Fechas, importes y mensajes de cobranzas. No toca la pantalla ni la red.
import { pesos } from '../liquidacion.js';
import { detalleCuotas, nombrePropio, sumarDias, planVigente, estadoPlan, CADAS } from './calculo.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
/** Hoy en el dispositivo (la app se usa en Córdoba). */
export const hoy = () => iso(new Date());
const partes = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s.split('-').map(Number) : null);
/** 20/10/26 */
export const fmt = (s) => { const p = partes(s); return p ? `${String(p[2]).padStart(2, '0')}/${String(p[1]).padStart(2, '0')}/${String(p[0]).slice(2)}` : '—'; };
/** 20/10/2026 */
export const fmtLargo = (s) => { const p = partes(s); return p ? `${String(p[2]).padStart(2, '0')}/${String(p[1]).padStart(2, '0')}/${p[0]}` : ''; };
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** martes 20/10 */
export const fmtDia = (s) => { const p = partes(s); return p ? `${DIAS[new Date(p[0], p[1] - 1, p[2]).getDay()]} ${String(p[2]).padStart(2, '0')}/${String(p[1]).padStart(2, '0')}` : ''; };
/** "2026-10" → "octubre de 2026" */
export const nombreMes = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MESES[m - 1]} de ${y}`; };
export const mesDe = (s) => (s || '').slice(0, 7);
export const mesMas = (ym, k) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

/** "$ 1.500" con espacio duro: el signo no queda en un renglón y el número en el otro. */
export const plata = (n) => pesos(n).replace(' ', '\u00a0');
/** Para las cifras grandes del tablero: "$ 70,6 M", "$ 950.000". */
export function compacto(n) {
  const a = Math.abs(n || 0), s = n < 0 ? '-' : '';
  if (a >= 1e6) return `${s}$ ${(a / 1e6).toLocaleString('es-AR', { maximumFractionDigits: a >= 1e8 ? 0 : 1 })} M`;
  return `${s}$ ${Math.round(a).toLocaleString('es-AR')}`;
}
export const porciento = (n) => `${(+n || 0).toLocaleString('es-AR', { maximumFractionDigits: 4 })}%`;
export const cuantos = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

// ───────────────────────── Teléfonos ─────────────────────────

/**
 * Número para wa.me: 54 9 + código de área + número, sin 0 ni 15. Solo los que traen código de
 * área (10 cifras): un fijo de 6 cifras no tiene WhatsApp que se pueda adivinar. Escrito con 0
 * adelante ("03537-400100") es la forma de marcar un fijo, salvo que lleve el 15 de los celulares.
 */
export function numWhatsapp(tel) {
  let n = String(tel || '').replace(/\D/g, '');
  if (n.startsWith('549')) return n.length === 13 ? n : '';
  if (n.startsWith('54') && n.length === 12) n = n.slice(2);
  if (n.startsWith('0')) {
    n = n.slice(1);
    if (!/^\d{2,4}15\d{6,8}$/.test(n)) return '';
  }
  if (n.length === 12 && /^\d{2,4}15/.test(n)) n = n.replace(/^(\d{2,4})15/, '$1'); // 3537-15-000111
  return n.length === 10 ? '549' + n : '';
}
/** Los teléfonos del deudor, con su número de WhatsApp (o vacío) y una etiqueta para elegirlo. */
export const telefonos = (d) => (d.telefonos || []).map((t) => ({ ...t, wa: numWhatsapp(t.numero), etiqueta: [t.numero, t.nota].filter(Boolean).join(' · ') }));

// ───────────────────────── Operaciones ─────────────────────────

export const TIPOS_OPERACION = ['Ayuda económica con prenda', 'Ayuda económica', 'Pagaré', 'Cheque', 'Otro'];
export function vehiculoTexto(v) {
  if (!v) return '';
  const desc = [v.marca, v.modelo, v.anio && v.anio !== '0' ? v.anio : ''].filter(Boolean).join(' ').trim();
  return [desc, v.dominio ? `dominio ${v.dominio}` : ''].filter(Boolean).join(', ');
}
/** "ayuda económica con garantía prendaria N° 900123" (cómo se nombra en los mensajes). */
export function operacionTexto(d) {
  const op = (d.operaciones || [])[0];
  if (!op) return 'deuda';
  const tipo = op.tipo === 'Ayuda económica con prenda' ? 'ayuda económica con garantía prendaria' : (op.tipo || 'deuda').toLowerCase();
  return op.numero ? `${tipo} N° ${op.numero}` : tipo;
}

// ───────────────────────── Mensajes ─────────────────────────

/** Los campos que se pueden usar en los modelos de mensaje. */
export const CAMPOS_MENSAJE = [
  ['nombre', 'Cómo se lo nombra (el "trato" de la ficha, o su nombre)'],
  ['acreedor', 'El acreedor'],
  ['fecha', 'La fecha de hoy'],
  ['deuda', 'La deuda a hoy: capital, intereses, honorarios y gastos'],
  ['saldo', 'Lo que tiene que pagar: el saldo del plan si tiene uno, si no la deuda'],
  ['capital', 'El capital adeudado'],
  ['intereses', 'Los intereses adeudados'],
  ['detalle_cuotas', 'Las cuotas vencidas, en palabras ("las cuotas 21 a 24 de 24")'],
  ['dias_mora', 'Días de mora de la cuota más vieja'],
  ['operacion', 'La operación ("ayuda económica con garantía prendaria N° …")'],
  ['vehiculo', 'El vehículo prendado'],
  ['contado', 'La deuda con el descuento de contado de Ajustes'],
  ['vence_oferta', 'Hasta cuándo vale la oferta de contado'],
  ['deuda_sistema', 'Capital e intereses según el sistema de la Mutual'],
  ['plan_detalle', 'El plan: anticipo, cantidad y valor de las cuotas, primer vencimiento'],
  ['proxima_cuota_n', 'El número de la próxima cuota del plan'],
  ['proxima_cuota_vto', 'Su vencimiento'],
  ['proxima_cuota_importe', 'Lo que falta pagar de esa cuota'],
  ['plan_impagas', 'Cuántas cuotas del plan están atrasadas ("2 cuotas")'],
  ['plan_atrasado', 'Lo que suman las cuotas atrasadas'],
  ['ultimo_pago', 'El importe del último pago'],
  ['ultimo_pago_fecha', 'Su fecha'],
  ['firma', 'La firma de Ajustes'],
];

const FRECUENCIA = { mes: 'mensuales', quincena: 'quincenales', semana: 'semanales' };
/** "un anticipo de $ 100.000 y 6 cuotas mensuales de $ 250.000 (la primera vence el 20/11/2026)" */
export function planDetalle(plan) {
  if (!plan || !(plan.cuotas || []).length) return '';
  const pesos = plata;
  const qs = plan.cuotas, n = qs.length, primera = qs[0], ultima = qs[n - 1];
  const iguales = qs.every((q) => q.importe === primera.importe);
  const valor = iguales || n === 1 ? pesos(primera.importe) : `${pesos(primera.importe)} (la última, de ${pesos(ultima.importe)})`;
  const cuotas = n === 1 ? `un pago de ${pesos(primera.importe)}` : `${n} cuotas ${FRECUENCIA[plan.cada] || 'mensuales'} de ${valor}`;
  const vence = primera.vto ? `, ${n === 1 ? 'con vencimiento' : 'la primera con vencimiento'} el ${fmtLargo(primera.vto)}` : '';
  const anticipo = +plan.anticipo > 0 ? `un anticipo de ${pesos(plan.anticipo)} y ` : '';
  return `${anticipo}${cuotas}${vence}`;
}
export const frecuencia = (cada) => CADAS[cada] || 'Mensual';

/**
 * Los valores de cada campo para un deudor. `r` es su resumen (calculo.resumen). Si se pasa un
 * plan en armado (la propuesta que todavía no se guardó), los campos del plan salen de ahí.
 */
export function contextoMensaje(d, r, aj, dia, planPropuesto = null) {
  const pesos = plata;
  const liq = r.liq, saldoDe = (id) => liq.rubros.find((x) => x.id === id)?.saldo || 0;
  const deuda = Math.max(0, liq.total.saldo);
  const plan = planPropuesto || planVigente(d);
  const ep = planPropuesto ? null : r.ep;
  const op = (d.operaciones || [])[0];
  const c = {
    nombre: (d.trato || '').trim() || nombrePropio(d.nombre),
    acreedor: d.acreedor || aj.acreedor || '',
    fecha: fmtLargo(dia),
    deuda: pesos(deuda),
    saldo: pesos(r.saldo),
    capital: pesos(saldoDe('capital')),
    intereses: pesos(saldoDe('intereses')),
    detalle_cuotas: liq.vencidas ? detalleCuotas(liq) : '',
    dias_mora: liq.vencidas ? String(liq.dias_mora) : '',
    operacion: operacionTexto(d),
    vehiculo: vehiculoTexto(op?.vehiculo),
    contado: deuda ? pesos(Math.round(deuda * (+aj.contado_pct || 100) / 100)) : '',
    vence_oferta: fmtLargo(sumarDias(dia, +aj.oferta_dias || 7)),
    deuda_sistema: liq.sistema.total ? pesos(liq.sistema.total) : '',
    plan_detalle: planDetalle(plan),
    proxima_cuota_n: ep?.proxima ? (ep.proxima.n === 0 ? 'del anticipo' : String(ep.proxima.n)) : '',
    proxima_cuota_vto: ep?.proxima?.vto ? fmtLargo(ep.proxima.vto) : '',
    proxima_cuota_importe: ep?.proxima ? pesos(ep.proxima.importe) : '',
    plan_impagas: ep?.impagas ? cuantos(ep.impagas, 'cuota', 'cuotas') : '',
    plan_atrasado: ep?.impagas ? pesos(ep.atrasado) : '',
    ultimo_pago: r.ultimo ? pesos(Object.values(r.ultimo.imp || {}).reduce((a, v) => a + (+v || 0), 0)) : '',
    ultimo_pago_fecha: r.ultimo ? fmtLargo(r.ultimo.fecha) : '',
    firma: aj.firma || '',
  };
  return c;
}

/** Completa un modelo. Devuelve el texto y los campos que no tienen dato (quedan escritos tal cual). */
export function completar(modelo, ctx) {
  const faltan = new Set();
  const texto = String(modelo || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (todo, k) => {
    const v = ctx[k.toLowerCase()];
    if (v === undefined) return todo; // no es un campo: queda como está
    if (v === '') { faltan.add(k.toLowerCase()); return todo; }
    return v;
  });
  return { texto, faltan: [...faltan] };
}

/** Situación del plan, para mostrar. */
export const SITUACION_PLAN = {
  'al-dia': ['Al día', 's-ok'], atrasado: ['Atrasado', 's-warn'], 'para-caer': ['Para caer', 's-bad'],
  cumplido: ['Cumplido', 's-ok'], caido: ['Caído', 's-bad'], anulado: ['Anulado', ''],
};
export { estadoPlan };

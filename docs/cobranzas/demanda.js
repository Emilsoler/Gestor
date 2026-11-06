// "Haz DP": la demanda ejecutiva prendaria en Word, a partir del modelo del estudio. Los datos se escriben a mano
// o se toman de un deudor ya cargado (y se pueden corregir). No toca la pantalla ni la red; el Word lo arma
// `armarAcuerdo` (acuerdo.js) con el modelo `modelos/demanda-prendaria.docx`.
//
// El texto del modelo no se modifica ni se amplía: solo se reemplazan los datos variables ({{campos}}).
// El modelo lo arma `dev/modelo-dp.mjs` (el texto de la demanda del estudio está ahí, al pie de la letra).
import { liquidar, sumarMeses, ES_FECHA } from './calculo.js';
import { enLetras, cifra, partirDomicilio, partirVehiculo } from '../oficio.js';
import { fechaLarga } from './acuerdo.js';
import { r2 } from '../liquidacion.js';

/** Cada campo del modelo con cómo se le dice a la persona cuando falta (queda "[DNI del demandado]" en el Word, a completar a mano). */
export const CAMPOS_DEMANDA = {
  demandados: 'datos de los demandados', sea_condenado: 'condena', al_demandado: 'demandado',
  monto_letras: 'monto reclamado en letras', monto: 'monto reclamado',
  prestamo_fecha: 'fecha del contrato de prenda', prenda_letras: 'monto de la prenda en letras', prenda_monto: 'monto de la prenda',
  registro: 'Registro del Automotor', inscripcion_fecha: 'fecha de inscripción',
  marca: 'marca', dominio: 'dominio', modelo: 'modelo', motor: 'N° de motor', chasis: 'N° de chasis',
  cuotas_cant: 'cantidad de cuotas', cuota_letras: 'cuota en letras', cuota_monto: 'importe de la cuota', primer_venc: 'vencimiento de la primera cuota',
  cuotas_pagadas: 'cuotas pagadas', mora_cuota_nro: 'cuota en que empezó la mora', mora_fecha: 'fecha de la mora',
};

/** Lo que se escribe en la pantalla (textos, como los escribe la persona). */
export const nuevoDemandado = () => ({ nombre: '', dni: '', calle: '', ciudad: 'Bell Ville' });
export const nuevaDemanda = () => ({
  id: '', q: '', demandados: [nuevoDemandado()],
  prestamo: '', prendaMonto: '', registro: '', inscripcion: '',
  marca: '', dominio: '', modelo: '', motor: '', chasis: '',
  cuotas: '', cuota: '', vto1: '', moraN: '',
});

const num = (t) => { const n = parseFloat(String(t ?? '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const ent = (t) => { const n = parseInt(String(t ?? '').trim(), 10); return Number.isFinite(n) && n > 0 ? n : 0; };

/**
 * Los datos del formulario tomados de un deudor ya cargado: su prenda (la primera operación con prenda o con vehículo),
 * el vencimiento de la cuota 1 y la primera cuota vencida impaga como cuota en mora. Lo que la ficha no tenga queda vacío
 * (el Registro del Automotor, la fecha de inscripción y el monto de la prenda no están en la ficha: se escriben).
 */
export function demandaDesdeDeudor(d, hoy) {
  const F = { ...nuevaDemanda(), id: d.id };
  const dom = partirDomicilio(d.domicilio);
  F.demandados = [{ nombre: d.nombre || '', dni: d.dni || '', calle: [dom.calle, dom.numero].filter(Boolean).join(' '), ciudad: dom.localidad || 'Bell Ville' }]; // otros demandados se agregan a mano
  const ops = d.operaciones || [];
  const op = ops.find((o) => /prenda/i.test(o.tipo || '')) || ops.find((o) => o.vehiculo) || ops[0] || null;
  if (op) {
    F.prestamo = ES_FECHA.test(op.fecha || '') ? op.fecha : '';
    if (+op.cuotas) F.cuotas = String(+op.cuotas);
    if (+op.importe) F.cuota = String(+op.importe);
    const v = op.vehiculo;
    if (v && typeof v === 'object') Object.assign(F, { marca: v.marca || '', modelo: v.modelo || '', dominio: v.dominio || '', motor: v.motor || '', chasis: v.chasis || '' });
    else if (typeof v === 'string' && v.trim()) { const p = partirVehiculo(v); Object.assign(F, { marca: p.marca, modelo: p.modelo, dominio: p.dominio, motor: p.motor, chasis: p.chasis }); }
  }
  const cs = (d.cuotas || []).filter((q) => !op || !q.op || String(q.op) === String(op.id));
  const liq = liquidar(d, hoy);
  const venc = liq.cuotas.filter((c) => c.saldo > 0 && c.vto && c.vto <= hoy && c.n != null); // en orden de vencimiento
  const primera = venc.find((c) => !op || cs.some((q) => String(q.id) === String(c.id))) || venc[0] || null;
  if (primera) {
    F.moraN = String(primera.n);
    F.vto1 = sumarMeses(primera.vto, -(primera.n - 1));
    if (!F.cuotas && primera.de) F.cuotas = String(primera.de);
    if (!F.cuota && primera.importe) F.cuota = String(primera.importe);
  }
  return F;
}

/** Las cuentas de la demanda: cuotas impagas (desde la cuota en mora hasta la última) × valor de la cuota. */
export function estadoDemanda(F) {
  const total = ent(F.cuotas), mora = ent(F.moraN), cuota = num(F.cuota);
  const valida = total > 0 && mora > 0 && mora <= total;
  const impagas = valida ? total - mora + 1 : 0;
  const pagadas = valida ? mora - 1 : 0;
  const vto1 = ES_FECHA.test(F.vto1 || '') ? F.vto1 : '';
  return {
    total, mora, cuota, valida, impagas, pagadas, vto1,
    reclamado: valida && cuota > 0 ? r2(impagas * cuota) : 0,
    moraFecha: valida && vto1 ? sumarMeses(vto1, mora - 1) : '',
  };
}

/** "Calle 745" → "Calle nro. 745" (como en el modelo). */
const calleDe = (t) => { const dom = partirDomicilio(t); return dom.numero ? `${dom.calle} nro. ${dom.numero}` : dom.calle; };
/** Los datos de un demandado como van en el escrito; lo que falta queda entre corchetes. */
function textoDemandado(x, i, varios) {
  const t = (v) => String(v ?? '').trim(), sufijo = varios ? ' ' + (i + 1) : '';
  return `${t(x.nombre).toUpperCase() || `[nombre del demandado${sufijo}]`}, DNI Nº ${t(x.dni) || `[DNI del demandado${sufijo}]`} con domicilio en calle ${calleDe(x.calle) || `[domicilio del demandado${sufijo}]`} de la ciudad de ${t(x.ciudad) || `[ciudad del demandado${sufijo}]`}, Provincia de Córdoba`;
}
/** Los demandados de a uno, unidos con "y" (con tres o más, separados con punto y coma). */
export function unirDemandados(xs) {
  const ps = xs.map((x, i) => textoDemandado(x, i, xs.length > 1));
  return ps.length < 3 ? ps.join(' y ') : `${ps.slice(0, -1).join('; ')} y ${ps[ps.length - 1]}`;
}

const mayus = (n) => enLetras(n).toUpperCase();
const pesosCifra = (n) => cifra(n);

/** Los valores de cada {{campo}} del modelo (vacío: queda "[nombre]" en el Word). */
export function datosDemanda(F) {
  const e = estadoDemanda(F), prenda = num(F.prendaMonto);
  const t = (x) => String(x ?? '').trim();
  const xs = F.demandados?.length ? F.demandados : [nuevoDemandado()], varios = xs.length > 1;
  return {
    demandados: unirDemandados(xs), sea_condenado: varios ? 'sean condenados' : 'sea condenado', al_demandado: varios ? 'a los demandados' : 'al demandado',
    monto_letras: e.reclamado > 0 ? mayus(e.reclamado) : '', monto: e.reclamado > 0 ? pesosCifra(e.reclamado) : '',
    prestamo_fecha: fechaLarga(F.prestamo),
    prenda_letras: prenda > 0 ? mayus(prenda) : '', prenda_monto: prenda > 0 ? pesosCifra(prenda) : '',
    registro: t(F.registro).toUpperCase(), inscripcion_fecha: fechaLarga(F.inscripcion),
    marca: t(F.marca).toUpperCase(), dominio: t(F.dominio).toUpperCase().replace(/\s+/g, ''), modelo: t(F.modelo).toUpperCase(),
    motor: t(F.motor).toUpperCase(), chasis: t(F.chasis).toUpperCase(),
    cuotas_cant: e.total ? String(e.total) : '',
    cuota_letras: e.cuota > 0 ? mayus(e.cuota) : '', cuota_monto: e.cuota > 0 ? pesosCifra(e.cuota) : '',
    primer_venc: fechaLarga(e.vto1),
    cuotas_pagadas: e.valida ? String(e.pagadas) : '',
    mora_cuota_nro: e.valida ? String(e.mora) : '', mora_fecha: fechaLarga(e.moraFecha),
  };
}

/**
 * Los datos que van a quedar entre corchetes en el Word, por sus nombres. Se muestran en pantalla antes de
 * bajarlo: el Registro, la fecha de inscripción y el monto de la prenda no están en la ficha del deudor y es
 * fácil darlos por cargados.
 */
export function faltanDemanda(F) {
  const v = datosDemanda(F), faltan = [];
  for (const [c, nombre] of Object.entries(CAMPOS_DEMANDA)) {
    if (c === 'demandados') { if (/\[[^\]]+\]/.test(v.demandados)) faltan.push('datos de algún demandado'); continue; }
    if (!String(v[c] ?? '').trim()) faltan.push(nombre);
  }
  return faltan;
}

/** Avisos para mostrar antes de bajar el Word. */
export function avisosDemanda(F) {
  const e = estadoDemanda(F), av = [];
  if (e.total && e.mora && !e.valida) av.push('La cuota en que empezó la mora tiene que estar entre 1 y la cantidad de cuotas');
  if (e.valida && !e.vto1) av.push('Falta el vencimiento de la primera cuota: sin eso no se calcula la fecha de la mora');
  return av;
}

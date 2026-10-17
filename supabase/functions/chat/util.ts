// Cuentas y textos que el chat comparte con la app (docs/app.js, docs/datos.js): mismas reglas,
// para que lo que diga Claude coincida con lo que se ve en la pantalla.

export const ZONA = 'America/Argentina/Cordoba';
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export type Ahora = { fecha: string; hora: string; dow: number; texto: string };

/** Fecha y hora de Córdoba (la función corre en UTC). */
export function ahora(d = new Date()): Ahora {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)) p[x.type] = x.value;
  const fecha = `${p.year}-${p.month}-${p.day}`, hora = `${p.hour}:${p.minute}`, dow = diaSemana(fecha);
  return { fecha, hora, dow, texto: `${DIAS[dow]} ${p.day}/${p.month}/${p.year}, ${hora} hs (hora de Córdoba)` };
}

export const diaSemana = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();
export const esFecha = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
export const dma = (iso: string) => (iso ? iso.split('-').reverse().join('/') : '');
export const nombreDia = (iso: string) => DIAS[diaSemana(iso)];

export type Causa = {
  expte: string; actor: string; demandado: string; tipo: string; nom: string; oficina: string; estado: string;
  etiquetas: string[]; proxima: string; vence: string | null; ultima: string; fecha: string | null; notas: string;
  historial?: Mov[]; liquidacion?: Liquidacion | null; demandados?: Demandado[]; titulos?: Titulo[];
  rev: number; actualizado?: string; actualizado_por?: string;
};
export type Mov = { fecha: string; texto: string; hecha?: boolean };
export type Demandado = { nombre: string; dni: string; telefono: string; domicilio: string; notas: string };
export type Titulo = { tipo: string; monto: number; vence: string; descripcion: string; vehiculo: string };
export type Liquidacion = {
  fecha?: string; embargo?: number;
  rubros?: { id?: string; rubro: string; monto: number; pagado?: number }[];
  pagos?: { id?: string; fecha?: string; op?: string; imp?: Record<string, number> }[];
};

// Hay juicios sin contraparte (limitación de la capacidad, sucesiones…): se nombran por el actor.
export const partes = (c: Causa) => (c.actor && !c.demandado ? c.actor : `${c.actor || 'AMB'} c/ ${c.demandado || '…'}`);
export const caratula = (c: Causa) => `${partes(c)}${c.tipo ? ' – ' + c.tipo : ''}`;
export const nombreCausa = (c: Causa) => c.demandado || c.actor || '(sin carátula)';

/** Completa los campos {{…}} de una plantilla con los datos de la causa (igual que la ficha). */
export function completar(t: string, c: Causa): string {
  const m: Record<string, string> = {
    caratula: caratula(c), expediente: c.expte, actor: c.actor, demandado: c.demandado, tipo: c.tipo,
    nominacion: c.nom ? c.nom + '°' : '', oficina: c.oficina,
  };
  return String(t || '').replace(/\{\{\s*([a-záéíóúñ]+)\s*\}\}/gi, (x, k: string) => {
    k = k.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return k in m ? (m[k] || '') : x;
  });
}

export const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** La última acción es el movimiento de fecha más reciente; a igual fecha, el anotado después. */
export function ultimaDe(h: Mov[]) {
  let mejor: Mov | null = null;
  for (const x of h || []) if (!mejor || (x.fecha || '') >= (mejor.fecha || '')) mejor = x;
  return mejor ? { ultima: mejor.texto || '', fecha: mejor.fecha || null } : { ultima: '', fecha: null };
}

export const ESTADOS = ['Iniciar', 'Notificando', 'Casillero', 'A despacho', 'Sentencia', 'Tramites p/ subasta', 'Acuerdo', 'Archivada'];
export const ETIQUETAS = ['En trámite', 'Embargo de sueldo', 'Secuestro / subasta', 'Acuerdo', 'Martillero', 'OP solicitada'];

const r2 = (n: number) => Math.round((+n || 0) * 100) / 100;
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

/** Monto reclamado a hoy: capital + interés simple del 5% por cada 30 días desde el vencimiento. */
export function reclamado(c: Causa, hoy: string) {
  const titulos = (c.titulos || []).map((t) => {
    const capital = +t.monto || 0, dias = t.vence && esFecha(t.vence) ? Math.max(0, diasEntre(t.vence, hoy)) : 0;
    const interes = r2(capital * 0.05 * dias / 30);
    return { tipo: t.tipo, descripcion: t.descripcion, vehiculo: t.vehiculo || undefined, vence: t.vence || null, capital, dias_de_mora: dias, interes, total: r2(capital + interes) };
  });
  const suma = (k: 'capital' | 'interes' | 'total') => r2(titulos.reduce((a, t) => a + t[k], 0));
  return { titulos, capital: suma('capital'), interes: suma('interes'), total: suma('total'), tasa: '5% mensual simple' };
}

/** Total, cobrado y saldo de la planilla (cobrado = lo imputado por las órdenes de pago). */
export function resumenLiquidacion(l: Liquidacion | null | undefined) {
  if (!l) return null;
  const rubros = Array.isArray(l.rubros) ? l.rubros : [];
  const pagos = Array.isArray(l.pagos) ? l.pagos : null;
  const cobrado = (r: { id?: string; pagado?: number }) =>
    pagos ? r2(pagos.reduce((a, p) => a + (+(p.imp || {})[r.id || ''] || 0), 0)) : r2(+(r.pagado || 0));
  const total = r2(rubros.reduce((a, r) => a + (+r.monto || 0), 0)), pag = r2(rubros.reduce((a, r) => a + cobrado(r), 0));
  return {
    fecha: l.fecha || null, total, cobrado: pag, saldo: r2(total - pag), embargo: +(l.embargo || 0),
    rubros: rubros.map((r) => ({ rubro: r.rubro, monto: +r.monto || 0, cobrado: cobrado(r) })),
    ordenes_de_pago: (pagos || []).map((p) => ({ fecha: p.fecha || null, op: p.op || '', monto: r2(Object.values(p.imp || {}).reduce((a, v) => a + (+v || 0), 0)) })),
  };
}

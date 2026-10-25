// La consulta a la Central de Deudores del BCRA y el semáforo de la aprobación de créditos.
// Nada de Deno ni de la base: lo usa index.ts y lo prueban las pruebas locales contra un BCRA falso.
//
// API pública del BCRA (sin clave): https://api.bcra.gob.ar/CentralDeDeudores/v1.0/Deudas/{cuit}
//   Deudas/{cuit}                  situación actual en cada entidad (montos en miles de pesos)
//   Deudas/Historicas/{cuit}       los últimos 24 meses
//   Deudas/ChequesRechazados/{cuit}
// Responden {status, results} o, si falla, {status, errorMessages}. 404: no figura.

const RUTA = '/CentralDeDeudores/v1.0/Deudas';
const ESPERA_MS = 20_000; // por pedido; el BCRA a veces tarda
const REINTENTO_MS = 700;

export const soloDigitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** CUIT, CUIL o CDI: 11 números y el último, el dígito verificador (módulo 11). */
export function cuitValido(c: string): boolean {
  if (!/^\d{11}$/.test(c)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((a, p, i) => a + p * Number(c[i]), 0);
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  return dv !== 10 && dv === Number(c[10]);
}

export type TipoError = 'red' | 'tiempo' | 'certificado' | 'limite' | 'bcra' | 'parametro' | 'formato';
const MENSAJES: Record<TipoError, string> = {
  red: 'No se pudo conectar con el BCRA. Probá de nuevo en un momento.',
  tiempo: 'El BCRA tardó demasiado en responder. Probá de nuevo en un momento.',
  certificado: 'No se pudo verificar la conexión segura con el BCRA. Avisale a Claude para revisarlo.',
  limite: 'El BCRA está limitando las consultas. Esperá unos minutos y probá de nuevo.',
  bcra: 'El BCRA respondió con un error. Probá de nuevo en un rato.',
  parametro: 'El BCRA no aceptó ese CUIT.',
  formato: 'El BCRA respondió algo que no se pudo leer. Probá de nuevo en un rato.',
};

export class ErrorBCRA extends Error {
  constructor(public tipo: TipoError, public status = 0, public detalle = '') { super(MENSAJES[tipo]); }
}

const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// Para los registros: sin el CUIT (va en la dirección y en algunos mensajes de error).
export const sinCuit = (s: unknown) => String(s ?? '').replace(/\d{11}/g, '…').slice(0, 300);

function tipoDeFalla(e: unknown): TipoError {
  const texto = `${(e as Error)?.name || ''} ${(e as Error)?.message || ''} ${(e as { cause?: unknown })?.cause || ''}`;
  if (/TimeoutError|timed? ?out/i.test(texto)) return 'tiempo';
  if (/certificate|UnknownIssuer|invalid peer|tls|ssl/i.test(texto)) return 'certificado';
  return 'red';
}

type Respuesta = { status: number; results: any };

/** Un pedido al BCRA. Reintenta una vez si no hubo conexión o si el BCRA falló (5xx). */
async function pedir(url: string): Promise<Respuesta> {
  let ultimo: ErrorBCRA | null = null;
  for (let intento = 0; intento < 2; intento++) {
    if (intento) await esperar(REINTENTO_MS);
    let r: Response;
    try {
      r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ESPERA_MS) });
    } catch (e) {
      ultimo = new ErrorBCRA(tipoDeFalla(e), 0, sinCuit(`${(e as Error)?.name}: ${(e as Error)?.message}`));
      continue;
    }
    const texto = await r.text();
    let datos: any = null;
    try { datos = texto ? JSON.parse(texto) : null; } catch { /* no es JSON: abajo */ }
    // El cuerpo también trae el estado; si alguna vez no coincide con el de HTTP, manda el del cuerpo.
    const status = r.status === 200 && Number.isInteger(datos?.status) ? datos.status : r.status;
    if (status >= 500) { ultimo = new ErrorBCRA('bcra', status, sinCuit(texto)); continue; }
    if (status === 404) return { status: 404, results: null };
    if (status === 429) throw new ErrorBCRA('limite', 429);
    if (status === 400) throw new ErrorBCRA('parametro', 400, sinCuit(texto));
    if (status !== 200) throw new ErrorBCRA('bcra', status, sinCuit(texto));
    if (!datos || typeof datos.results !== 'object' || datos.results === null) throw new ErrorBCRA('formato', 200, sinCuit(texto));
    return { status: 200, results: datos.results };
  }
  throw ultimo!;
}

export type Consulta = {
  deudas: any; historicas: any; cheques: any;
  errores: Record<string, string>;
  estados: Record<string, number>; // para los registros: lo que respondió cada endpoint
};

/**
 * Los tres pedidos, a la vez. La situación actual y los cheques son indispensables: si alguno falla,
 * no hay consulta. Los 24 meses son un agregado: si fallan, la consulta sale igual y lo anota.
 */
export async function consultar(cuit: string, { url = 'https://api.bcra.gob.ar' } = {}): Promise<Consulta> {
  const base = `${url}${RUTA}`;
  const [deudas, historicas, cheques] = await Promise.allSettled([
    pedir(`${base}/${cuit}`), pedir(`${base}/Historicas/${cuit}`), pedir(`${base}/ChequesRechazados/${cuit}`),
  ]);
  for (const r of [deudas, cheques]) if (r.status === 'rejected') throw r.reason;
  const errores: Record<string, string> = {};
  const estados: Record<string, number> = {};
  const de = (nombre: string, r: PromiseSettledResult<Respuesta>) => {
    if (r.status === 'fulfilled') { estados[nombre] = r.value.status; return r.value.results; }
    const e = r.reason as ErrorBCRA;
    estados[nombre] = e?.status || 0;
    errores[nombre] = e?.message || 'No se pudo consultar.';
    return null;
  };
  return { deudas: de('deudas', deudas), historicas: de('historicas', historicas), cheques: de('cheques', cheques), errores, estados };
}

// ───────────────────────── Semáforo ─────────────────────────

export type Resumen = {
  denominacion: string; periodo: string; semaforo: 'verde' | 'amarillo' | 'rojo' | 'sin_datos';
  peor_situacion: number; entidades: number; deuda_total: number; cheques: number; cheques_impagos: number;
  motivos: string[];
};

const lista = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const r2 = (n: number) => Math.round(n * 100) / 100;
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** El último período informado (AAAAMM) y sus entidades. */
export function ultimoPeriodo(deudas: any): { periodo: string; entidades: any[] } {
  const periodos = lista(deudas?.periodos).filter((p) => p && /^\d{6}$/.test(String(p.periodo)));
  if (!periodos.length) return { periodo: '', entidades: [] };
  const p = periodos.reduce((a, b) => (String(b.periodo) > String(a.periodo) ? b : a));
  return { periodo: String(p.periodo), entidades: lista(p.entidades) };
}

/** Todos los cheques rechazados, con su causal. */
export function chequesDe(cheques: any): any[] {
  return lista(cheques?.causales).flatMap((c) => lista(c?.entidades).flatMap((e) => lista(e?.detalle).map((d) => ({ ...d, causal: c?.causal ?? '', entidad: e?.entidad ?? null }))));
}

const situacion = (e: any) => Math.max(0, Math.min(6, Math.trunc(Number(e?.situacion) || 0)));

/** La peor situación de los últimos 24 meses y en qué período (el más reciente, si se repite). */
export function peorHistorica(historicas: any): { situacion: number; periodo: string } {
  let peor = { situacion: 0, periodo: '' };
  for (const p of lista(historicas?.periodos)) {
    for (const e of lista(p?.entidades)) {
      const s = situacion(e), per = String(p?.periodo ?? '');
      if (s > peor.situacion || (s === peor.situacion && s > 0 && per > peor.periodo)) peor = { situacion: s, periodo: per };
    }
  }
  return peor;
}

/**
 * El color de la consulta y por qué. Lo decide la situación actual:
 *   rojo      situación 3 o peor en alguna entidad, o algún cheque rechazado sin pagar
 *   amarillo  situación 2 en alguna entidad, o cheques rechazados ya pagados
 *   verde     todo en situación 1 y sin cheques rechazados
 *   sin_datos sin deudas en el último período informado y sin cheques rechazados
 * Lo de los últimos 24 meses no cambia el color, pero si fue peor que hoy queda entre los motivos.
 */
export function resumir(deudas: any, cheques: any, historicas: any = null): Resumen {
  const { periodo, entidades } = ultimoPeriodo(deudas);
  const peor = entidades.reduce((a, e) => Math.max(a, situacion(e)), 0);
  const deuda = r2(entidades.reduce((a, e) => a + (Number(e?.monto) || 0), 0) * 1000);
  const todos = chequesDe(cheques), impagos = todos.filter((d) => !d.fechaPago).length, pagados = todos.length - impagos;
  const antes = peorHistorica(historicas);

  const motivos: string[] = [];
  for (const e of [...entidades].filter((e) => situacion(e) >= 2).sort((a, b) => situacion(b) - situacion(a))) {
    motivos.push(`Situación ${situacion(e)} en ${String(e.entidad ?? '').trim() || 'una entidad'}`);
  }
  if (impagos) motivos.push(`${plural(impagos, 'cheque rechazado', 'cheques rechazados')} sin pagar`);
  if (pagados) motivos.push(`${plural(pagados, 'cheque rechazado', 'cheques rechazados')}, ${pagados === 1 ? 'ya pagado' : 'ya pagados'}`);

  let semaforo: Resumen['semaforo'];
  if (peor >= 3 || impagos) semaforo = 'rojo';
  else if (peor === 2 || pagados) semaforo = 'amarillo';
  else if (entidades.length) semaforo = 'verde';
  else semaforo = 'sin_datos';

  if (semaforo === 'verde') motivos.push(`Situación 1 (normal) en ${plural(entidades.length, 'entidad', 'entidades')}`, 'Sin cheques rechazados');
  if (semaforo === 'sin_datos') {
    motivos.push(antes.situacion ? 'Sin deudas en el último período informado' : 'No figura en la Central de Deudores', 'Sin cheques rechazados');
  }
  if (antes.situacion >= 2 && antes.situacion > peor) {
    const [y, m] = [antes.periodo.slice(0, 4), antes.periodo.slice(4, 6)];
    motivos.push(`En los últimos 24 meses llegó a situación ${antes.situacion}${/^\d{6}$/.test(antes.periodo) ? ` (${m}/${y})` : ''}`);
  }

  return {
    denominacion: String(deudas?.denominacion || cheques?.denominacion || historicas?.denominacion || '').trim().slice(0, 300),
    periodo, semaforo, peor_situacion: peor, entidades: entidades.length, deuda_total: deuda,
    cheques: Math.min(todos.length, 32767), cheques_impagos: Math.min(impagos, 32767), motivos,
  };
}

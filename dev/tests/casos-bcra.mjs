// Casos inventados del BCRA falso (dev/bcra-falso.mjs), compartidos por las pruebas de la función y de
// la app: CUITs con su dígito verificador correcto que no son de nadie.
export const CUIT = {
  verde: '20111111112', amarillo: '27222222228', rojo: '20333333334', empresa: '30444444440', nada: '20555555556',
  antes: '27666666661', caido: '20777777778', corte: '20888888889', sinHistoria: '23123456785', limite: '27100000011',
  enCuerpo: '30700000024',
};
const entidad = (entidad, situacion, monto, extra = {}) => ({
  entidad, situacion, fechaSit1: situacion === 1 ? '2019-03-01' : null, monto, diasAtrasoPago: 0, refinanciaciones: false,
  recategorizacionOblig: false, situacionJuridica: false, irrecDisposicionTecnica: false, enRevision: false, procesoJud: false, ...extra,
});
/** Los 24 meses hasta `fin` (AAAAMM), del más viejo al más nuevo. */
export function meses(fin = '202609', n = 24) {
  const [y, m] = [+fin.slice(0, 4), +fin.slice(4)];
  return Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1)); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; });
}
const historia = (cuit, nombre, porMes) => ({ results: { identificacion: +cuit, denominacion: nombre, periodos: meses().map((p, i) => ({ periodo: p, entidades: porMes(p, i) })) } });
const cheque = (nro, fechaRechazo, monto, fechaPago = null, extra = {}) => ({ nroCheque: nro, fechaRechazo, monto, fechaPago, fechaPagoMulta: null, estadoMulta: fechaPago ? null : 'IMPAGA', ctaPersonal: true, denomJuridica: null, enRevision: false, procesoJud: false, ...extra });

/** Los casos del BCRA falso: los mismos para estas pruebas y las de la app. */
export const CASOS = {
  [CUIT.verde]: {
    deudas: { results: { identificacion: +CUIT.verde, denominacion: 'PERSONA VERDE', periodos: [{ periodo: '202609', entidades: [
      entidad('BANCO DE LA NACION ARGENTINA', 1, 150.5), entidad('TARJETA NARANJA S.A.', 1, 80)] }] } },
    historicas: historia(CUIT.verde, 'PERSONA VERDE', () => [{ entidad: 'BANCO DE LA NACION ARGENTINA', situacion: 1, monto: 140, enRevision: false, procesoJud: false }]),
  },
  [CUIT.amarillo]: {
    deudas: { results: { identificacion: +CUIT.amarillo, denominacion: 'PERSONA AMARILLA', periodos: [{ periodo: '202609', entidades: [
      entidad('BANCO DE GALICIA Y BUENOS AIRES S.A.', 2, 320, { diasAtrasoPago: 45 }), entidad('BANCO MACRO S.A.', 1, 50, { refinanciaciones: true })] }] } },
    historicas: historia(CUIT.amarillo, 'PERSONA AMARILLA', (p, i) => [{ entidad: 'BANCO DE GALICIA Y BUENOS AIRES S.A.', situacion: i > 20 ? 2 : 1, monto: 300, enRevision: false, procesoJud: false }]),
    cheques: { results: { identificacion: +CUIT.amarillo, denominacion: 'PERSONA AMARILLA', causales: [{ causal: 'SIN FONDOS', entidades: [{ entidad: 7, detalle: [cheque(12345678, '2025-11-03', 150000, '2025-11-20')] }] }] } },
  },
  [CUIT.rojo]: {
    deudas: { results: { identificacion: +CUIT.rojo, denominacion: 'PERSONA ROJA', periodos: [{ periodo: '202609', entidades: [
      entidad('BANCO SANTANDER ARGENTINA S.A.', 4, 1200, { procesoJud: true, diasAtrasoPago: 250 }), entidad('<b>FINANCIERA</b> "X"', 1, 10)] }] } },
    historicas: historia(CUIT.rojo, 'PERSONA ROJA', (p, i) => [{ entidad: 'BANCO SANTANDER ARGENTINA S.A.', situacion: i === 10 ? 5 : i > 15 ? 4 : 1, monto: 1100, enRevision: false, procesoJud: i > 15 }]),
    cheques: { results: { identificacion: +CUIT.rojo, denominacion: 'PERSONA ROJA', causales: [
      { causal: 'SIN FONDOS', entidades: [{ entidad: 11, detalle: [cheque(87654321, '2026-08-10', 500000)] }] },
      { causal: 'Defectos formales', entidades: [{ entidad: 11, detalle: [cheque(87654322, '2026-02-01', 20000, '2026-02-15')] }] }] } },
  },
  [CUIT.empresa]: {
    deudas: { results: { identificacion: +CUIT.empresa, denominacion: 'EMPRESA EJEMPLO S.A.', periodos: [{ periodo: '202609', entidades: [entidad('BANCO PATAGONIA S.A.', 3, 5000)] }] } },
  },
  [CUIT.antes]: {
    historicas: historia(CUIT.antes, 'PERSONA QUE PAGO', (p, i) => (i < 20 ? [{ entidad: 'BANCO MACRO S.A.', situacion: i === 15 ? 3 : 1, monto: 90, enRevision: false, procesoJud: false }] : [])),
  },
  [CUIT.caido]: { deudas: { status: 500 } },
  [CUIT.corte]: { deudas: { cortar: true } },
  [CUIT.sinHistoria]: {
    deudas: { results: { identificacion: +CUIT.sinHistoria, denominacion: 'PERSONA SIN HISTORIA', periodos: [{ periodo: '202609', entidades: [entidad('BANCO CREDICOOP COOPERATIVO LIMITADO', 1, 20)] }] } },
    historicas: { status: 500 },
  },
  [CUIT.limite]: { deudas: { status: 429 }, cheques: { status: 429 } },
  // "No figura" dicho dentro de una respuesta 200.
  [CUIT.enCuerpo]: {
    deudas: { cuerpo: { status: 404, errorMessages: ['No se encontró datos para la identificación ingresada.'] } },
    cheques: { cuerpo: { status: 200, results: { identificacion: +CUIT.enCuerpo, denominacion: 'EMPRESA SIN DEUDAS S.A.', causales: [] } } },
  },
};

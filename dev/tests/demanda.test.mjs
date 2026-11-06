// "Haz DP" (docs/cobranzas/demanda.js): la demanda ejecutiva prendaria en Word. No necesita el stack.
// El caso es el de la demanda del estudio contra CALDERON Pablo Gabriel (260824).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nuevaDemanda, estadoDemanda, datosDemanda, avisosDemanda, demandaDesdeDeudor, CAMPOS_DEMANDA } from '../../docs/cobranzas/demanda.js';
import { armarAcuerdo, leerZip } from '../../docs/cobranzas/acuerdo.js';

const MODELO = new Uint8Array(readFileSync(new URL('../../docs/cobranzas/modelos/demanda-prendaria.docx', import.meta.url)));
const formulario = () => ({
  ...nuevaDemanda(), nombre: 'Calderon Pablo Gabriel', dni: '26.816.517', calle: 'Intendente Da Silva 745', ciudad: 'Bell Ville',
  prestamo: '2025-05-28', prendaMonto: '17516280', registro: 'Bell Ville N°1', inscripcion: '2025-05-29',
  marca: 'Volkswagen', dominio: 'kmn 065', modelo: 'Amarok 2.0L TDI 122 CV S22', motor: 'CDB 012416', chasis: '8AWDD42H1CA001746',
  cuotas: '12', cuota: '1459690', vto1: '2025-06-30', moraN: '3',
});
const texto = async (blob) => {
  const partes = await leerZip(new Uint8Array(await blob.arrayBuffer()));
  return new TextDecoder().decode(partes.find((p) => p.nombre === 'word/document.xml').datos).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
};

test('el modelo trae todos los campos y todos son conocidos', async () => {
  const xml = new TextDecoder().decode((await leerZip(MODELO)).find((p) => p.nombre === 'word/document.xml').datos);
  const campos = new Set([...xml.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
  for (const k of campos) assert.ok(k in CAMPOS_DEMANDA, `campo sin describir: ${k}`);
  for (const k of Object.keys(CAMPOS_DEMANDA)) assert.ok(campos.has(k), `campo que el modelo no usa: ${k}`);
});

test('lo reclamado es cuotas impagas × valor de la cuota, y la mora cae en el mes que corresponde', () => {
  const e = estadoDemanda(formulario());
  assert.equal(e.impagas, 10);
  assert.equal(e.pagadas, 2);
  assert.equal(e.reclamado, 14596900);
  assert.equal(e.moraFecha, '2025-08-30');
});

test('los datos salen como en la demanda del estudio', () => {
  const v = datosDemanda(formulario());
  assert.equal(v.deudor_nombre, 'CALDERON PABLO GABRIEL');
  assert.equal(v.deudor_calle, 'Intendente Da Silva nro. 745');
  assert.equal(v.monto_letras, 'CATORCE MILLONES QUINIENTOS NOVENTA Y SEIS MIL NOVECIENTOS');
  assert.equal(v.monto, '14.596.900');
  assert.equal(v.prenda_letras, 'DIECISIETE MILLONES QUINIENTOS DIECISÉIS MIL DOSCIENTOS OCHENTA');
  assert.equal(v.cuota_letras, 'UN MILLÓN CUATROCIENTOS CINCUENTA Y NUEVE MIL SEISCIENTOS NOVENTA');
  assert.equal(v.prestamo_fecha, '28 de mayo de 2025');
  assert.equal(v.primer_venc, '30 de junio de 2025');
  assert.equal(v.mora_fecha, '30 de agosto de 2025');
  assert.equal(v.dominio, 'KMN065');
});

test('el Word sale completo y con el texto del modelo', async () => {
  const { blob, faltan } = await armarAcuerdo(MODELO, datosDemanda(formulario()), CAMPOS_DEMANDA);
  assert.deepEqual(faltan, []);
  const t = await texto(blob);
  assert.ok(t.includes('promover demanda de ejecución prendaria en contra en contra de CALDERON PABLO GABRIEL, DNI Nº 26.816.517 con domicilio en calle Intendente Da Silva nro. 745 de la ciudad de Bell Ville, Provincia de Córdoba, para que sea condenado al pago de la suma de Pesos CATORCE MILLONES QUINIENTOS NOVENTA Y SEIS MIL NOVECIENTOS ($ 14.596.900) con más intereses y costas.'));
  assert.ok(t.includes('automotor marca VOLKSWAGEN dominio KMN065 modelo AMAROK 2.0L TDI 122 CV S22, motor CDB 012416, chasis 8AWDD42H1CA001746.'));
  assert.ok(t.includes('habiéndose abonado 2 cuotas. La mora se produjo a partir del vencimiento de la cuota n° 3, es decir, el 30 de agosto de 2025.'));
  assert.ok(t.includes('con vencimiento la primera el 30 de junio de 2025 y las restantes cada treinta días subsiguientes.'));
  assert.ok(!/\{\{|\}\}/.test(t));
});

test('lo que falta queda entre corchetes y avisa', async () => {
  const F = { ...nuevaDemanda(), nombre: 'Perez Juan' };
  const { blob, faltan } = await armarAcuerdo(MODELO, datosDemanda(F), CAMPOS_DEMANDA);
  assert.ok(faltan.includes('deudor_dni') && faltan.includes('monto'));
  assert.ok((await texto(blob)).includes('DNI Nº [DNI del demandado]'));
  assert.ok(avisosDemanda({ ...formulario(), moraN: '13' }).length);
  assert.equal(estadoDemanda({ ...formulario(), moraN: '13' }).reclamado, 0);
});

test('de un deudor cargado salen sus datos y la primera cuota vencida como mora', () => {
  const d = {
    id: 'x', nombre: 'Calderon Pablo Gabriel', dni: '26816517', domicilio: 'Intendente Da Silva 745, Bell Ville',
    tasa: 5, hon_pct: 0, gastos: [], pagos: [], planes: [], gestiones: [],
    operaciones: [{ id: 'o1', tipo: 'Ayuda económica con prenda', numero: '900123', fecha: '2025-05-28', cuotas: 12, importe: 1459690, vehiculo: { marca: 'Volkswagen', modelo: 'Amarok', dominio: 'KMN065' } }],
    cuotas: Array.from({ length: 12 }, (_, i) => ({ id: 'q' + (i + 1), op: 'o1', n: i + 1, de: 12, vto: ['2025-06-30', '2025-07-30', '2025-08-30', '2025-09-30', '2025-10-30', '2025-11-30', '2025-12-30', '2026-01-30', '2026-02-28', '2026-03-30', '2026-04-30', '2026-05-30'][i], importe: 1459690 })).filter((q) => q.n >= 3),
  };
  const F = demandaDesdeDeudor(d, '2026-11-05');
  assert.equal(F.calle, 'Intendente Da Silva 745');
  assert.equal(F.ciudad, 'Bell Ville');
  assert.equal(F.cuotas, '12');
  assert.equal(F.moraN, '3');
  assert.equal(F.vto1, '2025-06-30');
  assert.equal(F.dominio, 'KMN065');
  assert.equal(estadoDemanda(F).reclamado, 14596900);
});

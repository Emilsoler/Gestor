// Descuento de cheques (docs/cobranzas/descuento.js y la tabla public.descuentos_cheques, migración 0035).
// Las cuentas no necesitan el stack; las pruebas de la base sí (`dev/stack.sh up`): se saltean si no está.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  nuevoDescuento, nuevoCheque, filaDeForm, formDeFila, liquidarDescuento, cartera, resumenCartera, hojaDescuento, htmlLiquidacionDescuento, diasEntre, pct,
} from '../../docs/cobranzas/descuento.js';

const HOY = '2026-11-18';
const cheque = (importe, vence, extra = {}) => ({ ...nuevoCheque(), importe, vence, ...extra });
const op = (extra = {}) => ({ cliente: 'Pérez Juan', cuit: '', socio: '412', fecha: HOY, tasa: 4, comision: 1, sellado: 1.2, gastos: 500, dias_extra: 2, notas: '', cheques: [], ...extra });

test('cada cheque: interés simple por días (tasa mensual / 30), comisión, sellado y gastos fijos; neto = valor − descuentos', () => {
  const e = liquidarDescuento(op({ cheques: [cheque(1_000_000, '2026-12-18'), cheque(500_000, '2026-11-10')] }));
  const [a, b] = e.cheques;
  assert.equal(a.dias, 30 + 2); // 30 días hasta el pago + 2 de acreditación
  assert.equal(a.interes, 42_666.67); // 1.000.000 × 4% / 30 × 32
  assert.equal(a.comision, 10_000);
  assert.equal(a.sellado, 12_000);
  assert.equal(a.gastos, 500);
  assert.equal(a.neto, 1_000_000 - 42_666.67 - 10_000 - 12_000 - 500);
  // Un cheque ya vencido (al día) solo paga los días de acreditación.
  assert.equal(b.dias, 2);
  assert.equal(b.interes, 1333.33);
  assert.deepEqual(e.total, { importe: 1_500_000, interes: 44_000, comision: 15_000, sellado: 18_000, gastos: 1000, descuento: 78_000, neto: 1_422_000 });
  assert.equal(e.plazo, 22); // ponderado por valor: (32 × 1.000.000 + 2 × 500.000) / 1.500.000
  assert.deepEqual(e.problemas, []);
});

test('sin IVA: los descuentos son exactamente interés + comisión + sellado + gastos, y los totales suman los cheques', () => {
  for (let i = 0; i < 300; i++) {
    const n = 1 + (i % 6), cs = Array.from({ length: n }, (_, k) => cheque(Math.round(1000 + Math.random() * 5e6) / 1, `2027-0${1 + ((i + k) % 9)}-${String(1 + ((i * 7 + k) % 28)).padStart(2, '0')}`));
    const e = liquidarDescuento(op({ tasa: Math.round(Math.random() * 800) / 100, comision: Math.round(Math.random() * 300) / 100, sellado: Math.round(Math.random() * 200) / 100, gastos: i % 3 ? 0 : 750, cheques: cs }));
    for (const c of e.cheques) assert.equal(Math.round((c.interes + c.comision + c.sellado + c.gastos) * 100), Math.round(c.descuento * 100));
    for (const k of ['importe', 'interes', 'comision', 'sellado', 'gastos', 'neto']) {
      assert.equal(Math.round(e.total[k] * 100), Math.round(e.cheques.reduce((a, c) => a + c[k], 0) * 100), k);
    }
    assert.equal(Math.round((e.total.importe - e.total.descuento) * 100), Math.round(e.total.neto * 100));
  }
});

test('los días extra de clearing se ven aparte («30 + 2») y no pasan de 5: el plazo sale de la fecha de pago', () => {
  const e = liquidarDescuento(op({ cheques: [cheque(1_000_000, '2026-12-18')] }));
  assert.deepEqual([e.cheques[0].plazo, e.cheques[0].extra, e.cheques[0].dias], [30, 2, 32]);
  assert.match(htmlLiquidacionDescuento(e), /30 \+ 2/);
  const sin = liquidarDescuento(op({ dias_extra: 0, cheques: [cheque(1_000_000, '2026-12-18')] }));
  assert.match(htmlLiquidacionDescuento(sin), />30</);
  assert.doesNotMatch(htmlLiquidacionDescuento(sin), /\+ 0/);
  // El caso que llevó a esto: el plazo escrito también como días extra daba el doble.
  const mal = liquidarDescuento(op({ dias_extra: 30, cheques: [cheque(1_000_000, '2026-12-18')] }));
  assert.ok(mal.problemas.some((p) => /clearing van de 0 a 5/.test(p)));
});

test('días entre fechas, sin husos horarios (también con el cambio de año)', () => {
  assert.equal(diasEntre('2026-11-18', '2026-12-18'), 30);
  assert.equal(diasEntre('2026-12-31', '2027-01-01'), 1);
  assert.equal(diasEntre('2026-11-18', '2026-11-10'), -8);
  assert.equal(pct('1,5'), 1.5); assert.equal(pct(''), 0); assert.ok(Number.isNaN(pct('abc')));
});

test('el formulario: se escribe a la argentina y se guarda en números; ida y vuelta da lo mismo', () => {
  const F = nuevoDescuento(HOY);
  assert.deepEqual([F.tasa, F.comision, F.sellado, F.gastos, F.dias], ['', '', '', '', '']); // no se inventan condiciones
  Object.assign(F, { cliente: '  Pérez Juan ', cuit: '20-12345678-6', tasa: '4,5', comision: '1', sellado: '1,2', gastos: '1.500', dias: '2' });
  F.cheques = [{ ...nuevoCheque(), importe: '1.250.000,50', vence: '2027-01-15', numero: '00012345', banco: 'Banco de la Nación Argentina', entidad: '11', cuit: '30-50000000-1' }, nuevoCheque()];
  const f = filaDeForm(F);
  assert.equal(f.cliente, 'Pérez Juan');
  assert.equal(f.cuit, '20123456786');
  assert.deepEqual([f.tasa, f.comision, f.sellado, f.gastos, f.dias_extra], [4.5, 1, 1.2, 1500, 2]);
  assert.equal(f.cheques.length, 1, 'la fila vacía no se guarda');
  assert.deepEqual([f.cheques[0].importe, f.cheques[0].numero, f.cheques[0].entidad, f.cheques[0].estado], [1_250_000.5, '12345', 11, 'cartera']);
  const g = filaDeForm(formDeFila({ ...f, id: 'x' }));
  assert.deepEqual(g, f);
  // La operación siguiente arranca con las condiciones de la última.
  const N = nuevoDescuento(HOY, f);
  assert.deepEqual([N.tasa, N.comision, N.sellado, N.gastos, N.dias], ['4,5', '1', '1,2', '1.500', '2']);
});

test('lo que falta para guardar se dice en palabras', () => {
  const e = liquidarDescuento(filaDeForm({ ...nuevoDescuento(HOY), cliente: '', tasa: '150', cuit: '20-12345678-0', cheques: [{ ...nuevoCheque(), importe: '1000' }] }));
  assert.ok(e.problemas.includes('Falta el nombre del cliente'));
  assert.ok(e.problemas.includes('El CUIT del cliente no es válido'));
  assert.ok(e.problemas.some((p) => /La tasa/.test(p)));
  assert.ok(e.problemas.includes('Cheque 1: falta la fecha de pago'));
  const caro = liquidarDescuento(op({ gastos: 2000, cheques: [cheque(1500, '2027-01-01')] }));
  assert.ok(caro.problemas.some((p) => /se comen todo el cheque/.test(p)));
});

test('cartera: los cheques sin cobrar de todas las operaciones, del que vence antes al que vence después', () => {
  const ops = [
    op({ id: 'a', cliente: 'B', cheques: [cheque(100, '2026-12-01', { id: 'a1' }), cheque(200, '2026-11-20', { id: 'a2', estado: 'cobrado' })] }),
    op({ id: 'b', cliente: 'A', cheques: [cheque(300, '2026-11-15', { id: 'b1' }), cheque(400, '2026-11-22', { id: 'b2' }), cheque(50, '2026-11-30', { id: 'b3', estado: 'rechazado' })] }),
  ];
  assert.deepEqual(cartera(ops, HOY).map((x) => [x.c.id, x.falta]), [['b1', -3], ['b2', 4], ['a1', 13]]);
  assert.deepEqual(resumenCartera(ops, HOY), { cant: 3, total: 800, semana: 400, cantSemana: 1, vencidos: 300, cantVencidos: 1, rechazados: 1 });
});

test('la planilla de Excel tiene las mismas cifras que la pantalla, con fórmulas', () => {
  const o = op({ cheques: [cheque(1_000_000, '2026-12-18', { librador: 'ACME SA' }), cheque(500_000, '2026-11-10')] }), e = liquidarDescuento(o);
  const [h] = hojaDescuento(o, e, HOY);
  const fila = h.filas.find((r) => r[0]?.v === 'Neto a pagar al cliente');
  assert.equal(fila[1].v, 1_422_000);
  const ch = h.filas[11];
  assert.equal(ch[2].v, 'ACME SA');
  assert.equal(ch[7].f, 'ROUND(G12*$B$5/100/30*F12,2)');
  assert.equal(ch[7].v, 42_666.67);
  assert.equal(h.filas[4][1].v, 4, 'B5 es la tasa');
  assert.match(htmlLiquidacionDescuento(e), /1\.422\.000/);
});

// ───────────────────────── La base ─────────────────────────

let stack = false, sql, sqlFalla, entrar, crearCuenta, servicio;
const EMAIL = 'descuento@test.local', CLAVE = 'Clave-de-descuentos-2026', OTRO = 'curioso-dc@test.local';
before(async () => {
  try {
    ({ sql, sqlFalla, entrar, crearCuenta, servicio } = await import('./helpers.mjs'));
    sql('select 1'); stack = true;
  } catch { return; }
  sql(`delete from public.descuentos_cheques; delete from auth.users where email in ('${EMAIL}', '${OTRO}');`);
  await crearCuenta(EMAIL, CLAVE, 'Emi');
  const { error } = await servicio().auth.admin.createUser({ email: OTRO, password: CLAVE, email_confirm: true });
  if (error) throw error;
});

test('base: un miembro guarda, cambia y elimina operaciones; queda el historial y se deshace', async (t) => {
  if (!stack) return t.skip('sin stack');
  const cliente = await entrar(EMAIL, CLAVE);
  const fila = filaDeForm({ ...nuevoDescuento(HOY), cliente: 'Pérez Juan', tasa: '4', cheques: [{ ...nuevoCheque(), importe: '1.000.000', vence: '2026-12-18' }] });
  const alta = await cliente.from('descuentos_cheques').insert(fila).select().single();
  assert.ifError(alta.error);
  const id = alta.data.id, rev = alta.data.rev;
  assert.equal(alta.data.actualizado_por, 'Emi');
  // Marcar un cheque cobrado con la revisión vieja no pisa un cambio hecho en el medio.
  sql(`begin; select set_config('gestor.autor', 'Claude', true); update public.descuentos_cheques set notas = 'de Claude' where id = '${id}'; commit;`);
  const viejo = await cliente.from('descuentos_cheques').update({ notas: 'pisado' }).eq('id', id).eq('rev', rev).select();
  assert.equal(viejo.data.length, 0);
  assert.equal(sql(`select notas from public.descuentos_cheques where id = '${id}'`), 'de Claude');
  for (const mala of [{ ...fila, cliente: ' ' }, { ...fila, tasa: 120 }, { ...fila, dias_extra: 90 }, { ...fila, cheques: {} }]) {
    assert.equal((await cliente.from('descuentos_cheques').insert(mala)).error?.code, '23514', JSON.stringify(mala).slice(0, 80));
  }
  assert.ifError((await cliente.from('descuentos_cheques').delete().eq('id', id)).error);
  const baja = sql(`select id from gestor.cambios where tabla = 'descuentos_cheques' and clave = '${id}' and operacion = 'baja'`);
  assert.match(sql(`select gestor.deshacer(${baja})`), /volvió a como estaba/);
  assert.equal(sql(`select cliente || ' ' || notas || ' ' || jsonb_array_length(cheques) from public.descuentos_cheques where id = '${id}'`), 'Pérez Juan de Claude 1');
});

test('base: nadie más la ve (anónimos, cuentas sin autorizar, estadísticas)', async (t) => {
  if (!stack) return t.skip('sin stack');
  assert.ok(sqlFalla(`set role anon; select * from public.descuentos_cheques;`).includes('permission denied'));
  const intruso = await entrar(OTRO, CLAVE);
  const r = await intruso.from('descuentos_cheques').select('id');
  assert.ok(r.error || r.data.length === 0, 'una cuenta sin autorizar no lee nada');
  assert.equal(sql(`select count(*) from pg_attribute where attrelid = 'public.descuentos_cheques'::regclass and attnum > 0 and not attisdropped and attstattarget <> 0`), '0');
});

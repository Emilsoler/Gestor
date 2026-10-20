// Cobranzas: las cuentas (docs/cobranzas/calculo.js), las funciones de la base para Claude y los
// permisos de las tablas nuevas. Requiere `dev/stack.sh up`.
//
// La liquidación se calcula en dos lugares —la app y gestor.liquidacion_deudor— y tienen que dar
// exactamente lo mismo: además de los casos de la planilla de Excel del estudio y del listado de
// la Mutual, se comparan las dos con cientos de deudores al azar.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, sqlFalla, anon, entrar, crearCuenta, servicio } from './helpers.mjs';
import {
  liquidar, armarPlan, estadoPlan, promesa, resumen, detalleCuotas, nombrePropio, sumarMeses, diasEntre, totalPago,
} from '../../docs/cobranzas/calculo.js';

const EMAIL = 'cobra@test.local', CLAVE = 'Clave-de-cobranzas-2026';
const OTRO = 'curioso@test.local';
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const json = (o) => q(JSON.stringify(o));
const rubro = (liq, id) => liq.rubros.find((r) => r.id === id);
const cuotasDesde = (desde, cant, importe, n0 = 1, de = 24) => Array.from({ length: cant }, (_, k) => ({ id: 'q' + (n0 + k), n: n0 + k, de, vto: sumarMeses(desde, k), importe }));

before(async () => {
  sql(`delete from public.deudores; delete from auth.users where email in ('${EMAIL}', '${OTRO}');`);
  await crearCuenta(EMAIL, CLAVE, 'Cobranzas');
  const { error } = await servicio().auth.admin.createUser({ email: OTRO, password: CLAVE, email_confirm: true });
  if (error) throw error;
});

// ───────────────────────── La planilla de Excel del estudio ─────────────────────────

test('Excel: el caso con honorarios (5% mensual, 10% de honorarios, con la cuota que todavía no vence)', () => {
  const d = { tasa: 5, hon_pct: 10, cuotas: cuotasDesde('2026-08-15', 4, 278640) };
  const l = liquidar(d, '2026-10-19', { aVencer: true });
  assert.deepEqual(l.cuotas.map((c) => [c.dias, c.interes]), [[65, 30186], [34, 15789.6], [4, 1857.6], [0, 0]]);
  assert.equal(rubro(l, 'capital').devengado, 1114560);
  assert.equal(rubro(l, 'intereses').devengado, 47833.2);
  assert.equal(rubro(l, 'honorarios').devengado, 116239.32);
  assert.equal(l.total.saldo, 1278632.52); // la celda TOTAL de la hoja
  // Sin las cuotas a vencer: solo las tres vencidas, y la cuarta queda aparte.
  const v = liquidar(d, '2026-10-19');
  assert.equal(rubro(v, 'capital').devengado, 835920);
  assert.equal(v.capital_a_vencer, 278640);
  assert.equal(v.vencidas, 3);
  assert.equal(v.dias_mora, 65);
});

test('Excel: los otros tres casos (interés simple al 4%, 3% y 4%)', () => {
  const m = liquidar({ tasa: 4, cuotas: cuotasDesde('2026-06-20', 4, 656470) }, '2026-10-19');
  assert.deepEqual(m.cuotas.map((c) => c.interes), [105910.49, 79651.69, 52517.6, 25383.51]);
  assert.equal(rubro(m, 'capital').devengado, 2625880);
  assert.equal(rubro(m, 'intereses').devengado, 263463.29);
  const p = liquidar({ tasa: 3, cuotas: cuotasDesde('2025-10-05', 13, 643600) }, '2026-10-19');
  assert.equal(rubro(p, 'capital').devengado, 8366800);
  assert.equal(rubro(p, 'intereses').devengado, 1644398);
  const a = liquidar({ tasa: 4, cuotas: cuotasDesde('2025-12-02', 5, 691940) }, '2026-10-19');
  assert.equal(rubro(a, 'capital').devengado, 3459700);
  assert.equal(rubro(a, 'intereses').devengado, 1200285.25);
  assert.equal(a.dias_mora, 321);
});

test('listado de la Mutual: el 9% mensual capitalizable da lo mismo que el sistema (al peso)', () => {
  // Un deudor del listado, al 20/10/26: cuotas 21 a 24 de 24, $ 297.060 cada una. El sistema: $ 1.787.513,14.
  const d = { tasa: 5, cuotas: [21, 22, 23, 24].map((n, k) => ({ id: 'm' + n, n, de: 24, vto: sumarMeses('2026-04-17', k), importe: 297060 })) };
  const l = liquidar(d, '2026-10-20', { tasaSistema: 9 });
  assert.deepEqual(l.cuotas.map((c) => c.dias), [186, 156, 125, 95]);
  assert.equal(l.sistema.capital, 1188240);
  assert.ok(Math.abs(l.sistema.total - 1787513.14) < 15, `sistema ${l.sistema.total}`);
  // Otro: un saldo de cuota (DOCUMENTO-R) y dos cuotas, con 313, 282 y 251 días.
  const g = { tasa: 5, cuotas: [
    { id: 'r', n: 10, de: 0, vto: '2025-12-11', importe: 681990, doc: '59676' },
    { id: 'a', n: 11, de: 12, vto: '2026-01-11', importe: 1421160 },
    { id: 'b', n: 12, de: 12, vto: '2026-02-11', importe: 1421160 }] };
  const lg = liquidar(g, '2026-10-20', { tasaSistema: 9 });
  assert.ok(Math.abs(lg.sistema.total - 7793492.81) < 40, `sistema ${lg.sistema.total}`);
  assert.equal(lg.cuotas[0].de, null);
  assert.equal(detalleCuotas(lg), 'el saldo de la cuota 10 y las cuotas 11 y 12 de 12');
});

// ───────────────────────── Pagos ─────────────────────────

test('pagos: lo imputado a capital baja el capital desde la fecha del pago; lo de intereses, el saldo de intereses', () => {
  const d = {
    tasa: 5, cuotas: [{ id: 'a', n: 1, de: 1, vto: '2026-01-01', importe: 100000 }],
    pagos: [{ id: 'p', fecha: '2026-02-01', imp: { capital: 40000, intereses: 5000 } }],
  };
  const l = liquidar(d, '2026-03-03');
  // 31 días sobre $ 100.000 y 30 días sobre $ 60.000
  assert.equal(rubro(l, 'intereses').devengado, 8166.67);
  assert.equal(rubro(l, 'intereses').saldo, 3166.67);
  assert.equal(rubro(l, 'capital').saldo, 60000);
  assert.equal(l.total.pagado, 45000);
  // A una fecha anterior al pago, el pago no cuenta.
  const antes = liquidar(d, '2026-01-31');
  assert.equal(antes.total.pagado, 0);
  assert.equal(rubro(antes, 'intereses').devengado, 5000);
});

test('pagos: el capital cancela las cuotas en orden de vencimiento, incluso las que todavía no vencieron', () => {
  const d = {
    tasa: 4, cuotas: [
      { id: 'c', n: 3, de: 3, vto: '2026-03-10', importe: 1000 },
      { id: 'a', n: 1, de: 3, vto: '2026-01-10', importe: 1000 },
      { id: 'b', n: 2, de: 3, vto: '2026-02-10', importe: 1000 }],
    pagos: [{ id: 'x', fecha: '2026-02-20', imp: { capital: 2500 } }],
  };
  const l = liquidar(d, '2026-02-28');
  assert.deepEqual(l.cuotas.map((c) => [c.n, c.saldo]), [[1, 0], [2, 0], [3, 500]]);
  assert.equal(rubro(l, 'capital').devengado, 2000); // la 3 no venció
  assert.equal(rubro(l, 'capital').saldo, 0);
  assert.equal(l.capital_anticipado, 500);
  assert.equal(l.capital_a_vencer, 500);
  assert.equal(l.vencidas, 0);
  const sobra = liquidar({ ...d, pagos: [{ fecha: '2026-02-20', imp: { capital: 3500 } }] }, '2026-04-01');
  assert.equal(sobra.capital_sin_cuotas, 500);
});

test('gastos y honorarios fijos: cuentan desde su fecha y se les imputa por su id', () => {
  const d = {
    tasa: 0, hon_pct: 0, cuotas: [],
    gastos: [
      { id: 'g1', tipo: 'gasto', concepto: 'Tasa de justicia', monto: 30000, fecha: '2026-05-01' },
      { id: 'g2', tipo: 'honorarios', concepto: 'Honorarios abogado', monto: 200000, fecha: '2026-07-01' }],
    pagos: [{ id: 'p', fecha: '2026-06-01', imp: { g1: 30000 } }],
  };
  const junio = liquidar(d, '2026-06-15');
  assert.deepEqual(junio.rubros.map((r) => r.id), ['capital', 'intereses', 'g1']);
  assert.equal(rubro(junio, 'g1').saldo, 0);
  const julio = liquidar(d, '2026-07-15');
  assert.equal(rubro(julio, 'g2').tipo, 'honorarios');
  assert.equal(julio.total.saldo, 200000);
});

// ───────────────────────── La base da lo mismo que la app ─────────────────────────

function azar(semilla) { let s = semilla >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

function deudorAlAzar(r, i) {
  const ent = (a, b) => a + Math.floor(r() * (b - a + 1));
  const fecha = () => sumarMeses('2025-01-01', ent(0, 22)).slice(0, 8) + String(ent(1, 28)).padStart(2, '0');
  const importe = () => (r() < 0.3 ? ent(1, 2000000) : ent(1, 20000) * 100) + (r() < 0.3 ? ent(0, 99) / 100 : 0);
  const cuotas = Array.from({ length: ent(0, 9) }, (_, k) => ({
    id: 'q' + k, n: r() < 0.1 ? null : ent(1, 36), de: r() < 0.15 ? 0 : 36, vto: r() < 0.05 ? '' : fecha(), importe: importe(), doc: r() < 0.2 ? 'R' + k : '',
  }));
  const gastos = Array.from({ length: ent(0, 3) }, (_, k) => ({ id: 'g' + k, tipo: r() < 0.3 ? 'honorarios' : 'gasto', concepto: 'Gasto ' + k, monto: importe(), fecha: r() < 0.3 ? '' : fecha() }));
  const claves = ['capital', 'intereses', 'honorarios', ...gastos.map((g) => g.id)];
  const pagos = Array.from({ length: ent(0, 6) }, (_, k) => {
    const imp = {};
    for (const c of claves) if (r() < 0.45) imp[c] = r() < 0.5 ? importe() : ent(1, 500000);
    return { id: 'p' + k, fecha: fecha(), imp, plan: '', recibo: String(k) };
  });
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, nombre: 'AZAR ' + i,
    tasa: r() < 0.2 ? 0 : Math.round(r() * 1200) / 100, hon_pct: r() < 0.5 ? 0 : Math.round(r() * 2000) / 100,
    cuotas, gastos, pagos,
  };
}

test('la liquidación de la base (gestor.liquidacion_deudor) da lo mismo que la de la app, en 300 deudores al azar', () => {
  const r = azar(20261020);
  const ds = Array.from({ length: 300 }, (_, i) => deudorAlAzar(r, i));
  sql(`delete from public.deudores where nombre like 'AZAR %'`);
  for (let i = 0; i < ds.length; i += 25) { // de a tandas: la línea de comandos tiene un largo máximo
    sql(`insert into public.deudores (id, nombre, tasa, hon_pct, cuotas, gastos, pagos)
      select x.id, x.nombre, x.tasa, x.hon_pct, x.cuotas, x.gastos, x.pagos
        from jsonb_to_recordset(${json(ds.slice(i, i + 25))}::jsonb) x(id uuid, nombre text, tasa numeric, hon_pct numeric, cuotas jsonb, gastos jsonb, pagos jsonb);`);
  }
  const fechas = ['2025-06-30', '2026-01-15', '2026-10-20', '2027-03-01'];
  let comparadas = 0;
  for (const [i, d] of ds.entries()) {
    const f = fechas[i % fechas.length], aVencer = i % 3 === 0;
    const base = JSON.parse(sql(`select gestor.liquidacion_deudor('${d.id}', '${f}', ${aVencer})`));
    const app = liquidar(d, f, { aVencer, tasaSistema: 9 });
    // El comparativo con la Mutual usa potencias con decimales: hasta un centavo de diferencia.
    assert.ok(Math.abs(base.sistema.total - app.sistema.total) <= 0.01 * Math.max(1, app.cuotas.length), `sistema del deudor ${i}`);
    delete base.sistema.total; delete base.sistema.intereses; delete app.sistema.total; delete app.sistema.intereses;
    assert.deepEqual(base, app, `deudor ${i} al ${f}${aVencer ? ' con cuotas a vencer' : ''}`);
    comparadas++;
  }
  assert.equal(comparadas, 300);
  sql(`delete from public.deudores where nombre like 'AZAR %'`);
});

// ───────────────────────── Funciones para Claude ─────────────────────────

test('registrar_pago valida la imputación, agrega el pago firmado por Claude y devuelve la liquidación', () => {
  const id = sql(`insert into public.deudores (nombre, tasa, cuotas, gastos) values ('PAGADOR', 5,
    '[{"id":"a","n":1,"de":2,"vto":"2026-01-10","importe":100000},{"id":"b","n":2,"de":2,"vto":"2026-02-10","importe":100000}]',
    '[{"id":"tj","tipo":"gasto","concepto":"Tasa de justicia","monto":5000}]') returning id`);
  assert.match(sqlFalla(`select gestor.registrar_pago('${id}', '2026-03-01', '{"capitall": 10}')`), /Rubro desconocido: "capitall"/);
  assert.match(sqlFalla(`select gestor.registrar_pago('${id}', '2026-03-01', '{"capital": -10}')`), /no negativo/);
  assert.match(sqlFalla(`select gestor.registrar_pago('${id}', '2026-03-01', '{"capital": 0}')`), /no imputa ningún importe/);
  assert.match(sqlFalla(`select gestor.registrar_pago('${id}', '2999-01-01', '{"capital": 10}')`), /posterior a hoy/);
  assert.match(sqlFalla(`select gestor.registrar_pago('${id}', '2026-03-01', '{"capital": 10}', p_plan => 'nada')`), /plan vigente/);
  const liq = JSON.parse(sql(`select gestor.registrar_pago('${id}', '2026-03-01', '{"capital": 150000, "tj": 5000, "intereses": 0}', 'R-1', 'Transferencia')`));
  assert.equal(liq.rubros.find((x) => x.id === 'capital').saldo, 50000);
  assert.equal(liq.rubros.find((x) => x.id === 'tj').saldo, 0);
  const pagos = JSON.parse(sql(`select pagos from public.deudores where id = '${id}'`));
  assert.equal(pagos.length, 1);
  assert.deepEqual(pagos[0].imp, { capital: 150000, tj: 5000 }); // lo que es cero no se guarda
  assert.equal(pagos[0].recibo, 'R-1');
  assert.equal(sql(`select actualizado_por from public.deudores where id = '${id}'`), 'Claude');
});

test('anotar_gestion, promesas de pago y próxima acción', () => {
  const id = sql(`insert into public.deudores (nombre) values ('GESTIONADO') returning id`);
  assert.match(sqlFalla(`select gestor.anotar_gestion('${id}', 'algo', 'Paloma mensajera')`), /Tipo de gestión desconocido/);
  assert.match(sqlFalla(`select gestor.anotar_gestion('${id}', '  ')`), /Falta el texto/);
  sql(`select gestor.anotar_gestion('${id}', 'Llamé, dice que paga el viernes', 'Promesa de pago', '2026-10-20', '2026-10-23', 150000)`);
  const g = JSON.parse(sql(`select gestiones from public.deudores where id = '${id}'`));
  assert.equal(g[0].tipo, 'Promesa de pago');
  assert.equal(g[0].promesa_fecha, '2026-10-23');
  assert.equal(g[0].promesa_monto, 150000);
  sql(`select gestor.proxima_deudor('${id}', 'Llamar el lunes', '2026-10-26')`);
  assert.equal(sql(`select proxima || '|' || vence from public.deudores where id = '${id}'`), 'Llamar el lunes|2026-10-26');
  sql(`select gestor.proxima_deudor('${id}', '')`);
  assert.equal(sql(`select proxima || '|' || coalesce(vence::text, '-') from public.deudores where id = '${id}'`), '|-');
});

test('deshacer devuelve un deudor a como estaba (también los ajustes)', () => {
  const id = sql(`insert into public.deudores (nombre, notas) values ('ARREPENTIDO', 'original') returning id`);
  sql(`begin; select set_config('gestor.autor', 'Prueba', true); update public.deudores set notas = 'cambiada', tasa = 7 where id = '${id}'; commit;`);
  const cambio = sql(`select max(id) from gestor.cambios where tabla = 'deudores' and clave = '${id}'`);
  sql(`select gestor.deshacer(${cambio})`);
  assert.equal(sql(`select notas || '|' || tasa from public.deudores where id = '${id}'`), 'original|5.0000');
  sql(`begin; select set_config('gestor.autor', 'Prueba', true); update public.ajustes_cobranzas set firma = 'Otra firma' where id = 1; commit;`);
  const ca = sql(`select max(id) from gestor.cambios where tabla = 'ajustes_cobranzas'`);
  sql(`select gestor.deshacer(${ca})`);
  assert.equal(sql(`select firma from public.ajustes_cobranzas`), 'Dr. Emiliano Soler · Abogado');
});

// ───────────────────────── Permisos ─────────────────────────

test('sin cuenta, o con una cuenta no autorizada, no se ve ni se toca nada de cobranzas', async () => {
  sql(`insert into public.deudores (nombre) values ('SECRETO')`);
  for (const t of ['deudores', 'modelos_mensaje', 'ajustes_cobranzas']) {
    const r = await anon().from(t).select('*');
    assert.ok(r.error || r.data.length === 0, `anon leyó ${t}`);
  }
  const otro = await entrar(OTRO, CLAVE);
  const r = await otro.from('deudores').select('*');
  assert.ok(r.error, 'la puerta de la API rechaza a la cuenta no autorizada');
  assert.match(r.error.message, /cuenta no autorizada/);
  const ins = await otro.from('deudores').insert({ nombre: 'INTRUSO' });
  assert.ok(ins.error);
  assert.equal(sql(`select count(*) from public.deudores where nombre = 'INTRUSO'`), '0');
});

test('un miembro lee y escribe deudores y modelos; los ajustes se cambian pero no se crean ni se borran', async () => {
  const c = await entrar(EMAIL, CLAVE);
  const nuevo = await c.from('deudores').insert({ nombre: 'DESDE LA APP', tasa: 4 }).select().single();
  assert.ifError(nuevo.error);
  assert.equal(nuevo.data.actualizado_por, 'Cobranzas');
  const mal = await c.from('deudores').insert({ nombre: 'X', estado: 'Inventado' });
  assert.equal(mal.error?.code, '23514');
  const m = await c.from('modelos_mensaje').select('id, titulo').order('orden');
  assert.deepEqual(m.data.map((x) => x.id), ['aviso', 'contado', 'plan', 'recordatorio', 'atraso', 'recibo']);
  const aj = await c.from('ajustes_cobranzas').update({ tasa: 4.5 }).eq('id', 1).select().single();
  assert.ifError(aj.error);
  assert.equal(+aj.data.tasa, 4.5);
  const otra = await c.from('ajustes_cobranzas').insert({ id: 1 });
  assert.ok(otra.error, 'no se puede crear otra fila de ajustes');
  const borrar = await c.from('ajustes_cobranzas').delete().eq('id', 1);
  assert.ok(borrar.error || sql('select count(*) from public.ajustes_cobranzas') === '1');
  sql(`update public.ajustes_cobranzas set tasa = 5 where id = 1`);
  // Las funciones de Claude no se pueden llamar desde la API.
  const fn = await c.rpc('liquidacion_deudor', { p_deudor: nuevo.data.id });
  assert.ok(fn.error);
});

test('las tablas de cobranzas no tienen estadísticas del planificador', () => {
  assert.equal(sql(`select count(*) from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('deudores', 'modelos_mensaje', 'ajustes_cobranzas') and a.attnum > 0 and not a.attisdropped and a.attstattarget <> 0`), '0');
});

// ───────────────────────── Planes, promesas y textos ─────────────────────────

test('planes: cuotas iguales en pesos enteros (la última absorbe el redondeo) y sistema francés', () => {
  const p = armarPlan({ deuda: 1000, n: 3, primerVto: '2026-01-31' });
  assert.deepEqual(p.cuotas.map((c) => [c.vto, c.importe]), [['2026-01-31', 333], ['2026-02-28', 333], ['2026-03-31', 334]]);
  const f = armarPlan({ deuda: 1200000, quita: 100000, anticipo: 100000, n: 12, tasa: 5, primerVto: '2026-11-10' });
  assert.equal(f.financiado, 1000000);
  assert.equal(f.cuota, 112825);
  assert.equal(f.cuotas.reduce((a, c) => a + c.importe, 0), f.total);
  assert.ok(Math.abs(f.total - 1353904.9) < 1);
  const q = armarPlan({ deuda: 900, n: 2, cada: 'quincena', primerVto: '2026-01-01' });
  assert.deepEqual(q.cuotas.map((c) => c.vto), ['2026-01-01', '2026-01-16']);
});

test('planes: los pagos que lo nombran cubren anticipo y cuotas en orden; atraso, caída y cumplimiento', () => {
  const plan = { id: 'pl', estado: 'vigente', fecha: '2026-06-01', anticipo: 100, anticipo_vto: '2026-06-01', caducidad: 2,
    cuotas: [{ n: 1, vto: '2026-07-01', importe: 200 }, { n: 2, vto: '2026-08-01', importe: 200 }, { n: 3, vto: '2026-09-01', importe: 200 }] };
  const pagos = [{ fecha: '2026-06-01', plan: 'pl', imp: { capital: 100 } }, { fecha: '2026-07-03', plan: 'pl', imp: { capital: 150, intereses: 100 } }, { fecha: '2026-07-03', plan: '', imp: { capital: 999 } }];
  const e = estadoPlan(plan, pagos, '2026-08-20', 5);
  assert.deepEqual(e.items.map((x) => x.estado), ['pagada', 'pagada', 'parcial', 'pendiente']);
  assert.equal(e.impagas, 1); // la 2 está atrasada; la 3 todavía no venció
  assert.equal(e.atrasado, 150);
  assert.equal(e.situacion, 'atrasado');
  assert.deepEqual(e.proxima, { n: 2, vto: '2026-08-01', importe: 150 });
  assert.equal(estadoPlan(plan, pagos, '2026-09-10', 5).situacion, 'para-caer');
  const todo = [...pagos, { fecha: '2026-09-01', plan: 'pl', imp: { capital: 350 } }];
  assert.equal(estadoPlan(plan, todo, '2026-09-10', 5).situacion, 'cumplido');
  assert.equal(estadoPlan({ ...plan, estado: 'caido' }, pagos, '2026-09-10').situacion, 'caido');
});

test('promesas de pago: pendiente, cumplida, incumplida y seguida', () => {
  const base = { gestiones: [{ fecha: '2026-10-01', tipo: 'Promesa de pago', texto: 'paga el 10', promesa_fecha: '2026-10-10', promesa_monto: 1000 }] };
  assert.equal(promesa({ ...base, pagos: [] }, '2026-10-10').estado, 'pendiente');
  assert.equal(promesa({ ...base, pagos: [] }, '2026-10-10').hoy, true);
  assert.equal(promesa({ ...base, pagos: [{ fecha: '2026-10-12', imp: { capital: 1000 } }] }, '2026-10-20').estado, 'cumplida');
  assert.equal(promesa({ ...base, pagos: [{ fecha: '2026-10-12', imp: { capital: 500 } }] }, '2026-10-20').estado, 'incumplida');
  const seguida = { ...base, gestiones: [...base.gestiones, { fecha: '2026-10-15', tipo: 'Llamada', texto: 'no atiende' }], pagos: [] };
  assert.equal(promesa(seguida, '2026-10-20').estado, 'seguida');
  assert.equal(promesa({ gestiones: [] }, '2026-10-20'), null);
  // Un pago del mismo día, registrado antes de anotar la promesa, no la cumple.
  const mismoDia = { gestiones: [{ fecha: '2026-10-20', creado: '2026-10-20T15:00:00.000Z', promesa_fecha: '2026-10-20', promesa_monto: 100 }] };
  assert.equal(promesa({ ...mismoDia, pagos: [{ fecha: '2026-10-20', creado: '2026-10-20T14:00:00.000Z', imp: { capital: 500 } }] }, '2026-10-20').estado, 'pendiente');
  assert.equal(promesa({ ...mismoDia, pagos: [{ fecha: '2026-10-20', creado: '2026-10-20T16:00:00.000Z', imp: { capital: 500 } }] }, '2026-10-20').estado, 'cumplida');
});

test('resumen: la situación que se muestra de cada deudor', () => {
  const venc = { tasa: 5, estado: 'En gestión', cuotas: [{ id: 'a', n: 1, de: 1, vto: '2026-09-01', importe: 1000 }] };
  assert.equal(resumen(venc, '2026-10-20').clave, 'mora');
  assert.equal(resumen(venc, '2026-10-20').texto, 'En mora · 49 días');
  assert.equal(resumen({ ...venc, estado: 'En juicio' }, '2026-10-20').clave, 'juicio');
  assert.equal(resumen({ ...venc, estado: 'Cancelado' }, '2026-10-20').activo, false);
  const conPlan = { ...venc, planes: [{ id: 'p', estado: 'vigente', fecha: '2026-10-01', anticipo: 0, cuotas: [{ n: 1, vto: '2026-10-05', importe: 500 }, { n: 2, vto: '2026-11-05', importe: 500 }] }] };
  const r = resumen(conPlan, '2026-10-20');
  assert.equal(r.clave, 'plan-atrasado');
  assert.equal(r.saldo, 1000); // lo exigible es el saldo del plan, no la liquidación original
  assert.equal(resumen({ ...venc, cuotas: [] }, '2026-10-20').clave, 'al-dia');
});

test('textos: cuotas en palabras, nombres propios, fechas y pagos', () => {
  const l = (cs) => liquidar({ tasa: 0, cuotas: cs.map(([n, de], k) => ({ id: 'x' + k, n, de, vto: '2026-01-0' + (k + 1), importe: 10 })) }, '2026-02-01');
  assert.equal(detalleCuotas(l([[21, 24], [22, 24], [23, 24], [24, 24]])), 'las cuotas 21 a 24 de 24');
  assert.equal(detalleCuotas(l([[13, 24]])), 'la cuota 13 de 24');
  assert.equal(detalleCuotas(l([[12, 24], [13, 24]])), 'las cuotas 12 y 13 de 24');
  assert.equal(detalleCuotas(l([[5, 12], [7, 12], [8, 12], [9, 12], [12, 12]])), 'las cuotas 5, 7 a 9 y 12 de 12');
  assert.equal(detalleCuotas(l([[11, 0], [12, 24], [13, 24]])), 'el saldo de la cuota 11 y las cuotas 12 y 13 de 24');
  assert.equal(nombrePropio('GOMEZ ANA DE LAS NIEVES'), 'Gomez Ana de las Nieves');
  assert.equal(nombrePropio('DISTRIBUIDORA EJEMPLO SAS'), 'Distribuidora Ejemplo SAS');
  assert.equal(sumarMeses('2026-01-31', 1), '2026-02-28');
  assert.equal(diasEntre('2026-03-01', '2026-03-31'), 30);
  assert.equal(totalPago({ imp: { capital: 1000.1, intereses: 0.2 } }), 1000.3);
});

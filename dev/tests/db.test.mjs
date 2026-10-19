// Pruebas de la base contra GoTrue y PostgREST reales (dev/stack.sh up).
// Verifican lo que no se ve desde la app: quién puede leer qué, el control de
// revisiones, el historial de cambios y las funciones que usa Claude.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { sql, sqlFalla, anon, servicio, entrar, limpiar, crearCuenta, env } from './helpers.mjs';

const CLAVE_PROVISORIA = 'Provisoria-del-panel-1';
let emi;

before(() => limpiar());

test('una cuenta creada en el panel y autorizada puede entrar', async () => {
  assert.match(sqlFalla(`select gestor.autorizar('emi@test.local', 'Emi')`), /No existe una cuenta/);
  assert.equal(await crearCuenta('emi@test.local', CLAVE_PROVISORIA), 'emi@test.local ya puede usar el gestor');
  // autorizar de nuevo actualiza nombre y marca; el email se normaliza
  assert.equal(sql(`select gestor.autorizar(' Emi@Test.Local ', 'Emi', true)`), 'emi@test.local ya puede usar el gestor');
  assert.equal(sql(`select count(*) from gestor.miembros`), '1');
  emi = await entrar('emi@test.local', CLAVE_PROVISORIA);
  assert.equal(emi.sesion.user.email, 'emi@test.local');
  const { data, error } = await emi.rpc('mi_acceso');
  assert.ifError(error);
  assert.deepEqual(data, { autorizado: true, clave_temporal: true, nombre: 'Emi', email: 'emi@test.local' });
});

test('una clave equivocada no entra', async () => {
  const { error } = await anon().auth.signInWithPassword({ email: 'emi@test.local', password: 'no-es-esta' });
  assert.ok(error);
});

test('sin sesión no se lee ni se escribe nada', async () => {
  const c = anon();
  for (const t of ['causas', 'acuerdos', 'plantillas']) {
    const { data, error } = await c.from(t).select('*');
    assert.ok(error, `${t}: debería fallar sin sesión`);
    assert.equal(data, null);
  }
  const { error } = await c.from('causas').insert({ expte: '1' });
  assert.ok(error);
  assert.ok((await c.rpc('mi_acceso')).error, 'las funciones tampoco son para anónimos');
  assert.match((await c.from('causas').select('*')).error.message, /permission denied for table causas/);
  // tampoco el conteo estimado, que no pasa por las políticas de filas
  const r = await c.from('causas').select('*', { count: 'planned', head: true });
  assert.ok(r.error || r.status >= 400);
  assert.equal(r.count, null);
});

test('miembro: alta, lectura, edición con control de revisión y baja', async () => {
  const causa = {
    expte: '14000001', actor: 'AMB', demandado: 'PEREZ JUAN', tipo: 'EJECUTIVO', nom: '2', oficina: 'OEP',
    estado: 'Casillero', etiquetas: ['En trámite', 'Embargo de sueldo'], proxima: 'Pedir embargo', vence: '2026-10-09',
    ultima: 'Dimos cédula', fecha: '2026-10-01', notas: 'tel 123',
    historial: [{ fecha: '2026-10-01', texto: 'Dimos cédula' }],
    liquidacion: { fecha: '2026-10-01', embargo: 1000, rubros: [{ rubro: 'Capital', monto: 900, pagado: 0 }] },
  };
  let r = await emi.from('causas').insert(causa).select().single();
  assert.ifError(r.error);
  const rev0 = r.data.rev;
  assert.ok(Number.isSafeInteger(rev0) && rev0 > 0);
  assert.equal(r.data.actualizado_por, 'Emi');
  assert.deepEqual(r.data.etiquetas, causa.etiquetas);
  assert.deepEqual(r.data.historial, causa.historial);
  assert.equal(r.data.vence, '2026-10-09');

  // expediente repetido
  r = await emi.from('causas').insert({ expte: '14000001' }).select();
  assert.equal(r.error?.code, '23505');
  // expediente no numérico
  r = await emi.from('causas').insert({ expte: '14-A' }).select();
  assert.equal(r.error?.code, '23514');

  // edición con la revisión correcta
  r = await emi.from('causas').update({ estado: 'A despacho', vence: null }).eq('expte', '14000001').eq('rev', rev0).select();
  assert.ifError(r.error);
  assert.equal(r.data.length, 1);
  const rev1 = r.data[0].rev;
  assert.ok(rev1 > rev0);
  assert.equal(r.data[0].vence, null);

  // edición con una revisión vieja: no pisa nada
  r = await emi.from('causas').update({ estado: 'Sentencia' }).eq('expte', '14000001').eq('rev', rev0).select();
  assert.ifError(r.error);
  assert.equal(r.data.length, 0);
  assert.equal(sql(`select estado from public.causas where expte='14000001'`), 'A despacho');

  // guardar sin cambios no sube la revisión ni ensucia el historial
  r = await emi.from('causas').update({ estado: 'A despacho' }).eq('expte', '14000001').eq('rev', rev1).select();
  assert.equal(r.data[0].rev, rev1);
  assert.equal(sql(`select count(*) from gestor.cambios where tabla='causas' and clave='14000001'`), '2');

  // el cliente no puede falsear revisión ni autor
  r = await emi.from('causas').update({ notas: 'x', rev: 999999999, actualizado_por: 'otro' }).eq('expte', '14000001').select();
  assert.ok(r.data[0].rev > rev1 && r.data[0].rev < 999999999);
  assert.equal(r.data[0].actualizado_por, 'Emi');
});

test('una causa eliminada y vuelta a crear no se confunde con la anterior', async () => {
  // Quien tenía abierta la primera versión guarda con su revisión vieja: no puede pisar la nueva.
  let r = await emi.from('causas').insert({ expte: '555', demandado: 'PRIMERA', notas: 'vieja' }).select().single();
  const revVieja = r.data.rev;
  sql(`delete from public.causas where expte='555'`);
  sql(`insert into public.causas (expte, demandado, notas) values ('555', 'SEGUNDA', 'nueva, cargada después')`);
  r = await emi.from('causas').update({ notas: 'vieja' }).eq('expte', '555').eq('rev', revVieja).select();
  assert.deepEqual(r.data, []);
  assert.equal(sql(`select demandado || '|' || notas from public.causas where expte='555'`), 'SEGUNDA|nueva, cargada después');
  sql(`delete from public.causas where expte='555'`);
});

test('acuerdos y plantillas: ida y vuelta', async () => {
  let r = await emi.from('acuerdos').insert({
    deudor: 'GOMEZ ANA', expte: '14000001', notas: '', creado: '2026-10-05',
    cuotas: [{ vence: '2026-10-10', monto: 50000, estado: 'pendiente', pago: '' }],
  }).select().single();
  assert.ifError(r.error);
  assert.match(r.data.id, /^[0-9a-f-]{36}$/);
  const id = r.data.id;
  r = await emi.from('acuerdos').update({ cuotas: [{ vence: '2026-10-10', monto: 50000, estado: 'pagada', pago: '2026-10-05' }] })
    .eq('id', id).eq('rev', r.data.rev).select();
  assert.equal(r.data[0].cuotas[0].estado, 'pagada');

  r = await emi.from('plantillas').insert({ titulo: 'Solicita', cuerpo: 'Sr. Juez: {{caratula}}' }).select().single();
  assert.ifError(r.error);
  r = await emi.from('plantillas').insert({ id: 'con-id-propio', titulo: 'T', cuerpo: 'C' }).select().single();
  assert.equal(r.data.id, 'con-id-propio');
  r = await emi.from('plantillas').delete().eq('id', 'con-id-propio').select();
  assert.equal(r.data.length, 1);
});

test('una cuenta sin autorización no ve ni toca nada', async () => {
  const s = servicio();
  const { error } = await s.auth.admin.createUser({ email: 'intruso@test.local', password: 'Intruso-123456', email_confirm: true });
  assert.ifError(error);
  const x = await entrar('intruso@test.local', 'Intruso-123456');
  const rechazado = (r, que) => {
    assert.equal(r.error?.code, '42501', `${que}: tendría que rechazarse`);
    assert.match(r.error.message, /cuenta no autorizada/);
    assert.equal(r.data, null);
  };
  rechazado(await x.rpc('mi_acceso'), 'mi_acceso');
  rechazado(await x.rpc('clave_definida'), 'clave_definida');
  for (const t of ['causas', 'acuerdos', 'plantillas']) rechazado(await x.from(t).select('*'), `leer ${t}`);
  rechazado(await x.from('causas').insert({ expte: '999' }).select(), 'alta');
  rechazado(await x.from('causas').update({ notas: 'hackeado' }).eq('expte', '14000001').select(), 'edición');
  rechazado(await x.from('causas').delete().eq('expte', '14000001').select(), 'baja');
  assert.equal(sql(`select notas from public.causas where expte='14000001'`), 'x');
  // Ni conteos: el estimado sale del planificador sin pasar por las políticas de filas.
  for (const count of ['planned', 'estimated', 'exact']) {
    const r = await x.from('causas').select('*', { count, head: true }).gte('demandado', 'A');
    assert.ok(r.error || r.status === 403, `conteo ${count}: tendría que rechazarse`);
    assert.equal(r.count, null);
  }
});

test('aunque la puerta de la API no estuviera, las políticas y las estadísticas no dejan ver nada', () => {
  // Segunda y tercera barrera, probadas directo en la base como una cuenta con sesión que no es miembro.
  const comoIntruso = (q) => sql(`begin; set local role authenticated; select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001"}', true); ${q}; rollback;`);
  assert.equal(comoIntruso(`select count(*) from public.causas`).split('\n').pop(), '0');
  // Sin estadísticas por columna, lo que estima el planificador no depende de qué hay cargado.
  sql(`analyze public.causas; analyze public.acuerdos; analyze public.plantillas`);
  assert.equal(sql(`select count(*) from pg_stats where schemaname='public' and tablename in ('causas','acuerdos','plantillas')`), '0');
  assert.equal(sql(`select count(*) from pg_attribute a join pg_class c on c.oid = a.attrelid
                     where c.relnamespace = 'public'::regnamespace and c.relname in ('causas','acuerdos','plantillas')
                       and a.attnum > 0 and not a.attisdropped and a.attstattarget is distinct from 0`), '0',
    'toda columna de estas tablas tiene que tener las estadísticas desactivadas (gestor.sin_estadisticas)');
  const estimado = (filtro) => /rows=(\d+)/.exec(comoIntruso(`explain select * from public.causas where ${filtro}`))[1];
  assert.equal(estimado(`demandado = 'PEREZ JUAN'`), estimado(`demandado = 'NO EXISTE NADIE ASI'`));
  assert.equal(estimado(`demandado >= 'A' and demandado < 'M'`), estimado(`demandado >= 'M' and demandado < 'Z'`));
});

test('el esquema privado no es alcanzable por la API', async () => {
  for (const t of ['miembros', 'cambios', 'usuarios']) {
    const r = await emi.schema('gestor').from(t).select('*');
    assert.ok(r.error, `gestor.${t} no debería ser accesible`);
  }
  const r = await emi.schema('gestor').rpc('autorizar', { p_email: 'intruso@test.local' });
  assert.ok(r.error);
  assert.ok((await emi.rpc('autorizar', { p_email: 'intruso@test.local' })).error, 'tampoco existe como función pública');
  // ni siquiera con SQL en nombre de un usuario de la app
  const err = sqlFalla(`set role authenticated; select gestor.autorizar('intruso@test.local')`);
  assert.match(err, /permission denied/);
  assert.equal(sql(`select count(*) from gestor.miembros where email = 'intruso@test.local'`), '0');
});

test('cambio de clave: deja de ser temporal y la vieja ya no sirve', async () => {
  const { error } = await emi.auth.updateUser({ password: 'Clave-definitiva-2026' });
  assert.ifError(error);
  assert.ifError((await emi.rpc('clave_definida')).error);
  assert.equal((await emi.rpc('mi_acceso')).data.clave_temporal, false);
  assert.ok((await anon().auth.signInWithPassword({ email: 'emi@test.local', password: CLAVE_PROVISORIA })).error);
  emi = await entrar('emi@test.local', 'Clave-definitiva-2026');
});

test('funciones de Claude: movimiento, presentación, próxima acción y realizada', () => {
  // movimiento con fecha anterior al último: la "última acción" sigue siendo la más reciente
  sql(`select gestor.movimiento('14000001', 'Se libró oficio', '2026-09-20')`);
  assert.equal(sql(`select ultima || '|' || fecha || '|' || estado from public.causas where expte='14000001'`),
    'Dimos cédula|2026-10-01|A despacho');
  // mismo día que el último: gana el anotado después
  sql(`select gestor.movimiento('14000001', 'Diligenciada', '2026-10-01')`);
  assert.equal(sql(`select ultima from public.causas where expte='14000001'`), 'Diligenciada');
  // presentación: movimiento + A despacho
  sql(`update public.causas set estado='Casillero' where expte='14000001'`);
  const hoy = sql(`select gestor.hoy()`);
  sql(`select gestor.presentacion('14000001', 'Solicita aprobación de liquidación')`);
  assert.equal(sql(`select ultima || '|' || fecha || '|' || estado from public.causas where expte='14000001'`),
    `Solicita aprobación de liquidación|${hoy}|A despacho`);
  assert.equal(sql(`select actualizado_por from public.causas where expte='14000001'`), 'Claude');
  // próxima acción y realizada
  sql(`select gestor.proxima('14000001', 'Designar martillero', '2026-10-15')`);
  assert.equal(sql(`select proxima || '|' || vence from public.causas where expte='14000001'`), 'Designar martillero|2026-10-15');
  // realizada antes de que venza: queda con la fecha de hoy, no con una futura
  sql(`select gestor.proxima('14000001', 'Controlar plazo', (gestor.hoy() + 60))`);
  sql(`select gestor.realizada('14000001')`);
  assert.equal(sql(`select proxima || '|' || coalesce(vence::text,'') || '|' || ultima || '|' || fecha from public.causas where expte='14000001'`),
    `||Controlar plazo|${hoy}`);
  assert.equal(sql(`select historial -> -1 ->> 'hecha' from public.causas where expte='14000001'`), 'true');
  // realizada después de vencida: queda con la fecha en que vencía
  sql(`select gestor.proxima('14000001', 'Designar martillero', (gestor.hoy() - 3))`);
  sql(`select gestor.realizada('14000001')`);
  assert.equal(sql(`select (historial -> -1 ->> 'fecha') = (gestor.hoy() - 3)::text from public.causas where expte='14000001'`), 't');
  assert.equal(sql(`select ultima || '|' || fecha from public.causas where expte='14000001'`), `Controlar plazo|${hoy}`);
  // errores claros
  assert.match(sqlFalla(`select gestor.movimiento('1', 'x')`), /No existe la causa/);
  assert.match(sqlFalla(`select gestor.movimiento('14000001', '  ')`), /Falta el texto/);
  assert.match(sqlFalla(`select gestor.movimiento('14000001', 'x', null, 'A Despacho')`), /Estado desconocido/);
  assert.match(sqlFalla(`select gestor.realizada('14000001')`), /no tiene próxima acción/);
});

test('historial de cambios: quién, qué y el estado anterior', () => {
  const filas = sql(`select operacion || ':' || autor from gestor.cambios where tabla='causas' and clave='14000001' order by id`).split('\n');
  assert.equal(filas[0], 'alta:Emi');
  assert.ok(filas.includes('cambio:Emi'));
  assert.ok(filas.includes('cambio:Claude'));
  assert.ok(filas.includes('cambio:SQL directo'), 'el update manual sin autor queda como SQL directo');
  // se puede reconstruir el valor anterior
  assert.equal(sql(`select antes ->> 'estado' from gestor.cambios where tabla='causas' and clave='14000001' and operacion='cambio' order by id limit 1`), 'Casillero');
});

test('deshacer: un cambio y una baja; nunca elimina', () => {
  sql(`insert into public.causas (expte, demandado, estado, etiquetas, vence, historial, liquidacion)
       values ('777', 'PRUEBA', 'Casillero', '{"En trámite","Martillero"}', '2026-11-01', '[{"fecha":"2026-10-01","texto":"uno"}]', '{"fecha":"2026-10-01","embargo":5,"rubros":[]}')`);
  const antes = sql(`select to_jsonb(c) - 'rev' - 'actualizado' - 'actualizado_por' from public.causas c where expte='777'`);
  // un cambio
  sql(`select gestor.movimiento('777', 'dos', '2026-10-02', 'A despacho')`);
  let id = sql(`select max(id) from gestor.cambios where tabla='causas' and clave='777'`);
  assert.match(sql(`select gestor.deshacer(${id})`), /volvió a como estaba antes/);
  assert.equal(sql(`select to_jsonb(c) - 'rev' - 'actualizado' - 'actualizado_por' from public.causas c where expte='777'`), antes);
  // una baja
  sql(`delete from public.causas where expte='777'`);
  id = sql(`select max(id) from gestor.cambios where tabla='causas' and clave='777' and operacion='baja'`);
  sql(`select gestor.deshacer(${id})`);
  assert.equal(sql(`select to_jsonb(c) - 'rev' - 'actualizado' - 'actualizado_por' from public.causas c where expte='777'`), antes);
  // sin liquidación sigue sin liquidación
  sql(`update public.causas set liquidacion = null where expte='777'`);
  sql(`update public.causas set notas = 'x' where expte='777'`);
  id = sql(`select max(id) from gestor.cambios where tabla='causas' and clave='777'`);
  sql(`select gestor.deshacer(${id})`);
  assert.equal(sql(`select (liquidacion is null) || '|' || notas from public.causas where expte='777'`), 'true|');
  // con cambios posteriores no pisa nada, salvo que se lo pidan
  id = sql(`select min(id) from gestor.cambios where tabla='causas' and clave='777' and operacion='cambio'`);
  assert.match(sqlFalla(`select gestor.deshacer(${id})`), /hubo \d+ cambio\(s\) más en causas 777/);
  assert.equal(sql(`select notas from public.causas where expte='777'`), '');
  assert.match(sql(`select gestor.deshacer(${id}, true)`), /volvió a como estaba antes/);
  assert.equal(sql(`select to_jsonb(c) - 'rev' - 'actualizado' - 'actualizado_por' from public.causas c where expte='777'`), antes);
  // un alta no se deshace: sería eliminar
  id = sql(`select min(id) from gestor.cambios where tabla='causas' and clave='777' and operacion='alta'`);
  assert.match(sqlFalla(`select gestor.deshacer(${id}, true)`), /no elimina nada/);
  assert.equal(sql(`select count(*) from public.causas where expte='777'`), '1');
  sql(`delete from public.causas where expte='777'`);
  // acuerdos y plantillas
  const aid = sql(`insert into public.acuerdos (deudor, cuotas) values ('D', '[{"vence":"2026-10-10","monto":1,"estado":"pendiente","pago":""}]') returning id`);
  sql(`update public.acuerdos set cuotas = '[]' where id='${aid}'`);
  sql(`select gestor.deshacer((select max(id) from gestor.cambios where tabla='acuerdos' and clave='${aid}'))`);
  assert.equal(sql(`select jsonb_array_length(cuotas) from public.acuerdos where id='${aid}'`), '1');
  sql(`insert into public.plantillas (id, titulo, cuerpo) values ('p-deshacer', 'T', 'C'); delete from public.plantillas where id='p-deshacer'`);
  sql(`select gestor.deshacer((select max(id) from gestor.cambios where tabla='plantillas' and clave='p-deshacer'))`);
  assert.equal(sql(`select titulo || cuerpo from public.plantillas where id='p-deshacer'`), 'TC');
  sql(`delete from public.acuerdos where id='${aid}'; delete from public.plantillas where id='p-deshacer'`);
  assert.match(sqlFalla(`select gestor.deshacer(-1)`), /No existe el cambio/);
});

test('autorizar una cuenta que ya existe, sin tocarle la clave', async () => {
  const { error } = await servicio().auth.admin.createUser({ email: 'socia@test.local', password: 'Socia-123456789', email_confirm: true });
  assert.ifError(error);
  assert.match(sqlFalla(`select gestor.autorizar('nadie@test.local')`), /No existe una cuenta/);
  assert.equal(sql(`select gestor.autorizar('Socia@test.local', 'Socia')`), 'socia@test.local ya puede usar el gestor');
  sql(`select gestor.autorizar('socia@test.local')`); // repetirlo sin nombre no lo borra
  const s = await entrar('socia@test.local', 'Socia-123456789');
  assert.deepEqual((await s.rpc('mi_acceso')).data, { autorizado: true, clave_temporal: false, nombre: 'Socia', email: 'socia@test.local' });
  assert.equal(sql(`select email || '|' || nombre from gestor.usuarios where email='socia@test.local'`), 'socia@test.local|Socia');
  assert.equal(sql(`select gestor.quitar_usuario('socia@test.local')`), 'socia@test.local ya no puede usar el gestor');
});

test('lo que cambia Claude lo ve la app en la siguiente lectura, y su revisión vieja ya no pisa', async () => {
  const antes = (await emi.from('causas').select('*').eq('expte', '14000001').single()).data;
  sql(`select gestor.movimiento('14000001', 'Decreto: autos', '2026-10-20')`);
  const r = await emi.from('causas').update({ notas: 'edición vieja' }).eq('expte', '14000001').eq('rev', antes.rev).select();
  assert.deepEqual(r.data, []);
  const ahora = (await emi.from('causas').select('*').eq('expte', '14000001').single()).data;
  assert.equal(ahora.ultima, 'Decreto: autos');
  assert.ok(ahora.rev > antes.rev);
});

test('demandados y títulos: se cargan, la app los lee y el reclamado suma interés simple', async () => {
  assert.match(sqlFalla(`select gestor.agregar_titulo('14000001', 'letra', 1000)`), /pagare/);
  assert.match(sqlFalla(`select gestor.agregar_titulo('14000001', 'pagare', -5)`), /no negativo/);
  assert.match(sqlFalla(`select gestor.agregar_demandado('0', 'Nadie')`), /No existe la causa/);
  sql(`select gestor.agregar_demandado('14000001', 'Lucas Piedra', '20-1', '3534000000', 'Bv. Colón 1', 'trabaja de día')`);
  sql(`select gestor.agregar_titulo('14000001', 'pagare', 100000, '2026-04-07', 'Pagaré 1')`);
  sql(`select gestor.agregar_titulo('14000001', 'prenda', 200000, '2026-07-06', 'Prenda', 'Ford Fiesta AA123BB')`);
  const fila = (await emi.from('causas').select('demandados, titulos').eq('expte', '14000001').single()).data;
  assert.equal(fila.demandados[0].telefono, '3534000000');
  assert.equal(fila.titulos[1].vehiculo, 'Ford Fiesta AA123BB');
  const r = JSON.parse(sql(`select gestor.reclamado('14000001', '2026-10-07')`));
  assert.deepEqual([r.capital, r.interes, r.total], [300000, 61500, 361500]);
  assert.equal(r.titulos[0].dias, 183);
  // sin vencimiento o con vencimiento futuro no hay interés
  assert.equal(JSON.parse(sql(`select gestor.reclamado('14000001', '2026-04-01')`)).interes, 0);
  // deshacer devuelve las listas a como estaban
  const id = sql(`select max(id) from gestor.cambios where tabla = 'causas' and clave = '14000001'`);
  sql(`select gestor.deshacer(${id})`);
  assert.equal(sql(`select jsonb_array_length(titulos) from public.causas where expte = '14000001'`), '1');
});

test('agenda: solo para miembros, con causa existente y estados conocidos', async () => {
  let r = await emi.from('agenda').insert({ expte: '14000001', titulo: 'Solicita', cuerpo: 'Texto', fecha: '2026-10-20' }).select().single();
  assert.ifError(r.error);
  assert.equal(r.data.estado, 'borrador', 'nace como borrador: falta que la persona lo confirme');
  assert.equal(r.data.actualizado_por, 'Emi');
  const id = r.data.id;
  // causa inexistente, estado desconocido, texto vacío
  assert.equal((await emi.from('agenda').insert({ expte: '999999', titulo: 'T', cuerpo: 'C', fecha: '2026-10-20' }).select()).error?.code, '23503');
  assert.equal((await emi.from('agenda').update({ estado: 'enviado' }).eq('id', id).select()).error?.code, '23514');
  assert.equal((await emi.from('agenda').insert({ expte: '14000001', titulo: ' ', cuerpo: 'C', fecha: '2026-10-20' }).select()).error?.code, '23514');
  // sin sesión, nada
  r = await anon().from('agenda').select('*');
  assert.ok(r.error);
  assert.match(r.error.message, /permission denied for table agenda/);
  // una cuenta sin autorización tampoco (la puerta de la API la frena)
  const x = await entrar('intruso@test.local', 'Intruso-123456');
  r = await x.from('agenda').select('*');
  assert.equal(r.error?.code, '42501');
  assert.equal(r.data, null);
  // y aunque la puerta no estuviera, la política de filas no muestra nada
  const comoIntruso = sql(`begin; set local role authenticated; select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001"}', true); select count(*) from public.agenda; rollback;`);
  assert.equal(comoIntruso.split('\n').pop(), '0');
  sql(`analyze public.agenda`);
  assert.equal(sql(`select count(*) from pg_stats where schemaname='public' and tablename='agenda'`), '0');
  sql(`delete from public.agenda where id='${id}'`);
});

test('el chat de la app firma sus cambios como Claude', async () => {
  // Es lo que hace la función `chat`: pide con la sesión de la persona y el encabezado x-gestor-via.
  const chat = createClient(env.SUPABASE_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { 'x-gestor-via': 'chat' } } });
  const { error } = await chat.auth.signInWithPassword({ email: 'emi@test.local', password: 'Clave-definitiva-2026' });
  assert.ifError(error);
  let r = await chat.from('causas').update({ notas: 'anotado por el chat' }).eq('expte', '14000001').select().single();
  assert.ifError(r.error);
  assert.equal(r.data.actualizado_por, 'Claude');
  assert.equal(sql(`select autor from gestor.cambios where tabla='causas' and clave='14000001' order by id desc limit 1`), 'Claude');
  r = await chat.from('agenda').insert({ expte: '14000001', titulo: 'T', cuerpo: 'C', fecha: '2026-10-20' }).select().single();
  assert.equal(r.data.actualizado_por, 'Claude');
  sql(`delete from public.agenda where id='${r.data.id}'`);
  // sin el encabezado, el mismo usuario firma con su nombre
  r = await emi.from('causas').update({ notas: 'x' }).eq('expte', '14000001').select().single();
  assert.equal(r.data.actualizado_por, 'Emi');
  // y un valor cualquiera en el encabezado no cambia nada
  const otro = createClient(env.SUPABASE_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { 'x-gestor-via': 'otra cosa' } } });
  await otro.auth.signInWithPassword({ email: 'emi@test.local', password: 'Clave-definitiva-2026' });
  r = await otro.from('causas').update({ notas: 'y' }).eq('expte', '14000001').select().single();
  assert.equal(r.data.actualizado_por, 'Emi');
  sql(`update public.causas set notas = 'x' where expte = '14000001'`);
});

test('tarea del SAC: toma lo confirmado para hoy, lo anota en la causa y cierra el pedido', () => {
  const hoy = sql(`select gestor.hoy()`);
  sql(`insert into public.causas (expte, demandado, estado, proxima, vence, historial) values
       ('881', 'UNO', 'Casillero', 'Solicitar aprobación de liquidación', gestor.hoy(), '[]'),
       ('882', 'DOS', 'Casillero', 'Otra cosa', null, '[]')`);
  const nuevo = (expte, fecha, estado, realizar = '') =>
    sql(`insert into public.agenda (expte, titulo, cuerpo, fecha, estado, realizar) values ('${expte}', 'Solicita aprobación de liquidación', 'Que vengo…', ${fecha}, '${estado}', '${realizar}') returning id`);
  const borrador = nuevo('881', 'gestor.hoy()', 'borrador');
  const futuro = nuevo('881', 'gestor.hoy() + 3', 'pendiente');
  const deHoy = nuevo('881', 'gestor.hoy()', 'pendiente', 'Solicitar aprobación de liquidación');
  const atrasado = nuevo('882', 'gestor.hoy() - 2', 'pendiente', 'Lo que había antes');
  // solo lo confirmado, de hoy o atrasado
  const del = sql(`select id || '|' || caratula || '|' || atrasado from gestor.agenda_del_dia()`).split('\n');
  assert.deepEqual(del.sort(), [`${atrasado}|AMB c/ DOS|true`, `${deHoy}|AMB c/ UNO|false`].sort());
  assert.ok(!del.some((l) => l.startsWith(borrador) || l.startsWith(futuro)));

  // presentado, con la próxima acción que se pidió dar por realizada
  assert.match(sql(`select gestor.agenda_presentada('${deHoy}')`), /quedó A despacho/);
  assert.equal(sql(`select estado || '|' || proxima || '|' || coalesce(vence::text, '') || '|' || ultima || '|' || fecha || '|' || actualizado_por from public.causas where expte='881'`),
    `A despacho|||Solicitar aprobación de liquidación|${hoy}|Claude`);
  assert.equal(sql(`select historial -> -1 ->> 'hecha' from public.causas where expte='881'`), 'true');
  assert.equal(sql(`select estado || '|' || resultado || '|' || (presentado is not null) from public.agenda where id='${deHoy}'`), 'presentado|Presentado en el SAC|true');
  // no se anota dos veces
  assert.match(sqlFalla(`select gestor.agenda_presentada('${deHoy}')`), /no está pendiente/);

  // atrasado y con la próxima acción cambiada: se presenta, pero no se toca la próxima acción
  assert.match(sql(`select gestor.agenda_presentada('${atrasado}', 'Presentado 10:16')`), /había cambiado/);
  assert.equal(sql(`select estado || '|' || proxima || '|' || ultima from public.causas where expte='882'`), 'A despacho|Otra cosa|Solicita aprobación de liquidación');
  assert.match(sql(`select resultado from public.agenda where id='${atrasado}'`), /^Presentado 10:16 \(estaba agendado para el \d\d\/\d\d\)\. La próxima acción no se dio por realizada/);

  // si falla, queda el motivo y la causa no se toca
  const otro = nuevo('882', 'gestor.hoy()', 'pendiente');
  const antes = sql(`select rev from public.causas where expte='882'`);
  assert.match(sqlFalla(`select gestor.agenda_fallida('${otro}', ' ')`), /Falta el motivo/);
  assert.match(sql(`select gestor.agenda_fallida('${otro}', 'La compu estaba apagada')`), /quedó con error/);
  assert.equal(sql(`select estado || '|' || resultado from public.agenda where id='${otro}'`), 'error|La compu estaba apagada');
  assert.equal(sql(`select rev from public.causas where expte='882'`), antes);
  assert.match(sqlFalla(`select gestor.agenda_fallida('${otro}', 'otra vez')`), /No hay un pedido pendiente/);
  assert.match(sqlFalla(`select gestor.agenda_presentada('${borrador}')`), /no está pendiente \(está "borrador"\)/);

  // deshacer también sirve en la agenda
  sql(`update public.agenda set fecha = gestor.hoy() + 10 where id='${futuro}'`);
  sql(`select gestor.deshacer((select max(id) from gestor.cambios where tabla='agenda' and clave='${futuro}'))`);
  assert.equal(sql(`select fecha - gestor.hoy() from public.agenda where id='${futuro}'`), '3');

  // si la causa cambia de expediente, la agenda la sigue; si se elimina, se va con ella
  sql(`update public.causas set expte = '883' where expte = '881'`);
  assert.equal(sql(`select count(*) from public.agenda where expte = '883'`), '3');
  sql(`delete from public.causas where expte in ('882', '883')`);
  assert.equal(sql(`select count(*) from public.agenda`), '0');
});

test('a qué hora se puede tomar un escrito: lo de hoy desde las 10:15, lo pedido «Ahora» en el momento', () => {
  // Córdoba es UTC−3: 12:00Z son las 9:00 y 13:15Z las 10:15. La fecha cuenta en Córdoba, no en UTC.
  const casos = [
    ["'2026-10-19', null, false, '2026-10-19 13:14Z'", 'f', 'de hoy, a las 10:14: todavía no'],
    ["'2026-10-19', null, false, '2026-10-19 13:15Z'", 't', 'de hoy, a las 10:15'],
    ["'2026-10-19', null, false, '2026-10-20 02:30Z'", 't', 'de hoy, a las 23:30 de Córdoba (ya es mañana en UTC)'],
    ["'2026-10-18', null, false, '2026-10-19 12:00Z'", 't', 'atrasado, a las 9:00'],
    ["'2026-10-19', now(), false, '2026-10-19 12:00Z'", 't', 'pedido «Ahora», a las 9:00'],
    ["'2026-10-19', now(), true, '2026-10-19 12:00Z'", 't', 'pedido «Ahora», en la corrida del botón'],
    ["'2026-10-18', null, true, '2026-10-19 16:00Z'", 'f', 'atrasado sin «Ahora»: la corrida del botón no lo toma'],
    ["'2026-10-19', null, true, '2026-10-19 16:00Z'", 'f', 'de hoy sin «Ahora»: la corrida del botón no lo toma'],
    ["'2026-10-20', now(), false, '2026-10-19 16:00Z'", 'f', 'con fecha futura nunca'],
  ];
  for (const [args, esperado, que] of casos) assert.equal(sql(`select gestor.agenda_a_tiempo(${args})`), esperado, que);
});

test('tarea del SAC: toma de a uno, primero lo pedido «Ahora», y nunca lo mismo dos veces', async () => {
  sql(`delete from public.agenda; delete from public.causas where expte in ('891', '892')`);
  sql(`insert into public.causas (expte, actor, demandado, tipo, estado, historial) values
       ('891', 'AMB', 'UNO', 'EJECUTIVO', 'Casillero', '[]'), ('892', 'AMB', 'DOS', '', 'Casillero', '[]')`);
  const nuevo = (expte, titulo, fecha, estado = 'pendiente', ahora = 'null') =>
    sql(`insert into public.agenda (expte, titulo, cuerpo, fecha, estado, ahora) values ('${expte}', '${titulo}', 'Texto', ${fecha}, '${estado}', ${ahora}) returning id`);
  const atrasado = nuevo('891', 'Atrasado', 'gestor.hoy() - 1');
  const deHoy = nuevo('891', 'De hoy', 'gestor.hoy()');
  const ahora1 = nuevo('892', 'Ahora 1', 'gestor.hoy()', 'pendiente', "now() - interval '1 minute'");
  const ahora2 = nuevo('891', 'Ahora 2', 'gestor.hoy()', 'pendiente', 'now()');
  nuevo('891', 'Borrador', 'gestor.hoy()', 'borrador', 'now()');
  nuevo('891', 'Futuro', 'gestor.hoy() + 2');
  const tomar = (soloAhora) => sql(`select id || '|' || caratula || '|' || ahora || '|' || atrasado from gestor.agenda_tomar(${soloAhora})`);

  // la corrida del botón: solo lo pedido «Ahora», de a uno, y cada uno queda "presentando"
  assert.equal(tomar(true), `${ahora1}|AMB c/ DOS|true|false`, 'el que se pidió primero');
  assert.equal(sql(`select estado || '|' || actualizado_por from public.agenda where id = '${ahora1}'`), 'presentando|Claude');
  assert.equal(tomar(true), `${ahora2}|AMB c/ UNO – EJECUTIVO|true|false`);
  assert.equal(tomar(true), '', 'no queda nada pedido «Ahora»: lo atrasado y lo de hoy esperan su corrida');
  assert.equal(sql(`select string_agg(titulo, ',' order by titulo) from public.agenda where estado = 'pendiente'`), 'Atrasado,De hoy,Futuro');
  // lo tomado ya no figura para la tarea y no se cancela desde la agenda del día
  assert.equal(sql(`select count(*) from gestor.agenda_del_dia() where id in ('${ahora1}', '${ahora2}')`), '0');

  // la corrida de las 10:15: lo atrasado siempre; lo de hoy, solo si ya son las 10:15
  assert.equal(tomar(false).split('|')[0], atrasado);
  const yaEsLaHora = sql(`select (now() at time zone 'America/Argentina/Cordoba')::time >= gestor.hora_tarea()`) === 't';
  assert.equal(tomar(false).split('|')[0], yaEsLaHora ? deHoy : '');
  assert.equal(tomar(false), '', 'lo futuro no se toma');

  // un escrito tomado se cierra igual que uno pendiente; ya cerrado, no se vuelve a cerrar
  assert.match(sql(`select gestor.agenda_presentada('${ahora1}', 'Presentado en el SAC a las 11:40')`), /quedó A despacho/);
  assert.match(sql(`select gestor.agenda_fallida('${ahora2}', 'El SAC pidió iniciar sesión')`), /quedó con error/);
  assert.equal(sql(`select string_agg(estado, ',' order by titulo) from public.agenda where id in ('${ahora1}', '${ahora2}')`), 'presentado,error');
  assert.match(sqlFalla(`select gestor.agenda_presentada('${ahora1}')`), /no está pendiente \(está "presentado"\)/);

  // dos corridas a la vez nunca toman el mismo escrito: la segunda saltea el que la primera está tomando
  sql(`delete from public.agenda`);
  const a = nuevo('891', 'A', 'gestor.hoy()', 'pendiente', "now() - interval '1 minute'");
  const b = nuevo('892', 'B', 'gestor.hoy()', 'pendiente', 'now()');
  const pg = (await import('pg')).default;
  const conectar = async () => { const c = new pg.Client({ host: '127.0.0.1', port: 54322, user: 'postgres', password: 'postgres', database: 'postgres' }); await c.connect(); return c; };
  const [c1, c2] = await Promise.all([conectar(), conectar()]);
  try {
    await c1.query('begin'); await c2.query('begin');
    const r1 = await c1.query('select id from gestor.agenda_tomar(true)');
    const r2 = await c2.query('select id from gestor.agenda_tomar(true)'); // la primera todavía no confirmó
    assert.deepEqual([r1.rows[0]?.id, r2.rows[0]?.id], [a, b]);
    await c1.query('commit'); await c2.query('commit');
  } finally { await c1.end(); await c2.end(); }
  assert.equal(tomar(true), '');
  assert.equal(sql(`select string_agg(estado, ',') from public.agenda`), 'presentando,presentando');

  // el estado nuevo es válido; uno inventado no
  assert.match(sqlFalla(`update public.agenda set estado = 'enviando' where id = '${a}'`), /agenda_estado_check/);
  // deshacer restaura también la marca «Ahora»
  sql(`update public.agenda set ahora = null, estado = 'pendiente' where id = '${b}'`);
  sql(`select gestor.deshacer((select max(id) from gestor.cambios where tabla = 'agenda' and clave = '${b}'))`);
  assert.equal(sql(`select estado || '|' || (ahora is not null) from public.agenda where id = '${b}'`), 'presentando|true');
  sql(`delete from public.agenda; delete from public.causas where expte in ('891', '892')`);
});

test('las funciones de la tarea del SAC no se alcanzan desde la API', async () => {
  for (const f of ['agenda_del_dia', 'agenda_presentada', 'agenda_fallida', 'agenda_tomar', 'agenda_a_tiempo', 'hora_tarea']) {
    assert.ok((await emi.schema('gestor').rpc(f, {})).error, `gestor.${f} no debería ser accesible`);
    assert.ok((await emi.rpc(f, {})).error, `${f} tampoco existe como función pública`);
  }
  assert.match(sqlFalla(`set role authenticated; select * from gestor.agenda_del_dia()`), /permission denied/);
});

test('quitar un usuario le corta el acceso en el acto, aunque su sesión siga abierta', async () => {
  assert.ifError((await emi.from('causas').select('expte')).error);
  sql(`select gestor.quitar_usuario('emi@test.local')`);
  const r = await emi.from('causas').select('*');
  assert.equal(r.error?.code, '42501');
  assert.match(r.error.message, /cuenta no autorizada/);
  assert.equal(sql(`select count(*) from auth.users where email='emi@test.local'`), '1', 'la cuenta no se borra: eso es del panel');
  assert.match(sqlFalla(`select gestor.quitar_usuario('emi@test.local')`), /No hay un usuario autorizado/);
});

test('las funciones del esquema no escriben en las tablas de login', () => {
  const fuentes = sql(`select string_agg(p.prosrc, ' ') from pg_proc p where p.pronamespace = 'gestor'::regnamespace`).toLowerCase();
  assert.doesNotMatch(fuentes, /(insert\s+into|update|delete\s+from)\s+auth\./);
});

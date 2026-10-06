// Pruebas de la base contra GoTrue y PostgREST reales (dev/stack.sh up).
// Verifican lo que no se ve desde la app: quién puede leer qué, el control de
// revisiones, el historial de cambios y las funciones que usa Claude.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, sqlFalla, anon, servicio, entrar, limpiar } from './helpers.mjs';

let claveEmi, emi;

before(() => limpiar());

test('alta de usuario por SQL: puede iniciar sesión con la clave temporal', async () => {
  claveEmi = sql(`select gestor.crear_usuario('Emi@Test.Local ', 'Emi')`);
  assert.match(claveEmi, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  emi = await entrar('emi@test.local', claveEmi);
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
  const r = await emi.schema('gestor').rpc('crear_usuario', { p_email: 'a@b.co' });
  assert.ok(r.error);
  // ni siquiera con SQL en nombre de un usuario de la app
  const err = sqlFalla(`set role authenticated; select gestor.crear_usuario('a@b.co')`);
  assert.match(err, /permission denied/);
});

test('cambio de clave: deja de ser temporal y la vieja ya no sirve', async () => {
  const { error } = await emi.auth.updateUser({ password: 'Clave-definitiva-2026' });
  assert.ifError(error);
  assert.ifError((await emi.rpc('clave_definida')).error);
  assert.equal((await emi.rpc('mi_acceso')).data.clave_temporal, false);
  assert.ok((await anon().auth.signInWithPassword({ email: 'emi@test.local', password: claveEmi })).error);
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

test('deshacer: un cambio, una baja y un alta', () => {
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
  // un alta, con cambios posteriores: no los pisa salvo que se lo pidan
  id = sql(`select min(id) from gestor.cambios where tabla='causas' and clave='777' and operacion='alta'`);
  assert.match(sqlFalla(`select gestor.deshacer(${id})`), /hubo \d+ cambio\(s\) más en causas 777/);
  assert.equal(sql(`select count(*) from public.causas where expte='777'`), '1');
  assert.match(sql(`select gestor.deshacer(${id}, true)`), /Se eliminó causas 777/);
  assert.equal(sql(`select count(*) from public.causas where expte='777'`), '0');
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
  sql(`select gestor.autorizar('Socia@test.local', 'Socia')`);
  const s = await entrar('socia@test.local', 'Socia-123456789');
  assert.deepEqual((await s.rpc('mi_acceso')).data, { autorizado: true, clave_temporal: false, nombre: 'Socia', email: 'socia@test.local' });
  assert.equal(sql(`select email || '|' || nombre from gestor.usuarios where email='socia@test.local'`), 'socia@test.local|Socia');
  sql(`select gestor.quitar_usuario('socia@test.local')`);
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

test('olvidó la clave: una temporal nueva cierra las sesiones anteriores', async () => {
  const nueva = sql(`select gestor.nueva_clave('emi@test.local')`);
  assert.ok((await anon().auth.signInWithPassword({ email: 'emi@test.local', password: 'Clave-definitiva-2026' })).error);
  const { error } = await emi.auth.refreshSession();
  assert.ok(error, 'la sesión vieja no se puede renovar');
  emi = await entrar('emi@test.local', nueva);
  assert.equal((await emi.rpc('mi_acceso')).data.clave_temporal, true);
  assert.match(sqlFalla(`select gestor.nueva_clave('nadie@test.local')`), /No hay un usuario autorizado/);
});

test('quitar un usuario le corta el acceso en el acto', async () => {
  sql(`select gestor.quitar_usuario('emi@test.local')`);
  const r = await emi.from('causas').select('*');
  assert.ok(r.error || r.data.length === 0);
  assert.equal(sql(`select count(*) from auth.users where email='emi@test.local'`), '0');
});

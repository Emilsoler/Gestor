// Cuenta «solo panel máster» (migración 0057): lo que puede y, sobre todo, lo que NO puede. Y la venta de mostrador.
// Necesita el stack local (dev/stack.sh up).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, sqlFalla, limpiar, crearCuenta, entrar, env, servicio } from './helpers.mjs';
import { CASOS } from './casos-bcra.mjs';

const MOSTRADOR = '00000000-0000-0000-0000-000000000000';
let emi, maca, jwtMaca, causaTablas;
const fn = async (nombre, jwt, cuerpo) => {
  const form = cuerpo instanceof FormData;
  const r = await fetch(`${env.SUPABASE_URL}/functions/v1/${nombre}`, {
    method: 'POST', headers: { apikey: env.ANON_KEY, authorization: `Bearer ${jwt}`, ...(form ? {} : { 'content-type': 'application/json' }) },
    body: form ? cuerpo : JSON.stringify(cuerpo),
  });
  return { status: r.status, datos: await r.json().catch(() => null) };
};
const rest = async (jwt, metodo, ruta, cuerpo, extra = {}) => {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${ruta}`, {
    method: metodo, headers: { apikey: env.ANON_KEY, authorization: `Bearer ${jwt}`, 'content-type': 'application/json', ...extra },
    ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
  });
  const t = await r.text();
  return { status: r.status, datos: t ? JSON.parse(t) : null, rango: r.headers.get('content-range') };
};

before(async () => {
  limpiar();
  sql(`delete from public.solicitudes_credito; delete from public.cotizaciones_agencia; delete from public.agencias; delete from public.consultas_bcra;
       delete from gestor.masters; update public.ajustes_agencias set habilitado = true;`);
  await crearCuenta('emi@test.local', 'Clave-de-prueba-2026', 'Emi');
  const { error } = await servicio().auth.admin.createUser({ email: 'maca@test.local', password: 'Maca-123456-clave', email_confirm: true });
  if (error && !/already/i.test(error.message)) throw new Error(error.message);
  sql(`select gestor.autorizar_master('maca@test.local', 'Maca Prueba', false)`);
  emi = (await entrar('emi@test.local', 'Clave-de-prueba-2026')).sesion.access_token;
  jwtMaca = (await entrar('maca@test.local', 'Maca-123456-clave')).sesion.access_token;
  // Datos ajenos que no tiene que ver: una causa, un deudor y una consulta al BCRA de Cobranzas.
  sql(`insert into public.causas (expte, actor, demandado) values ('99999999', 'AMB', 'SECRETO CAUSA');
       insert into public.deudores (nombre) values ('SECRETO DEUDOR');
       insert into public.consultas_bcra (cuit, denominacion, semaforo, resultado, consultado_por) values ('20111111112', 'SECRETO BCRA', 'verde', '{}', 'Emi');`);
});

test('la cuenta máster no puede leer ni escribir NADA fuera del cotizador', async () => {
  const tablas = sql(`select string_agg(tablename, ',') from pg_tables where schemaname = 'public' and tablename <> '_migraciones_locales'`).split(',');
  const delPanel = ['ajustes_agencias', 'agencias', 'agencia_vendedores', 'cotizaciones_agencia', 'solicitudes_credito', 'consultas_bcra'];
  for (const t of tablas) {
    // Una columna que exista en cada tabla, para que el rechazo no sea por pedir algo inexistente.
    const col = sql(`select column_name from information_schema.columns where table_schema = 'public' and table_name = '${t}' order by ordinal_position limit 1`);
    for (const [m, q, cuerpo] of [['GET', '?select=*', undefined], ['HEAD', '?select=*', undefined], ['POST', '', {}], ['PATCH', `?${col}=not.is.null`, { [col]: null }], ['DELETE', `?${col}=not.is.null`, undefined]]) {
      const permitido = delPanel.includes(t) && (m === 'GET' || (t === 'consultas_bcra' && m === 'POST') || (m === 'PATCH' && !['cotizaciones_agencia', 'consultas_bcra'].includes(t))
        || (t === 'cotizaciones_agencia' && ['HEAD', 'DELETE'].includes(m)) || (t === 'solicitudes_credito' && m === 'HEAD'));
      if (permitido) continue;
      const r = await rest(jwtMaca, m, t + q, cuerpo, m === 'HEAD' ? { prefer: 'count=estimated' } : {});
      assert.ok(r.status === 401 || r.status === 403, `${m} ${t}: tenía que rechazarse y respondió ${r.status} ${JSON.stringify(r.datos)?.slice(0, 200)}`);
    }
  }
  // Funciones de la base: solo las de la lista de invitados.
  for (const f of ['mi_acceso', 'es_miembro', 'es_panel', 'es_master', 'panel_nombre', 'buscar_conocimientos', 'leer_conocimiento', 'chat_liquidacion_deudor', 'chat_registrar_pago']) {
    const r = await rest(jwtMaca, 'POST', `rpc/${f}`, {});
    assert.ok([401, 403, 404].includes(r.status), `rpc ${f} respondió ${r.status}`);
  }
  // GET a una función de la lista no está invitado (la lista es por método).
  assert.equal((await rest(jwtMaca, 'GET', 'rpc/panel_acceso')).status, 403);
  // La segunda barrera frena sola: sin la puerta, las políticas no le dan filas del gestor.
  const sinPuerta = sql(`begin; select set_config('request.jwt.claims', json_build_object('role','authenticated','sub',(select user_id from gestor.masters where email='maca@test.local'))::text, true);
    set local role authenticated;
    select (select count(*) from public.causas) + (select count(*) from public.deudores) + (select count(*) from public.vehiculos) + (select count(*) from public.ajustes_firma)
      + (select count(*) from public.consultas_bcra) + (select count(*) from public.consultas_cheques) + (select count(*) from public.plantillas) + (select count(*) from public.acuerdos); rollback;`);
  assert.equal(sinPuerta.trim().split('\n').pop(), '0');
});

test('las otras funciones del servidor la rechazan', async () => {
  for (const [n, cuerpo] of [['chat', { historial: [], texto: 'hola' }], ['ubicar', { id: MOSTRADOR }]]) {
    const r = await fn(n, jwtMaca, cuerpo);
    assert.equal(r.status, 403, `${n}: ${r.status} ${JSON.stringify(r.datos)}`);
  }
  const cheque = await fn('bcra', jwtMaca, { accion: 'cheque', entidad: 11, numero: '123' });
  assert.notEqual(cheque.status, 200);
});

test('la cuenta máster administra el cotizador y firma con su nombre', async () => {
  const yo = await rest(jwtMaca, 'POST', 'rpc/panel_acceso', {});
  assert.deepEqual([yo.datos.autorizado, yo.datos.miembro, yo.datos.nombre], [true, false, 'Maca Prueba']);
  for (const t of ['ajustes_agencias', 'agencias', 'agencia_vendedores', 'cotizaciones_agencia', 'solicitudes_credito']) assert.equal((await rest(jwtMaca, 'GET', `${t}?select=*`)).status, 200, t);
  assert.equal((await rest(jwtMaca, 'PATCH', 'ajustes_agencias?id=eq.1', { contacto: 'prueba' })).status, 204);
  assert.equal(sql(`select actualizado_por from public.ajustes_agencias`), 'Maca Prueba');
  for (const f of ['agencias_conectadas', 'estadisticas_agencias']) assert.equal((await rest(jwtMaca, 'POST', `rpc/${f}`, {})).status, 200, f);
  const ses = await fn('agencias', jwtMaca, { accion: 'yo' });
  assert.equal(ses.datos.miembro, true);
  assert.equal((await fn('agencias', jwtMaca, { accion: 'chats' })).status, 200);
  const nueva = await fn('agencias', jwtMaca, { accion: 'crear_agencia', nombre: 'Salón Maca', email: `salon-maca-${Date.now()}@test.local` });
  assert.equal(nueva.status, 200, JSON.stringify(nueva.datos));
});

test('venta de mostrador: BCRA, aprobar, documentos opcionales y verla', async () => {
  await fetch('http://127.0.0.1:54341/__casos', { method: 'POST', body: JSON.stringify(CASOS) });
  const cuit = Object.keys(CASOS.deudas || CASOS)[0].replace(/\D/g, '');
  for (const [quien, jwt, nombre] of [['máster', jwtMaca, 'Maca Prueba'], ['miembro', emi, 'Emi']]) {
    const b = await fn('bcra', jwt, { cuit });
    assert.equal(b.status, 200, `${quien}: ${JSON.stringify(b.datos)}`);
    const pedido = { cuit, consulta: b.datos.consulta.id, vehiculo: 'Fiat Cronos', anio: '2021', monto: 5000000 + (nombre === 'Emi' ? 1 : 0), cuotas: 24, cuota: 400000, total: 9600000, tasa: 5, datos: { celular: '3534000000', dni: '11111111' } };
    const ap = await rest(jwt, 'POST', 'rpc/mostrador_aprobar', { p: pedido });
    assert.equal(ap.status, 200, `${quien}: ${JSON.stringify(ap.datos)}`);
    assert.equal(sql(`select estado || '|' || resuelto_por || '|' || agencia || '|' || (resuelto is not null) from public.solicitudes_credito where id = '${ap.datos}'`), `aprobada|${nombre}|Mutual Bell · mostrador|true`);
    assert.equal((await rest(jwt, 'POST', 'rpc/mostrador_aprobar', { p: pedido })).status, 400, 'no se duplica');
    assert.equal((await rest(jwt, 'POST', 'rpc/mostrador_aprobar', { p: { ...pedido, cuit: '27222222223' } })).status, 400, 'la consulta es de otro CUIT');
    const form = new FormData(); form.set('id', ap.datos); form.set('archivo', new File([new TextEncoder().encode('%PDF-1.4\n%%EOF\n')], 'dni.pdf'));
    const s = await fn('mostrador', jwt, form);
    assert.equal(s.status, 200, JSON.stringify(s.datos));
    const malo = new FormData(); malo.set('id', ap.datos); malo.set('archivo', new File([new TextEncoder().encode('hola')], 'x.pdf'));
    assert.equal((await fn('mostrador', jwt, malo)).status, 415);
    const ver = await fn('agencias', jwt, { accion: 'archivos', id: ap.datos });
    assert.equal(ver.datos.archivos.length, 1);
    assert.equal((await rest(jwt, 'GET', `consultas_bcra?id=eq.${pedido.consulta}&select=semaforo`)).datos.length, 1);
  }
  // La máster ve las consultas que respaldan solicitudes y las suyas; la de Cobranzas, no.
  const vistas = (await rest(jwtMaca, 'GET', 'consultas_bcra?select=denominacion')).datos.map((x) => x.denominacion);
  assert.ok(!vistas.includes('SECRETO BCRA'), vistas.join());
  const [{ id }] = (await rest(jwtMaca, 'GET', `solicitudes_credito?select=id&limit=1`)).datos;
  assert.equal((await fn('agencias', jwtMaca, { accion: 'eliminar', id })).status, 200);
});

test('una agencia no puede aprobar en el mostrador ni subir documentos ahí', async () => {
  const { error } = await servicio().auth.admin.createUser({ email: 'ag-mostrador@test.local', password: 'Agencia-123456', email_confirm: true });
  if (error && !/already/i.test(error.message)) throw new Error(error.message);
  sql(`select gestor.autorizar_agencia('ag-mostrador@test.local', 'Salón Intruso', null)`);
  const ag = (await entrar('ag-mostrador@test.local', 'Agencia-123456')).sesion.access_token;
  assert.equal((await rest(ag, 'POST', 'rpc/mostrador_aprobar', { p: {} })).status, 403);
  const form = new FormData(); form.set('id', MOSTRADOR); form.set('archivo', new File([new TextEncoder().encode('%PDF-1.4\n')], 'a.pdf'));
  assert.equal((await fn('mostrador', ag, form)).status, 403);
});

test('una cuenta máster no puede ser agencia, y al quitarla pierde todo', async () => {
  assert.ok(sqlFalla(`select gestor.autorizar_agencia('maca@test.local', 'No', null)`));
  assert.ok(sqlFalla(`select gestor.autorizar_master('emi@test.local', 'Otro')`));
  sql(`select gestor.quitar_master('maca@test.local')`);
  assert.equal((await rest(jwtMaca, 'GET', 'solicitudes_credito?select=id')).status, 403);
  assert.equal((await fn('agencias', jwtMaca, { accion: 'yo' })).status, 403);
});

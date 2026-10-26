// Aprobación de créditos: la función `bcra` corriendo en local (dev/stack.sh up la levanta con Deno),
// contra la base local y un doble del BCRA (dev/bcra-falso.mjs) con casos inventados: nunca se consulta
// a personas ni cheques reales. Verifican lo que se le pide al BCRA, el semáforo, lo que queda guardado
// y los permisos; las de cheques denunciados están al final.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sql, sqlFalla, limpiar, crearCuenta, entrar, env, servicio } from './helpers.mjs';
import { CUIT, CASOS, CHEQUE, meses } from './casos-bcra.mjs';

const FALSO = 'http://127.0.0.1:54341';
const BCRA = `${env.SUPABASE_URL}/functions/v1/bcra`;
const casos = (c) => fetch(`${FALSO}/__casos`, { method: 'POST', body: JSON.stringify(c) });
const pedidos = async () => (await fetch(`${FALSO}/__pedidos`)).json();
const olvidar = () => fetch(`${FALSO}/__pedidos`, { method: 'DELETE' });
const registro = () => readFileSync(`${process.env.STACK || '/home/claude/.stack'}/logs/bcra.log`, 'utf8');
let token, cliente;

/** Un pedido a la función, con la sesión de Emi (o la que se indique). */
async function pedirBCRA(cuerpo, { jwt = token, origen = 'http://127.0.0.1:8080' } = {}) {
  const r = await fetch(BCRA, {
    method: 'POST',
    headers: { apikey: env.ANON_KEY, 'content-type': 'application/json', origin: origen, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(cuerpo),
  });
  return { status: r.status, datos: await r.json(), headers: r.headers };
}
const consultar = (cuit, opciones) => pedirBCRA({ cuit }, opciones);
const filas = () => JSON.parse(sql(`select coalesce(json_agg(to_jsonb(c) - 'resultado' order by momento), '[]') from public.consultas_bcra c`));
const filasCheques = () => JSON.parse(sql(`select coalesce(json_agg(to_jsonb(c) order by momento), '[]') from public.consultas_cheques c`));

before(async () => {
  limpiar();
  sql('delete from public.consultas_bcra; delete from public.consultas_cheques;');
  await olvidar();
  await casos(CASOS);
  await crearCuenta('emi@test.local', 'Clave-de-prueba-2026', 'Emi');
  cliente = await entrar('emi@test.local', 'Clave-de-prueba-2026');
  token = cliente.sesion.access_token;
});
after(() => olvidar());

test('sin sesión, sin autorización o con la clave temporal, no se consulta al BCRA', async () => {
  await olvidar(); await casos(CASOS);
  assert.equal((await consultar(CUIT.verde, { jwt: null })).status, 401);
  assert.equal((await consultar(CUIT.verde, { jwt: 'no-es-un-token' })).status, 401);
  // Una cuenta que existe pero no está autorizada: la frena la puerta de la API.
  const { error } = await servicio().auth.admin.createUser({ email: 'intruso@test.local', password: 'Intruso-123456', email_confirm: true });
  assert.ifError(error);
  const intruso = (await entrar('intruso@test.local', 'Intruso-123456')).sesion.access_token;
  let r = await consultar(CUIT.verde, { jwt: intruso });
  assert.equal(r.status, 403);
  assert.equal(r.datos.error, 'sin_acceso');
  await crearCuenta('temporal@test.local', 'Provisoria-123456', 'T', true);
  r = await consultar(CUIT.verde, { jwt: (await entrar('temporal@test.local', 'Provisoria-123456')).sesion.access_token });
  assert.equal(r.status, 403);
  assert.equal(r.datos.error, 'clave_temporal');
  assert.deepEqual(await pedidos(), [], 'ningún pedido llegó al BCRA');
  assert.deepEqual(filas(), []);
});

test('un CUIT mal escrito se rechaza antes de preguntar', async () => {
  await olvidar(); await casos(CASOS);
  let r = await consultar('20-12345678-9'); // el verificador correcto es 6
  assert.equal(r.status, 400);
  assert.equal(r.datos.error, 'cuit');
  assert.match(r.datos.mensaje, /revisá los números/);
  r = await consultar('2012345');
  assert.equal(r.status, 400);
  assert.match(r.datos.mensaje, /11 números/);
  r = await consultar('20999999990'); // verificador 10: no existe ningún CUIT así
  assert.equal(r.status, 400);
  assert.deepEqual(await pedidos(), []);
});

test('verde: los tres pedidos al BCRA, el semáforo y la constancia guardada', async () => {
  await olvidar(); await casos(CASOS);
  const r = await consultar('20-11111111-2');
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  assert.deepEqual((await pedidos()).sort(), [
    `/CentralDeDeudores/v1.0/Deudas/${CUIT.verde}`,
    `/CentralDeDeudores/v1.0/Deudas/ChequesRechazados/${CUIT.verde}`,
    `/CentralDeDeudores/v1.0/Deudas/Historicas/${CUIT.verde}`,
  ]);
  const c = r.datos.consulta;
  assert.equal(c.cuit, CUIT.verde);
  assert.equal(c.denominacion, 'PERSONA VERDE');
  assert.equal(c.semaforo, 'verde');
  assert.equal(c.periodo, '202609');
  assert.equal(c.peor_situacion, 1);
  assert.equal(c.entidades, 2);
  assert.equal(+c.deuda_total, 230500); // 150,5 + 80 miles de pesos
  assert.equal(c.cheques, 0);
  assert.deepEqual(c.motivos, ['Situación 1 (normal) en 2 entidades', 'Sin cheques rechazados']);
  assert.equal(c.consultado_por, 'Emi');
  assert.equal(c.resultado.deudas.denominacion, 'PERSONA VERDE');
  assert.equal(c.resultado.historicas.periodos.length, 24);
  assert.equal(c.resultado.cheques, null, 'sin cheques: el BCRA dijo que no figura');
  assert.deepEqual(c.resultado.errores, {});
  // Quedó en la base, con la fecha que puso la base.
  const [f] = filas();
  assert.equal(f.id, c.id);
  assert.ok(Math.abs(Date.parse(f.momento) - Date.now()) < 60_000);
  // Y en el historial de cambios, como alta de Emi.
  assert.equal(sql(`select autor || ' ' || operacion from gestor.cambios where tabla = 'consultas_bcra' and clave = '${c.id}'`), 'Emi alta');
});

test('amarillo: situación 2 y un cheque rechazado ya pagado', async () => {
  const { status, datos } = await consultar(CUIT.amarillo);
  assert.equal(status, 200);
  const c = datos.consulta;
  assert.equal(c.semaforo, 'amarillo');
  assert.equal(c.peor_situacion, 2);
  assert.equal(c.cheques, 1);
  assert.equal(c.cheques_impagos, 0);
  assert.deepEqual(c.motivos, ['Situación 2 en BANCO DE GALICIA Y BUENOS AIRES S.A.', '1 cheque rechazado, ya pagado']);
});

test('rojo: situación 4, un cheque sin pagar y lo peor de los últimos 24 meses', async () => {
  const { status, datos } = await consultar(CUIT.rojo);
  assert.equal(status, 200);
  const c = datos.consulta;
  assert.equal(c.semaforo, 'rojo');
  assert.equal(c.peor_situacion, 4);
  assert.equal(c.cheques, 2);
  assert.equal(c.cheques_impagos, 1);
  const mes = meses()[10];
  assert.deepEqual(c.motivos, [
    'Situación 4 en BANCO SANTANDER ARGENTINA S.A.', '1 cheque rechazado sin pagar', '1 cheque rechazado, ya pagado',
    `En los últimos 24 meses llegó a situación 5 (${mes.slice(4)}/${mes.slice(0, 4)})`,
  ]);
  // Una empresa con situación 3 también es rojo.
  assert.equal((await consultar(CUIT.empresa)).datos.consulta.semaforo, 'rojo');
});

test('sin deudas: no figura, o no figura hoy pero sí en los últimos 24 meses', async () => {
  let c = (await consultar(CUIT.nada)).datos.consulta;
  assert.equal(c.semaforo, 'sin_datos');
  assert.equal(c.denominacion, '', 'sin deudas el BCRA no devuelve el nombre');
  assert.equal(+c.deuda_total, 0);
  assert.deepEqual(c.motivos, ['No figura en la Central de Deudores', 'Sin cheques rechazados']);
  assert.deepEqual(c.resultado, { deudas: null, historicas: null, cheques: null, errores: {} });

  // El BCRA puede decir "no figura" dentro de una respuesta 200; los cheques, con la lista vacía.
  c = (await consultar(CUIT.enCuerpo)).datos.consulta;
  assert.equal(c.semaforo, 'sin_datos');
  assert.equal(c.denominacion, 'EMPRESA SIN DEUDAS S.A.', 'el nombre sale de los cheques');
  assert.equal(c.resultado.deudas, null);
  assert.equal(c.cheques, 0);

  c = (await consultar(CUIT.antes)).datos.consulta;
  assert.equal(c.semaforo, 'sin_datos');
  assert.equal(c.denominacion, 'PERSONA QUE PAGO', 'el nombre sale de los 24 meses');
  const mes = meses()[15];
  assert.deepEqual(c.motivos, ['Sin deudas en el último período informado', 'Sin cheques rechazados',
    `En los últimos 24 meses llegó a situación 3 (${mes.slice(4)}/${mes.slice(0, 4)})`]);
});

test('si el BCRA falla no se guarda nada; si fallan solo los 24 meses, se guarda y se avisa', async () => {
  const antes = filas().length;
  await olvidar(); await casos(CASOS);
  let r = await consultar(CUIT.caido);
  assert.equal(r.status, 502);
  assert.equal(r.datos.error, 'bcra_bcra');
  assert.match(r.datos.mensaje, /BCRA respondió con un error/);
  assert.equal((await pedidos()).filter((p) => p === `/CentralDeDeudores/v1.0/Deudas/${CUIT.caido}`).length, 2, 'reintenta una vez');

  r = await consultar(CUIT.corte);
  assert.equal(r.status, 502);
  assert.equal(r.datos.error, 'bcra_red');
  assert.match(r.datos.mensaje, /No se pudo conectar con el BCRA/);

  r = await consultar(CUIT.limite);
  assert.equal(r.status, 429);
  assert.match(r.datos.mensaje, /limitando las consultas/);
  assert.equal(filas().length, antes, 'nada guardado');

  r = await consultar(CUIT.sinHistoria);
  assert.equal(r.status, 200);
  assert.equal(r.datos.consulta.semaforo, 'verde');
  assert.equal(r.datos.consulta.resultado.historicas, null);
  assert.match(r.datos.consulta.resultado.errores.historicas, /BCRA respondió con un error/);
  // En los registros de la función no queda ningún CUIT.
  const log = registro();
  for (const c of Object.values(CUIT)) assert.ok(!log.includes(c), `el registro no tiene el CUIT ${c}`);
  assert.match(log, /"bcra":"error","tipo":"bcra"/);
});

test('CORS: solo responde al origen de la app', async () => {
  // (la puerta local agrega CORS propio; acá se mira la función directa)
  const directo = 'http://127.0.0.1:54332';
  let r = await fetch(directo, { method: 'OPTIONS', headers: { origin: 'https://emilsoler.github.io' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://emilsoler.github.io');
  r = await fetch(directo, { method: 'OPTIONS', headers: { origin: 'https://otro-sitio.example' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  r = await fetch(directo, { method: 'POST', headers: { origin: 'https://otro-sitio.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('permisos de la tabla: se lee, se agrega y se elimina; cambiar, no; la fecha y el autor los pone la base', async () => {
  const { data, error } = await cliente.from('consultas_bcra').select('id, cuit, semaforo').order('momento');
  assert.ifError(error);
  assert.ok(data.length >= 5);
  const id = data[0].id;
  // Cambiar una constancia no se puede.
  const cambio = await cliente.from('consultas_bcra').update({ semaforo: 'verde' }).eq('id', id).select();
  assert.ok(cambio.error, 'update rechazado');
  assert.equal(cambio.error.code, '42501');
  // Desde la API, la fecha y el autor no se pueden elegir.
  const alta = await cliente.from('consultas_bcra').insert({ cuit: CUIT.verde, semaforo: 'verde', resultado: {}, momento: '2020-01-01T00:00:00Z', consultado_por: 'Otro' }).select().single();
  assert.ifError(alta.error);
  assert.equal(alta.data.consultado_por, 'Emi');
  assert.ok(Date.parse(alta.data.momento) > Date.parse('2026-01-01'));
  // La base rechaza datos con otra forma.
  const mala = await cliente.from('consultas_bcra').insert({ cuit: '123', semaforo: 'verde', resultado: {} });
  assert.equal(mala.error?.code, '23514');
  // Eliminar sí, y se puede recuperar tal como era.
  const original = JSON.parse(sql(`select to_jsonb(c) from public.consultas_bcra c where id = '${id}'`));
  const baja = await cliente.from('consultas_bcra').delete().eq('id', id);
  assert.ifError(baja.error);
  const cambioId = sql(`select id from gestor.cambios where tabla = 'consultas_bcra' and clave = '${id}' and operacion = 'baja'`);
  assert.match(sql(`select gestor.deshacer(${cambioId})`), /volvió a como estaba/);
  const vuelta = JSON.parse(sql(`select to_jsonb(c) from public.consultas_bcra c where id = '${id}'`));
  for (const k of ['cuit', 'denominacion', 'momento', 'consultado_por', 'semaforo', 'motivos', 'resultado', 'deuda_total']) assert.deepEqual(vuelta[k], original[k], k);
  // Sin estadísticas del planificador (barrera 3).
  assert.equal(sql(`select count(*) from pg_attribute where attrelid = 'public.consultas_bcra'::regclass and attnum > 0 and not attisdropped and attstattarget <> 0`), '0');
  // Y sin acceso anónimo.
  assert.ok(sqlFalla(`set role anon; select * from public.consultas_bcra;`).includes('permission denied'));
});

// ───────────────────────── Cheques denunciados ─────────────────────────

test('cheques: la lista de bancos, ordenada y sin espacios de más; sin sesión, nada', async () => {
  await olvidar(); await casos(CASOS);
  assert.equal((await pedirBCRA({ accion: 'entidades' }, { jwt: null })).status, 401);
  assert.deepEqual(await pedidos(), []);
  const r = await pedirBCRA({ accion: 'entidades' });
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  assert.deepEqual(r.datos.entidades, [
    { codigo: 191, nombre: 'BANCO CREDICOOP COOPERATIVO LIMITADO' },
    { codigo: 7, nombre: 'BANCO DE GALICIA Y BUENOS AIRES S.A.' },
    { codigo: 11, nombre: 'BANCO DE LA NACION ARGENTINA' },
    { codigo: 14, nombre: 'BANCO DE LA PROVINCIA DE BUENOS AIRES' },
    { codigo: 20, nombre: 'BANCO DE LA PROVINCIA DE CORDOBA S.A.' },
  ]);
  assert.deepEqual(await pedidos(), ['/cheques/v1.0/entidades']);
  // Si el BCRA no la da, se dice en palabras (y la próxima vez se vuelve a pedir).
  await casos({ cheques: { entidades: { status: 500 } } });
  const f = await pedirBCRA({ accion: 'entidades' });
  assert.equal(f.status, 502);
  assert.equal(f.datos.error, 'bcra_bcra');
  assert.match(f.datos.mensaje, /BCRA respondió con un error/);
  await casos(CASOS);
  assert.equal((await pedirBCRA({ accion: 'otra cosa' })).status, 400);
});

test('cheque sin denuncias: lo que se le pide al BCRA y la constancia guardada', async () => {
  await olvidar(); await casos(CASOS);
  const r = await pedirBCRA({ accion: 'cheque', entidad: 11, numero: '0012.345.678' }); // ceros y puntos: se limpian
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  assert.deepEqual(await pedidos(), [`/cheques/v1.0/denunciados/11/${CHEQUE.limpio}`]);
  const c = r.datos.consulta;
  assert.equal(c.entidad, 11);
  assert.equal(c.numero, CHEQUE.limpio);
  assert.equal(c.denunciado, false);
  assert.equal(c.entidad_nombre, 'BANCO DE LA NACION ARGENTINA', 'sin los espacios que manda el BCRA');
  assert.equal(c.fecha_bcra, '2026-10-24');
  assert.equal(c.consultado_por, 'Emi');
  assert.deepEqual(c.resultado.detalles, []);
  assert.ok(Math.abs(Date.parse(c.momento) - Date.now()) < 60_000);
  assert.equal(sql(`select autor || ' ' || operacion from gestor.cambios where tabla = 'consultas_cheques' and clave = '${c.id}'`), 'Emi alta');
  // La entidad también llega como texto (es lo que tiene la lista de la app).
  assert.equal((await pedirBCRA({ accion: 'cheque', entidad: '11', numero: CHEQUE.limpio })).status, 200);
  assert.equal(filasCheques().length, 2);
});

test('cheque denunciado: queda con sus denuncias', async () => {
  const r = await pedirBCRA({ accion: 'cheque', entidad: 20, numero: CHEQUE.denunciado });
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  const c = r.datos.consulta;
  assert.equal(c.denunciado, true);
  assert.equal(c.entidad_nombre, 'BANCO DE LA PROVINCIA DE CORDOBA S.A.');
  assert.deepEqual(c.resultado.detalles.map((d) => d.causal), ['Denunciado por titular', 'Denunciado por tercero']);
  assert.equal(c.resultado.detalles[0].numeroCuenta, 3120055962);
  assert.equal(c.resultado.detalles[0].sucursal, 312);
});

test('cheque sin banco o con un número que no sirve: se rechaza antes de preguntar', async () => {
  await olvidar(); await casos(CASOS);
  const antes = filasCheques().length;
  for (const [cuerpo, error] of [
    [{ accion: 'cheque', numero: CHEQUE.limpio }, 'entidad'],
    [{ accion: 'cheque', entidad: 'Nación', numero: CHEQUE.limpio }, 'entidad'],
    [{ accion: 'cheque', entidad: 0, numero: CHEQUE.limpio }, 'entidad'],
    [{ accion: 'cheque', entidad: 11.5, numero: CHEQUE.limpio }, 'entidad'],
    [{ accion: 'cheque', entidad: 11 }, 'numero'],
    [{ accion: 'cheque', entidad: 11, numero: 'abc' }, 'numero'],
    [{ accion: 'cheque', entidad: 11, numero: '0000' }, 'numero'],
    [{ accion: 'cheque', entidad: 11, numero: '1234567890123456' }, 'numero'], // 16 cifras
  ]) {
    const r = await pedirBCRA(cuerpo);
    assert.equal(r.status, 400, JSON.stringify(cuerpo));
    assert.equal(r.datos.error, error, JSON.stringify(cuerpo));
  }
  assert.equal((await pedirBCRA({ accion: 'cheque', entidad: 11, numero: CHEQUE.limpio }, { jwt: null })).status, 401);
  assert.deepEqual(await pedidos(), [], 'ningún pedido llegó al BCRA');
  assert.equal(filasCheques().length, antes);
});

test('si el BCRA no tiene el banco, falla o responde algo raro, no se guarda nada', async () => {
  await olvidar(); await casos(CASOS);
  const antes = filasCheques().length;
  let r = await pedirBCRA({ accion: 'cheque', entidad: 2222, numero: CHEQUE.limpio });
  assert.equal(r.status, 400);
  assert.equal(r.datos.error, 'bcra_entidad');
  assert.match(r.datos.mensaje, /no tiene ese banco/);

  r = await pedirBCRA({ accion: 'cheque', entidad: 11, numero: CHEQUE.caido });
  assert.equal(r.status, 502);
  assert.equal(r.datos.error, 'bcra_bcra');
  assert.equal((await pedidos()).filter((p) => p === `/cheques/v1.0/denunciados/11/${CHEQUE.caido}`).length, 2, 'reintenta una vez');

  r = await pedirBCRA({ accion: 'cheque', entidad: 11, numero: CHEQUE.corte });
  assert.equal(r.status, 502);
  assert.equal(r.datos.error, 'bcra_red');

  r = await pedirBCRA({ accion: 'cheque', entidad: 11, numero: CHEQUE.raro });
  assert.equal(r.status, 502);
  assert.equal(r.datos.error, 'bcra_formato');
  assert.equal(filasCheques().length, antes, 'nada guardado');

  // En los registros de la función no queda ningún número de cheque ni de cuenta.
  const log = registro();
  for (const n of [...Object.values(CHEQUE), '3120055962']) assert.ok(!log.includes(n), `el registro no tiene el número ${n}`);
  assert.match(log, /"cheque":"error","tipo":"entidad"/);
  assert.match(log, /"cheque":"error","tipo":"red"/);
  assert.match(log, /"cheque":"ok","ms":\d+,"denunciado":true/);
});

test('permisos de la tabla de cheques: se lee, se agrega y se elimina; cambiar, no; la fecha y el autor los pone la base', async () => {
  const { data, error } = await cliente.from('consultas_cheques').select('id, numero, denunciado').order('momento');
  assert.ifError(error);
  assert.ok(data.length >= 3);
  const id = data[0].id;
  const cambio = await cliente.from('consultas_cheques').update({ denunciado: true }).eq('id', id).select();
  assert.equal(cambio.error?.code, '42501', 'update rechazado');
  // Desde la API, la fecha y el autor no se pueden elegir.
  const alta = await cliente.from('consultas_cheques')
    .insert({ entidad: 11, numero: '123', denunciado: false, resultado: {}, momento: '2020-01-01T00:00:00Z', consultado_por: 'Otro' }).select().single();
  assert.ifError(alta.error);
  assert.equal(alta.data.consultado_por, 'Emi');
  assert.ok(Date.parse(alta.data.momento) > Date.parse('2026-01-01'));
  // La base rechaza datos con otra forma.
  for (const mala of [
    { entidad: 11, numero: '0123', denunciado: false, resultado: {} },
    { entidad: 0, numero: '123', denunciado: false, resultado: {} },
    { entidad: 11, numero: '123', denunciado: false, resultado: [] },
  ]) assert.equal((await cliente.from('consultas_cheques').insert(mala)).error?.code, '23514', JSON.stringify(mala));
  // Eliminar sí, y se puede recuperar tal como era.
  const original = JSON.parse(sql(`select to_jsonb(c) from public.consultas_cheques c where id = '${id}'`));
  assert.ifError((await cliente.from('consultas_cheques').delete().eq('id', id)).error);
  const cambioId = sql(`select id from gestor.cambios where tabla = 'consultas_cheques' and clave = '${id}' and operacion = 'baja'`);
  assert.match(sql(`select gestor.deshacer(${cambioId})`), /volvió a como estaba/);
  const vuelta = JSON.parse(sql(`select to_jsonb(c) from public.consultas_cheques c where id = '${id}'`));
  for (const k of ['entidad', 'entidad_nombre', 'numero', 'denunciado', 'fecha_bcra', 'momento', 'consultado_por', 'resultado']) assert.deepEqual(vuelta[k], original[k], k);
  // Sin estadísticas del planificador (barrera 3), sin acceso anónimo, y una cuenta sin autorizar no ve nada.
  assert.equal(sql(`select count(*) from pg_attribute where attrelid = 'public.consultas_cheques'::regclass and attnum > 0 and not attisdropped and attstattarget <> 0`), '0');
  assert.ok(sqlFalla(`set role anon; select * from public.consultas_cheques;`).includes('permission denied'));
  const intruso = await entrar('intruso@test.local', 'Intruso-123456');
  const visto = await intruso.from('consultas_cheques').select('id');
  assert.ok(visto.error || visto.data.length === 0, 'la cuenta sin autorizar no ve las consultas');
});

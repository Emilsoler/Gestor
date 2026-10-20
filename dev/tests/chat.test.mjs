// Pruebas de la función `chat` corriendo en local (dev/stack.sh up la levanta con Deno), contra
// la base local y un doble de la API de Claude (dev/claude-falso.mjs) que contesta lo que cada
// prueba le indica. Verifican lo que manda a Claude, lo que hacen las herramientas en la base y
// lo que vuelve a la app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { sql, limpiar, crearCuenta, entrar, env } from './helpers.mjs';

const FALSO = 'http://127.0.0.1:54340';
const CHAT = `${env.SUPABASE_URL}/functions/v1/chat`;
let token;

const guion = (pasos) => fetch(`${FALSO}/__guion`, { method: 'POST', body: JSON.stringify(pasos) });
const pedidos = async () => (await fetch(`${FALSO}/__pedidos`)).json();
const olvidar = () => fetch(`${FALSO}/__pedidos`, { method: 'DELETE' });
async function chat(cuerpo, { jwt = token, url = CHAT, origen = 'http://127.0.0.1:8080' } = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { apikey: env.ANON_KEY, 'content-type': 'application/json', origin: origen, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(cuerpo),
  });
  return { status: r.status, datos: await r.json(), headers: r.headers };
}
/** Los tool_result que recibió Claude en el último pedido, ya leídos. */
async function resultados() {
  const ps = await pedidos();
  const ultimo = ps.at(-1).cuerpo.messages.at(-1);
  return ultimo.content.map((b) => ({ ...JSON.parse(b.content), es_error: !!b.is_error }));
}
const textoDe = (m) => m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
/** El próximo día hábil (lunes a viernes) desde mañana, en Córdoba. */
const habil = () => sql(`select d::date from generate_series(gestor.hoy() + 1, gestor.hoy() + 7, '1 day') d where extract(isodow from d) < 6 limit 1`);

before(async () => {
  limpiar();
  await olvidar();
  await crearCuenta('emi@test.local', 'Clave-de-prueba-2026', 'Emi');
  token = (await entrar('emi@test.local', 'Clave-de-prueba-2026')).sesion.access_token;
  sql(`begin; select set_config('gestor.autor', 'Semilla', true);
    insert into public.causas (expte, actor, demandado, tipo, nom, oficina, ubicacion, estado, cautelar, proxima, vence, notas, historial) values
      ('1001', 'AMB', 'ALFA ANA', 'EJECUTIVO', '2', 'OEP', 'Casillero', '4. Ejecución de Sentencia', 'Embargo de sueldo', 'Solicitar aprobación de liquidación', gestor.hoy() + 1, 'tel 123', '[]'),
      ('1002', 'AMB', 'BETA BRUNO', 'PRENDARIO', '1', 'OEP', 'A despacho', '2. No oposición de excepciones', 'Vehículo secuestrado', '', null, '', '[]');
    insert into public.plantillas (id, titulo, cuerpo) values
      ('aprobacion', 'Solicita aprobación de liquidación', 'En autos {{caratula}}, expediente {{expediente}}, de la {{nominacion}} nominación: solicito se apruebe la liquidación.');
    commit;`);
});
after(() => olvidar());

test('sin sesión, sin autorización o con la clave temporal, no se habla con Claude', async () => {
  await olvidar();
  assert.equal((await chat({ texto: 'hola' }, { jwt: null })).status, 401);
  assert.equal((await chat({ texto: 'hola' }, { jwt: 'no-es-un-token' })).status, 401);
  await crearCuenta('temporal@test.local', 'Provisoria-123456', 'T', true);
  const temporal = (await entrar('temporal@test.local', 'Provisoria-123456')).sesion.access_token;
  let r = await chat({ texto: 'hola' }, { jwt: temporal });
  assert.equal(r.status, 403);
  assert.equal(r.datos.error, 'clave_temporal');
  sql(`select gestor.quitar_usuario('temporal@test.local')`);
  r = await chat({ texto: 'hola' }, { jwt: temporal });
  assert.equal(r.status, 403);
  assert.equal(r.datos.error, 'sin_acceso');
  assert.deepEqual(await pedidos(), [], 'ningún pedido llegó a Claude');
});

test('un mensaje: lo que se manda a Claude y lo que vuelve a la app', async () => {
  await olvidar();
  await guion([{ texto: 'Tenés una sola cosa pendiente.' }]);
  const r = await chat({ historial: [], texto: '¿Qué tengo pendiente?', notas: ['Agendaste "X" en la causa 1001 para el 20/10.'] });
  assert.equal(r.status, 200);
  assert.equal(r.datos.nuevos.length, 2);
  const [usuario, respuesta] = r.datos.nuevos;
  assert.match(textoDe(usuario), /^\[(lunes|martes|miércoles|jueves|viernes|sábado|domingo) \d\d\/\d\d\/\d{4}, \d\d:\d\d hs \(hora de Córdoba\)\]\n\[Nota del gestor: Agendaste "X" en la causa 1001 para el 20\/10\.\]\n¿Qué tengo pendiente\?$/);
  assert.equal(textoDe(respuesta), 'Tenés una sola cosa pendiente.');
  assert.equal(r.datos.cambios, false);
  const [p] = await pedidos();
  assert.equal(p.headers['anthropic-version'], '2023-06-01');
  assert.equal(p.headers['x-api-key'], 'clave-de-prueba');
  assert.equal(p.cuerpo.model, 'claude-sonnet-5-5');
  assert.deepEqual(p.cuerpo.thinking, { type: 'between_tools' });
  assert.deepEqual(p.cuerpo.output_config, { effort: 'medium' });
  assert.deepEqual(p.cuerpo.cache_control, { type: 'ephemeral' });
  assert.equal(p.cuerpo.temperature, undefined, 'Sonnet 5.5 rechaza temperature');
  assert.equal(p.cuerpo.tool_choice, undefined, 'y la elección forzada de herramientas');
  assert.match(p.cuerpo.system, /Te escribe Emi/);
  assert.doesNotMatch(p.cuerpo.system, /\d{2}\/\d{2}\/\d{4}/, 'sin fecha en las instrucciones: tienen que ser siempre iguales');
  const nombres = p.cuerpo.tools.map((t) => t.name);
  assert.deepEqual(nombres, ['buscar_causas', 'ver_causa', 'listar_pendientes', 'editar_causa', 'registrar_movimiento', 'marcar_realizada',
    'listar_plantillas', 'preparar_presentacion', 'ver_agenda', 'cancelar_presentacion', 'reprogramar_presentacion']);
  assert.ok(!nombres.some((n) => /elimin|borrar|presentar_en|sql/.test(n)), 'nada para eliminar ni para presentar directo');
});

test('herramientas: busca, lee, cambia y anota; los cambios quedan firmados como Claude', async () => {
  await olvidar();
  await guion([
    { herramientas: [{ name: 'buscar_causas', input: { texto: 'alfa' } }, { name: 'listar_pendientes', input: {} }] },
    { herramientas: [{ name: 'ver_causa', input: { expte: '1001' } }] },
    { herramientas: [{ name: 'editar_causa', input: { expte: '1001', ubicacion: 'A despacho', agregar_a_notas: 'Llamó el demandado' } }] },
    { herramientas: [{ name: 'registrar_movimiento', input: { expte: '1002', texto: 'Sentencia de remate', estado: '3. Sentencia', ubicacion: 'Casillero' } }] },
    { texto: 'Hecho.' },
  ]);
  const r = await chat({ historial: [], texto: 'Pasá Alfa a despacho, anotá que llamó, y en Beta anotá la sentencia de hoy.' });
  assert.equal(r.status, 200);
  assert.equal(r.datos.nuevos.length, 10); // usuario + 4 × (asistente, resultados) + respuesta final
  assert.equal(r.datos.cambios, true);
  assert.deepEqual(r.datos.acciones, ['Causa 1001: notas, ubicación actualizados', `Causa 1002: movimiento anotado (${sql(`select to_char(gestor.hoy(), 'DD/MM/YYYY')`)}: Sentencia de remate), estado 3. Sentencia, Casillero`]);
  const ps = await pedidos();
  const res = (i) => ps[i].cuerpo.messages.at(-1).content.map((b) => JSON.parse(b.content));
  const [busqueda, pendientes] = res(1);
  assert.equal(busqueda.encontradas, 1);
  assert.equal(busqueda.causas[0].caratula, 'AMB c/ ALFA ANA – EJECUTIVO');
  assert.deepEqual([busqueda.causas[0].ubicacion, busqueda.causas[0].estado, busqueda.causas[0].cautelar, busqueda.causas[0].situacion],
    ['Casillero', '4. Ejecución de Sentencia', 'Embargo de sueldo', 'En trámite']);
  assert.equal(pendientes.proximas_acciones[0].expte, '1001');
  assert.equal(pendientes.proximas_acciones[0].plazo.startsWith('vence el'), true);
  const [ficha] = res(2);
  assert.equal(ficha.notas, 'tel 123');
  assert.equal(ficha.nominacion, '2°');
  assert.equal(sql(`select ubicacion || '|' || estado || '|' || notas || '|' || actualizado_por from public.causas where expte = '1001'`), 'A despacho|4. Ejecución de Sentencia|tel 123\nLlamó el demandado|Claude');
  assert.equal(sql(`select ultima || '|' || (fecha = gestor.hoy()) || '|' || estado || '|' || ubicacion || '|' || actualizado_por from public.causas where expte = '1002'`), 'Sentencia de remate|true|3. Sentencia|Casillero|Claude');
  assert.equal(sql(`select count(*) from gestor.cambios where autor = 'Claude' and clave in ('1001', '1002')`), '2');
  // el pensamiento firmado vuelve a Claude tal cual en el pedido siguiente
  assert.deepEqual(ps[1].cuerpo.messages.at(-2).content[0], { type: 'thinking', thinking: 'Voy a usar las herramientas del gestor.', signature: ps[1].cuerpo.messages.at(-2).content[0].signature });
  assert.deepEqual(ps[1].cuerpo.messages.at(-2), r.datos.nuevos[1]);
});

test('lo que no se puede hacer vuelve a Claude explicado, sin tocar nada', async () => {
  await olvidar();
  const antes = sql(`select string_agg(rev::text, ',' order by expte) from public.causas`);
  await guion([
    { herramientas: [
      { name: 'editar_causa', input: { expte: '9999', ubicacion: 'A despacho' } },
      { name: 'editar_causa', input: { expte: '1001', estado: 'Inventado' } },
      { name: 'editar_causa', input: { expte: '1001' } },
      { name: 'editar_causa', input: { expte: '1001', cautelar: 'Rara' } },
      { name: 'registrar_movimiento', input: { expte: '1001', texto: 'Algo futuro', fecha: '2999-01-01' } },
      { name: 'ver_causa', input: { expte: '1001; drop table causas' } },
      { name: 'marcar_realizada', input: { expte: '1002' } },
      { name: 'preparar_presentacion', input: { expte: '1001', fecha: '2020-01-01', plantilla_id: 'aprobacion' } },
      { name: 'preparar_presentacion', input: { expte: '1001', fecha: habil(), plantilla_id: 'no-existe' } },
      { name: 'cancelar_presentacion', input: { id: '00000000-0000-0000-0000-000000000000' } },
      { name: 'herramienta_inventada', input: {} },
      { name: 'editar_causa', input: { expte: '1001', estado: 'A despacho' } },
      { name: 'registrar_movimiento', input: { expte: '1001', texto: 'Archivo', ubicacion: 'Archivada' } },
    ] },
    { texto: 'No pude.' },
  ]);
  const r = await chat({ historial: [], texto: 'Probá cosas raras.' });
  assert.equal(r.status, 200);
  const rs = await resultados();
  assert.equal(rs.length, 13);
  assert.ok(rs.every((x) => x.es_error && x.error), 'todos vuelven como error, explicado');
  assert.match(rs[0].error, /No existe la causa con expediente 9999/);
  assert.match(rs[1].error, /Estado desconocido/);
  assert.match(rs[2].error, /No mandaste ningún cambio/);
  assert.match(rs[3].error, /Etiqueta cautelar desconocida: "Rara"\. Las etiquetas cautelares son: Sin Cautelar, Embargo de sueldo, Vehículo secuestrado/);
  assert.match(rs[4].error, /ya pasó/);
  assert.match(rs[5].error, /no es un N° de expediente/);
  assert.match(rs[6].error, /no tiene próxima acción/);
  assert.match(rs[7].error, /La fecha ya pasó/);
  assert.match(rs[8].error, /No existe la plantilla "no-existe".*Solicita aprobación de liquidación \(id aprobacion\)/);
  assert.match(rs[9].error, /No existe ese escrito/);
  assert.match(rs[10].error, /No existe la herramienta/);
  assert.match(rs[11].error, /Estado desconocido: "A despacho"\. Ese valor va en ubicacion\./);
  assert.match(rs[12].error, /Ubicación desconocida: "Archivada"\. Ese valor va en situacion\./);
  assert.equal(sql(`select string_agg(rev::text, ',' order by expte) from public.causas`), antes);
  assert.equal(sql(`select count(*) from public.agenda`), '0');
  assert.equal(r.datos.cambios, false);
});

test('buscar por ubicación, estado, cautelar o situación; las archivadas solo si se piden', async () => {
  await olvidar();
  sql(`begin; select set_config('gestor.autor', 'Semilla', true);
    insert into public.causas (expte, actor, demandado, tipo, ubicacion, estado, cautelar, situacion, notas, historial) values
      ('1003', 'AMB', 'GAMA GIL', 'PRENDARIO', 'A despacho', '5. Martillero Designado', 'Vehículo secuestrado', 'Archivada', '', '[]'),
      ('1004', 'AMB', 'DELTA DORA', 'EJECUTIVO', 'A despacho', '5. Martillero Designado', 'Vehículo secuestrado', 'En trámite', 'el expediente pasó a despacho', '[]');
    commit;`);
  await guion([
    { herramientas: [
      { name: 'buscar_causas', input: { ubicacion: 'A despacho', cautelar: 'Vehículo secuestrado' } },
      { name: 'buscar_causas', input: { situacion: 'Archivada' } },
      { name: 'buscar_causas', input: { texto: 'gama' } },
      { name: 'buscar_causas', input: { texto: 'despacho', estado: '5. Martillero Designado' } },
      { name: 'buscar_causas', input: { estado: 'Casillero' } },
      { name: 'buscar_causas', input: {} },
    ] },
    { texto: 'ok' },
  ]);
  await chat({ historial: [], texto: '¿Qué causas con vehículo secuestrado están a despacho?' });
  const [despacho, archivadas, gama, conTexto, mal, vacia] = await resultados();
  assert.deepEqual(despacho.causas.map((c) => c.expte), ['1004'], 'la archivada no aparece');
  assert.equal(despacho.archivadas_que_coinciden, 1);
  assert.deepEqual(archivadas.causas.map((c) => c.expte), ['1003'], 'si se pide Archivada, aparecen');
  assert.deepEqual([gama.encontradas, gama.archivadas_que_coinciden], [0, 1]);
  assert.deepEqual(conTexto.causas.map((c) => c.expte), ['1004']);
  assert.match(mal.error, /Estado desconocido: "Casillero"\. Ese valor va en ubicacion\./);
  assert.match(vacia.error, /Decime qué buscar/);
  sql(`delete from public.causas where expte in ('1003', '1004')`);
});

test('preparar un escrito deja un borrador para confirmar en la app, no algo para presentar', async () => {
  await olvidar();
  const dia = habil();
  await guion([
    { herramientas: [{ name: 'preparar_presentacion', input: { expte: '1001', fecha: dia, plantilla_id: 'aprobacion', dar_por_realizada: true } }] },
    { texto: 'Te dejé el escrito en la tarjeta: revisalo y tocá Agendar.' },
  ]);
  const r = await chat({ historial: [], texto: `Presentá la aprobación de planilla en Alfa el ${dia} y marcá la acción como realizada.` });
  assert.equal(r.status, 200);
  assert.equal(r.datos.borradores.length, 1);
  const b = r.datos.borradores[0];
  assert.equal(b.estado, 'borrador');
  assert.equal(b.titulo, 'Solicita aprobación de liquidación');
  assert.equal(b.cuerpo, 'En autos AMB c/ ALFA ANA – EJECUTIVO, expediente 1001, de la 2° nominación: solicito se apruebe la liquidación.');
  assert.equal(b.realizar, 'Solicitar aprobación de liquidación');
  assert.equal(b.caratula, 'AMB c/ ALFA ANA – EJECUTIVO');
  assert.equal(b.fecha, dia);
  assert.deepEqual(b.avisos, []);
  const [res] = await resultados();
  assert.equal(res.tarjeta, true);
  assert.match(res.importante, /toca "Ahora" y después "Ejecutar ahora".*no se presenta solo.*no está confirmado/i);
  assert.equal(sql(`select estado || '|' || actualizado_por from public.agenda where id = '${b.id}'`), 'borrador|Claude');
  // la tarea del SAC no lo ve: falta la confirmación
  assert.equal(sql(`select count(*) from gestor.agenda_del_dia()`), '0');
  // un segundo igual avisa que ya hay uno
  await guion([{ herramientas: [{ name: 'preparar_presentacion', input: { expte: '1001', fecha: dia, plantilla_id: 'aprobacion' } }] }, { texto: 'ok' }]);
  await chat({ historial: [], texto: 'otra vez' });
  const [otro] = await resultados();
  assert.match(otro.avisos.join(' '), /Ya hay un escrito igual en borrador/);
  sql(`delete from public.agenda`);
});

test('avisos: campos sin completar y documentos adjuntos; no se promete ningún horario', async () => {
  await olvidar();
  const sabado = sql(`select d::date from generate_series(gestor.hoy() + 1, gestor.hoy() + 7, '1 day') d where extract(isodow from d) = 6`);
  await guion([{ herramientas: [{ name: 'preparar_presentacion', input: { expte: '1002', fecha: sabado, titulo: 'Acompaña tasa', cuerpo: 'Acompaño tasa. Monto: {{monto}}' } }] }, { texto: 'ok' }]);
  await chat({ historial: [], texto: 'x' });
  const [r] = await resultados();
  assert.match(r.avisos.join(' '), /Quedaron campos sin completar: \{\{monto\}\}/);
  assert.match(r.avisos.join(' '), /acompaña documentos: la tarea que presenta en el SAC no adjunta archivos/);
  assert.equal(r.avisos.length, 2, 'ni fin de semana ni hora: nada se presenta solo');
  // las instrucciones del chat no prometen corridas automáticas
  const sistema = (await pedidos()).at(-1).cuerpo.system;
  assert.doesNotMatch(sistema, /10:15|de lunes a viernes/);
  assert.match(sistema, /No hay horario automático: nada se presenta solo/);
  sql(`delete from public.agenda`);
});

test('la conversación sigue: lo que devolvió vuelve igual, y se le suma lo nuevo', async () => {
  await olvidar();
  await guion([{ herramientas: [{ name: 'listar_plantillas', input: {} }] }, { texto: 'Hay una plantilla.' }, { texto: 'De nada.' }]);
  const r1 = await chat({ historial: [], texto: '¿Qué plantillas hay?' });
  const r2 = await chat({ historial: r1.datos.nuevos, texto: 'Gracias' });
  assert.equal(r2.status, 200);
  const ps = await pedidos();
  const enviado = ps.at(-1).cuerpo.messages;
  assert.deepEqual(enviado.slice(0, r1.datos.nuevos.length), r1.datos.nuevos);
  assert.match(textoDe(enviado.at(-1)), /\nGracias$/);
  // una conversación con otra forma no se acepta
  assert.equal((await chat({ historial: [{ role: 'assistant', content: [] }], texto: 'x' })).status, 400);
  assert.equal((await chat({ historial: r1.datos.nuevos.slice(0, -1), texto: 'x' })).status, 400);
  assert.equal((await chat({ historial: [], texto: '   ' })).status, 400);
  assert.equal((await chat({ historial: [], texto: 'x'.repeat(8001) })).status, 400);
});

test('si Claude falla antes de hacer nada, no se pierde el mensaje; si falla a mitad, vuelve lo hecho', async () => {
  await olvidar();
  await guion([{ error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } }, { error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } }]);
  let r = await chat({ historial: [], texto: 'hola' });
  assert.equal(r.status, 502);
  assert.match(r.datos.mensaje, /saturado/);
  assert.equal((await pedidos()).length, 2, 'reintenta una vez');

  await olvidar();
  await guion([{ error: { status: 400, type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }]);
  r = await chat({ historial: [], texto: 'hola' });
  assert.match(r.datos.mensaje, /sin crédito/);

  await olvidar();
  await guion([
    { herramientas: [{ name: 'editar_causa', input: { expte: '1002', agregar_a_notas: 'antes del corte' } }] },
    { error: { status: 500, type: 'api_error', message: 'Internal' } }, { error: { status: 500, type: 'api_error', message: 'Internal' } },
  ]);
  r = await chat({ historial: [], texto: 'anotá algo' });
  assert.equal(r.status, 200);
  assert.equal(r.datos.cambios, true);
  assert.deepEqual(r.datos.acciones, ['Causa 1002: notas actualizado']);
  assert.match(textoDe(r.datos.nuevos.at(-1)), /^Se cortó la respuesta: Claude está saturado/);
  assert.deepEqual(r.datos.nuevos.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'], 'sigue siendo una conversación válida');
});

test('CORS: solo responde al origen de la app', async () => {
  const preflight = (origen) => fetch(CHAT, { method: 'OPTIONS', headers: { origin: origen, 'access-control-request-method': 'POST' } });
  // (la puerta local agrega CORS propio; acá se mira la función directa)
  const directo = 'http://127.0.0.1:54330';
  let r = await fetch(directo, { method: 'OPTIONS', headers: { origin: 'https://emilsoler.github.io' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://emilsoler.github.io');
  r = await fetch(directo, { method: 'OPTIONS', headers: { origin: 'https://otro-sitio.example' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal((await preflight('http://127.0.0.1:8080')).status, 204);
});

// ───────── Escritos listos para presentar, vistos desde el chat ─────────

const escritoNuevo = (estado, fecha = 'gestor.hoy() + 3', realizar = '') => sql(`begin; select set_config('gestor.autor', 'Claude', true);
  insert into public.agenda (expte, titulo, cuerpo, fecha, estado, realizar) values ('1001', 'Solicita aprobación de liquidación', 'Texto original', ${fecha}, '${estado}', '${realizar}') returning id; commit;`).split('\n').find((l) => /^[0-9a-f-]{36}$/.test(l));
const fila = (id) => JSON.parse(sql(`select row_to_json(a) from public.agenda a where id = '${id}'`));

test('desde el chat: lo listo para presentar se ve como tal, y lo que se está presentando no se cancela ni se cambia', async () => {
  await olvidar();
  sql(`delete from public.agenda`);
  const id = escritoNuevo('pendiente', 'gestor.hoy()');
  sql(`update public.agenda set ahora = now() where id = '${id}'`);
  const dia = habil();
  await guion([{ herramientas: [{ name: 'ver_agenda', input: {} }] }, { herramientas: [{ name: 'reprogramar_presentacion', input: { id, fecha: dia } }] }, { texto: 'ok' }]);
  await chat({ historial: [], texto: '¿qué hay en la agenda? pasalo al próximo día hábil' });
  let ps = await pedidos();
  const [agenda] = ps[1].cuerpo.messages.at(-1).content.map((b) => JSON.parse(b.content));
  assert.equal(agenda.escritos[0].estado, 'listo para presentar: falta que la persona toque "Ejecutar ahora" en la tarea de Claude');
  assert.deepEqual([fila(id).fecha, fila(id).ahora], [dia, null], 'reprogramado: va en la corrida de ese día');

  sql(`update public.agenda set estado = 'presentando' where id = '${id}'`);
  await olvidar();
  await guion([{ herramientas: [{ name: 'ver_agenda', input: {} }, { name: 'cancelar_presentacion', input: { id } }, { name: 'reprogramar_presentacion', input: { id, fecha: dia } }] }, { texto: 'ok' }]);
  await chat({ historial: [], texto: 'cancelalo' });
  const [ver, cancelar, reprogramar] = await resultados();
  assert.equal(ver.escritos[0].estado, 'presentándose en el SAC en este momento');
  assert.match(cancelar.error, /se está presentando en el SAC en este momento: ya no se puede cancelar/);
  assert.match(reprogramar.error, /se está presentando en el SAC en este momento: no se puede reprogramar/);
  assert.equal(fila(id).estado, 'presentando');
  sql(`delete from public.agenda`);
});

test('sin la clave de la API, el chat lo dice en vez de fallar a ciegas', async () => {
  const deno = process.env.DENO || '/home/claude/.stack/deno/node_modules/.bin/deno';
  const p = spawn(deno, ['run', '--allow-net', '--allow-env', new URL('../../supabase/functions/chat/index.ts', import.meta.url).pathname], {
    env: { ...process.env, SUPABASE_URL: env.SUPABASE_URL, SUPABASE_ANON_KEY: env.ANON_KEY, DENO_SERVE_ADDRESS: 'tcp:127.0.0.1:54331', ANTHROPIC_API_KEY: '' },
    stdio: 'ignore',
  });
  try {
    let r;
    for (let i = 0; i < 40; i++) {
      try { r = await chat({ historial: [], texto: 'hola' }, { url: 'http://127.0.0.1:54331' }); break; } catch { await new Promise((ok) => setTimeout(ok, 250)); }
    }
    assert.equal(r.status, 503);
    assert.equal(r.datos.error, 'sin_clave');
    assert.match(r.datos.mensaje, /ANTHROPIC_API_KEY/);
  } finally { p.kill(); }
});

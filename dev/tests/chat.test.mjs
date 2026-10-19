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
const olvidar = () => Promise.all([fetch(`${FALSO}/__pedidos`, { method: 'DELETE' }), fetch(`${FALSO}/__disparos`, { method: 'DELETE' })]);
// La tarea programada del SAC, también en el doble (botón «Ahora»).
const tarea = (respuestas) => fetch(`${FALSO}/__tarea`, { method: 'POST', body: JSON.stringify(respuestas) });
const disparos = async () => (await fetch(`${FALSO}/__disparos`)).json();
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
    insert into public.causas (expte, actor, demandado, tipo, nom, oficina, estado, proxima, vence, notas, historial) values
      ('1001', 'AMB', 'ALFA ANA', 'EJECUTIVO', '2', 'OEP', 'Casillero', 'Solicitar aprobación de liquidación', gestor.hoy() + 1, 'tel 123', '[]'),
      ('1002', 'AMB', 'BETA BRUNO', 'PRENDARIO', '1', 'OEP', 'A despacho', '', null, '', '[]');
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
    { herramientas: [{ name: 'editar_causa', input: { expte: '1001', estado: 'A despacho', agregar_a_notas: 'Llamó el demandado' } }] },
    { herramientas: [{ name: 'registrar_movimiento', input: { expte: '1002', texto: 'Decreto: autos a despacho' } }] },
    { texto: 'Hecho.' },
  ]);
  const r = await chat({ historial: [], texto: 'Pasá Alfa a despacho, anotá que llamó, y en Beta anotá el decreto de hoy.' });
  assert.equal(r.status, 200);
  assert.equal(r.datos.nuevos.length, 10); // usuario + 4 × (asistente, resultados) + respuesta final
  assert.equal(r.datos.cambios, true);
  assert.deepEqual(r.datos.acciones, ['Causa 1001: estado, notas actualizados', `Causa 1002: movimiento anotado (${sql(`select to_char(gestor.hoy(), 'DD/MM/YYYY')`)}: Decreto: autos a despacho)`]);
  const ps = await pedidos();
  const res = (i) => ps[i].cuerpo.messages.at(-1).content.map((b) => JSON.parse(b.content));
  const [busqueda, pendientes] = res(1);
  assert.equal(busqueda.encontradas, 1);
  assert.equal(busqueda.causas[0].caratula, 'AMB c/ ALFA ANA – EJECUTIVO');
  assert.equal(pendientes.proximas_acciones[0].expte, '1001');
  assert.equal(pendientes.proximas_acciones[0].situacion.startsWith('vence el'), true);
  const [ficha] = res(2);
  assert.equal(ficha.notas, 'tel 123');
  assert.equal(ficha.nominacion, '2°');
  assert.equal(sql(`select estado || '|' || notas || '|' || actualizado_por from public.causas where expte = '1001'`), 'A despacho|tel 123\nLlamó el demandado|Claude');
  assert.equal(sql(`select ultima || '|' || (fecha = gestor.hoy()) || '|' || actualizado_por from public.causas where expte = '1002'`), 'Decreto: autos a despacho|true|Claude');
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
      { name: 'editar_causa', input: { expte: '9999', estado: 'A despacho' } },
      { name: 'editar_causa', input: { expte: '1001', estado: 'Inventado' } },
      { name: 'editar_causa', input: { expte: '1001' } },
      { name: 'editar_causa', input: { expte: '1001', etiquetas: ['Rara'] } },
      { name: 'registrar_movimiento', input: { expte: '1001', texto: 'Algo futuro', fecha: '2999-01-01' } },
      { name: 'ver_causa', input: { expte: '1001; drop table causas' } },
      { name: 'marcar_realizada', input: { expte: '1002' } },
      { name: 'preparar_presentacion', input: { expte: '1001', fecha: '2020-01-01', plantilla_id: 'aprobacion' } },
      { name: 'preparar_presentacion', input: { expte: '1001', fecha: habil(), plantilla_id: 'no-existe' } },
      { name: 'cancelar_presentacion', input: { id: '00000000-0000-0000-0000-000000000000' } },
      { name: 'herramienta_inventada', input: {} },
    ] },
    { texto: 'No pude.' },
  ]);
  const r = await chat({ historial: [], texto: 'Probá cosas raras.' });
  assert.equal(r.status, 200);
  const rs = await resultados();
  assert.equal(rs.length, 11);
  assert.ok(rs.every((x) => x.es_error && x.error), 'todos vuelven como error, explicado');
  assert.match(rs[0].error, /No existe la causa con expediente 9999/);
  assert.match(rs[1].error, /Estado desconocido/);
  assert.match(rs[2].error, /No mandaste ningún cambio/);
  assert.match(rs[3].error, /Etiquetas desconocidas: Rara/);
  assert.match(rs[4].error, /ya pasó/);
  assert.match(rs[5].error, /no es un N° de expediente/);
  assert.match(rs[6].error, /no tiene próxima acción/);
  assert.match(rs[7].error, /La fecha ya pasó/);
  assert.match(rs[8].error, /No existe la plantilla "no-existe".*Solicita aprobación de liquidación \(id aprobacion\)/);
  assert.match(rs[9].error, /No existe ese escrito/);
  assert.match(rs[10].error, /No existe la herramienta/);
  assert.equal(sql(`select string_agg(rev::text, ',' order by expte) from public.causas`), antes);
  assert.equal(sql(`select count(*) from public.agenda`), '0');
  assert.equal(r.datos.cambios, false);
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
  assert.match(res.importante, /hasta entonces no está agendado/i);
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

test('avisos: fin de semana, la tarea de hoy ya corrió, campos sin completar', async () => {
  await olvidar();
  const sabado = sql(`select d::date from generate_series(gestor.hoy() + 1, gestor.hoy() + 7, '1 day') d where extract(isodow from d) = 6`);
  await guion([{ herramientas: [{ name: 'preparar_presentacion', input: { expte: '1002', fecha: sabado, titulo: 'Acompaña tasa', cuerpo: 'Acompaño tasa. Monto: {{monto}}' } }] }, { texto: 'ok' }]);
  await chat({ historial: [], texto: 'x' });
  const [r] = await resultados();
  assert.match(r.avisos.join(' '), /es sábado: la tarea corre de lunes a viernes/);
  assert.match(r.avisos.join(' '), /Quedaron campos sin completar: \{\{monto\}\}/);
  assert.match(r.avisos.join(' '), /acompaña documentos: la tarea que presenta en el SAC no adjunta archivos/);
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

// ───────── Botón «Ahora» (ruta chat/ahora) ─────────

const AHORA = `${CHAT}/ahora`;
const escritoNuevo = (estado, fecha = 'gestor.hoy() + 3', realizar = '') => sql(`begin; select set_config('gestor.autor', 'Claude', true);
  insert into public.agenda (expte, titulo, cuerpo, fecha, estado, realizar) values ('1001', 'Solicita aprobación de liquidación', 'Texto original', ${fecha}, '${estado}', '${realizar}') returning id; commit;`).split('\n').find((l) => /^[0-9a-f-]{36}$/.test(l));
const fila = (id) => JSON.parse(sql(`select row_to_json(a) from public.agenda a where id = '${id}'`));

test('«Ahora»: confirma el escrito para hoy, firmado por la persona, y dispara la tarea del SAC', async () => {
  await olvidar();
  sql(`delete from public.agenda`);
  const id = escritoNuevo('borrador', `'${habil()}'`, 'Solicitar aprobación de liquidación');
  const r = await chat({ id, rev: fila(id).rev, titulo: ' Solicita aprobación (v2) ', cuerpo: 'Texto corregido\n\n', realizar: 'Solicitar aprobación de liquidación' }, { url: AHORA });
  assert.equal(r.status, 200);
  const hoy = sql(`select gestor.hoy()`);
  const f = fila(id);
  assert.deepEqual([f.estado, f.fecha, f.titulo, f.cuerpo, f.realizar, f.actualizado_por], ['pendiente', hoy, 'Solicita aprobación (v2)', 'Texto corregido', 'Solicitar aprobación de liquidación', 'Emi']);
  assert.ok(f.ahora && Math.abs(Date.now() - Date.parse(f.ahora)) < 60_000, 'con la hora del pedido');
  assert.equal(r.datos.fila.rev, f.rev, 'la app recibe la fila tal como quedó');
  assert.match(r.datos.sesion, /^https:\/\/claude\.ai\/code\/session_falsa_/);
  const [d, ...otros] = await disparos();
  assert.equal(otros.length, 0, 'un solo disparo');
  assert.equal(d.rutina, 'trig_prueba');
  assert.deepEqual(d.headers, { authorization: 'Bearer token-de-prueba', 'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'anthropic-version': '2023-06-01' });
  assert.equal(d.cuerpo.text, `Botón «Ahora» del gestor: Emi pidió presentar en el SAC el escrito ${id} (causa 1001).`);
  assert.deepEqual(await pedidos(), [], 'no pasa por la API de Claude');
  // la corrida que se disparó lo encuentra: es lo único pedido «Ahora»
  assert.equal(sql(`select id from gestor.agenda_tomar(true)`), id);

  // desde un escrito agendado para otro día, o uno que no se pudo presentar, también; lo
  // escrito en la tarjeta no cuenta si ya no es un borrador (el texto ya estaba confirmado)
  for (const estado of ['pendiente', 'error']) {
    const otro = escritoNuevo(estado);
    const r2 = await chat({ id: otro, rev: fila(otro).rev, titulo: 'Otro título', cuerpo: 'Otro texto' }, { url: AHORA });
    assert.equal(r2.status, 200, estado);
    assert.deepEqual([fila(otro).estado, fila(otro).fecha, fila(otro).titulo], ['pendiente', hoy, 'Solicita aprobación de liquidación']);
  }
  // desmarcar "dar por realizada" en la tarjeta la quita; no se puede poner otro texto
  const conAccion = escritoNuevo('borrador', 'gestor.hoy()', 'Solicitar aprobación de liquidación');
  await chat({ id: conAccion, rev: fila(conAccion).rev, realizar: 'cualquier otra cosa' }, { url: AHORA });
  assert.equal(fila(conAccion).realizar, '');
  sql(`delete from public.agenda`);
});

test('«Ahora»: si la tarea no arranca, el escrito queda como estaba', async () => {
  await olvidar();
  sql(`delete from public.agenda`);
  const borrador = escritoNuevo('borrador');
  const antes = fila(borrador);
  await tarea([{ status: 500 }]);
  let r = await chat({ id: borrador, rev: antes.rev, titulo: 'Corregido', cuerpo: 'Corregido' }, { url: AHORA });
  assert.equal(r.status, 502);
  assert.equal(r.datos.error, 'tarea');
  assert.match(r.datos.mensaje, /no arrancó \(respondió 500\)\..* No se agendó: sigue como borrador, con lo que corregiste\.$/);
  let f = fila(borrador);
  assert.deepEqual([f.estado, f.fecha, f.ahora, f.titulo, f.cuerpo], ['borrador', antes.fecha, null, 'Corregido', 'Corregido'], 'sin agendar, y lo corregido no se pierde');
  assert.equal(r.datos.fila.rev, f.rev, 'la app recibe cómo quedó');

  const agendado = escritoNuevo('pendiente');
  await tarea([{ status: 429 }]);
  r = await chat({ id: agendado, rev: fila(agendado).rev }, { url: AHORA });
  assert.equal(r.status, 429);
  assert.match(r.datos.mensaje, /demasiadas presentaciones seguidas.* Sigue agendado como antes\.$/);
  assert.deepEqual([fila(agendado).estado, fila(agendado).fecha, fila(agendado).ahora], ['pendiente', antes.fecha, null], 'sigue agendado para su día');

  await tarea([{ status: 401 }]);
  r = await chat({ id: agendado, rev: fila(agendado).rev }, { url: AHORA });
  assert.match(r.datos.mensaje, /no aceptó el token: hay que generar uno nuevo y cargarlo en Supabase \(secreto TAREA_SAC_TOKEN\)/);

  // si mientras tanto la corrida de las 10:15 ya lo tomó, no se vuelve atrás: se cuenta cómo quedó
  await tarea([{ status: 500, demora: 1200 }]);
  const enCurso = chat({ id: agendado, rev: fila(agendado).rev }, { url: AHORA });
  await new Promise((ok) => setTimeout(ok, 500));
  assert.equal(sql(`select id from gestor.agenda_tomar(false)`), agendado);
  r = await enCurso;
  assert.match(r.datos.mensaje, /Mientras tanto el escrito cambió/);
  assert.equal(r.datos.fila.estado, 'presentando');
  assert.equal(fila(agendado).estado, 'presentando');
  sql(`delete from public.agenda`);
});

test('«Ahora»: lo que no corresponde no toca nada ni dispara la tarea', async () => {
  await olvidar();
  sql(`delete from public.agenda`);
  const id = escritoNuevo('borrador');
  const rev = fila(id).rev;
  // revisión vieja: alguien lo cambió recién
  let r = await chat({ id, rev: rev - 1 }, { url: AHORA });
  assert.equal(r.status, 409);
  assert.equal(r.datos.error, 'conflicto');
  assert.equal(r.datos.fila.rev, rev);
  // ya presentado, presentándose o cancelado
  for (const [estado, texto] of [['presentado', /ya se presentó/], ['presentando', /ya se está presentando/], ['cancelado', /está cancelado/]]) {
    sql(`update public.agenda set estado = '${estado}' where id = '${id}'`);
    r = await chat({ id, rev: fila(id).rev }, { url: AHORA });
    assert.equal(r.status, 409, estado);
    assert.match(r.datos.mensaje, texto);
  }
  sql(`update public.agenda set estado = 'borrador' where id = '${id}'`);
  // título vacío: la base no lo acepta, y no se dispara nada
  r = await chat({ id, rev: fila(id).rev, titulo: '   ', cuerpo: 'x' }, { url: AHORA });
  assert.equal(r.status, 400);
  assert.match(r.datos.mensaje, /Completá el título y el texto/);
  // sin escrito, inexistente, sin sesión, sin autorización
  assert.equal((await chat({}, { url: AHORA })).status, 400);
  assert.equal((await chat({ id: '00000000-0000-0000-0000-000000000000', rev: 1 }, { url: AHORA })).status, 404);
  assert.equal((await chat({ id, rev: fila(id).rev }, { url: AHORA, jwt: null })).status, 401);
  await crearCuenta('ajeno@test.local', 'Clave-de-prueba-2026', 'Ajeno');
  const ajeno = (await entrar('ajeno@test.local', 'Clave-de-prueba-2026')).sesion.access_token;
  sql(`select gestor.quitar_usuario('ajeno@test.local')`);
  r = await chat({ id, rev: fila(id).rev }, { url: AHORA, jwt: ajeno });
  assert.equal(r.status, 403);
  assert.equal(r.datos.error, 'sin_acceso');
  assert.equal(fila(id).estado, 'borrador');
  assert.deepEqual(await disparos(), [], 'la tarea no se disparó nunca');
  sql(`delete from public.agenda`);
});

test('desde el chat: lo pedido «Ahora» se ve como tal, y lo que se está presentando no se cancela ni se cambia', async () => {
  await olvidar();
  sql(`delete from public.agenda`);
  const id = escritoNuevo('pendiente', 'gestor.hoy()');
  sql(`update public.agenda set ahora = now() where id = '${id}'`);
  const dia = habil();
  await guion([{ herramientas: [{ name: 'ver_agenda', input: {} }] }, { herramientas: [{ name: 'reprogramar_presentacion', input: { id, fecha: dia } }] }, { texto: 'ok' }]);
  await chat({ historial: [], texto: '¿qué hay en la agenda? pasalo al próximo día hábil' });
  let ps = await pedidos();
  const [agenda] = ps[1].cuerpo.messages.at(-1).content.map((b) => JSON.parse(b.content));
  assert.equal(agenda.escritos[0].estado, 'agendado para presentar ahora (botón «Ahora»)');
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

test('sin el token de la tarea, «Ahora» lo dice y no toca el escrito', async () => {
  const deno = process.env.DENO || '/home/claude/.stack/deno/node_modules/.bin/deno';
  const p = spawn(deno, ['run', '--allow-net', '--allow-env', new URL('../../supabase/functions/chat/index.ts', import.meta.url).pathname], {
    env: { ...process.env, SUPABASE_URL: env.SUPABASE_URL, SUPABASE_ANON_KEY: env.ANON_KEY, DENO_SERVE_ADDRESS: 'tcp:127.0.0.1:54332', ANTHROPIC_API_KEY: '', TAREA_SAC_TOKEN: '' },
    stdio: 'ignore',
  });
  sql(`delete from public.agenda`);
  const id = escritoNuevo('borrador');
  const antes = fila(id);
  try {
    let r;
    for (let i = 0; i < 40; i++) {
      try { r = await chat({ id, rev: antes.rev }, { url: 'http://127.0.0.1:54332/chat/ahora' }); break; } catch { await new Promise((ok) => setTimeout(ok, 250)); }
    }
    assert.equal(r.status, 503);
    assert.equal(r.datos.error, 'sin_token');
    assert.match(r.datos.mensaje, /TAREA_SAC_TOKEN\)\. El escrito quedó como estaba\.$/);
    assert.equal(fila(id).rev, antes.rev);
  } finally { p.kill(); sql(`delete from public.agenda`); }
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

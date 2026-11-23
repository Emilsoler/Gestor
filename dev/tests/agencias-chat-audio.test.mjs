// Mensajes de voz del chat «M» (migración 0040): la función `agencias` en local contra la base local, el doble de Claude y el
// doble del almacenamiento (dev/storage-falso.mjs).
//
// Lo que se controla: que un audio solo se pueda mandar con una persona de la Mutual en la conversación (nunca al asistente),
// que se valide por los primeros bytes y por el tamaño, que quede en la carpeta privada `chat-audios`, que la agencia nunca
// vea la ruta, que la Mutual y la propia agencia puedan escucharlo y ninguna otra agencia, y que la base cuide el formato.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sql, sqlFalla, limpiar, crearCuenta, entrar, env, servicio } from './helpers.mjs';
import { tipoAudio, segundosDeAudio, MAX_AUDIO_BYTES, MAX_AUDIO_SEG, TEXTO_AUDIO } from '../../supabase/functions/agencias/chat.js';

const FN = `${env.SUPABASE_URL}/functions/v1/agencias`;
const CLAUDE = 'http://127.0.0.1:54340';
const ALMACEN = 'http://127.0.0.1:54344';
const guion = (pasos) => fetch(`${CLAUDE}/__guion`, { method: 'POST', body: JSON.stringify(pasos) });
const objetos = async () => (await fetch(`${ALMACEN}/__objetos`)).json();

// Un audio mínimo que se reconoce por sus primeros bytes (no hace falta que suene).
const MP4 = (n = 3000) => { const b = new Uint8Array(n); b.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]); b.fill(7, 12); return b; };
const WEBM = (n = 2000) => { const b = new Uint8Array(n); b.set([0x1a, 0x45, 0xdf, 0xa3]); b.fill(9, 4); return b; };
const OGG = (n = 2000) => { const b = new Uint8Array(n); b.set([0x4f, 0x67, 0x67, 0x53]); b.fill(5, 4); return b; };
const PDF = new TextEncoder().encode('%PDF-1.4\n% no es un audio\n%%EOF\n');

async function pedir(jwt, cuerpo) {
  const r = await fetch(FN, {
    method: 'POST',
    headers: { apikey: env.ANON_KEY, 'content-type': 'application/json', origin: 'http://127.0.0.1:8080', authorization: `Bearer ${jwt}` },
    body: JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  return { status: r.status, datos: JSON.parse(texto), texto };
}
async function mandarAudio(jwt, bytes, seg = 7, nombre = 'audio.m4a') {
  const fd = new FormData();
  fd.append('accion', 'chat_audio');
  if (seg !== null) fd.append('seg', String(seg));
  fd.append('audio', new Blob([bytes]), nombre);
  const r = await fetch(FN, { method: 'POST', headers: { apikey: env.ANON_KEY, origin: 'http://127.0.0.1:8080', authorization: `Bearer ${jwt}` }, body: fd });
  const texto = await r.text();
  return { status: r.status, datos: JSON.parse(texto), texto };
}
const deBase64 = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'));

let emi, agencia, otra;

before(async () => {
  limpiar();
  await fetch(`${ALMACEN}/__objetos`, { method: 'DELETE' });
  sql(`delete from public.chats_agencia; delete from public.cotizaciones_agencia; delete from public.agencias;
       update public.ajustes_agencias set habilitado = true, chat_habilitado = true, pct_financiable = 40, plazos = '{12,24}', tope_diario = 300;`);
  await crearCuenta('emi@test.local', 'Clave-de-prueba-2026', 'Emi');
  emi = (await entrar('emi@test.local', 'Clave-de-prueba-2026')).sesion.access_token;
  for (const [email, nombre] of [['salon@test.local', 'Salón Uno'], ['otra@test.local', 'Otra Agencia']]) {
    const { error } = await servicio().auth.admin.createUser({ email, password: 'Agencia-123456', email_confirm: true });
    assert.ifError(error);
    sql(`select gestor.autorizar_agencia('${email}', '${nombre}', gestor.hoy())`);
  }
  agencia = (await entrar('salon@test.local', 'Agencia-123456')).sesion.access_token;
  otra = (await entrar('otra@test.local', 'Agencia-123456')).sesion.access_token;
  await pedir(agencia, { accion: 'clave_definida' });
  await pedir(otra, { accion: 'clave_definida' });
});

test('se reconoce el audio por sus primeros bytes y la duración se acota', () => {
  assert.deepEqual(tipoAudio(MP4()), { tipo: 'audio/mp4', ext: 'm4a' });
  assert.deepEqual(tipoAudio(WEBM()), { tipo: 'audio/webm', ext: 'webm' });
  assert.deepEqual(tipoAudio(OGG()), { tipo: 'audio/ogg', ext: 'ogg' });
  assert.equal(tipoAudio(PDF), null);
  assert.equal(tipoAudio(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1])), null, 'una foto no es un audio');
  assert.equal(tipoAudio(new Uint8Array(0)), null);
  assert.equal(segundosDeAudio('7'), 7);
  assert.equal(segundosDeAudio(6.6), 7);
  assert.equal(segundosDeAudio(9999), MAX_AUDIO_SEG, 'tope de 2 minutos');
  for (const malo of [0, -3, 'abc', null, undefined, NaN]) assert.equal(segundosDeAudio(malo), null, String(malo));
  assert.equal(MAX_AUDIO_BYTES, 3 * 1024 * 1024);
  // La carpeta real admite lo mismo que el doble y la migración.
  const mig = readFileSync(new URL('../../supabase/migrations/0040_agencias_chat_audio.sql', import.meta.url), 'utf8');
  assert.match(mig, /file_size_limit[^)]*\)\s*values \('chat-audios', 'chat-audios', false, 3145728, array\['audio\/mp4', 'audio\/webm', 'audio\/ogg'\]\)/);
});

test('un audio no se manda al asistente: hace falta una persona de la Mutual en la conversación', async () => {
  // Sin ninguna conversación.
  let r = await mandarAudio(agencia, MP4());
  assert.equal(r.status, 409);
  assert.equal(r.datos.error, 'audio_sin_representante');
  // Con el asistente contestando.
  await guion([{ texto: 'Escribí el CUIT del cliente y tocá «Consultar BCRA».' }]);
  assert.equal((await pedir(agencia, { accion: 'chat_enviar', texto: '¿Cómo empiezo?' })).datos.chat.estado, 'bot');
  r = await mandarAudio(agencia, MP4());
  assert.equal(r.status, 409);
  assert.equal(r.datos.error, 'audio_sin_representante');
  assert.equal((await objetos()).filter((o) => o.clave.startsWith('chat-audios/')).length, 0, 'no se guardó nada');
  assert.equal(sql('select count(*) from public.mensajes_agencia where audio_path is not null'), '0');
});

test('con un representante en la conversación, el audio se guarda en la carpeta privada y se registra sin mostrar la ruta', async () => {
  const rep = await pedir(agencia, { accion: 'chat_representante' });
  assert.equal(rep.datos.chat.estado, 'espera');
  const bytes = MP4(4096);
  const r = await mandarAudio(agencia, bytes, 12);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.datos.chat.estado, 'espera', 'el estado no cambia');
  assert.equal(r.datos.mensajes.length, 1);
  const m = r.datos.mensajes[0];
  assert.deepEqual({ de: m.de, texto: m.texto, seg: m.audio_seg }, { de: 'agencia', texto: TEXTO_AUDIO, seg: 12 });
  assert.ok(!/audio_path|audio_tipo|chat-audios|\.m4a/.test(r.texto), `la ruta no sale: ${r.texto}`);
  const guardados = (await objetos()).filter((o) => o.clave.startsWith('chat-audios/'));
  assert.equal(guardados.length, 1);
  assert.equal(guardados[0].tipo, 'audio/mp4');
  assert.equal(guardados[0].tamano, 4096);
  assert.equal(sql(`select count(*) from public.mensajes_agencia where audio_path like '${sql('select id from public.chats_agencia limit 1')}/%'`), '1', 'queda bajo la carpeta de su conversación');
  assert.equal(sql(`select audio_tipo || ' ' || audio_seg from public.mensajes_agencia where audio_path is not null`), 'audio/mp4 12');
});

test('se rechaza lo que no es un audio, lo vacío, lo demasiado grande y lo que no dice cuánto dura', async () => {
  const antes = (await objetos()).length;
  let r = await mandarAudio(agencia, PDF, 5, 'audio.m4a');
  assert.equal(r.status, 415, 'por los bytes, no por el nombre');
  assert.equal(r.datos.error, 'tipo');
  r = await mandarAudio(agencia, new Uint8Array(0), 5);
  assert.equal(r.status, 400);
  assert.equal(r.datos.error, 'vacio');
  r = await mandarAudio(agencia, MP4(MAX_AUDIO_BYTES + 1), 5);
  assert.equal(r.status, 413);
  assert.equal(r.datos.error, 'tamano');
  r = await mandarAudio(agencia, MP4(), null);
  assert.equal(r.status, 400, 'sin duración');
  r = await mandarAudio(agencia, MP4(), 0);
  assert.equal(r.status, 400);
  assert.equal((await objetos()).length, antes, 'no se guardó nada de lo rechazado');
  // webm y ogg (Android y PC) pasan.
  assert.equal((await mandarAudio(agencia, WEBM(), 3, 'audio.webm')).status, 200);
  assert.equal((await mandarAudio(agencia, OGG(), 4, 'audio.ogg')).status, 200);
  // Una duración exagerada se acota a 2 minutos.
  const largo = await mandarAudio(agencia, MP4(), 9999);
  assert.equal(largo.datos.mensajes[0].audio_seg, MAX_AUDIO_SEG);
});

test('la Mutual ve que hay audios, los escucha, y se le avisa como un mensaje más', async () => {
  const lista = await pedir(emi, { accion: 'chats' });
  const [c] = lista.datos.chats;
  assert.equal(c.ultimo.texto, TEXTO_AUDIO);
  assert.equal(c.sin_leer_mutual, true);
  const v = await pedir(emi, { accion: 'chat_ver', chat: c.id });
  const audios = v.datos.mensajes.filter((m) => m.audio_seg);
  assert.equal(audios.length, 4);
  assert.ok(!/audio_path|chat-audios/.test(v.texto), 'tampoco la Mutual ve la ruta: pide el audio a la función');
  const a = await pedir(emi, { accion: 'chat_audio_ver', mensaje: audios[0].id });
  assert.equal(a.status, 200, a.texto);
  assert.deepEqual({ tipo: a.datos.tipo, seg: a.datos.seg }, { tipo: 'audio/mp4', seg: 12 });
  const bajado = deBase64(a.datos.datos);
  assert.equal(bajado.length, 4096);
  assert.deepEqual(bajado, MP4(4096), 'vuelve idéntico a lo que se grabó');
  const w = await pedir(emi, { accion: 'chat_audio_ver', mensaje: audios[1].id });
  assert.equal(w.datos.tipo, 'audio/webm');
});

test('la agencia escucha sus propios audios; otra agencia no, y un mensaje de texto no tiene audio', async () => {
  const mios = (await pedir(agencia, { accion: 'chat_leer', desde: 0 })).datos;
  const audios = mios.mensajes.filter((m) => m.audio_seg);
  assert.equal(audios.length, 4);
  assert.ok(!/audio_path|chat-audios/.test(JSON.stringify(mios)));
  const propio = await pedir(agencia, { accion: 'chat_audio_ver', mensaje: audios[0].id });
  assert.equal(propio.status, 200);
  assert.equal(deBase64(propio.datos.datos).length, 4096);
  const ajeno = await pedir(otra, { accion: 'chat_audio_ver', mensaje: audios[0].id });
  assert.equal(ajeno.status, 404, 'otra agencia no lo puede escuchar');
  assert.equal(ajeno.datos.error, 'audio');
  const texto = mios.mensajes.find((m) => !m.audio_seg);
  assert.equal((await pedir(agencia, { accion: 'chat_audio_ver', mensaje: texto.id })).status, 404);
  assert.equal((await pedir(emi, { accion: 'chat_audio_ver', mensaje: texto.id })).status, 404);
  for (const malo of [0, -1, 'x', null, 1.5]) assert.equal((await pedir(emi, { accion: 'chat_audio_ver', mensaje: malo })).status, 400, `mensaje ${malo}`);
});

test('cada lado hace lo suyo con los audios', async () => {
  // La Mutual no manda audios como agencia, y una cuenta sin sesión no hace nada.
  assert.equal((await mandarAudio(emi, MP4())).status, 400);
  const sin = await fetch(FN, { method: 'POST', headers: { apikey: env.ANON_KEY, origin: 'http://127.0.0.1:8080' }, body: new FormData() });
  assert.equal(sin.status, 401);
  // Con el chat apagado, ni la agencia manda ni escucha.
  sql(`update public.ajustes_agencias set chat_habilitado = false`);
  assert.equal((await mandarAudio(agencia, MP4())).datos.error, 'chat_apagado');
  assert.equal((await pedir(agencia, { accion: 'chat_audio_ver', mensaje: 1 })).datos.error, 'chat_apagado');
  assert.equal((await pedir(agencia, { accion: 'chat_leer', desde: 0 })).datos.error, 'chat_apagado');
  sql(`update public.ajustes_agencias set chat_habilitado = true`);
  // Un multipart de otra acción sigue sin aceptarse.
  const fd = new FormData(); fd.append('accion', 'chats');
  const raro = await fetch(FN, { method: 'POST', headers: { apikey: env.ANON_KEY, origin: 'http://127.0.0.1:8080', authorization: `Bearer ${emi}` }, body: fd });
  assert.equal(raro.status, 400);
});

test('el audio cuenta para el tope diario de mensajes de la agencia', async () => {
  const hoy = Number(sql(`select count(*) from public.mensajes_agencia where de = 'agencia'`));
  assert.ok(hoy >= 5, 'el texto de antes y los audios');
  // Se llena el cupo con filas directas (200 por día) y el siguiente audio se frena.
  sql(`insert into public.mensajes_agencia (chat_id, de, texto)
       select (select id from public.chats_agencia limit 1), 'agencia', 'relleno' from generate_series(1, ${200 - hoy})`);
  const r = await mandarAudio(agencia, MP4(), 3);
  assert.equal(r.status, 429);
  assert.equal(r.datos.error, 'tope');
});

test('la base cuida el formato: un audio es completo, solo de la agencia y de un tipo conocido', () => {
  const chat = sql('select id from public.chats_agencia limit 1');
  const mal = (valores, motivo) => assert.match(sqlFalla(`insert into public.mensajes_agencia (chat_id, de, texto, audio_path, audio_seg, audio_tipo) values ('${chat}', ${valores})`), motivo);
  mal(`'bot', 'x', '${chat}/a.m4a', 5, 'audio/mp4'`, /audio_de_agencia/);
  mal(`'mutual', 'x', '${chat}/a.m4a', 5, 'audio/mp4'`, /audio_de_agencia/);
  mal(`'agencia', 'x', '${chat}/a.m4a', null, 'audio/mp4'`, /audio_completo/);
  mal(`'agencia', 'x', null, 5, 'audio/mp4'`, /audio_completo/);
  mal(`'agencia', 'x', '${chat}/a.mp3', 5, 'audio/mpeg'`, /audio_tipo_check/);
  mal(`'agencia', 'x', '${chat}/a.m4a', 181, 'audio/mp4'`, /audio_seg_check/);
  mal(`'agencia', 'x', '${chat}/a.m4a', 0, 'audio/mp4'`, /audio_seg_check/);
});

test('las columnas del audio no se leen por la API, ni siquiera con la sesión de la Mutual', async () => {
  for (const [correo, clave] of [['salon@test.local', 'Agencia-123456'], ['emi@test.local', 'Clave-de-prueba-2026']]) {
    const c = await entrar(correo, clave);
    const { data, error } = await c.from('mensajes_agencia').select('audio_path');
    assert.ok(error || !data?.length, `${correo}: ${JSON.stringify(data)}`);
  }
  assert.equal(sql(`select has_table_privilege('authenticated', 'public.mensajes_agencia', 'select')`), 'f');
  assert.equal(sql(`select has_table_privilege('anon', 'public.mensajes_agencia', 'select')`), 'f');
});

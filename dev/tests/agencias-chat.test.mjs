// Chat de las agencias (botón «M»): la función `agencias` corriendo en local contra la base local, un doble de la API de
// Claude (dev/claude-falso.mjs), un doble de Resend y un «celular» falso que recibe los avisos cifrados (Web Push).
//
// Lo que se controla: que el asistente reciba solo lo que puede saber la agencia, que nunca diga lo que no puede, que
// pedir un representante avise a la Mutual (celular y mail) y solo una vez por tanda, que la Mutual conteste y la agencia
// lo vea, que las tablas del chat estén cerradas a la API y que cada lado solo pueda hacer lo suyo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sql, limpiar, crearCuenta, entrar, env, servicio } from './helpers.mjs';
import { celular, descifrar } from './push-lector.mjs';

const FN = `${env.SUPABASE_URL}/functions/v1/agencias`;
const CLAUDE = 'http://127.0.0.1:54340';
const guion = (pasos) => fetch(`${CLAUDE}/__guion`, { method: 'POST', body: JSON.stringify(pasos) });
const pedidosClaude = async () => (await fetch(`${CLAUDE}/__pedidos`)).json();
const olvidarClaude = () => fetch(`${CLAUDE}/__pedidos`, { method: 'DELETE' });

async function pedir(jwt, cuerpo) {
  const r = await fetch(FN, {
    method: 'POST',
    headers: { apikey: env.ANON_KEY, 'content-type': 'application/json', origin: 'http://127.0.0.1:8080', authorization: `Bearer ${jwt}` },
    body: JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  return { status: r.status, datos: JSON.parse(texto), texto };
}

// ── Dobles: el servidor de avisos del celular y Resend ──
let avisos = [], mails = [], respuestaPush = 201;
const servidores = [];
function servidor(puerto, alRecibir) {
  const s = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => { const r = alRecibir(req, Buffer.concat(partes)); res.writeHead(r).end(); });
  });
  servidores.push(s);
  return new Promise((ok) => s.listen(puerto, '127.0.0.1', ok));
}

let emi, agencia, otra, tel;
const sinFiltraciones = (texto) => assert.ok(!/codia|valuaci|infoauto|pct_financiable/i.test(texto), `no debe aparecer: ${texto.slice(0, 200)}`);

before(async () => {
  limpiar();
  sql(`delete from public.avisos_push; delete from public.push_claves; delete from public.chats_agencia; delete from public.cotizaciones_agencia; delete from public.agencias;
       update public.ajustes_agencias set habilitado = true, chat_habilitado = false, pct_financiable = 40, plazos = '{12,24}', tope_diario = 300, contacto = '3537-000000', relacion_max = 45;`);
  await servidor(54346, (req, cuerpo) => { avisos.push({ url: req.url, headers: req.headers, cuerpo }); return respuestaPush; });
  await servidor(54345, (req, cuerpo) => { mails.push({ headers: req.headers, cuerpo: JSON.parse(cuerpo.toString() || '{}') }); return 200; });
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
  tel = await celular();
  tel.sub.endpoint = 'http://127.0.0.1:54346/push/celular-de-emi';
});
after(() => { for (const s of servidores) s.close(); });

test('con el chat apagado, la agencia no lo ve ni lo puede usar', async () => {
  assert.equal((await pedir(agencia, { accion: 'yo' })).datos.chat, false);
  const r = await pedir(agencia, { accion: 'chat_enviar', texto: 'Hola' });
  assert.equal(r.status, 403);
  assert.equal(r.datos.error, 'chat_apagado');
  sql(`update public.ajustes_agencias set chat_habilitado = true`);
  assert.equal((await pedir(agencia, { accion: 'yo' })).datos.chat, true);
  assert.equal((await pedir(emi, { accion: 'yo' })).datos.chat, false, 'la vista previa de la Mutual no tiene la «M»');
});

test('el asistente recibe la hoja y los datos que la agencia ya ve, y nada que deje deducir el valor del auto', async () => {
  await olvidarClaude();
  await guion([{ texto: '**Primero** escribí el CUIT del cliente y tocá «Consultar BCRA».' }]);
  const r = await pedir(agencia, { accion: 'chat_enviar', texto: '¿Cómo empiezo una cotización?' });
  assert.equal(r.status, 200);
  assert.equal(r.datos.chat.estado, 'bot');
  assert.deepEqual(r.datos.mensajes.map((m) => m.de), ['agencia', 'bot']);
  assert.equal(r.datos.mensajes[1].texto, 'Primero escribí el CUIT del cliente y tocá «Consultar BCRA».', 'sin formato');
  assert.equal(r.datos.derivar, false);
  const [p] = await pedidosClaude();
  assert.equal(p.headers['x-api-key'], 'clave-de-prueba');
  assert.ok(p.cuerpo.model);
  assert.match(p.cuerpo.system, /HOJA DE RESPUESTAS/);
  assert.match(p.cuerpo.system, /SEMÁFORO DEL BCRA/, 'la hoja base de la migración 0038');
  assert.match(p.cuerpo.system, /12, 24/);
  assert.match(p.cuerpo.system, /3537-000000/);
  assert.ok(!/\b40\b/.test(p.cuerpo.system.replace(/40 archivos/g, '')), 'no se le pasa el % del valor del vehículo');
  assert.deepEqual(p.cuerpo.messages, [{ role: 'user', content: '¿Cómo empiezo una cotización?' }]);
  sinFiltraciones(r.texto);
});

test('la conversación se retoma y le llega entera al asistente', async () => {
  await olvidarClaude();
  await guion([{ texto: 'La cuota no puede pasar el 45 % del ingreso.' }]);
  const r = await pedir(agencia, { accion: 'chat_enviar', texto: '¿Y los ingresos?' });
  assert.equal(r.status, 200);
  const [p] = await pedidosClaude();
  assert.deepEqual(p.cuerpo.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  const leido = await pedir(agencia, { accion: 'chat_leer', desde: 0 });
  assert.equal(leido.datos.mensajes.length, 4);
  assert.equal((await pedir(agencia, { accion: 'chat_leer', desde: leido.datos.mensajes[2].id })).datos.mensajes.length, 1, 'solo lo nuevo');
});

test('lo que nunca puede decir el asistente se reemplaza y se ofrece el representante', async () => {
  await guion([{ texto: 'Según InfoAuto el valor del auto es alto.' }]);
  const r = await pedir(agencia, { accion: 'chat_enviar', texto: '¿Cuánto vale un Cronos?' });
  assert.equal(r.datos.derivar, true);
  assert.ok(!/infoauto/i.test(r.datos.mensajes[1].texto));
  await guion([{ texto: 'Eso lo tiene que ver una persona de la Mutual. [[REPRESENTANTE]]' }]);
  const q = await pedir(agencia, { accion: 'chat_enviar', texto: 'Tengo un reclamo' });
  assert.equal(q.datos.derivar, true);
  assert.ok(!q.datos.mensajes[1].texto.includes('[['));
});

test('si Claude falla, la agencia no ve el motivo: se le ofrece el representante', async () => {
  for (const error of [{ status: 401, type: 'authentication_error', message: 'invalid x-api-key' }, { status: 400, type: 'invalid_request_error', message: 'Your credit balance is too low' }]) {
    await guion([{ error }]);
    const r = await pedir(agencia, { accion: 'chat_enviar', texto: 'Una duda' });
    assert.equal(r.status, 200);
    assert.equal(r.datos.derivar, true);
    assert.match(r.datos.mensajes[1].texto, /representante/);
    assert.ok(!/crédito|credit|clave|key|api/i.test(r.datos.mensajes[1].texto), r.datos.mensajes[1].texto);
  }
});

test('pedir un representante deja la conversación en espera y avisa a la Mutual por celular y por mail', async () => {
  // La Mutual registra su celular (la función crea el par VAPID la primera vez).
  const clave = await pedir(emi, { accion: 'push_clave' });
  assert.equal(clave.status, 200);
  assert.match(clave.datos.publica, /^[\w-]{87}$/);
  assert.equal((await pedir(emi, { accion: 'push_clave' })).datos.publica, clave.datos.publica, 'la clave es siempre la misma');
  const mal = await pedir(emi, { accion: 'push_suscribir', suscripcion: { endpoint: 'http://ejemplo.com/x', keys: tel.sub } });
  assert.equal(mal.status, 400);
  assert.equal((await pedir(emi, { accion: 'push_suscribir', suscripcion: { endpoint: tel.sub.endpoint, keys: { p256dh: tel.sub.p256dh, auth: tel.sub.auth } }, agente: 'iPhone de prueba' })).status, 200);
  assert.equal((await pedir(agencia, { accion: 'push_suscribir', suscripcion: { endpoint: tel.sub.endpoint } })).status, 400, 'una agencia no registra celulares');

  avisos = []; mails = [];
  const r = await pedir(agencia, { accion: 'chat_representante' });
  assert.equal(r.status, 200);
  assert.equal(r.datos.chat.estado, 'espera');
  assert.match(r.datos.mensajes[0].texto, /avisé a la Mutual/);
  // El celular recibió un aviso que solo él puede leer.
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].url, '/push/celular-de-emi');
  assert.equal(avisos[0].headers['content-encoding'], 'aes128gcm');
  assert.match(avisos[0].headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
  const aviso = JSON.parse(await descifrar(new Uint8Array(avisos[0].cuerpo), tel.par, tel.auth));
  assert.equal(aviso.t, 'Salón Uno quiere hablar con vos');
  assert.equal(aviso.c, 'Una duda', 'la última consulta de la agencia');
  assert.equal(aviso.u, '/Gestor/cobranzas/#agencias-chats');
  // Y el mail de respaldo.
  assert.equal(mails.length, 1);
  assert.equal(mails[0].headers.authorization, 'Bearer clave-resend');
  assert.deepEqual(mails[0].cuerpo.to, ['emi@mutual.test']);
  assert.equal(mails[0].cuerpo.subject, 'Salón Uno quiere hablar con vos');
  // Pedirlo otra vez no vuelve a avisar.
  assert.equal((await pedir(agencia, { accion: 'chat_representante' })).datos.mensajes.length, 0);
  assert.equal(avisos.length, 1);
});

test('en espera el asistente se calla; se avisa de un mensaje nuevo solo si la Mutual leyó lo anterior', async () => {
  await olvidarClaude(); avisos = []; mails = [];
  const a = await pedir(agencia, { accion: 'chat_enviar', texto: 'Sigo esperando' });
  assert.deepEqual(a.datos.mensajes.map((m) => m.de), ['agencia']);
  assert.equal((await pedidosClaude()).length, 0, 'no se le pregunta nada a Claude con una persona en juego');
  assert.equal(avisos.length, 0, 'la Mutual todavía no leyó lo anterior: no se le insiste');
  // La Mutual abre la lista y la conversación.
  const lista = await pedir(emi, { accion: 'chats' });
  assert.equal(lista.status, 200);
  assert.equal(lista.datos.espera, 1);
  assert.equal(lista.datos.atencion, 1);
  assert.equal(lista.datos.chats.length, 1);
  const c = lista.datos.chats[0];
  assert.equal(c.agencia, 'Salón Uno');
  assert.equal(c.estado, 'espera');
  assert.equal(c.ultimo.texto, 'Sigo esperando');
  const v = await pedir(emi, { accion: 'chat_ver', chat: c.id });
  assert.equal(v.datos.chat.sin_leer_mutual, false, 'al abrirla queda como leída');
  assert.ok(v.datos.mensajes.length >= 7);
  assert.equal((await pedir(emi, { accion: 'chat_resumen' })).datos.sin_leer, 0);
  // Ahora sí: con lo anterior leído, el mensaje siguiente avisa (una vez).
  await pedir(agencia, { accion: 'chat_enviar', texto: '¿Alguien me contesta?' });
  assert.equal(avisos.length, 1);
  assert.equal(JSON.parse(await descifrar(new Uint8Array(avisos[0].cuerpo), tel.par, tel.auth)).t, 'Salón Uno: mensaje nuevo');
  await pedir(agencia, { accion: 'chat_enviar', texto: 'Gracias' });
  assert.equal(avisos.length, 1, 'sin leer no se vuelve a avisar');
});

test('la Mutual responde y la agencia lo ve; con lo leído se apaga el aviso', async () => {
  const [c] = (await pedir(emi, { accion: 'chats' })).datos.chats;
  const r = await pedir(emi, { accion: 'chat_responder', chat: c.id, texto: 'Hola, soy Emi. ¿Qué necesitás?' });
  assert.equal(r.status, 200);
  assert.equal(r.datos.mensaje.de, 'mutual');
  assert.equal((await pedir(emi, { accion: 'chats' })).datos.chats[0].estado, 'humano');
  const antes = await pedir(agencia, { accion: 'chat_leer', desde: 0 });
  assert.equal(antes.datos.chat.estado, 'humano');
  assert.equal(antes.datos.chat.sin_leer, true);
  assert.equal(antes.datos.mensajes.at(-1).texto, 'Hola, soy Emi. ¿Qué necesitás?');
  assert.equal((await pedir(agencia, { accion: 'chat_leer', desde: 0, leido: true })).datos.chat.sin_leer, true, 'trae el estado de antes de leer');
  assert.equal((await pedir(agencia, { accion: 'chat_leer', desde: 0 })).datos.chat.sin_leer, false);
  assert.equal((await pedir(emi, { accion: 'chat_responder', chat: c.id, texto: '  ' })).status, 400);
  assert.equal((await pedir(emi, { accion: 'chat_responder', chat: 'no-es-un-id', texto: 'x' })).status, 400);
});

test('un celular que ya no recibe avisos (410) se borra solo', async () => {
  respuestaPush = 410; avisos = [];
  const [c] = (await pedir(emi, { accion: 'chats' })).datos.chats;
  await pedir(emi, { accion: 'chat_ver', chat: c.id }); // lee lo anterior para que el próximo mensaje avise
  await pedir(agencia, { accion: 'chat_enviar', texto: 'Otro mensaje' });
  assert.equal(avisos.length, 1);
  assert.equal(sql('select count(*) from public.avisos_push'), '0');
  respuestaPush = 201;
});

test('el aviso de prueba llega al celular de quien lo pide', async () => {
  await pedir(emi, { accion: 'push_suscribir', suscripcion: { endpoint: tel.sub.endpoint, keys: { p256dh: tel.sub.p256dh, auth: tel.sub.auth } } });
  avisos = []; mails = [];
  const r = await pedir(emi, { accion: 'push_probar' });
  assert.equal(r.status, 200);
  assert.deepEqual({ e: r.datos.enviados, f: r.datos.fallidos, c: r.datos.celulares }, { e: 1, f: 0, c: 1 });
  assert.equal(JSON.parse(await descifrar(new Uint8Array(avisos[0].cuerpo), tel.par, tel.auth)).t, 'Aviso de prueba');
  assert.equal(mails.length, 0, 'la prueba es solo del celular');
  assert.equal((await pedir(emi, { accion: 'push_quitar', suscripcion: { endpoint: tel.sub.endpoint } })).status, 200);
  assert.equal(sql('select count(*) from public.avisos_push'), '0');
});

test('cada lado hace lo suyo', async () => {
  const [c] = (await pedir(emi, { accion: 'chats' })).datos.chats;
  for (const accion of ['chats', 'chat_resumen', 'push_clave', 'push_probar']) assert.equal((await pedir(agencia, { accion })).status, 400, `la agencia no puede ${accion}`);
  assert.equal((await pedir(agencia, { accion: 'chat_ver', chat: c.id })).status, 400);
  assert.equal((await pedir(agencia, { accion: 'chat_responder', chat: c.id, texto: 'x' })).status, 400);
  assert.equal((await pedir(emi, { accion: 'chat_enviar', texto: 'hola' })).status, 400, 'la Mutual no chatea como agencia');
  // Una agencia no ve la conversación de otra.
  const nada = await pedir(otra, { accion: 'chat_leer', desde: 0 });
  assert.equal(nada.datos.chat, null);
  assert.deepEqual(nada.datos.mensajes, []);
});

test('las tablas del chat están cerradas a la API, para la agencia y también para la Mutual', async () => {
  for (const sesion of ['salon@test.local', 'emi@test.local']) {
    const c = await entrar(sesion, sesion.startsWith('emi') ? 'Clave-de-prueba-2026' : 'Agencia-123456');
    for (const t of ['chats_agencia', 'mensajes_agencia', 'avisos_push', 'push_claves']) {
      const { data, error } = await c.from(t).select('*');
      assert.ok(error || !data?.length, `${t} no debería leerse con ${sesion}: ${JSON.stringify(data)}`);
    }
  }
  const { data, error } = await servicio().from('push_claves').select('publica');
  assert.ifError(error);
  assert.equal(data.length, 1, 'el servicio sí');
});

test('la Mutual cierra la conversación: la agencia empieza otra y hay una sola abierta', async () => {
  const [c] = (await pedir(emi, { accion: 'chats' })).datos.chats;
  assert.equal((await pedir(emi, { accion: 'chat_cerrar', chat: c.id })).status, 200);
  assert.equal((await pedir(agencia, { accion: 'chat_leer', desde: 0 })).datos.chat, null);
  assert.equal((await pedir(emi, { accion: 'chat_responder', chat: c.id, texto: 'x' })).status, 409);
  await guion([{ texto: 'Hola de nuevo.' }]);
  const r = await pedir(agencia, { accion: 'chat_enviar', texto: 'Hola otra vez' });
  assert.equal(r.datos.chat.estado, 'bot');
  assert.notEqual(r.datos.chat.id, c.id);
  assert.equal(sql(`select count(*) from public.chats_agencia where estado <> 'cerrado'`), '1');
  assert.ok(sqlUnica(`insert into public.chats_agencia (agencia_id, agencia) select agencia_id, agencia from public.chats_agencia limit 1`), 'una segunda abierta no entra');
  // La agencia también puede empezar de cero.
  assert.equal((await pedir(agencia, { accion: 'chat_cerrar' })).status, 200);
  assert.equal((await pedir(agencia, { accion: 'chat_leer', desde: 0 })).datos.chat, null);
});

function sqlUnica(q) { try { sql(q); return false; } catch { return true; } }

test('pedir un representante sin haber escrito nada no se puede; los textos vacíos o larguísimos se acotan', async () => {
  const r = await pedir(otra, { accion: 'chat_representante' });
  assert.equal(r.status, 400);
  assert.equal(r.datos.error, 'sin_consulta');
  assert.equal((await pedir(otra, { accion: 'chat_enviar', texto: '   ' })).status, 400);
  await guion([{ texto: 'Ok.' }]);
  const l = await pedir(otra, { accion: 'chat_enviar', texto: 'x'.repeat(5000) });
  assert.equal(l.datos.mensajes[0].texto.length, 1500);
});

test('el tope diario de mensajes de una agencia', async () => {
  sql(`insert into public.mensajes_agencia (chat_id, de, texto) select c.id, 'agencia', 'relleno' from public.chats_agencia c join public.agencias a on a.id = c.agencia_id
       cross join generate_series(1, 200) where a.email = 'otra@test.local' and c.estado <> 'cerrado'`);
  const r = await pedir(otra, { accion: 'chat_enviar', texto: 'uno más' });
  assert.equal(r.status, 429);
  assert.equal(r.datos.error, 'tope');
  assert.equal((await pedir(agencia, { accion: 'chat_enviar', texto: 'yo sí puedo' })).status, 200, 'el tope es por agencia');
});

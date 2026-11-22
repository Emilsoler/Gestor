// El chat de las agencias, lo que no necesita la base: el asistente (chat.js) y los avisos al celular (push.js).
// No hace falta levantar el stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { MARCA_DERIVAR, RESPUESTA_SEGURA, armarMensajes, datosVigentes, instrucciones, limpiarRespuesta, textoDeAgencia } from '../../supabase/functions/agencias/chat.js';
import { b64u, cifrar, deB64u, enviarPush, firmaVapid, nuevasClaves } from '../../supabase/functions/agencias/push.js';
import { celular, descifrar } from './push-lector.mjs';

// ───────────────────────── Asistente ─────────────────────────
test('las instrucciones llevan la hoja y los datos vigentes, y no el % del valor ni las tasas', () => {
  const a = { ayuda: 'HOJA-DE-PRUEBA', plazos: [12, 24], relacion_max: 45, tope_diario: 300, contacto: '3537-000000', pct_financiable: 40, tasa_mensual: 5, tasas: [{ desde: 2021, tasa: 5 }] };
  const t = instrucciones(a, 'Salón «Uno»');
  assert.match(t, /HOJA-DE-PRUEBA/);
  assert.match(t, /12, 24/);
  assert.match(t, /45 %/);
  assert.match(t, /3537-000000/);
  assert.ok(!/40 ?%|pct_financiable|tasa_mensual|2021/.test(t), 'no se le pasa lo que permitiría deducir el valor del auto');
  assert.ok(t.includes(MARCA_DERIVAR));
  assert.ok(!t.includes('«Uno»'), 'el nombre de la agencia no puede cerrar las comillas de la frase');
});

test('sin hoja cargada se avisa y no se inventa', () => {
  assert.match(instrucciones({ ayuda: '  ' }, ''), /no hay una hoja de respuestas cargada/i);
  assert.equal(datosVigentes({}), '- (sin datos cargados)');
});

test('la conversación alterna user/assistant, arranca con la agencia y se acota', () => {
  const filas = [
    { de: 'bot', texto: 'Hola' }, { de: 'agencia', texto: 'a' }, { de: 'agencia', texto: 'b' }, { de: 'bot', texto: 'c' }, { de: 'mutual', texto: 'd' }, { de: 'agencia', texto: '   ' },
  ];
  assert.deepEqual(armarMensajes(filas), [{ role: 'user', content: 'a\nb' }, { role: 'assistant', content: 'c\nd' }]);
  const muchas = Array.from({ length: 100 }, (_, i) => ({ de: i % 2 ? 'bot' : 'agencia', texto: `m${i}` }));
  assert.ok(armarMensajes(muchas).length <= 20);
  assert.equal(armarMensajes(muchas)[0].role, 'user');
});

test('la respuesta se limpia: marca de derivación, formato y lo que nunca puede decirse', () => {
  assert.deepEqual(limpiarRespuesta(`**Eso** lo ve una persona. ${MARCA_DERIVAR}`), { texto: 'Eso lo ve una persona.', derivar: true });
  assert.deepEqual(limpiarRespuesta('Elegí marca y modelo.'), { texto: 'Elegí marca y modelo.', derivar: false });
  for (const mala of ['Según InfoAuto vale mucho', 'El CODIA es 12345', 'La valuación del vehículo es alta', '']) {
    assert.deepEqual(limpiarRespuesta(mala), { texto: RESPUESTA_SEGURA, derivar: true }, mala);
  }
});

test('el texto de la agencia: sin controles, largo acotado, vacío = null', () => {
  assert.equal(textoDeAgencia('  hola\u0000 \u0007mundo \r\n'), 'hola mundo');
  assert.equal(textoDeAgencia('   '), null);
  assert.equal(textoDeAgencia(null), null);
  assert.equal(textoDeAgencia('x'.repeat(5000)).length, 1500);
});

// ───────────────────────── Avisos al celular ─────────────────────────
test('el aviso cifrado lo puede leer el celular y solo él', async () => {
  const c = await celular();
  const otro = await celular();
  const mensaje = JSON.stringify({ t: 'Salón Uno quiere hablar con vos', c: 'Tengo una duda con una solicitud', u: '/Gestor/cobranzas/#agencias-chats' });
  const cuerpo = await cifrar(mensaje, c.sub);
  assert.equal(await descifrar(cuerpo, c.par, c.auth), mensaje);
  await assert.rejects(descifrar(cuerpo, otro.par, otro.auth), 'otro celular no puede leerlo');
  assert.ok(cuerpo.length <= 4096 + 100);
});

test('el cifrado coincide con el ejemplo del RFC 8291 (apéndice A)', async () => {
  // Valores fijos del RFC: con ellos el resultado tiene que ser exactamente el del apéndice.
  const rfc = {
    plano: 'When I grow up, I want to be a watermelon',
    uaPublica: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    uaPrivada: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    asPublica: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    asPrivada: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    sal: 'DGv6ra1nlYgDCS1FRnbzlw',
    esperado: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };
  const jwk = (pub, priv) => { const p = deB64u(pub); return { kty: 'EC', crv: 'P-256', x: b64u(p.slice(1, 33)), y: b64u(p.slice(33)), d: priv, ext: true }; };
  const efimera = {
    privateKey: await crypto.subtle.importKey('jwk', jwk(rfc.asPublica, rfc.asPrivada), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('jwk', (({ d, ...x }) => x)(jwk(rfc.asPublica, rfc.asPrivada)), { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  };
  // El RFC no agrega relleno al mensaje de ejemplo más allá del delimitador: coincide con nuestro formato (texto + 0x02).
  const cuerpo = await cifrar(rfc.plano, { p256dh: rfc.uaPublica, auth: rfc.auth }, { sal: deB64u(rfc.sal), efimera });
  assert.equal(b64u(cuerpo), rfc.esperado);
});

test('la firma VAPID es un JWT ES256 válido para el origen del celular', async () => {
  const claves = await nuevasClaves();
  assert.equal(deB64u(claves.publica).length, 65);
  const ahora = Date.UTC(2026, 10, 22, 12);
  const jwt = await firmaVapid('https://web.push.apple.com/abc/def', claves, 'mailto:a@b.com', ahora);
  const [h, c, f] = jwt.split('.');
  assert.deepEqual(JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/'))), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/')));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:a@b.com');
  assert.equal(claims.exp, Math.floor(ahora / 1000) + 12 * 3600);
  const pub = await crypto.subtle.importKey('raw', deB64u(claves.publica), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, deB64u(f), new TextEncoder().encode(`${h}.${c}`)));
});

test('enviarPush: encabezados, estado y celulares vencidos', async () => {
  const claves = await nuevasClaves();
  const c = await celular();
  const pedidos = [];
  const falso = (status) => async (url, init) => { pedidos.push({ url, init }); return { status }; };
  const ok = await enviarPush(c.sub, { t: 'x' }, claves, { sujeto: 'mailto:a@b.com', enviar: falso(201) });
  assert.deepEqual(ok, { ok: true, status: 201, vencida: false });
  const h = pedidos[0].init.headers;
  assert.equal(pedidos[0].url, c.sub.endpoint);
  assert.equal(h['content-encoding'], 'aes128gcm');
  assert.match(h.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${claves.publica}$`));
  assert.equal(await descifrar(pedidos[0].init.body, c.par, c.auth), JSON.stringify({ t: 'x' }));
  assert.deepEqual(await enviarPush(c.sub, {}, claves, { enviar: falso(410) }), { ok: false, status: 410, vencida: true });
  assert.deepEqual(await enviarPush(c.sub, {}, claves, { enviar: falso(404) }), { ok: false, status: 404, vencida: true });
  assert.deepEqual(await enviarPush(c.sub, {}, claves, { enviar: falso(500) }), { ok: false, status: 500, vencida: false });
  assert.deepEqual(await enviarPush(c.sub, {}, claves, { enviar: async () => { throw new Error('red'); } }), { ok: false, status: 0, vencida: false });
});

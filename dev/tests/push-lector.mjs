// El celular de mentira de las pruebas de avisos: genera sus claves como las genera el navegador y lee los avisos
// cifrados (RFC 8291, sección 3.4), para comprobar que lo que manda la función lo puede abrir solo ese celular.
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { b64u } from '../../supabase/functions/agencias/push.js';

/** El otro lado: lo que hace el navegador del celular con el aviso (RFC 8291, sección 3.4). */
export async function descifrar(cuerpo, uaPar, secretoAuth) {
  const salt = cuerpo.slice(0, 16), idlen = cuerpo[20], asPublica = cuerpo.slice(21, 21 + idlen), datos = cuerpo.slice(21 + idlen);
  const uaPublica = new Uint8Array(await crypto.subtle.exportKey('raw', uaPar.publicKey));
  const asClave = await crypto.subtle.importKey('raw', asPublica, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const compartido = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asClave }, uaPar.privateKey, 256));
  const hk = async (ikm, sal, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: sal, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const enc = new TextEncoder();
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublica, ...asPublica]);
  const ikm = await hk(compartido, secretoAuth, info, 32);
  const cek = await hk(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const claro = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), datos));
  assert.equal(claro[claro.length - 1], 2, 'termina con el delimitador del último registro');
  return new TextDecoder().decode(claro.slice(0, -1));
}

export async function celular() {
  const par = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { par, auth, sub: { endpoint: 'https://web.push.apple.com/QWxhZGRpbjpvcGVuIHNlc2FtZQ', p256dh: b64u(await crypto.subtle.exportKey('raw', par.publicKey)), auth: b64u(auth) } };
}


// Avisos al celular (Web Push, RFC 8030 + cifrado aes128gcm RFC 8291 + firma VAPID RFC 8292), sin librerías: solo
// WebCrypto, que está en Deno (la función) y en Node (las pruebas). Es el aviso «una agencia quiere hablar con
// vos» que le llega al iPhone con la app de Créditos y Cobros instalada en la pantalla de inicio.
//
// El par de claves VAPID lo crea la función la primera vez (`nuevasClaves`) y queda en public.push_claves; la
// clave pública es la que usa la app para registrar el celular (`applicationServerKey`).

const enc = new TextEncoder();

export const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const deB64u = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(s).length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const juntar = (...xs) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };

/** Un par de claves VAPID nuevo: { publica (base64url, 65 bytes sin comprimir), privada (JWK) }. */
export async function nuevasClaves() {
  const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publica = b64u(await crypto.subtle.exportKey('raw', par.publicKey));
  const privada = await crypto.subtle.exportKey('jwk', par.privateKey);
  return { publica, privada };
}

/** El JWT de VAPID para el servidor de avisos de ese celular (audiencia = su origen). */
export async function firmaVapid(endpoint, claves, sujeto, ahora = Date.now()) {
  const clave = await crypto.subtle.importKey('jwk', claves.privada, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const cabeza = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const cuerpo = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(ahora / 1000) + 12 * 3600, sub: sujeto })));
  const firma = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, clave, enc.encode(`${cabeza}.${cuerpo}`)); // r||s, como pide JWS
  return `${cabeza}.${cuerpo}.${b64u(firma)}`;
}

const hkdf = async (ikm, salt, info, bytes) => {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
};

/** Cifra el mensaje para ese celular (RFC 8291). `sub` = { p256dh, auth } en base64url. */
export async function cifrar(mensaje, sub, { sal, efimera } = {}) {
  const uaPublica = deB64u(sub.p256dh), secretoAuth = deB64u(sub.auth);
  const par = efimera || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublica = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey));
  const uaClave = await crypto.subtle.importKey('raw', uaPublica, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const compartido = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaClave }, par.privateKey, 256));
  const ikm = await hkdf(compartido, secretoAuth, juntar(enc.encode('WebPush: info\0'), uaPublica, asPublica), 32);
  const salt = sal || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const texto = juntar(typeof mensaje === 'string' ? enc.encode(mensaje) : mensaje, Uint8Array.of(2)); // 2 = último registro
  if (texto.length > 4096 - 17) throw new Error('El aviso es demasiado largo.');
  const clavAes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, clavAes, texto));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return juntar(salt, rs, Uint8Array.of(asPublica.length), asPublica, cifrado);
}

/**
 * Manda un aviso. Devuelve { ok, status, vencida }: `vencida` = el celular ya no recibe avisos (se borra de la base).
 * `enviar` es fetch (se cambia en las pruebas).
 */
export async function enviarPush(sub, datos, claves, { sujeto = 'mailto:avisos@example.com', enviar = fetch, ttl = 3600 } = {}) {
  const cuerpo = await cifrar(JSON.stringify(datos), sub);
  const jwt = await firmaVapid(sub.endpoint, claves, sujeto);
  let r;
  try {
    r = await enviar(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: `vapid t=${jwt}, k=${claves.publica}`, 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
        ttl: String(ttl), urgency: 'high',
      },
      body: cuerpo,
      signal: AbortSignal.timeout(10_000),
    });
  } catch { return { ok: false, status: 0, vencida: false }; }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, vencida: r.status === 404 || r.status === 410 };
}

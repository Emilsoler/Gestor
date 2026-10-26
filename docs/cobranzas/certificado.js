// Certificado para los web services de ARCA, armado en el navegador.
//
// ARCA le da un certificado a la app si le presentan una solicitud (.csr) firmada con una clave privada.
// Las dos cosas se crean acá, con la criptografía del propio navegador (WebCrypto): la clave nace en la
// compu de la persona, se descarga y no se guarda ni se manda a ningún lado; ARCA recibe solo la
// solicitud, que no es secreta. La clave se carga después, una sola vez, como secreto de la función en
// el panel de Supabase.
//
// La solicitud es un PKCS#10 (RFC 2986) con el sujeto que pide ARCA:
//   C=AR, O=<nombre o razón social>, CN=<alias>, serialNumber=CUIT <cuit>
// firmado con SHA-256 y una clave RSA de 2048 bits. Es lo mismo que arma
//   openssl req -new -key clave.key -subj "/C=AR/O=…/CN=…/serialNumber=CUIT …"
// con los mismos tipos de texto: país y serialNumber como PrintableString, el resto como UTF8String.
import { cuitValido, soloDigitos } from './creditos.js';

export const ALIAS_ARCA = 'CobranzasSoler';

/** El alias (CN) va solo con letras y números: así lo pide ARCA. */
export const aliasValido = (s) => /^[A-Za-z0-9]{1,50}$/.test(String(s ?? ''));
/** El nombre del sujeto: hasta 64 caracteres (el máximo de X.520 para una organización). */
export const nombreValido = (s) => { const t = String(s ?? '').trim(); return t.length > 0 && t.length <= 64; };

// ───────────────────────── DER, lo mínimo ─────────────────────────

function largo(n) {
  if (n < 0x80) return [n];
  const b = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v & 0xff);
  return [0x80 | b.length, ...b];
}
function unir(...partes) {
  const out = new Uint8Array(partes.reduce((a, p) => a + p.length, 0));
  let i = 0;
  for (const p of partes) { out.set(p, i); i += p.length; }
  return out;
}
const tlv = (tag, contenido) => { const c = Uint8Array.from(contenido); return unir(Uint8Array.of(tag, ...largo(c.length)), c); };
const secuencia = (...xs) => tlv(0x30, unir(...xs));
const conjunto = (...xs) => tlv(0x31, unir(...xs));
function oid(texto) {
  const [a, b, ...resto] = texto.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const n of resto) {
    const grupo = [];
    for (let v = n; ; v = Math.floor(v / 128)) { grupo.unshift(v & 0x7f); if (v < 128) break; }
    for (let i = 0; i < grupo.length - 1; i++) grupo[i] |= 0x80;
    bytes.push(...grupo);
  }
  return tlv(0x06, bytes);
}
const utf8 = (s) => tlv(0x0c, new TextEncoder().encode(s));
const imprimible = (s) => tlv(0x13, new TextEncoder().encode(s));
const rdn = (tipo, valor) => conjunto(secuencia(oid(tipo), valor));

const OID = { pais: '2.5.4.6', organizacion: '2.5.4.10', nombreComun: '2.5.4.3', numeroDeSerie: '2.5.4.5', sha256ConRsa: '1.2.840.113549.1.1.11' };

/** El texto PEM: base64 en renglones de 64, entre los rótulos. */
export function pem(rotulo, bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/.{64}/g, '$&\n').replace(/\n$/, '');
  return `-----BEGIN ${rotulo}-----\n${b64}\n-----END ${rotulo}-----\n`;
}

/**
 * Arma la clave privada y la solicitud de certificado. Devuelve los dos textos PEM: `csr` (para subir a
 * ARCA) y `clave` (PKCS#8, secreta). Lanza un error en palabras si un dato no sirve.
 */
export async function armarSolicitud({ cuit, nombre, alias = ALIAS_ARCA }) {
  const c = soloDigitos(cuit);
  if (!cuitValido(c)) throw new Error('Ese CUIT no existe: revisá los números.');
  if (!nombreValido(nombre)) throw new Error('Escribí el nombre o la razón social (hasta 64 letras).');
  if (!aliasValido(alias)) throw new Error('El alias va solo con letras y números, sin espacios.');
  if (!globalThis.crypto?.subtle) throw new Error('Este navegador no puede crear la clave. Probá con Chrome o Edge actualizados.');

  const par = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const publica = new Uint8Array(await crypto.subtle.exportKey('spki', par.publicKey));
  const sujeto = secuencia(
    rdn(OID.pais, imprimible('AR')),
    rdn(OID.organizacion, utf8(String(nombre).trim())),
    rdn(OID.nombreComun, utf8(alias)),
    rdn(OID.numeroDeSerie, imprimible(`CUIT ${c}`)),
  );
  // versión 0, sujeto, clave pública y atributos vacíos ([0])
  const info = secuencia(Uint8Array.of(0x02, 0x01, 0x00), sujeto, publica, Uint8Array.of(0xa0, 0x00));
  const firma = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', par.privateKey, info));
  const solicitud = secuencia(info, secuencia(oid(OID.sha256ConRsa), Uint8Array.of(0x05, 0x00)), tlv(0x03, unir(Uint8Array.of(0), firma)));
  const privada = new Uint8Array(await crypto.subtle.exportKey('pkcs8', par.privateKey));
  return { csr: pem('CERTIFICATE REQUEST', solicitud), clave: pem('PRIVATE KEY', privada) };
}

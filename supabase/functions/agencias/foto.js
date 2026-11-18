// Foto del vehículo cotizado (pedido de la persona, nov 2026: «como la de Ver ficha de InfoAuto»).
//
// La función la pide a InfoAuto (/models/{codia}/photos/) en el momento y la devuelve ya convertida en imagen
// (data:image/...;base64): la agencia no ve la dirección de la foto (podría llevar el CODIA) ni el nombre de InfoAuto,
// y no se guarda nada (no se copia el catálogo). Si algo falla, no hay foto y el cotizador sigue igual.
//
// OJO licencia: usar las fotos quedó a confirmar con InfoAuto (la persona lo decidió igual, nov 2026). Si dicen que
// no, poner el secreto AGENCIAS_FOTOS=no en Supabase y la función deja de pedirlas, sin tocar nada más.

export const MAX_FOTO = 2_000_000; // bytes
const CLAVES = ['url', 'image', 'photo', 'picture', 'src', 'path', 'link', 'large', 'big', 'medium', 'original', 'small', 'thumb',
  'photos', 'images', 'pictures', 'results', 'data', 'items'];

/** La primera dirección de foto en la respuesta. El formato no está documentado: se acepta una lista o un objeto, con
 *  la dirección en `url`, `image`, `photo`, `src`, etc., o una cadena suelta. Las relativas se resuelven contra `base`. */
export function urlDeFoto(x, base) {
  const cands = [];
  const ver = (v, prof) => {
    if (v == null || prof > 4) return;
    if (typeof v === 'string') { cands.push(v.trim()); return; }
    if (Array.isArray(v)) { for (const y of v) ver(y, prof + 1); return; }
    if (typeof v === 'object') for (const k of CLAVES) if (Object.hasOwn(v, k)) ver(v[k], prof + 1);
  };
  ver(x, 0);
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(base || '') + '/');
  for (const c of cands) {
    if (!c || !(/^https?:\/\//i.test(c) || /\.(jpe?g|png|webp)(\?|$)/i.test(c))) continue;
    let u;
    try { u = new URL(c, base); } catch { continue; }
    if (u.protocol === 'https:' || (local && u.protocol === 'http:')) return u.toString();
  }
  return null;
}

/** Qué imagen es, por los primeros bytes (no por lo que diga el servidor). */
export function tipoImagen(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export function base64(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

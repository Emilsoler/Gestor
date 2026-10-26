// El oficio en una forma que se copia sin errores de un lado a otro. La tarea del SAC lo lee de la
// base con el conector de Supabase y lo tiene que escribir en un archivo: como el resultado le llega
// dentro de capas de JSON, un texto con comillas, barras o saltos de línea vendría escapado dos y
// tres veces. Por eso la base lo entrega en renglones de solo ASCII sin comillas ni barras (ninguna
// capa los cambia), cortos y con un control cada uno: si uno se copia mal, se sabe cuál y se vuelve
// a copiar ese solo.
//
// Es el espejo de gestor.texto_seguro y gestor.agenda_adjuntos (migración 0013): las pruebas
// comparan lo que da la base con lo que da este archivo.
//
//   ~n      salto de línea
//   ~sNN    NN espacios seguidos (de 02 a 99); ~s01, un espacio al principio o al final del texto
//   ~XXXX   la letra U+XXXX (acentos, comillas tipográficas, º, ~, <, >, comillas, barra…); lo que
//           está más allá de U+FFFF va en dos (par sustituto, como en UTF-16)
// Quedan tal cual las letras sin acento, los números, el espacio suelto y  . , ; : ( ) / - _ ? ! + * = % # @ $ [ ] { } | ' ^
//
// Renglones de un adjunto, en orden:
//   oficio <control del oficio: 16 hex> <cantidad de partes> <nombre del PDF>
//   <k> <control de la parte: 8 hex> <parte k del texto codificado>      (k = 1, 2, …)
// El control es el comienzo del sha256 (del oficio, o del texto de la parte tal como está en el
// renglón). Ninguna parte empieza ni termina con un espacio: el corte nunca cae al lado de uno.
import { createHash } from 'node:crypto';

const SUELTAS = /^[\]A-Za-z0-9 .,;:()/_?!+*=%#@$|'^{}[-]$/;
const LARGO_PARTE = 240;
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function codificar(doc) {
  const cs = [...String(doc)], n = cs.length;
  let r = '';
  for (let i = 0; i < n;) {
    const ch = cs[i];
    if (ch === ' ' && cs[i + 1] === ' ') {
      let k = 1;
      while (i + k < n && cs[i + k] === ' ' && k < 99) k++;
      r += '~s' + String(k).padStart(2, '0');
      i += k;
      continue;
    }
    if (ch === ' ' && (i === 0 || i === n - 1)) r += '~s01';
    else if (ch === '\n') r += '~n';
    else if (SUELTAS.test(ch)) r += ch;
    else {
      const u = ch.codePointAt(0);
      if (u < 0x10000) r += '~' + u.toString(16).padStart(4, '0');
      else { const v = u - 0x10000; r += '~' + (0xd800 + (v >> 10)).toString(16) + '~' + (0xdc00 + (v & 0x3ff)).toString(16); }
    }
    i++;
  }
  return r;
}

export function decodificar(e) {
  let r = '';
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (c !== '~') { r += c; continue; }
    const t = e[i + 1];
    if (t === 'n') { r += '\n'; i += 1; continue; }
    if (t === 's') {
      const n = e.slice(i + 2, i + 4);
      if (!/^\d\d$/.test(n)) throw new Error(`marca de espacios inválida en la posición ${i + 1}`);
      r += ' '.repeat(+n); i += 3; continue;
    }
    const h = e.slice(i + 1, i + 5);
    if (!/^[0-9a-f]{4}$/.test(h)) throw new Error(`marca de letra inválida en la posición ${i + 1}`);
    r += String.fromCharCode(parseInt(h, 16)); i += 4;
  }
  return r;
}

/** Corta el texto codificado en partes de hasta 240 letras, sin cortar al lado de un espacio. */
export function partir(e) {
  const r = [];
  for (let pos = 0; pos < e.length;) {
    let fin = Math.min(pos + LARGO_PARTE, e.length);
    while (fin < e.length && fin - 1 > pos && (e[fin - 1] === ' ' || e[fin] === ' ')) fin--;
    r.push(e.slice(pos, fin));
    pos = fin;
  }
  return r;
}

/** Los renglones de un adjunto, como los devuelve gestor.agenda_adjuntos. */
export function renglones(doc, nombre) {
  const partes = partir(codificar(doc));
  return [`oficio ${sha(doc).slice(0, 16)} ${partes.length} ${nombre}`, ...partes.map((p, k) => `${k + 1} ${sha(p).slice(0, 8)} ${p}`)];
}

/**
 * Lee los renglones copiados y devuelve { doc, nombre }, o lanza un error que dice qué renglones
 * volver a copiar (`renglonesMal`: los números de parte; 0 es el renglón "oficio").
 */
export function leerRenglones(texto) {
  const ls = String(texto).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const falla = (mensaje, renglonesMal = []) => { throw Object.assign(new Error(mensaje), { renglonesMal }); };
  const cab = /^oficio ([0-9a-f]{16}) (\d+) (.+)$/.exec(ls[0] || '');
  if (!cab) falla('El primer renglón tiene que ser el que empieza con "oficio" (control, cantidad de partes y nombre del PDF), copiado tal cual.', [0]);
  const [, control, cuantas, nombre] = cab, total = +cuantas;
  if (!/^[A-Za-z0-9 ._-]{1,150}\.pdf$/.test(nombre)) falla(`El nombre del PDF del renglón "oficio" no es válido: "${nombre}".`, [0]);
  const partes = new Map(), mal = new Set(), raros = [];
  for (const l of ls.slice(1)) {
    const m = /^(\d+) ([0-9a-f]{8}) (.+)$/.exec(l);
    if (!m) { raros.push(l.slice(0, 40)); continue; }
    const k = +m[1];
    if (k < 1 || k > total) { raros.push(l.slice(0, 40)); continue; }
    if (partes.has(k)) { mal.add(k); continue; } // repetida: no se sabe cuál es la buena
    if (sha(m[3]).slice(0, 8) !== m[2]) mal.add(k);
    partes.set(k, m[3]);
  }
  if (raros.length) falla(`Hay renglones que no tienen la forma "número control texto" (o con un número de parte que no existe): ${raros.map((r) => `"${r}…"`).join(', ')}.`);
  const faltan = [];
  for (let k = 1; k <= total; k++) if (!partes.has(k)) faltan.push(k);
  if (faltan.length) falla(`Faltan las partes ${faltan.join(', ')} de ${total}: copialas tal cual.`, faltan);
  if (mal.size) { const ks = [...mal].sort((a, b) => a - b); falla(`No coinciden las partes ${ks.join(', ')}: volvé a copiar esos renglones tal cual, sin cambiar nada.`, ks); }
  let doc;
  try { doc = decodificar([...partes.keys()].sort((a, b) => a - b).map((k) => partes.get(k)).join('')); } catch (e) { falla(`El texto no se pudo leer (${e.message}).`); }
  if (sha(doc).slice(0, 16) !== control) falla('Todas las partes coinciden pero el oficio entero no: volvé a copiar el renglón "oficio" tal cual.', [0]);
  return { doc, nombre };
}

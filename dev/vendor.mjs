// Copia a docs/ lo que la app usa de terceros, para que no dependa de ningún CDN:
// la librería de Supabase y las tipografías. Correr después de `npm install`
// cuando se actualice alguna versión:  node vendor.mjs
import { copyFileSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

/**
 * WOFF (1.0) → TrueType. Los PDF de los oficios llevan la tipografía adentro y un PDF solo
 * acepta el archivo TrueType tal cual: se rearma a partir de las tablas comprimidas del WOFF.
 */
function woffATtf(woff) {
  if (woff.toString('latin1', 0, 4) !== 'wOFF') throw new Error('no es un WOFF 1.0');
  const flavor = woff.readUInt32BE(4), n = woff.readUInt16BE(12);
  const tablas = [];
  for (let i = 0; i < n; i++) {
    const p = 44 + i * 20, off = woff.readUInt32BE(p + 4), comp = woff.readUInt32BE(p + 8), orig = woff.readUInt32BE(p + 12);
    const crudo = woff.subarray(off, off + comp);
    tablas.push({ tag: woff.subarray(p, p + 4), suma: woff.readUInt32BE(p + 16), datos: comp < orig ? inflateSync(crudo) : crudo });
  }
  let pot = 1, exp = 0; while (pot * 2 <= n) { pot *= 2; exp++; }
  const cab = Buffer.alloc(12 + n * 16);
  cab.writeUInt32BE(flavor, 0); cab.writeUInt16BE(n, 4); cab.writeUInt16BE(pot * 16, 6); cab.writeUInt16BE(exp, 8); cab.writeUInt16BE(n * 16 - pot * 16, 10);
  const partes = [cab];
  let pos = cab.length;
  tablas.forEach((t, i) => {
    const r = 12 + i * 16;
    t.tag.copy(cab, r); cab.writeUInt32BE(t.suma, r + 4); cab.writeUInt32BE(pos, r + 8); cab.writeUInt32BE(t.datos.length, r + 12);
    const relleno = (4 - (t.datos.length % 4)) % 4;
    partes.push(t.datos, Buffer.alloc(relleno));
    pos += t.datos.length + relleno;
  });
  return Buffer.concat(partes);
}

// Tipografías de los oficios (docs/oficio.js): EB Garamond para el cuerpo, como los oficios del
// estudio en Garamond, y Caladea (de las mismas medidas que Cambria) para el encabezado.
const oficio = [
  ['@fontsource/eb-garamond/files/eb-garamond-latin-400-normal.woff', 'fonts/eb-garamond-400.ttf'],
  ['@fontsource/eb-garamond/files/eb-garamond-latin-700-normal.woff', 'fonts/eb-garamond-700.ttf'],
  ['@fontsource/caladea/files/caladea-latin-400-normal.woff', 'fonts/caladea-400.ttf'],
];

const aqui = dirname(fileURLToPath(import.meta.url));
const nm = join(aqui, 'node_modules');
const docs = join(aqui, '..', 'docs');

const copias = [
  ['@supabase/supabase-js/dist/umd/supabase.js', 'vendor/supabase.js'],
  // 300: las cifras grandes del resumen; 400 a 600: todo lo demás
  ...['300', '400', '500', '600'].flatMap((w) => ['latin', 'latin-ext'].map((s) => [
    `@fontsource/ibm-plex-sans/files/ibm-plex-sans-${s}-${w}-normal.woff2`, `fonts/plex-sans-${s}-${w}.woff2`])),
  ...['400', '500'].flatMap((w) => ['latin', 'latin-ext'].map((s) => [
    `@fontsource/ibm-plex-mono/files/ibm-plex-mono-${s}-${w}-normal.woff2`, `fonts/plex-mono-${s}-${w}.woff2`])),
  // Licencias de lo que se redistribuye (las tipografías son OFL 1.1; supabase-js es MIT)
  ['@fontsource/ibm-plex-sans/LICENSE', 'fonts/LICENCIA-IBM-Plex-Sans.txt'],
  ['@fontsource/ibm-plex-mono/LICENSE', 'fonts/LICENCIA-IBM-Plex-Mono.txt'],
  ['@fontsource/eb-garamond/LICENSE', 'fonts/LICENCIA-EB-Garamond.txt'],
  ['@fontsource/caladea/LICENSE', 'fonts/LICENCIA-Caladea.txt'],
  ['@supabase/supabase-js/LICENSE', 'vendor/LICENCIA-supabase-js.txt'],
];

let total = 0;
for (const [de, a] of copias) {
  const destino = join(docs, a);
  mkdirSync(dirname(destino), { recursive: true });
  copyFileSync(join(nm, de), destino);
  total += statSync(destino).size;
  console.log(String(statSync(destino).size).padStart(8), a);
}
for (const [de, a] of oficio) {
  const destino = join(docs, a);
  writeFileSync(destino, woffATtf(readFileSync(join(nm, de))));
  total += statSync(destino).size;
  console.log(String(statSync(destino).size).padStart(8), a);
}
const v = JSON.parse(readFileSync(join(nm, '@supabase/supabase-js/package.json'), 'utf8')).version;
writeFileSync(join(docs, 'vendor/VERSIONES.txt'), `@supabase/supabase-js ${v} (dist/umd/supabase.js)\n`);
console.log(String(total).padStart(8), 'bytes en total · supabase-js', v);

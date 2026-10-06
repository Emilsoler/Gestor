// Copia a docs/ lo que la app usa de terceros, para que no dependa de ningún CDN:
// la librería de Supabase y las tipografías. Correr después de `npm install`
// cuando se actualice alguna versión:  node vendor.mjs
import { copyFileSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const nm = join(aqui, 'node_modules');
const docs = join(aqui, '..', 'docs');

const copias = [
  ['@supabase/supabase-js/dist/umd/supabase.js', 'vendor/supabase.js'],
  ...['400', '500', '600'].flatMap((w) => ['latin', 'latin-ext'].map((s) => [
    `@fontsource/ibm-plex-sans/files/ibm-plex-sans-${s}-${w}-normal.woff2`, `fonts/plex-sans-${s}-${w}.woff2`])),
  ...['400', '500'].flatMap((w) => ['latin', 'latin-ext'].map((s) => [
    `@fontsource/ibm-plex-mono/files/ibm-plex-mono-${s}-${w}-normal.woff2`, `fonts/plex-mono-${s}-${w}.woff2`])),
  ...['latin', 'latin-ext'].map((s) => [
    `@fontsource-variable/source-serif-4/files/source-serif-4-${s}-opsz-normal.woff2`, `fonts/source-serif-4-${s}.woff2`]),
  // Licencias de lo que se redistribuye (las tipografías son OFL 1.1; supabase-js es MIT)
  ['@fontsource/ibm-plex-sans/LICENSE', 'fonts/LICENCIA-IBM-Plex-Sans.txt'],
  ['@fontsource/ibm-plex-mono/LICENSE', 'fonts/LICENCIA-IBM-Plex-Mono.txt'],
  ['@fontsource-variable/source-serif-4/LICENSE', 'fonts/LICENCIA-Source-Serif-4.txt'],
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
const v = JSON.parse(readFileSync(join(nm, '@supabase/supabase-js/package.json'), 'utf8')).version;
writeFileSync(join(docs, 'vendor/VERSIONES.txt'), `@supabase/supabase-js ${v} (dist/umd/supabase.js)\n`);
console.log(String(total).padStart(8), 'bytes en total · supabase-js', v);

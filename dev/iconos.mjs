// Genera los íconos de la app a partir de un dibujo vectorial:  node iconos.mjs
// Marca: una "J" de trazo recto con su punto en ámbar (el color de los vencimientos).
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'icons');
const VERDE = '#1f5f5b', AMBAR = '#e5b25a';

// La marca, pensada en una grilla de 512. `escala` la achica alrededor del centro.
const marca = (escala = 1) => `
  <g transform="translate(256 256) scale(${escala}) translate(-256 -256)">
    <path d="M196 138H346" stroke="#fff" stroke-width="44" fill="none"/>
    <path d="M290 138V306a68 68 0 0 1-136 0V286" stroke="#fff" stroke-width="44" fill="none"/>
    <rect x="336" y="324" width="52" height="52" fill="${AMBAR}"/>
  </g>`;

const svg = (fondo, escala) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${fondo}${marca(escala)}</svg>`;

const redondeado = `<rect width="512" height="512" rx="112" fill="${VERDE}"/>`;
const pleno = `<rect width="512" height="512" fill="${VERDE}"/>`;

writeFileSync(join(out, 'icon.svg'), svg(redondeado, 1).replace(/\n\s*/g, ''));
const png = (s, tam, archivo) => sharp(Buffer.from(s), { density: 300 }).resize(tam, tam).png().toFile(join(out, archivo));
await png(svg(redondeado, 1), 192, 'icon-192.png');
await png(svg(redondeado, 1), 512, 'icon-512.png');
await png(svg(pleno, 0.74), 512, 'icon-maskable-512.png'); // todo dentro de la zona segura (80 % central)
await png(svg(pleno, 0.9), 180, 'apple-touch-icon.png');   // iOS redondea solo
console.log('íconos generados en', out);

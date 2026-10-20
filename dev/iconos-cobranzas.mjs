// Genera los íconos de la app de cobranzas a partir de un dibujo vectorial:  node iconos-cobranzas.mjs
// Marca: una "C" de trazo con su punto en verde lima (el color de lo pagado), sobre el degradado
// verde petróleo → esmeralda de la app. Es la hermana de la "J" del gestor (iconos.mjs).
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'cobranzas', 'icons');
const PETROLEO = '#0b6e74', ESMERALDA = '#10804a', LIMA = '#a6e07e';
const degradado = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${PETROLEO}"/><stop offset="1" stop-color="${ESMERALDA}"/></linearGradient></defs>`;

// La marca, pensada en una grilla de 512. `escala` la achica alrededor del centro.
const marca = (escala = 1) => `
  <g transform="translate(256 256) scale(${escala}) translate(-256 -256)">
    <path d="M318 168A106 106 0 1 0 318 344" stroke="#fff" stroke-width="44" fill="none"/>
    <rect x="338" y="322" width="52" height="52" fill="${LIMA}"/>
  </g>`;

const svg = (fondo, escala) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${fondo}${marca(escala)}</svg>`;

const redondeado = `${degradado}<rect width="512" height="512" rx="112" fill="url(#g)"/>`;
const pleno = `${degradado}<rect width="512" height="512" fill="url(#g)"/>`;

writeFileSync(join(out, 'icon.svg'), svg(redondeado, 1).replace(/\n\s*/g, ''));
const png = (s, tam, archivo) => sharp(Buffer.from(s), { density: 300 }).resize(tam, tam).png().toFile(join(out, archivo));
await png(svg(redondeado, 1), 192, 'icon-192.png');
await png(svg(redondeado, 1), 512, 'icon-512.png');
await png(svg(pleno, 0.74), 512, 'icon-maskable-512.png'); // todo dentro de la zona segura (80 % central)
await png(svg(pleno, 0.9), 180, 'apple-touch-icon.png');   // iOS redondea solo
console.log('íconos generados en', out);

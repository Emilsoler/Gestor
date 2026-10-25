// Genera los íconos de la app Prenda a partir de un dibujo vectorial:  node iconos-prenda.mjs
// Marca: un pin de ubicación blanco sobre el degradado cian (azul → cian "de rastreo") de la app.
// Es la hermana de la "J" del gestor (iconos.mjs) y la "C" de cobranzas (iconos-cobranzas.mjs).
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'prenda', 'icons');
const AZUL = '#0e6f9e', CIAN = '#19a6bf', FONDO = '#0b1823';
const degradado = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${AZUL}"/><stop offset="1" stop-color="${CIAN}"/></linearGradient></defs>`;

// Pin de ubicación en una grilla de 512. `escala` lo achica alrededor del centro.
const marca = (escala = 1) => `
  <g transform="translate(256 262) scale(${escala}) translate(-256 -262)">
    <path d="M256 112c-57 0-103 45-103 101 0 70 103 185 103 185s103-115 103-185c0-56-46-101-103-101z" fill="#fff"/>
    <circle cx="256" cy="212" r="40" fill="${FONDO}"/>
  </g>`;

const svg = (fondo, escala) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${fondo}${marca(escala)}</svg>`;

const redondeado = `${degradado}<rect width="512" height="512" rx="112" fill="url(#g)"/>`;
const pleno = `${degradado}<rect width="512" height="512" fill="url(#g)"/>`;

writeFileSync(join(out, 'icon.svg'), svg(redondeado, 1).replace(/\n\s*/g, ''));
const png = (s, tam, archivo) => sharp(Buffer.from(s), { density: 300 }).resize(tam, tam).png().toFile(join(out, archivo));
await png(svg(redondeado, 1), 192, 'icon-192.png');
await png(svg(redondeado, 1), 512, 'icon-512.png');
await png(svg(pleno, 0.72), 512, 'icon-maskable-512.png'); // todo dentro de la zona segura (80 % central)
await png(svg(pleno, 0.86), 180, 'apple-touch-icon.png');   // iOS redondea solo
console.log('íconos generados en', out);

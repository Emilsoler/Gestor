// Arma el PDF de un oficio adjunto a un escrito de la agenda, igual al que muestra la app. Lo usa
// la tarea que presenta en el SAC, que no llega a la base desde la línea de comandos:
//
//   1. select n, nombre, linea from gestor.agenda_adjuntos('<id del escrito>');
//   2. guardar en un archivo la columna `linea` de las filas de un mismo adjunto (n), en orden y
//      tal cual: son de una sola línea, de solo ASCII y sin comillas (ver dev/texto-seguro.mjs)
//   3. node dev/oficio-pdf.mjs <archivo.txt> <carpeta o archivo .pdf>
//
// Antes de armar nada controla cada renglón contra su control y el oficio entero contra el suyo.
// Si algo no coincide, sale con código 2, dice qué renglones volver a copiar y no escribe el PDF.
// Sin dependencias: solo Node 18 o más nuevo.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfOficio, analizar } from '../docs/oficio.js';
import { leerRenglones } from './texto-seguro.mjs';

const [entrada, destino] = process.argv.slice(2);
if (!entrada || !destino) {
  console.error('uso: node dev/oficio-pdf.mjs <renglones.txt> <carpeta de salida o archivo .pdf>');
  process.exit(1);
}

let leido;
try { leido = leerRenglones(readFileSync(entrada, 'utf8')); } catch (e) {
  console.error(e.message);
  process.exit(2);
}
const { doc, nombre } = leido;

let salida = destino;
if (!/\.pdf$/i.test(destino)) {
  let carpeta = false;
  try { carpeta = statSync(destino).isDirectory(); } catch { /* no existe: se crea */ }
  if (!carpeta) mkdirSync(destino, { recursive: true });
  salida = join(destino, nombre);
}
const fuentes = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'fonts');
const pdf = pdfOficio(doc, {
  cuerpo: readFileSync(join(fuentes, 'eb-garamond-400.ttf')),
  negrita: readFileSync(join(fuentes, 'eb-garamond-700.ttf')),
  encabezado: readFileSync(join(fuentes, 'caladea-400.ttf')),
}, { titulo: nombre.replace(/\.pdf$/i, '') });
mkdirSync(dirname(salida), { recursive: true });
writeFileSync(salida, pdf);
console.log(`ok · ${salida} · ${pdf.length} bytes · ${analizar(doc).parrafos.length} párrafos · sha256 del PDF ${createHash('sha256').update(pdf).digest('hex')}`);

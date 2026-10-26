// Los oficios de las acciones cautelares (docs/oficio.js) y el armado del PDF para la tarea del SAC
// (dev/oficio-pdf.mjs). No necesita el stack: es todo local. Usa pdftotext (poppler) para leer los PDF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODELOS, ACCIONES, rellenar, analizar, htmlOficio, pdfOficio, enLetras, cifra, dniOficio, partirDomicilio, partirVehiculo,
  datosDeCausa, nombreArchivo, esModeloOficio, leerTtf,
} from '../../docs/oficio.js';
import { codificar, decodificar, partir, renglones, leerRenglones } from '../texto-seguro.mjs';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fuentes = {
  cuerpo: readFileSync(join(raiz, 'docs/fonts/eb-garamond-400.ttf')),
  negrita: readFileSync(join(raiz, 'docs/fonts/eb-garamond-700.ttf')),
  encabezado: readFileSync(join(raiz, 'docs/fonts/caladea-400.ttf')),
};
const tmp = mkdtempSync(join(tmpdir(), 'oficio-'));
const texto = (pdf) => { const f = join(tmp, 'x.pdf'); writeFileSync(f, pdf); return execFileSync('pdftotext', [f, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' '); };

// Una causa inventada, con los datos como se cargan en la ficha.
const causa = {
  expte: '14000001', actor: 'AMB', demandado: 'PÉREZ, JUAN CARLOS Y OTRO', tipo: 'EJECUTIVO', nom: '2', oficina: 'OEP',
  demandados: [
    { nombre: 'Pérez Juan Carlos', dni: '28.555.111', domicilio: 'San Juan 1520, Villa María, Córdoba' },
    { nombre: 'Gómez Ana', dni: '20-30123456-7', domicilio: 'Int. Matienzo 812, Leones, Córdoba' },
  ],
  titulos: [{ tipo: 'prenda', monto: 5390240, vencimiento: '', vehiculo: 'Motocicleta MONDIAL 110 MAX (año 2024), dominio A111BCD, motor CVRA00A000111, chasis 8CMML113R2000111' }],
};
const hoy = new Date(2026, 9, 26);

test('importes en letras y en números, como en los oficios', () => {
  const casos = {
    1: 'Uno', 21: 'Veintiuno', 100: 'Cien', 101: 'Ciento Uno', 1000: 'Mil', 1001: 'Mil Uno', 21000: 'Veintiún Mil', 101000: 'Ciento Un Mil',
    654815: 'Seiscientos Cincuenta y Cuatro Mil Ochocientos Quince', 1790000: 'Un Millón Setecientos Noventa Mil', 2100000: 'Dos Millones Cien Mil',
    21000000: 'Veintiún Millones', 1000000000: 'Mil Millones', 16250080: 'Dieciséis Millones Doscientos Cincuenta Mil Ochenta',
    31031031: 'Treinta y Un Millones Treinta y Un Mil Treinta y Uno', 0: 'Cero',
  };
  for (const [n, letras] of Object.entries(casos)) assert.equal(enLetras(+n), letras, n);
  assert.equal(enLetras(1234.5), 'Mil Doscientos Treinta y Cuatro con 50/100');
  assert.equal(cifra(1790000), '1.790.000');
  assert.equal(cifra(474164.5), '474.164,50');
  assert.equal(cifra(999), '999');
});

test('datos que salen de la causa: DNI, domicilio y vehículo', () => {
  assert.equal(dniOficio('28555111'), '28.555.111');
  assert.equal(dniOficio('20-30123456-7'), '30.123.456');
  assert.equal(dniOficio('7.654.321'), '7.654.321');
  assert.deepEqual(partirDomicilio('Int. Matienzo 812, Leones, Córdoba'), { calle: 'Int. Matienzo', numero: '812', localidad: 'Leones' });
  assert.deepEqual(partirDomicilio('Pública s/n, Ana Zumarán, Córdoba'), { calle: 'Pública', numero: 's/n', localidad: 'Ana Zumarán' });
  assert.deepEqual(partirVehiculo('MERCEDES BENZ LS 1634 (chasis c/cabina dormitorio), dominio AAA111, motor 457914U0000111, chasis 9BM6950538B000111'),
    { marca: 'MERCEDES BENZ', modelo: 'LS 1634', anio_vehiculo: '', dominio: 'AAA111', motor: '457914U0000111', chasis: '9BM6950538B000111' });
  assert.deepEqual(partirVehiculo('Camión IVECO 160E23N, dominio BBB222, motor 8M000222, chasis 8ATA1NFHOXX000222'),
    { marca: 'IVECO', modelo: '160E23N', anio_vehiculo: '', dominio: 'BBB222', motor: '8M000222', chasis: '8ATA1NFHOXX000222' });
  const d = datosDeCausa(causa, 1, hoy);
  assert.equal(d.autos, 'ASOCIACION MUTUAL BELL C/ PÉREZ, JUAN CARLOS Y OTRO');
  assert.equal(d.persona, 'GÓMEZ ANA');
  assert.equal(d.dni, '30.123.456');
  assert.equal(d.localidad, 'Leones');
  assert.deepEqual([d.marca, d.modelo, d.anio_vehiculo, d.dominio], ['MONDIAL', '110 MAX', '2024', 'A111BCD']);
  assert.deepEqual([d.nom, d.nom_ordinal, d.tipo_oficio, d.ciudad, d.anio], ['2', '2da', 'EJECUTIVO', 'Bell Ville', '2026']);
  assert.equal(d.monto_prenda, 5390240);
  assert.equal(datosDeCausa({ ...causa, tipo: 'PRENDARIO', oficina: 'OEP VM' }).tipo_oficio, 'EJECUCIÓN PRENDARIA');
  assert.equal(datosDeCausa({ ...causa, oficina: 'OEP VM' }).ciudad, 'Villa María');
  assert.equal(nombreArchivo('Oficio embargo de haberes', '14000001'), 'Oficio embargo de haberes - Expte 14000001.pdf');
});

test('completar un modelo: campos, lo opcional entre corchetes y lo que falta', () => {
  const m = 'A {{x}} B[[, año {{y}}]] C[[ D {{z}} E {{x}}]].';
  assert.deepEqual(rellenar(m, { x: '1', y: '2026', z: '' }), { texto: 'A 1 B, año 2026 C.', faltan: [] });
  assert.deepEqual(rellenar(m, { x: '', y: '', z: '3' }), { texto: 'A  B C.', faltan: ['x'] });
  // un dato no puede meter marcas
  assert.equal(rellenar('{{x}}', { x: '**negrita** [[y]]' }).texto, 'negrita y');
  // sin la sede, el encabezado del secuestro no deja un renglón vacío
  const base = { ...datosDeCausa(causa, 0, hoy), monto: '', monto_letras: '' };
  const sec = rellenar(MODELOS['oficio-secuestro-automotor'].cuerpo, base);
  assert.deepEqual(sec.faltan, []);
  const d = analizar(sec.texto);
  assert.deepEqual(d.encabezado.map((l) => l[0].t.replace(/\s+/g, ' ')), ['Bell Ville, de de 2026', 'Sr. Oficial de Justicia', 'S____________/_____________D']);
  assert.deepEqual(d.parrafos.map((p) => p.tipo), ['sangria', 'sangria', 'sangria', 'sangria', 'cierre']);
  assert.ok(!sec.texto.includes('enervar'), 'sin monto no va la cláusula para enervar el secuestro');
  const con = rellenar(MODELOS['oficio-secuestro-automotor'].cuerpo, { ...base, monto: cifra(5390240), monto_letras: enLetras(5390240), sede_oficial: 'Sede Bell Ville' });
  assert.match(con.texto, /pudiendo el ejecutado enervar el secuestro abonando la suma de Pesos \*\*Cinco Millones Trescientos Noventa Mil Doscientos Cuarenta \(\$5\.390\.240\) con más intereses y costas\*\*\*\*\.\*\*/);
  assert.equal(analizar(con.texto).encabezado[2][0].t, 'Sede Bell Ville');
  // el embargo marca lo que falta en la vista previa
  const emb = rellenar(MODELOS['oficio-embargo-haberes'].cuerpo, datosDeCausa(causa, 0, hoy), { marcar: true });
  assert.deepEqual(emb.faltan.sort(), ['cbu', 'cuenta_judicial', 'empleador', 'monto', 'monto_letras']);
  const html = htmlOficio(emb.texto);
  assert.match(html, /<span class="of-falta">empleador<\/span>/);
  assert.ok(!/<script/i.test(htmlOficio(rellenar('{{x}}', { x: '<script>alert(1)</script>' }).texto)), 'la vista previa escapa los datos');
});

test('los cuatro modelos son los mismos que carga la migración 0013', () => {
  const sqlMig = readFileSync(join(raiz, 'supabase/migrations/0013_acciones_cautelares.sql'), 'utf8');
  const filas = [...sqlMig.matchAll(/\('([a-z-]+)', '([^']+)', \$tx\$([\s\S]*?)\$tx\$\)/g)].map((m) => [m[1], { titulo: m[2], cuerpo: m[3] }]);
  assert.deepEqual(Object.fromEntries(filas), MODELOS);
  for (const a of Object.values(ACCIONES)) { assert.ok(MODELOS[a.oficio] && esModeloOficio(a.oficio)); assert.ok(MODELOS[a.escrito] && !esModeloOficio(a.escrito)); }
});

test('el PDF: tipografías adentro, texto que se puede leer y siempre el mismo para el mismo oficio', () => {
  for (const f of Object.values(fuentes)) { const t = leerTtf(f); assert.ok(t.anchos[65] > 0 && t.anchos[0xe9] > 0 && t.anchos[0x93] > 0, t.nombre); }
  const v = { ...datosDeCausa(causa, 0, hoy), empleador: 'EMPRESA DE PRUEBA SRL', cuit_empleador: '30-71234567-8', domicilio_empleador: 'San Martín 100, Bell Ville',
    monto: cifra(1790000), monto_letras: enLetras(1790000), cuenta_judicial: '305/1234567', cbu: '0200305251000001234567' };
  const doc = rellenar(MODELOS['oficio-embargo-haberes'].cuerpo, v).texto;
  const pdf = pdfOficio(doc, fuentes, { titulo: 'Oficio' });
  assert.equal(Buffer.from(pdf.subarray(0, 8)).toString(), '%PDF-1.4');
  assert.match(Buffer.from(pdf.subarray(-6)).toString(), /%%EOF\n$/);
  assert.deepEqual(pdfOficio(doc, fuentes, { titulo: 'Oficio' }), pdf, 'mismo texto, mismo PDF');
  const t = texto(pdf);
  for (const frase of ['Sr. Titular Empresa EMPRESA DE PRUEBA SRL', '“ASOCIACION MUTUAL BELL C/ PÉREZ, JUAN CARLOS Y OTRO - EJECUTIVO (Expte. Nº 14000001)”',
    'A TRABAR EMBARGO', 'PÉREZ JUAN CARLOS DNI 28.555.111', 'Un Millón Setecientos Noventa Mil ($ 1.790.000)', 'cuenta judicial nº 305/1234567 CBU 0200305251000001234567',
    'SOLER CARLOS EMILIANO MP 3-35383', 'Saluda a Ud. atentamente']) assert.ok(t.includes(frase), `falta "${frase}" en el PDF`);
  const info = execFileSync('pdfinfo', [join(tmp, 'x.pdf')], { encoding: 'utf8' });
  assert.match(info, /Pages:\s+1\b/);
  assert.match(info, /Page size:\s+612 x 792 pts/);
  const fonts = execFileSync('pdffonts', [join(tmp, 'x.pdf')], { encoding: 'utf8' });
  for (const n of ['EBGaramond-Regular', 'EBGaramond-Bold', 'Caladea-Regular']) assert.match(fonts, new RegExp(`${n}\\s+TrueType\\s+WinAnsi\\s+yes`), n);
});

test('texto seguro: ida y vuelta exacta, renglones cortos de ASCII sin comillas, sin espacios en los cortes', () => {
  for (const t of ['Bell Ville,     de               de 2026\nSr. “X” Nº 5 – ñ\\ "q" ~ <b> & 😀\t', ' a ', '  ', 'x', '~s05~n', 'a' + ' '.repeat(150) + 'b', 'pa labra '.repeat(200)]) {
    const e = codificar(t);
    assert.ok(/^[\x20-\x7e]*$/.test(e) && !/["\\]/.test(e) && !/^ | $|  /.test(e), JSON.stringify(t).slice(0, 30));
    assert.equal(decodificar(e), t);
    const ps = partir(e);
    assert.equal(ps.join(''), e);
    assert.ok(ps.every((p) => p.length <= 240 && p.length > 0 && !/^ | $/.test(p)));
    assert.equal(leerRenglones(renglones(t, 'Oficio.pdf').join('\n')).doc, t);
  }
  assert.equal(codificar('Bell Ville,     de               de 2026\nSr. “X”'), 'Bell Ville,~s05de~s15de 2026~nSr. ~201cX~201d');
});

test('oficio-pdf.mjs: arma el mismo PDF que la app y dice qué renglón se copió mal', () => {
  const v = { ...datosDeCausa(causa, 0, hoy), monto: cifra(5390240), monto_letras: enLetras(5390240) };
  const doc = rellenar(MODELOS['oficio-secuestro-automotor'].cuerpo, v).texto;
  const nombre = 'Oficio secuestro automotor - Expte 14000001.pdf';
  const ls = renglones(doc, nombre);
  assert.ok(ls.length >= 6, 'un oficio va en varias partes');
  const fin = join(tmp, 'oficio-1.txt'), correr = (destino) => spawnSync('node', [join(raiz, 'dev/oficio-pdf.mjs'), fin, destino], { encoding: 'utf8' });
  // copiado bien (aunque con sangría y renglones en blanco de más): el PDF es el de la app
  writeFileSync(fin, ls.map((l) => '  ' + l).join('\n\n') + '\n');
  const ok = correr(join(tmp, 'sale'));
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(new Uint8Array(readFileSync(join(tmp, 'sale', nombre))), pdfOficio(doc, fuentes, { titulo: nombre.replace('.pdf', '') }));
  // una letra distinta en la parte 3: dice cuál, y no arma nada
  const mal = [...ls]; mal[3] = mal[3].replace(/[a-z](?=[^~]*$)/, (c) => (c === 'a' ? 'b' : 'a'));
  writeFileSync(fin, mal.join('\n'));
  let r = correr(join(tmp, 'mal.pdf'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No coinciden las partes 3: volvé a copiar esos renglones/);
  assert.throws(() => readFileSync(join(tmp, 'mal.pdf')));
  // una parte que falta
  writeFileSync(fin, ls.filter((_, i) => i !== 2).join('\n'));
  r = correr(join(tmp, 'mal.pdf'));
  assert.match(r.stderr, /Faltan las partes 2 de/);
  // el renglón "oficio" mal copiado
  writeFileSync(fin, [ls[0].replace(/^oficio (\w)/, (x, c) => 'oficio ' + (c === '0' ? '1' : '0')), ...ls.slice(1)].join('\n'));
  r = correr(join(tmp, 'mal.pdf'));
  assert.match(r.stderr, /volvé a copiar el renglón "oficio"/);
});

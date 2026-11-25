// «Agencias conectadas» (migración 0051), la parte que no necesita la base: cómo se agrupan los vendedores por agencia,
// cómo se dice cuánto hace que entró y el cartel que ve la Mutual (docs/cobranzas/agencias.js). No necesita el stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumenConectadas, haceTexto, htmlConectadas } from '../../docs/cobranzas/agencias.js';

const fila = (agencia_id, agencia, vendedor, hace_seg, conectado) => ({ agencia_id, agencia, vendedor_id: `${agencia_id}-${vendedor}`, vendedor, titular: false, hace_seg, conectado });
const FILAS = [
  fila('a', 'Auto Sur', 'Ana', 20, true),
  fila('a', 'Auto Sur', 'Beto', 9000, false),
  fila('b', 'Norte <b>', 'Cris', 600, false),
  fila('c', 'Nueva', 'Dan', null, false),
  fila('d', 'Centro', 'Eva', 5, true),
];

test('una agencia está conectada si alguno de sus vendedores lo está; las conectadas van primero', () => {
  const r = resumenConectadas(FILAS);
  assert.deepEqual(r.conectadas.map((g) => g.nombre), ['Auto Sur', 'Centro']);
  assert.deepEqual(r.otras.map((g) => g.nombre), ['Norte <b>', 'Nueva'], 'la que estuvo más hace menos arriba; la que nunca entró, al final');
  assert.equal(r.total, 4);
  assert.deepEqual(resumenConectadas(null), { conectadas: [], otras: [], total: 0 });
});

test('cuánto hace que entró', () => {
  assert.equal(haceTexto(20), 'hace 1 min');
  assert.equal(haceTexto(600), 'hace 10 min');
  assert.equal(haceTexto(3 * 3600), 'hace 3 h');
  assert.equal(haceTexto(86400), 'hace 1 día');
  assert.equal(haceTexto(3 * 86400), 'hace 3 días');
  assert.equal(haceTexto(null), 'todavía no entró');
});

test('el cartel: cuántas hay, la luz, quiénes son al abrirlo y nada si la base no lo tiene', () => {
  const cerrado = htmlConectadas({ filas: FILAS, abierto: false });
  assert.match(cerrado, /2 agencias conectadas/);
  assert.match(cerrado, /class="luz verde"/);
  assert.ok(!cerrado.includes('ag-conx-lista'), 'cerrado no muestra la lista');
  assert.match(cerrado, /aria-expanded="false"/);

  const abierto = htmlConectadas({ filas: FILAS, abierto: true });
  assert.match(abierto, /aria-expanded="true"/);
  assert.match(abierto, /Auto Sur/);
  assert.match(abierto, /Ana/, 'con dos vendedores se dice cuál está conectado');
  assert.ok(!abierto.includes('Beto'), 'el que no está conectado no se nombra');
  assert.match(abierto, /hace 10 min/);
  assert.match(abierto, /todavía no entró/);
  assert.match(abierto, /conectada ahora/);
  assert.ok(abierto.includes('Norte &lt;b&gt;') && !abierto.includes('Norte <b>'), 'los nombres se escapan');
  assert.equal((abierto.match(/class="luz verde"/g) || []).length, 3, 'la del cartel y las dos conectadas');
  assert.equal((abierto.match(/class="luz roja"/g) || []).length, 2);

  assert.match(htmlConectadas({ filas: [fila('a', 'Auto Sur', 'Ana', 20, true)], abierto: false }), /1 agencia conectada/);
  const ninguna = htmlConectadas({ filas: [fila('b', 'Norte', 'Cris', 600, false)], abierto: false });
  assert.match(ninguna, /Ninguna agencia conectada/);
  assert.match(ninguna, /class="luz roja"/);
  assert.match(htmlConectadas({ filas: [], abierto: true }), /Todavía no hay agencias activas/);
  assert.equal(htmlConectadas({ filas: null, abierto: true }), '');
  assert.equal(htmlConectadas(undefined), '');
});

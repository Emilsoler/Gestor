// Persona jurídica en la solicitud del cotizador y la pregunta «¿es asociado a la Mutual?»: lo que no necesita base ni red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOCS_NO_ASOCIADA, esJuridica, revisarDatos } from '../../docs/agencias/solicitud.js';

const HOY = '2026-11-25';
const SEDE = { dom_calle: 'Bv. Colón', dom_numero: '135', dom_cp: '2550', dom_localidad: 'Bell Ville', dom_provincia: 'Córdoba' };
const EMPRESA = { ...SEDE, representante_nombre: 'PEREZ JUAN', representante_dni: '20123456', representante_cargo: 'Presidente', celular: '3534 123456', asociado: false };
const PERSONA = { dni: '11111111', estado_civil: 'soltero', celular: '3534123456', nacionalidad: 'Argentina', nacimiento: '1980-02-03', ...SEDE, asociado: true };

test('esJuridica: CUIT 30, 33 y 34; las personas no', () => {
  for (const c of ['30-71234567-8', '33711111119', '34000000001']) assert.equal(esJuridica(c), true, c);
  for (const c of ['20-11111111-2', '27111111112', '23111111119', '', null, '3071234567']) assert.equal(esJuridica(c), false, String(c));
});

test('empresa: pide sede, representante, celular y si es asociada; no pide DNI ni estado civil', () => {
  const vacio = revisarDatos({}, HOY, true);
  assert.ok(vacio.errores.length >= 8);
  assert.ok(!vacio.errores.some((e) => /estado civil|nacionalidad|nacimiento/i.test(e)));
  assert.ok(vacio.errores.some((e) => /asociada/.test(e)));
  const ok = revisarDatos(EMPRESA, HOY, true);
  assert.equal(ok.errores, undefined);
  assert.equal(ok.datos.persona, 'juridica');
  assert.equal(ok.datos.asociado, false);
  assert.equal(ok.datos.representante_dni, '20123456');
  assert.equal(ok.datos.dni, undefined);
  assert.equal(ok.datos.estado_civil, undefined);
  assert.match(ok.datos.domicilio, /Bv\. Colón 135, Bell Ville/);
});

test('empresa: DNI y celular mal escritos se rechazan', () => {
  assert.ok(revisarDatos({ ...EMPRESA, representante_dni: '12' }, HOY, true).errores.some((e) => /DNI del representante/.test(e)));
  assert.ok(revisarDatos({ ...EMPRESA, celular: '12' }, HOY, true).errores.some((e) => /celular/.test(e)));
  assert.ok(revisarDatos({ ...EMPRESA, asociado: undefined }, HOY, true).errores.some((e) => /asociada/.test(e)));
});

test('persona física: también tiene que decir si es asociada, y no se le pide nada más', () => {
  assert.ok(revisarDatos({ ...PERSONA, asociado: undefined }, HOY).errores.some((e) => /asociado/.test(e)));
  for (const asociado of [true, false]) {
    const r = revisarDatos({ ...PERSONA, asociado }, HOY);
    assert.equal(r.errores, undefined);
    assert.equal(r.datos.asociado, asociado);
    assert.equal(r.datos.persona, undefined);
  }
});

test('la lista de documentos de una empresa no asociada tiene los cuatro del estudio', () => {
  assert.deepEqual(DOCS_NO_ASOCIADA, ['Estatuto social', 'Última acta de autoridades', 'Último balance certificado y aprobado', 'DNI de los socios']);
});

test('la copia de solicitud.js de la función es igual a la de la app', () => {
  assert.equal(readFileSync(new URL('../../supabase/functions/agencias/solicitud.js', import.meta.url), 'utf8'), readFileSync(new URL('../../docs/agencias/solicitud.js', import.meta.url), 'utf8'));
});

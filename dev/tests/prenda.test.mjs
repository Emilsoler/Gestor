// Prenda (geolocalización de vehículos prendados): permisos, bitácora append-only, funciones del
// esquema gestor y la función `ubicar` de punta a punta (con posición simulada, sin equipo real).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { anon, servicio, entrar, crearCuenta, sql, env } from './helpers.mjs';

const MIEMBRO = 'prenda.miembro@test', AJENO = 'prenda.ajeno@test', CLAVE = 'Clave-de-prueba-2026';
let cli; // cliente del miembro

function limpiarPrenda() {
  sql(`delete from public.ubicaciones; delete from public.vehiculos; update public.ajustes_prenda set politica='mora', zona_km=20 where id=1;
       delete from gestor.cambios where tabla in ('vehiculos','ajustes_prenda');`);
}

before(async () => {
  sql(`delete from gestor.miembros; delete from auth.users;`);
  limpiarPrenda();
  await crearCuenta(MIEMBRO, CLAVE, 'Emi');
  await crearCuenta(AJENO, CLAVE, '').catch(() => {});
  sql(`delete from gestor.miembros where email='${AJENO}'`); // ajeno: tiene cuenta pero no está autorizado
  cli = await entrar(MIEMBRO, CLAVE);
});
after(() => limpiarPrenda());

test('un ajeno (cuenta sin autorizar) no puede leer vehículos', async () => {
  const c = await entrar(AJENO, CLAVE);
  const { error } = await c.from('vehiculos').select('*');
  assert.ok(error, 'debería rechazar a quien no es miembro');
  assert.equal(error.code, '42501');
});

test('un miembro puede crear, leer, modificar y borrar vehículos', async () => {
  const { data: nuevo, error: e1 } = await cli.from('vehiculos').insert({ dominio: 'AA123BB', marca: 'Fiat', situacion: 'mora' }).select().single();
  assert.equal(e1, null);
  assert.equal(nuevo.dominio, 'AA123BB');
  const { data: mod } = await cli.from('vehiculos').update({ modelo: 'Cronos' }).eq('id', nuevo.id).select().single();
  assert.equal(mod.modelo, 'Cronos');
  const { error: e3 } = await cli.from('vehiculos').delete().eq('id', nuevo.id);
  assert.equal(e3, null);
});

test('la bitácora es append-only: se puede agregar y leer, pero no modificar ni borrar', async () => {
  const { data: v } = await cli.from('vehiculos').insert({ dominio: 'BB222CC', deudor: 'Fulano' }).select().single();
  const { data: u, error: eIns } = await cli.from('ubicaciones')
    .insert({ vehiculo: v.id, dominio: v.dominio, deudor: v.deudor, motivo: 'Alerta del equipo', consultado_por: 'FALSO', momento: '2000-01-01T00:00:00Z' })
    .select().single();
  assert.equal(eIns, null);
  // El disparador pone autor y momento reales: no se puede firmar con otro nombre ni antedatar.
  assert.notEqual(u.consultado_por, 'FALSO');
  assert.ok(Date.now() - new Date(u.momento).getTime() < 60000, 'el momento lo pone la base, cercano a ahora');
  const { error: eUpd } = await cli.from('ubicaciones').update({ motivo: 'otro' }).eq('id', u.id);
  assert.ok(eUpd, 'no se puede modificar una constancia');
  const { error: eDel } = await cli.from('ubicaciones').delete().eq('id', u.id);
  assert.ok(eDel, 'no se puede borrar una constancia');
  await cli.from('vehiculos').delete().eq('id', v.id);
});

test('funciones del conector: alta, consentimiento, búsqueda y bitácora', () => {
  sql(`select gestor.agregar_vehiculo('CD456EF', 'Toyota', 'Etios', 2020, 'Mengano', '0999', 'al_dia')`);
  assert.equal(sql(`select consentimiento is null from public.vehiculos where dominio='CD456EF'`), 't', 'nace sin consentimiento');
  sql(`select gestor.registrar_consentimiento('CD456EF', '2025-05-05')`);
  assert.equal(sql(`select consentimiento->>'fecha' from public.vehiculos where dominio='CD456EF'`), '2025-05-05');
  assert.equal(sql(`select count(*) from gestor.vehiculo('cd456ef')`), '1', 'busca por dominio sin importar may/min');
  assert.equal(sql(`select count(*) from gestor.vehiculo('Mengano')`), '1', 'busca por deudor');
});

test('deshacer repone un vehículo modificado y los ajustes', () => {
  const id = sql(`select id from public.vehiculos where dominio='CD456EF'`);
  sql(`begin; select set_config('gestor.autor','Claude',true); update public.vehiculos set situacion='ejecucion' where id='${id}'; commit;`);
  const cambio = sql(`select id from gestor.cambios where tabla='vehiculos' and clave='${id}' and operacion='cambio' order by id desc limit 1`);
  sql(`select gestor.deshacer(${cambio})`);
  assert.equal(sql(`select situacion from public.vehiculos where id='${id}'`), 'al_dia', 'volvió al estado anterior');

  sql(`begin; select set_config('gestor.autor','Claude',true); update public.ajustes_prenda set zona_km=40 where id=1; commit;`);
  const c2 = sql(`select id from gestor.cambios where tabla='ajustes_prenda' order by id desc limit 1`);
  sql(`select gestor.deshacer(${c2})`);
  assert.equal(sql(`select zona_km from public.ajustes_prenda where id=1`), '20.0');
});

test('las tablas de Prenda no tienen estadísticas del planificador (barrera 3)', () => {
  const n = sql(`select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace s on s.oid=c.relnamespace
    where s.nspname='public' and c.relname in ('vehiculos','ubicaciones','ajustes_prenda') and a.attnum>0 and not a.attisdropped and a.attstattarget<>0`);
  assert.equal(n, '0', 'todas las columnas en 0');
});

test('ubicar: sin consentimiento no da ubicación; con consentimiento sí, y queda en la bitácora', async () => {
  const { data: v } = await cli.from('vehiculos')
    .insert({ dominio: 'EF789GH', marca: 'Chevrolet', modelo: 'Onix', deudor: 'Zutano', situacion: 'mora', sim: { modo: 'quieto', pos: [-32.63, -62.68] } })
    .select().single();

  // Sin consentimiento → 403 sin_consentimiento.
  const r1 = await cli.functions.invoke('ubicar', { body: { vehiculo_id: v.id, motivo: 'Control de la garantía por mora' } });
  assert.ok(r1.error, 'sin consentimiento no ubica');

  // Con consentimiento → devuelve la constancia (posición simulada).
  sql(`select gestor.registrar_consentimiento('${v.id}', '2025-01-01')`);
  const r2 = await cli.functions.invoke('ubicar', { body: { vehiculo_id: v.id, motivo: 'Control de la garantía por mora', nota: 'prueba' } });
  assert.equal(r2.error, null, r2.error && JSON.stringify(r2.error));
  const u = r2.data.ubicacion;
  assert.equal(u.resultado.origen, 'simulado');
  assert.ok(Math.abs(u.resultado.lat + 32.63) < 0.01 && Math.abs(u.resultado.lon + 62.68) < 0.01, 'la posición coincide con la simulación');
  assert.ok(u.codigo && /^[0-9A-F ]+$/.test(u.codigo), 'trae código de control');
  assert.equal(sql(`select count(*) from public.ubicaciones where vehiculo='${v.id}'`), '1', 'quedó en la bitácora');

  // Motivo inválido → 400.
  const r3 = await cli.functions.invoke('ubicar', { body: { vehiculo_id: v.id, motivo: 'cualquier cosa' } });
  assert.ok(r3.error, 'rechaza un motivo que no está en la lista');
});

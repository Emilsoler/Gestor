// Cotizador para agencias: la función `agencias` corriendo en local (dev/stack.sh up la levanta con Deno),
// contra la base local y un doble de InfoAuto (dev/infoauto-falso.mjs) con vehículos y precios inventados.
// Lo principal que se controla: que a una agencia NUNCA le llegue un precio ni un CODIA de InfoAuto
// (licencia "Agencias/Concesionarias"), y las reglas de la licencia en la base (tope de 20, aviso a InfoAuto).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, sqlFalla, limpiar, crearCuenta, entrar, env, servicio } from './helpers.mjs';
import { simularCredito as simInterno, GASTOS_DEFECTO, gastosDe } from '../../docs/cobranzas/vehiculos.js';
import { simularCredito, montoMaximo, tasaInterna, tasasDelCredito } from '../../supabase/functions/agencias/credito.js';

const FALSO = 'http://127.0.0.1:54343';
const FN = `${env.SUPABASE_URL}/functions/v1/agencias`;
const pedidos = async () => (await fetch(`${FALSO}/__pedidos`)).json();
const olvidar = () => fetch(`${FALSO}/__pedidos`, { method: 'DELETE' });
// Precios del doble (en pesos) y CODIA: nada de esto puede aparecer en una respuesta a una agencia.
const PROHIBIDO = ['35000000', '30000000', '25000000', '18000000', '20000000', '9000000', '3000000', '500001', '500002', '500009',
  '35000', '30000', '25000', '18000'];

async function pedir(jwt, cuerpo) {
  const r = await fetch(FN, {
    method: 'POST',
    headers: { apikey: env.ANON_KEY, 'content-type': 'application/json', origin: 'http://127.0.0.1:8080', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  return { status: r.status, datos: JSON.parse(texto), texto };
}
function sinFiltraciones(texto) {
  for (const p of PROHIBIDO) assert.ok(!new RegExp(`(?<![0-9])${p}(?![0-9])`).test(texto), `la respuesta no debe incluir ${p}: ${texto.slice(0, 300)}`);
  assert.ok(!/codia|valuaci|precio|price|infoauto/i.test(texto), `la respuesta no debe nombrar precios ni códigos: ${texto.slice(0, 300)}`);
}

async function cuentaAgencia(email, nombre, { informada = 'gestor.hoy()' } = {}) {
  const { error } = await servicio().auth.admin.createUser({ email, password: 'Agencia-123456', email_confirm: true });
  if (error) throw new Error(error.message);
  sql(`select gestor.autorizar_agencia('${email}', '${nombre}', ${informada})`);
  return (await entrar(email, 'Agencia-123456')).sesion.access_token;
}

let emi, agencia;
before(async () => {
  limpiar();
  sql(`delete from public.cotizaciones_agencia; delete from public.agencias; delete from public.infoauto_token;
       update public.ajustes_agencias set habilitado = false, antiguedad_max = null, tope_diario = 300, monto_maximo = null, monto_minimo = 0, redondeo = 50000, pct_financiable = 50, plazos = '{12,18,24,36}',
         tasas = '[]', anio_minimo = null, tasa_mensual = 7, gastos = '{"sellado":1.2,"arancel":0.1,"arancelMin":13000,"contratos":20000,"envio":20000,"gestoria":29000,"redondeo":null,"seguro":0.1,"administrativos":50,"cuotaSocial":200,"igr":3}';`);
  await crearCuenta('emi@test.local', 'Clave-de-prueba-2026', 'Emi');
  emi = (await entrar('emi@test.local', 'Clave-de-prueba-2026')).sesion.access_token;
  agencia = await cuentaAgencia('salon@test.local', 'Salón Uno');
});

test('las cuentas del cotizador son las del simulador interno', () => {
  const g = gastosDe(GASTOS_DEFECTO);
  for (let k = 0; k < 300; k++) {
    const capital = 100000 + Math.round(Math.random() * 40_000_000), cuotas = 1 + Math.floor(Math.random() * 120), tasa = Math.round(Math.random() * 1500) / 100;
    assert.deepEqual(simularCredito({ capital, cuotas, g, tasa }), simInterno({ capital, cuotas, g, tasa }));
  }
  // El máximo redondea hacia abajo y respeta mínimo y máximo.
  const a = { pct_financiable: 50, redondeo: 50000, monto_minimo: 0, monto_maximo: null };
  assert.equal(montoMaximo(35_000_000, a), 17_500_000);
  assert.equal(montoMaximo(25_123_456, a), 12_550_000);
  assert.equal(montoMaximo(25_123_456, { ...a, monto_maximo: 10_000_000 }), 10_000_000);
  assert.equal(montoMaximo(1_000_000, { ...a, monto_minimo: 600_000 }), 0);
  // La TIR de un préstamo sin gastos es su tasa.
  const i = 0.07, n = 24, cuota = 1_000_000 * i / (1 - (1 + i) ** -n);
  assert.ok(Math.abs(tasaInterna(1_000_000, cuota, n) - i) < 1e-9);
  const s = simularCredito({ capital: 5_000_000, cuotas: 24, g, tasa: 7 });
  const t = tasasDelCredito(s);
  assert.equal(t.tna, 84);
  assert.equal(t.tea, 125.22);
  assert.ok(t.cft > t.tea, 'el CFT incluye los gastos');
});

test('sin sesión o con una cuenta que no es de una agencia, no se cotiza', async () => {
  assert.equal((await pedir(null, { accion: 'yo' })).status, 401);
  assert.equal((await pedir('no-es-un-token', { accion: 'yo' })).status, 401);
  const { error } = await servicio().auth.admin.createUser({ email: 'intruso@test.local', password: 'Intruso-123456', email_confirm: true });
  assert.ifError(error);
  const intruso = (await entrar('intruso@test.local', 'Intruso-123456')).sesion.access_token;
  const r = await pedir(intruso, { accion: 'marcas' });
  assert.equal(r.status, 403);
  assert.equal(r.datos.error, 'sin_acceso');
});

test('la agencia no puede leer nada de la base: la API se la cierra la puerta del gestor', async () => {
  const c = await entrar('salon@test.local', 'Agencia-123456');
  for (const t of ['deudores', 'causas', 'agencias', 'ajustes_agencias', 'cotizaciones_agencia', 'infoauto_token']) {
    const { data, error } = await c.from(t).select('*');
    assert.ok(error, `${t}: tenía que fallar y devolvió ${JSON.stringify(data)}`);
  }
  const { error } = await c.rpc('agencia_sesion', { p_user: c.sesion.user.id });
  assert.ok(error);
});

test('clave temporal y cotizador deshabilitado', async () => {
  let r = await pedir(agencia, { accion: 'yo' });
  assert.equal(r.status, 200);
  assert.equal(r.datos.agencia, 'Salón Uno');
  assert.equal(r.datos.clave_temporal, true);
  assert.equal(r.datos.habilitado, false);
  r = await pedir(agencia, { accion: 'marcas' });
  assert.equal(r.status, 403);
  assert.equal(r.datos.error, 'clave_temporal');
  assert.equal((await pedir(agencia, { accion: 'clave_definida' })).status, 200);
  r = await pedir(agencia, { accion: 'marcas' });
  assert.equal(r.status, 403);
  assert.equal(r.datos.error, 'deshabilitado');
  // La Mutual sí puede probarlo deshabilitado, como vista previa.
  r = await pedir(emi, { accion: 'yo' });
  assert.equal(r.datos.miembro, true);
  assert.equal((await pedir(emi, { accion: 'marcas' })).status, 200);
});

test('elegir el auto: marcas, modelos (paginados), versiones y años, sin precios ni CODIA', async () => {
  sql('update public.ajustes_agencias set habilitado = true');
  await olvidar();
  let r = await pedir(agencia, { accion: 'marcas' });
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(r.datos.marcas.map((m) => m.nombre), ['MARCA DOS', 'MARCA UNO']);
  sinFiltraciones(r.texto);

  r = await pedir(agencia, { accion: 'modelos', marca: 2 });
  assert.equal(r.datos.modelos.length, 120, 'trae todas las páginas');
  assert.ok((await pedidos()).some((p) => p.includes('/brands/2/groups/') && p.includes('page=2')));

  r = await pedir(agencia, { accion: 'versiones', marca: 1, grupo: 10 });
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(r.datos.versiones.map((v) => v.nombre), ['SEDAN 1.6 BASE L/24', 'SEDAN 2.0 FULL']);
  sinFiltraciones(r.texto);
  const ref = r.datos.versiones[0].ref;
  assert.match(ref, /^[A-Za-z0-9_-]{20,}$/);

  r = await pedir(agencia, { accion: 'anios', ref });
  assert.deepEqual(r.datos.anios, ['0km', '2026', '2024', '2020']);
  sinFiltraciones(r.texto);

  // Una referencia inventada o alterada no sirve.
  r = await pedir(agencia, { accion: 'anios', ref: '500001' });
  assert.equal(r.status, 400);
  r = await pedir(agencia, { accion: 'anios', ref: ref.slice(0, -2) + (ref.endsWith('A') ? 'BB' : 'AA') });
  assert.equal(r.status, 400);

  // Antigüedad máxima: con 5 años, el 2020 y el modelo viejo quedan afuera.
  sql('update public.ajustes_agencias set antiguedad_max = 5');
  r = await pedir(agencia, { accion: 'anios', ref });
  assert.deepEqual(r.datos.anios, ['0km', '2026', '2024']);
  r = await pedir(agencia, { accion: 'modelos', marca: 1 });
  assert.deepEqual(r.datos.modelos.map((m) => m.nombre), ['SEDAN']);
  sql('update public.ajustes_agencias set antiguedad_max = null');
});

test('cotizar: solo las condiciones del préstamo, y queda registrado sin el valor', async () => {
  sql('update public.ajustes_agencias set habilitado = true; delete from public.cotizaciones_agencia;');
  const ref = (await pedir(agencia, { accion: 'versiones', marca: 1, grupo: 10 })).datos.versiones[0].ref;
  let r = await pedir(agencia, { accion: 'cotizar', ref, anio: '0km', cuotas: 24, vehiculo: 'MARCA UNO SEDAN 1.6' });
  assert.equal(r.status, 200, r.texto);
  sinFiltraciones(r.texto);
  const d = r.datos;
  assert.equal(d.maximo, 17_500_000); // 50% de 35.000.000, redondeado a $50.000
  assert.equal(d.monto, 17_500_000);
  const g = gastosDe(GASTOS_DEFECTO), esperado = simInterno({ capital: 17_500_000, cuotas: 24, g, tasa: 7 });
  assert.equal(d.cuota, esperado.cuota);
  assert.equal(d.total, esperado.totalCredito);
  assert.deepEqual(d.opciones.map((o) => o.cuotas), [12, 18, 24, 36]);
  assert.equal(d.tna, 84);
  assert.deepEqual(Object.keys(d).sort(), ['anio', 'cft', 'contacto', 'cuota', 'cuotas', 'financiable', 'gastos_otorgamiento', 'leyenda', 'maximo', 'monto', 'opciones', 'tea', 'tna', 'total'].sort());

  // Un monto menor se respeta; uno mayor se lleva al máximo.
  r = await pedir(agencia, { accion: 'cotizar', ref, anio: '2024', cuotas: 12, monto: 5_000_000 });
  assert.equal(r.datos.maximo, 12_500_000);
  assert.equal(r.datos.monto, 5_000_000);
  r = await pedir(agencia, { accion: 'cotizar', ref, anio: '2024', cuotas: 12, monto: 99_000_000 });
  assert.equal(r.datos.monto, 12_500_000);

  // Plazo fuera de los permitidos o año sin precio: no.
  assert.equal((await pedir(agencia, { accion: 'cotizar', ref, anio: '2024', cuotas: 48 })).status, 400);
  assert.equal((await pedir(agencia, { accion: 'cotizar', ref, anio: '2019', cuotas: 12 })).status, 400);

  const filas = JSON.parse(sql(`select json_agg(to_jsonb(c) order by id) from public.cotizaciones_agencia c`));
  assert.equal(filas.length, 3);
  assert.equal(filas[0].agencia, 'Salón Uno');
  assert.equal(filas[0].vehiculo, 'MARCA UNO SEDAN 1.6');
  assert.equal(filas[0].anio, '0km');
  for (const f of filas) for (const p of ['35000000', '25000000', '500001']) assert.ok(!JSON.stringify(f).includes(p));

  // La vista previa de la Mutual no se registra.
  await pedir(emi, { accion: 'cotizar', ref, anio: '2024', cuotas: 12 });
  assert.equal(sql('select count(*) from public.cotizaciones_agencia'), '3');
});

test('el token de InfoAuto se reutiliza: un solo login para muchas consultas', async () => {
  sql('delete from public.infoauto_token');
  await olvidar();
  for (let k = 0; k < 4; k++) await pedir(agencia, { accion: 'marcas' });
  assert.equal((await pedidos()).filter((p) => p.startsWith('/cars/auth/login')).length, 1);
});

test('tope diario de cotizaciones por agencia', async () => {
  sql('update public.ajustes_agencias set habilitado = true, tope_diario = 4; delete from public.cotizaciones_agencia;');
  const ref = (await pedir(agencia, { accion: 'versiones', marca: 1, grupo: 10 })).datos.versiones[1].ref;
  for (let k = 0; k < 4; k++) assert.equal((await pedir(agencia, { accion: 'cotizar', ref, anio: '2022', cuotas: 12 })).status, 200);
  const r = await pedir(agencia, { accion: 'cotizar', ref, anio: '2022', cuotas: 12 });
  assert.equal(r.status, 429);
  assert.equal(r.datos.error, 'tope');
  sql('update public.ajustes_agencias set tope_diario = 300');
});

test('reglas de la licencia en la base: aviso a InfoAuto, tope de 20 y cuentas separadas', async () => {
  // Sin la fecha del aviso a InfoAuto no se activa.
  const { error } = await servicio().auth.admin.createUser({ email: 'sinaviso@test.local', password: 'Agencia-123456', email_confirm: true });
  assert.ifError(error);
  assert.match(sqlFalla(`select gestor.autorizar_agencia('sinaviso@test.local', 'Sin aviso', null)`), /informó por escrito a InfoAuto/);
  assert.match(sqlFalla(`select gestor.autorizar_agencia('sinaviso@test.local', 'Sin aviso', gestor.hoy() + 3)`), /no puede ser futura/);
  // Una cuenta del gestor no puede ser agencia.
  assert.match(sqlFalla(`select gestor.autorizar_agencia('emi@test.local', 'Emi', gestor.hoy())`), /usuario del gestor/);
  // Tope de 20 activas (ya hay 1).
  sql(`insert into public.agencias (nombre, email, informada_infoauto) select 'A' || g, 'a' || g || '@x.local', gestor.hoy() from generate_series(2, 20) g`);
  assert.match(sqlFalla(`insert into public.agencias (nombre, email, informada_infoauto) values ('Veintiuno', 'a21@x.local', gestor.hoy())`), /20 agencias activas/);
  sql(`insert into public.agencias (nombre, email, informada_infoauto, activa) values ('Pausada', 'a22@x.local', null, false)`);
  sql(`select gestor.pausar_agencia('a2@x.local')`);
  sql(`update public.agencias set activa = true, informada_infoauto = gestor.hoy() where email = 'a22@x.local'`);
  // Pausada, la agencia deja de poder cotizar en el acto.
  sql(`select gestor.pausar_agencia('salon@test.local')`);
  assert.equal((await pedir(agencia, { accion: 'yo' })).status, 403);
  sql(`delete from public.agencias where email like '%@x.local'`);
  sql(`select gestor.autorizar_agencia('salon@test.local', 'Salón Uno', gestor.hoy())`);
});

test('la Mutual administra desde la app: parámetros, agencias y cotizaciones; la agencia no', async () => {
  const c = await entrar('emi@test.local', 'Clave-de-prueba-2026');
  let r = await c.from('ajustes_agencias').update({ pct_financiable: 60 }).eq('id', 1).select();
  assert.ifError(r.error);
  assert.equal(+r.data[0].pct_financiable, 60);
  sql('update public.ajustes_agencias set pct_financiable = 50');
  r = await c.from('cotizaciones_agencia').select('*');
  assert.ifError(r.error);
  const { error } = await servicio().auth.admin.createUser({ email: 'salon2@test.local', password: 'Agencia-123456', email_confirm: true });
  assert.ifError(error);
  r = await c.rpc('alta_agencia', { p_email: 'salon2@test.local', p_nombre: 'Salón Dos', p_informada: new Date().toISOString().slice(0, 10) });
  assert.ifError(r.error);
  assert.equal(sql(`select actualizado_por from public.agencias where email = 'salon2@test.local'`), 'Emi');
  // Las cotizaciones no se modifican ni se inventan desde la API.
  r = await c.from('cotizaciones_agencia').insert({ agencia_id: crypto.randomUUID(), agencia: 'x', monto: 1, cuotas: 1, cuota: 1 });
  assert.ok(r.error);
});

// ───────────────────────── Segunda parte: tasas por modelo, BCRA y solicitudes ─────────────────────────
import { readFileSync } from 'node:fs';
import { tasaPara, anioMinimo } from '../../supabase/functions/agencias/credito.js';
import { CUIT, CASOS } from './casos-bcra.mjs';
const cargarCasosBCRA = () => fetch('http://127.0.0.1:54341/__casos', { method: 'POST', body: JSON.stringify(CASOS) });

const PARAMS_MUTUAL = `update public.ajustes_agencias set habilitado = true, pct_financiable = 40, anio_minimo = 2014, antiguedad_max = null,
  plazos = (select array_agg(g) from generate_series(1, 24) g), tope_diario = 300,
  tasas = '[{"desde":2021,"tasa":5},{"desde":2018,"tasa":6},{"desde":2014,"tasa":7}]',
  gastos = jsonb_set(jsonb_set(gastos, '{envio}', '0'), '{gestoria}', '0')`;

test('la copia del semáforo del BCRA es la misma que la de Cobranzas', () => {
  assert.equal(readFileSync(new URL('../../supabase/functions/agencias/bcra.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../../supabase/functions/bcra/bcra.ts', import.meta.url), 'utf8'));
});

test('tasa según el año del modelo y año mínimo', () => {
  const a = { tasa_mensual: 9, tasas: [{ desde: 2021, tasa: 5 }, { desde: 2018, tasa: 6 }, { desde: 2014, tasa: 7 }] };
  assert.equal(tasaPara('0km', a, 2026), 5);
  assert.equal(tasaPara('2026', a, 2026), 5);
  assert.equal(tasaPara('2021', a, 2026), 5);
  assert.equal(tasaPara('2020', a, 2026), 6);
  assert.equal(tasaPara('2018', a, 2026), 6);
  assert.equal(tasaPara('2017', a, 2026), 7);
  assert.equal(tasaPara('2014', a, 2026), 7);
  assert.equal(tasaPara('2013', a, 2026), 9, 'sin tramo, la tasa general');
  assert.equal(anioMinimo({ anio_minimo: 2014, antiguedad_max: null }, 2026), 2014);
  assert.equal(anioMinimo({ anio_minimo: 2014, antiguedad_max: 5 }, 2026), 2021);
  assert.equal(anioMinimo({ anio_minimo: null, antiguedad_max: null }, 2026), 0);
});

test('con los parámetros de la Mutual: 40 %, 1 a 24 cuotas, desde 2014 y tasa por modelo', async () => {
  sql(PARAMS_MUTUAL);
  let r = await pedir(agencia, { accion: 'yo' });
  assert.deepEqual(r.datos.plazos, Array.from({ length: 24 }, (_, i) => i + 1));
  // El modelo de 1995-2001 queda afuera.
  r = await pedir(agencia, { accion: 'modelos', marca: 1 });
  assert.deepEqual(r.datos.modelos.map((m) => m.nombre), ['SEDAN']);
  const [v1, v2] = (await pedir(agencia, { accion: 'versiones', marca: 1, grupo: 10 })).datos.versiones;
  assert.deepEqual((await pedir(agencia, { accion: 'anios', ref: v2.ref })).datos.anios, ['2022', '2015']);
  const g = { ...gastosDe(GASTOS_DEFECTO), envio: 0, gestoria: 0 };
  for (const [ref, anio, valor, tasa] of [[v1.ref, '0km', 35_000_000, 5], [v1.ref, '2020', 18_000_000, 6], [v2.ref, '2015', 9_000_000, 7]]) {
    r = await pedir(agencia, { accion: 'cotizar', ref, anio, cuotas: 24 });
    assert.equal(r.status, 200, r.texto);
    sinFiltraciones(r.texto);
    const maximo = Math.floor(valor * 0.4 / 50000) * 50000;
    assert.equal(r.datos.maximo, maximo, anio);
    const esperado = simInterno({ capital: maximo, cuotas: 24, g, tasa });
    assert.equal(r.datos.cuota, esperado.cuota, `cuota ${anio}`);
    assert.equal(r.datos.tna, tasa * 12, `TNA ${anio}`);
    assert.equal(r.datos.opciones.length, 24);
  }
  assert.equal((await pedir(agencia, { accion: 'cotizar', ref: v1.ref, anio: '2020', cuotas: 25 })).status, 400);
  assert.equal((await pedir(agencia, { accion: 'cotizar', ref: v1.ref, anio: '2020', cuotas: 1 })).status, 200);
});

test('BCRA desde la agencia: el color y el nombre; el detalle queda para la Mutual', async () => {
  sql(PARAMS_MUTUAL);
  await cargarCasosBCRA();
  let r = await pedir(agencia, { accion: 'bcra', cuit: '20-11111111-2' });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.datos.semaforo, 'verde');
  assert.equal(r.datos.denominacion, 'PERSONA VERDE');
  assert.deepEqual(Object.keys(r.datos).sort(), ['consulta', 'cuit', 'denominacion', 'semaforo']);
  const fila = JSON.parse(sql(`select to_jsonb(c) from public.consultas_bcra c where id = '${r.datos.consulta}'`));
  assert.equal(fila.consultado_por, 'Agencia · Salón Uno');
  assert.equal(fila.cuit, CUIT.verde);
  assert.ok(fila.resultado.deudas, 'la constancia guarda el detalle');
  r = await pedir(agencia, { accion: 'bcra', cuit: CUIT.amarillo });
  assert.equal(r.datos.semaforo, 'amarillo');
  r = await pedir(agencia, { accion: 'bcra', cuit: CUIT.rojo });
  assert.equal(r.datos.semaforo, 'rojo');
  r = await pedir(agencia, { accion: 'bcra', cuit: '20111111113' });
  assert.equal(r.status, 400);
  assert.equal(r.datos.error, 'cuit');
  // La vista previa de la Mutual consulta pero no guarda.
  const antes = sql('select count(*) from public.consultas_bcra');
  r = await pedir(emi, { accion: 'bcra', cuit: CUIT.verde });
  assert.equal(r.datos.semaforo, 'verde');
  assert.equal(r.datos.consulta, null);
  assert.equal(sql('select count(*) from public.consultas_bcra'), antes);
});

test('solicitud de aprobación: solo en verde, con el crédito recalculado, y la Mutual decide', async () => {
  sql(PARAMS_MUTUAL + '; delete from public.solicitudes_credito');
  await cargarCasosBCRA();
  const verde = (await pedir(agencia, { accion: 'bcra', cuit: CUIT.verde })).datos.consulta;
  const amarillo = (await pedir(agencia, { accion: 'bcra', cuit: CUIT.amarillo })).datos.consulta;
  const ref = (await pedir(agencia, { accion: 'versiones', marca: 1, grupo: 10 })).datos.versiones[0].ref;
  const base = { accion: 'solicitar', ref, anio: '2024', cuotas: 18, vehiculo: 'MARCA UNO SEDAN 1.6', cliente: '3534 123456' };

  let r = await pedir(agencia, { ...base, consulta: amarillo });
  assert.equal(r.status, 400);
  assert.equal(r.datos.error, 'semaforo');
  r = await pedir(emi, { ...base, consulta: verde });
  assert.equal(r.status, 400, 'la vista previa no manda solicitudes');
  // Un monto mayor al máximo no pasa: se recalcula en el servidor.
  r = await pedir(agencia, { ...base, consulta: verde, monto: 999_000_000 });
  assert.equal(r.status, 200, r.texto);
  const s = JSON.parse(sql(`select to_jsonb(s) from public.solicitudes_credito s where id = '${r.datos.id}'`));
  assert.equal(s.agencia, 'Salón Uno');
  assert.equal(s.cuit, CUIT.verde);
  assert.equal(s.denominacion, 'PERSONA VERDE');
  assert.equal(s.semaforo, 'verde');
  assert.equal(s.consulta, verde);
  assert.equal(+s.monto, 10_000_000); // 40 % de 25.000.000
  assert.equal(+s.tasa, 5);
  assert.equal(s.cuotas, 18);
  assert.equal(+s.cuota, simInterno({ capital: 10_000_000, cuotas: 18, g: { ...gastosDe(GASTOS_DEFECTO), envio: 0, gestoria: 0 }, tasa: 5 }).cuota);
  assert.equal(s.cliente, '3534 123456');
  assert.equal(s.estado, 'pendiente');
  for (const p of ['25000000', '500001']) assert.ok(!JSON.stringify(s).includes(p));
  // Otra para el mismo cliente, mientras está pendiente: no.
  r = await pedir(agencia, { ...base, consulta: verde });
  assert.equal(r.status, 409);
  // Una consulta de otra agencia no sirve.
  const otra = await cuentaAgencia('salon3@test.local', 'Salón Tres');
  await pedir(otra, { accion: 'clave_definida' });
  r = await pedir(otra, { ...base, consulta: verde });
  assert.equal(r.status, 400);
  assert.equal(r.datos.error, 'consulta');

  // La agencia ve la suya, pendiente.
  r = await pedir(agencia, { accion: 'solicitudes' });
  assert.equal(r.datos.solicitudes.length, 1);
  assert.equal(r.datos.solicitudes[0].estado, 'pendiente');
  assert.equal((await pedir(otra, { accion: 'solicitudes' })).datos.solicitudes.length, 0);

  // La Mutual la aprueba desde la app: solo puede tocar estado y nota.
  const c = await entrar('emi@test.local', 'Clave-de-prueba-2026');
  let u = await c.from('solicitudes_credito').update({ monto: 1 }).eq('id', s.id).select();
  assert.ok(u.error, 'el monto no se cambia');
  u = await c.from('solicitudes_credito').update({ estado: 'aprobada', nota: 'Que pase a firmar el jueves' }).eq('id', s.id).select();
  assert.ifError(u.error);
  assert.equal(u.data[0].resuelto_por, 'Emi');
  assert.ok(u.data[0].resuelto);
  u = await c.from('solicitudes_credito').insert({ agencia_id: crypto.randomUUID(), agencia: 'x', cuit: CUIT.verde, semaforo: 'verde', monto: 1, cuotas: 1, cuota: 1, total: 1, tasa: 1, cft: 1 });
  assert.ok(u.error, 'las solicitudes las crea solo la función');
  r = await pedir(agencia, { accion: 'solicitudes' });
  assert.equal(r.datos.solicitudes[0].estado, 'aprobada');
  assert.equal(r.datos.solicitudes[0].nota, 'Que pase a firmar el jueves');
  // La agencia no lee la tabla por la API.
  const ca = await entrar('salon@test.local', 'Agencia-123456');
  assert.ok((await ca.from('solicitudes_credito').select('*')).error);
});

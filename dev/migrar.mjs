// Traspaso de los datos del gestor anterior (la página en Claude) a la base nueva.
//
//   node migrar.mjs <carpeta-exportada> <carpeta-de-salida>
//
// <carpeta-exportada> tiene causas/*.json, acuerdos/*.json y plantillas/*.json, un archivo
// por registro (así los deja la exportación de la base de la página).
// Escribe en <carpeta-de-salida>:
//   NN-<tabla>.sql   lotes chicos para correr en orden (psql local, o el conector de Supabase)
//   verificar.sql    consulta que devuelve una huella por tabla
// Los datos son de clientes: la carpeta de salida NO va al repositorio.
//
// Cómo se verifica que no cambió nada en el camino: se cargan los mismos lotes en la base
// local, se corre verificar.sql en las dos bases y las huellas tienen que coincidir.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const [origen, salida] = process.argv.slice(2);
if (!origen || !salida) { console.error('uso: node migrar.mjs <carpeta-exportada> <carpeta-de-salida>'); process.exit(2); }
const LOTE = +process.env.LOTE_BYTES || 9000;

const leer = (tabla) => {
  const dir = join(origen, tabla);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ _id: basename(f, '.json'), ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
};

const txt = (v) => (v == null ? '' : String(v));
const causas = leer('causas').map((c) => {
  if (txt(c.expte) !== c._id) throw new Error(`causa ${c._id}: el expediente (${c.expte}) no coincide con su clave`);
  if (!/^\d+$/.test(c._id)) throw new Error(`causa ${c._id}: expediente no numérico`);
  for (const k of ['vence', 'fecha']) if (txt(c[k]) && !/^\d{4}-\d{2}-\d{2}$/.test(c[k])) throw new Error(`causa ${c._id}: ${k} inválida (${c[k]})`);
  return {
    expte: c._id, actor: txt(c.actor), demandado: txt(c.demandado), tipo: txt(c.tipo), nom: txt(c.nom), oficina: txt(c.oficina),
    estado: txt(c.estado), etiquetas: c.etiquetas || [], proxima: txt(c.proxima), vence: txt(c.vence), ultima: txt(c.ultima),
    fecha: txt(c.fecha), notas: txt(c.notas), historial: c.historial || [], liquidacion: c.liquidacion || null,
  };
});
const acuerdos = leer('acuerdos').map((a) => ({
  origen: a._id, deudor: txt(a.deudor), expte: txt(a.expte), notas: txt(a.notas), cuotas: a.cuotas || [], creado: txt(a.creado),
}));
const plantillas = leer('plantillas').map((p) => ({ id: p._id, titulo: txt(p.titulo), cuerpo: txt(p.cuerpo) }));

// Literal SQL con comillas de dólar, con una etiqueta que no aparezca en los datos.
function literal(json) {
  let tag = 'gj';
  while (json.includes(`$${tag}$`)) tag += 'x';
  return `$${tag}$${json}$${tag}$::jsonb`;
}
function lotes(filas) {
  const out = []; let actual = [], bytes = 0;
  for (const f of filas) {
    const n = Buffer.byteLength(JSON.stringify(f));
    if (actual.length && bytes + n > LOTE) { out.push(actual); actual = []; bytes = 0; }
    actual.push(f); bytes += n;
  }
  if (actual.length) out.push(actual);
  return out;
}

const SQL = {
  causas: (filas) => `begin;
select set_config('gestor.autor', 'Traspaso inicial', true);
insert into public.causas (expte, actor, demandado, tipo, nom, oficina, estado, etiquetas, proxima, vence, ultima, fecha, notas, historial, liquidacion)
select x.expte, x.actor, x.demandado, x.tipo, x.nom, x.oficina, x.estado,
       coalesce((select array_agg(e.v order by e.n) from jsonb_array_elements_text(x.etiquetas) with ordinality e(v, n)), '{}'),
       x.proxima, nullif(x.vence, '')::date, x.ultima, nullif(x.fecha, '')::date, x.notas, x.historial, nullif(x.liquidacion, 'null'::jsonb)
  from jsonb_to_recordset(${literal(JSON.stringify(filas))})
    as x(expte text, actor text, demandado text, tipo text, nom text, oficina text, estado text, etiquetas jsonb,
         proxima text, vence text, ultima text, fecha text, notas text, historial jsonb, liquidacion jsonb);
commit;`,
  acuerdos: (filas) => `begin;
select set_config('gestor.autor', 'Traspaso inicial', true);
insert into public.acuerdos (deudor, expte, notas, cuotas, creado)
select x.deudor, x.expte, x.notas, x.cuotas, coalesce(nullif(x.creado, '')::date, gestor.hoy())
  from jsonb_to_recordset(${literal(JSON.stringify(filas))})
    as x(deudor text, expte text, notas text, cuotas jsonb, creado text);
commit;`,
  plantillas: (filas) => `begin;
select set_config('gestor.autor', 'Traspaso inicial', true);
insert into public.plantillas (id, titulo, cuerpo)
select x.id, x.titulo, x.cuerpo
  from jsonb_to_recordset(${literal(JSON.stringify(filas))}) as x(id text, titulo text, cuerpo text);
commit;`,
};

mkdirSync(salida, { recursive: true });
let n = 0;
for (const [tabla, filas] of [['causas', causas], ['acuerdos', acuerdos], ['plantillas', plantillas]]) {
  for (const lote of lotes(filas)) {
    const archivo = `${String(++n).padStart(2, '0')}-${tabla}.sql`;
    writeFileSync(join(salida, archivo), SQL[tabla](lote) + '\n');
    console.log(archivo, `${lote.length} filas`, Buffer.byteLength(SQL[tabla](lote)) + ' bytes');
  }
}

// Huella de cada tabla: cantidad de filas y un md5 de todo su contenido, en un orden fijo.
// Los acuerdos no llevan su id (se genera en la base nueva).
writeFileSync(join(salida, 'verificar.sql'), `select 'causas' as tabla, count(*) as filas,
       md5(coalesce(string_agg(md5(concat_ws('|', expte, actor, demandado, tipo, nom, oficina, estado, array_to_string(etiquetas, ','),
           proxima, coalesce(to_char(vence, 'YYYY-MM-DD'), ''), ultima, coalesce(to_char(fecha, 'YYYY-MM-DD'), ''), notas,
           historial::text, coalesce(liquidacion::text, ''))), '' order by expte), '')) as huella
  from public.causas
union all
select 'acuerdos', count(*),
       md5(coalesce(string_agg(md5(concat_ws('|', deudor, expte, notas, cuotas::text, to_char(creado, 'YYYY-MM-DD'))), ''
           order by deudor, expte, cuotas::text), ''))
  from public.acuerdos
union all
select 'plantillas', count(*),
       md5(coalesce(string_agg(md5(concat_ws('|', id, titulo, cuerpo)), '' order by id), ''))
  from public.plantillas;
`);
console.log(`\n${causas.length} causas, ${acuerdos.length} acuerdos, ${plantillas.length} plantillas → ${n} lotes en ${salida}`);

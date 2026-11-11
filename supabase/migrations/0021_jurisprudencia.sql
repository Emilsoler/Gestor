-- Solapa «Jurisprudencia»: pedidos de búsqueda que la persona le hace a Claude.
--
-- La persona escribe un pedido en la app («fallos de demanda prendaria donde el actor sea una mutual»);
-- Claude lo toma, lo busca en Jurisemia (el buscador del Boletín Judicial de Córdoba, con Claude in Chrome
-- en la compu del estudio) y deja las fichas de los fallos acá, para verlas en la app.
--   borrador no hay: pendiente → buscando (una corrida lo tomó) → listo | error; o cancelado (antes de que lo tomen).
--
-- Reglas de uso de Jurisemia que esta tabla cuida (términos del Poder Judicial, v0.2):
--   · nada de búsquedas masivas ni automáticas: cada pedido lo hace la persona, uno por vez, y a lo sumo 4 consultas;
--   · no se replica el catálogo: de cada fallo se guarda solo cómo identificarlo y un resumen breve de Claude
--     (hasta 600 caracteres), nunca el texto de la resolución ni del sumario;
--   · el pedido no lleva nombres de clientes ni datos personales (la app lo avisa).
--
--   pedido      lo que pidió la persona, en sus palabras (hasta 600 caracteres)
--   filtros     {sede, anio, instancia, tipo} opcionales, texto libre corto
--   expte       causa a la que se vincula el pedido (opcional; sin clave foránea, como deudores.expte)
--   ahora       cuándo tocó «Buscar ahora»: ese pedido va primero
--   nota        lo que Claude cuenta del resultado (qué encontró, qué no, qué tan cerca quedó)
--   consultas   cuántas consultas hizo en Jurisemia (0 a 4)
--   resultados  lista de fichas: {caratula, resolucion, fecha, tribunal, sumario_leido, resumen, archivo}
--   resultado   si salió con error, el motivo

create table public.juris_pedidos (
  id              uuid primary key default gen_random_uuid(),
  pedido          text not null check (length(btrim(pedido)) between 3 and 600),
  filtros         jsonb not null default '{}'::jsonb check (jsonb_typeof(filtros) = 'object' and pg_column_size(filtros) <= 2048),
  expte           text not null default '',
  estado          text not null default 'pendiente' check (estado in ('pendiente', 'buscando', 'listo', 'error', 'cancelado')),
  ahora           timestamptz,
  nota            text not null default '',
  consultas       integer not null default 0 check (consultas between 0 and 4),
  resultados      jsonb not null default '[]'::jsonb
                    check (jsonb_typeof(resultados) = 'array' and jsonb_array_length(resultados) <= 20 and pg_column_size(resultados) <= 40960),
  resultado       text not null default '',
  creado          timestamptz not null default now(),
  rev             bigint not null default 0,
  actualizado     timestamptz not null default now(),
  actualizado_por text not null default ''
);
comment on table public.juris_pedidos is
  'Pedidos de jurisprudencia (solapa Jurisprudencia). pendiente → buscando → listo | error; o cancelado. `resultados`: fichas de fallos del catálogo del Boletín Judicial (Jurisemia): solo identificación y un resumen breve de Claude, nunca el texto de la resolución. Ver supabase/migrations/0021_jurisprudencia.sql.';

create trigger sello before insert or update on public.juris_pedidos for each row execute function gestor.tg_sello();
create trigger auditar after insert or update or delete on public.juris_pedidos for each row execute function gestor.tg_auditar('id');

-- ───────────────────────── Permisos ─────────────────────────
alter table public.juris_pedidos enable row level security;
create policy solo_miembros on public.juris_pedidos for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));

revoke all on public.juris_pedidos from public, anon, authenticated;
grant select, insert, update, delete on public.juris_pedidos to authenticated;
grant all on public.juris_pedidos to service_role;

do $$
begin
  alter publication supabase_realtime add table public.juris_pedidos;
exception when undefined_object or duplicate_object then null;
end $$;

-- ───────────────────────── Estadísticas ─────────────────────────
create or replace function gestor.sin_estadisticas() returns void
language plpgsql set search_path = ''
as $$
declare r record;
begin
  for r in
    select c.relname, a.attname
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('causas', 'acuerdos', 'plantillas', 'agenda', 'deudores', 'modelos_mensaje',
                         'ajustes_cobranzas', 'consultas_bcra', 'consultas_cheques', 'vehiculos', 'ubicaciones', 'ajustes_prenda', 'casos_refi',
                         'juris_pedidos')
       and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('alter table public.%I alter column %I set statistics 0', r.relname, r.attname);
  end loop;
end $$;
comment on function gestor.sin_estadisticas() is
  'Desactiva las estadísticas del planificador en todas las columnas de las tablas de la app. Volver a llamarla en cada migración que agregue columnas o tablas.';
select gestor.sin_estadisticas();

-- ───────────────────────── Lo que hace Claude ─────────────────────────

-- Toma el próximo pedido y lo deja «buscando», todo junto: dos corridas a la vez nunca toman el mismo.
-- Con p_solo_ahora = true toma solo los que la persona pidió con «Buscar ahora».
create function gestor.juris_tomar(p_solo_ahora boolean default false, p_autor text default 'Claude')
returns table (id uuid, pedido text, filtros jsonb, expte text, ahora boolean)
language plpgsql set search_path = ''
as $$
#variable_conflict use_column
declare v_id uuid;
begin
  perform set_config('gestor.autor', p_autor, true);
  select j.id into v_id from public.juris_pedidos j
   where j.estado = 'pendiente' and (not p_solo_ahora or j.ahora is not null)
   order by (j.ahora is null), j.ahora, j.creado
   limit 1 for update skip locked;
  if v_id is null then return; end if;
  update public.juris_pedidos set estado = 'buscando' where id = v_id;
  return query select j.id, j.pedido, j.filtros, j.expte, (j.ahora is not null) from public.juris_pedidos j where j.id = v_id;
end $$;
comment on function gestor.juris_tomar(boolean, text) is
  'Toma el próximo pedido de jurisprudencia (lo deja «buscando»). Devuelve cero filas si no hay. Un pedido por corrida: nada de búsquedas masivas.';

-- Deja el resultado. Cada ficha: {caratula, resolucion, fecha, tribunal, sumario_leido (true/false), resumen (hasta 600), archivo}.
create function gestor.juris_listo(p_id uuid, p_nota text, p_consultas integer, p_fichas jsonb, p_autor text default 'Claude')
returns text
language plpgsql set search_path = ''
as $$
declare f jsonb; j public.juris_pedidos; v_limpias jsonb := '[]'::jsonb; v_leidos integer := 0;
begin
  perform set_config('gestor.autor', p_autor, true);
  if jsonb_typeof(coalesce(p_fichas, '[]'::jsonb)) <> 'array' then raise exception 'p_fichas tiene que ser una lista'; end if;
  if jsonb_array_length(coalesce(p_fichas, '[]'::jsonb)) > 20 then raise exception 'Hasta 20 fichas por pedido'; end if;
  for f in select * from jsonb_array_elements(coalesce(p_fichas, '[]'::jsonb)) loop
    if jsonb_typeof(f) <> 'object' or coalesce(btrim(f->>'caratula'), '') = '' then raise exception 'Cada ficha necesita carátula'; end if;
    if length(coalesce(f->>'resumen', '')) > 600 then
      raise exception 'El resumen de "%" pasa de 600 caracteres: se guarda un resumen breve, no el texto del fallo', left(f->>'caratula', 40);
    end if;
    v_limpias := v_limpias || jsonb_build_array(jsonb_build_object(
      'caratula', btrim(f->>'caratula'), 'resolucion', coalesce(f->>'resolucion', ''), 'fecha', coalesce(f->>'fecha', ''),
      'tribunal', coalesce(f->>'tribunal', ''), 'sumario_leido', coalesce((f->>'sumario_leido')::boolean, false),
      'resumen', coalesce(btrim(f->>'resumen'), ''), 'archivo', coalesce(f->>'archivo', '')));
    if coalesce((f->>'sumario_leido')::boolean, false) then v_leidos := v_leidos + 1; end if;
  end loop;
  update public.juris_pedidos
     set estado = 'listo', nota = coalesce(btrim(p_nota), ''), consultas = least(greatest(coalesce(p_consultas, 0), 0), 4),
         resultados = v_limpias, resultado = ''
   where id = p_id and estado in ('pendiente', 'buscando') returning * into j;
  if not found then raise exception 'No hay un pedido pendiente o buscando con id %', p_id; end if;
  return format('Pedido "%s": %s fichas (%s con sumario leído).', left(j.pedido, 50), jsonb_array_length(v_limpias), v_leidos);
end $$;

create function gestor.juris_fallido(p_id uuid, p_motivo text, p_autor text default 'Claude')
returns text
language plpgsql set search_path = ''
as $$
declare j public.juris_pedidos;
begin
  if coalesce(btrim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  perform set_config('gestor.autor', p_autor, true);
  update public.juris_pedidos set estado = 'error', resultado = btrim(p_motivo)
   where id = p_id and estado in ('pendiente', 'buscando') returning * into j;
  if not found then raise exception 'No hay un pedido pendiente o buscando con id %', p_id; end if;
  return format('Pedido "%s" quedó con error: %s', left(j.pedido, 50), j.resultado);
end $$;

-- Las funciones nuevas nacen ejecutables por PUBLIC: se les quita, como en 0001.
revoke all on all functions in schema gestor from public, anon, authenticated;

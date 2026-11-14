-- Archivero de conocimientos jurídicos del estudio (CPCC de Córdoba ley 8465, Falcón, Gómez Leo,
-- Busetto, Ley de Prenda, pagaré de consumo, modelos). Lo carga Claude con el conector de Supabase y
-- lo consulta el chat con consultar_archivero / leer_archivero.
--
-- La tabla no tiene políticas de filas ni permisos para anon/authenticated: nadie la lee por la API.
-- Se lee solo con las dos funciones de abajo (SECURITY DEFINER), que exigen ser miembro del gestor.
-- No hay datos de causas ni de personas en ella: es material de consulta.

create table if not exists public.conocimientos (
  id          text primary key,
  fuente      text not null,
  tipo        text not null check (tipo in ('fichas','resumen','texto','articulo','modelos','mapa')),
  titulo      text not null,
  orden       int  not null default 0,
  contenido   text not null,
  tsv         tsvector generated always as (to_tsvector('spanish', coalesce(titulo, '') || ' ' || coalesce(contenido, ''))) stored,
  actualizado timestamptz not null default now()
);
create index if not exists conocimientos_fuente_tipo_idx on public.conocimientos (fuente, tipo, orden);
create index if not exists conocimientos_tsv_idx on public.conocimientos using gin (tsv);

alter table public.conocimientos enable row level security;
revoke all on public.conocimientos from anon, authenticated;

-- Busca por texto (todas las palabras; si no hay nada, cualquiera de ellas). Lo de Córdoba (fuente
-- 'cpcc-cba') pesa más y cada resultado dice su jerarquía: el CPCC de Córdoba rige y lo demás es
-- criterio de fondo.
create or replace function public.buscar_conocimientos(p_texto text, p_fuente text default null, p_limite int default 6)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  q tsquery; q_or tsquery; res jsonb; n int := least(greatest(coalesce(p_limite, 6), 1), 10);
  palabras text;
begin
  if not exists (select 1 from gestor.miembros m where m.user_id = (select auth.uid())) then
    raise exception 'sin acceso' using errcode = '42501';
  end if;
  if coalesce(btrim(p_texto), '') = '' then
    return jsonb_build_object('error', 'Decime qué buscar.');
  end if;
  q := websearch_to_tsquery('spanish', p_texto);
  select string_agg(w, ' | ') into palabras
    from regexp_split_to_table(lower(p_texto), '[^[:alnum:]áéíóúñü]+') w where length(w) > 2;
  q_or := case when palabras is null then null else to_tsquery('spanish', palabras) end;

  for i in 1..2 loop
    select coalesce(jsonb_agg(x order by x.orden_rank desc), '[]'::jsonb) into res from (
      select c.id, c.fuente, c.tipo, c.titulo,
             case when c.fuente = 'cpcc-cba' then 'CÓRDOBA: rige' else 'doctrina/criterio de fondo: no citar artículos de otros códigos' end as jerarquia,
             ts_headline('spanish', c.contenido, case when i = 1 then q else q_or end,
                         'MaxFragments=3, MaxWords=45, MinWords=15, FragmentDelimiter= […] ') as extracto,
             ts_rank(c.tsv, case when i = 1 then q else q_or end) * (case when c.fuente = 'cpcc-cba' then 1.5 else 1 end) as orden_rank
        from public.conocimientos c
       where c.tsv @@ (case when i = 1 then q else q_or end)
         and (p_fuente is null or c.fuente = p_fuente)
       order by orden_rank desc limit n
    ) x;
    exit when jsonb_array_length(res) > 0 or q_or is null;
  end loop;
  return jsonb_build_object('encontrados', jsonb_array_length(res), 'resultados', res);
end $$;

-- Lee un documento del archivero de a tramos (hasta 16000 caracteres por vez).
create or replace function public.leer_conocimiento(p_id text, p_desde int default 1, p_largo int default 12000)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare r record; d int := greatest(coalesce(p_desde, 1), 1); l int := least(greatest(coalesce(p_largo, 12000), 500), 16000);
begin
  if not exists (select 1 from gestor.miembros m where m.user_id = (select auth.uid())) then
    raise exception 'sin acceso' using errcode = '42501';
  end if;
  select id, fuente, titulo, contenido, length(contenido) as total into r from public.conocimientos where id = p_id;
  if not found then return jsonb_build_object('error', 'No existe ese id en el archivero.'); end if;
  return jsonb_build_object('id', r.id, 'fuente', r.fuente, 'titulo', r.titulo, 'total_caracteres', r.total,
    'desde', d, 'hasta', least(d + l - 1, r.total), 'hay_mas', d + l - 1 < r.total,
    'contenido', substr(r.contenido, d, l));
end $$;

revoke all on function public.buscar_conocimientos(text, text, int) from public, anon;
revoke all on function public.leer_conocimiento(text, int, int) from public, anon;
grant execute on function public.buscar_conocimientos(text, text, int) to authenticated;
grant execute on function public.leer_conocimiento(text, int, int) to authenticated;

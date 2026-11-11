-- Se saca el sistema de pedidos de jurisprudencia de la migración 0021: la persona pidió dejar la solapa
-- «Jurisprudencia» sin buscador (botón «Buscar» desactivado) y decidir más adelante cómo tener uno.
-- 0021 queda en el historial porque ya se aplicó; esta migración la deja sin efecto.

drop function if exists gestor.juris_tomar(boolean, text);
drop function if exists gestor.juris_listo(uuid, text, integer, jsonb, text);
drop function if exists gestor.juris_fallido(uuid, text, text);
drop table if exists public.juris_pedidos;

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
                         'ajustes_cobranzas', 'consultas_bcra', 'consultas_cheques', 'vehiculos', 'ubicaciones', 'ajustes_prenda', 'casos_refi')
       and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('alter table public.%I alter column %I set statistics 0', r.relname, r.attname);
  end loop;
end $$;
comment on function gestor.sin_estadisticas() is
  'Desactiva las estadísticas del planificador en todas las columnas de las tablas de la app. Volver a llamarla en cada migración que agregue columnas o tablas.';
select gestor.sin_estadisticas();

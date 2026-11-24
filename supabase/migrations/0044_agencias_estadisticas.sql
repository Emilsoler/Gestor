-- Estadísticas por agencia (pedido de la persona, 23/11/2026): cuántas cotizaciones, solicitudes y
-- aprobaciones tiene cada agencia en un período. SECURITY INVOKER: las tablas ya tienen políticas solo
-- para miembros, así que a una agencia (o a un usuario sin permiso) le devuelve vacío.
create or replace function public.estadisticas_agencias(p_dias int default null) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x.solicitudes desc, x.cotizaciones desc, x.nombre), '[]'::jsonb) from (
    select a.id, a.nombre, a.activa,
      (select count(*) from public.cotizaciones_agencia c
        where c.agencia_id = a.id and (p_dias is null or c.momento >= now() - make_interval(days => p_dias)))::int as cotizaciones,
      (select count(*) from public.solicitudes_credito s
        where s.agencia_id = a.id and s.estado <> 'cargando' and (p_dias is null or s.momento >= now() - make_interval(days => p_dias)))::int as solicitudes,
      (select count(*) from public.solicitudes_credito s
        where s.agencia_id = a.id and s.estado = 'aprobada' and (p_dias is null or s.momento >= now() - make_interval(days => p_dias)))::int as aprobadas,
      (select count(*) from public.solicitudes_credito s
        where s.agencia_id = a.id and s.estado = 'rechazada' and (p_dias is null or s.momento >= now() - make_interval(days => p_dias)))::int as rechazadas,
      (select count(*) from public.solicitudes_credito s
        where s.agencia_id = a.id and s.estado in ('pendiente','en_analisis') and (p_dias is null or s.momento >= now() - make_interval(days => p_dias)))::int as abiertas,
      (select coalesce(sum(s.monto), 0) from public.solicitudes_credito s
        where s.agencia_id = a.id and s.estado = 'aprobada' and (p_dias is null or s.momento >= now() - make_interval(days => p_dias))) as monto_aprobado,
      (select max(c.momento) from public.cotizaciones_agencia c where c.agencia_id = a.id) as ultima_cotizacion
    from public.agencias a
  ) x;
$$;
revoke all on function public.estadisticas_agencias(int) from public, anon;
grant execute on function public.estadisticas_agencias(int) to authenticated;

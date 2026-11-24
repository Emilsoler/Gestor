-- «Mis cotizaciones»: el vendedor puede eliminar de su lista las que no quiere ver (pedido de la persona, 23/11/2026).
-- No se borra la fila: queda `oculta` para que (1) el tope diario de la agencia no se reinicie borrando y (2) la Mutual
-- conserve el registro en Créditos y Cobros → Agencias → Cotizaciones.
alter table public.cotizaciones_agencia add column oculta boolean not null default false;

create or replace function public.agencia_cotizaciones(p_user uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x.momento desc), '[]'::jsonb) from (
    select c.id, c.momento, c.vehiculo, c.anio, c.monto, c.cuotas, c.cuota, c.cuit
      from public.cotizaciones_agencia c
     where c.vendedor_id = public.vendedor_de(p_user) and not c.oculta order by c.momento desc limit 50) x;
$$;

-- p_id null = ocultar todas las del vendedor. Solo toca las suyas.
create function public.agencia_cotizacion_ocultar(p_user uuid, p_id bigint default null) returns integer
language plpgsql security definer set search_path = ''
as $$
declare n integer;
begin
  update public.cotizaciones_agencia c set oculta = true
   where c.vendedor_id = public.vendedor_de(p_user) and not c.oculta and (p_id is null or c.id = p_id);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.agencia_cotizacion_ocultar(uuid, bigint) from public, anon, authenticated;
grant execute on function public.agencia_cotizacion_ocultar(uuid, bigint) to service_role;

select gestor.sin_estadisticas();

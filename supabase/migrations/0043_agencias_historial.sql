-- Historial de cotizaciones del vendedor (Etapa 4, pedido de la persona del 23/11/2026).
-- Cada vendedor ve solo las suyas. Sin valor del vehículo ni CODIA: solo lo que ya guarda cotizaciones_agencia.
create or replace function public.agencia_cotizaciones(p_user uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x.momento desc), '[]'::jsonb) from (
    select c.id, c.momento, c.vehiculo, c.anio, c.monto, c.cuotas, c.cuota, c.cuit
      from public.cotizaciones_agencia c
     where c.vendedor_id = public.vendedor_de(p_user) order by c.momento desc limit 50) x;
$$;
revoke all on function public.agencia_cotizaciones(uuid) from public, anon, authenticated;
grant execute on function public.agencia_cotizaciones(uuid) to service_role;

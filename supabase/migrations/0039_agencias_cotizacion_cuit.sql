-- El CUIT que la agencia consulta para cotizar queda en el registro de cotizaciones (pedido de la persona, 22/11/2026),
-- para verlo en Créditos y Cobros → Agencias → Cotizaciones. Es opcional: las cotizaciones anteriores y las de una versión
-- vieja de la app (que no lo manda) quedan sin CUIT. Sigue sin guardarse el valor del vehículo ni el CODIA.
alter table public.cotizaciones_agencia add column cuit text not null default '';
comment on column public.cotizaciones_agencia.cuit is
  'CUIT o CUIL del cliente que la agencia consultó para cotizar (11 dígitos, validado por la función); vacío si no se informó.';

-- Misma función con un parámetro más. Se borra la anterior para no dejar dos versiones (PostgREST no sabría cuál llamar).
drop function public.agencia_registrar(uuid, text, text, numeric, int, numeric);
create function public.agencia_registrar(p_user uuid, p_vehiculo text, p_anio text, p_monto numeric, p_cuotas int, p_cuota numeric, p_cuit text default '') returns boolean
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; tope int; n int;
begin
  select * into a from public.agencias where user_id = p_user and activa;
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('agencia:' || a.id::text));
  select tope_diario into tope from public.ajustes_agencias where id = 1;
  select count(*) into n from public.cotizaciones_agencia c
   where c.agencia_id = a.id and c.momento >= (gestor.hoy()::timestamp at time zone 'America/Argentina/Cordoba');
  if n >= tope then return false; end if;
  insert into public.cotizaciones_agencia (agencia_id, agencia, vehiculo, anio, monto, cuotas, cuota, cuit)
  values (a.id, a.nombre, left(coalesce(p_vehiculo, ''), 200), left(coalesce(p_anio, ''), 10), p_monto, p_cuotas, p_cuota,
          case when p_cuit ~ '^[0-9]{11}$' then p_cuit else '' end);
  return true;
end $$;

revoke all on function public.agencia_registrar(uuid, text, text, numeric, int, numeric, text) from public, anon, authenticated;
grant execute on function public.agencia_registrar(uuid, text, text, numeric, int, numeric, text) to service_role;

select gestor.sin_estadisticas();

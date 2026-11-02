-- Chat de Claude en la app de cobranzas: puentes hacia las funciones de cobranzas del esquema
-- `gestor`, que la API no expone. Cada una verifica que la cuenta sea miembro y firma "Claude";
-- la lectura y la búsqueda de deudores van por la tabla `public.deudores` (con sus políticas).

create function public.chat_liquidacion_deudor(p_deudor uuid, p_fecha date default null, p_a_vencer boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not coalesce((select public.es_miembro()), false) then
    raise exception 'cuenta no autorizada' using errcode = '42501';
  end if;
  return gestor.liquidacion_deudor(p_deudor, p_fecha, p_a_vencer);
end $$;

create function public.chat_registrar_pago(p_deudor uuid, p_fecha date, p_imp jsonb, p_recibo text default '', p_medio text default '', p_nota text default '', p_plan text default '')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not coalesce((select public.es_miembro()), false) then
    raise exception 'cuenta no autorizada' using errcode = '42501';
  end if;
  return gestor.registrar_pago(p_deudor, p_fecha, p_imp, p_recibo, p_medio, p_nota, p_plan, 'Claude');
end $$;

create function public.chat_anotar_gestion(p_deudor uuid, p_texto text, p_tipo text default 'Nota', p_fecha date default null, p_promesa_fecha date default null, p_promesa_monto numeric default null)
returns text
language plpgsql security definer set search_path = ''
as $$
begin
  if not coalesce((select public.es_miembro()), false) then
    raise exception 'cuenta no autorizada' using errcode = '42501';
  end if;
  return gestor.anotar_gestion(p_deudor, p_texto, p_tipo, p_fecha, p_promesa_fecha, p_promesa_monto, 'Claude');
end $$;

create function public.chat_proxima_deudor(p_deudor uuid, p_texto text, p_vence date default null)
returns text
language plpgsql security definer set search_path = ''
as $$
begin
  if not coalesce((select public.es_miembro()), false) then
    raise exception 'cuenta no autorizada' using errcode = '42501';
  end if;
  return gestor.proxima_deudor(p_deudor, p_texto, p_vence, 'Claude');
end $$;

revoke all on function public.chat_liquidacion_deudor(uuid, date, boolean) from public, anon;
revoke all on function public.chat_registrar_pago(uuid, date, jsonb, text, text, text, text) from public, anon;
revoke all on function public.chat_anotar_gestion(uuid, text, text, date, date, numeric) from public, anon;
revoke all on function public.chat_proxima_deudor(uuid, text, date) from public, anon;
grant execute on function public.chat_liquidacion_deudor(uuid, date, boolean) to authenticated;
grant execute on function public.chat_registrar_pago(uuid, date, jsonb, text, text, text, text) to authenticated;
grant execute on function public.chat_anotar_gestion(uuid, text, text, date, date, numeric) to authenticated;
grant execute on function public.chat_proxima_deudor(uuid, text, date) to authenticated;

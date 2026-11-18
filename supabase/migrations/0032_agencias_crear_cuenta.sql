-- Crear una agencia desde la app (pedido de la persona, 17/11/2026): la función `agencias` (acción `crear_agencia`,
-- solo miembros) crea la cuenta con una clave provisoria al azar y la habilita con esta función. La clave se la muestra
-- a quien la pidió una sola vez y no se guarda en ningún lado; la agencia elige la suya al entrar (clave_temporal).
-- La cuenta de la agencia se crea con la API de administración del login, no por SQL.
create function public.agencia_alta(p_user uuid, p_email text, p_nombre text, p_informada date, p_notas text default '') returns text
language plpgsql security definer set search_path = ''
as $$
declare m gestor.miembros;
begin
  select * into m from gestor.miembros where user_id = p_user;
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  perform set_config('gestor.autor', coalesce(nullif(m.nombre, ''), m.email), true);
  return gestor.autorizar_agencia(p_email, p_nombre, p_informada, p_notas);
end $$;

revoke all on function public.agencia_alta(uuid, text, text, date, text) from public, anon, authenticated;
grant execute on function public.agencia_alta(uuid, text, text, date, text) to service_role;

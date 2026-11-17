-- Los documentos de una solicitud de agencia dejan de ser obligatorios para enviarla (pedido de la persona,
-- 17/11/2026: a veces los documentos le llegan a la Mutual por otra vía). Se siguen pudiendo adjuntar en los
-- mismos casilleros (gestor.docs_requeridos sigue diciendo cuáles admite cada solicitud) y la Mutual ve en
-- Créditos y Cobros → Agencias cuáles quedaron sin adjuntar. Los permisos de la función no cambian.
create or replace function public.agencia_enviar(p_user uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; s public.solicitudes_credito;
begin
  select * into a from public.agencias where user_id = p_user and activa;
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  select * into s from public.solicitudes_credito where id = p_id and agencia_id = a.id for update;
  if not found or s.estado <> 'cargando' then return jsonb_build_object('error', 'solicitud'); end if;
  perform set_config('gestor.autor', 'Agencia · ' || a.nombre, true);
  perform set_config('gestor.solicitud_envio', 'si', true);
  update public.solicitudes_credito set estado = 'pendiente', enviada = now() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.agencia_enviar(uuid, uuid) from public, anon, authenticated;
grant execute on function public.agencia_enviar(uuid, uuid) to service_role;

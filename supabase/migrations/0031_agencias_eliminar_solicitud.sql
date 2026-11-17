-- La Mutual puede eliminar una solicitud de agencia que ya no necesita ver (pedido de la persona, 17/11/2026).
-- La borra la función `agencias` (acción `eliminar`, solo miembros), que con la lista que devuelve esta función borra
-- también los documentos de la carpeta privada `solicitudes`. La fila queda en gestor.cambios (se puede restaurar con
-- gestor.deshacer), pero los documentos no vuelven. Los miembros siguen sin permiso de `delete` por la API.
create function public.solicitud_eliminar(p_user uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare m gestor.miembros; borrar jsonb;
begin
  select * into m from gestor.miembros where user_id = p_user;
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  perform set_config('gestor.autor', coalesce(nullif(m.nombre, ''), m.email), true);
  with x as (delete from public.solicitudes_credito s where s.id = p_id returning s.archivos)
  select coalesce(jsonb_agg(e->>'path'), '[]'::jsonb) into borrar from x cross join lateral jsonb_array_elements(coalesce(x.archivos, '[]'::jsonb)) e;
  return jsonb_build_object('ok', not exists (select 1 from public.solicitudes_credito where id = p_id), 'borrar', borrar);
end $$;

revoke all on function public.solicitud_eliminar(uuid, uuid) from public, anon, authenticated;
grant execute on function public.solicitud_eliminar(uuid, uuid) to service_role;

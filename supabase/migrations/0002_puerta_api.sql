-- Puerta de entrada de la API: antes de atender CUALQUIER pedido, PostgREST llama a esta
-- función. Si quien pide tiene una cuenta pero no está autorizado en gestor.miembros, el
-- pedido se rechaza ahí mismo, antes de planificar o ejecutar ninguna consulta.
--
-- Las políticas de acceso ya impiden que vea o toque filas; esto cierra además los caminos
-- laterales (por ejemplo, los conteos estimados) y no depende de cómo esté configurado el
-- registro de usuarios en el proyecto.
create function public.gestor_puerta() returns void
language plpgsql stable set search_path = ''
as $$
begin
  -- Dos pasos y no un "and": la segunda función solo debe evaluarse para cuentas con sesión
  -- (los pedidos anónimos no tienen permiso para llamarla, y los frena la falta de permisos).
  if (select auth.role()) = 'authenticated' then
    if not public.es_miembro() then
      raise insufficient_privilege using message = 'gestor: cuenta no autorizada';
    end if;
  end if;
end $$;
comment on function public.gestor_puerta() is
  'Filtro previo de la API (pgrst.db_pre_request): rechaza todo pedido de una cuenta que no está en gestor.miembros.';

-- La ejecuta el rol de cada pedido, así que los tres roles de la API tienen que poder llamarla.
revoke all on function public.gestor_puerta() from public;
grant execute on function public.gestor_puerta() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'public.gestor_puerta';
notify pgrst, 'reload config';

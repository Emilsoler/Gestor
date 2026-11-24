-- «Ver precios» (pedido de la persona del 24/11/2026): solo la cuenta de la persona recibe, junto a la cotización, el valor del
-- vehículo (`valor_vehiculo`); no se guarda en ningún lado. Es una marca por agencia, apagada para todas las demás: a las agencias
-- siguen sin llegar precios, valuaciones ni CODIA (licencia de InfoAuto).
alter table public.agencias add column ver_precios boolean not null default false;
comment on column public.agencias.ver_precios is
  'true: el cotizador de esta agencia muestra el valor del vehículo. Solo la cuenta de la persona; las agencias reales nunca.';

-- Igual que en 0047, con la marca nueva.
create or replace function public.agencia_sesion(p_user uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case
    when a.id is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', a.id, 'nombre', a.nombre, 'email', v.email, 'clave_temporal', v.clave_temporal, 'miembro', false,
                                    'simulacion_rapida', a.simulacion_rapida, 'todos_los_anios', a.todos_los_anios, 'ver_precios', a.ver_precios,
                                    'vendedor_id', v.id, 'vendedor', v.nombre, 'titular', v.titular),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', (select count(*) from public.cotizaciones_agencia c where c.agencia_id = a.id and c.momento >= (gestor.hoy()::timestamp at time zone 'America/Argentina/Cordoba')))
    when m.user_id is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', null, 'nombre', 'Vista previa de la Mutual', 'email', m.email, 'clave_temporal', false, 'miembro', true,
                                    'simulacion_rapida', false, 'todos_los_anios', false, 'ver_precios', false),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', 0)
  end
  from (select 1) x
  left join public.agencia_vendedores v on v.user_id = p_user and v.activo
  left join public.agencias a on a.id = v.agencia_id and a.activa
  left join gestor.miembros m on m.user_id = p_user;
$$;

select set_config('gestor.autor', 'Claude', true);
update public.agencias set ver_precios = true where lower(email) = 'emiliano_soler@hotmail.com';

select gestor.sin_estadisticas();

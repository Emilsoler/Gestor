-- «Todos los años» (pedido de la persona del 24/11/2026): la cuenta de la persona puede cotizar vehículos de cualquier año,
-- sin el piso de `anio_minimo` ni el tope de antigüedad. Es una marca por agencia (como `simulacion_rapida`): las demás
-- agencias siguen con los parámetros de la Mutual. Siguen valiendo las reglas de InfoAuto (a la agencia nunca llegan precios,
-- valuaciones ni CODIA); la cuenta de prueba es la de la persona.
alter table public.agencias add column todos_los_anios boolean not null default false;
comment on column public.agencias.todos_los_anios is
  'true: el cotizador de esta agencia no aplica anio_minimo ni antiguedad_max (cualquier año de modelo). Solo la cuenta de la persona.';

-- Igual que en 0042, con la marca nueva.
create or replace function public.agencia_sesion(p_user uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case
    when a.id is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', a.id, 'nombre', a.nombre, 'email', v.email, 'clave_temporal', v.clave_temporal, 'miembro', false,
                                    'simulacion_rapida', a.simulacion_rapida, 'todos_los_anios', a.todos_los_anios,
                                    'vendedor_id', v.id, 'vendedor', v.nombre, 'titular', v.titular),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', (select count(*) from public.cotizaciones_agencia c where c.agencia_id = a.id and c.momento >= (gestor.hoy()::timestamp at time zone 'America/Argentina/Cordoba')))
    when m.user_id is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', null, 'nombre', 'Vista previa de la Mutual', 'email', m.email, 'clave_temporal', false, 'miembro', true,
                                    'simulacion_rapida', false, 'todos_los_anios', false),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', 0)
  end
  from (select 1) x
  left join public.agencia_vendedores v on v.user_id = p_user and v.activo
  left join public.agencias a on a.id = v.agencia_id and a.activa
  left join gestor.miembros m on m.user_id = p_user;
$$;

select set_config('gestor.autor', 'Claude', true);
update public.agencias set todos_los_anios = true where lower(email) = 'emiliano_soler@hotmail.com';

select gestor.sin_estadisticas();

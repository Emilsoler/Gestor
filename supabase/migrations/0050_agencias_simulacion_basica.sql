-- Simulación rápida «básica» (pedido de la persona del 25/11/2026): las agencias con la simulación rápida, salvo las que la persona
-- elija, solo escriben capital y cuotas; la tasa y los gastos no se muestran ni se escriben: salen de los parámetros de la Mutual
-- (gastos) y de `ajustes_agencias.tasa_rapida` (6 % mensual). `agencias.simulacion_completa = true` deja la pantalla de antes
-- (tasa y gastos a mano). La función ignora lo que mande una agencia sin esa marca.
alter table public.agencias add column simulacion_completa boolean not null default false;
comment on column public.agencias.simulacion_completa is
  'true: en la simulación rápida la agencia escribe también la tasa y los gastos. false: solo capital y cuotas (tasa = ajustes_agencias.tasa_rapida y gastos de los parámetros).';

alter table public.ajustes_agencias add column tasa_rapida numeric not null default 6 check (tasa_rapida >= 0 and tasa_rapida <= 50);
comment on column public.ajustes_agencias.tasa_rapida is
  'Tasa mensual (%) de la simulación rápida para las agencias sin `simulacion_completa`.';

-- Igual que en 0048, con la marca nueva.
create or replace function public.agencia_sesion(p_user uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case
    when a.id is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', a.id, 'nombre', a.nombre, 'email', v.email, 'clave_temporal', v.clave_temporal, 'miembro', false,
                                    'simulacion_rapida', a.simulacion_rapida, 'simulacion_completa', a.simulacion_completa,
                                    'todos_los_anios', a.todos_los_anios, 'ver_precios', a.ver_precios,
                                    'vendedor_id', v.id, 'vendedor', v.nombre, 'titular', v.titular),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', (select count(*) from public.cotizaciones_agencia c where c.agencia_id = a.id and c.momento >= (gestor.hoy()::timestamp at time zone 'America/Argentina/Cordoba')))
    when m.user_id is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', null, 'nombre', 'Vista previa de la Mutual', 'email', m.email, 'clave_temporal', false, 'miembro', true,
                                    'simulacion_rapida', false, 'simulacion_completa', false, 'todos_los_anios', false, 'ver_precios', false),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', 0)
  end
  from (select 1) x
  left join public.agencia_vendedores v on v.user_id = p_user and v.activo
  left join public.agencias a on a.id = v.agencia_id and a.activa
  left join gestor.miembros m on m.user_id = p_user;
$$;

-- La cuenta de la persona sigue con la pantalla completa.
select set_config('gestor.autor', 'Claude', true);
update public.agencias set simulacion_completa = true where lower(email) = 'emiliano_soler@hotmail.com';

select gestor.sin_estadisticas();

-- Simulación rápida en el cotizador (pedido de la persona del 19/11/2026): solo para su cuenta de prueba «PROPIO».
-- Capital, cuotas, tasa y gastos escritos a mano, sin CUIT ni vehículo. No toca InfoAuto ni el BCRA, así que la
-- licencia no cambia; igual va con una marca por agencia para que el resto no la vea ni la pueda pedir a la función.
alter table public.agencias add column simulacion_rapida boolean not null default false;
comment on column public.agencias.simulacion_rapida is
  'true: la agencia ve «Simulación rápida» (capital, cuotas, tasa y gastos a mano, sin CUIT ni vehículo). Solo la de prueba de la persona.';

create or replace function public.agencia_sesion(p_user uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case
    when a.id is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', a.id, 'nombre', a.nombre, 'email', a.email, 'clave_temporal', a.clave_temporal, 'miembro', false,
                                    'simulacion_rapida', a.simulacion_rapida),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', (select count(*) from public.cotizaciones_agencia c where c.agencia_id = a.id and c.momento >= (gestor.hoy()::timestamp at time zone 'America/Argentina/Cordoba')))
    when m.user_id is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', null, 'nombre', 'Vista previa de la Mutual', 'email', m.email, 'clave_temporal', false, 'miembro', true,
                                    'simulacion_rapida', false),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', 0)
  end
  from (select 1) x
  left join public.agencias a on a.user_id = p_user and a.activa
  left join gestor.miembros m on m.user_id = p_user;
$$;

select set_config('gestor.autor', 'Claude', true);
update public.agencias set simulacion_rapida = true where lower(email) = 'emiliano_soler@hotmail.com';

select gestor.sin_estadisticas();

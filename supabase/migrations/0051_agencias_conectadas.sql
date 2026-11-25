-- «Agencias conectadas» (pedido de la persona del 25/11/2026): en Créditos y Cobros, un cartel «3 agencias conectadas» (luz verde;
-- roja si no hay ninguna) que al tocarlo muestra quiénes son. Conectada = tiene el cotizador abierto y a la vista ahora mismo.
--
-- Cómo se sabe: el cotizador (docs/agencias) manda un «latido» cada minuto mientras la pestaña está a la vista, y la función
-- `agencias` (acción `latido`) lo anota acá. Una cuenta cuenta como conectada si su último latido tiene menos de 150 segundos
-- (un latido perdido no la apaga; dos sí). Se guarda solo la hora del último latido de cada vendedor: nada de autos, valores ni CODIA.
--
-- Tabla aparte, SIN `sello`, `auditar` ni `rev`: un latido por minuto por vendedor llenaría el historial de cambios (`gestor.cambios`)
-- y nadie necesita deshacer una hora de conexión.

create table public.agencia_presencia (
  vendedor_id uuid primary key references public.agencia_vendedores (id) on delete cascade,
  momento     timestamptz not null default now()
);
comment on table public.agencia_presencia is
  'Último latido del cotizador de cada vendedor (docs/agencias): sirve para saber quién tiene el cotizador abierto ahora. Sin historial a propósito.';

alter table public.agencia_presencia enable row level security;
create policy solo_miembros on public.agencia_presencia for select to authenticated
  using ((select public.es_miembro()));
revoke all on public.agencia_presencia from public, anon, authenticated;
grant select on public.agencia_presencia to authenticated;
grant all on public.agencia_presencia to service_role;

-- La anota la función `agencias` (clave de servicio) con la sesión de quien está usando el cotizador. Una cuenta pausada, o de una
-- agencia pausada, no tiene vendedor (`vendedor_de` da null) y no deja nada.
create function public.agencia_latido(p_user uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare v uuid;
begin
  v := public.vendedor_de(p_user);
  if v is null then return; end if;
  insert into public.agencia_presencia (vendedor_id, momento) values (v, now())
  on conflict (vendedor_id) do update set momento = now();
end $$;
revoke all on function public.agencia_latido(uuid) from public, anon, authenticated;
grant execute on function public.agencia_latido(uuid) to service_role;

-- Lo que lee el panel: cada vendedor activo de cada agencia activa, con su último latido. `conectado` lo decide la base con su
-- propio reloj (no el del celular de nadie). SECURITY INVOKER: solo los miembros ven filas, por las políticas de las tablas.
create function public.agencias_conectadas()
returns table (agencia_id uuid, agencia text, vendedor_id uuid, vendedor text, titular boolean, ultimo timestamptz, hace_seg integer, conectado boolean)
language sql stable security invoker set search_path = ''
as $$
  select a.id, a.nombre, v.id, v.nombre, v.titular, p.momento,
         case when p.momento is null then null else greatest(0, extract(epoch from now() - p.momento))::integer end,
         coalesce(now() - p.momento < interval '150 seconds', false)
    from public.agencia_vendedores v
    join public.agencias a on a.id = v.agencia_id
    left join public.agencia_presencia p on p.vendedor_id = v.id
   where a.activa and v.activo;
$$;
revoke all on function public.agencias_conectadas() from public, anon;
grant execute on function public.agencias_conectadas() to authenticated, service_role;
comment on function public.agencias_conectadas() is
  'Vendedores activos con su último latido; conectado = latido de hace menos de 150 s. Para el cartel «agencias conectadas» de Créditos y Cobros.';

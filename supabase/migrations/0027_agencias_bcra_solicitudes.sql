-- 0027 (aplicada en la base como «0026_agencias_bcra_solicitudes»). Cotizador para agencias, segunda parte (pedido de la persona, 17/11/2026):
--   * Parámetros nuevos: año mínimo del modelo (`anio_minimo`), tasa según el año del modelo (`tasas`) y
--     plazos de 1 a 24 cuotas (el tope de 12 plazos distintos pasa a 120).
--   * La agencia consulta el CUIT del cliente en la Central de Deudores del BCRA (el mismo semáforo que
--     Cobranzas). La consulta queda en public.consultas_bcra, firmada «Agencia · <nombre>», con el detalle
--     completo para la Mutual; a la agencia la función solo le devuelve el color y el nombre.
--   * Solicitudes de aprobación de crédito: con el cliente en verde, la agencia manda la solicitud (agencia,
--     CUIT, resultado del BCRA, vehículo y crédito) y la Mutual la aprueba o la rechaza. Sin valor del
--     vehículo ni CODIA.

-- ───────────────────────── Parámetros ─────────────────────────
alter table public.ajustes_agencias
  add column anio_minimo int check (anio_minimo is null or anio_minimo between 1950 and 2100),
  add column tasas jsonb not null default '[]'::jsonb check (jsonb_typeof(tasas) = 'array' and jsonb_array_length(tasas) <= 20);
comment on column public.ajustes_agencias.anio_minimo is 'Año de modelo más viejo que se financia (null: sin tope).';
comment on column public.ajustes_agencias.tasas is
  'Tasa mensual según el año del modelo: [{"desde": 2021, "tasa": 5}, …]. Vale el tramo de mayor `desde` que no supere el año (el 0 km cuenta como el año en curso). Sin tramo que alcance, `tasa_mensual`.';

do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.ajustes_agencias'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%cardinality(plazos)%' loop
    execute format('alter table public.ajustes_agencias drop constraint %I', c);
  end loop;
end $$;
alter table public.ajustes_agencias add constraint ajustes_agencias_plazos_check
  check (cardinality(plazos) between 1 and 120 and 1 <= all(plazos) and 120 >= all(plazos));

-- ───────────────────────── Solicitudes ─────────────────────────
create table public.solicitudes_credito (
  id              uuid primary key default gen_random_uuid(),
  momento         timestamptz not null default now(),
  agencia_id      uuid not null,
  agencia         text not null,
  cuit            text not null check (cuit ~ '^[0-9]{11}$'),
  denominacion    text not null default '',
  consulta        uuid,                       -- la consulta al BCRA (public.consultas_bcra.id; sin clave foránea)
  semaforo        text not null,
  cliente         text not null default '' check (length(cliente) <= 300),   -- teléfono u otro dato que escribe la agencia
  vehiculo        text not null default '',
  anio            text not null default '',
  monto           numeric not null,
  cuotas          int not null,
  cuota           numeric not null,
  total           numeric not null,
  tasa            numeric not null,
  cft             numeric not null,
  estado          text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada')),
  nota            text not null default '' check (length(nota) <= 1000),
  resuelto        timestamptz,
  resuelto_por    text not null default '',
  rev             bigint not null default 0,
  actualizado     timestamptz not null default now(),
  actualizado_por text not null default ''
);
create index solicitudes_credito_agencia_idx on public.solicitudes_credito (agencia_id, momento desc);
comment on table public.solicitudes_credito is
  'Solicitudes de aprobación de crédito que mandan las agencias desde el cotizador (solo con el BCRA en verde). `consulta`: id de la consulta en consultas_bcra (detalle del BCRA). `estado`: pendiente | aprobada | rechazada, lo decide la Mutual. Sin valor del vehículo ni CODIA.';

-- Quién resolvió y cuándo los pone la base.
create function gestor.tg_solicitud_resuelta() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.estado is distinct from old.estado then
    if new.estado = 'pendiente' then new.resuelto := null; new.resuelto_por := '';
    else new.resuelto := now(); new.resuelto_por := gestor.autor(); end if;
  end if;
  return new;
end $$;
create trigger resuelta before update on public.solicitudes_credito for each row execute function gestor.tg_solicitud_resuelta();
create trigger sello before insert or update on public.solicitudes_credito for each row execute function gestor.tg_sello();
create trigger auditar after insert or update or delete on public.solicitudes_credito for each row execute function gestor.tg_auditar('id');

alter table public.solicitudes_credito enable row level security;
create policy solo_miembros on public.solicitudes_credito for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));
revoke all on public.solicitudes_credito from public, anon, authenticated;
grant select on public.solicitudes_credito to authenticated;
grant update (estado, nota) on public.solicitudes_credito to authenticated;   -- la Mutual solo resuelve
grant all on public.solicitudes_credito to service_role;

-- ───────────────────────── Para la función `agencias` (solo clave de servicio) ─────────────────────────
-- Guarda la consulta al BCRA de una agencia como constancia, con el tope diario. Devuelve {id} o {tope: true}.
create function public.agencia_bcra_guardar(p_user uuid, p_fila jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; tope int; n int; v_id uuid; firma text;
begin
  select * into a from public.agencias where user_id = p_user and activa;
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  firma := 'Agencia · ' || a.nombre;
  perform pg_advisory_xact_lock(hashtext('agencia-bcra:' || a.id::text));
  select tope_diario into tope from public.ajustes_agencias where id = 1;
  select count(*) into n from public.consultas_bcra c
   where c.consultado_por = firma and c.momento >= (gestor.hoy()::timestamp at time zone 'America/Argentina/Cordoba');
  if n >= tope then return jsonb_build_object('tope', true); end if;
  perform set_config('gestor.autor', firma, true);
  insert into public.consultas_bcra (cuit, denominacion, periodo, semaforo, peor_situacion, entidades, deuda_total, cheques, cheques_impagos, motivos, resultado)
  values (p_fila->>'cuit', left(coalesce(p_fila->>'denominacion', ''), 300), coalesce(p_fila->>'periodo', ''), p_fila->>'semaforo',
          coalesce((p_fila->>'peor_situacion')::smallint, 0), coalesce((p_fila->>'entidades')::smallint, 0), coalesce((p_fila->>'deuda_total')::numeric, 0),
          coalesce((p_fila->>'cheques')::smallint, 0), coalesce((p_fila->>'cheques_impagos')::smallint, 0),
          coalesce(p_fila->'motivos', '[]'::jsonb), coalesce(p_fila->'resultado', '{}'::jsonb))
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- Crea la solicitud. Exige una consulta al BCRA de esa misma agencia, de ese CUIT, de los últimos 3 días y en verde.
create function public.agencia_solicitar(p_user uuid, p_consulta uuid, p_datos jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; c public.consultas_bcra; v_id uuid;
begin
  select * into a from public.agencias where user_id = p_user and activa;
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  select * into c from public.consultas_bcra where id = p_consulta and consultado_por = 'Agencia · ' || a.nombre;
  if not found or c.momento < now() - interval '3 days' then return jsonb_build_object('error', 'consulta'); end if;
  if c.semaforo <> 'verde' then return jsonb_build_object('error', 'semaforo'); end if;
  perform pg_advisory_xact_lock(hashtext('agencia-sol:' || a.id::text));
  if exists (select 1 from public.solicitudes_credito s where s.agencia_id = a.id and s.cuit = c.cuit and s.estado = 'pendiente') then
    return jsonb_build_object('error', 'repetida');
  end if;
  perform set_config('gestor.autor', 'Agencia · ' || a.nombre, true);
  insert into public.solicitudes_credito (agencia_id, agencia, cuit, denominacion, consulta, semaforo, cliente, vehiculo, anio, monto, cuotas, cuota, total, tasa, cft)
  values (a.id, a.nombre, c.cuit, c.denominacion, c.id, c.semaforo, left(coalesce(p_datos->>'cliente', ''), 300),
          left(coalesce(p_datos->>'vehiculo', ''), 200), left(coalesce(p_datos->>'anio', ''), 10),
          (p_datos->>'monto')::numeric, (p_datos->>'cuotas')::int, (p_datos->>'cuota')::numeric, (p_datos->>'total')::numeric,
          (p_datos->>'tasa')::numeric, (p_datos->>'cft')::numeric)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- Las solicitudes de la agencia, para que vea en qué quedó cada una.
create function public.agencia_solicitudes(p_user uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x.momento desc), '[]'::jsonb) from (
    select s.id, s.momento, s.cuit, s.denominacion, s.vehiculo, s.anio, s.monto, s.cuotas, s.cuota, s.estado, s.nota, s.resuelto
      from public.solicitudes_credito s join public.agencias a on a.id = s.agencia_id
     where a.user_id = p_user and a.activa order by s.momento desc limit 50) x;
$$;

revoke all on function public.agencia_bcra_guardar(uuid, jsonb), public.agencia_solicitar(uuid, uuid, jsonb), public.agencia_solicitudes(uuid)
  from public, anon, authenticated;
grant execute on function public.agencia_bcra_guardar(uuid, jsonb), public.agencia_solicitar(uuid, uuid, jsonb), public.agencia_solicitudes(uuid)
  to service_role;

-- ───────────────────────── Estadísticas ─────────────────────────
create or replace function gestor.sin_estadisticas() returns void
language plpgsql set search_path = ''
as $$
declare r record;
begin
  for r in
    select c.relname, a.attname
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('causas', 'acuerdos', 'plantillas', 'agenda', 'deudores', 'modelos_mensaje',
                         'ajustes_cobranzas', 'consultas_bcra', 'consultas_cheques', 'vehiculos', 'ubicaciones', 'ajustes_prenda', 'casos_refi',
                         'agencias', 'ajustes_agencias', 'cotizaciones_agencia', 'solicitudes_credito')
       and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('alter table public.%I alter column %I set statistics 0', r.relname, r.attname);
  end loop;
end $$;
select gestor.sin_estadisticas();

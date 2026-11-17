-- Cotizador para agencias y concesionarias (app docs/agencias/, función supabase/functions/agencias/).
--
-- Las agencias que ofrecen los créditos prendarios de la Mutual entran con su usuario y contraseña, eligen
-- marca, modelo, versión y año, y ven SOLO las condiciones del crédito (monto máximo, cuotas, TNA, TEA y CFT).
-- La licencia "Agencias/Concesionarias" de InfoAuto lo permite "sin exposición de descripciones, códigos ni
-- valuaciones InfoAuto" (presupuesto 63.199 del 04/11/2026; la persona eligió mostrar marca, modelo y versión
-- para elegir el auto, a confirmar con InfoAuto). Por eso:
--   * Las agencias NO son miembros del gestor: gestor_puerta les cierra toda la API de la base. Solo hablan
--     con la función `agencias`, que consulta a InfoAuto con la clave de servicio y nunca devuelve el
--     precio ni el CODIA (el auto elegido viaja como una referencia cifrada).
--   * Tope de 20 salones activos (la licencia cubre "tope 20 salones").
--   * Cada agencia necesita la fecha en que se informó por escrito a InfoAuto (la licencia lo exige).
--   * El registro de cotizaciones no guarda precios ni CODIA.
--   * El cotizador arranca deshabilitado: lo habilita la persona después de revisar los parámetros.

-- ───────────────────────── Agencias ─────────────────────────
create table public.agencias (
  id                  uuid primary key default gen_random_uuid(),
  nombre              text not null check (length(btrim(nombre)) between 1 and 120),
  email               text not null unique check (email = lower(btrim(email)) and email like '%@%'),
  user_id             uuid unique,
  activa              boolean not null default true,
  informada_infoauto  date,
  clave_temporal      boolean not null default true,
  notas               text not null default '' check (length(notas) <= 2000),
  creado              timestamptz not null default now(),
  rev                 bigint not null default 0,
  actualizado         timestamptz not null default now(),
  actualizado_por     text not null default ''
);
comment on table public.agencias is
  'Agencias/concesionarias que usan el cotizador (docs/agencias). No son miembros del gestor: solo usan la función `agencias`. `informada_infoauto`: fecha en que se informó a InfoAuto por escrito (obligatoria para estar activa). Tope: 20 activas.';

create function gestor.tg_agencias_reglas() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  if new.activa then
    if new.informada_infoauto is null then
      raise exception 'Para activar la agencia % hace falta la fecha en que se informó por escrito a InfoAuto (lo exige la licencia).', new.nombre
        using errcode = '23514';
    end if;
    if new.informada_infoauto > gestor.hoy() then
      raise exception 'La fecha en que se informó a InfoAuto no puede ser futura.' using errcode = '23514';
    end if;
    select count(*) into n from public.agencias a where a.activa and a.id <> new.id;
    if n >= 20 then
      raise exception 'Ya hay 20 agencias activas: es el tope de la licencia de InfoAuto. Pausá una o consultá con InfoAuto la ampliación.'
        using errcode = '23514';
    end if;
  end if;
  if new.user_id is not null and exists (select 1 from gestor.miembros m where m.user_id = new.user_id) then
    raise exception 'Esa cuenta es de un usuario del gestor: una agencia necesita una cuenta propia.' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger reglas before insert or update on public.agencias for each row execute function gestor.tg_agencias_reglas();
create trigger sello before insert or update on public.agencias for each row execute function gestor.tg_sello();
create trigger auditar after insert or update or delete on public.agencias for each row execute function gestor.tg_auditar('id');

-- ───────────────────────── Parámetros del crédito ─────────────────────────
-- Una sola fila. Los gastos tienen la forma de GASTOS_DEFECTO de docs/cobranzas/vehiculos.js, en números
-- (porcentajes en %, el resto en pesos): el cálculo es el mismo que el simulador interno.
create table public.ajustes_agencias (
  id               int primary key default 1 check (id = 1),
  habilitado       boolean not null default false,
  pct_financiable  numeric not null default 50 check (pct_financiable > 0 and pct_financiable <= 100),
  tasa_mensual     numeric not null default 7 check (tasa_mensual >= 0 and tasa_mensual <= 50),
  plazos           int[] not null default '{12,18,24,36}'
                     check (cardinality(plazos) between 1 and 12 and 1 <= all(plazos) and 120 >= all(plazos)),
  antiguedad_max   int check (antiguedad_max is null or antiguedad_max between 0 and 60),
  monto_minimo     numeric not null default 0 check (monto_minimo >= 0),
  monto_maximo     numeric check (monto_maximo is null or monto_maximo > 0),
  redondeo         numeric not null default 50000 check (redondeo >= 1),
  gastos           jsonb not null default '{"sellado":1.2,"arancel":0.1,"arancelMin":13000,"contratos":20000,"envio":20000,"gestoria":29000,"redondeo":null,"seguro":0.1,"administrativos":50,"cuotaSocial":200,"igr":3}'::jsonb
                     check (jsonb_typeof(gastos) = 'object'),
  tope_diario      int not null default 300 check (tope_diario between 1 and 5000),
  leyenda          text not null default 'Simulación sujeta a aprobación crediticia de la Asociación Mutual Bell. No constituye una oferta. Los importes pueden variar según la fecha de liquidación.'
                     check (length(leyenda) <= 1000),
  contacto         text not null default '' check (length(contacto) <= 300),
  rev              bigint not null default 0,
  actualizado      timestamptz not null default now(),
  actualizado_por  text not null default ''
);
comment on table public.ajustes_agencias is
  'Parámetros del cotizador de agencias (una fila): % del valor que se financia, tasa mensual, plazos, antigüedad máxima (años), montos mínimo y máximo, redondeo hacia abajo del monto máximo, gastos (como el simulador interno), tope diario por agencia y leyenda. `habilitado` = false: las agencias no pueden cotizar.';
insert into public.ajustes_agencias (id) values (1) on conflict do nothing;

create trigger sello before insert or update on public.ajustes_agencias for each row execute function gestor.tg_sello();
create trigger auditar after insert or update or delete on public.ajustes_agencias for each row execute function gestor.tg_auditar('id');

-- ───────────────────────── Registro de cotizaciones ─────────────────────────
-- Una fila por simulación de una agencia (posibles clientes). Sin precio ni CODIA de InfoAuto.
create table public.cotizaciones_agencia (
  id         bigint generated always as identity primary key,
  momento    timestamptz not null default now(),
  agencia_id uuid not null,
  agencia    text not null,
  vehiculo   text not null default '',
  anio       text not null default '',
  monto      numeric not null,
  cuotas     int not null,
  cuota      numeric not null
);
create index cotizaciones_agencia_momento_idx on public.cotizaciones_agencia (agencia_id, momento desc);
comment on table public.cotizaciones_agencia is
  'Simulaciones hechas por las agencias en el cotizador. No guarda el valor del vehículo ni el CODIA.';

-- ───────────────────────── Permisos ─────────────────────────
alter table public.agencias enable row level security;
alter table public.ajustes_agencias enable row level security;
alter table public.cotizaciones_agencia enable row level security;
create policy solo_miembros on public.agencias for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));
create policy solo_miembros on public.ajustes_agencias for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));
create policy solo_miembros on public.cotizaciones_agencia for select to authenticated
  using ((select public.es_miembro()));

revoke all on public.agencias, public.ajustes_agencias, public.cotizaciones_agencia from public, anon, authenticated;
grant select, update on public.agencias to authenticated;       -- las altas, con alta_agencia (busca la cuenta)
grant select, update on public.ajustes_agencias to authenticated;
grant select on public.cotizaciones_agencia to authenticated;
grant all on public.agencias, public.ajustes_agencias, public.cotizaciones_agencia to service_role;

-- ───────────────────────── Altas (la persona y Claude) ─────────────────────────
-- La cuenta (email y contraseña) se crea en el panel de Supabase, como las del gestor. Esto la vincula.
create function gestor.autorizar_agencia(p_email text, p_nombre text, p_informada date, p_notas text default '') returns text
language plpgsql set search_path = ''
as $$
declare v_email text := lower(btrim(p_email)); v_id uuid;
begin
  select id into v_id from auth.users where lower(email) = v_email;
  if v_id is null then
    raise exception 'No existe una cuenta con el email %. Primero hay que crearla en el panel de Supabase (Authentication → Users → Add user, con «Auto Confirm User»).', p_email;
  end if;
  insert into public.agencias (nombre, email, user_id, activa, informada_infoauto, clave_temporal, notas)
  values (btrim(p_nombre), v_email, v_id, true, p_informada, true, coalesce(p_notas, ''))
  on conflict (email) do update
     set nombre = excluded.nombre, user_id = excluded.user_id, activa = true,
         informada_infoauto = excluded.informada_infoauto,
         notas = case when excluded.notas <> '' then excluded.notas else public.agencias.notas end;
  return format('La agencia %s (%s) ya puede usar el cotizador', btrim(p_nombre), v_email);
end $$;
comment on function gestor.autorizar_agencia(text, text, date, text) is
  'Da de alta (o reactiva) una agencia con una cuenta ya creada en el panel de Supabase. p_informada: fecha en que se informó a InfoAuto por escrito.';

create function gestor.pausar_agencia(p_email text) returns text
language plpgsql set search_path = ''
as $$
begin
  update public.agencias set activa = false where email = lower(btrim(p_email));
  if not found then raise exception 'No hay una agencia con el email %', p_email; end if;
  return format('%s ya no puede usar el cotizador', p_email);
end $$;

-- La misma alta desde la app (pantalla de administración de docs/agencias), solo para miembros.
create function public.alta_agencia(p_email text, p_nombre text, p_informada date, p_notas text default '') returns text
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.es_miembro() then raise exception 'sin acceso' using errcode = '42501'; end if;
  perform set_config('gestor.autor', coalesce((select m.nombre from gestor.miembros m where m.user_id = (select auth.uid())), ''), true);
  return gestor.autorizar_agencia(p_email, p_nombre, p_informada, p_notas);
end $$;
revoke all on function public.alta_agencia(text, text, date, text) from public, anon;
grant execute on function public.alta_agencia(text, text, date, text) to authenticated;

-- ───────────────────────── Para la función `agencias` (solo clave de servicio) ─────────────────────────
-- Quién es la agencia de una sesión, y los parámetros. Null si la cuenta no es de una agencia activa.
-- Un miembro del gestor entra como «vista previa» (para probar el cotizador antes de habilitarlo): sus
-- simulaciones no se registran.
create function public.agencia_sesion(p_user uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case
    when a.id is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', a.id, 'nombre', a.nombre, 'email', a.email, 'clave_temporal', a.clave_temporal, 'miembro', false),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', (select count(*) from public.cotizaciones_agencia c where c.agencia_id = a.id and c.momento >= (gestor.hoy()::timestamp at time zone 'America/Argentina/Cordoba')))
    when m.user_id is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', null, 'nombre', 'Vista previa de la Mutual', 'email', m.email, 'clave_temporal', false, 'miembro', true),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', 0)
  end
  from (select 1) x
  left join public.agencias a on a.user_id = p_user and a.activa
  left join gestor.miembros m on m.user_id = p_user;
$$;

-- Registra una simulación, si la agencia no pasó el tope del día. Devuelve false si lo pasó.
create function public.agencia_registrar(p_user uuid, p_vehiculo text, p_anio text, p_monto numeric, p_cuotas int, p_cuota numeric) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; tope int; n int;
begin
  select * into a from public.agencias where user_id = p_user and activa;
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('agencia:' || a.id::text));
  select tope_diario into tope from public.ajustes_agencias where id = 1;
  select count(*) into n from public.cotizaciones_agencia c
   where c.agencia_id = a.id and c.momento >= (gestor.hoy()::timestamp at time zone 'America/Argentina/Cordoba');
  if n >= tope then return false; end if;
  insert into public.cotizaciones_agencia (agencia_id, agencia, vehiculo, anio, monto, cuotas, cuota)
  values (a.id, a.nombre, left(coalesce(p_vehiculo, ''), 200), left(coalesce(p_anio, ''), 10), p_monto, p_cuotas, p_cuota);
  return true;
end $$;

create function public.agencia_clave_definida(p_user uuid) returns void
language sql security definer set search_path = ''
as $$
  update public.agencias set clave_temporal = false where user_id = p_user;
$$;

revoke all on function public.agencia_sesion(uuid), public.agencia_registrar(uuid, text, text, numeric, int, numeric),
  public.agencia_clave_definida(uuid) from public, anon, authenticated;
grant execute on function public.agencia_sesion(uuid), public.agencia_registrar(uuid, text, text, numeric, int, numeric),
  public.agencia_clave_definida(uuid) to service_role;

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
                         'agencias', 'ajustes_agencias', 'cotizaciones_agencia')
       and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('alter table public.%I alter column %I set statistics 0', r.relname, r.attname);
  end loop;
end $$;
select gestor.sin_estadisticas();

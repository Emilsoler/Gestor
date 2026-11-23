-- Vendedores de una agencia (pedido de la persona del 23/11/2026): cada vendedor entra con su propio usuario y contraseña
-- y ve SOLO lo suyo (sus cotizaciones, sus solicitudes y su chat). La persona da el alta de cada vendedor desde
-- Créditos y Cobros → Agencias; el dueño de la agencia no da altas.
--
-- Qué sigue siendo de la agencia (no del vendedor): el tope de 20 agencias de la licencia de InfoAuto, el tope diario de
-- cotizaciones y de consultas al BCRA, y «pausar»: pausar la agencia corta el acceso de todos sus vendedores.
-- La cuenta que ya tenía cada agencia pasa a ser su primer vendedor («titular»), con sus datos y su clave de siempre.
-- `agencias.user_id` y `agencias.email` quedan como la cuenta del titular (así siguen sirviendo `gestor.autorizar_agencia`, etc.).

create table public.agencia_vendedores (
  id              uuid primary key default gen_random_uuid(),
  agencia_id      uuid not null references public.agencias (id) on delete cascade,
  nombre          text not null check (length(btrim(nombre)) between 1 and 120),
  email           text not null unique check (email = lower(btrim(email)) and email like '%@%'),
  user_id         uuid unique,
  activo          boolean not null default true,
  titular         boolean not null default false,
  clave_temporal  boolean not null default true,
  creado          timestamptz not null default now(),
  rev             bigint not null default 0,
  actualizado     timestamptz not null default now(),
  actualizado_por text not null default ''
);
create index agencia_vendedores_agencia_idx on public.agencia_vendedores (agencia_id);
-- Un solo titular por agencia.
create unique index agencia_vendedores_un_titular on public.agencia_vendedores (agencia_id) where titular;
comment on table public.agencia_vendedores is
  'Cuentas de las agencias (docs/agencias): cada vendedor entra con la suya y ve solo lo suyo. `titular`: la cuenta con la que se dio de alta la agencia. Pausar la agencia (agencias.activa) corta a todos; `activo` pausa a uno.';

create function gestor.tg_vendedores_reglas() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.user_id is not null and exists (select 1 from gestor.miembros m where m.user_id = new.user_id) then
    raise exception 'Esa cuenta es de un usuario del gestor: un vendedor necesita una cuenta propia.' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger reglas before insert or update on public.agencia_vendedores for each row execute function gestor.tg_vendedores_reglas();
create trigger sello before insert or update on public.agencia_vendedores for each row execute function gestor.tg_sello();
create trigger auditar after insert or update or delete on public.agencia_vendedores for each row execute function gestor.tg_auditar('id');

alter table public.agencia_vendedores enable row level security;
create policy solo_miembros on public.agencia_vendedores for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));
revoke all on public.agencia_vendedores from public, anon, authenticated;
grant select on public.agencia_vendedores to authenticated;
grant update (activo, nombre) on public.agencia_vendedores to authenticated;   -- las altas, con agencia_vendedor_alta (busca la cuenta)
grant all on public.agencia_vendedores to service_role;

-- La clave provisoria del titular sigue pudiéndose tocar en `agencias` (pruebas, conector): se refleja en su vendedor.
create function gestor.tg_agencias_clave() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.clave_temporal is distinct from old.clave_temporal then
    update public.agencia_vendedores set clave_temporal = new.clave_temporal where agencia_id = new.id and titular;
  end if;
  return new;
end $$;
create trigger clave_titular after update of clave_temporal on public.agencias for each row execute function gestor.tg_agencias_clave();

-- ───────────────────────── Las cuentas que ya existían pasan a ser el titular de su agencia ─────────────────────────
select set_config('gestor.autor', 'Claude', true);
insert into public.agencia_vendedores (agencia_id, nombre, email, user_id, activo, titular, clave_temporal)
select a.id, a.nombre, a.email, a.user_id, true, true, a.clave_temporal from public.agencias a where a.user_id is not null;

-- Lo que ya se hizo queda a nombre del titular. `on delete set null`: un vendedor nunca se borra (se pausa), pero si la agencia se borra
-- también se borran sus cosas por su propia clave foránea.
alter table public.solicitudes_credito add column vendedor_id uuid references public.agencia_vendedores (id) on delete set null;
alter table public.cotizaciones_agencia add column vendedor_id uuid references public.agencia_vendedores (id) on delete set null;
alter table public.chats_agencia add column vendedor_id uuid references public.agencia_vendedores (id) on delete set null;
alter table public.chats_agencia add column vendedor text not null default '';
update public.solicitudes_credito s set vendedor_id = v.id from public.agencia_vendedores v where v.agencia_id = s.agencia_id and v.titular;
update public.cotizaciones_agencia c set vendedor_id = v.id from public.agencia_vendedores v where v.agencia_id = c.agencia_id and v.titular;
update public.chats_agencia c set vendedor_id = v.id, vendedor = v.nombre from public.agencia_vendedores v where v.agencia_id = c.agencia_id and v.titular;
create index solicitudes_credito_vendedor_idx on public.solicitudes_credito (vendedor_id, momento desc);
-- Una conversación abierta por vendedor (antes, por agencia).
drop index public.chats_agencia_una_abierta;
create unique index chats_agencia_una_abierta on public.chats_agencia (vendedor_id) where estado <> 'cerrado';
comment on column public.solicitudes_credito.vendedor_id is 'El vendedor de la agencia que la cargó: cada uno ve solo las suyas.';
comment on column public.cotizaciones_agencia.vendedor_id is 'El vendedor de la agencia que hizo la simulación.';
comment on column public.chats_agencia.vendedor_id is 'El vendedor que habla: cada uno tiene su conversación.';

-- ───────────────────────── Quién es la agencia (y el vendedor) de una sesión ─────────────────────────
create function public.agencia_de(p_user uuid) returns public.agencias
language sql stable security definer set search_path = ''
as $$
  select a.* from public.agencias a join public.agencia_vendedores v on v.agencia_id = a.id
   where v.user_id = p_user and v.activo and a.activa;
$$;
create function public.vendedor_de(p_user uuid) returns uuid
language sql stable security definer set search_path = ''
as $$
  select v.id from public.agencia_vendedores v join public.agencias a on a.id = v.agencia_id
   where v.user_id = p_user and v.activo and a.activa;
$$;
revoke all on function public.agencia_de(uuid), public.vendedor_de(uuid) from public, anon, authenticated;
grant execute on function public.agencia_de(uuid), public.vendedor_de(uuid) to service_role;

-- Igual que en 0036; el vendedor da el email, el nombre y la clave provisoria. «hoy» sigue siendo de toda la agencia (el tope es suyo).
create or replace function public.agencia_sesion(p_user uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case
    when a.id is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', a.id, 'nombre', a.nombre, 'email', v.email, 'clave_temporal', v.clave_temporal, 'miembro', false,
                                    'simulacion_rapida', a.simulacion_rapida, 'vendedor_id', v.id, 'vendedor', v.nombre, 'titular', v.titular),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', (select count(*) from public.cotizaciones_agencia c where c.agencia_id = a.id and c.momento >= (gestor.hoy()::timestamp at time zone 'America/Argentina/Cordoba')))
    when m.user_id is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', null, 'nombre', 'Vista previa de la Mutual', 'email', m.email, 'clave_temporal', false, 'miembro', true,
                                    'simulacion_rapida', false),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', 0)
  end
  from (select 1) x
  left join public.agencia_vendedores v on v.user_id = p_user and v.activo
  left join public.agencias a on a.id = v.agencia_id and a.activa
  left join gestor.miembros m on m.user_id = p_user;
$$;

-- Igual que en 0039; la simulación queda a nombre del vendedor.
create or replace function public.agencia_registrar(p_user uuid, p_vehiculo text, p_anio text, p_monto numeric, p_cuotas int, p_cuota numeric, p_cuit text default '') returns boolean
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; v_vend uuid; tope int; n int;
begin
  select * into a from public.agencia_de(p_user);
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  v_vend := public.vendedor_de(p_user);
  perform pg_advisory_xact_lock(hashtext('agencia:' || a.id::text));
  select tope_diario into tope from public.ajustes_agencias where id = 1;
  select count(*) into n from public.cotizaciones_agencia c
   where c.agencia_id = a.id and c.momento >= (gestor.hoy()::timestamp at time zone 'America/Argentina/Cordoba');
  if n >= tope then return false; end if;
  insert into public.cotizaciones_agencia (agencia_id, vendedor_id, agencia, vehiculo, anio, monto, cuotas, cuota, cuit)
  values (a.id, v_vend, a.nombre, left(coalesce(p_vehiculo, ''), 200), left(coalesce(p_anio, ''), 10), p_monto, p_cuotas, p_cuota,
          case when p_cuit ~ '^[0-9]{11}$' then p_cuit else '' end);
  return true;
end $$;

-- La clave definitiva es del vendedor; si es el titular, también queda en la agencia (como antes).
create or replace function public.agencia_clave_definida(p_user uuid) returns void
language sql security definer set search_path = ''
as $$
  update public.agencia_vendedores set clave_temporal = false where user_id = p_user;
  update public.agencias set clave_temporal = false where user_id = p_user;
$$;

-- Igual que en 0027; solo cambia cómo se encuentra la agencia (la consulta al BCRA queda a nombre de la agencia: su tope es de la agencia).
create or replace function public.agencia_bcra_guardar(p_user uuid, p_fila jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; tope int; n int; v_id uuid; firma text;
begin
  select * into a from public.agencia_de(p_user);
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

-- Igual que en 0041; la solicitud queda a nombre del vendedor. «Repetida» sigue siendo por agencia: no se manda dos veces el mismo cliente.
create or replace function public.agencia_solicitar(p_user uuid, p_consulta uuid, p_datos jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; v_vend uuid; c public.consultas_bcra; maximo numeric; v_rel numeric; v_ingreso numeric; v_id uuid; borrar jsonb;
begin
  select * into a from public.agencia_de(p_user);
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  v_vend := public.vendedor_de(p_user);
  select * into c from public.consultas_bcra where id = p_consulta and consultado_por = 'Agencia · ' || a.nombre;
  if not found or c.momento < now() - interval '3 days' then return jsonb_build_object('error', 'consulta'); end if;
  if c.semaforo not in ('verde', 'amarillo', 'sin_datos') then return jsonb_build_object('error', 'semaforo'); end if;
  v_ingreso := nullif(p_datos->>'ingreso', '')::numeric;
  if v_ingreso is null or v_ingreso <= 0 then return jsonb_build_object('error', 'ingreso'); end if;
  if coalesce(p_datos->>'categoria', '') not in ('dependencia', 'monotributo', 'inscripto') then return jsonb_build_object('error', 'categoria'); end if;
  select relacion_max into maximo from public.ajustes_agencias where id = 1;
  v_rel := round((p_datos->>'cuota')::numeric / v_ingreso * 100, 2);
  if v_rel > maximo then return jsonb_build_object('error', 'relacion'); end if;

  perform pg_advisory_xact_lock(hashtext('agencia-sol:' || a.id::text));
  if exists (select 1 from public.solicitudes_credito s where s.agencia_id = a.id and s.cuit = c.cuit and s.estado in ('pendiente', 'en_analisis')) then
    return jsonb_build_object('error', 'repetida');
  end if;
  perform set_config('gestor.autor', 'Agencia · ' || a.nombre, true);
  -- Las que quedaron a medio cargar: las de este vendedor para ese cliente, o cualquiera de hace más de 2 días.
  with x as (
    delete from public.solicitudes_credito s
     where s.agencia_id = a.id and s.estado = 'cargando'
       and ((s.cuit = c.cuit and s.vendedor_id is not distinct from v_vend) or s.momento < now() - interval '2 days')
    returning s.archivos)
  select coalesce(jsonb_agg(e->>'path'), '[]'::jsonb) into borrar from x cross join lateral jsonb_array_elements(x.archivos) e;

  insert into public.solicitudes_credito (agencia_id, vendedor_id, agencia, cuit, denominacion, consulta, semaforo, cliente, vehiculo, anio, monto, cuotas,
                                          cuota, total, tasa, cft, estado, ingreso, relacion, categoria, datos)
  values (a.id, v_vend, a.nombre, c.cuit, c.denominacion, c.id, c.semaforo, left(coalesce(p_datos->>'cliente', ''), 300),
          left(coalesce(p_datos->>'vehiculo', ''), 200), left(coalesce(p_datos->>'anio', ''), 10),
          (p_datos->>'monto')::numeric, (p_datos->>'cuotas')::int, (p_datos->>'cuota')::numeric, (p_datos->>'total')::numeric,
          (p_datos->>'tasa')::numeric, (p_datos->>'cft')::numeric, 'cargando', v_ingreso, v_rel, p_datos->>'categoria',
          coalesce(p_datos->'datos', '{}'::jsonb))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'borrar', borrar);
end $$;

-- Igual que en 0029; solo el vendedor que cargó la solicitud le agrega archivos.
create or replace function public.agencia_archivo(p_user uuid, p_id uuid, p_archivo jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; v_vend uuid; s public.solicitudes_credito; v_slot text := p_archivo->>'slot'; n int; n_slot int;
begin
  select * into a from public.agencia_de(p_user);
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  v_vend := public.vendedor_de(p_user);
  select * into s from public.solicitudes_credito where id = p_id and agencia_id = a.id and vendedor_id is not distinct from v_vend for update;
  if not found or s.estado <> 'cargando' then return jsonb_build_object('error', 'solicitud'); end if;
  if v_slot is null or not (v_slot = any (gestor.docs_requeridos(s.categoria, s.anio))) then
    return jsonb_build_object('error', 'slot');
  end if;
  if left(coalesce(p_archivo->>'path', ''), 37) <> p_id::text || '/' then return jsonb_build_object('error', 'path'); end if;
  select count(*), count(*) filter (where e->>'slot' = v_slot) into n, n_slot from jsonb_array_elements(s.archivos) e;
  if n >= 40 or n_slot >= gestor.docs_maximo(v_slot) then return jsonb_build_object('error', 'cantidad'); end if;
  perform set_config('gestor.autor', 'Agencia · ' || a.nombre, true);
  update public.solicitudes_credito
     set archivos = archivos || jsonb_build_array(jsonb_build_object(
           'slot', v_slot, 'nombre', left(coalesce(p_archivo->>'nombre', ''), 120), 'path', p_archivo->>'path',
           'tipo', p_archivo->>'tipo', 'tamano', (p_archivo->>'tamano')::bigint, 'sha256', p_archivo->>'sha256', 'subido', now()))
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Igual que en 0030; solo el vendedor que la cargó la envía.
create or replace function public.agencia_enviar(p_user uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; v_vend uuid; s public.solicitudes_credito;
begin
  select * into a from public.agencia_de(p_user);
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  v_vend := public.vendedor_de(p_user);
  select * into s from public.solicitudes_credito where id = p_id and agencia_id = a.id and vendedor_id is not distinct from v_vend for update;
  if not found or s.estado <> 'cargando' then return jsonb_build_object('error', 'solicitud'); end if;
  perform set_config('gestor.autor', 'Agencia · ' || a.nombre, true);
  perform set_config('gestor.solicitud_envio', 'si', true);
  update public.solicitudes_credito set estado = 'pendiente', enviada = now() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Igual que en 0028; cada vendedor ve solo las suyas.
create or replace function public.agencia_solicitudes(p_user uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x.momento desc), '[]'::jsonb) from (
    select s.id, coalesce(s.enviada, s.momento) as momento, s.cuit, s.denominacion, s.semaforo, s.vehiculo, s.anio, s.monto, s.cuotas, s.cuota,
           s.estado, s.nota, s.resuelto
      from public.solicitudes_credito s
     where s.vendedor_id = public.vendedor_de(p_user) and s.estado <> 'cargando' order by s.momento desc limit 50) x;
$$;

revoke all on function public.agencia_sesion(uuid), public.agencia_registrar(uuid, text, text, numeric, int, numeric, text),
  public.agencia_clave_definida(uuid), public.agencia_bcra_guardar(uuid, jsonb), public.agencia_solicitar(uuid, uuid, jsonb),
  public.agencia_archivo(uuid, uuid, jsonb), public.agencia_enviar(uuid, uuid), public.agencia_solicitudes(uuid) from public, anon, authenticated;
grant execute on function public.agencia_sesion(uuid), public.agencia_registrar(uuid, text, text, numeric, int, numeric, text),
  public.agencia_clave_definida(uuid), public.agencia_bcra_guardar(uuid, jsonb), public.agencia_solicitar(uuid, uuid, jsonb),
  public.agencia_archivo(uuid, uuid, jsonb), public.agencia_enviar(uuid, uuid), public.agencia_solicitudes(uuid) to service_role;

-- ───────────────────────── Altas (la persona y Claude) ─────────────────────────
-- Alta de una agencia: además de la fila de la agencia, su cuenta queda como el titular (el primer vendedor).
create or replace function gestor.autorizar_agencia(p_email text, p_nombre text, p_informada date, p_notas text default '') returns text
language plpgsql set search_path = ''
as $$
declare v_email text := lower(btrim(p_email)); v_id uuid; v_ag uuid;
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
         notas = case when excluded.notas <> '' then excluded.notas else public.agencias.notas end
  returning id into v_ag;
  insert into public.agencia_vendedores (agencia_id, nombre, email, user_id, activo, titular, clave_temporal)
  values (v_ag, btrim(p_nombre), v_email, v_id, true, true, true)
  on conflict (email) do update set agencia_id = excluded.agencia_id, user_id = excluded.user_id, activo = true;
  return format('La agencia %s (%s) ya puede usar el cotizador', btrim(p_nombre), v_email);
end $$;

-- Alta de un vendedor de una agencia que ya existe, con una cuenta ya creada (panel de Supabase o la función `agencias`).
create function gestor.autorizar_vendedor(p_agencia_email text, p_email text, p_nombre text) returns text
language plpgsql set search_path = ''
as $$
declare v_email text := lower(btrim(p_email)); v_user uuid; v_ag public.agencias;
begin
  select * into v_ag from public.agencias where email = lower(btrim(p_agencia_email));
  if not found then raise exception 'No hay una agencia con el email %', p_agencia_email; end if;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is null then
    raise exception 'No existe una cuenta con el email %. Primero hay que crearla (Authentication → Users → Add user, con «Auto Confirm User»).', p_email;
  end if;
  if btrim(coalesce(p_nombre, '')) = '' then raise exception 'Falta el nombre del vendedor.'; end if;
  insert into public.agencia_vendedores (agencia_id, nombre, email, user_id, activo, titular, clave_temporal)
  values (v_ag.id, btrim(p_nombre), v_email, v_user, true, false, true)
  on conflict (email) do update set nombre = excluded.nombre, user_id = excluded.user_id, activo = true
   where public.agencia_vendedores.agencia_id = v_ag.id;
  if not found then raise exception 'Ese email ya es de un vendedor de otra agencia.'; end if;
  return format('%s ya puede usar el cotizador de %s', v_email, v_ag.nombre);
end $$;

create function gestor.pausar_vendedor(p_email text) returns text
language plpgsql set search_path = ''
as $$
begin
  update public.agencia_vendedores set activo = false where email = lower(btrim(p_email));
  if not found then raise exception 'No hay un vendedor con el email %', p_email; end if;
  return format('%s ya no puede usar el cotizador', p_email);
end $$;

-- La misma alta desde la función `agencias` (acción `crear_vendedor`, solo miembros). p_user es el miembro que la pide.
create function public.agencia_vendedor_alta(p_user uuid, p_agencia uuid, p_email text, p_nombre text) returns text
language plpgsql security definer set search_path = ''
as $$
declare m gestor.miembros; v_ag public.agencias;
begin
  select * into m from gestor.miembros where user_id = p_user;
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  select * into v_ag from public.agencias where id = p_agencia;
  if not found then raise exception 'Esa agencia ya no existe.' using errcode = '22023'; end if;
  perform set_config('gestor.autor', coalesce(nullif(m.nombre, ''), m.email), true);
  return gestor.autorizar_vendedor(v_ag.email, p_email, p_nombre);
end $$;
revoke all on function public.agencia_vendedor_alta(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.agencia_vendedor_alta(uuid, uuid, text, text) to service_role;

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
                         'agencias', 'ajustes_agencias', 'cotizaciones_agencia', 'solicitudes_credito', 'descuentos_cheques',
                         'chats_agencia', 'mensajes_agencia', 'avisos_push', 'push_claves', 'agencia_vendedores')
       and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('alter table public.%I alter column %I set statistics 0', r.relname, r.attname);
  end loop;
end $$;
select gestor.sin_estadisticas();

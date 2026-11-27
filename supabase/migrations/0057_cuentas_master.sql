-- Cuentas «solo panel máster» y venta de mostrador (pedido de la persona del 27/11/2026).
--
-- Una cuenta máster (gestor.masters) administra el cotizador desde docs/agencias/master/ y NADA MÁS: no es miembro del
-- gestor, así que causas, cobranzas, prenda y el resto siguen cerrados para ella por las mismas barreras de siempre.
-- `es_miembro()` y `mi_acceso()` no cambian (las otras apps y funciones siguen preguntando por ellas). Lo que se abre
-- es explícito y corto: la puerta de la API le deja pasar solo los pedidos del panel (lista de abajo) y, aparte, solo las
-- tablas del cotizador tienen una política que la incluye. Las dos barreras la frenan cada una por su cuenta.
--
-- Venta de mostrador: la persona va a la Mutual sin pasar por una agencia. Desde el panel se consulta el BCRA, se arma el
-- crédito y se aprueba ahí mismo (public.mostrador_aprobar): queda en solicitudes_credito como «Mutual Bell · mostrador».
-- Sin instrucciones destructivas: las políticas se cambian con `alter policy`.

-- ───────────────────────── Quiénes ─────────────────────────
create table gestor.masters (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  email          text not null unique,
  nombre         text not null check (length(btrim(nombre)) between 1 and 80),
  clave_temporal boolean not null default true,
  creado         timestamptz not null default now()
);
alter table gestor.masters enable row level security;
comment on table gestor.masters is
  'Cuentas que usan SOLO el panel máster del cotizador. No son miembros del gestor. Se administran con gestor.autorizar_master y gestor.quitar_master.';

create function public.es_master() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from gestor.masters m where m.user_id = (select auth.uid())); $$;

create function public.es_panel() returns boolean
language sql stable security definer set search_path = ''
as $$ select public.es_miembro() or public.es_master(); $$;
comment on function public.es_panel() is 'Quien puede administrar el cotizador: un miembro del gestor o una cuenta máster. Solo la usan las tablas del cotizador.';

-- El nombre con que firma quien está usando el panel (lo necesita la política de las consultas al BCRA).
create function public.panel_nombre() returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce((select coalesce(nullif(m.nombre, ''), m.email) from gestor.miembros m where m.user_id = (select auth.uid())),
                  (select m.nombre from gestor.masters m where m.user_id = (select auth.uid())));
$$;

create function public.panel_acceso() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('autorizado', true, 'miembro', true, 'clave_temporal', m.clave_temporal, 'nombre', m.nombre, 'email', m.email)
       from gestor.miembros m where m.user_id = (select auth.uid())),
    (select jsonb_build_object('autorizado', true, 'miembro', false, 'clave_temporal', m.clave_temporal, 'nombre', m.nombre, 'email', m.email)
       from gestor.masters m where m.user_id = (select auth.uid())),
    jsonb_build_object('autorizado', false));
$$;
comment on function public.panel_acceso() is 'Como mi_acceso, para el panel máster y lo que él usa (funciones bcra, leer-documentos y mostrador).';

revoke all on function public.es_master(), public.es_panel(), public.panel_nombre(), public.panel_acceso() from public, anon;
grant execute on function public.es_master(), public.es_panel(), public.panel_nombre(), public.panel_acceso() to authenticated, service_role;

create or replace function public.clave_definida() returns void
language sql security definer set search_path = ''
as $$
  update gestor.miembros set clave_temporal = false where user_id = (select auth.uid());
  update gestor.masters set clave_temporal = false where user_id = (select auth.uid());
$$;

-- Igual que en 0005, sumando las cuentas máster para que lo que cambien quede firmado con su nombre.
create or replace function gestor.autor() returns text
language plpgsql stable security definer set search_path = ''
as $$
declare v text;
begin
  v := nullif(current_setting('gestor.autor', true), '');
  if v is not null then return v; end if;
  if (select auth.uid()) is not null then
    if coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-gestor-via', '') = 'chat' then
      return 'Claude';
    end if;
    v := public.panel_nombre();
    return coalesce(v, (select auth.jwt()) ->> 'email', 'usuario');
  end if;
  return 'SQL directo';
end $$;

-- ───────────────────────── La puerta de la API ─────────────────────────
-- Un miembro pasa como siempre. Una cuenta máster pasa SOLO con estos pedidos (método y ruta exactos); cualquier otro,
-- incluidos mi_acceso y las tablas del gestor, se rechaza igual que a una cuenta sin autorización.
create or replace function public.gestor_puerta() returns void
language plpgsql stable set search_path = ''
as $$
begin
  if (select auth.role()) = 'authenticated' then
    if not public.es_miembro() then
      if not (public.es_master() and (coalesce(current_setting('request.method', true), '') || ' ' || coalesce(current_setting('request.path', true), '')) = any (array[
        'POST /rpc/panel_acceso', 'POST /rpc/clave_definida', 'POST /rpc/alta_agencia', 'POST /rpc/mostrador_aprobar',
        'POST /rpc/agencias_conectadas', 'POST /rpc/estadisticas_agencias',
        'GET /ajustes_agencias', 'PATCH /ajustes_agencias',
        'GET /agencias', 'PATCH /agencias',
        'GET /agencia_vendedores', 'PATCH /agencia_vendedores',
        'GET /cotizaciones_agencia', 'HEAD /cotizaciones_agencia', 'DELETE /cotizaciones_agencia',
        'GET /solicitudes_credito', 'HEAD /solicitudes_credito', 'PATCH /solicitudes_credito',
        'GET /consultas_bcra', 'POST /consultas_bcra'
      ])) then
        raise insufficient_privilege using message = 'gestor: cuenta no autorizada';
      end if;
    end if;
  end if;
end $$;

-- ───────────────────────── Políticas: solo las tablas del cotizador ─────────────────────────
alter policy solo_miembros on public.ajustes_agencias using ((select public.es_panel())) with check ((select public.es_panel()));
alter policy solo_miembros on public.agencias using ((select public.es_panel())) with check ((select public.es_panel()));
alter policy solo_miembros on public.agencia_vendedores using ((select public.es_panel())) with check ((select public.es_panel()));
alter policy solo_miembros on public.solicitudes_credito using ((select public.es_panel())) with check ((select public.es_panel()));
alter policy solo_miembros on public.cotizaciones_agencia using ((select public.es_panel()));
alter policy miembros_eliminan on public.cotizaciones_agencia using ((select public.es_panel()));
alter policy solo_miembros on public.agencia_presencia using ((select public.es_panel()));

-- Consultas al BCRA: la política de miembros no cambia. Una cuenta máster puede guardar consultas y ver solo las suyas y
-- las que respaldan una solicitud de crédito: nunca el resto (que incluye las de Cobranzas).
create policy master_lee on public.consultas_bcra for select to authenticated
  using ((select public.es_master()) and (consultado_por = (select public.panel_nombre())
         or id in (select s.consulta from public.solicitudes_credito s where s.consulta is not null)));
create policy master_agrega on public.consultas_bcra for insert to authenticated
  with check ((select public.es_master()));

-- ───────────────────────── Una cuenta máster no puede ser agencia ni vendedor ─────────────────────────
create or replace function gestor.tg_agencias_reglas() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  if new.activa then
    if new.informada_infoauto > gestor.hoy() then
      raise exception 'La fecha en que se informó a InfoAuto no puede ser futura.' using errcode = '23514';
    end if;
    select count(*) into n from public.agencias a where a.activa and a.id <> new.id;
    if n >= 20 then
      raise exception 'Ya hay 20 agencias activas: es el tope de la licencia de InfoAuto. Pausá una o consultá con InfoAuto la ampliación.'
        using errcode = '23514';
    end if;
  end if;
  if new.user_id is not null and exists (select 1 from gestor.miembros m where m.user_id = new.user_id
                                         union all select 1 from gestor.masters x where x.user_id = new.user_id) then
    raise exception 'Esa cuenta es de un usuario del gestor: una agencia necesita una cuenta propia.' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function gestor.tg_vendedores_reglas() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.user_id is not null and exists (select 1 from gestor.miembros m where m.user_id = new.user_id
                                         union all select 1 from gestor.masters x where x.user_id = new.user_id) then
    raise exception 'Esa cuenta es de un usuario del gestor: un vendedor necesita una cuenta propia.' using errcode = '23514';
  end if;
  return new;
end $$;

-- ───────────────────────── Altas y bajas (por el conector) ─────────────────────────
create function gestor.autorizar_master(p_email text, p_nombre text, p_clave_temporal boolean default true) returns text
language plpgsql set search_path = ''
as $$
declare v_email text := lower(btrim(p_email)); v_nombre text := btrim(coalesce(p_nombre, '')); v_id uuid;
begin
  select u.id into v_id from auth.users u where lower(u.email) = v_email;
  if v_id is null then raise exception 'No hay una cuenta con el email %. Primero hay que crearla en el panel de Supabase.', v_email; end if;
  if exists (select 1 from gestor.miembros m where m.user_id = v_id) then raise exception '% ya es usuario del gestor: ya puede usar el panel.', v_email; end if;
  if exists (select 1 from public.agencias a where a.user_id = v_id) or exists (select 1 from public.agencia_vendedores v where v.user_id = v_id) then
    raise exception '% es una cuenta de agencia: la cuenta máster necesita otro email.', v_email;
  end if;
  if v_nombre = '' or exists (select 1 from gestor.miembros m where lower(m.nombre) = lower(v_nombre))
     or exists (select 1 from gestor.masters x where lower(x.nombre) = lower(v_nombre) and x.user_id <> v_id) then
    raise exception 'Falta un nombre propio, distinto del de los demás usuarios.';
  end if;
  insert into gestor.masters (user_id, email, nombre, clave_temporal) values (v_id, v_email, v_nombre, p_clave_temporal)
  on conflict (user_id) do update set email = excluded.email, nombre = excluded.nombre, clave_temporal = excluded.clave_temporal;
  return format('%s ya puede usar el panel máster (solo el panel)', v_email);
end $$;

create function gestor.quitar_master(p_email text) returns text
language plpgsql set search_path = ''
as $$
declare v_id uuid;
begin
  select user_id into v_id from gestor.masters where email = lower(btrim(p_email));
  if v_id is null then raise exception 'No hay una cuenta máster con el email %', p_email; end if;
  delete from public.avisos_push where user_id = v_id;
  delete from gestor.masters where user_id = v_id;
  return format('%s ya no puede usar el panel máster', p_email);
end $$;

-- ───────────────────────── Las funciones del cotizador que preguntaban «¿es miembro?» ─────────────────────────
create function gestor.persona_panel(p_user uuid) returns table (nombre text, email text)
language sql stable set search_path = ''
as $$
  select coalesce(nullif(m.nombre, ''), m.email), m.email from gestor.miembros m where m.user_id = p_user
  union all
  select x.nombre, x.email from gestor.masters x where x.user_id = p_user
  limit 1;
$$;

create or replace function public.alta_agencia(p_email text, p_nombre text, p_informada date, p_notas text default '') returns text
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.es_panel() then raise exception 'sin acceso' using errcode = '42501'; end if;
  perform set_config('gestor.autor', coalesce(public.panel_nombre(), ''), true);
  return gestor.autorizar_agencia(p_email, p_nombre, p_informada, p_notas);
end $$;

create or replace function public.agencia_alta(p_user uuid, p_email text, p_nombre text, p_informada date, p_notas text default '') returns text
language plpgsql security definer set search_path = ''
as $$
declare v text;
begin
  select p.nombre into v from gestor.persona_panel(p_user) p;
  if v is null then raise exception 'sin acceso' using errcode = '42501'; end if;
  perform set_config('gestor.autor', v, true);
  return gestor.autorizar_agencia(p_email, p_nombre, p_informada, p_notas);
end $$;

create or replace function public.agencia_vendedor_alta(p_user uuid, p_agencia uuid, p_email text, p_nombre text) returns text
language plpgsql security definer set search_path = ''
as $$
declare v text; v_ag public.agencias;
begin
  select p.nombre into v from gestor.persona_panel(p_user) p;
  if v is null then raise exception 'sin acceso' using errcode = '42501'; end if;
  select * into v_ag from public.agencias where id = p_agencia;
  if not found then raise exception 'Esa agencia ya no existe.' using errcode = '22023'; end if;
  perform set_config('gestor.autor', v, true);
  return gestor.autorizar_vendedor(v_ag.email, p_email, p_nombre);
end $$;

create or replace function public.solicitud_eliminar(p_user uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v text; borrar jsonb;
begin
  select p.nombre into v from gestor.persona_panel(p_user) p;
  if v is null then raise exception 'sin acceso' using errcode = '42501'; end if;
  perform set_config('gestor.autor', v, true);
  with x as (delete from public.solicitudes_credito s where s.id = p_id returning s.archivos)
  select coalesce(jsonb_agg(e->>'path'), '[]'::jsonb) into borrar from x cross join lateral jsonb_array_elements(coalesce(x.archivos, '[]'::jsonb)) e;
  return jsonb_build_object('ok', not exists (select 1 from public.solicitudes_credito where id = p_id), 'borrar', borrar);
end $$;

-- Igual que en 0050: quien administra puede ser miembro o máster, y en su sesión se ve el valor del vehículo (es la
-- Mutual, no una agencia: lo necesita para el mostrador). A las agencias les sigue llegando solo lo de siempre.
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
    when m.email is not null then jsonb_build_object(
      'agencia', jsonb_build_object('id', null, 'nombre', 'Vista previa de la Mutual', 'email', m.email, 'clave_temporal', false, 'miembro', true,
                                    'simulacion_rapida', false, 'simulacion_completa', false, 'todos_los_anios', false, 'ver_precios', true),
      'ajustes', (select to_jsonb(j) - 'rev' - 'actualizado' - 'actualizado_por' from public.ajustes_agencias j where j.id = 1),
      'hoy', 0)
  end
  from (select 1) x
  left join public.agencia_vendedores v on v.user_id = p_user and v.activo
  left join public.agencias a on a.id = v.agencia_id and a.activa
  left join lateral gestor.persona_panel(p_user) m on true;
$$;

-- ───────────────────────── Venta de mostrador ─────────────────────────
-- La solicitud nace aprobada. `agencia_id` es el identificador fijo del mostrador (no es ninguna agencia). El BCRA sale de
-- la constancia guardada, no de lo que mande el navegador; quién aprobó y cuándo los pone la base.
create function public.mostrador_aprobar(p jsonb) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v text; c public.consultas_bcra; v_id uuid; v_cuit text := coalesce(p->>'cuit', '');
  v_monto numeric := (p->>'monto')::numeric; v_cuotas int := (p->>'cuotas')::int; v_cuota numeric := (p->>'cuota')::numeric;
  v_total numeric := (p->>'total')::numeric; v_tasa numeric := (p->>'tasa')::numeric; v_datos jsonb := p->'datos';
begin
  if not public.es_panel() then raise exception 'sin acceso' using errcode = '42501'; end if;
  v := public.panel_nombre();
  select * into c from public.consultas_bcra where id = (p->>'consulta')::uuid;
  if not found or c.cuit <> v_cuit or c.momento < now() - interval '3 days' then
    raise exception 'La consulta al BCRA de este cliente venció: consultá el CUIT de nuevo.' using errcode = '22023';
  end if;
  if not (coalesce(v_monto, 0) > 0 and v_cuotas between 1 and 120 and coalesce(v_cuota, 0) > 0 and coalesce(v_total, 0) > 0 and v_tasa between 0 and 100) then
    raise exception 'Faltan datos del crédito.' using errcode = '22023';
  end if;
  if v_datos is null or jsonb_typeof(v_datos) <> 'object' or length(v_datos::text) > 8000 then
    raise exception 'Faltan los datos del cliente.' using errcode = '22023';
  end if;
  if exists (select 1 from public.solicitudes_credito s where s.agencia_id = '00000000-0000-0000-0000-000000000000' and s.cuit = v_cuit
             and s.monto = v_monto and s.cuotas = v_cuotas and s.momento > now() - interval '2 minutes') then
    raise exception 'Ese crédito ya se aprobó recién: miralo en Solicitudes.' using errcode = '22023';
  end if;
  perform set_config('gestor.autor', v, true);
  insert into public.solicitudes_credito (agencia_id, agencia, cuit, denominacion, consulta, semaforo, cliente, vehiculo, anio,
                                          monto, cuotas, cuota, total, tasa, cft, estado, nota, resuelto, resuelto_por, datos, enviada)
  values ('00000000-0000-0000-0000-000000000000', 'Mutual Bell · mostrador', v_cuit, left(c.denominacion, 300), c.id, c.semaforo,
          left(coalesce(v_datos->>'celular', ''), 300), left(coalesce(p->>'vehiculo', ''), 200), left(coalesce(p->>'anio', ''), 10),
          v_monto, v_cuotas, v_cuota, v_total, v_tasa, 0, 'aprobada', left(coalesce(p->>'nota', ''), 1000), now(), v, v_datos, now())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.mostrador_aprobar(jsonb) from public, anon;
grant execute on function public.mostrador_aprobar(jsonb) to authenticated;

-- Los documentos (opcionales) los sube la función `mostrador`, con la clave de servicio.
create function public.mostrador_archivo(p_user uuid, p_id uuid, p_archivo jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v text; n int;
begin
  select p.nombre into v from gestor.persona_panel(p_user) p;
  if v is null then raise exception 'sin acceso' using errcode = '42501'; end if;
  perform set_config('gestor.autor', v, true);
  update public.solicitudes_credito s set archivos = s.archivos || jsonb_build_array(p_archivo || jsonb_build_object('subido', now()))
   where s.id = p_id and s.agencia_id = '00000000-0000-0000-0000-000000000000' and jsonb_array_length(s.archivos) < 40;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n = 1);
end $$;
revoke all on function public.mostrador_archivo(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.mostrador_archivo(uuid, uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
select gestor.sin_estadisticas();

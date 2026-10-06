-- Gestor de juicios — Estudio Soler
-- Tablas, permisos, historial de cambios y funciones de apoyo.
--
-- Esquema `public`: lo que usa la app por la API (causas, acuerdos, plantillas).
-- Esquema `gestor`: privado, no se expone por la API. Usuarios autorizados,
--                   historial de cambios y funciones que usa Claude por el conector.
--
-- En el proyecto real se aplicó en partes (gestor_esquema, gestor_01_miembros … gestor_06_deshacer),
-- con el mismo contenido y en este orden.

create schema if not exists gestor;
revoke all on schema gestor from public;

-- ───────────────────────── Usuarios autorizados ─────────────────────────

create table gestor.miembros (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  email          text not null,
  nombre         text not null default '',
  clave_temporal boolean not null default true,
  creado         timestamptz not null default now()
);
alter table gestor.miembros enable row level security;
comment on table gestor.miembros is
  'Quién puede usar el gestor. Tener una cuenta no alcanza: sin fila acá, la API no devuelve ni acepta nada. Se administra con gestor.autorizar y gestor.quitar_usuario.';

create function public.es_miembro() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from gestor.miembros m where m.user_id = (select auth.uid()));
$$;
comment on function public.es_miembro() is 'Verdadero si quien llama es un usuario autorizado del gestor. La usan las políticas de acceso.';

create function public.mi_acceso() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('autorizado', true, 'clave_temporal', m.clave_temporal,
                               'nombre', m.nombre, 'email', m.email)
       from gestor.miembros m where m.user_id = (select auth.uid())),
    jsonb_build_object('autorizado', false));
$$;
comment on function public.mi_acceso() is 'Lo que la app necesita saber de quien inició sesión: si está autorizado y si todavía tiene la clave temporal.';

create function public.clave_definida() returns void
language sql security definer set search_path = ''
as $$
  update gestor.miembros set clave_temporal = false where user_id = (select auth.uid());
$$;
comment on function public.clave_definida() is 'La app la llama después de que el usuario reemplaza su clave temporal.';

revoke all on function public.es_miembro(), public.mi_acceso(), public.clave_definida() from public, anon;
grant execute on function public.es_miembro(), public.mi_acceso(), public.clave_definida() to authenticated, service_role;

-- ───────────────────────── Autoría e historial de cambios ─────────────────────────

create function gestor.hoy() returns date
language sql stable set search_path = ''
as $$ select (now() at time zone 'America/Argentina/Cordoba')::date $$;

-- Quién está haciendo el cambio: el usuario de la app, o lo que se haya indicado
-- con set_config('gestor.autor', ...) cuando el cambio entra por SQL (Claude).
create function gestor.autor() returns text
language plpgsql stable security definer set search_path = ''
as $$
declare v text;
begin
  v := nullif(current_setting('gestor.autor', true), '');
  if v is not null then return v; end if;
  if (select auth.uid()) is not null then
    select coalesce(nullif(m.nombre, ''), m.email) into v
      from gestor.miembros m where m.user_id = (select auth.uid());
    return coalesce(v, (select auth.jwt()) ->> 'email', 'usuario');
  end if;
  return 'SQL directo';
end $$;

create table gestor.cambios (
  id        bigint generated always as identity primary key,
  momento   timestamptz not null default now(),
  autor     text not null,
  tabla     text not null,
  clave     text not null,
  operacion text not null check (operacion in ('alta', 'cambio', 'baja')),
  antes     jsonb,
  despues   jsonb
);
create index cambios_por_registro on gestor.cambios (tabla, clave, momento desc);
alter table gestor.cambios enable row level security;
comment on table gestor.cambios is
  'Historial de todo cambio en causas, acuerdos y plantillas, con el estado anterior y el posterior. Sirve para ver quién cambió qué y para deshacer.';

-- Las revisiones salen de un contador único para toda la base: un número nunca se repite,
-- ni siquiera si una causa se elimina y se vuelve a crear con el mismo expediente. Así, quien
-- tenía abierta la versión anterior no puede pisar la nueva creyendo que es la misma.
create sequence gestor.revisiones;

-- Antes de guardar: número de revisión, fecha y autor.
create function gestor.tg_sello() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'rev' - 'actualizado' - 'actualizado_por')
       = (to_jsonb(old) - 'rev' - 'actualizado' - 'actualizado_por') then
    new.rev := old.rev; new.actualizado := old.actualizado; new.actualizado_por := old.actualizado_por;
    return new;                         -- guardar sin cambios no cuenta como modificación
  end if;
  new.rev := nextval('gestor.revisiones');
  new.actualizado := now();
  new.actualizado_por := gestor.autor();
  return new;
end $$;

-- Después de guardar: deja constancia en gestor.cambios. tg_argv[0] = columna clave.
create function gestor.tg_auditar() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    insert into gestor.cambios (autor, tabla, clave, operacion, antes)
    values (gestor.autor(), tg_table_name, to_jsonb(old) ->> tg_argv[0], 'baja', to_jsonb(old));
    return old;
  elsif tg_op = 'UPDATE' then
    if new.rev = old.rev then return new; end if;
    insert into gestor.cambios (autor, tabla, clave, operacion, antes, despues)
    values (new.actualizado_por, tg_table_name, to_jsonb(new) ->> tg_argv[0], 'cambio', to_jsonb(old), to_jsonb(new));
    return new;
  else
    insert into gestor.cambios (autor, tabla, clave, operacion, despues)
    values (new.actualizado_por, tg_table_name, to_jsonb(new) ->> tg_argv[0], 'alta', to_jsonb(new));
    return new;
  end if;
end $$;

-- ───────────────────────── Datos del gestor ─────────────────────────

create table public.causas (
  expte          text primary key check (expte ~ '^[0-9]+$'),
  actor          text not null default '',
  demandado      text not null default '',
  tipo           text not null default '',
  nom            text not null default '',
  oficina        text not null default '',
  estado         text not null default '',
  etiquetas      text[] not null default '{}',
  proxima        text not null default '',
  vence          date,
  ultima         text not null default '',
  fecha          date,
  notas          text not null default '',
  historial      jsonb not null default '[]'::jsonb check (jsonb_typeof(historial) = 'array'),
  liquidacion    jsonb check (liquidacion is null or jsonb_typeof(liquidacion) = 'object'),
  rev            bigint not null default 0,
  actualizado    timestamptz not null default now(),
  actualizado_por text not null default ''
);
comment on table public.causas is
  'Una fila por juicio; la clave es el N° de expediente del SAC. `ultima` y `fecha` son la última acción y su fecha; `proxima` y `vence`, lo que hay que hacer y para cuándo. `historial` es un array de {fecha:"AAAA-MM-DD", texto, hecha?}. `liquidacion` es {fecha, embargo, rubros:[{rubro, monto, pagado}]} o null. Para anotar movimientos usar gestor.movimiento / gestor.presentacion.';

create table public.acuerdos (
  id             uuid primary key default gen_random_uuid(),
  deudor         text not null default '',
  expte          text not null default '',
  notas          text not null default '',
  cuotas         jsonb not null default '[]'::jsonb check (jsonb_typeof(cuotas) = 'array'),
  creado         date not null default (now() at time zone 'America/Argentina/Cordoba')::date,
  rev            bigint not null default 0,
  actualizado    timestamptz not null default now(),
  actualizado_por text not null default ''
);
comment on table public.acuerdos is
  'Planes de pago. `expte` vincula (opcionalmente) con una causa. `cuotas` es un array de {vence:"AAAA-MM-DD", monto, estado:"pendiente"|"pagada"|"impaga", pago:"AAAA-MM-DD"|""}.';

create table public.plantillas (
  id             text primary key default gen_random_uuid()::text,
  titulo         text not null,
  cuerpo         text not null,
  rev            bigint not null default 0,
  actualizado    timestamptz not null default now(),
  actualizado_por text not null default ''
);
comment on table public.plantillas is
  'Plantillas de escritos. En título y cuerpo se pueden usar {{caratula}}, {{expediente}}, {{actor}}, {{demandado}}, {{tipo}}, {{nominacion}} y {{oficina}}.';

create trigger sello before insert or update on public.causas     for each row execute function gestor.tg_sello();
create trigger sello before insert or update on public.acuerdos   for each row execute function gestor.tg_sello();
create trigger sello before insert or update on public.plantillas for each row execute function gestor.tg_sello();
create trigger auditar after insert or update or delete on public.causas     for each row execute function gestor.tg_auditar('expte');
create trigger auditar after insert or update or delete on public.acuerdos   for each row execute function gestor.tg_auditar('id');
create trigger auditar after insert or update or delete on public.plantillas for each row execute function gestor.tg_auditar('id');

-- Postgres guarda estadísticas de cada columna (valores más frecuentes, histogramas) para
-- planificar consultas, y la API deja pedir el conteo "estimado" de una consulta, que sale de
-- esas estadísticas sin pasar por las políticas de acceso. Con eso, alguien con una cuenta
-- pero sin autorización podría ir adivinando contenido. Estas tablas son chicas y no las
-- necesitan: se desactivan en todas sus columnas, y las estimaciones dejan de depender de los datos.
create function gestor.sin_estadisticas() returns void
language plpgsql set search_path = ''
as $$
declare r record;
begin
  for r in
    select c.relname, a.attname
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname in ('causas', 'acuerdos', 'plantillas')
       and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('alter table public.%I alter column %I set statistics 0', r.relname, r.attname);
  end loop;
end $$;
comment on function gestor.sin_estadisticas() is
  'Desactiva las estadísticas del planificador en todas las columnas de causas, acuerdos y plantillas. Volver a llamarla en cada migración que agregue columnas.';
select gestor.sin_estadisticas();

-- ───────────────────────── Permisos ─────────────────────────
-- Solo usuarios con sesión iniciada Y autorizados en gestor.miembros.

alter table public.causas     enable row level security;
alter table public.acuerdos   enable row level security;
alter table public.plantillas enable row level security;

create policy solo_miembros on public.causas for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));
create policy solo_miembros on public.acuerdos for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));
create policy solo_miembros on public.plantillas for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));

-- Los permisos se dan uno por uno (los proyectos nuevos de Supabase ya no los dan solos).
revoke all on public.causas, public.acuerdos, public.plantillas from public, anon, authenticated;
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.causas, public.acuerdos, public.plantillas to authenticated;
grant all on public.causas, public.acuerdos, public.plantillas to service_role;

-- Avisos en vivo a la app cuando cambia algo (por ejemplo, cuando actualiza Claude).
do $$
begin
  alter publication supabase_realtime add table public.causas, public.acuerdos, public.plantillas;
exception when undefined_object or duplicate_object then null;
end $$;

-- ───────────────────────── Funciones para Claude (por el conector) ─────────────────────────

create function gestor.estados_base() returns text[]
language sql immutable set search_path = ''
as $$ select array['Iniciar','Notificando','Casillero','A despacho','Sentencia','Tramites p/ subasta','Acuerdo','Archivada'] $$;

-- La última acción es el movimiento de fecha más reciente; a igual fecha, el anotado después.
create function gestor.ultima_de(h jsonb, out ultima text, out fecha date)
language sql immutable set search_path = ''
as $$
  select coalesce((select e.v ->> 'texto' from jsonb_array_elements(h) with ordinality e(v, n)
                    order by coalesce(e.v ->> 'fecha', '') desc, e.n desc limit 1), ''),
         (select nullif(e.v ->> 'fecha', '')::date from jsonb_array_elements(h) with ordinality e(v, n)
           order by coalesce(e.v ->> 'fecha', '') desc, e.n desc limit 1);
$$;

create function gestor.validar_estado(p_estado text) returns void
language plpgsql stable set search_path = ''
as $$
begin
  if p_estado is null then return; end if;
  if p_estado = any (gestor.estados_base()) or exists (select 1 from public.causas where estado = p_estado) then return; end if;
  raise exception 'Estado desconocido: "%". Los estados del gestor son: %', p_estado, array_to_string(gestor.estados_base(), ', ');
end $$;

-- Anota un movimiento en la causa (y opcionalmente cambia el estado).
create function gestor.movimiento(p_expte text, p_texto text, p_fecha date default null,
                                  p_estado text default null, p_autor text default 'Claude')
returns public.causas
language plpgsql set search_path = ''
as $$
declare c public.causas; h jsonb; u record;
begin
  perform set_config('gestor.autor', p_autor, true);
  if coalesce(btrim(p_texto), '') = '' then raise exception 'Falta el texto del movimiento'; end if;
  perform gestor.validar_estado(p_estado);
  select * into c from public.causas where expte = p_expte for update;
  if not found then raise exception 'No existe la causa con expediente %', p_expte; end if;
  h := c.historial || jsonb_build_array(jsonb_build_object(
         'fecha', to_char(coalesce(p_fecha, gestor.hoy()), 'YYYY-MM-DD'), 'texto', btrim(p_texto)));
  select * into u from gestor.ultima_de(h);
  update public.causas set historial = h, ultima = u.ultima, fecha = u.fecha, estado = coalesce(p_estado, estado)
   where expte = p_expte returning * into c;
  return c;
end $$;
comment on function gestor.movimiento(text, text, date, text, text) is
  'Agrega un movimiento al historial de la causa y actualiza última acción y fecha. p_fecha por defecto: hoy (hora de Córdoba). p_estado opcional.';

-- Presentación en el SAC: movimiento + la causa pasa a despacho.
create function gestor.presentacion(p_expte text, p_texto text, p_fecha date default null, p_autor text default 'Claude')
returns public.causas
language sql set search_path = ''
as $$ select gestor.movimiento(p_expte, p_texto, p_fecha, 'A despacho', p_autor) $$;
comment on function gestor.presentacion(text, text, date, text) is
  'Regla del estudio: cada presentación en el SAC deja el expediente "A despacho". Anota el movimiento y cambia el estado.';

-- Fija (o borra, con texto vacío) la próxima acción y su vencimiento.
create function gestor.proxima(p_expte text, p_texto text, p_vence date default null, p_autor text default 'Claude')
returns public.causas
language plpgsql set search_path = ''
as $$
declare c public.causas;
begin
  perform set_config('gestor.autor', p_autor, true);
  update public.causas
     set proxima = coalesce(btrim(p_texto), ''),
         vence = case when coalesce(btrim(p_texto), '') = '' then null else p_vence end
   where expte = p_expte returning * into c;
  if not found then raise exception 'No existe la causa con expediente %', p_expte; end if;
  return c;
end $$;

-- Marca como realizada la próxima acción (igual que el botón "✓ Realizada" de la app).
create function gestor.realizada(p_expte text, p_autor text default 'Claude')
returns public.causas
language plpgsql set search_path = ''
as $$
declare c public.causas; h jsonb; u record;
begin
  perform set_config('gestor.autor', p_autor, true);
  select * into c from public.causas where expte = p_expte for update;
  if not found then raise exception 'No existe la causa con expediente %', p_expte; end if;
  if btrim(c.proxima) = '' then raise exception 'La causa % no tiene próxima acción anotada', p_expte; end if;
  -- Queda con la fecha en que vencía; si todavía no venció (se hizo antes), con la de hoy:
  -- un movimiento con fecha futura taparía la causa en "sin movimiento" y en "última acción".
  h := c.historial || jsonb_build_array(jsonb_build_object(
         'fecha', to_char(least(coalesce(c.vence, gestor.hoy()), gestor.hoy()), 'YYYY-MM-DD'),
         'texto', btrim(c.proxima), 'hecha', true));
  select * into u from gestor.ultima_de(h);
  update public.causas set historial = h, ultima = u.ultima, fecha = u.fecha, proxima = '', vence = null
   where expte = p_expte returning * into c;
  return c;
end $$;

-- ───────────────────────── Usuarios ─────────────────────────
-- Las cuentas (email y contraseña) las maneja el servicio de login de Supabase y se crean desde
-- su panel (Authentication → Users → Add user). Acá solo se decide cuáles de esas cuentas pueden
-- usar el gestor. Ninguna función de este esquema escribe en las tablas de `auth`.

-- Autoriza a una cuenta que ya existe. Con p_clave_temporal, la app le hace elegir una
-- contraseña nueva la próxima vez que entre (para cuando la cuenta se creó con una provisoria).
create function gestor.autorizar(p_email text, p_nombre text default '', p_clave_temporal boolean default false) returns text
language plpgsql set search_path = ''
as $$
declare v_email text := lower(btrim(p_email)); v_id uuid;
begin
  select id into v_id from auth.users where lower(email) = v_email;
  if v_id is null then
    raise exception 'No existe una cuenta con el email %. Primero hay que crearla en el panel de Supabase (Authentication → Users → Add user).', p_email;
  end if;
  insert into gestor.miembros (user_id, email, nombre, clave_temporal)
  values (v_id, v_email, coalesce(btrim(p_nombre), ''), p_clave_temporal)
  on conflict (user_id) do update
     set email = excluded.email,
         clave_temporal = excluded.clave_temporal,
         nombre = case when excluded.nombre <> '' then excluded.nombre else gestor.miembros.nombre end;
  return format('%s ya puede usar el gestor', v_email);
end $$;
comment on function gestor.autorizar(text, text, boolean) is
  'Habilita a una cuenta existente (creada en el panel de Supabase) a usar el gestor.';

-- Le quita el acceso en el acto. La cuenta sigue existiendo en el panel de Supabase, sin poder ver nada.
create function gestor.quitar_usuario(p_email text) returns text
language plpgsql set search_path = ''
as $$
declare v_email text := lower(btrim(p_email));
begin
  delete from gestor.miembros where email = v_email;
  if not found then raise exception 'No hay un usuario autorizado con el email %', p_email; end if;
  return format('%s ya no puede usar el gestor', v_email);
end $$;
comment on function gestor.quitar_usuario(text) is
  'Quita el acceso al gestor. No borra la cuenta: eso se hace en el panel de Supabase.';

create view gestor.usuarios with (security_invoker = true) as
  select m.email, m.nombre, m.clave_temporal, m.creado, u.last_sign_in_at as ultimo_ingreso
    from gestor.miembros m join auth.users u on u.id = m.user_id;

-- ───────────────────────── Deshacer ─────────────────────────

-- Vuelve un registro a como estaba ANTES del cambio indicado (id de gestor.cambios): deshace
-- una modificación o recupera algo eliminado. Restaura el registro entero. Si después de ese
-- cambio hubo otros sobre el mismo registro, también los pisaría: en ese caso no hace nada
-- salvo que se pida con p_forzar => true.
-- Nunca elimina: deshacer un alta es borrar un registro, y eso se hace aparte y a propósito.
create function gestor.deshacer(p_cambio bigint, p_forzar boolean default false, p_autor text default 'Claude') returns text
language plpgsql set search_path = ''
as $$
declare c gestor.cambios; posteriores integer;
begin
  perform set_config('gestor.autor', p_autor, true);
  select * into c from gestor.cambios where id = p_cambio;
  if not found then raise exception 'No existe el cambio %', p_cambio; end if;
  select count(*) into posteriores from gestor.cambios where tabla = c.tabla and clave = c.clave and id > c.id;
  if posteriores > 0 and not p_forzar then
    raise exception 'Después del cambio % hubo % cambio(s) más en % %. Deshacerlo también los pisa: revisalos en gestor.cambios y, si corresponde, repetí con p_forzar => true.',
      p_cambio, posteriores, c.tabla, c.clave;
  end if;

  if c.operacion = 'alta' then
    raise exception 'El cambio % es el alta de % %. Deshacerla sería eliminar el registro, y esta función no elimina nada.',
      p_cambio, c.tabla, c.clave;
  end if;

  if c.tabla = 'causas' then
    insert into public.causas (expte, actor, demandado, tipo, nom, oficina, estado, etiquetas, proxima, vence, ultima, fecha, notas, historial, liquidacion)
    select r.expte, r.actor, r.demandado, r.tipo, r.nom, r.oficina, r.estado, r.etiquetas, r.proxima, r.vence, r.ultima, r.fecha, r.notas, r.historial, nullif(r.liquidacion, 'null'::jsonb)
      from jsonb_populate_record(null::public.causas, c.antes) r
    on conflict (expte) do update set
      actor = excluded.actor, demandado = excluded.demandado, tipo = excluded.tipo, nom = excluded.nom, oficina = excluded.oficina,
      estado = excluded.estado, etiquetas = excluded.etiquetas, proxima = excluded.proxima, vence = excluded.vence, ultima = excluded.ultima,
      fecha = excluded.fecha, notas = excluded.notas, historial = excluded.historial, liquidacion = excluded.liquidacion;
  elsif c.tabla = 'acuerdos' then
    insert into public.acuerdos (id, deudor, expte, notas, cuotas, creado)
    select r.id, r.deudor, r.expte, r.notas, r.cuotas, r.creado from jsonb_populate_record(null::public.acuerdos, c.antes) r
    on conflict (id) do update set
      deudor = excluded.deudor, expte = excluded.expte, notas = excluded.notas, cuotas = excluded.cuotas, creado = excluded.creado;
  elsif c.tabla = 'plantillas' then
    insert into public.plantillas (id, titulo, cuerpo)
    select r.id, r.titulo, r.cuerpo from jsonb_populate_record(null::public.plantillas, c.antes) r
    on conflict (id) do update set titulo = excluded.titulo, cuerpo = excluded.cuerpo;
  else
    raise exception 'No sé deshacer cambios de la tabla %', c.tabla;
  end if;
  return format('%s %s volvió a como estaba antes del cambio %s (%s, %s)', c.tabla, c.clave, c.id, c.autor,
                to_char(c.momento at time zone 'America/Argentina/Cordoba', 'DD/MM HH24:MI'));
end $$;
comment on function gestor.deshacer(bigint, boolean, text) is
  'Deshace una modificación o una baja registrada en gestor.cambios: restaura el registro entero al estado anterior. Si hubo cambios posteriores sobre el mismo registro exige p_forzar => true. No deshace altas (nunca elimina).';

-- Nada del esquema privado es alcanzable por los roles de la API. La barrera que vale es que
-- no tienen USAGE sobre el esquema (ver arriba): NO darles nunca `grant usage on schema gestor`.
-- Las funciones nuevas de Postgres nacen ejecutables por PUBLIC, así que además se les quita
-- acá a las que existen; una migración que agregue funciones a `gestor` tiene que repetir estas líneas.
revoke all on all tables in schema gestor from public, anon, authenticated;
revoke all on all sequences in schema gestor from public, anon, authenticated;
revoke all on all functions in schema gestor from public, anon, authenticated;

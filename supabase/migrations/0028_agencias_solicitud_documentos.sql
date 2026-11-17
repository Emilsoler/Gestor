-- Cotizador para agencias, tercera parte (pedido de la persona, 17/11/2026):
--   * Semáforo para la agencia: verde «Continuar»; amarillo y sin antecedentes «Continuar – Sujeto a revisión»;
--     rojo «No apto» (no se puede solicitar).
--   * La solicitud se arma en pasos: ingresos demostrables (si no tiene, no avanza), ingreso mensual (la cuota no
--     puede pasar el `relacion_max` % del ingreso: 45 %), cómo obtiene los ingresos (relación de dependencia,
--     monotributo o responsable inscripto) con su documentación, y los datos del cliente con la suya (DNI, título
--     del automotor, domicilio, CBU).
--   * Los archivos (PDF o JPEG) van a la carpeta privada `solicitudes` del almacenamiento. No tiene políticas:
--     solo la usa la función `agencias`, con la clave de servicio (para subirlos y para darle a la Mutual enlaces
--     que vencen a los 15 minutos).
--   * Mientras la agencia sube los archivos la solicitud está «cargando» y no se le muestra a nadie; al terminar
--     pasa a «pendiente». Las que quedan a medio cargar se descartan (con sus archivos) cuando la misma agencia
--     vuelve a armar una para ese cliente, o a los 2 días.

-- ───────────────────────── Parámetro ─────────────────────────
alter table public.ajustes_agencias
  add column relacion_max numeric not null default 45 check (relacion_max > 0 and relacion_max <= 100);
comment on column public.ajustes_agencias.relacion_max is 'Tope de la relación cuota/ingreso mensual, en %. Por encima, la agencia no puede seguir con la solicitud.';

-- ───────────────────────── Solicitudes ─────────────────────────
alter table public.solicitudes_credito
  add column ingreso   numeric check (ingreso is null or ingreso > 0),
  add column relacion  numeric,
  add column categoria text check (categoria is null or categoria in ('dependencia', 'monotributo', 'inscripto')),
  add column datos     jsonb not null default '{}'::jsonb check (jsonb_typeof(datos) = 'object'),
  add column archivos  jsonb not null default '[]'::jsonb check (jsonb_typeof(archivos) = 'array'),
  add column enviada   timestamptz;
comment on column public.solicitudes_credito.ingreso is 'Ingreso mensual aproximado que declaró la agencia, en pesos.';
comment on column public.solicitudes_credito.relacion is 'Cuota / ingreso, en %.';
comment on column public.solicitudes_credito.datos is
  'Datos del cliente: {dni, domicilio, estado_civil: soltero|casado, matrimonio_lugar, matrimonio_fecha, celular, cbu}.';
comment on column public.solicitudes_credito.archivos is
  'Documentos: [{slot, nombre, path, tipo, tamano, sha256, subido}]. `path` dentro de la carpeta `solicitudes` del almacenamiento; `slot` es el casillero (recibos, constancia, pagos, iva, ganancias, dni, titulo, servicio, cbu).';
comment on column public.solicitudes_credito.enviada is 'Cuándo la agencia terminó de subir todo y la mandó.';

update public.solicitudes_credito set enviada = momento where enviada is null;

do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.solicitudes_credito'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%pendiente%' loop
    execute format('alter table public.solicitudes_credito drop constraint %I', c);
  end loop;
end $$;
alter table public.solicitudes_credito add constraint solicitudes_credito_estado_check
  check (estado in ('cargando', 'pendiente', 'aprobada', 'rechazada'));

-- «cargando» lo maneja solo la función de las agencias; la Mutual resuelve las que ya llegaron.
create or replace function gestor.tg_solicitud_resuelta() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.estado is distinct from old.estado and 'cargando' in (old.estado, new.estado)
     and coalesce(current_setting('gestor.solicitud_envio', true), '') <> 'si' then
    raise exception 'Esa solicitud todavía la está cargando la agencia.' using errcode = '22023';
  end if;
  if new.estado is distinct from old.estado then
    if new.estado in ('pendiente', 'cargando') then new.resuelto := null; new.resuelto_por := '';
    else new.resuelto := now(); new.resuelto_por := gestor.autor(); end if;
  end if;
  return new;
end $$;

-- Los casilleros de documentos. Espejo de docsRequeridos en docs/agencias/solicitud.js (las pruebas los comparan).
create function gestor.docs_requeridos(p_categoria text, p_anio text) returns text[]
language sql immutable set search_path = ''
as $$
  select case p_categoria when 'dependencia' then array['recibos'] when 'monotributo' then array['constancia', 'pagos']
                          when 'inscripto' then array['constancia', 'iva', 'ganancias'] else array[]::text[] end
      || array['dni'] || case when p_anio = '0km' then array[]::text[] else array['titulo'] end || array['servicio', 'cbu'];
$$;

create function gestor.docs_maximo(p_slot text) returns int
language sql immutable set search_path = ''
as $$
  select case p_slot when 'recibos' then 6 when 'constancia' then 2 when 'pagos' then 6 when 'iva' then 12 when 'ganancias' then 3
                     when 'dni' then 2 when 'titulo' then 4 when 'servicio' then 2 when 'cbu' then 2 else 0 end;
$$;

-- ───────────────────────── Para la función `agencias` (solo clave de servicio) ─────────────────────────
-- Crea la solicitud «cargando». Exige una consulta al BCRA de esa agencia y ese cliente, de los últimos 3 días y
-- que no esté en rojo, y repite el control de la relación cuota/ingreso (la función ya lo hizo). Devuelve
-- {id, borrar: [paths]} con los archivos de las que quedaron a medio cargar, para que la función los borre.
create or replace function public.agencia_solicitar(p_user uuid, p_consulta uuid, p_datos jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; c public.consultas_bcra; maximo numeric; v_rel numeric; v_ingreso numeric; v_id uuid; borrar jsonb;
begin
  select * into a from public.agencias where user_id = p_user and activa;
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
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
  if exists (select 1 from public.solicitudes_credito s where s.agencia_id = a.id and s.cuit = c.cuit and s.estado = 'pendiente') then
    return jsonb_build_object('error', 'repetida');
  end if;
  perform set_config('gestor.autor', 'Agencia · ' || a.nombre, true);
  with x as (
    delete from public.solicitudes_credito s
     where s.agencia_id = a.id and s.estado = 'cargando' and (s.cuit = c.cuit or s.momento < now() - interval '2 days')
    returning s.archivos)
  select coalesce(jsonb_agg(e->>'path'), '[]'::jsonb) into borrar from x cross join lateral jsonb_array_elements(x.archivos) e;

  insert into public.solicitudes_credito (agencia_id, agencia, cuit, denominacion, consulta, semaforo, cliente, vehiculo, anio, monto, cuotas,
                                          cuota, total, tasa, cft, estado, ingreso, relacion, categoria, datos)
  values (a.id, a.nombre, c.cuit, c.denominacion, c.id, c.semaforo, left(coalesce(p_datos->>'cliente', ''), 300),
          left(coalesce(p_datos->>'vehiculo', ''), 200), left(coalesce(p_datos->>'anio', ''), 10),
          (p_datos->>'monto')::numeric, (p_datos->>'cuotas')::int, (p_datos->>'cuota')::numeric, (p_datos->>'total')::numeric,
          (p_datos->>'tasa')::numeric, (p_datos->>'cft')::numeric, 'cargando', v_ingreso, v_rel, p_datos->>'categoria',
          coalesce(p_datos->'datos', '{}'::jsonb))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'borrar', borrar);
end $$;

-- Anota un archivo ya subido al almacenamiento. {ok: true} o {error: solicitud|slot|path|cantidad}; con error, la
-- función borra lo que subió.
create function public.agencia_archivo(p_user uuid, p_id uuid, p_archivo jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; s public.solicitudes_credito; v_slot text := p_archivo->>'slot'; n int; n_slot int;
begin
  select * into a from public.agencias where user_id = p_user and activa;
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  select * into s from public.solicitudes_credito where id = p_id and agencia_id = a.id for update;
  if not found or s.estado <> 'cargando' then return jsonb_build_object('error', 'solicitud'); end if;
  if v_slot is null or not (v_slot = any (gestor.docs_requeridos(s.categoria, s.anio) || array['titulo'])) then
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

-- La agencia terminó de subir: si están todos los casilleros obligatorios, la solicitud pasa a «pendiente».
create function public.agencia_enviar(p_user uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; s public.solicitudes_credito; faltan text[];
begin
  select * into a from public.agencias where user_id = p_user and activa;
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  select * into s from public.solicitudes_credito where id = p_id and agencia_id = a.id for update;
  if not found or s.estado <> 'cargando' then return jsonb_build_object('error', 'solicitud'); end if;
  select array_agg(t.r order by t.o) into faltan from unnest(gestor.docs_requeridos(s.categoria, s.anio)) with ordinality as t(r, o)
   where not exists (select 1 from jsonb_array_elements(s.archivos) e where e->>'slot' = t.r);
  if faltan is not null then return jsonb_build_object('error', 'faltan', 'faltan', to_jsonb(faltan)); end if;
  perform set_config('gestor.autor', 'Agencia · ' || a.nombre, true);
  perform set_config('gestor.solicitud_envio', 'si', true);
  update public.solicitudes_credito set estado = 'pendiente', enviada = now() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Las solicitudes de la agencia (las que ya mandó), para que vea en qué quedó cada una.
create or replace function public.agencia_solicitudes(p_user uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x.momento desc), '[]'::jsonb) from (
    select s.id, coalesce(s.enviada, s.momento) as momento, s.cuit, s.denominacion, s.semaforo, s.vehiculo, s.anio, s.monto, s.cuotas, s.cuota,
           s.estado, s.nota, s.resuelto
      from public.solicitudes_credito s join public.agencias a on a.id = s.agencia_id
     where a.user_id = p_user and a.activa and s.estado <> 'cargando' order by s.momento desc limit 50) x;
$$;

revoke all on function public.agencia_archivo(uuid, uuid, jsonb), public.agencia_enviar(uuid, uuid) from public, anon, authenticated;
grant execute on function public.agencia_archivo(uuid, uuid, jsonb), public.agencia_enviar(uuid, uuid) to service_role;
revoke all on function gestor.docs_requeridos(text, text), gestor.docs_maximo(text) from public;

-- ───────────────────────── Carpeta privada del almacenamiento ─────────────────────────
-- Sin políticas sobre storage.objects: nadie la lee ni la escribe por la API, salvo la clave de servicio.
-- (En la base local de pruebas no hay almacenamiento: ahí lo imita dev/storage-falso.mjs.)
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('solicitudes', 'solicitudes', false, 10485760, array['application/pdf', 'image/jpeg'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;

select gestor.sin_estadisticas();

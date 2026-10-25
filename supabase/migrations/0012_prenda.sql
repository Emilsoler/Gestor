-- Geolocalización de vehículos prendados (app "Prenda", docs/prenda/).
--
-- Ubica el vehículo que el tomador de una ayuda económica con garantía prendaria dio como
-- garantía, con su consentimiento previo. La ubicación la pide la función `ubicar`
-- (supabase/functions/ubicar): verifica la sesión (mismas barreras que el resto), controla que
-- haya consentimiento registrado, le pregunta al equipo GPS a través de Traccar (o, mientras no
-- haya equipo, simula una posición para poder probar) y deja constancia en public.ubicaciones.
--
-- Tres tablas:
--   vehiculos        una fila por vehículo con GPS; lleva el consentimiento y los datos del equipo.
--   ubicaciones      bitácora de cada consulta de ubicación: quién, cuándo, qué vehículo y por qué.
--                    Es una constancia: NO se modifica ni se borra (ni con gestor.deshacer).
--   ajustes_prenda   una sola fila: política de ubicación exacta y radio de la zona habitual.

-- ───────────────────────── Vehículos ─────────────────────────
create table public.vehiculos (
  id              uuid primary key default gen_random_uuid(),
  dominio         text not null default '' check (length(dominio) <= 10),  -- patente
  marca           text not null default '',
  modelo          text not null default '',
  anio            smallint check (anio is null or anio between 1950 and 2100),
  deudor          text not null default '',
  dni             text not null default '',
  telefono        text not null default '',
  operacion       text not null default '',   -- N° de la ayuda económica con garantía prendaria
  expte           text not null default '',   -- vínculo opcional con una causa del gestor
  situacion       text not null default 'al_dia' check (situacion in ('al_dia', 'mora', 'ejecucion')),
  -- Consentimiento del tomador. Sin esto, la app no muestra la ubicación.
  --   {fecha:"AAAA-MM-DD", version, archivo, informado:bool, copia:bool}
  consentimiento  jsonb check (consentimiento is null or jsonb_typeof(consentimiento) = 'object'),
  -- Equipo GPS
  imei            text not null default '' check (imei = '' or imei ~ '^[0-9]{14,17}$'),
  equipo          text not null default 'Teltonika FMC920',
  instalado       date,
  traccar_id      text not null default '',   -- id del dispositivo en Traccar; vacío = todavía sin equipo (se simula)
  -- Simulación de demostración (solo cuando no hay traccar_id). La función `ubicar` y el mapa de la
  -- app calculan la posición de la misma forma a partir de esto:
  --   {modo:"quieto", pos:[lat,lon]} | {modo:"ruta", ruta:[[lat,lon],…], v, t0}  (v en km/h, t0 epoch ms)
  --   opcionales: motor:"cortado", bateria:0-100, senal:"sin"|"regular"|"buena", silencio_min:int
  sim             jsonb check (sim is null or jsonb_typeof(sim) = 'object'),
  zona_km         numeric(6,1) not null default 0 check (zona_km >= 0),  -- 0 = usa el valor de ajustes_prenda
  notas           text not null default '',
  rev             bigint not null default 0,
  actualizado     timestamptz not null default now(),
  actualizado_por text not null default ''
);
create index vehiculos_por_dominio on public.vehiculos (dominio);
comment on table public.vehiculos is
  'Vehículos prendados con GPS (app Prenda). `consentimiento` null = todavía no se registró el consentimiento del tomador y la app no muestra la ubicación. `traccar_id` vacío = sin equipo real: la ubicación se simula a partir de `sim`, para poder probar. `situacion`: al_dia | mora | ejecucion.';

-- ───────────────────────── Bitácora de ubicaciones (constancias) ─────────────────────────
-- Append-only: se puede leer y agregar, nunca modificar ni borrar. Es la prueba de cuándo y por
-- qué se consultó cada ubicación. Guarda una foto de los datos (dominio, deudor) para valer por
-- sí sola aunque después se borre el vehículo.
create table public.ubicaciones (
  id              uuid primary key default gen_random_uuid(),
  vehiculo        uuid references public.vehiculos (id) on delete set null,
  dominio         text not null default '',
  deudor          text not null default '',
  momento         timestamptz not null default now(),
  consultado_por  text not null default '',
  motivo          text not null default '',
  nota            text not null default '',
  exito           boolean not null default true,   -- el equipo respondió (false: se mostró la última conocida)
  resultado       jsonb not null default '{}'::jsonb check (jsonb_typeof(resultado) = 'object'),
  codigo          text not null default ''          -- código de control de la constancia
);
create index ubicaciones_por_vehiculo on public.ubicaciones (vehiculo, momento desc);
create index ubicaciones_por_momento on public.ubicaciones (momento desc);
comment on table public.ubicaciones is
  'Bitácora de consultas de ubicación (app Prenda): una fila por consulta, con quién, cuándo, qué vehículo y por qué. Constancia append-only: no se modifica ni se borra. `resultado`: {lat, lon, referencia, momento_reporte, origen:"traccar"|"simulado", velocidad, motor, bateria}.';

-- ───────────────────────── Ajustes ─────────────────────────
create table public.ajustes_prenda (
  id              integer primary key default 1 check (id = 1),
  politica        text not null default 'mora' check (politica in ('mora', 'siempre')),
  zona_km         numeric(6,1) not null default 20 check (zona_km > 0),
  base_lat        numeric(9,6) not null default -32.625900,  -- centro de la zona habitual (Bell Ville)
  base_lon        numeric(9,6) not null default -62.688700,
  rev             bigint not null default 0,
  actualizado     timestamptz not null default now(),
  actualizado_por text not null default ''
);
comment on table public.ajustes_prenda is
  'Ajustes de la app Prenda (una sola fila). `politica`: "mora" = la ubicación exacta de un vehículo al día se muestra solo indicando un motivo (al día se ve la zona); "siempre" = con consentimiento se ve la ubicación exacta siempre. `zona_km`: radio de la zona habitual para las alertas de alejamiento.';

-- ───────────────────────── Sellos e historial ─────────────────────────
-- vehiculos y ajustes_prenda: como el resto (rev, fecha, autor; y quedan en gestor.cambios).
create trigger sello before insert or update on public.vehiculos      for each row execute function gestor.tg_sello();
create trigger sello before insert or update on public.ajustes_prenda for each row execute function gestor.tg_sello();
create trigger auditar after insert or update or delete on public.vehiculos      for each row execute function gestor.tg_auditar('id');
create trigger auditar after insert or update or delete on public.ajustes_prenda for each row execute function gestor.tg_auditar('id');

-- ubicaciones: la fecha y el autor los pone la base (como las constancias del BCRA), para que
-- desde la app no se pueda antedatar ni firmar con otro nombre. Desde SQL directo se respeta lo
-- que venga (no hace falta para esta tabla, pero mantiene la coherencia).
create function gestor.tg_ubicacion() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce((select auth.role()), '') <> '' then
    new.momento := now();
    new.consultado_por := gestor.autor();
  elsif new.consultado_por = '' then
    new.consultado_por := gestor.autor();
  end if;
  return new;
end $$;
create trigger constancia before insert on public.ubicaciones for each row execute function gestor.tg_ubicacion();

-- ───────────────────────── Permisos ─────────────────────────
-- Mismas barreras que el resto: solo usuarios con sesión iniciada Y autorizados en gestor.miembros.
alter table public.vehiculos      enable row level security;
alter table public.ubicaciones    enable row level security;
alter table public.ajustes_prenda enable row level security;

create policy solo_miembros on public.vehiculos for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));
create policy solo_miembros on public.ubicaciones for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));
create policy solo_miembros on public.ajustes_prenda for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));

revoke all on public.vehiculos, public.ubicaciones, public.ajustes_prenda from public, anon, authenticated;
grant select, insert, update, delete on public.vehiculos to authenticated;
grant select, insert, update, delete on public.ajustes_prenda to authenticated;
-- La bitácora no se modifica ni se borra: solo leer y agregar.
grant select, insert on public.ubicaciones to authenticated;
grant all on public.vehiculos, public.ubicaciones, public.ajustes_prenda to service_role;

-- Realtime, para que la app se actualice sola.
do $$
begin
  alter publication supabase_realtime add table public.vehiculos, public.ubicaciones, public.ajustes_prenda;
exception when undefined_object or duplicate_object then null;
end $$;

-- Sin estadísticas del planificador, como las demás tablas (barrera 3, ver 0001).
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
                         'ajustes_cobranzas', 'consultas_bcra', 'vehiculos', 'ubicaciones', 'ajustes_prenda')
       and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('alter table public.%I alter column %I set statistics 0', r.relname, r.attname);
  end loop;
end $$;
comment on function gestor.sin_estadisticas() is
  'Desactiva las estadísticas del planificador en todas las columnas de las tablas de la app (gestor, cobranzas, BCRA y Prenda). Volver a llamarla en cada migración que agregue columnas o tablas.';
select gestor.sin_estadisticas();

-- ───────────────────────── Funciones para Claude (por el conector) ─────────────────────────
-- Buscar un vehículo por dominio o por deudor.
create function gestor.vehiculo(p_busca text) returns setof public.vehiculos
language sql stable set search_path = ''
as $$
  select * from public.vehiculos
   where replace(upper(dominio), ' ', '') = replace(upper(p_busca), ' ', '')
      or dominio ilike '%' || p_busca || '%' or deudor ilike '%' || p_busca || '%'
   order by dominio;
$$;

-- Alta de un vehículo. El consentimiento se registra aparte (gestor.registrar_consentimiento).
create function gestor.agregar_vehiculo(
  p_dominio text, p_marca text default '', p_modelo text default '', p_anio int default null,
  p_deudor text default '', p_operacion text default '', p_situacion text default 'al_dia',
  p_dni text default '', p_telefono text default '', p_expte text default '', p_autor text default 'Claude')
returns public.vehiculos
language plpgsql set search_path = ''
as $$
declare v public.vehiculos;
begin
  perform set_config('gestor.autor', p_autor, true);
  if coalesce(btrim(p_dominio), '') = '' then raise exception 'Falta el dominio (patente) del vehículo'; end if;
  insert into public.vehiculos (dominio, marca, modelo, anio, deudor, operacion, situacion, dni, telefono, expte)
  values (upper(btrim(p_dominio)), btrim(p_marca), btrim(p_modelo), p_anio, btrim(p_deudor),
          btrim(p_operacion), p_situacion, btrim(p_dni), btrim(p_telefono), btrim(p_expte))
  returning * into v;
  return v;
end $$;
comment on function gestor.agregar_vehiculo(text, text, text, int, text, text, text, text, text, text, text) is
  'Da de alta un vehículo con GPS. El consentimiento del tomador se registra después con gestor.registrar_consentimiento. Mientras no tenga equipo (traccar_id), la ubicación se simula.';

-- Registra (o quita, con p_fecha vacía) el consentimiento del tomador.
create function gestor.registrar_consentimiento(
  p_vehiculo text, p_fecha date default null, p_version text default 'v1.0',
  p_archivo text default '', p_autor text default 'Claude')
returns public.vehiculos
language plpgsql set search_path = ''
as $$
declare v public.vehiculos; v_id uuid;
begin
  perform set_config('gestor.autor', p_autor, true);
  select id into v_id from public.vehiculos
   where id::text = p_vehiculo or replace(upper(dominio), ' ', '') = replace(upper(p_vehiculo), ' ', '')
   limit 1;
  if v_id is null then raise exception 'No encontré el vehículo "%"', p_vehiculo; end if;
  update public.vehiculos
     set consentimiento = jsonb_build_object(
           'fecha', to_char(coalesce(p_fecha, gestor.hoy()), 'YYYY-MM-DD'),
           'version', coalesce(nullif(btrim(p_version), ''), 'v1.0'),
           'archivo', btrim(p_archivo), 'informado', true, 'copia', true)
   where id = v_id returning * into v;
  return v;
end $$;
comment on function gestor.registrar_consentimiento(text, date, text, text, text) is
  'Registra el consentimiento informado del tomador para geolocalizar su vehículo. Recién con esto la app muestra la ubicación.';

-- Las últimas consultas de ubicación de un vehículo (la bitácora).
create function gestor.ubicaciones_de(p_vehiculo text, p_limite int default 20)
returns table (momento timestamptz, consultado_por text, motivo text, nota text, exito boolean, referencia text)
language sql stable set search_path = ''
as $$
  select u.momento, u.consultado_por, u.motivo, u.nota, u.exito, u.resultado ->> 'referencia'
    from public.ubicaciones u
    join public.vehiculos v on v.id = u.vehiculo
   where v.id::text = p_vehiculo or replace(upper(v.dominio), ' ', '') = replace(upper(p_vehiculo), ' ', '')
   order by u.momento desc
   limit greatest(1, least(p_limite, 200));
$$;

-- ───────────────────────── Deshacer ─────────────────────────
-- Se agregan vehiculos y ajustes_prenda. La bitácora (ubicaciones) no se deshace: es append-only.
create or replace function gestor.deshacer(p_cambio bigint, p_forzar boolean default false, p_autor text default 'Claude') returns text
language plpgsql set search_path = ''
as $$
declare c gestor.cambios; posteriores integer; v_antes jsonb; v_estado text;
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
    v_antes := c.antes;
    if not (v_antes ? 'ubicacion') then
      v_antes := gestor.forma_0007(v_antes);
      select x.estado into v_estado from public.causas x where x.expte = c.clave;
      if found then v_antes := v_antes || jsonb_build_object('estado', v_estado); end if;
    end if;
    insert into public.causas (expte, actor, demandado, tipo, nom, oficina, ubicacion, estado, cautelar, situacion, proxima, vence, ultima, fecha, notas, historial, liquidacion, demandados, titulos)
    select r.expte, r.actor, r.demandado, r.tipo, r.nom, r.oficina, r.ubicacion, r.estado, r.cautelar, r.situacion, r.proxima, r.vence, r.ultima, r.fecha, r.notas, r.historial,
           nullif(r.liquidacion, 'null'::jsonb), coalesce(r.demandados, '[]'::jsonb), coalesce(r.titulos, '[]'::jsonb)
      from jsonb_populate_record(null::public.causas, v_antes) r
    on conflict (expte) do update set
      actor = excluded.actor, demandado = excluded.demandado, tipo = excluded.tipo, nom = excluded.nom, oficina = excluded.oficina,
      ubicacion = excluded.ubicacion, estado = excluded.estado, cautelar = excluded.cautelar, situacion = excluded.situacion,
      proxima = excluded.proxima, vence = excluded.vence, ultima = excluded.ultima,
      fecha = excluded.fecha, notas = excluded.notas, historial = excluded.historial, liquidacion = excluded.liquidacion,
      demandados = excluded.demandados, titulos = excluded.titulos;
  elsif c.tabla = 'acuerdos' then
    insert into public.acuerdos (id, deudor, expte, notas, cuotas, creado)
    select r.id, r.deudor, r.expte, r.notas, r.cuotas, r.creado from jsonb_populate_record(null::public.acuerdos, c.antes) r
    on conflict (id) do update set
      deudor = excluded.deudor, expte = excluded.expte, notas = excluded.notas, cuotas = excluded.cuotas, creado = excluded.creado;
  elsif c.tabla = 'plantillas' then
    insert into public.plantillas (id, titulo, cuerpo)
    select r.id, r.titulo, r.cuerpo from jsonb_populate_record(null::public.plantillas, c.antes) r
    on conflict (id) do update set titulo = excluded.titulo, cuerpo = excluded.cuerpo;
  elsif c.tabla = 'agenda' then
    insert into public.agenda (id, expte, titulo, cuerpo, fecha, realizar, estado, resultado, presentado, creado, ahora)
    select r.id, r.expte, r.titulo, r.cuerpo, r.fecha, r.realizar, r.estado, r.resultado, r.presentado, r.creado, r.ahora
      from jsonb_populate_record(null::public.agenda, c.antes) r
    on conflict (id) do update set
      expte = excluded.expte, titulo = excluded.titulo, cuerpo = excluded.cuerpo, fecha = excluded.fecha, realizar = excluded.realizar,
      estado = excluded.estado, resultado = excluded.resultado, presentado = excluded.presentado, creado = excluded.creado,
      ahora = excluded.ahora;
  elsif c.tabla = 'deudores' then
    insert into public.deudores (id, nombre, trato, dni, socio, domicilio, email, telefonos, acreedor, estado, expte, tasa, hon_pct,
                                 operaciones, cuotas, gastos, pagos, planes, gestiones, proxima, vence, notas, creado)
    select r.id, r.nombre, r.trato, r.dni, r.socio, r.domicilio, r.email, r.telefonos, r.acreedor, r.estado, r.expte, r.tasa, r.hon_pct,
           r.operaciones, r.cuotas, r.gastos, r.pagos, r.planes, r.gestiones, r.proxima, r.vence, r.notas, r.creado
      from jsonb_populate_record(null::public.deudores, c.antes) r
    on conflict (id) do update set
      nombre = excluded.nombre, trato = excluded.trato, dni = excluded.dni, socio = excluded.socio, domicilio = excluded.domicilio,
      email = excluded.email, telefonos = excluded.telefonos, acreedor = excluded.acreedor, estado = excluded.estado,
      expte = excluded.expte, tasa = excluded.tasa, hon_pct = excluded.hon_pct, operaciones = excluded.operaciones,
      cuotas = excluded.cuotas, gastos = excluded.gastos, pagos = excluded.pagos, planes = excluded.planes,
      gestiones = excluded.gestiones, proxima = excluded.proxima, vence = excluded.vence, notas = excluded.notas,
      creado = excluded.creado;
  elsif c.tabla = 'modelos_mensaje' then
    insert into public.modelos_mensaje (id, titulo, cuerpo, orden)
    select r.id, r.titulo, r.cuerpo, r.orden from jsonb_populate_record(null::public.modelos_mensaje, c.antes) r
    on conflict (id) do update set titulo = excluded.titulo, cuerpo = excluded.cuerpo, orden = excluded.orden;
  elsif c.tabla = 'ajustes_cobranzas' then
    update public.ajustes_cobranzas a set
      tasa = r.tasa, tasa_sistema = r.tasa_sistema, contado_pct = r.contado_pct, oferta_dias = r.oferta_dias,
      gracia = r.gracia, caducidad = r.caducidad, acreedor = r.acreedor, firma = r.firma
      from jsonb_populate_record(null::public.ajustes_cobranzas, c.antes) r
     where a.id = 1;
  elsif c.tabla = 'consultas_bcra' then
    insert into public.consultas_bcra (id, cuit, denominacion, momento, consultado_por, periodo, semaforo, peor_situacion, entidades,
                                       deuda_total, cheques, cheques_impagos, motivos, resultado)
    select r.id, r.cuit, r.denominacion, r.momento, r.consultado_por, r.periodo, r.semaforo, r.peor_situacion, r.entidades,
           r.deuda_total, r.cheques, r.cheques_impagos, r.motivos, r.resultado
      from jsonb_populate_record(null::public.consultas_bcra, c.antes) r
    on conflict (id) do update set
      cuit = excluded.cuit, denominacion = excluded.denominacion, momento = excluded.momento, consultado_por = excluded.consultado_por,
      periodo = excluded.periodo, semaforo = excluded.semaforo, peor_situacion = excluded.peor_situacion, entidades = excluded.entidades,
      deuda_total = excluded.deuda_total, cheques = excluded.cheques, cheques_impagos = excluded.cheques_impagos,
      motivos = excluded.motivos, resultado = excluded.resultado;
  elsif c.tabla = 'consultas_cheques' then
    insert into public.consultas_cheques (id, entidad, entidad_nombre, numero, denunciado, fecha_bcra, momento, consultado_por, resultado)
    select r.id, r.entidad, r.entidad_nombre, r.numero, r.denunciado, r.fecha_bcra, r.momento, r.consultado_por, r.resultado
      from jsonb_populate_record(null::public.consultas_cheques, c.antes) r
    on conflict (id) do update set
      entidad = excluded.entidad, entidad_nombre = excluded.entidad_nombre, numero = excluded.numero, denunciado = excluded.denunciado,
      fecha_bcra = excluded.fecha_bcra, momento = excluded.momento, consultado_por = excluded.consultado_por, resultado = excluded.resultado;
  elsif c.tabla = 'vehiculos' then
    insert into public.vehiculos (id, dominio, marca, modelo, anio, deudor, dni, telefono, operacion, expte, situacion,
                                  consentimiento, imei, equipo, instalado, traccar_id, sim, zona_km, notas)
    select r.id, r.dominio, r.marca, r.modelo, r.anio, r.deudor, r.dni, r.telefono, r.operacion, r.expte, r.situacion,
           r.consentimiento, r.imei, r.equipo, r.instalado, r.traccar_id, r.sim, r.zona_km, r.notas
      from jsonb_populate_record(null::public.vehiculos, c.antes) r
    on conflict (id) do update set
      dominio = excluded.dominio, marca = excluded.marca, modelo = excluded.modelo, anio = excluded.anio, deudor = excluded.deudor,
      dni = excluded.dni, telefono = excluded.telefono, operacion = excluded.operacion, expte = excluded.expte, situacion = excluded.situacion,
      consentimiento = excluded.consentimiento, imei = excluded.imei, equipo = excluded.equipo, instalado = excluded.instalado,
      traccar_id = excluded.traccar_id, sim = excluded.sim, zona_km = excluded.zona_km, notas = excluded.notas;
  elsif c.tabla = 'ajustes_prenda' then
    update public.ajustes_prenda a set
      politica = r.politica, zona_km = r.zona_km, base_lat = r.base_lat, base_lon = r.base_lon
      from jsonb_populate_record(null::public.ajustes_prenda, c.antes) r
     where a.id = 1;
  else
    raise exception 'No sé deshacer cambios de la tabla %', c.tabla;
  end if;
  return format('%s %s volvió a como estaba antes del cambio %s (%s, %s)', c.tabla, c.clave, c.id, c.autor,
                to_char(c.momento at time zone 'America/Argentina/Cordoba', 'DD/MM HH24:MI'));
end $$;

-- Nada del esquema privado es alcanzable por los roles de la API (ver 0001).
revoke all on all tables in schema gestor from public, anon, authenticated;
revoke all on all functions in schema gestor from public, anon, authenticated;

-- La fila única de ajustes.
insert into public.ajustes_prenda (id) values (1) on conflict (id) do nothing;

-- Que la API vea las tablas nuevas sin esperar.
notify pgrst, 'reload schema';

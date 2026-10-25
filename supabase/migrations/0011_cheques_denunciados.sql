-- Aprobación de créditos: consultas a la Central de Cheques Denunciados del BCRA (vista "Créditos").
--
-- Se elige el banco y se escribe el número de cheque; la función `bcra` de Supabase le pregunta al BCRA si
-- ese cheque está denunciado como extraviado, sustraído o adulterado y guarda acá la respuesta con la sesión
-- de la persona (mismas barreras que el resto). Igual que consultas_bcra: cada fila es la constancia de lo
-- que informaba el BCRA ese día, y no se modifica (la API no da permiso de update).
--
--   entidad     código de la entidad en el BCRA (11 = Banco de la Nación, 20 = Banco de Córdoba, …)
--   numero      el número del cheque como lo toma el BCRA: solo cifras, sin ceros adelante
--   resultado   el `results` del BCRA tal cual: {numeroCheque, denunciado, fechaProcesamiento,
--               denominacionEntidad, detalles: [{sucursal, numeroCuenta, causal}]}

create table public.consultas_cheques (
  id              uuid primary key default gen_random_uuid(),
  entidad         integer not null check (entidad between 1 and 99999),
  entidad_nombre  text not null default '' check (length(entidad_nombre) <= 200),
  numero          text not null check (numero ~ '^[1-9][0-9]{0,14}$'),
  denunciado      boolean not null,
  fecha_bcra      date,
  momento         timestamptz not null default now(),
  consultado_por  text not null default '',
  resultado       jsonb not null check (jsonb_typeof(resultado) = 'object'),
  rev             bigint not null default 0,
  actualizado     timestamptz not null default now(),
  actualizado_por text not null default ''
);
create index consultas_cheques_por_cheque on public.consultas_cheques (entidad, numero, momento desc);
comment on table public.consultas_cheques is
  'Aprobación de créditos: una fila por consulta a la Central de Cheques Denunciados del BCRA (cheques extraviados, sustraídos o adulterados), hecha desde la app (función bcra). `entidad`: código del banco en el BCRA. `numero`: el del cheque, sin ceros adelante. `denunciado`: lo que respondió el BCRA. `fecha_bcra`: a qué fecha tenía procesada la información. `resultado`: la respuesta del BCRA tal cual (con sucursal, cuenta y causal de cada denuncia). Que un cheque no esté denunciado no dice si tiene fondos: eso se ve consultando por CUIT a quien lo libró. Desde SQL no se puede consultar al BCRA: lo hace el botón de la app.';
comment on column public.consultas_cheques.resultado is
  '{numeroCheque, denunciado, fechaProcesamiento, denominacionEntidad, detalles: [{sucursal, numeroCuenta, causal}]}: el `results` de la API de Cheques Denunciados (cheques/v1.0/denunciados/{entidad}/{numero}).';

-- La fecha y quién consultó los pone la base, como en consultas_bcra (gestor.tg_consulta_bcra sirve para
-- las dos constancias): desde la app no se puede antedatar ni firmar con otro nombre.
create trigger constancia before insert on public.consultas_cheques for each row execute function gestor.tg_consulta_bcra();
create trigger sello before insert or update on public.consultas_cheques for each row execute function gestor.tg_sello();
create trigger auditar after insert or update or delete on public.consultas_cheques for each row execute function gestor.tg_auditar('id');

-- ───────────────────────── Permisos ─────────────────────────
-- Igual que consultas_bcra: solo usuarios con sesión iniciada Y autorizados en gestor.miembros. Se puede
-- consultar, agregar y eliminar; cambiar una consulta, no.

alter table public.consultas_cheques enable row level security;
create policy solo_miembros on public.consultas_cheques for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));

revoke all on public.consultas_cheques from public, anon, authenticated;
grant select, insert, delete on public.consultas_cheques to authenticated;
grant all on public.consultas_cheques to service_role;

do $$
begin
  alter publication supabase_realtime add table public.consultas_cheques;
exception when undefined_object or duplicate_object then null;
end $$;

-- Sin estadísticas del planificador, como las demás tablas (ver 0001).
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
       and c.relname in ('causas', 'acuerdos', 'plantillas', 'agenda', 'deudores', 'modelos_mensaje', 'ajustes_cobranzas',
                         'consultas_bcra', 'consultas_cheques')
       and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('alter table public.%I alter column %I set statistics 0', r.relname, r.attname);
  end loop;
end $$;
comment on function gestor.sin_estadisticas() is
  'Desactiva las estadísticas del planificador en todas las columnas de las tablas de la app (gestor, cobranzas y consultas al BCRA de personas y de cheques). Volver a llamarla en cada migración que agregue columnas o tablas.';
select gestor.sin_estadisticas();

-- ───────────────────────── Deshacer ─────────────────────────
-- Una consulta de cheque eliminada también se puede recuperar (vuelve con su fecha y su autor originales).

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
    -- La constancia vuelve como era, con su fecha y su autor (desde SQL, `constancia` los respeta).
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
  else
    raise exception 'No sé deshacer cambios de la tabla %', c.tabla;
  end if;
  return format('%s %s volvió a como estaba antes del cambio %s (%s, %s)', c.tabla, c.clave, c.id, c.autor,
                to_char(c.momento at time zone 'America/Argentina/Cordoba', 'DD/MM HH24:MI'));
end $$;

-- Nada del esquema privado es alcanzable por los roles de la API (ver 0001).
revoke all on all tables in schema gestor from public, anon, authenticated;
revoke all on all functions in schema gestor from public, anon, authenticated;

-- Que la API vea la tabla nueva sin esperar.
notify pgrst, 'reload schema';

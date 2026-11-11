-- Archivar casos de "Estado de Deuda y Refinanciación".
--
-- Cuando el convenio ya se firmó, el caso deja de hacer falta en la lista de "Casos guardados" pero no
-- se borra: queda archivado y se puede ver y desarchivar desde "Archivados".
--
--   archivado   cuándo se archivó (null: caso en curso). Una columna y no un estado nuevo, para que
--               desarchivar sea volver a null y no se pierda cuándo se firmó.

alter table public.casos_refi add column archivado timestamptz;
comment on column public.casos_refi.archivado is
  'Cuándo se archivó el caso (convenio ya firmado). null: en curso. Los archivados no se listan con los casos guardados sino aparte.';

-- La columna nueva también va sin estadísticas del planificador (ver 0001).
select gestor.sin_estadisticas();

-- ───────────────────────── Deshacer ─────────────────────────
-- Igual que en 0020; la rama de casos_refi también restaura `archivado`.

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
    insert into public.agenda (id, expte, titulo, cuerpo, fecha, realizar, estado, resultado, presentado, creado, ahora, adjuntos)
    select r.id, r.expte, r.titulo, r.cuerpo, r.fecha, r.realizar, r.estado, r.resultado, r.presentado, r.creado, r.ahora,
           coalesce(r.adjuntos, '[]'::jsonb)
      from jsonb_populate_record(null::public.agenda, c.antes) r
    on conflict (id) do update set
      expte = excluded.expte, titulo = excluded.titulo, cuerpo = excluded.cuerpo, fecha = excluded.fecha, realizar = excluded.realizar,
      estado = excluded.estado, resultado = excluded.resultado, presentado = excluded.presentado, creado = excluded.creado,
      ahora = excluded.ahora, adjuntos = excluded.adjuntos;
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
  elsif c.tabla = 'casos_refi' then
    insert into public.casos_refi (id, nombre, deudor, datos, creado, archivado)
    select r.id, r.nombre, r.deudor, r.datos, r.creado, r.archivado from jsonb_populate_record(null::public.casos_refi, c.antes) r
    on conflict (id) do update set nombre = excluded.nombre, deudor = excluded.deudor, datos = excluded.datos, creado = excluded.creado,
                                   archivado = excluded.archivado;
  else
    raise exception 'No sé deshacer cambios de la tabla %', c.tabla;
  end if;
  return format('%s %s volvió a como estaba antes del cambio %s (%s, %s)', c.tabla, c.clave, c.id, c.autor,
                to_char(c.momento at time zone 'America/Argentina/Cordoba', 'DD/MM HH24:MI'));
end $$;

-- Las funciones nuevas nacen ejecutables por PUBLIC: se les quita, como en 0001.
revoke all on all functions in schema gestor from public, anon, authenticated;

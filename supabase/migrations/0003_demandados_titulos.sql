-- Datos de contacto de los demandados y títulos reclamados (pagarés o prenda) de cada causa.
--
-- Van como dos columnas más en `causas`, igual que `historial` y `liquidacion`: así heredan sin
-- tocar nada la revisión (rev), la auditoría, el deshacer, las políticas de acceso y el aviso en vivo.
--
--   demandados: [{nombre, dni, telefono, domicilio, notas}]
--   titulos:    [{tipo: "pagare"|"prenda", monto, vence: "AAAA-MM-DD", descripcion, vehiculo}]
--               `vehiculo` solo se usa en las prendas.
alter table public.causas
  add column demandados jsonb not null default '[]'::jsonb check (jsonb_typeof(demandados) = 'array'),
  add column titulos    jsonb not null default '[]'::jsonb check (jsonb_typeof(titulos) = 'array');
comment on column public.causas.demandados is
  'Fichas de los demandados: array de {nombre, dni, telefono, domicilio, notas}. Para cargar uno usar gestor.agregar_demandado.';
comment on column public.causas.titulos is
  'Títulos reclamados: array de {tipo:"pagare"|"prenda", monto, vence:"AAAA-MM-DD", descripcion, vehiculo}. El monto reclamado con intereses sale de gestor.reclamado. Para cargar uno usar gestor.agregar_titulo.';

-- Las columnas nuevas también quedan sin estadísticas del planificador (ver 0001).
select gestor.sin_estadisticas();

-- ───────────────────────── Funciones para Claude ─────────────────────────

create function gestor.agregar_demandado(
  p_expte text, p_nombre text, p_dni text default '', p_telefono text default '',
  p_domicilio text default '', p_notas text default '', p_autor text default 'Claude'
) returns text
language plpgsql set search_path = ''
as $$
begin
  perform set_config('gestor.autor', p_autor, true);
  update public.causas
     set demandados = demandados || jsonb_build_array(jsonb_build_object(
           'nombre', coalesce(p_nombre, ''), 'dni', coalesce(p_dni, ''), 'telefono', coalesce(p_telefono, ''),
           'domicilio', coalesce(p_domicilio, ''), 'notas', coalesce(p_notas, '')))
   where expte = p_expte;
  if not found then raise exception 'No existe la causa %', p_expte; end if;
  return format('Causa %s: demandado "%s" agregado', p_expte, p_nombre);
end $$;
comment on function gestor.agregar_demandado(text, text, text, text, text, text, text) is
  'Agrega la ficha de un demandado a una causa.';

create function gestor.agregar_titulo(
  p_expte text, p_tipo text, p_monto numeric, p_vence date default null,
  p_descripcion text default '', p_vehiculo text default '', p_autor text default 'Claude'
) returns text
language plpgsql set search_path = ''
as $$
begin
  if p_tipo not in ('pagare', 'prenda') then
    raise exception 'El tipo tiene que ser "pagare" o "prenda" (llegó "%")', p_tipo;
  end if;
  if p_monto is null or p_monto < 0 then raise exception 'El monto tiene que ser un número no negativo'; end if;
  perform set_config('gestor.autor', p_autor, true);
  update public.causas
     set titulos = titulos || jsonb_build_array(jsonb_build_object(
           'tipo', p_tipo, 'monto', p_monto, 'vence', coalesce(p_vence::text, ''),
           'descripcion', coalesce(p_descripcion, ''), 'vehiculo', case when p_tipo = 'prenda' then coalesce(p_vehiculo, '') else '' end))
   where expte = p_expte;
  if not found then raise exception 'No existe la causa %', p_expte; end if;
  return format('Causa %s: %s por %s agregado', p_expte, p_tipo, p_monto);
end $$;
comment on function gestor.agregar_titulo(text, text, numeric, date, text, text, text) is
  'Agrega un pagaré o una prenda (con su monto y vencimiento) a una causa.';

-- Monto reclamado al día de hoy (o a p_hasta): capital + interés simple, p_tasa por cada 30 días
-- transcurridos desde el vencimiento de cada título. Sin vencimiento, o con vencimiento futuro,
-- el interés es cero. La app hace el mismo cálculo; esta función es para Claude.
create function gestor.reclamado(p_expte text, p_hasta date default null, p_tasa numeric default 0.05) returns jsonb
language sql stable set search_path = ''
as $$
  with h as (select coalesce(p_hasta, gestor.hoy()) as hasta),
  t as (
    select e.ord, e.t ->> 'tipo' as tipo, e.t ->> 'descripcion' as descripcion,
           coalesce(nullif(e.t ->> 'monto', '')::numeric, 0) as capital,
           nullif(e.t ->> 'vence', '')::date as vence
      from public.causas c, jsonb_array_elements(c.titulos) with ordinality e(t, ord)
     where c.expte = p_expte
  ),
  r as (
    select t.*, greatest(coalesce(h.hasta - t.vence, 0), 0) as dias,
           round(t.capital * p_tasa * greatest(coalesce(h.hasta - t.vence, 0), 0) / 30.0, 2) as interes
      from t, h
  )
  select jsonb_build_object(
    'hasta', (select hasta from h), 'tasa_mensual', p_tasa,
    'titulos', coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'descripcion', descripcion, 'capital', capital,
                 'vence', vence, 'dias', dias, 'interes', interes, 'total', capital + interes) order by ord), '[]'::jsonb),
    'capital', coalesce(sum(capital), 0), 'interes', coalesce(sum(interes), 0), 'total', coalesce(sum(capital + interes), 0))
  from r
$$;
comment on function gestor.reclamado(text, date, numeric) is
  'Monto reclamado de una causa: por título y total, con interés simple (p_tasa cada 30 días desde el vencimiento).';

-- ───────────────────────── Deshacer con las columnas nuevas ─────────────────────────
-- Igual que en 0001, más demandados y titulos. Los cambios anteriores a esta migración no
-- tienen esas claves en `antes`: se restauran como lista vacía.
create or replace function gestor.deshacer(p_cambio bigint, p_forzar boolean default false, p_autor text default 'Claude') returns text
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
    insert into public.causas (expte, actor, demandado, tipo, nom, oficina, estado, etiquetas, proxima, vence, ultima, fecha, notas, historial, liquidacion, demandados, titulos)
    select r.expte, r.actor, r.demandado, r.tipo, r.nom, r.oficina, r.estado, r.etiquetas, r.proxima, r.vence, r.ultima, r.fecha, r.notas, r.historial,
           nullif(r.liquidacion, 'null'::jsonb), coalesce(r.demandados, '[]'::jsonb), coalesce(r.titulos, '[]'::jsonb)
      from jsonb_populate_record(null::public.causas, c.antes) r
    on conflict (expte) do update set
      actor = excluded.actor, demandado = excluded.demandado, tipo = excluded.tipo, nom = excluded.nom, oficina = excluded.oficina,
      estado = excluded.estado, etiquetas = excluded.etiquetas, proxima = excluded.proxima, vence = excluded.vence, ultima = excluded.ultima,
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
  else
    raise exception 'No sé deshacer cambios de la tabla %', c.tabla;
  end if;
  return format('%s %s volvió a como estaba antes del cambio %s (%s, %s)', c.tabla, c.clave, c.id, c.autor,
                to_char(c.momento at time zone 'America/Argentina/Cordoba', 'DD/MM HH24:MI'));
end $$;

-- Las funciones nuevas nacen ejecutables por PUBLIC: se les quita, como en 0001.
revoke all on all functions in schema gestor from public, anon, authenticated;

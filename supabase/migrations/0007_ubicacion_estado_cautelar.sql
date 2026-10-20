-- Ubicación, estado procesal, etiqueta cautelar y situación de cada causa.
--
-- Hasta acá `estado` mezclaba tres cosas —dónde está el expediente, en qué etapa va el juicio y si
-- está archivado o en acuerdo— y `etiquetas` era una lista libre. Desde ahora cada cosa tiene su
-- campo, con valores fijos:
--   ubicacion  Casillero | A despacho. Cada presentación en el SAC la deja "A despacho".
--   estado     La etapa del juicio: 0. Iniciamos | 1.1 Demanda | 1.2 Contestación |
--              2. No oposición de excepciones | 3. Sentencia | 4. Ejecución de Sentencia |
--              5. Martillero Designado. Vacío = sin estado (solo en causas que vienen de antes).
--   cautelar   La "Etiqueta Cautelar": Sin Cautelar | Embargo de sueldo | Vehículo secuestrado.
--   situacion  En trámite | Acuerdo | Archivada. Las archivadas no se listan y los acuerdos van
--              aparte, como antes con los estados del mismo nombre.
--
-- Los datos se pasan con gestor.forma_0007, que también usa gestor.deshacer con las fotos de
-- gestor.cambios anteriores a este cambio. Del estado anterior solo se deduce la etapa cuando es
-- evidente; el resto queda sin estado y se completa causa por causa. Lo que había antes queda en
-- gestor.respaldo_0007.
--
-- Esta migración no borra nada (así se aplica sin el paso de confirmación que piden las
-- instrucciones destructivas): la columna `etiquetas` queda con lo que tenía y sin uso, y la versión
-- anterior de gestor.movimiento pasa a llamarse gestor.movimiento_anterior y solo avisa. Las dos se
-- pueden quitar más adelante.

-- ───────────────────────── Valores admitidos ─────────────────────────

create or replace function gestor.estados_base() returns text[]
language sql immutable set search_path = ''
as $$ select array['0. Iniciamos','1.1 Demanda','1.2 Contestación','2. No oposición de excepciones','3. Sentencia','4. Ejecución de Sentencia','5. Martillero Designado'] $$;
comment on function gestor.estados_base() is 'Las etapas del juicio, en orden: los estados que acepta una causa.';

create function gestor.ubicaciones() returns text[]
language sql immutable set search_path = ''
as $$ select array['Casillero','A despacho'] $$;

create function gestor.cautelares() returns text[]
language sql immutable set search_path = ''
as $$ select array['Sin Cautelar','Embargo de sueldo','Vehículo secuestrado'] $$;

create function gestor.situaciones() returns text[]
language sql immutable set search_path = ''
as $$ select array['En trámite','Acuerdo','Archivada'] $$;

-- ───────────────────────── De la forma anterior a la nueva ─────────────────────────

-- Recibe una causa como jsonb. Si no tiene `ubicacion` (forma anterior a 0007) la devuelve con
-- ubicacion, estado, cautelar y situacion, sacados del estado y las etiquetas de antes; si ya tiene
-- la forma nueva, la devuelve igual.
create function gestor.forma_0007(p jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select case when p ? 'ubicacion' then p else
    (p - 'etiquetas') || jsonb_build_object(
      'ubicacion', case when (p ->> 'estado') in ('Casillero', 'A despacho') then p ->> 'estado' else 'Casillero' end,
      'estado', case
        when (p -> 'etiquetas') ? 'Martillero' then '5. Martillero Designado'
        when (p ->> 'estado') = 'Tramites p/ subasta' then '4. Ejecución de Sentencia'
        when (p ->> 'estado') = 'Sentencia' then '3. Sentencia'
        when (p ->> 'estado') = 'Notificando' then '1.1 Demanda'
        when (p ->> 'estado') = 'Iniciar' then '0. Iniciamos'
        else '' end,
      'cautelar', case
        when (p -> 'etiquetas') ? 'Secuestro / subasta' then 'Vehículo secuestrado'
        when (p -> 'etiquetas') ? 'Embargo de sueldo' then 'Embargo de sueldo'
        else 'Sin Cautelar' end,
      'situacion', case
        when (p ->> 'estado') = 'Archivada' then 'Archivada'
        when (p ->> 'estado') = 'Acuerdo' or (p -> 'etiquetas') ? 'Acuerdo' then 'Acuerdo'
        else 'En trámite' end)
  end
$$;
comment on function gestor.forma_0007(jsonb) is
  'Pasa una causa en jsonb de la forma anterior a 0007 (sin ubicacion: estado mezclado + etiquetas) a la actual (ubicacion, estado, cautelar, situacion). Si ya está en la forma actual, la devuelve igual.';

-- ───────────────────────── Respaldo ─────────────────────────

create table gestor.respaldo_0007 (
  expte     text primary key,
  estado    text not null,
  etiquetas text[] not null,
  guardado  timestamptz not null default now()
);
alter table gestor.respaldo_0007 enable row level security;
comment on table gestor.respaldo_0007 is
  'Estado y etiquetas de cada causa tal como estaban antes de 0007 (ubicación, estado procesal, etiqueta cautelar y situación). Solo para consultar.';
insert into gestor.respaldo_0007 (expte, estado, etiquetas) select expte, estado, etiquetas from public.causas;

-- ───────────────────────── Columnas y datos ─────────────────────────

alter table public.causas
  add column ubicacion text not null default 'Casillero',
  add column cautelar  text not null default 'Sin Cautelar',
  add column situacion text not null default 'En trámite';
alter table public.causas alter column estado set default '0. Iniciamos';

-- En un solo bloque, para que todo el cambio quede firmado por Claude en gestor.cambios.
do $$
begin
  perform set_config('gestor.autor', 'Claude', true);
  update public.causas c
     set ubicacion = f.n ->> 'ubicacion', estado = f.n ->> 'estado', cautelar = f.n ->> 'cautelar', situacion = f.n ->> 'situacion'
    from (select x.expte, gestor.forma_0007(to_jsonb(x) - 'ubicacion' - 'cautelar' - 'situacion') as n from public.causas x) f
   where f.expte = c.expte;
end $$;

comment on column public.causas.etiquetas is
  'Sin uso desde 0007: lo que decía pasó a cautelar y situacion. Queda con los valores de antes, solo para consultar.';
alter table public.causas
  add constraint causas_ubicacion_check check (ubicacion in ('Casillero', 'A despacho')),
  add constraint causas_estado_check check (estado in ('', '0. Iniciamos', '1.1 Demanda', '1.2 Contestación',
    '2. No oposición de excepciones', '3. Sentencia', '4. Ejecución de Sentencia', '5. Martillero Designado')),
  add constraint causas_cautelar_check check (cautelar in ('Sin Cautelar', 'Embargo de sueldo', 'Vehículo secuestrado')),
  add constraint causas_situacion_check check (situacion in ('En trámite', 'Acuerdo', 'Archivada'));

comment on table public.causas is
  'Una fila por juicio; la clave es el N° de expediente del SAC. `ubicacion`: Casillero | A despacho. `estado`: la etapa del juicio (gestor.estados_base()). `cautelar` (Etiqueta Cautelar): Sin Cautelar | Embargo de sueldo | Vehículo secuestrado. `situacion`: En trámite | Acuerdo | Archivada. `ultima` y `fecha` son la última acción y su fecha; `proxima` y `vence`, lo que hay que hacer y para cuándo. `historial` es un array de {fecha:"AAAA-MM-DD", texto, hecha?}. `liquidacion` es {fecha, embargo, rubros:[{id, rubro, monto, pagado}], pagos:[{id, fecha, op, imp}]} o null. Para anotar movimientos usar gestor.movimiento / gestor.presentacion.';
comment on column public.causas.ubicacion is 'Dónde está el expediente: Casillero o A despacho. Cada presentación en el SAC lo deja A despacho.';
comment on column public.causas.estado is 'La etapa del juicio: 0. Iniciamos, 1.1 Demanda, 1.2 Contestación, 2. No oposición de excepciones, 3. Sentencia, 4. Ejecución de Sentencia o 5. Martillero Designado. Vacío: sin estado.';
comment on column public.causas.cautelar is 'Etiqueta Cautelar: Sin Cautelar, Embargo de sueldo o Vehículo secuestrado.';
comment on column public.causas.situacion is 'En trámite, Acuerdo o Archivada. Las archivadas no aparecen en el listado de la app; las de acuerdo se ven aparte.';

select gestor.sin_estadisticas();

-- ───────────────────────── Funciones para Claude ─────────────────────────

create or replace function gestor.validar_estado(p_estado text) returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if p_estado is null or p_estado = any (gestor.estados_base()) then return; end if;
  if p_estado = any (gestor.ubicaciones()) then
    raise exception '"%" es una ubicación, no un estado: va en p_ubicacion. Los estados del gestor son: %',
      p_estado, array_to_string(gestor.estados_base(), ', ');
  end if;
  if p_estado = any (gestor.situaciones()) then
    raise exception '"%" es la situación de la causa (columna situacion), no un estado. Los estados del gestor son: %',
      p_estado, array_to_string(gestor.estados_base(), ', ');
  end if;
  raise exception 'Estado desconocido: "%". Los estados del gestor son: %', p_estado, array_to_string(gestor.estados_base(), ', ');
end $$;

create function gestor.validar_ubicacion(p_ubicacion text) returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if p_ubicacion is null or p_ubicacion = any (gestor.ubicaciones()) then return; end if;
  raise exception 'Ubicación desconocida: "%". Las ubicaciones son: %', p_ubicacion, array_to_string(gestor.ubicaciones(), ', ');
end $$;

-- Anota un movimiento; opcionalmente cambia la etapa y la ubicación. p_autor sigue al final, como
-- en las demás funciones: la ubicación entra antes.
alter function gestor.movimiento(text, text, date, text, text) rename to movimiento_anterior;
create or replace function gestor.movimiento_anterior(p_expte text, p_texto text, p_fecha date default null,
                                                      p_estado text default null, p_autor text default 'Claude')
returns public.causas
language plpgsql set search_path = ''
as $$
begin
  raise exception 'gestor.movimiento_anterior quedó sin uso con 0007: usá gestor.movimiento, que acepta p_estado (la etapa) y p_ubicacion.';
end $$;
create function gestor.movimiento(p_expte text, p_texto text, p_fecha date default null,
                                  p_estado text default null, p_ubicacion text default null,
                                  p_autor text default 'Claude')
returns public.causas
language plpgsql set search_path = ''
as $$
declare c public.causas; h jsonb; u record;
begin
  perform set_config('gestor.autor', p_autor, true);
  if coalesce(btrim(p_texto), '') = '' then raise exception 'Falta el texto del movimiento'; end if;
  perform gestor.validar_estado(p_estado);
  perform gestor.validar_ubicacion(p_ubicacion);
  select * into c from public.causas where expte = p_expte for update;
  if not found then raise exception 'No existe la causa con expediente %', p_expte; end if;
  h := c.historial || jsonb_build_array(jsonb_build_object(
         'fecha', to_char(coalesce(p_fecha, gestor.hoy()), 'YYYY-MM-DD'), 'texto', btrim(p_texto)));
  select * into u from gestor.ultima_de(h);
  update public.causas
     set historial = h, ultima = u.ultima, fecha = u.fecha,
         estado = coalesce(p_estado, estado), ubicacion = coalesce(p_ubicacion, ubicacion)
   where expte = p_expte returning * into c;
  return c;
end $$;
comment on function gestor.movimiento(text, text, date, text, text, text) is
  'Agrega un movimiento al historial de la causa y actualiza última acción y fecha. p_fecha por defecto: hoy (hora de Córdoba). Opcionales: p_estado (etapa del juicio) y p_ubicacion (Casillero o A despacho).';

create or replace function gestor.presentacion(p_expte text, p_texto text, p_fecha date default null, p_autor text default 'Claude')
returns public.causas
language sql set search_path = ''
as $$ select gestor.movimiento(p_expte, p_texto, p_fecha, null, 'A despacho', p_autor) $$;
comment on function gestor.presentacion(text, text, date, text) is
  'Regla del estudio: cada presentación en el SAC deja el expediente "A despacho". Anota el movimiento y cambia la ubicación.';

-- Igual que en 0006, pero lo que queda "A despacho" es la ubicación.
create or replace function gestor.agenda_presentada(p_id uuid, p_detalle text default '', p_autor text default 'Claude')
returns text
language plpgsql set search_path = ''
as $$
declare a public.agenda; c public.causas; h jsonb; u record; nota text := ''; hoy date := gestor.hoy();
begin
  perform set_config('gestor.autor', p_autor, true);
  select * into a from public.agenda where id = p_id for update;
  if not found then raise exception 'No existe el pedido % en la agenda', p_id; end if;
  if a.estado not in ('pendiente', 'presentando') then
    raise exception 'El pedido % no está pendiente (está "%"): no se anota otra vez', p_id, a.estado;
  end if;
  select * into c from public.causas where expte = a.expte for update;

  if a.realizar <> '' and btrim(c.proxima) = btrim(a.realizar) then
    -- El escrito era la próxima acción anotada: pasa a los movimientos como realizada, con la
    -- fecha en que se presentó, y la causa queda sin próxima acción.
    h := c.historial || jsonb_build_array(jsonb_build_object(
           'fecha', to_char(hoy, 'YYYY-MM-DD'), 'texto', btrim(c.proxima), 'hecha', true));
    select * into u from gestor.ultima_de(h);
    update public.causas set historial = h, ultima = u.ultima, fecha = u.fecha, proxima = '', vence = null, ubicacion = 'A despacho'
     where expte = c.expte;
  else
    if a.realizar <> '' then
      -- Entre que se agendó y hoy, la próxima acción cambió: no se toca, y se avisa.
      nota := case when btrim(c.proxima) = '' then ' La próxima acción ya no estaba anotada.'
                   else format(' La próxima acción no se dio por realizada porque había cambiado (ahora dice "%s").', btrim(c.proxima)) end;
    end if;
    h := c.historial || jsonb_build_array(jsonb_build_object('fecha', to_char(hoy, 'YYYY-MM-DD'), 'texto', btrim(a.titulo)));
    select * into u from gestor.ultima_de(h);
    update public.causas set historial = h, ultima = u.ultima, fecha = u.fecha, ubicacion = 'A despacho'
     where expte = c.expte;
  end if;

  update public.agenda
     set estado = 'presentado', presentado = now(),
         resultado = coalesce(nullif(btrim(p_detalle), ''), 'Presentado en el SAC') || case when a.fecha < hoy then format(' (estaba agendado para el %s).', to_char(a.fecha, 'DD/MM')) else '' end || nota
   where id = p_id;
  return format('Causa %s: "%s" presentado; la causa quedó A despacho.%s', a.expte, a.titulo, nota);
end $$;

-- ───────────────────────── Deshacer, con los campos nuevos ─────────────────────────
-- Igual que en 0006. Una foto de una causa anterior a 0007 se pasa a la forma actual; como la
-- etapa del juicio no existía, queda la que la causa tiene hoy (si todavía existe).
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
  else
    raise exception 'No sé deshacer cambios de la tabla %', c.tabla;
  end if;
  return format('%s %s volvió a como estaba antes del cambio %s (%s, %s)', c.tabla, c.clave, c.id, c.autor,
                to_char(c.momento at time zone 'America/Argentina/Cordoba', 'DD/MM HH24:MI'));
end $$;

-- Nada del esquema privado es alcanzable por los roles de la API (ver 0001).
revoke all on all tables in schema gestor from public, anon, authenticated;
revoke all on all functions in schema gestor from public, anon, authenticated;

-- Que la API vea las columnas nuevas sin esperar.
notify pgrst, 'reload schema';

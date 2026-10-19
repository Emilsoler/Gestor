-- Botón «Ahora» de la app y escritos que la tarea del SAC toma de a uno.
--
-- 1. `agenda.ahora`: cuándo la persona tocó «Ahora» en la app. Ese escrito no espera a la corrida
--    de las 10:15: la función `chat` (ruta `ahora`) lo confirma con fecha de hoy y dispara la
--    tarea programada en el momento, y esa corrida presenta solo lo pedido así.
-- 2. Estado `presentando`: antes de presentar un escrito, la corrida lo toma con
--    gestor.agenda_tomar(), que lo elige y lo marca en una sola operación. Dos corridas a la vez
--    (la de las 10:15 y una del botón, o dos «Ahora» seguidos) nunca presentan el mismo escrito.
--      borrador → pendiente → presentando → presentado | error; o cancelado (antes de que lo tomen).
-- 3. Lo que es para hoy y no se pidió «Ahora» no se toma antes de las 10:15 aunque la tarea se
--    dispare antes: hay escritos que se agendan para esa hora por un plazo.

alter table public.agenda add column ahora timestamptz;
comment on column public.agenda.ahora is
  'Cuándo la persona tocó «Ahora» en la app: se presenta en el momento, sin esperar a la corrida de las 10:15. Vacío: lo presenta la corrida del día (fecha).';

alter table public.agenda drop constraint agenda_estado_check;
alter table public.agenda add constraint agenda_estado_check
  check (estado in ('borrador', 'pendiente', 'presentando', 'presentado', 'error', 'cancelado'));

comment on table public.agenda is
  'Escritos para presentar en el SAC. `fecha`: el día en que se presentan (la tarea diaria toma los pendientes de ese día o atrasados). `ahora`: la persona pidió presentarlo en el momento (botón «Ahora»). `realizar`: si no está vacío, el texto de la próxima acción que se da por realizada al presentar (solo si la causa la sigue teniendo igual). `estado`: borrador (lo armó el chat) → pendiente (la persona lo confirmó en la app) → presentando (una corrida de la tarea lo tomó) → presentado | error; o cancelado. `resultado`: qué pasó al presentarlo.';

select gestor.sin_estadisticas();

-- ───────────────────────── La hora de la tarea ─────────────────────────

-- A qué hora corre la tarea programada los días hábiles. Está también en la tarea programada, en
-- supabase/functions/chat/instrucciones.ts (HORA_TAREA) y en docs/app.js (HORA_SAC): si cambia,
-- cambia en los cuatro.
create function gestor.hora_tarea() returns time
language sql immutable set search_path = ''
as $$ select time '10:15' $$;

-- ───────────────────────── Tomar el próximo escrito ─────────────────────────

-- Si un escrito confirmado ya se puede presentar en un momento dado. Va aparte para poder
-- probar la regla a cualquier hora.
--   p_solo_ahora = true  → corrida del botón «Ahora»: solo lo pedido así.
--   p_solo_ahora = false → corrida de las 10:15: lo pedido «Ahora», lo atrasado y lo de hoy (desde las 10:15).
create function gestor.agenda_a_tiempo(p_fecha date, p_ahora timestamptz, p_solo_ahora boolean, p_momento timestamptz)
returns boolean
language sql stable set search_path = ''
as $$
  with m as (select (p_momento at time zone 'America/Argentina/Cordoba')::date as dia,
                    (p_momento at time zone 'America/Argentina/Cordoba')::time as hora)
  select p_fecha <= m.dia
     and (p_ahora is not null
          or (not p_solo_ahora and (p_fecha < m.dia or m.hora >= gestor.hora_tarea())))
    from m
$$;

-- La corrida toma el próximo escrito y lo deja "presentando", todo junto: si dos corridas lo
-- intentan a la vez, una lo toma y la otra sigue de largo (skip locked) con el siguiente.
create function gestor.agenda_tomar(p_solo_ahora boolean default false, p_autor text default 'Claude')
returns table (id uuid, expte text, caratula text, nominacion text, oficina text, titulo text,
               cuerpo text, fecha date, atrasado boolean, realizar text, ahora boolean)
language plpgsql set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id uuid;
  v_hoy date := gestor.hoy();
begin
  perform set_config('gestor.autor', p_autor, true);
  select a.id into v_id
    from public.agenda a
   where a.estado = 'pendiente' and gestor.agenda_a_tiempo(a.fecha, a.ahora, p_solo_ahora, now())
   order by a.ahora is null, a.ahora, a.fecha, a.creado   -- primero lo pedido «Ahora», en el orden en que se pidió
   limit 1
   for update of a skip locked;
  if v_id is null then return; end if;

  update public.agenda a set estado = 'presentando' where a.id = v_id;

  return query
  select a.id, a.expte,
         (case when c.demandado = '' then c.actor
               else coalesce(nullif(c.actor, ''), 'AMB') || ' c/ ' || c.demandado end)
           || case when c.tipo <> '' then ' – ' || c.tipo else '' end,
         c.nom, c.oficina, a.titulo, a.cuerpo, a.fecha, a.fecha < v_hoy, a.realizar, a.ahora is not null
    from public.agenda a join public.causas c on c.expte = a.expte
   where a.id = v_id;
end $$;
comment on function gestor.agenda_tomar(boolean, text) is
  'Para la tarea que presenta en el SAC: toma el próximo escrito (queda "presentando", ninguna otra corrida lo toma) y devuelve sus datos con los de la causa. Con true, solo lo pedido con el botón «Ahora». Sin filas: no queda nada para presentar. Cada escrito tomado se cierra con agenda_presentada o agenda_fallida.';

comment on function gestor.agenda_del_dia() is
  'Escritos confirmados para presentar hoy (o atrasados) que todavía nadie tomó, con los datos de la causa. Para consultar: la corrida los toma de a uno con gestor.agenda_tomar().';

-- ───────────────────────── Cerrar un escrito tomado ─────────────────────────
-- Igual que en 0005, pero aceptan el escrito ya tomado ("presentando") además del pendiente.

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
    update public.causas set historial = h, ultima = u.ultima, fecha = u.fecha, proxima = '', vence = null, estado = 'A despacho'
     where expte = c.expte;
  else
    if a.realizar <> '' then
      -- Entre que se agendó y hoy, la próxima acción cambió: no se toca, y se avisa.
      nota := case when btrim(c.proxima) = '' then ' La próxima acción ya no estaba anotada.'
                   else format(' La próxima acción no se dio por realizada porque había cambiado (ahora dice "%s").', btrim(c.proxima)) end;
    end if;
    h := c.historial || jsonb_build_array(jsonb_build_object('fecha', to_char(hoy, 'YYYY-MM-DD'), 'texto', btrim(a.titulo)));
    select * into u from gestor.ultima_de(h);
    update public.causas set historial = h, ultima = u.ultima, fecha = u.fecha, estado = 'A despacho'
     where expte = c.expte;
  end if;

  update public.agenda
     set estado = 'presentado', presentado = now(),
         resultado = coalesce(nullif(btrim(p_detalle), ''), 'Presentado en el SAC') || case when a.fecha < hoy then format(' (estaba agendado para el %s).', to_char(a.fecha, 'DD/MM')) else '' end || nota
   where id = p_id;
  return format('Causa %s: "%s" presentado; la causa quedó A despacho.%s', a.expte, a.titulo, nota);
end $$;

create or replace function gestor.agenda_fallida(p_id uuid, p_motivo text, p_autor text default 'Claude')
returns text
language plpgsql set search_path = ''
as $$
declare a public.agenda;
begin
  if coalesce(btrim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  perform set_config('gestor.autor', p_autor, true);
  update public.agenda set estado = 'error', resultado = btrim(p_motivo)
   where id = p_id and estado in ('pendiente', 'presentando') returning * into a;
  if not found then raise exception 'No hay un pedido pendiente con id %', p_id; end if;
  return format('Causa %s: "%s" quedó con error: %s', a.expte, a.titulo, a.resultado);
end $$;

-- ───────────────────────── Deshacer, con la marca «Ahora» ─────────────────────────
-- Igual que en 0005; en la agenda también restaura `ahora`.
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

-- Las funciones nuevas nacen ejecutables por PUBLIC: se les quita, como en 0001.
revoke all on all functions in schema gestor from public, anon, authenticated;

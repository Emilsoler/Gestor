-- Agenda de presentaciones en el SAC y chat con Claude dentro de la app.
--
-- 1. `public.agenda`: escritos para presentar en el SAC en una fecha. El recorrido es siempre
--    el mismo, y nadie se lo saltea:
--      borrador   → lo arma el chat de la app (función `chat` de Supabase) con una plantilla
--                   y los datos de la causa. Todavía no se presenta.
--      pendiente  → la persona lo leyó en la app y tocó "Agendar". Es la única aprobación que vale.
--      presentado → la tarea programada de Claude lo presentó en el SAC desde la compu del
--                   estudio y lo anotó con gestor.agenda_presentada (la causa queda "A despacho").
--      error      → la tarea no pudo presentarlo (gestor.agenda_fallida dice por qué).
--      cancelado  → descartado o cancelado por la persona.
-- 2. `gestor.autor()` firma como "Claude" lo que cambia el chat de la app, que pide a la API con
--    la sesión de la persona y el encabezado `x-gestor-via: chat`.

-- ───────────────────────── Agenda ─────────────────────────

create table public.agenda (
  id              uuid primary key default gen_random_uuid(),
  -- Si la causa cambia de expediente (uno provisorio por el real), la sigue; si se elimina, se va con ella.
  expte           text not null references public.causas (expte) on update cascade on delete cascade,
  titulo          text not null check (btrim(titulo) <> '' and length(titulo) <= 500),
  cuerpo          text not null check (btrim(cuerpo) <> '' and length(cuerpo) <= 50000),
  fecha           date not null,
  realizar        text not null default '',
  estado          text not null default 'borrador'
                  check (estado in ('borrador', 'pendiente', 'presentado', 'error', 'cancelado')),
  resultado       text not null default '',
  presentado      timestamptz,
  creado          timestamptz not null default now(),
  rev             bigint not null default 0,
  actualizado     timestamptz not null default now(),
  actualizado_por text not null default ''
);
create index agenda_por_causa on public.agenda (expte);
create index agenda_pendientes on public.agenda (fecha) where estado = 'pendiente';
comment on table public.agenda is
  'Escritos para presentar en el SAC. `fecha`: el día en que se presentan (la tarea diaria toma los pendientes de ese día o atrasados). `realizar`: si no está vacío, el texto de la próxima acción que se da por realizada al presentar (solo si la causa la sigue teniendo igual). `estado`: borrador (lo armó el chat) → pendiente (la persona lo confirmó en la app) → presentado | error; o cancelado. `resultado`: qué pasó al presentarlo.';

create trigger sello before insert or update on public.agenda for each row execute function gestor.tg_sello();
create trigger auditar after insert or update or delete on public.agenda for each row execute function gestor.tg_auditar('id');

alter table public.agenda enable row level security;
create policy solo_miembros on public.agenda for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));

-- Igual que las otras tablas: los permisos por defecto de Supabase le darían todo a anon.
revoke all on public.agenda from public, anon, authenticated;
grant select, insert, update, delete on public.agenda to authenticated;
grant all on public.agenda to service_role;

do $$
begin
  alter publication supabase_realtime add table public.agenda;
exception when undefined_object or duplicate_object then null;
end $$;

-- La agenda también queda sin estadísticas del planificador (ver 0001).
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
     where n.nspname = 'public' and c.relname in ('causas', 'acuerdos', 'plantillas', 'agenda')
       and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('alter table public.%I alter column %I set statistics 0', r.relname, r.attname);
  end loop;
end $$;
comment on function gestor.sin_estadisticas() is
  'Desactiva las estadísticas del planificador en todas las columnas de causas, acuerdos, plantillas y agenda. Volver a llamarla en cada migración que agregue columnas.';
select gestor.sin_estadisticas();

-- ───────────────────────── Autoría de los cambios del chat ─────────────────────────

create or replace function gestor.autor() returns text
language plpgsql stable security definer set search_path = ''
as $$
declare v text;
begin
  v := nullif(current_setting('gestor.autor', true), '');
  if v is not null then return v; end if;
  if (select auth.uid()) is not null then
    -- El chat de la app pide a la API con la sesión de la persona y este encabezado: lo que
    -- cambie queda firmado como Claude. Solo cuenta para cuentas autorizadas (las demás no pasan
    -- de la puerta de la API), así que no abre nada: solo dice quién hizo el cambio.
    if coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-gestor-via', '') = 'chat' then
      return 'Claude';
    end if;
    select coalesce(nullif(m.nombre, ''), m.email) into v
      from gestor.miembros m where m.user_id = (select auth.uid());
    return coalesce(v, (select auth.jwt()) ->> 'email', 'usuario');
  end if;
  return 'SQL directo';
end $$;

-- ───────────────────────── Funciones para la tarea que presenta en el SAC ─────────────────────────

-- Lo que hay que presentar hoy: los pedidos confirmados con fecha de hoy o anterior (atrasados).
create function gestor.agenda_del_dia()
returns table (id uuid, expte text, caratula text, nominacion text, oficina text,
               titulo text, cuerpo text, fecha date, atrasado boolean, realizar text)
language sql stable set search_path = ''
as $$
  select a.id, a.expte,
         (case when c.demandado = '' then c.actor
               else coalesce(nullif(c.actor, ''), 'AMB') || ' c/ ' || c.demandado end)
           || case when c.tipo <> '' then ' – ' || c.tipo else '' end,
         c.nom, c.oficina, a.titulo, a.cuerpo, a.fecha, a.fecha < gestor.hoy(), a.realizar
    from public.agenda a join public.causas c on c.expte = a.expte
   where a.estado = 'pendiente' and a.fecha <= gestor.hoy()
   order by a.fecha, a.creado;
$$;
comment on function gestor.agenda_del_dia() is
  'Escritos confirmados para presentar hoy (o atrasados), con los datos de la causa para buscarla en el SAC.';

-- Después de presentar el escrito en el SAC: lo anota en la causa y cierra el pedido, todo junto.
create function gestor.agenda_presentada(p_id uuid, p_detalle text default '', p_autor text default 'Claude')
returns text
language plpgsql set search_path = ''
as $$
declare a public.agenda; c public.causas; h jsonb; u record; nota text := ''; hoy date := gestor.hoy();
begin
  perform set_config('gestor.autor', p_autor, true);
  select * into a from public.agenda where id = p_id for update;
  if not found then raise exception 'No existe el pedido % en la agenda', p_id; end if;
  if a.estado <> 'pendiente' then
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
comment on function gestor.agenda_presentada(uuid, text, text) is
  'Para la tarea que presenta en el SAC, después de presentar: anota el movimiento (o da por realizada la próxima acción, si así se pidió y sigue igual), deja la causa A despacho y marca el pedido como presentado.';

-- Si no se pudo presentar: queda el motivo a la vista y la persona decide qué hacer.
create function gestor.agenda_fallida(p_id uuid, p_motivo text, p_autor text default 'Claude')
returns text
language plpgsql set search_path = ''
as $$
declare a public.agenda;
begin
  if coalesce(btrim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  perform set_config('gestor.autor', p_autor, true);
  update public.agenda set estado = 'error', resultado = btrim(p_motivo)
   where id = p_id and estado = 'pendiente' returning * into a;
  if not found then raise exception 'No hay un pedido pendiente con id %', p_id; end if;
  return format('Causa %s: "%s" quedó con error: %s', a.expte, a.titulo, a.resultado);
end $$;
comment on function gestor.agenda_fallida(uuid, text, text) is
  'Para la tarea que presenta en el SAC: deja el pedido con error y el motivo, sin tocar la causa.';

-- ───────────────────────── Deshacer, también en la agenda ─────────────────────────
-- Igual que en 0003, más la agenda.
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
    insert into public.agenda (id, expte, titulo, cuerpo, fecha, realizar, estado, resultado, presentado, creado)
    select r.id, r.expte, r.titulo, r.cuerpo, r.fecha, r.realizar, r.estado, r.resultado, r.presentado, r.creado
      from jsonb_populate_record(null::public.agenda, c.antes) r
    on conflict (id) do update set
      expte = excluded.expte, titulo = excluded.titulo, cuerpo = excluded.cuerpo, fecha = excluded.fecha, realizar = excluded.realizar,
      estado = excluded.estado, resultado = excluded.resultado, presentado = excluded.presentado, creado = excluded.creado;
  else
    raise exception 'No sé deshacer cambios de la tabla %', c.tabla;
  end if;
  return format('%s %s volvió a como estaba antes del cambio %s (%s, %s)', c.tabla, c.clave, c.id, c.autor,
                to_char(c.momento at time zone 'America/Argentina/Cordoba', 'DD/MM HH24:MI'));
end $$;

-- Las funciones nuevas nacen ejecutables por PUBLIC: se les quita, como en 0001.
revoke all on all functions in schema gestor from public, anon, authenticated;

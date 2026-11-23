-- Estados de la solicitud de crédito de una agencia: se suma «En análisis» (pedido de la persona del 23/11/2026).
--
-- Recorrido que ve la agencia en «Mis solicitudes»:
--   pendiente (se muestra «Recibida») → en_analisis → aprobada | rechazada
-- «cargando» sigue siendo interno (la agencia todavía sube archivos) y no lo ve nadie.
--
-- «En análisis» no es una resolución: no pone `resuelto` ni `resuelto_por`, y la solicitud sigue contando como
-- abierta (no deja mandar otra del mismo cliente mientras tanto).

do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.solicitudes_credito'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%pendiente%' loop
    execute format('alter table public.solicitudes_credito drop constraint %I', c);
  end loop;
end $$;
alter table public.solicitudes_credito add constraint solicitudes_credito_estado_check
  check (estado in ('cargando', 'pendiente', 'en_analisis', 'aprobada', 'rechazada'));

comment on table public.solicitudes_credito is
  'Solicitudes de aprobación de crédito que mandan las agencias desde el cotizador. `estado`: cargando (la agencia sube archivos; interno) | pendiente (la agencia la ve «Recibida») | en_analisis | aprobada | rechazada; los tres últimos los decide la Mutual. Sin valor del vehículo ni CODIA.';

-- Igual que en 0028; solo cambia qué estados dejan la solicitud sin resolver.
create or replace function gestor.tg_solicitud_resuelta() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.estado is distinct from old.estado and 'cargando' in (old.estado, new.estado)
     and coalesce(current_setting('gestor.solicitud_envio', true), '') <> 'si' then
    raise exception 'Esa solicitud todavía la está cargando la agencia.' using errcode = '22023';
  end if;
  if new.estado is distinct from old.estado then
    if new.estado in ('pendiente', 'en_analisis', 'cargando') then new.resuelto := null; new.resuelto_por := '';
    else new.resuelto := now(); new.resuelto_por := gestor.autor(); end if;
  end if;
  return new;
end $$;

-- Igual que en 0028; solo cambia que una solicitud «En análisis» también cuenta como abierta.
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
  if exists (select 1 from public.solicitudes_credito s where s.agencia_id = a.id and s.cuit = c.cuit and s.estado in ('pendiente', 'en_analisis')) then
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
revoke all on function public.agencia_solicitar(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.agencia_solicitar(uuid, uuid, jsonb) to service_role;

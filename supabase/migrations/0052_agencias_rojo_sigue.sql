-- 0052 · Una consulta en rojo del BCRA ya no frena la solicitud (pedido de la persona del 25/11/2026).
-- A veces la Central informa una deuda que ya está paga y todavía no se actualizó el estado del deudor: la agencia sigue,
-- lo aclara en «Notas y aclaraciones» (datos.notas) y, si hace falta, adjunta un libre deuda. La Mutual decide al revisar.
-- Es igual a la función de 0042; lo único que cambia es que 'rojo' deja de ser un error. La solicitud guarda el color rojo
-- (solicitudes_credito.semaforo no tiene restricción de valores) y la Mutual lo ve en su círculo.
create or replace function public.agencia_solicitar(p_user uuid, p_consulta uuid, p_datos jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; v_vend uuid; c public.consultas_bcra; maximo numeric; v_rel numeric; v_ingreso numeric; v_id uuid; borrar jsonb;
begin
  select * into a from public.agencia_de(p_user);
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  v_vend := public.vendedor_de(p_user);
  select * into c from public.consultas_bcra where id = p_consulta and consultado_por = 'Agencia · ' || a.nombre;
  if not found or c.momento < now() - interval '3 days' then return jsonb_build_object('error', 'consulta'); end if;
  if c.semaforo not in ('verde', 'amarillo', 'rojo', 'sin_datos') then return jsonb_build_object('error', 'semaforo'); end if;
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
  -- Las que quedaron a medio cargar: las de este vendedor para ese cliente, o cualquiera de hace más de 2 días.
  with x as (
    delete from public.solicitudes_credito s
     where s.agencia_id = a.id and s.estado = 'cargando'
       and ((s.cuit = c.cuit and s.vendedor_id is not distinct from v_vend) or s.momento < now() - interval '2 days')
    returning s.archivos)
  select coalesce(jsonb_agg(e->>'path'), '[]'::jsonb) into borrar from x cross join lateral jsonb_array_elements(x.archivos) e;

  insert into public.solicitudes_credito (agencia_id, vendedor_id, agencia, cuit, denominacion, consulta, semaforo, cliente, vehiculo, anio, monto, cuotas,
                                          cuota, total, tasa, cft, estado, ingreso, relacion, categoria, datos)
  values (a.id, v_vend, a.nombre, c.cuit, c.denominacion, c.id, c.semaforo, left(coalesce(p_datos->>'cliente', ''), 300),
          left(coalesce(p_datos->>'vehiculo', ''), 200), left(coalesce(p_datos->>'anio', ''), 10),
          (p_datos->>'monto')::numeric, (p_datos->>'cuotas')::int, (p_datos->>'cuota')::numeric, (p_datos->>'total')::numeric,
          (p_datos->>'tasa')::numeric, (p_datos->>'cft')::numeric, 'cargando', v_ingreso, v_rel, p_datos->>'categoria',
          coalesce(p_datos->'datos', '{}'::jsonb))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'borrar', borrar);
end $$;

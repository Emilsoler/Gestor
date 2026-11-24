-- «Ver mi solicitud» (pedido de la persona del 24/11/2026): la agencia abre una solicitud que mandó y ve lo que envió.
-- Cada vendedor ve solo las suyas (igual que agencia_solicitudes, 0042). Es lo que la agencia misma cargó (crédito, ingresos,
-- datos del cliente) y el nombre de los archivos que subió. NUNCA devuelve `datos.pct_valor` (el % del valor del vehículo:
-- permitiría deducir el valor de InfoAuto), ni la ruta de los archivos en el almacenamiento, ni enlaces: no se pueden abrir.
create or replace function public.agencia_solicitud(p_user uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select to_jsonb(x) from (
    select s.id, coalesce(s.enviada, s.momento) as momento, s.cuit, s.denominacion, s.semaforo, s.vehiculo, s.anio,
           s.monto, s.cuotas, s.cuota, s.total, s.tasa, s.cft, s.ingreso, s.relacion, s.categoria,
           s.estado, s.nota, s.resuelto,
           coalesce(s.datos, '{}'::jsonb) - 'pct_valor' as datos,
           coalesce((select jsonb_agg(jsonb_build_object('nombre', a->>'nombre', 'tipo', a->>'tipo', 'tamano', a->'tamano'))
                       from jsonb_array_elements(case when jsonb_typeof(s.archivos) = 'array' then s.archivos else '[]'::jsonb end) a),
                    '[]'::jsonb) as archivos
      from public.solicitudes_credito s
     where s.id = p_id and s.vendedor_id = public.vendedor_de(p_user) and s.estado <> 'cargando') x;
$$;
revoke all on function public.agencia_solicitud(uuid, uuid) from public, anon, authenticated;
grant execute on function public.agencia_solicitud(uuid, uuid) to service_role;

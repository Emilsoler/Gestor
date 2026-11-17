-- Cotizador para agencias (pedido de la persona, 17/11/2026):
--   * En un 0 km se adjunta la factura del vehículo en lugar del título (casillero `factura`, obligatorio).
--     El título ya no es opcional en ningún caso: va en los usados y no en los 0 km.
--   * La cuenta donde se deposita el crédito puede ser del cliente o de un tercero: `datos.cuenta` es
--     propia | terceros y, si es de un tercero, `cuenta_titular`, `cuenta_cuit` y `cuenta_relacion` (opcional).
--     Eso lo controlan la app y la función (solicitud.js); acá solo cambian los casilleros de documentos.

create or replace function gestor.docs_requeridos(p_categoria text, p_anio text) returns text[]
language sql immutable set search_path = ''
as $$
  select case p_categoria when 'dependencia' then array['recibos'] when 'monotributo' then array['constancia', 'pagos']
                          when 'inscripto' then array['constancia', 'iva', 'ganancias'] else array[]::text[] end
      || array['dni'] || case when p_anio = '0km' then array['factura'] else array['titulo'] end || array['servicio', 'cbu'];
$$;

create or replace function gestor.docs_maximo(p_slot text) returns int
language sql immutable set search_path = ''
as $$
  select case p_slot when 'recibos' then 6 when 'constancia' then 2 when 'pagos' then 6 when 'iva' then 12 when 'ganancias' then 3
                     when 'dni' then 2 when 'titulo' then 4 when 'factura' then 4 when 'servicio' then 2 when 'cbu' then 2 else 0 end;
$$;

-- Solo los casilleros de esa solicitud (ya no hay casilleros opcionales).
create or replace function public.agencia_archivo(p_user uuid, p_id uuid, p_archivo jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.agencias; s public.solicitudes_credito; v_slot text := p_archivo->>'slot'; n int; n_slot int;
begin
  select * into a from public.agencias where user_id = p_user and activa;
  if not found then raise exception 'sin acceso' using errcode = '42501'; end if;
  select * into s from public.solicitudes_credito where id = p_id and agencia_id = a.id for update;
  if not found or s.estado <> 'cargando' then return jsonb_build_object('error', 'solicitud'); end if;
  if v_slot is null or not (v_slot = any (gestor.docs_requeridos(s.categoria, s.anio))) then
    return jsonb_build_object('error', 'slot');
  end if;
  if left(coalesce(p_archivo->>'path', ''), 37) <> p_id::text || '/' then return jsonb_build_object('error', 'path'); end if;
  select count(*), count(*) filter (where e->>'slot' = v_slot) into n, n_slot from jsonb_array_elements(s.archivos) e;
  if n >= 40 or n_slot >= gestor.docs_maximo(v_slot) then return jsonb_build_object('error', 'cantidad'); end if;
  perform set_config('gestor.autor', 'Agencia · ' || a.nombre, true);
  update public.solicitudes_credito
     set archivos = archivos || jsonb_build_array(jsonb_build_object(
           'slot', v_slot, 'nombre', left(coalesce(p_archivo->>'nombre', ''), 120), 'path', p_archivo->>'path',
           'tipo', p_archivo->>'tipo', 'tamano', (p_archivo->>'tamano')::bigint, 'sha256', p_archivo->>'sha256', 'subido', now()))
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.agencia_archivo(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.agencia_archivo(uuid, uuid, jsonb) to service_role;
revoke all on function gestor.docs_requeridos(text, text), gestor.docs_maximo(text) from public;

comment on column public.solicitudes_credito.datos is
  'Datos del cliente: {dni, domicilio, estado_civil: soltero|casado, matrimonio_lugar, matrimonio_fecha, celular, cbu, cuenta: propia|terceros, cuenta_titular, cuenta_cuit, cuenta_relacion}.';
comment on column public.solicitudes_credito.archivos is
  'Documentos: [{slot, nombre, path, tipo, tamano, sha256, subido}]. `path` dentro de la carpeta `solicitudes` del almacenamiento; `slot` es el casillero (recibos, constancia, pagos, iva, ganancias, dni, titulo, factura, servicio, cbu).';

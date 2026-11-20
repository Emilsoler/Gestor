-- Cotizador para agencias (pedido de la persona, 20/11/2026): la agencia sube toda la documentación junta, en un solo
-- recuadro, en vez de un casillero por documento (DNI, recibos, título, servicio, CBU…).
--   * Un casillero nuevo, `documentacion`, hasta 40 archivos (el tope por solicitud, que ya existía).
--   * Es el único que admite una solicitud nueva (gestor.docs_requeridos). Sigue sin ser obligatorio enviarla con archivos.
--   * Los casilleros anteriores no se borran de docs_maximo: las solicitudes ya enviadas conservan sus archivos con
--     el casillero de entonces (`archivos[].slot`) y la Mutual los sigue viendo agrupados así.
-- Las reglas de la app y de la función están en docs/agencias/solicitud.js (copia exacta en la función); las pruebas
-- comparan las tres.

create or replace function gestor.docs_requeridos(p_categoria text, p_anio text) returns text[]
language sql immutable set search_path = ''
as $$
  select array['documentacion'];
$$;

create or replace function gestor.docs_maximo(p_slot text) returns int
language sql immutable set search_path = ''
as $$
  select case p_slot when 'documentacion' then 40
                     when 'recibos' then 6 when 'constancia' then 2 when 'pagos' then 6 when 'iva' then 12 when 'ganancias' then 3
                     when 'dni' then 2 when 'titulo' then 4 when 'factura' then 4 when 'servicio' then 2 when 'cbu' then 2 else 0 end;
$$;

revoke all on function gestor.docs_requeridos(text, text), gestor.docs_maximo(text) from public;

comment on column public.solicitudes_credito.archivos is
  'Documentos: [{slot, nombre, path, tipo, tamano, sha256, subido}]. `path` dentro de la carpeta `solicitudes` del almacenamiento; `slot` es `documentacion` (desde el 20/11/2026, todo junto) o, en las anteriores, el casillero (recibos, constancia, pagos, iva, ganancias, dni, titulo, factura, servicio, cbu).';

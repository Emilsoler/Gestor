-- La Mutual puede eliminar cotizaciones de agencias del registro (pedido de la persona, 17/11/2026): una por una o toda la lista.
-- Es solo un registro de simulaciones (sin valor del vehículo ni CODIA, sin datos del cliente), por eso se borra por la API con la
-- misma barrera de siempre (es_miembro); no queda historial en gestor.cambios, como al crearlas. Las agencias no tienen acceso.
-- Ojo: el tope diario de cada agencia cuenta estas filas, así que borrar las de hoy le devuelve cotizaciones del día.
create policy miembros_eliminan on public.cotizaciones_agencia for delete to authenticated
  using ((select public.es_miembro()));
grant delete on public.cotizaciones_agencia to authenticated;

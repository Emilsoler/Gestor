-- Sin conexión con ARCA: la persona pidió quitar lo de la migración 0014 (el certificado, el permiso de WSAA y
-- la constancia que la función `bcra` sumaba a la consulta por CUIT). La constancia de inscripción se mira en
-- la consulta pública de ARCA, con el botón «Constancia en ARCA» de la vista Créditos de Cobranzas, que solo
-- abre esa página: la app no le pregunta nada a ARCA ni guarda lo que responde.
--
-- Se borran el certificado y el permiso guardados, y la API ya no llega a las dos funciones que los leían y
-- escribían. La tabla y las funciones quedan vacías y sin uso: borrarlas (`drop`) pide una confirmación de la
-- persona que desde acá no llega (como en 0007); se pueden quitar en una migración aparte.

update gestor.arca set certificado = '', ticket = null, actualizado = now() where id = 1;

revoke all on function public.arca_config() from public, anon, authenticated;
revoke all on function public.arca_guardar_ticket(jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';

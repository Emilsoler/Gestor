-- Cierra el permiso por defecto («cualquiera puede ejecutar») de las funciones que creó 0042.
-- Hoy no se podían llamar desde la API (el esquema gestor no tiene USAGE para anon/authenticated), pero
-- las otras barreras no deben depender de esa: las funciones de gestor solo las usan postgres y service_role.
revoke all on function gestor.autorizar_vendedor(text, text, text), gestor.pausar_vendedor(text),
  gestor.tg_vendedores_reglas(), gestor.tg_agencias_clave() from public, anon, authenticated;

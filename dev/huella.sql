-- Huella de lo que define supabase/migrations en una base: una fila por categoría.
-- Sirve para comprobar que el proyecto real quedó igual a lo probado en local: se corre acá
-- (dev/stack.sh psql -f dev/huella.sql) y allá (execute_sql del conector) y se comparan las filas.
with fn as (
  select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as objeto,
         md5(p.prosrc) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || l.lanname as huella
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
   where n.nspname = 'gestor' or (n.nspname = 'public' and p.proname in ('es_miembro', 'mi_acceso', 'clave_definida', 'gestor_puerta'))
), col as (
  select c.table_schema || '.' || c.table_name || '.' || c.column_name as objeto,
         c.data_type || '|' || c.is_nullable || '|' || coalesce(c.column_default, '') || '|' || case when coalesce(a.attstattarget, -1) = -1 then 'defecto' else a.attstattarget::text end as huella  -- (el valor por defecto es -1 en Postgres 16 y null en 17)
    from information_schema.columns c
    join pg_attribute a on a.attrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass and a.attname = c.column_name
   where (c.table_schema = 'gestor' and c.table_name in ('miembros', 'cambios'))
      or (c.table_schema = 'public' and c.table_name in ('causas', 'acuerdos', 'plantillas'))
), res as (
  select conrelid::regclass::text || '.' || conname as objeto, pg_get_constraintdef(oid) as huella
    from pg_constraint
   where conrelid in ('gestor.miembros'::regclass, 'gestor.cambios'::regclass, 'public.causas'::regclass, 'public.acuerdos'::regclass, 'public.plantillas'::regclass)
), pol as (
  select schemaname || '.' || tablename || '.' || policyname as objeto,
         cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '') as huella
    from pg_policies where schemaname in ('public', 'gestor')
), rls as (
  select c.oid::regclass::text as objeto, c.relrowsecurity::text || '|' || c.relforcerowsecurity::text as huella
    from pg_class c where c.oid in ('gestor.miembros'::regclass, 'gestor.cambios'::regclass, 'public.causas'::regclass, 'public.acuerdos'::regclass, 'public.plantillas'::regclass)
), trg as (
  select tgrelid::regclass::text || '.' || tgname as objeto, pg_get_triggerdef(oid) as huella
    from pg_trigger where not tgisinternal and tgname in ('sello', 'auditar')
), per as (
  select r.rol || ' en ' || t.oid::regclass::text as objeto,
         concat_ws(',', case when has_table_privilege(r.rol, t.oid, 'select') then 'select' end,
                        case when has_table_privilege(r.rol, t.oid, 'insert') then 'insert' end,
                        case when has_table_privilege(r.rol, t.oid, 'update') then 'update' end,
                        case when has_table_privilege(r.rol, t.oid, 'delete') then 'delete' end,
                        case when has_table_privilege(r.rol, t.oid, 'truncate') then 'truncate' end) as huella
    from (values ('anon'), ('authenticated')) r(rol),
         pg_class t where t.oid in ('gestor.miembros'::regclass, 'gestor.cambios'::regclass, 'gestor.usuarios'::regclass, 'public.causas'::regclass, 'public.acuerdos'::regclass, 'public.plantillas'::regclass)
), eje as (
  select r.rol || ' ejecuta ' || p.oid::regprocedure::text as objeto, has_function_privilege(r.rol, p.oid, 'execute')::text as huella
    from (values ('anon'), ('authenticated')) r(rol), pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'gestor' or (n.nspname = 'public' and p.proname in ('es_miembro', 'mi_acceso', 'clave_definida', 'gestor_puerta'))
), uso as (
  select r.rol || ' usa ' || s.esq as objeto, has_schema_privilege(r.rol, s.esq, 'usage')::text as huella
    from (values ('anon'), ('authenticated')) r(rol), (values ('gestor'), ('public')) s(esq)
), pub as (
  select schemaname || '.' || tablename as objeto, 'publicada' as huella from pg_publication_tables where pubname = 'supabase_realtime'
), rol as (
  select 'authenticator' as objeto, coalesce((select string_agg(c, ';' order by c) from unnest(rolconfig) c where c like 'pgrst.%'), '') as huella
    from pg_roles where rolname = 'authenticator'
)
select categoria, count(*) as objetos, md5(string_agg(objeto || '=' || huella, E'\n' order by objeto)) as huella
  from (select 'funciones' as categoria, * from fn
        union all select 'columnas', * from col
        union all select 'restricciones', * from res
        union all select 'politicas', * from pol
        union all select 'rls', * from rls
        union all select 'triggers', * from trg
        union all select 'permisos de tablas', * from per
        union all select 'permisos de funciones', * from eje
        union all select 'uso de esquemas', * from uso
        union all select 'tiempo real', * from pub
        union all select 'rol de la api', * from rol) t
 group by categoria order by categoria;

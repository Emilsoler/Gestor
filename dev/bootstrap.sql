-- Deja un Postgres local parecido a un proyecto nuevo de Supabase:
-- mismos roles, esquemas, extensiones y permisos por defecto.
-- Se corre una sola vez como superusuario (supabase_admin). Solo para pruebas.

create role postgres login createdb createrole replication bypassrls password 'postgres';
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit password 'postgres';
grant anon, authenticated, service_role to authenticator;
create role supabase_auth_admin login noinherit createrole password 'postgres';
create role dashboard_user nologin;

-- En Supabase, postgres puede actuar como los roles de la API.
grant anon, authenticated, service_role to postgres with admin option;

alter database postgres owner to postgres;
alter schema public owner to postgres;

create schema if not exists extensions authorization postgres;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
grant usage on schema extensions to public;
alter database postgres set search_path to "$user", public, extensions;

grant usage on schema public to anon, authenticated, service_role;
-- Permisos por defecto de Supabase sobre lo que cree postgres en public.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;

-- Esquema de autenticación: lo administra GoTrue.
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role, postgres;
alter role supabase_auth_admin set search_path = auth;
-- Igual que en la plataforma: postgres puede leer y modificar filas de auth, no su estructura.
alter default privileges for role supabase_auth_admin in schema auth grant all on tables to postgres, dashboard_user;
alter default privileges for role supabase_auth_admin in schema auth grant all on sequences to postgres, dashboard_user;
alter default privileges for role supabase_auth_admin in schema auth grant execute on functions to postgres, dashboard_user;

-- Publicación que usa Realtime.
create publication supabase_realtime;
alter publication supabase_realtime owner to postgres;

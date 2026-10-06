// Utilidades comunes de las pruebas: claves del stack local, SQL como `postgres`
// (el mismo rol que usa el conector de Supabase) y clientes de la API.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const STACK = process.env.STACK || '/home/claude/.stack';
export const env = Object.fromEntries(
  readFileSync(`${STACK}/keys.env`, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

/** Corre SQL como el rol `postgres` y devuelve la salida (una fila por línea, columnas con |). */
export function sql(q) {
  return execFileSync(
    'psql',
    ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '54322', '-U', 'postgres', '-d', 'postgres', '-c', q],
    { env: { ...process.env, PGPASSWORD: 'postgres' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}
export function sqlFalla(q) {
  try { sql(q); } catch (e) { return String(e.stderr || e.message); }
  throw new Error('se esperaba un error de SQL y no lo hubo: ' + q);
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
export const anon = () => createClient(env.SUPABASE_URL, env.ANON_KEY, opts);
export const servicio = () => createClient(env.SUPABASE_URL, env.SERVICE_KEY, opts);

/**
 * Crea una cuenta como se hace en el proyecto real (por el servicio de login, con la API de
 * administración, que es lo que usa el panel de Supabase) y la autoriza a usar el gestor.
 */
export async function crearCuenta(email, clave, nombre = '', temporal = false) {
  const { error } = await servicio().auth.admin.createUser({ email, password: clave, email_confirm: true });
  if (error) throw new Error(`crear ${email}: ${error.message}`);
  return sql(`select gestor.autorizar('${email}', '${nombre}', ${temporal})`);
}

/** Cliente con sesión iniciada. */
export async function entrar(email, clave) {
  const c = anon();
  const { data, error } = await c.auth.signInWithPassword({ email, password: clave });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return Object.assign(c, { sesion: data.session });
}

/** Deja la base sin datos de prueba. */
export function limpiar() {
  sql(`delete from public.causas; delete from public.acuerdos; delete from public.plantillas;
       delete from gestor.cambios; delete from auth.users;`);
}

#!/usr/bin/env bash
# Entorno local de pruebas: Postgres + GoTrue (login) + PostgREST (API), los mismos
# servicios que corre Supabase, detrás de una puerta de entrada en 127.0.0.1:54321.
#
#   dev/stack.sh up      crea (si hace falta) y levanta todo, aplica las migraciones
#   dev/stack.sh down    detiene todo
#   dev/stack.sh reset   borra la base local y la vuelve a crear desde cero
#   dev/stack.sh psql    abre psql como el rol `postgres` (el mismo que usa el conector)
#
# Requiere los binarios en $STACK/bin (ver dev/README.md).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
STACK="${STACK:-/home/claude/.stack}"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-/var/lib/postgresql/gestor-test}"
PGPORT=54322
JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"
LOGS="$STACK/logs"
mkdir -p "$LOGS"

as_pg() { runuser -u postgres -- "$@"; }
sql_admin() { psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $PGPORT -U supabase_admin -d postgres "$@"; }
sql_pg() { PGPASSWORD=postgres psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $PGPORT -U postgres -d postgres "$@"; }

jwt() { # jwt <role>
  node -e '
    const c=require("crypto"),b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
    const d=b({alg:"HS256",typ:"JWT"})+"."+b({role:process.argv[1],iss:"supabase",iat:1700000000,exp:4102444800});
    console.log(d+"."+c.createHmac("sha256",process.argv[2]).update(d).digest("base64url"))' "$1" "$JWT_SECRET"
}

stop_one() { # detiene el servicio y espera a que libere su puerto
  local pid; pid="$(cat "$STACK/$1.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$STACK/$1.pid"
}

down() {
  stop_one gateway; stop_one postgrest; stop_one gotrue
  if [ -d "$PGDATA" ]; then as_pg "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true; fi
}

up() {
  local fresh=0
  if [ ! -d "$PGDATA" ]; then
    fresh=1
    install -d -o postgres -g postgres "$PGDATA"
    as_pg "$PGBIN/initdb" -D "$PGDATA" -U supabase_admin --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
  fi
  if ! as_pg "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    as_pg "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -c listen_addresses=127.0.0.1 -c timezone=UTC" -l /tmp/gestor-pg.log -w start >/dev/null
  fi
  [ $fresh = 1 ] && sql_admin -f "$HERE/bootstrap.sql"

  ANON_KEY="$(jwt anon)"; SERVICE_KEY="$(jwt service_role)"
  cat > "$STACK/keys.env" <<EOF
SUPABASE_URL=http://127.0.0.1:54321
ANON_KEY=$ANON_KEY
SERVICE_KEY=$SERVICE_KEY
JWT_SECRET=$JWT_SECRET
EOF

  # GoTrue
  stop_one gotrue
  (
    cd "$STACK/auth"
    export GOTRUE_API_HOST=127.0.0.1 GOTRUE_API_PORT=9999 API_EXTERNAL_URL=http://127.0.0.1:54321/auth/v1
    export GOTRUE_DB_DRIVER=postgres DB_NAMESPACE=auth
    export DATABASE_URL="postgres://supabase_auth_admin:postgres@127.0.0.1:$PGPORT/postgres"
    export GOTRUE_DB_DATABASE_URL="$DATABASE_URL"
    export GOTRUE_SITE_URL=http://127.0.0.1:8080 GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP=3600
    export GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role
    export GOTRUE_DISABLE_SIGNUP=false GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=false
    export GOTRUE_RATE_LIMIT_TOKEN_REFRESH=10000 GOTRUE_RATE_LIMIT_VERIFY=10000
    ./auth migrate > "$LOGS/gotrue-migrate.log" 2>&1
    nohup setsid ./auth serve > "$LOGS/gotrue.log" 2>&1 &
    echo $! > "$STACK/gotrue.pid"
  )

  # Migraciones de la app, como el rol postgres (igual que el conector de Supabase).
  for f in "$REPO"/supabase/migrations/*.sql; do
    [ -e "$f" ] || continue
    local name; name="$(basename "$f")"
    if ! sql_admin -Atc "select 1 from pg_tables where schemaname='public' and tablename='_migraciones_locales'" | grep -q 1; then
      sql_admin -c "create table public._migraciones_locales(nombre text primary key); revoke all on public._migraciones_locales from anon, authenticated;"
    fi
    if ! sql_admin -Atc "select 1 from public._migraciones_locales where nombre='$name'" | grep -q 1; then
      echo "aplicando $name"; sql_pg -f "$f"; sql_admin -c "insert into public._migraciones_locales values ('$name')"
    fi
  done

  # Solo local: cada cambio avisa por NOTIFY al doble de Realtime de la puerta de entrada.
  sql_admin <<'SQL'
create or replace function public._rt_local() returns trigger language plpgsql as $$
begin perform pg_notify('gestor_rt', tg_table_name); return null; end $$;
do $$ declare t text; begin
  foreach t in array array['causas','acuerdos','plantillas'] loop
    if to_regclass('public.' || t) is not null and not exists
       (select 1 from pg_trigger where tgname = '_rt_local' and tgrelid = to_regclass('public.' || t)) then
      execute format('create trigger _rt_local after insert or update or delete on public.%I for each statement execute function public._rt_local()', t);
    end if;
  end loop;
end $$;
SQL

  # PostgREST
  stop_one postgrest
  PGRST_DB_URI="postgres://authenticator:postgres@127.0.0.1:$PGPORT/postgres" \
  PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$JWT_SECRET" \
  PGRST_DB_EXTRA_SEARCH_PATH="public,extensions" PGRST_DB_MAX_ROWS=1000 \
  PGRST_SERVER_HOST=127.0.0.1 PGRST_SERVER_PORT=3000 \
    nohup setsid "$STACK/bin/postgrest" > "$LOGS/postgrest.log" 2>&1 &
  echo $! > "$STACK/postgrest.pid"

  # Puerta de entrada
  stop_one gateway
  API_KEYS="$ANON_KEY,$SERVICE_KEY" nohup setsid node "$HERE/gateway.mjs" > "$LOGS/gateway.log" 2>&1 &
  echo $! > "$STACK/gateway.pid"

  for i in $(seq 1 40); do
    if curl -s -o /dev/null -m 2 -H "apikey: $ANON_KEY" http://127.0.0.1:54321/auth/v1/health \
       && curl -s -o /dev/null -m 2 -H "apikey: $ANON_KEY" http://127.0.0.1:54321/rest/v1/; then
      echo "stack arriba: http://127.0.0.1:54321"; return 0
    fi
    sleep 0.5
  done
  echo "el stack no respondió; ver $LOGS" >&2; return 1
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  reset) down; rm -rf "$PGDATA"; up ;;
  psql) shift; sql_pg "$@" ;;
  admin) shift; sql_admin "$@" ;;
  *) echo "uso: $0 up|down|reset|psql|admin" >&2; exit 2 ;;
esac

# Herramientas de prueba

Nada de esta carpeta se publica con la app (GitHub Pages sirve solo `docs/`).

## Qué hay

| Archivo | Para qué |
| --- | --- |
| `stack.sh` | Levanta en local los mismos servicios que usa Supabase: Postgres, GoTrue (login) y PostgREST (API), detrás de una puerta de entrada en `127.0.0.1:54321`. Aplica `supabase/migrations/*.sql` como el rol `postgres`, igual que el conector. |
| `gateway.mjs` | La puerta de entrada. Incluye un doble mínimo de Realtime y dos interruptores para las pruebas: `/__caido` (la base no responde) y `/__realtime` (avisos en vivo). |
| `serve.mjs` | Sirve `docs/` en `127.0.0.1:8080` apuntando al stack local. |
| `tests/db.test.mjs` | Permisos, control de revisiones, historial de cambios, deshacer y funciones de Claude. |
| `tests/app.test.mjs` | La app de punta a punta en un navegador real (Playwright). |
| `tests/mirar.mjs`, `tests/estados.mjs` | Capturas de pantalla para revisar la app a ojo. |
| `migrar.mjs` | Arma los lotes para pasar datos del gestor anterior y la consulta de verificación. |
| `vendor.mjs`, `iconos.mjs` | Regeneran lo que la app trae de terceros (librería y tipografías) y los íconos. |

## Preparar el entorno (una vez por sesión)

Hace falta Postgres 16 instalado (`/usr/lib/postgresql/16/bin`) y dos binarios en `~/.stack`:

```bash
mkdir -p ~/.stack/bin ~/.stack/auth && cd ~/.stack
curl -sSL -o postgrest.tar.xz https://github.com/PostgREST/postgrest/releases/download/v13.0.7/postgrest-v13.0.7-linux-static-x86-64.tar.xz
tar -xJf postgrest.tar.xz -C bin
curl -sSL -o auth.tar.gz https://github.com/supabase/auth/releases/download/v2.177.0/auth-v2.177.0-x86.tar.gz
tar -xzf auth.tar.gz -C auth
```

```bash
cd dev && npm install
STACK=~/.stack ./stack.sh up            # base + login + API
node serve.mjs &                        # la app en http://127.0.0.1:8080
npm run test:db && npm run test:app     # todo tiene que pasar antes de publicar
```

`./stack.sh reset` borra la base local y la crea de nuevo. `./stack.sh psql -c "…"` corre SQL como `postgres`.

## Qué no cubre

El Realtime de verdad y las particularidades de la plataforma (permisos del rol `postgres` sobre
el esquema `auth`, pausa por inactividad) solo se ven en el proyecto real. Después de aplicar una
migración ahí, conviene pasar los *advisors* de seguridad del conector de Supabase.

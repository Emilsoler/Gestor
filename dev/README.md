# Herramientas de prueba

Nada de esta carpeta se publica con la app (GitHub Pages sirve solo `docs/`).

## Qué hay

| Archivo | Para qué |
| --- | --- |
| `stack.sh` | Levanta en local los mismos servicios que usa Supabase: Postgres, GoTrue (login) y PostgREST (API), detrás de una puerta de entrada en `127.0.0.1:54321`. Aplica `supabase/migrations/*.sql` como el rol `postgres`, igual que el conector. |
| `gateway.mjs` | La puerta de entrada. Incluye un doble mínimo de Realtime y dos interruptores para las pruebas: `/__caido` (la base no responde) y `/__realtime` (avisos en vivo). |
| `serve.mjs` | Sirve `docs/` en `127.0.0.1:8080` apuntando al stack local. |
| `tests/db.test.mjs` | Permisos, control de revisiones, historial de cambios, deshacer, agenda y funciones de Claude. |
| `tests/chat.test.mjs` | La función `chat` de punta a punta: lo que manda a Claude, lo que hacen las herramientas y lo que vuelve. |
| `claude-falso.mjs` | Un doble de la API de Claude (127.0.0.1:54340) que contesta lo que cada prueba le guiona. La función `chat` corre en local apuntando a él. |
| `tests/app.test.mjs` | La app de punta a punta en un navegador real (Playwright). |
| `tests/cobranzas.test.mjs` | Cobranzas: las cuentas (contra la planilla de Excel y el listado de la Mutual), la liquidación de la base comparada con la de la app en cientos de casos al azar, las funciones para Claude, los permisos y la importación del listado (con uno inventado). |
| `tests/cobranzas-app.test.mjs` | La app de cobranzas de punta a punta (`/cobranzas/`), en PC y en celular. |
| `tests/creditos.test.mjs` | La función `bcra` de punta a punta: los pedidos al BCRA (por CUIT, por cheque y la lista de bancos), el semáforo, lo que se guarda, los errores del BCRA y los permisos de `consultas_bcra` y `consultas_cheques`. |
| `tests/creditos-app.test.mjs` | La vista "Créditos" de la app de cobranzas, sus dos pestañas, en PC y en celular (también sin las tablas, sin la lista de bancos o sin la función publicadas). |
| `bcra-falso.mjs`, `tests/casos-bcra.mjs` | Un doble de las APIs Central de Deudores y Cheques Denunciados del BCRA (127.0.0.1:54341) y sus casos, con CUITs y cheques inventados: las pruebas nunca consultan a personas ni cheques reales. La función `bcra` corre en local apuntando a él (127.0.0.1:54332). |
| `importar-listado.mjs` | Lee el listado de prendarios vencidos de la Mutual (texto de `pdftotext -layout`) y arma los deudores; con `--lotes <carpeta>`, el `insert` en lotes chicos para el conector y `verificar.sql` para confirmar que llegaron iguales (con `--sql`, todo en uno). |
| `iconos-cobranzas.mjs` | Regenera los íconos de la app de cobranzas. |
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
mkdir -p deno && cd deno && npm init -y >/dev/null && npm i deno   # para correr la función chat
```

```bash
cd dev && npm install
STACK=~/.stack ./stack.sh up            # base + login + API
node serve.mjs &                        # la app en http://127.0.0.1:8080
npm run test:db && npm run test:chat && npm run test:app     # todo tiene que pasar antes de publicar
npm run test:cobranzas                                       # la app de cobranzas (en http://127.0.0.1:8080/cobranzas/), con la consulta al BCRA
npm run test:creditos                                        # solo la consulta al BCRA (función bcra y vista "Créditos")
```

`./stack.sh reset` borra la base local y la crea de nuevo. `./stack.sh psql -c "…"` corre SQL como `postgres`.

## Qué no cubre

La API de Claude de verdad y la del BCRA (las pruebas usan los dobles) y, de las funciones `chat` y
`bcra`, lo que pone la plataforma: el control de sesión previo (`verify_jwt`) y las variables `SUPABASE_*`.
Que el BCRA responda desde los servidores de Supabase se ve recién con la primera consulta real. El Realtime de verdad y las particularidades de la plataforma (permisos del rol `postgres` sobre
el esquema `auth`, pausa por inactividad) solo se ven en el proyecto real. Después de aplicar una
migración ahí, conviene pasar los *advisors* de seguridad del conector de Supabase.

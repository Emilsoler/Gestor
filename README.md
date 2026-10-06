# Juicios · Estudio Soler

Gestor de juicios: causas, movimientos, próximas acciones con vencimiento, liquidaciones,
acuerdos de pago y plantillas de escritos. Es una app web que se instala en el celular y en
la computadora, con usuario y contraseña propios.

## Cómo está hecha

| Carpeta | Qué es |
| --- | --- |
| `docs/` | La app. GitHub Pages publica esta carpeta tal cual; no hay paso de compilación. |
| `supabase/migrations/` | El esquema de la base de datos (Supabase): tablas, permisos, historial de cambios. |
| `dev/` | Herramientas de prueba. No se publican. |

Los datos no están en este repositorio: viven en la base, y solo los ven los usuarios
autorizados después de iniciar sesión. La clave que aparece en `docs/config.js` es la clave
pública del proyecto, pensada para estar a la vista; no da acceso a ningún dato por sí sola.

## Instalarla

- **Android o computadora (Chrome, Edge):** abrir la app, tocar la inicial arriba a la derecha
  y elegir "Instalar la app en este dispositivo".
- **iPhone:** abrirla en Safari, tocar Compartir y después "Agregar a inicio".

## Mantenimiento

La app y sus datos se actualizan pidiéndoselo a Claude, que trabaja sobre este repositorio y
sobre la base. `CLAUDE.md` describe cómo; `dev/README.md`, cómo probar un cambio antes de
publicarlo.

Tipografías: IBM Plex Sans, IBM Plex Mono y Source Serif 4 (SIL Open Font License 1.1).
Cliente de la base: supabase-js (MIT). Las licencias están en `docs/fonts/` y `docs/vendor/`.

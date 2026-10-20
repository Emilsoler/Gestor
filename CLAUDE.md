# Gestor de juicios — guía para Claude

App web instalable para llevar los juicios de un estudio jurídico: causas, movimientos,
próximas acciones con vencimiento, liquidaciones, acuerdos de pago, plantillas de escritos y
una agenda de escritos para presentar en el SAC. La usa un abogado desde la PC y el celular,
habla con Claude desde un chat dentro de la app, y le pide a Claude que la mantenga al día.

Tiene tres piezas:

- **La app**, en `docs/`: HTML, CSS y JavaScript sin compilación. GitHub Pages publica esa
  carpeta desde la rama `main`. Lo que se sube ahí queda en producción en un minuto.
- **La base**, en Supabase (Postgres + login). El esquema está en `supabase/migrations/`.
  La dirección y la clave pública del proyecto están en `docs/config.js`.
- **El chat**, en `supabase/functions/chat/`: una función de Supabase que habla con la API de
  Claude (ver "Chat con Claude y escritos para el SAC").

Este repositorio es **público**: acá no van datos de causas, exportaciones, claves secretas
ni nada del estudio que no sea el código.

## "Actualizá el gestor" puede ser dos cosas

### 1. Cambiar datos (lo más frecuente)

Se hace con el conector de Supabase (`execute_sql`), sin tocar este repositorio. Si el
conector no está disponible en la sesión, decirlo; no hay otro camino desde la nube.

Usar las funciones del esquema `gestor`, que respetan las reglas de la app y firman el cambio
como "Claude":

```sql
-- encontrar la causa (confirmar cuál es si hay más de una coincidencia)
select expte, actor, demandado, estado, ultima, fecha, proxima, vence
  from public.causas where demandado ilike '%apellido%' or actor ilike '%apellido%';

select gestor.movimiento('14000001', 'Se libró oficio');                  -- hoy, hora de Córdoba
select gestor.movimiento('14000001', 'Decreto', '2026-10-02', 'A despacho'); -- con fecha y estado
select gestor.presentacion('14000001', 'Solicita aprobación de liquidación'); -- presentación en el SAC: queda "A despacho"
select gestor.proxima('14000001', 'Designar martillero', '2026-10-15');   -- próxima acción y vencimiento ('' la borra)
select gestor.realizada('14000001');                                      -- la próxima acción pasa a movimientos, con la fecha en que vencía (o la de hoy si aún no venció)
```

Datos de los demandados y títulos reclamados (pagarés o prenda), con su monto reclamado:

```sql
select gestor.agregar_demandado('14000001', 'Lucas Piedra', '20-30123456-7', '3534123456', 'Bv. San Martín 450', 'notas');
select gestor.agregar_titulo('14000001', 'pagare', 400000, '2026-06-30', 'Pagaré 1');
select gestor.agregar_titulo('14000001', 'prenda', 3500000, '2026-03-15', 'Prenda N° 4821', 'Fiat Cronos AB123CD');
select gestor.reclamado('14000001');   -- capital, interés y total por título y en conjunto, a hoy
```

`reclamado` y la ficha de la app calculan igual: interés simple de 5% mensual (`0.05` cada 30 días
desde el vencimiento de cada título; sin vencimiento o aún no vencido, sin interés). Las dos
listas son columnas `jsonb` de `causas` (`demandados`, `titulos`): para editarlas o quitar un
elemento, `update` directo con `set_config('gestor.autor', …)`, como cualquier otro campo. Los
mensajes a los demandados (por ejemplo una oferta de acuerdo) se redactan a partir de estos datos
y de `gestor.reclamado`; los envía la persona, desde el enlace de WhatsApp de la ficha. Son datos
personales: usarlos solo para el reclamo de esa causa.

Para cualquier otro cambio, SQL directo dentro de una transacción que diga quién lo hace:

```sql
begin;
select set_config('gestor.autor', 'Claude', true);
update public.causas set notas = '…' where expte = '14000001';
commit;
```

Después de escribir, leer la fila y contar qué quedó. La app abierta lo muestra sola, en vivo.

- **Estados**: los de `gestor.estados_base()`. Un estado nuevo crea una columna en el tablero:
  no inventarlos.
- **Causas sin demandado**: los juicios sin contraparte (limitación de la capacidad,
  sucesiones…) van con `demandado = ''` y el interesado en `actor`; la app los nombra por el
  actor. No inventar un demandado para completar el campo.
- **Liquidación**: `liquidacion` es `{fecha, embargo, rubros:[{id, rubro, monto, pagado}], pagos:[{id, fecha, op, imp:{<id del rubro>: monto}}]}`. Cada pago es una orden de pago (`op` es su N°) que reparte su monto entre rubros en `imp`. `pagado` de cada rubro es la suma de lo imputado: si se editan los pagos con SQL directo, recalcular `pagado` también. En la app, la ficha muestra solo total, cobrado y saldo, y el botón "Abrir planilla": una hoja con los rubros en filas y cada orden de pago en una columna, que se guarda en este mismo campo (lo que cargue Claude por SQL aparece ahí). "Descargar en Excel" arma un .xlsx con fórmulas en el navegador; es una copia: lo que se cambie en el archivo no vuelve al gestor.
- **Última acción**: es el movimiento de fecha más reciente (a igual fecha, el anotado después).
  Las funciones ya lo calculan; con SQL directo sobre `historial` hay que actualizar también
  `ultima` y `fecha` (`gestor.ultima_de(historial)`).
- **Plantillas**: `select id, titulo, cuerpo from public.plantillas`. Los campos `{{caratula}}`,
  `{{expediente}}`, `{{actor}}`, `{{demandado}}`, `{{tipo}}`, `{{nominacion}}` y `{{oficina}}`
  se completan con la causa; la carátula es `actor c/ demandado – tipo` (sin demandado,
  `actor – tipo`).
- **Escritos para el SAC** (`public.agenda`): ver "Chat con Claude y escritos para el SAC".
  Para la tarea que los presenta:

  ```sql
  select * from gestor.agenda_tomar(true);                     -- toma el próximo listo para presentar (queda "presentando")
  select gestor.agenda_presentada('<id>', 'Presentado 10:16');  -- después de presentarlo: movimiento, "A despacho" y, si se pidió, realizada
  select gestor.agenda_fallida('<id>', 'motivo');               -- si no se pudo: queda con error, la causa no se toca
  ```

  Presentar siempre a partir de `agenda_tomar(true)`: toma solo lo que la persona marcó con
  «Ahora», y nunca le da el mismo escrito a dos corridas a la vez. (`agenda_tomar(false)` y
  `agenda_del_dia()` son del horario de las 10:15, que ya no existe; ver más abajo.)

- **Ver qué cambió y deshacer**: todo cambio queda en `gestor.cambios` con el estado anterior.

  ```sql
  select id, momento, autor, tabla, clave, operacion from gestor.cambios order by id desc limit 20;
  select gestor.deshacer(123);   -- vuelve ese registro a como estaba antes del cambio 123
  ```

  Restaura el registro entero. Si después del cambio 123 hubo otros sobre el mismo registro,
  no hace nada y avisa; mirarlos y, si de verdad corresponde pisarlos, `gestor.deshacer(123, true)`.
  Sirve para modificaciones y bajas; no elimina nunca (deshacer un alta es un `delete` aparte,
  pedido expresamente).

- **Usuarios**: la app no tiene registro público. La cuenta (email y contraseña) se crea en el
  panel de Supabase — Authentication → Users → "Add user", con "Auto Confirm User" marcado — y
  la contraseña la escribe la persona ahí: no pasa por el chat. Después se la habilita:

  ```sql
  select gestor.autorizar('persona@mail.com', 'Nombre');        -- ya puede usar el gestor
  select gestor.autorizar('persona@mail.com', 'Nombre', true);  -- ídem, y la app le hace elegir clave nueva al entrar
  select gestor.quitar_usuario('persona@mail.com');             -- pierde el acceso en el acto
  select * from gestor.usuarios;
  ```

  Las funciones de `gestor` no escriben en las tablas de `auth` (crear cuentas o cambiar
  contraseñas por SQL no es un camino admitido). Quien olvidó la contraseña y no tiene la app
  abierta en ningún lado la restablece desde el panel de Supabase; con la app abierta, se
  cambia en el menú de la cuenta.
- **"La app no conecta"** después de una semana o más sin uso: el plan gratuito pausa el
  proyecto. `get_project` lo confirma y `restore_project` lo reactiva (tarda unos minutos).

### 2. Cambiar la app

1. Editar en `docs/` (`app.js` interfaz, `datos.js` todo lo que habla con la base, `styles.css`,
   `liquidacion.js` cuentas de la liquidación e importes escritos a la argentina, `excel.js` el armado
   de archivos .xlsx sin librerías).
2. Probar en local: `dev/README.md` explica cómo levantar la base y correr las pruebas.
   `npm run test:db`, `npm run test:chat` y `npm run test:app` tienen que pasar; si el cambio se ve, mirar capturas
   (`node tests/mirar.mjs`), también en ancho de celular.
3. `git commit` y `git push` a `main`. No hay paso de compilación.

Si el cambio necesita columnas o funciones nuevas: migración numerada nueva en
`supabase/migrations/` (no editar las ya aplicadas), probarla con `dev/stack.sh reset`,
aplicarla con `apply_migration` y pasar `get_advisors` (seguridad).

## Cómo está armada

- **Acceso**: tener cuenta no alcanza; hay que estar en `gestor.miembros`. Lo exigen tres
  barreras independientes, y ninguna migración debe aflojar una contando con las otras:
  1. `public.gestor_puerta()`, que PostgREST ejecuta antes de cada pedido
     (`pgrst.db_pre_request` en el rol `authenticator`) y rechaza a quien no es miembro.
  2. Las políticas de filas de `causas`, `acuerdos` y `plantillas` (`public.es_miembro()`).
  3. Las estadísticas del planificador desactivadas en todas las columnas de esas tablas,
     para que los conteos estimados de la API no revelen contenido. Si una migración agrega
     columnas, termina con `select gestor.sin_estadisticas();`.

  El esquema `gestor` no se expone por la API y los roles de la API no tienen `USAGE` sobre
  él: no dárselo nunca. La clave de `config.js` es la pública; la secreta no se usa en ningún
  lado. En el proyecto de Supabase conviene además tener apagado el registro público
  (Authentication → Sign In / Providers → "Allow new users to sign up"): la app no lo usa.
- **Concurrencia**: cada fila tiene `rev`, que un trigger renueva en cada cambio real con un
  número que no se repite nunca (secuencia `gestor.revisiones`). La app
  guarda con `where rev = <la que tenía>`; si no coincide, avisa y deja elegir. Por eso un
  cambio de Claude nunca se pisa en silencio, ni pisa lo que la persona está editando.
- **Sincronización** (`docs/datos.js`): Realtime avisa los cambios y se relee; si no hay
  Realtime, se relee cada 30 s; sin conexión se muestra la copia guardada en el dispositivo,
  solo para consultar.
- **Service worker** (`docs/sw.js`): los archivos de la app van primero a la red, así una
  versión nueva se ve en la siguiente apertura. Si se agregan archivos al arranque o cambia
  una tipografía o ícono, subir `VERSION`.
- **Política de seguridad** (meta CSP en `index.html`): solo scripts y estilos propios, sin
  nada en línea. Los estilos van en `styles.css` (no usar `style="…"`), y todo dato que se
  pinta pasa por `esc()`.
- **Botón "Claude"**: abre el chat dentro de la app (el del encabezado, vacío; el de la ficha, con la causa nombrada). Para lo que el chat no hace, el aviso de error ofrece abrir la app de Claude con el pedido.
- **Terceros**: `docs/vendor/supabase.js` y las tipografías se copian desde `dev/node_modules`
  con `node dev/vendor.mjs`; no se cargan de ningún CDN.

## Chat con Claude y escritos para el SAC

- **Cómo funciona**: la app (`datos.js`, `preguntarAClaude`) manda a la función `chat` la
  conversación y el mensaje nuevo. La función le pasa todo a la API de Claude con las
  herramientas de `herramientas.ts`, ejecuta las que Claude pida y devuelve los mensajes nuevos,
  que la app guarda tal cual en el dispositivo (`gj.chat`, se borra al cerrar sesión). La API
  rechaza una conversación alterada: las instrucciones (`instrucciones.ts`) son siempre iguales
  y la fecha va en cada mensaje.
- **Permisos**: la función usa la sesión de la persona contra la API, así que valen las mismas
  tres barreras que la app; no usa la clave secreta. Con el encabezado `x-gestor-via: chat` lo
  que cambia queda firmado como "Claude" (`gestor.autor`). Las herramientas no eliminan nada ni
  presentan en el SAC.
- **La clave de la API** es el secreto `ANTHROPIC_API_KEY` de la función (se carga desde el
  panel de Supabase o con `create_edge_function_secret`; nunca por el chat ni en el repositorio).
  El gasto se controla con el tope mensual de la Consola de Claude. Modelo: `claude-sonnet-5-5`
  (`GESTOR_MODELO` para cambiarlo sin tocar el código).
- **Publicar la función**: `deploy_edge_function` con nombre `chat`, `verify_jwt: true` y los
  seis archivos de `supabase/functions/chat/` (entrada `index.ts`).
- **Agenda** (`public.agenda`, migraciones 0005 y 0006): borrador (lo arma el chat) → pendiente
  (la persona tocó "Agendar" o «Ahora» en la tarjeta: es la única aprobación que vale) →
  presentando (una corrida de la tarea lo tomó) → presentado o error; o cancelado (solo antes de
  que lo tomen). "Agendar" solo lo deja en la agenda para un día: **nada se presenta solo**.
- **Botón «Ahora»** (`docs/app.js`): deja el escrito pendiente, con fecha de hoy y la hora del
  pedido en `agenda.ahora` ("Listo para presentar"), y abre en otra pestaña la tarea de Claude
  "Presentar escritos agendados en el SAC" (`TAREA_SAC`, claude.ai/scheduled-task/trig_…). Ahí la
  persona toca "Ejecutar ahora": la corrida toma lo listo con `agenda_tomar(true)`, lo presenta con
  Claude in Chrome (el Chrome donde está abierta la sesión del SAC) y lo cierra con
  `agenda_presentada` o `agenda_fallida`. No adjunta archivos. Si una corrida se corta con un
  escrito tomado, a la media hora la tarjeta ofrece "Marcar como no presentado".
- **Por qué no se dispara solo**: la tarea es una "tarea programada" de claude.ai y en esta cuenta
  su "Activador" solo ofrece "Programación" (no hay activador por API ni token). Por pedido de la
  persona no tiene horario: quedó activa con una sola ejecución el 31/12/2099, así que corre solo
  con "Ejecutar ahora". No apagar "Activo". Las instrucciones de la tarea se cambian con
  `update_trigger` (id `trig_01EX9sLZMbvqDtgqTNJFGTg5`). Si algún día la tarea tiene activador por
  API, el disparo desde la función está en el historial de git (commit e601d73).
- **Tiene que correr en la compu del SAC**: manejar el Chrome es una herramienta de la
  computadora, y una corrida solo la tiene si la tarea "requiere" esa computadora (con la app de
  Claude de escritorio abierta ahí). Si `list_triggers` no le muestra `bound_device`, la tarea
  corre en la nube, no llega al Chrome y el escrito queda con error ("No había un Chrome
  conectado…"). La tarea se creó así. Lo activa la persona en la app de Claude de escritorio de
  esa compu, en la tarea ("Require this computer" en inglés). `update_trigger` no lo cambia;
  crearla de nuevo con `create_trigger` y `requires_local_device: true` le cambia el id (y hay que
  actualizar `TAREA_SAC`).

## Estilo

- Textos de la interfaz en castellano rioplatense, de vos, frases cortas. Un botón dice lo que
  hace ("Guardar cambios") y el aviso posterior usa las mismas palabras ("Cambios guardados").
- El diseño ya tiene su lenguaje: tema oscuro único (azul noche), un solo acento en degradado
  azul → violeta (`--grad`: botón principal, vista y cifra elegidas, mensajes propios del chat),
  colores de estado aclarados para leerse sobre fondo oscuro, IBM Plex Sans (300 solo para las
  cifras grandes del resumen) y Plex Mono para expedientes e importes, tarjetas redondeadas y
  botones píldora. Los avisos son tarjetas con una franja a la izquierda del color de lo que
  avisan. Los íconos son SVG de trazo dentro de `styles.css`, usados como máscara (`--i-…`).
  Las pantallas nuevas lo siguen; no sumar librerías.
- Armado: en la computadora, barra lateral con las vistas (columna de íconos desde 721 px,
  entera desde 1140 px); en el celular, las vistas quedan debajo del buscador. Es el mismo
  HTML: `.lateral` y `.wrap` pasan a `display: contents` y el orden lo da `order`.
- Comentarios en el código: por qué, no qué.

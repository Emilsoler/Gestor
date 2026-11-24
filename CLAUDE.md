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
- **La app de cobranzas**, en `docs/cobranzas/`: otra app instalable (deudores en mora,
  liquidaciones, pagos imputados por rubro, planes de pago, WhatsApp, aprobación de créditos con
  consultas al BCRA por CUIT y por cheque), con la misma base, el mismo login y las mismas barreras de
  acceso. Ver "Cobranzas", al final; las consultas al BCRA las hace la función `supabase/functions/bcra/`.
- **La app Prenda**, en `docs/prenda/`: tercera app instalable, para geolocalizar los vehículos
  prendados (con consentimiento del tomador): mapa, alertas, bitácora y constancias. Misma base,
  mismo login y mismas barreras. Ver "Prenda", al final; la ubicación la pide la función
  `supabase/functions/ubicar/`.
- **El cotizador para agencias**, en `docs/agencias/`: app web para agencias y concesionarias (no son
  usuarias del gestor) que muestra solo las condiciones de los créditos prendarios de la Mutual. Ver
  "Cotizador para agencias", al final; lo calcula la función `supabase/functions/agencias/`.

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
select expte, actor, demandado, ubicacion, estado, cautelar, situacion, ultima, fecha, proxima, vence
  from public.causas where demandado ilike '%apellido%' or actor ilike '%apellido%';

select gestor.movimiento('14000001', 'Se libró oficio');                  -- hoy, hora de Córdoba
select gestor.movimiento('14000001', 'Decreto', '2026-10-02', p_ubicacion => 'Casillero');  -- con fecha y ubicación
select gestor.movimiento('14000001', 'Sentencia de remate', '2026-10-02', '3. Sentencia');  -- con fecha y etapa
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

- **Ubicación, estado, etiqueta cautelar y situación** (migración 0007): cuatro columnas de `causas`
  con valores fijos; la base rechaza cualquier otro (y `gestor.movimiento` explica en cuál va un
  valor puesto en el lugar equivocado).
  - `ubicacion`: dónde está el expediente, `Casillero` o `A despacho`. Cada presentación en el SAC la
    deja `A despacho` ("pasó a despacho", "volvió al casillero" es esto).
  - `estado`: la etapa del juicio (`gestor.estados_base()`): `0. Iniciamos`, `1.1 Demanda`,
    `1.2 Contestación`, `2. No oposición de excepciones`, `3. Sentencia`, `4. Ejecución de Sentencia`,
    `5. Martillero Designado`. Vacío: sin estado (solo en causas
    que venían de antes).
  - `cautelar` (en la app, "Etiqueta Cautelar"): `Sin Cautelar`, `Embargo de sueldo` o `Vehículo secuestrado`.
  - `situacion`: `En trámite`, `Acuerdo` o `Archivada`. Las archivadas no aparecen en el listado ni
    en la agenda; las de acuerdo se ven aparte ("Con acuerdo").

  Hasta 0007, `estado` mezclaba ubicación, etapa y situación, y había una lista libre de `etiquetas`;
  lo que había quedó en `gestor.respaldo_0007` (solo para consultar). La columna `etiquetas` sigue en
  la tabla, sin uso, y `gestor.movimiento_anterior` solo avisa que se reemplazó: 0007 no borra nada
  porque desde el chat las instrucciones destructivas (`drop`) quedan esperando una confirmación que
  no llega. Se pueden quitar en una migración aparte, aplicada desde donde se pueda confirmar.
- **Causas sin demandado**: los juicios sin contraparte (limitación de la capacidad,
  sucesiones…) van con `demandado = ''` y el interesado en `actor`; la app los nombra por el
  actor. No inventar un demandado para completar el campo.
- **Liquidación**: `liquidacion` es `{fecha, embargo, rubros:[{id, rubro, monto, pagado}], pagos:[{id, fecha, op, imp:{<id del rubro>: monto}}]}`. Cada pago es una orden de pago (`op` es su N°) que reparte su monto entre rubros en `imp`. `pagado` de cada rubro es la suma de lo imputado: si se editan los pagos con SQL directo, recalcular `pagado` también. En la app, la ficha muestra solo total, cobrado y saldo, y el botón "Abrir planilla": una hoja con los rubros en filas y cada orden de pago en una columna, que se guarda en este mismo campo (lo que cargue Claude por SQL aparece ahí). "Descargar en Excel" arma un .xlsx con fórmulas en el navegador; es una copia: lo que se cambie en el archivo no vuelve al gestor.
- **Acuerdos de pago** (`public.acuerdos`, migración 0017): una fila por acuerdo, con `deudor`, `expte` (la
  causa; vacío si no se vinculó), `notas`, `creado` y `cuotas`, una lista jsonb de
  `{rubro, vence, monto, estado, pago}`. Los rubros son tres y cada uno lleva sus propias cuotas:
  `capital` (capital, intereses y gastos), `martillero` (honorarios del martillero) y `abogado`
  (honorarios del abogado). `estado`: `pendiente`, `pagada` (con `pago` = fecha) o `impaga`. Una cuota sin
  `rubro` (cargada antes de que existieran) es de capital. La app las muestra rubro por rubro, en el orden
  de la lista, que queda agrupada por rubro (capital, martillero, abogado): las cuotas que se agregan a un
  rubro van después de las que ese rubro ya tiene. El acuerdo se ve en la
  ficha de su causa ("Acuerdo de pago") y en la vista Acuerdos, donde cada uno es una fila con el nombre
  de la causa que se despliega al tocarla. A los 5 días de vencida una cuota pendiente, la app pregunta si
  se pagó. **Avisos de vencimiento**: desde 3 días antes (`AVISO_DIAS`) y hasta que vencen los 5 de gracia, la cuota
  cuenta como «por vencer» (`cuotasPorVencer`): un solo aviso en cualquier vista («Hay N cuotas de acuerdos por
  vencer», con «Ver cuotas»), la insignia de Acuerdos (en coral si alguna vence hoy o ya venció), el bloque «Cuotas por
  vencer» arriba de la vista Acuerdos (con «Pagó» y «Ver acuerdo») y una marca en la fila de cada acuerdo. Son avisos
  dentro de la app: no hay notificaciones al celular con la app cerrada. **Buscador**: la vista Acuerdos tiene el buscador
  del listado (sin los filtros) y filtra por deudor, demandado/actor y carátula de la causa, expediente y notas, sin
  distinguir tildes. Para cargar o cambiar uno por SQL, `insert`/`update` directo con `set_config('gestor.autor',
  'Claude', true)`, cuidando esa forma; la `situacion` de la causa (`Acuerdo`) se cambia aparte.
- **Última acción**: es el movimiento de fecha más reciente (a igual fecha, el anotado después).
  Las funciones ya lo calculan; con SQL directo sobre `historial` hay que actualizar también
  `ultima` y `fecha` (`gestor.ultima_de(historial)`).
- **Plantillas**: `select id, titulo, cuerpo from public.plantillas`. Los campos `{{caratula}}`,
  `{{expediente}}`, `{{actor}}`, `{{demandado}}`, `{{tipo}}`, `{{nominacion}}` y `{{oficina}}`
  se completan con la causa; la carátula es `actor c/ demandado – tipo` (sin demandado,
  `actor – tipo`). En el panel Plantillas cada una es una fila con su título, plegada: al tocarla se despliega el texto para leerlo y editarlo (el texto plegado sigue en la página, así que lo escrito sin guardar no se pierde). Las de id `oficio-…` son modelos de oficio y `solicita-embargo-haberes` /
  `solicita-secuestro-automotor` sus escritos: ver "Acciones cautelares".
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

- **Documentos en Drive** (migración 0026, columna `causas.drive`): lo que la revisión diaria de las 10:30 encontró en
  la carpeta de Drive del demandado. La anota Claude por el conector, solo nombres de archivo:

  ```sql
  select gestor.drive('14000001', 'Pérez Juan', array['261105-Cédula.pdf', '261101 tasa.pdf'], array['AFIP.pdf']);
  -- 3.º argumento: la carpeta del demandado; 4.º: la carpeta «Constancias Emiliano Soler»
  ```

  Reemplaza lo anterior y guarda la hora de la revisión. **No cuenta como cambio de la causa** (no sube `rev` ni
  queda en `gestor.cambios`), así no choca con quien tenga la ficha abierta. La app (`docs/seguimiento.js`) cruza esa
  lista con la próxima acción: `requisitos` dice qué adjuntos lleva cada escrito (reglas del estudio: tasa →
  tasa y comprobante, y oficio de secuestro en prendarios; no oposición → Cédula y AFIP; ejecuta sentencia con
  fianza → Cédula Sentencia y liquidación; pase a fallo y aprobación de liquidación → sin adjuntos; el resto,
  sin regla) y `documentos` busca cada uno por el nombre del archivo (el más nuevo, `AAMMDD-…`). La ficha muestra
  «Documentos en Drive» y la tarjeta del listado, «✗ Falta en Drive: …» o «✓ Adjuntos listos en Drive». Si una
  regla nueva de la persona cambia los adjuntos de un escrito, cambiarla ahí (y en `dev/tests/seguimiento.test.mjs`).
- **Movimientos como línea de tiempo**: en la ficha, agrupados por mes, con su tipo (Escrito, Tribunal,
  Notificación, Pago o Gestión, deducido del texto por `tipoMovimiento` de `seguimiento.js`) y quién lo anotó.
  Desde 0026, la base le pone `autor` a cada movimiento nuevo (disparador `autor_movimientos`: la persona desde la
  app, o «Claude» por SQL y el chat); los anteriores quedan sin autor. Se puede filtrar por tipo (`S.fh`).
- **Ver qué cambió y deshacer**: todo cambio queda en `gestor.cambios` con el estado anterior.

  ```sql
  select id, momento, autor, tabla, clave, operacion from gestor.cambios order by id desc limit 20;
  select gestor.deshacer(123);   -- vuelve ese registro a como estaba antes del cambio 123
  ```

  Restaura el registro entero. Si después del cambio 123 hubo otros sobre el mismo registro,
  no hace nada y avisa; mirarlos y, si de verdad corresponde pisarlos, `gestor.deshacer(123, true)`.
  Una foto de una causa anterior a 0007 se pasa a la forma actual (`gestor.forma_0007`); la etapa, que
  no existía, queda la que la causa tiene hoy.
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
   de archivos .xlsx sin librerías, `oficio.js` los oficios de las acciones cautelares y su PDF).
2. Probar en local: `dev/README.md` explica cómo levantar la base y correr las pruebas.
   `npm run test:db`, `npm run test:chat`, `npm run test:oficio` y `npm run test:app` tienen que pasar; si el cambio se ve, mirar capturas
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
  2. Las políticas de filas de `causas`, `acuerdos`, `plantillas`, `agenda` y las de cobranzas
     (`deudores`, `modelos_mensaje`, `ajustes_cobranzas`, `consultas_bcra`, `consultas_cheques`,
     `casos_refi`, `descuentos_cheques`, `vehiculos`, `ubicaciones`, `ajustes_prenda`), todas con `public.es_miembro()`.
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
- **Botón "SAC"** (encabezado, entre "Claude" y el círculo de la cuenta): un enlace común a Servicios
  Extranet del Poder Judicial (`https://www.justiciacordoba.gob.ar/JusticiaCordoba/extranet.aspx`),
  en otra pestaña para que el gestor quede abierto. El ingreso lo hace la persona en esa página.
  En el iPhone (la persona usa uno, con Chrome instalado) el gestor instalado abre ese enlace en una
  vista de Safari propia donde no se puede entrar a las causas; por eso `app.js` lo cambia a
  `googlechromes://…` y se abre en Chrome (el iPhone puede preguntar antes si abrirlo). Si el
  gestor ya está abierto en Chrome del iPhone (`CriOS`), queda el enlace común.
- **Terceros**: `docs/vendor/supabase.js` y las tipografías se copian desde `dev/node_modules`
  con `node dev/vendor.mjs`; no se cargan de ningún CDN. Las de los oficios (EB Garamond 400 y 700,
  Caladea 400) quedan como `.ttf`: `vendor.mjs` las rearma desde el WOFF, porque un PDF solo
  acepta TrueType.

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
  ocho archivos de `supabase/functions/chat/` (entrada `index.ts`).
- **Chat en Cobranzas** (botón "Claude" del encabezado de `docs/cobranzas/`, `chat.js`): la misma función `chat`, con
  `app: 'cobranzas'` en el pedido; con eso usa `herramientas_cobranzas.ts` e `instrucciones_cobranzas.ts` en vez de las de causas.
  Herramientas: `buscar_deudores`, `ver_deudor` (liquidación a hoy), `listar_pendientes_cobranza`, `anotar_gestion`,
  `fijar_proxima_accion` y `registrar_pago` (solo con la imputación que la persona dicta). Las cuentas las hace la base: la API no
  expone el esquema `gestor`, así que la migración 0019 agrega los puentes `public.chat_*` (miembros, firman "Claude"). No elimina nada
  ni manda WhatsApp. La conversación se guarda en el dispositivo como `cb.chat`. Para publicar: migración 0019 y
  `deploy_edge_function` de `chat` con los ocho archivos de `supabase/functions/chat/`, y después subir la app.
- **Agenda** (`public.agenda`, migraciones 0005 y 0006): borrador (lo arma el chat) → pendiente
  (la persona tocó "Agendar" o «Ahora» en la tarjeta: es la única aprobación que vale) →
  presentando (una corrida de la tarea lo tomó) → presentado o error; o cancelado (solo antes de
  que lo tomen). "Agendar" solo lo deja en la agenda para un día: **nada se presenta solo**.
- **Botón «Ahora»** (`docs/app.js`): deja el escrito pendiente, con fecha de hoy y la hora del
  pedido en `agenda.ahora` ("Listo para presentar"), y abre en otra pestaña la tarea de Claude
  "Presentar escritos agendados en el SAC" (`TAREA_SAC`, claude.ai/scheduled-task/trig_…). Ahí la
  persona toca "Ejecutar ahora": la corrida toma lo listo con `agenda_tomar(true)`, lo presenta con
  Claude in Chrome (el Chrome donde está abierta la sesión del SAC) y lo cierra con
  `agenda_presentada` o `agenda_fallida`. Adjunta solo los oficios guardados en `agenda.adjuntos`
  (ver "Acciones cautelares"); un escrito que dice acompañar otra cosa lo deja con error, para
  presentarlo a mano. Si una corrida se corta con un escrito tomado, a la media hora la tarjeta
  ofrece "Marcar como no presentado". Sus instrucciones completas están en `dev/tarea-sac.md`.
- **Por qué no se dispara solo**: la tarea es una "tarea programada" de claude.ai y en esta cuenta
  su "Activador" solo ofrece "Programación" (no hay activador por API ni token). Por pedido de la
  persona no tiene horario: quedó activa con una sola ejecución el 31/12/2099, así que corre solo
  con "Ejecutar ahora". No apagar "Activo". Id: `trig_01AFgigkwo8pfvJccpFYUx3n`. Si algún día
  la tarea tiene activador por API, el disparo desde la función está en el historial de git
  (commit e601d73).
- **Requiere la compu del estudio** ("emiliano", Windows): manejar el Chrome es una herramienta
  de la computadora, y una corrida solo la tiene si la tarea requiere esa computadora. Por eso
  la tarea se creó con `requires_local_device: true` desde una conversación vinculada a ella:
  para presentar, esa compu tiene que estar prendida, con la app de Claude de escritorio abierta
  y el SAC con la sesión iniciada en Chrome. Cambiar sus instrucciones con `update_trigger` solo
  vale si la persona lo aprueba desde una conversación vinculada a esa compu (si no, devuelve
  `needs_device_approval` y no cambia nada). No borrarla ni crearla de nuevo: pierde la compu.
  La anterior (`trig_01EX9sLZMbvqDtgqTNJFGTg5`) se había creado sin ese requisito: corría en la
  nube y no llegaba al Chrome. Quedó desactivada.

## Archivero legal (`public.conocimientos`, migración 0024)

Material de consulta jurídico del estudio, cargado con el conector de Supabase (`execute_sql`): el
CPCC de Córdoba ley 8465 (fuente `cpcc-cba`: el texto de los arts. 3 a 894 en bloques `txt-NNN` y 35
artículos sueltos `art-N` con comentario de González Castro), Falcón, Gómez Leo, Busetto, Ley de Prenda,
pagaré de consumo y los modelos de escritos. Una fila por documento: `id` (`fuente:clave`), `fuente`, `tipo`
(fichas, resumen, texto, articulo, modelos, mapa), `titulo`, `orden`, `contenido` y `tsv` (búsqueda de texto
completo en castellano). No hay datos de causas ni de personas.

- **Regla de oro: Córdoba primero, sin excepción.** Rige el CPCC de Córdoba; los demás libros dan solo
  criterio de fondo. En un escrito de Córdoba no se citan artículos del CPCCN, de Corrientes ni de Buenos Aires;
  si no hay un criterio verificado para Córdoba, se escribe «verificar en Córdoba». Está en `instrucciones.ts`
  y la búsqueda marca la jerarquía de cada resultado.
- **Acceso**: la tabla no tiene políticas ni permisos para `anon`/`authenticated` (nadie la lee por la API).
  El chat la consulta con las herramientas `consultar_archivero` y `leer_archivero`, que llaman a
  `public.buscar_conocimientos` y `public.leer_conocimiento` (`SECURITY DEFINER`, solo para miembros de `gestor.miembros`).
  Solo para el gestor: el chat de cobranzas no las tiene.
- **Cargar o corregir** (con el conector): `insert … on conflict (id) do update set contenido = excluded.contenido,
  actualizado = now()`. Un bloque de unos 10.000 caracteres pasa bien por `execute_sql`.
- **Huecos conocidos**: los arts. 1, 2, 6, 83, 130, 339 y 436 del CPCC estaban dañados (OCR) y se cargaron con el texto oficial
  (`cpcc-cba:txt-001`); queda por verificar el 384 (casación en el ejecutivo). No está la ley 10.555 (oralidad), a pedido de la
  persona. De Gómez Leo están cargados todos los capítulos (I a XVIII); los I a XI y el XVIII como resumen por apartado (`gomez-leo:resumen-b01` a `b25`, el texto del libro no es literal y es de 2004, anterior al CCyC), no las 955 páginas enteras. El art. 340 (cómputo de la perención) sí está, dentro de `cpcc-cba:txt-309`.
- Las cuentas de usuario no ven la tabla ni sus estadísticas: no hace falta `gestor.sin_estadisticas()` (no hay datos del estudio).

## Acciones cautelares (botón de la ficha)

En la ficha, "Acción cautelar" pregunta "¿Solicitar embargo de haberes?" o "¿Solicitar oficio de
secuestro automotor?". La app completa el oficio y el escrito "Solicita…" con los datos de la causa
(demandado elegido, DNI —de un CUIL sale el del medio—, domicilio, vehículo de la prenda, monto) y
pide en un formulario lo que falta (empleador, cuenta judicial y CBU; sede del oficial de justicia).
Al lado se ve el oficio como hoja, con lo que falta marcado. Al confirmar, el escrito queda en la
agenda **agendado para hoy** (`pendiente`, sin `ahora`) con el oficio en `adjuntos`: se presenta
recién cuando la persona toca "Presentar ahora" y después "Ejecutar ahora" en la tarea.

- **Modelos**: cuatro plantillas con id fijo (migración 0013, y una copia en `MODELOS` de
  `docs/oficio.js` que se usa si la persona las borra): `oficio-embargo-haberes`,
  `oficio-secuestro-automotor`, `solicita-embargo-haberes`, `solicita-secuestro-automotor`. Los
  oficios son los modelos de Word del estudio, al pie de la letra (los dos del Drive de Emi; el de
  secuestro es el del comando "haz OS", con la cláusula para enervar el secuestro opcional y el año
  y la sede si hay dato). No cambiar su texto sin que la persona lo pida. Los modelos de oficio no
  aparecen como escritos en la ficha; en Plantillas van aparte y tienen "Volver al texto original".
- **Marcas de un modelo de oficio** (`docs/oficio.js`): primer bloque = encabezado (un renglón por
  línea); párrafos separados por línea en blanco; `>` sangría de primera línea, `>>` despedida;
  `**negrita**`; `{{campo}}` (lista en `CAMPOS_OFICIO`); `[[ … ]]` (en un renglón) solo si sus campos
  tienen dato, y si el renglón era solo eso desaparece.
- **El PDF** lo arma `pdfOficio` sin librerías: carta, márgenes del modelo de Word, cuerpo en EB
  Garamond 12 justificado con interlineado 1,5, encabezado en Caladea 11, tipografías embebidas, sin
  fecha. El mismo texto da siempre el mismo PDF byte por byte, en la app y en Node.
- **`agenda.adjuntos`**: `[{nombre, modelo, doc, sha256, datos}]`. `doc` es el oficio completado
  (con las marcas), `sha256` lo pone la base (`gestor.tg_adjuntos`), `datos` son los del
  formulario (la app propone los últimos de la causa: empleador, cuenta, CBU, sede). Los adjuntos
  no cambian una vez que la tarea tomó el escrito. `gestor.deshacer` los restaura.
- **La tarea del SAC** no llega a la base desde la línea de comandos: lee
  `select n, nombre, linea from gestor.agenda_adjuntos('<id>')` y copia los renglones de cada adjunto
  a un archivo. Son de solo ASCII, sin comillas ni barras (`gestor.texto_seguro`, espejo de
  `dev/texto-seguro.mjs`), porque el resultado del conector viene dentro de capas de JSON que
  escaparían cualquier otra cosa; van en partes cortas con su control, para que un error de copia
  diga qué renglón repetir. `node dev/oficio-pdf.mjs <renglones.txt> <carpeta>` (desde un clon del
  repositorio) controla todo antes de armar el PDF (si no, sale con código 2) y la tarea lo sube al
  SAC con la herramienta de subir archivos de Claude in Chrome. Las pruebas comparan ese PDF con el
  que baja la app, y la codificación de la base con la de JS.
- **Para Claude, por el conector**: un escrito con oficio también se puede dejar armado por SQL
  (`insert into public.agenda (…, adjuntos)` con el `doc` completado con las marcas), pero lo normal es
  que la persona lo confirme desde la ficha, que muestra la hoja.

## Estilo

- Textos de la interfaz en castellano rioplatense, de vos, frases cortas. Un botón dice lo que
  hace ("Guardar cambios") y el aviso posterior usa las mismas palabras ("Cambios guardados").
- **Rediseño oscuro (nov 2026)**: tema oscuro único (fondo negro, tarjetas azul noche `--surface`, dorado `--accent` como
  acento y `--grad` para el botón principal y la vista elegida), IBM Plex Sans y Plex Mono, y fotos de estatuas y bustos
  griegos (en `docs/img/`, las puso la persona; no sumar fotos de internet). Los estilos del rediseño están al final de
  `styles.css` («Rediseño»); las variables de color, arriba. Tipografías de la portada en `docs/fonts/`: Cinzel (el nombre),
  EB Garamond cursiva (la frase) y Poppins (títulos de tarjetas), servidas por la app (sin CDN).
- **Inicio** (`vistaInicio` en `app.js`): la app abre siempre ahí (no recuerda la última vista; un enlace con `#vista=lista`,
  `agenda`, `acuerdos`, `juris` o `liq` abre esa pantalla). Solo «Dr. Soler Emiliano · Abogado» (el nombre ocupa todo el
  ancho: `ajustarNombre` lo escala), una frase de filósofos griegos con su busto (`FRASES`, al azar en cada apertura), las
  acciones rápidas (Nueva causa, Nuevo escrito para el SAC —abre el chat— y Nuevo acuerdo de pago) y ocho tarjetas con foto:
  Causas, Agenda, Acuerdos, Plantillas, Liquidaciones, Créditos y Cobros (`cobranzas/`), Jurisprudencia y SAC (enlace
  al extranet). Sin hora, fecha ni tarjetas de vencimientos. Los avisos de cuotas por vencer no se muestran en el inicio.
- **Jurisprudencia** (`vistaJuris`): el campo y el botón «Buscar» están desactivados a propósito: la persona pidió dejar la solapa
  sin buscador y decidir más adelante cómo tener uno (en nov 2026 se probó un sistema de pedidos a Claude con Jurisemia y lo
  descartó; no volver a armarlo sin que lo pida). **Liquidaciones** (`vistaLiq`): las causas con planilla, con total, cobrado y saldo; tocarla abre la causa.
- Armado: en la computadora, barra lateral con Inicio, Causas, Agenda, Acuerdos, Jurisprudencia y Plantillas (columna de
  íconos desde 721 px, entera desde 1140 px); en el celular, esas vistas son una barra fija abajo. Es el mismo HTML:
  `.lateral` y `.wrap` pasan a `display: contents` y el orden lo da `order`. El chat con Claude es un botón flotante
  (`#btnChat`; se oculta con una ficha abierta) y «+ Nueva causa» flota en Causas.
- **Causas**: banda con la foto de la Justicia, buscador y todas las causas en una lista sin filtros ni resumen, **salvo las archivadas**: esas están en la tarjeta «Archivadas» al pie
  del listado (`S.arch`, `data-arch`), que las abre aparte con una tarjeta «Volver a las causas» (las de acuerdo sí se ven en el listado). Cada tarjeta (`renderCausas`): carátula,
  expediente y juzgado («Juzg. 1° Nom. Sec.2»), última acción con su fecha, la próxima acción si la hay (`.causa-prox`),
  etiquetas y el botón «Acción cautelar» (la tarjeta entera abre la causa). **Agenda**: banda con la loba (foto de fondo
  difuminada y la nítida al centro, porque la imagen es chica) y sin filtros. Los selectores y botones de filtro y el resumen
  (`#stats`, `#chips`, `#fEstado`, `#fNom`, `#btnFiltros`) siguen en el HTML pero siempre ocultos.
- Comentarios en el código: por qué, no qué.

## Cobranzas (`docs/cobranzas/`)

Segunda app, para la cobranza de deudores en mora (hoy, los prendarios que la Asociación Mutual
Bell pasa a Legales). Publicada en https://emilsoler.github.io/Gestor/cobranzas/ (el repositorio
ahora se llama `Gestor`), instalable aparte (ícono "C" verde).
Comparte con el gestor la base, el login (la sesión se guarda con la misma clave: quien entra en
una está adentro de la otra), `config.js`, `vendor/`, las tipografías, `liquidacion.js` (importes) y
`excel.js`. La persona es la única usuaria; se manejan los dos con `gestor.miembros`.

- **Tablas** (migración 0008): `public.deudores` (una fila por deudor, con sus listas en jsonb:
  teléfonos, operaciones, cuotas, gastos, pagos, planes, gestiones; la forma de cada una está al
  principio de la migración), `public.modelos_mensaje` (textos de WhatsApp con `{{campos}}`) y
  `public.ajustes_cobranzas` (una sola fila). Mismas barreras, `rev`, historial y `gestor.deshacer`.
- **Cuentas** (`calculo.js` y `gestor.liquidacion_deudor`, que dan exactamente lo mismo: las pruebas
  lo comparan con cientos de casos al azar). Como la planilla de Excel del estudio: interés simple,
  `tasa` % mensual por cada 30 días, cuota por cuota desde su vencimiento; honorarios `hon_pct` %
  sobre capital + intereses; gastos y honorarios fijos como rubros propios. La deuda es esa sola
  cuenta: el saldo de las cuotas vencidas más sus intereses (y los honorarios y gastos, si tiene).
  **No hay saldo "según la Mutual"**: la persona pidió sacarlo (migración 0009; antes era el 9 %
  mensual capitalizable del sistema de la Mutual, para comparar con su listado). No volver a
  calcularlo ni a informarlo, tampoco al contestar por el conector. `ajustes_cobranzas.tasa_sistema`
  quedó en la tabla, sin uso, y los totales con intereses del listado sirven solo para controlar que
  el PDF se leyó bien al importarlo.
- **Pagos**: cada pago dice a qué rubro va cada parte (`imp`: `capital`, `intereses`,
  `honorarios` o el id de un gasto). **La persona indica la imputación en cada pago**: no hay un
  orden automático. Lo imputado a capital cancela las cuotas en orden de vencimiento y desde la
  fecha del pago deja de generar interés.
- **Planes**: uno vigente por deudor. Los pagos con `plan` = id del plan cubren anticipo y cuotas en
  orden; una cuota está atrasada a los `gracia` días; con `caducidad` cuotas atrasadas el plan
  "está para caer" (la persona lo da por caído). Si cae, vuelve la deuda original con sus
  intereses, descontados los pagos (por eso cada pago también se imputa a los rubros originales).
  Cumplido: el deudor queda Cancelado.
  **Importes editables** (pedido de la persona, nov 2026): al armar el plan, «Importe de cada cuota» fija todas y cada cuota de la
  tabla es un campo (`f.plan.cuota` y `f.plan.imp`, aplicados en `borradorPlan`; lo escrito manda sobre la cuenta y la suma puede
  diferir de lo financiado, la app lo avisa). En un plan vigente, «Editar importes de las cuotas» (`guardarImportesPlan`) cambia solo
  los importes y anota una gestión. Desde el listado, «Eliminar» en cada fila borra al deudor (con confirmación en la fila).
- **WhatsApp**: la app arma el mensaje y abre `wa.me` con el número y el texto; **lo envía la
  persona**. No hay envío automático: la política de WhatsApp Business (app y API) prohíbe la
  cobranza de deudas, y las APIs no oficiales arriesgan el número. Nunca mandar mensajes masivos.
  Los modelos cuidan el art. 8 bis de la Ley 24.240 (nada que parezca un reclamo judicial).

Para Claude, por el conector (firman "Claude"):

```sql
select id, nombre, socio, estado from public.deudores where nombre ilike '%apellido%';
select gestor.liquidacion_deudor('<id>');                        -- a hoy; o ('<id>', '2026-11-30', true) con cuotas a vencer
select gestor.registrar_pago('<id>', '2026-10-20', '{"capital": 250000, "intereses": 50000}', 'Recibo 123', 'Transferencia');
select gestor.registrar_pago('<id>', '2026-10-20', '{"capital": 90000}', '', 'Efectivo', '', '<id del plan>');  -- pago de un plan
select gestor.anotar_gestion('<id>', 'Llamé, no atiende', 'Llamada');
select gestor.anotar_gestion('<id>', 'Dice que paga el viernes', 'Promesa de pago', null, '2026-10-24', 150000);
select gestor.proxima_deudor('<id>', 'Llamar al garante', '2026-10-27');
```

Para registrar un pago hace falta que la persona diga a qué rubros va (si no lo dice, preguntarle).
Otros cambios (datos, cuotas, planes): `update` directo dentro de una transacción con
`set_config('gestor.autor', 'Claude', true)`, cuidando la forma de cada lista.

**Importar el listado de la Mutual** ("PRENDARIOS · DOCUMENTOS VENCIDOS", un PDF del sistema):
`pdftotext -layout listado.pdf - | node dev/importar-listado.mjs` muestra lo que se leyó (con los
totales del listado para controlar) y con `--lotes <carpeta del scratchpad>` arma el `insert` en
lotes chicos (`NN-deudores.sql`, uno por llamada a `execute_sql`, copiados tal cual) más
`verificar.sql`: correrlo después en la base tiene que dar "igual" en todos los socios nuevos (si uno
da "distinto", algo cambió al copiar: borrarlo y repetir su lote). Solo agrega los socios que no
están: a los que ya se gestionan no los toca (comparar a mano si cambió algo; ahí "distinto" es lo
esperable).
El listado y los datos no se guardan en el repositorio. Con el "N de M" de cada operación también
se cargan las cuotas que faltan vencer, mes a mes.

### Pase a juicio (botón "Pasar a juicio" del Resumen del deudor)

Abre el gestor en otra pestaña con `#desde-deudor=<id>`: la ficha de una causa nueva ya armada con el
deudor (`causaDesdeDeudor` en `docs/app.js`, con las cuentas de `cobranzas/calculo.js`, que el gestor
carga recién ahí): actor AMB, demandado con DNI, teléfonos, domicilio y N° de socio, tipo PRENDARIO si hay
prenda, un título por operación con el saldo de sus cuotas vencidas (vence = la primera impaga; la
descripción como las que carga la persona: "Contrato de prenda N° … del …. 24 cuotas de $ …. Mora desde la
cuota 22 (…): se reclaman las cuotas 22 a 24 de 24.") y el movimiento "Inicio del juicio: pasó desde
Cobranzas". Las cuotas a vencer no entran: si se reclama el total, la persona ajusta el monto. Falta solo
el N° de expediente del SAC.

- **La base** (migración 0016): `causas.deudor` es el id del deudor del que salió la causa (null: cargada a
  mano; sin clave foránea, como `deudores.expte`). Al crear una causa con deudor, o al ponérselo a una que
  ya existía, el disparador `pase_a_juicio` deja al deudor "En juicio", con el expediente y la gestión
  "Pasó a juicio: expte. N° …", en la misma transacción y firmado por quien guardó la causa. Si el deudor
  ya tiene otro expediente, la causa no se guarda (el error lo dice).
- **Si el número ya es una causa**, la ficha ofrece "Vincular con esa causa": solo le pone el deudor; el
  resto de la causa no cambia.
- **Enlaces entre las apps**: `#causa=<expte>` abre esa causa en el gestor (la etiqueta "Juicio · expte."
  de Cobranzas) y `cobranzas/#deudor=<id>` abre la ficha del deudor ("Ver en Cobranzas", arriba en la
  causa). Se borran de la dirección al usarse.

Para Claude, por el conector: la misma regla vale por SQL.

```sql
begin; select set_config('gestor.autor', 'Claude', true);
insert into public.causas (expte, actor, demandado, tipo, deudor) values ('14000001', 'AMB', 'APELLIDO NOMBRE', 'PRENDARIO', '<id del deudor>');
commit;
-- o, para una causa que ya existe: update public.causas set deudor = '<id del deudor>' where expte = '14000001';
```

### Aprobación de créditos (vista "Créditos")

Dos pestañas: "Deudas por CUIT" (Central de Deudores) y "Cheques denunciados" (más abajo). La app
recuerda en el dispositivo la última que se usó.

Se escribe un CUIT o CUIL y se toca "Consultar BCRA". La app llama a la función `bcra`
(`supabase/functions/bcra/`), que verifica la sesión con la base (mismas tres barreras), pide a la API
pública de la Central de Deudores del BCRA (`https://api.bcra.gob.ar/CentralDeDeudores/v1.0/Deudas/{cuit}`,
`…/Deudas/Historicas/{cuit}` y `…/Deudas/ChequesRechazados/{cuit}`, sin clave), arma el semáforo y guarda
la consulta en `public.consultas_bcra` (migración 0010) con la sesión de la persona. No usa ningún secreto.

- **Semáforo** (`bcra.ts`, `resumir`; lo explica también la ayuda de la vista): rojo con situación 3 o
  peor en alguna entidad, o algún cheque rechazado sin pagar; amarillo con situación 2, o cheques
  rechazados ya pagados; verde si todo está en situación 1; `sin_datos` sin deudas en el último período.
  Decide la situación actual; lo peor de los últimos 24 meses queda entre los `motivos`. Cada consulta
  guarda el color con el criterio de ese día: si el criterio cambia, las anteriores no se recalculan.
- **Constancia**: la fila no se modifica (la API no tiene permiso de `update`) y la fecha y el autor los
  pone la base (disparador `constancia`). Se puede eliminar, y recuperar con `gestor.deshacer`.
  `resultado` guarda las respuestas del BCRA tal cual (montos de deudas en miles de pesos;
  `deuda_total` ya está en pesos).
- **CUIT**: el dígito verificador se controla antes de preguntar (en `creditos.js` y en `bcra.ts`): para
  el BCRA un número que no existe "no figura", y eso se leería como una persona sin deudas.
- **Desde SQL no se puede consultar al BCRA** (la base no sale a internet): lo hace el botón. Para leer
  las consultas guardadas:
  `select cuit, denominacion, semaforo, motivos, deuda_total, momento from public.consultas_bcra order by momento desc;`
- **Publicar la función**: `deploy_edge_function` con nombre `bcra`, `verify_jwt: true` y los dos archivos
  de `supabase/functions/bcra/` (entrada `index.ts`). Si la tabla todavía no está en la base, la app sigue
  andando y la vista avisa que falta activarla.
- Son datos personales: se consultan para evaluar un crédito y no salen de la app. En los registros de la
  función no queda el CUIT.

**Cheques denunciados** (pestaña "Cheques denunciados", migración 0011): se elige el banco y se escribe el
número del cheque; la misma función `bcra` (pedido `{accion: 'cheque', entidad, numero}`) pregunta a la API
pública de Cheques Denunciados del BCRA (`https://api.bcra.gob.ar/cheques/v1.0/denunciados/{entidad}/{numero}`,
sin clave) si fue denunciado como extraviado, sustraído o adulterado, y guarda la constancia en
`public.consultas_cheques` (mismas reglas que `consultas_bcra`: no se modifica, fecha y autor de la base, se
recupera con `gestor.deshacer`). `resultado` es la respuesta del BCRA tal cual, con sucursal, cuenta y causal
de cada denuncia ("Denunciado por titular" o "por tercero").

- **Bancos**: la lista sale del BCRA (`…/cheques/v1.0/entidades`, pedido `{accion: 'entidades'}`, no se
  guarda en la base) y la app la deja en el dispositivo una semana (`cb.entidades`). Arriba van los bancos
  usados hace poco, que salen del historial: se pueden elegir aunque la lista no llegue.
- **Número**: solo cifras y sin ceros adelante (`numeroCheque`, en `creditos.js` y en `bcra.ts`). Para el
  BCRA, un 404 en esta consulta es "esa entidad no existe", no "el cheque no figura".
- **Lo que no dice**: que un cheque no esté denunciado no quiere decir que tenga fondos; la ficha lo aclara
  y lleva a consultar por CUIT a quien lo firmó (la API no da el CUIT del librador).
- Para leer las consultas guardadas:
  `select entidad, entidad_nombre, numero, denunciado, fecha_bcra, momento from public.consultas_cheques order by momento desc;`
  En los registros de la función no queda el número del cheque ni el de la cuenta.

**Sin ARCA**: la vista Créditos consulta solo al BCRA. Hubo una conexión con ARCA por web service, con
certificado digital (migración 0014), y después un botón que abría su constancia pública; la persona pidió
quitar las dos cosas. 0015 borró el certificado y el permiso guardados y le cerró a la API las funciones
`public.arca_config` y `public.arca_guardar_ticket`; la tabla `gestor.arca` y esas funciones (y
`gestor.arca_certificado`) quedan vacías y sin uso, porque borrarlas (`drop`) pide una confirmación de la
persona. Lo que ARCA había respondido se sacó de las consultas guardadas y del historial de cambios. No
sumar nada de ARCA sin que la persona lo pida.

### Estado de Deuda y Refinanciación (última pestaña de "Créditos", después de "Simulación")

Es la planilla de Excel del estudio (`CALCULO_INTERESES`) con las cuentas de la app. Lo escrito no se guarda
solo (como en Vehículo y Simulación), pero se puede **guardar como caso** (ver "Casos guardados", más abajo). Las cuentas y el HTML del resultado están en
`docs/cobranzas/refinanciacion.js` (`estadoRefi`, `htmlRefi`); la pantalla y los eventos, en `app.js`
(`vistaRefi`, `actualizarRefi`, `accionRefi`, estado en `S.cred.refi`).

- **Dos fuentes de datos** (`R.fuente`): **"Cargar a mano"** (la de arranque, sin deudor) y **"De un deudor"**.
  A mano se cargan: el crédito (vencimiento de la cuota 1, monto y cantidad de cuotas), **desde
  cuándo está en mora** (`moraTipo`: un N° de cuota o una fecha; las cuotas anteriores se toman como pagadas, y vacío
  es desde la cuota 1), interés moratorio, honorarios y los
  **pagos parciales** (fecha, monto y a qué rubro se imputa). `deudorManual` arma con eso un deudor
  y la cuenta es la misma que con uno real (`liquidar`). Con un deudor, la deuda sale de su liquidación
  (cuotas, pagos, gastos cargados, su interés y sus honorarios, que se cambian en su ficha).
- **Deuda**: la liquidación (`liquidar`: interés simple por cuota desde su vencimiento, honorarios `hon_pct` %
  sobre capital + intereses, pagos ya imputados) + los gastos y honorarios de juicio que se escriban (tasa de
  justicia, martillero, abogado, otros; con un deudor, se suman a los de su ficha) + si se tilda, las cuotas a
  vencer menos los intereses a vencer. Menos la entrega inicial queda el **saldo a financiar**. Un pago parcial
  baja la deuda y corta el interés desde su fecha (no se suma, como hacía la planilla).
- **El plan no se despliega solo**: la pantalla muestra el estado de deuda ("Total adeudado") y el botón "Armar plan
  de refinanciación" (`R.plan`) abre el resto: cuotas a vencer, intereses a vencer, entrega inicial y los datos del
  plan. Sin el plan abierto esos tres importes no cuentan (`estadoRefi` los ignora y `e.conPlan` es false).
- **Plan**: `armarPlan` (cuota fija sobre saldo, en pesos enteros). La tasa de financiación arranca en la de los
  créditos prendarios (`TASA_MENSUAL` de `vehiculos.js`, la de la pestaña Simulación) y se puede cambiar. Los
  honorarios arrancan en 0 % (se completan si corresponden) y el interés moratorio en el de los ajustes de la app.
- **"Armar este plan en la ficha"** (solo con un deudor) abre la pestaña Plan con monto, entrega, cuotas,
  frecuencia, primer vencimiento y tasa ya cargados, para mandar la propuesta por WhatsApp o guardarlo. Si el
  deudor ya tiene un plan vigente, solo ofrece abrir la ficha.
- Lo escrito vive en `S.cred.refi` (no se guarda en el dispositivo). Pruebas:
  `node --test dev/tests/refinanciacion.test.mjs` (no necesita el stack; el caso es el de la planilla).

- **Casos guardados** (migración 0020, `public.casos_refi`): arriba de la pestaña, "Guardar caso" (con nombre),
  "Guardar cambios", "Guardar como caso nuevo", "Cerrar caso" y "Eliminar" (con confirmación), y la lista para abrir
  otro. Una fila por caso: `nombre`, `deudor` (id del deudor de origen o null; sin clave foránea) y `datos`, el formulario
  tal cual (`nuevaRefi`; `datosCaso` y `restaurarCaso` de `refinanciacion.js` lo guardan y lo leen, tolerando lo que falte o
  venga raro). **No guarda cuentas, pero sí la fecha de cálculo** (`datos.fecha`, la del día en que se guardó; nov 2026, la persona pidió que los montos de un caso no cambien con los días): al abrirlo se recalcula con la lógica de hoy pero a esa fecha. Un caso viejo sin fecha se abre calculado al día de su último guardado (`actualizado`). «Actualizar a hoy» (con el caso abierto) cambia la fecha y hay que «Guardar cambios» para dejarla. El campo «Fecha de cálculo» sigue sin estar en la pantalla (la persona pidió sacarlo, y también "Otras cuotas ya pagadas": lo que traigan casos viejos se ignora). Mismas barreras, `rev` (si otro dispositivo lo cambió, avisa
  en vez de pisar), historial y `gestor.deshacer`. Tabla opcional en `datos.js` (`D.casos`): si la base no la tiene, la pestaña
  sigue andando y avisa "Falta activar el guardado de casos". Para leerlos:
  `select nombre, deudor, actualizado, actualizado_por from public.casos_refi order by actualizado desc;`
  Publicar: migración 0020 y después subir la app.

- **Archivar un caso** (migración 0023, columna `casos_refi.archivado`, null = en curso): con un caso abierto, «Archivar (convenio
  firmado)» lo saca de «Casos guardados» y limpia la pantalla, pero no lo borra: queda en la lista «Archivados», de donde se abre y
  se «Desarchivar». Archivar solo cambia `archivado` (no pisa el formulario guardado) y `gestor.deshacer` lo restaura. Para leerlos:
  `select nombre, archivado from public.casos_refi where archivado is not null;`

- **Exportar la refinanciación** (`docs/cobranzas/acuerdo.js`; botones «Descargar convenio en Word» y «Descargar en Excel», visibles con el plan abierto):
  - **Excel**: dos hojas, «Refinanciación» (estado de deuda, entrega, saldo a financiar, cuota y total, con fórmulas) y «Cuotas» (cronograma con pagado, saldo y totales). `hojasRefinanciacion` las arma y `xlsx` de `excel.js` las escribe.
  - **Word**: el modelo del estudio es `docs/cobranzas/modelos/acuerdo-refinanciacion.docx`, un Word común con campos `{{así}}` (la lista y cómo se nombran cuando faltan, en `CAMPOS_ACUERDO`). `armarAcuerdo` lo lee (zip + `DecompressionStream`), reemplaza los campos en `word/*.xml` y lo vuelve a empaquetar con `zip` de `excel.js`; no hay librerías ni red. Lo que falta (DNI, domicilio, fecha del préstamo…) queda como «[DNI del deudor]» para completar a mano. El DNI sale con puntos en los miles (`dniConPuntos`) y las firmas del final son una tabla de dos columnas sin bordes, con letra de 9 pt. **El deudor del convenio es el nombre del caso** (el campo «Nombre del caso», arriba; si no tiene, el de la ficha del deudor elegido) y su **DNI** es el campo «DNI del deudor», al lado (`R.dniDeudor`, se guarda con el caso). El domicilio, la ciudad y las fechas se escriben en «Datos para el convenio»; con un deudor de la app, lo que no se escriba sale de su ficha.
  - **Cuentas del convenio**: la deuda reconocida es la suma nominal de las cuotas impagas (las vencidas y, si se tildó «Incluir las cuotas a vencer», las que faltan vencer), como dice la cláusula 1.3; los montos y cantidades en letras salen de `enLetras`. `avisosAcuerdo` avisa si lo que se refinancia suma intereses, honorarios o gastos que el modelo no menciona, si la última cuota difiere por redondeo o si el plan no es mensual.
  - **Cambiar el texto legal**: reemplazar el .docx conservando los campos que se quieran completar (un campo nuevo se agrega en `datosAcuerdo` y en `CAMPOS_ACUERDO`) y subir `VERSION` en `sw.js`. Los números van entre paréntesis en el propio modelo: `veinticuatro ({{refi_cuotas}})`.
  - El modelo trae los datos de cobro de la Mutual (CUIT, alias y CBU): el repositorio es público, así que no sumar ahí datos de personas. Pruebas: `node --test tests/acuerdo.test.mjs`.

### Demanda prendaria — "haz DP" (pestaña "Demanda prendaria" de "Créditos" y botón de la ficha)

Arma la demanda ejecutiva prendaria en Word con el modelo del estudio. Los datos se escriben a mano (el formulario es
siempre editable) o se toman de un deudor ya cargado: "Tomar los datos de un deudor" en la pestaña, o el botón
"Demanda prendaria (DP)" de la ficha, que abre la pestaña con todo ya cargado. Lo escrito no se guarda.

- **Código**: cuentas y datos en `docs/cobranzas/demanda.js` (`demandaDesdeDeudor`, `estadoDemanda`, `datosDemanda`,
  `avisosDemanda`, `CAMPOS_DEMANDA`); pantalla en `app.js` (`vistaDemanda`, `descargarDemanda`, estado en `S.cred.dp`).
  El Word lo arma `armarAcuerdo` (de `acuerdo.js`, con los nombres de campos de la demanda) sobre
  `docs/cobranzas/modelos/demanda-prendaria.docx`.
- **El modelo** lo genera `node dev/modelo-dp.mjs`: ahí está el texto de la demanda del estudio, al pie de la letra (el de
  CALDERON Pablo Gabriel, 260824), con los datos variables como `{{campos}}`. **No modificar ni ampliar el texto** (ni
  agregar cláusulas, citas ni párrafos): solo se reemplazan datos. Formato: Garamond 12, interlineado 1,5, justificado,
  fondo lavanda `CCC0D9`, sangría de primera línea 2211 en los párrafos numerados, hoja carta con los márgenes de los oficios
  (esto último es una suposición: el original no se leyó en XML; si el Word del estudio usa otra hoja o márgenes, ajustar
  `SECT` en `dev/modelo-dp.mjs` y regenerar). Hay que subir `VERSION` en `sw.js` al cambiar el modelo.
- **Cuentas**: lo reclamado es cuotas impagas × valor de la cuota; impagas = cantidad − (cuota en mora − 1); la fecha de la
  mora es el vencimiento de la cuota 1 más (cuota en mora − 1) meses. Lo único que se pregunta de la mora es el N° de cuota.
  De un deudor salen: nombre, DNI, domicilio, la prenda (operación con prenda o con vehículo: fecha, cuotas, importe,
  vehículo) y como cuota en mora la primera vencida con saldo. **No están en la ficha** y se escriben: monto de la prenda,
  Registro del Automotor y fecha de inscripción (y motor y chasis si la ficha no los trae).
- **Más de un demandado**: el formulario tiene una tarjeta por demandado (nombre, DNI, calle y número, ciudad) y «+ Agregar otro demandado» (`F.demandados`; de un deudor sale el primero, los demás se escriben). En el modelo, los datos de los demandados son un solo campo (`{{demandados}}`, de «CALDERON…, DNI Nº … con domicilio en calle … de la ciudad de …, Provincia de Córdoba», unidos con «y»; con tres o más, con «;») y hay dos campos de concordancia: `{{sea_condenado}}` («sea condenado» / «sean condenados») y `{{al_demandado}}` («al demandado» / «a los demandados», en el apartado III y en el petitorio). Con un solo demandado el texto queda idéntico al del modelo; el resto del texto no cambia (ya decía «los demandados» en VII y en el petitorio).
- **Lo que falta se avisa en pantalla**, arriba del botón de descarga: `faltanDemanda` (en `demanda.js`) lista por su nombre todo dato que va a salir entre corchetes, y `htmlEstadoDemanda` lo muestra y se actualiza al escribir. Salió de que el ejemplo en gris del Registro («Bell Ville N°1») se leía como un dato ya cargado y la demanda se bajó sin él; ahora el ejemplo dice «Ej.: …». **No poner valores por defecto** en el Registro ni en nada del contrato: cambian según la prenda y un dato equivocado va a un escrito judicial.
- Lo que falte queda como `[nombre del dato]` en el Word. Pruebas: `node --test tests/demanda.test.mjs` (sin stack).

### Descuento de cheques (última pestaña de «Créditos», migración 0035)

La Mutual le compra cheques a un cliente (un socio) y le paga hoy el valor menos lo que se descuenta (pedido de la persona
del 18/11/2026): **interés por días, comisión, sellado y gastos fijos por cheque; sin IVA**. Tres partes:
**Liquidar** (en tres pasos, pedido de la persona del 23/11/2026: **1 · Cheque** —librador, CUIT del librador, importe, fecha de pago, banco y N°, un bloque por cheque—, **2 · Socio** —nombre, CUIT, N° de socio y notas— y **3 · Liquidación** —fecha, condiciones y la liquidación en vivo—; «Guardar operación», «Descargar en Excel»),
**Cartera** (los cheques sin cobrar de todas las operaciones, por fecha de pago, con «Cobrado», «Rechazado» y «Ver operación»;
abajo, plegados, los rechazados con «¿Denunciado?» —abre la consulta de Cheques denunciados—, «BCRA del librador» y «Volver a
cartera») y **Operaciones** (las guardadas, con buscador; tocarla la abre en Liquidar para editarla o eliminarla).

- **Semáforo del librador** (`bcraDeCheque`, `consultarLibrador` en `app.js`; `resumenBcraCheque` en `creditos.js`): al escribir un CUIT
  válido en un cheque se consulta solo al BCRA (la función `bcra`, queda guardada en «Deudas por CUIT» como cualquier consulta) y debajo
  aparecen el semáforo, el nombre y las cifras (deuda, entidades, peor situación, cheques rechazados). Si hay una consulta de ese CUIT de
  las últimas 6 horas se muestra esa, sin preguntar de nuevo; «Consultar de nuevo» fuerza otra y «Ver detalle completo» abre la ficha. Al abrir
  una operación guardada solo se muestra la última consulta que exista: no se consulta sin que la persona escriba.
- **Cuentas** (`docs/cobranzas/descuento.js`, `liquidarDescuento`): por cheque, días = de la fecha de la liquidación a la fecha
  de pago (0 si ya venció) + días extra de clearing (0 a 5, `DIAS_EXTRA_MAX`; la columna Días muestra «30 + 2»: en nov 2026 la persona puso
  el plazo del cheque en ese campo y le daba el doble de días); interés = valor × tasa % mensual / 30 × días (simple, sobre el valor);
  comisión y sellado = % sobre el valor; gastos = fijos por cheque; neto = valor − todo. Cada concepto se redondea a centavos
  cheque por cheque. Las condiciones de una operación nueva arrancan como las de la última guardada (no hay tasas por defecto:
  no inventarlas). **No se guardan cuentas**: con la misma fecha y condiciones da siempre lo mismo.
- **Tabla** `public.descuentos_cheques`: una fila por operación (`cliente`, `cuit`, `socio`, `fecha`, `tasa`, `comision`,
  `sellado`, `gastos`, `dias_extra`, `notas`) y `cheques`, lista jsonb de
  `{id, entidad, banco, numero, librador, cuit, importe, vence, estado, fecha_estado, nota}` con `estado` `cartera`, `cobrado` o
  `rechazado`. `entidad` es el código de banco del BCRA si el banco se eligió de la lista (sirve para consultar si está
  denunciado). Mismas barreras, `rev`, historial y `gestor.deshacer`. Tabla opcional en `datos.js` (`D.descuentos`): sin ella la
  pestaña avisa «Falta activar el descuento de cheques». Marcar un cheque (`estadoCheque`) se reaplica sobre la última versión,
  como `cambiarDeudor`.
- Para Claude, por el conector:

  ```sql
  select fecha, cliente, jsonb_array_length(cheques) cheques from public.descuentos_cheques order by fecha desc;
  -- la cartera: cheques sin cobrar, por fecha de pago
  select d.cliente, c->>'librador' librador, c->>'banco' banco, c->>'numero' numero, (c->>'importe')::numeric importe, c->>'vence' vence
    from public.descuentos_cheques d, jsonb_array_elements(d.cheques) c where c->>'estado' = 'cartera' order by c->>'vence';
  ```
  Para marcar un cheque o cambiar una operación, `update` con `set_config('gestor.autor', 'Claude', true)`, cuidando la forma de la
  lista. El neto se calcula con las fórmulas de arriba (no está guardado).
- Pruebas: `node --test tests/descuento.test.mjs` (cuentas sin stack; permisos y deshacer con stack) y
  `node --test tests/descuento-app.test.mjs` (en el navegador, PC y celular).

### Vehículo (pestaña de «Créditos»): búsqueda asistida

Como la de la página de InfoAuto (pedido de la persona, nov 2026: con la lista anterior, angosta, no se leían los modelos):
una tarjeta a todo el ancho con cinco columnas, Marca (con buscador) → Modelo (los grupos de la marca, `/brands/{id}/groups/`)
→ Año → Versión (`/brands/{id}/groups/{g}/models/`, el nombre entero, sin cortar) → Precio (0km y usados por año; el año
elegido queda resaltado y es el valor que toma la Simulación). El año solo filtra las versiones fabricadas ese año
(`prices_from`–`prices_to`). «O buscá por nombre» manda los resultados de `/search/` a la columna Versión. En el celular las
columnas se apilan. Código: `vistaVehiculo`, `elegirMarca`, `elegirGrupo`, `elegirFab`, `elegirVehiculo` en `app.js`
(`V.pedido` descarta respuestas viejas si se elige otra cosa antes de que lleguen); estilos `.va-*` en `styles.css`.

**Sin fondos de video ni de fotos**: en nov 2026 se probó un video de fondo (en el ingreso y después en Inicio) y una foto por
vista; a la persona no le gustó (las fotos se veían pixeladas) y pidió volver a como estaba. No volver a sumarlos sin que los pida.

**Cambiar la app**: `docs/cobranzas/` (`app.js` interfaz, `datos.js` la base, `calculo.js` cuentas,
`textos.js` fechas, importes y mensajes, `creditos.js` lo que se muestra de una consulta al BCRA (por CUIT y por cheque),
`agencias.js` la solapa «Agencias», que administra el cotizador para agencias —ver «Cotizador para agencias», al final—,
`styles.css`). Si se toca una cuenta, también
`gestor.liquidacion_deudor` (migración nueva). Probar con `npm run test:cobranzas` (y las del gestor);
capturas en ancho de PC y de celular. Su service worker es `docs/cobranzas/sw.js` (`VERSION`
propia); el del gestor no atiende nada de `cobranzas/`. Estilo (nov 2026, pedido de la persona: «una pauta similar a la del
gestor»): la del rediseño oscuro del gestor, en verde y **sin fotos ni videos** (ya se probaron y no le gustaron). Fondo negro,
tarjetas verde casi negro, bordes más redondeados (`--r` 20 px), acento esmeralda (`--grad`; el dorado queda para el gestor),
títulos de tarjeta en Poppins y el nombre en Cinzel (ingreso, barra lateral y portada de Inicio). **Inicio** (`vistaInicio`,
`presentacion` y `ajustarNombre` en `app.js`): «Créditos y Cobros» de lado a lado (en el celular, dos renglones), «Estudio Soler»,
una máxima del derecho en cursiva al azar en cada apertura (`FRASES`: solo máximas conocidas, sin citas dudosas), las acciones
rápidas (`data-inicio`: Nuevo deudor, Consultar el BCRA, Descontar cheques, Armar una refinanciación) y las cinco cifras como
tarjetas (`.kpi`, la primera más ancha). En el celular las vistas son una barra fija abajo (con ícono), como en el gestor.
La barra de los gráficos (`--barra`) está validada contra la superficie.

## Prenda (`docs/prenda/`)

Tercera app, para geolocalizar los vehículos dados en garantía prendaria (con el consentimiento
del tomador), al estilo de "Encontrar" del iPhone: un mapa con los vehículos, alertas, bitácora de
consultas y constancias de ubicación. Publicada en https://emilsoler.github.io/Gestor/prenda/,
instalable aparte (ícono de pin, cian). Comparte con las otras apps la base, el login (misma clave
de sesión: quien entra en una está adentro de esta), `config.js`, `vendor/` y las tipografías. La
persona es la única usuaria; se manejan las tres apps con `gestor.miembros`. Estética del gestor,
con acento cian (azul → cian "de rastreo", `--grad`).

- **Tablas** (migración 0012): `public.vehiculos` (una fila por vehículo con GPS: datos del bien y del
  deudor, `situacion` al_dia|mora|ejecucion, `consentimiento` jsonb o null, datos del equipo e `imei`,
  `traccar_id`, y `sim` para simular la posición mientras no hay equipo), `public.ubicaciones` (la
  bitácora: una fila por consulta, **append-only** — solo select e insert; la fecha y el autor los
  pone la base, no se puede antedatar ni firmar con otro nombre, ni deshacer) y `public.ajustes_prenda`
  (una sola fila: `politica` mora|siempre, `zona_km`, centro de la zona). Mismas barreras, `rev`,
  historial y `gestor.deshacer` (menos `ubicaciones`, que es constancia).
- **La ubicación NO se pide con una consulta común**: la hace la función `ubicar`
  (`supabase/functions/ubicar/`). Verifica la sesión (mismas barreras), controla que el vehículo
  tenga `consentimiento` (sin eso no ubica), pide la posición al equipo por Traccar (o la **simula**
  si no hay `traccar_id` o no hay servidor), y deja la constancia en `ubicaciones` con la sesión de
  quien consulta. No usa clave secreta de la base. El mapa y la función calculan la posición simulada
  igual (`docs/prenda/geo.js` y `supabase/functions/ubicar/traccar.ts`), para que coincidan.
- **Consentimiento y privacidad**: sin consentimiento registrado, la app no muestra la ubicación.
  Con política "mora", los vehículos al día se ven como **zona aproximada**; el punto exacto se ve
  indicando un motivo, que queda en la bitácora. Las alertas (GPS desconectado, sin señal, fuera de
  la zona habitual) llegan aunque el crédito esté al día. No hay corte de motor a distancia.

Para Claude, por el conector (firman "Claude"):

```sql
select * from gestor.vehiculo('AE874LP');   -- busca por dominio o por deudor
select gestor.agregar_vehiculo('AE874LP', 'Fiat', 'Cronos', 2021, 'Lucía Benítez', '0412', 'mora');
select gestor.registrar_consentimiento('AE874LP', '2025-11-04');  -- recién con esto se ve la ubicación
select * from gestor.ubicaciones_de('AE874LP');   -- la bitácora del vehículo
```

Otros cambios (datos, equipo, `sim`, `zona_km`): `update` directo dentro de una transacción con
`set_config('gestor.autor', 'Claude', true)`. **Desde SQL no se puede ubicar** (la base no sale a
internet): lo hace el botón de la app. El `sim` para probar: `{"modo":"quieto","pos":[lat,lon]}` o
`{"modo":"ruta","ruta":[[lat,lon],…],"v":90,"t0":<epoch ms>}`, con opcionales `motor:"cortado"`,
`bateria`, `senal:"sin"|"regular"|"buena"`. Hay vehículos de ejemplo cargados con nota
"Ejemplo para probar — se puede borrar" (se pueden eliminar cuando haya vehículos reales).

- **Publicar la función**: `deploy_edge_function` con nombre `ubicar`, `verify_jwt: true` y los dos
  archivos de `supabase/functions/ubicar/` (entrada `index.ts`). Si la tabla todavía no está en la
  base, la app sigue andando y avisa "Falta activar la geolocalización".
- **Cuando haya equipo real (Traccar)**: cargar los secretos `TRACCAR_URL` y `TRACCAR_TOKEN` de la
  función (panel de Supabase o `create_edge_function_secret`) y poner el `traccar_id` del dispositivo
  en el vehículo. Con eso, ese vehículo usa la posición real; los que no tengan `traccar_id` se siguen
  simulando. El aparato elegido es el Teltonika FMC920 (4G). Traccar es el servidor de rastreo (código
  abierto) que recibe lo que manda el equipo y la función se lo pide por su API.

**Cambiar la app**: `docs/prenda/` (`app.js` interfaz, `datos.js` la base y la función `ubicar`,
`mapa.js` el mapa esquemático en SVG sin librerías, `mapa-datos.js` la geometría de base (rutas, río, localidades, límite) recortada de Natural Earth
—dominio público—, `geo.js` las cuentas de coordenadas y la simulación, `textos.js` formato).
Probar con `npm run test:prenda` (y las del gestor). Su service worker es `docs/prenda/sw.js`
(`VERSION` propia); el del gestor no atiende nada de `prenda/`.

## Cotizador para agencias (`docs/agencias/`)

App web para las agencias y concesionarias que ofrecen los créditos prendarios de la Asociación Mutual Bell.
Publicada en https://emilsoler.github.io/Gestor/agencias/. El vendedor entra con su usuario, elige marca,
modelo, versión y año, y ve **solo las condiciones del crédito**: monto máximo, cuota por plazo, total, y TNA,
TEA y CFT en letra chica al pie (pedido de la persona, nov 2026); lo puede mandar por WhatsApp (lo envía él, con `wa.me`; el
mensaje lleva solo vehículo, monto y cuotas: sin total ni tasas, pedido de la persona; el de la simulación rápida es el mismo, sin la línea del vehículo y con la lista de lo que el cliente tiene que mandar, `DOCS_RAPIDA`) o imprimir. La marca de la app es la de la
Mutual y no nombra a InfoAuto.

- **Licencia de InfoAuto** (presupuesto 63.199 del 04/11/2026, "Licencia Agencias/Concesionarias", tope 20
  salones): permite simular y compartir información puntual del préstamo **sin exposición de códigos ni
  valuaciones InfoAuto**. Por eso: la función nunca devuelve el precio ni el CODIA (el auto elegido viaja como
  una referencia cifrada, AES-GCM con clave derivada de la de servicio); devuelve los años con precio, no los
  precios; el monto máximo se redondea hacia abajo (`redondeo`) para no dejar leer el valor; no se guarda el
  valor ni se copia el catálogo (todo se pide a demanda, paginado con tope, y reutiliza el token de
  `infoauto_token`). La persona eligió mostrar **marca, modelo y versión** de InfoAuto para elegir el auto
  (la licencia dice "sin exposición de descripciones"). **El 18/11/2026 InfoAuto dio el ok a todo** lo que hace el
  cotizador (marca, modelo y versión, y las fotos) y dijo que **no hace falta informarles nada** (ni las altas ni las
  bajas de agencias). Siguen valiendo el resto de las reglas: ni precios, ni valuaciones, ni CODIA a una agencia. Una **web para el público final no está
  contratada**: no abrir el cotizador sin usuario. No sumar nada que muestre valores o CODIA a una agencia.
- **Elegir el auto** (pedido de la persona del 18/11/2026): marca → modelo → **año** → **versión**. `versiones` devuelve, por
  versión, `anios` (el rango `prices_from`–`prices_to` del listado desde el año mínimo, y '0km' si tiene precio de lista; años,
  nunca precios: `aniosDeVersion`). El año se elige de la unión de esos años y filtra las versiones. La versión es un campo
  donde se escribe para buscar (palabras en cualquier orden, sin acentos; Enter elige la primera). Al elegirla, `anios` confirma
  con InfoAuto que ese año tenga valor (el rango puede tener huecos); si no, avisa y la borra.
- **Foto del vehículo** (`foto.js` en la función; nov 2026, la persona pidió la foto de «Ver ficha» de InfoAuto y descartó
  dibujos propios): después de cotizar, la app pide `accion: 'foto'` con la misma `ref` cifrada; la función busca
  `/models/{codia}/photos/` en el momento, baja la primera imagen y la devuelve como `data:image/…;base64` (así la
  agencia no ve la dirección ni el CODIA, y la CSP de la app no cambia: `img-src 'self' data:`). No se guarda nada. Sin
  foto o con cualquier error: `foto: null` y el resultado se ve como antes. El formato de la respuesta de fotos no está
  documentado: `urlDeFoto` acepta lista u objeto con `url`/`image`/`photo`/… (si no encuentra nada, revisar los logs
  `agencias: 'foto'` y una respuesta real). **Licencia**: usar las fotos quedó a confirmar con InfoAuto; si dicen que no,
  poner el secreto `AGENCIAS_FOTOS=no` en Supabase (corta las fotos sin tocar el código).
  **Estado**: hasta el 18/11/2026 InfoAuto respondía **403** (sin permiso) a `/models/{codia}/photos/`; ese día **las habilitó**
  y las fotos se ven (confirmado por la persona). Si vuelve un 403 justo después de un cambio de permisos en InfoAuto, vencer el
  token guardado (`update public.infoauto_token set access_vence = 'epoch', refresh_vence = 'epoch' where id = 1`) para que pida uno nuevo.
- **Las agencias no son miembros del gestor**: `gestor_puerta` les cierra toda la API de la base. Solo hablan con
  la función `agencias`, que las reconoce con `public.agencia_sesion` (clave de servicio). Un miembro que entra
  a `/agencias/` ve solo una «vista previa» (sus cotizaciones no se registran, puede probar con el cotizador
  deshabilitado) con un enlace a la administración, que está en **Créditos y Cobros → Agencias** (ver «Administración», más
  abajo; nov 2026, la persona no quería entrar y salir del cotizador con dos cuentas para revisar las solicitudes).
  **Sesión propia** (`storageKey: 'agencias.sesion'`, no la `gestor.sesion` de las otras tres apps): entrar al cotizador con una
  cuenta de agencia no cierra la sesión del gestor en ese navegador, ni al revés; la persona entra al cotizador aparte.
- **Agencia de prueba**: «Emiliano Soler» (emiliano_soler@hotmail.com; se llamaba «PROPIO» hasta el 19/11/2026, el nombre está en la base, no en el código), cuenta de la persona para probar el recorrido de una agencia;
  su `informada_infoauto` es la fecha del alta (17/11/2026), no un aviso real (lo dice su nota). Ocupa uno de los 20 lugares:
  pausarla (`gestor.pausar_agencia`) cuando no se use.
- **Simulación rápida** (migración 0036, pedido de la persona del 19/11/2026): solapa «Simulación rápida» del cotizador, **solo para
  la agencia con `agencias.simulacion_rapida = true`** (la cuenta «Emiliano Soler» y las agencias que la persona pidió; la lista está en la base: `select nombre from public.agencias where simulacion_rapida`). Capital, cuotas, tasa mensual y los gastos de
  `GASTOS_DEFECTO` escritos a mano (arrancan en la tasa del 0 km y los gastos de los parámetros), sin CUIT, sin BCRA y sin vehículo.
  Acción `rapida` de la función (a cualquier otra agencia o a la vista previa le contesta «Pedido desconocido»); no usa InfoAuto, no
  se registra en `cotizaciones_agencia` ni cuenta para el tope. `vistaRapida` y `simularRapida` en `docs/agencias/app.js`. Al lado del sellado y del arancel se ve el monto que dio la última simulación (la función devuelve `sellado` y `arancel`), y seguro, administrativos, cuota social e IGR van plegados en «Gastos que se reparten en las cuotas» (pedido del 19/11/2026). Para dársela
  o quitársela a otra cuenta: `update public.agencias set simulacion_rapida = … where email = '…'` (con `set_config('gestor.autor', 'Claude', true)`),
  solo si la persona lo pide.
- **Tablas** (migración 0025): `public.agencias` (nombre, email, cuenta, `activa`, `informada_infoauto` —fecha
  del aviso por escrito a InfoAuto; **opcional desde la migración 0034** (18/11/2026: InfoAuto dijo que no hace falta avisarles) y la
  app ya no la pide; queda la de las agencias viejas—, `clave_temporal`; tope de 20 activas y una cuenta
  del gestor no puede ser agencia, lo controla `gestor.tg_agencias_reglas`), `public.ajustes_agencias` (una fila:
  `habilitado` —arranca en false—, `pct_financiable`, `tasa_mensual`, `plazos`, `antiguedad_max`, montos mínimo y
  máximo, `redondeo`, `gastos` con la forma de `GASTOS_DEFECTO`, `tope_diario` por agencia, `leyenda`, `contacto`) y
  `public.cotizaciones_agencia` (cada simulación de una agencia, sin valor ni CODIA, **con el CUIT que la agencia consultó** —migración 0039, pedido de la persona del 22/11/2026: la app lo manda en `cotizar`, la función lo valida y, si falta o está mal, queda vacío—; los miembros las leen, con el CUIT en la pestaña Cotizaciones, y las pueden eliminar).
- **Cuentas**: `supabase/functions/agencias/credito.js` tiene una copia exacta de `simularCredito` de
  `docs/cobranzas/vehiculos.js` (las pruebas las comparan: si se cambia una, cambiar la otra), más `montoMaximo` y
  `tasasDelCredito` (TNA = tasa × 12; TEA = (1 + tasa)^12 − 1; CFT = TEA de la TIR entre lo que recibe el comprador y
  la cuota final, con todos los gastos, sin IVA).
- **Parámetros de la Mutual** (migración 0027, pedido de la persona del 17/11/2026): 40 % del valor, de 1 a 24 cuotas,
  modelos 2012 en adelante (`anio_minimo`; era 2014, la persona lo bajó el 19/11/2026), tasa mensual según el año del modelo (`tasas`: 2021 en adelante 5 %, 2018 a
  2020 6 %, 2014 a 2017 7 %; el 0 km cuenta como el año en curso; `tasaPara` en `credito.js`) y los gastos del simulador
  interno **sin envío ni gestoría** (en 0). Se cambian en Créditos y Cobros → Agencias → Parámetros (los plazos aceptan un rango, «1-24»,
  y las tasas, «2021=5; 2018=6; 2014=7»).
- **Flujo de la agencia** (pedido de la persona del 17/11/2026, migraciones 0027 y 0028):
  1. **El cliente**: CUIT → BCRA (acción `bcra`, con `bcra.ts`, **copia exacta** de `supabase/functions/bcra/bcra.ts`, mismo
     semáforo que Cobranzas; las pruebas comparan los dos archivos). A la agencia le llegan el color, el nombre y un resumen del último período de la Central de Deudores (`bancos`: entidad, situación y deuda en pesos; `deuda_total`, `periodo`; pedido de la persona del 18/11/2026: se muestra a la derecha del recuadro «1 · El cliente», `resumenBCRA` en `app.js`, y «Otro cliente» quedó fuera del recuadro); lo histórico y los cheques siguen solo para la Mutual. Ve:
     verde «Continuar»; amarillo y sin antecedentes «Continuar – Sujeto a revisión»; rojo «No apto» (no sigue). La consulta
     completa queda en `public.consultas_bcra` firmada «Agencia · <nombre>» (también en Créditos y Cobros → Deudas por CUIT) y
     cuenta para el `tope_diario`.
  2. **El crédito**: simula el vehículo. Debajo, «Continuar con la solicitud» si el cliente quiere avanzar.
  3. **Ingresos**: «¿Tiene ingresos demostrables?» Sí/No (con No no avanza); ingreso mensual aproximado: la cuota no puede pasar
     `ajustes_agencias.relacion_max` % (45) del ingreso; recién ahí elige cómo los obtiene (relación de dependencia,
     monotributo o responsable inscripto).
  4. **Documentación**: desde el 20/11/2026 (pedido de la persona) un **solo recuadro** donde la agencia suelta o elige todos los
     archivos juntos («Arrastrá los archivos acá»; en el celular se toca y se eligen varios de la galería), con el cartel «Recordá que
     para aprobar el crédito necesitamos los archivos PDF…» y los 7 puntos arriba (`REQUISITOS` en `docs/agencias/app.js`; el texto lo
     escribió la persona, no cambiarlo sin que lo pida). Es el casillero `documentacion`, hasta 40 archivos, PDF o JPEG de hasta 10 MB.
     Ya no se sabe qué archivo es cuál: la Mutual los mira y, si falta algo, lo pide por otra vía. Antes eran un casillero por documento
     (DNI, recibos, título, servicio, CBU…): las solicitudes anteriores conservan sus archivos con esos `slot`, y `docsSinAdjuntar`
     (solicitud.js) mide lo que falta con los grupos de entonces o con el casillero único, según la solicitud.
  5. **Datos del cliente** (empleo o actividad opcional, DNI, domicilio real, estado civil —casado: lugar y fecha del matrimonio—, celular,
     y CBU o CVU **opcional**; si se escribe, se controlan sus dígitos verificadores y hay que decir si la cuenta es **propia o de un tercero**
     (de un tercero: titular, su CUIT o CUIL —validado— y la relación con el cliente, opcional). Más la conformidad del cliente para mandar
     sus datos a la Mutual. Los datos son obligatorios; **los documentos no** (migración 0030, pedido de la persona del 17/11/2026: a veces
     llegan por otra vía). La app avisa «No adjuntaste ningún archivo» y deja enviar; la Mutual ve en la solicitud que no hay archivos.
  El casillero, su tope de archivos y los controles de los datos están en `docs/agencias/solicitud.js`, con **copia exacta**
  en `supabase/functions/agencias/solicitud.js`; el casillero admitido también en `gestor.docs_requeridos` y su tope en
  `gestor.docs_maximo` (migración 0037; las pruebas comparan los tres). Si se cambia la documentación que se pide, cambiar los tres
  (migración nueva).
- **Envío** (acciones `solicitar`, `archivo`, `enviar`): `solicitar` recalcula el crédito (no confía en el navegador), controla
  ingresos, relación, datos y conformidad, y crea la solicitud en estado `cargando` (exige una consulta al BCRA no roja de esa
  agencia, de los últimos 3 días, y no deja dos pendientes para el mismo CUIT; las que quedaron a medio cargar de ese cliente, o
  de hace más de 2 días, se borran con sus archivos). Después sube **un archivo por pedido** (formulario multipart); la función
  mira los primeros bytes (solo PDF o JPEG, hasta 10 MB) y lo guarda en la **carpeta privada `solicitudes` del almacenamiento**
  (Storage), en `<id de la solicitud>/<casillero>-<azar>.<pdf|jpg>`, con su SHA-256 en `solicitudes_credito.archivos`. La carpeta
  **no tiene políticas**: solo la usa la función, con la clave de servicio. La app achica las fotos antes de subirlas (2000 px,
  JPEG) y pasa a JPG las PNG o las del iPhone. `enviar` la deja `pendiente`, con o sin archivos (`gestor.docs_requeridos`, pese al nombre, dice solo qué casilleros admite).
  Mientras está `cargando` no la ve nadie y la Mutual no la puede resolver.
- **Solicitudes** (`public.solicitudes_credito`, migraciones 0027 a 0029): agencia, CUIT, nombre, color del BCRA, vehículo,
  año, monto, cuotas, cuota, total, tasa, CFT, `ingreso`, `relacion`, `categoria`, `datos` (DNI, domicilio, estado civil,
  matrimonio, celular, CBU, `cuenta` propia|terceros y, de un tercero, `cuenta_titular`, `cuenta_cuit`, `cuenta_relacion`),
  `archivos` y `cliente` (el celular); sin valor del vehículo ni CODIA. Las crea solo la función
  (`agencia_solicitar`, `agencia_archivo`, `agencia_enviar`, clave de servicio). La Mutual las ve en Créditos y Cobros →
  Agencias → **Solicitudes**, **resumidas para decidir** (pedido de la persona del 17/11/2026): arriba y en grande la agencia;
  después el cliente (nombre, CUIT y el BCRA como un **círculo de color** verde, amarillo —también sin antecedentes— o rojo, sin el texto «Continuar»/«Sujeto a revisión»; pedido de la persona del 17/11/2026), el crédito (monto con el **% del valor del vehículo** —`datos.pct_valor`, que calcula
  la función al solicitar y la agencia no ve—, cuotas y vehículo) y el trabajo e ingresos (categoría, **empleo, profesión o
  actividad** —`datos.actividad`, campo opcional del paso 4 del cotizador— e ingreso declarado). Lo que hace falta después
  (deuda informada, total, tasa, CFT, DNI, domicilio, estado civil, celular, CBU) va plegado en «Más datos del cliente y del
  crédito»; si el DNI no coincide con el CUIL, se avisa afuera y «Ver documentos», que pide a la función (acción `archivos`, solo miembros) enlaces que vencen a los
  15 minutos. **«Descargar todo en un PDF»** (`docs/cobranzas/unirpdf.js`, pedido de la persona del 17/11/2026) pide esos enlaces,
  baja cada archivo y arma en el navegador un solo PDF: carátula (cliente, agencia, crédito, documentos y «Sin adjuntar»), y
  después cada documento por casillero, con un rótulo arriba (los PDF con sus páginas; cada foto en una A4); lo que no se pueda
  leer queda como una hoja «No se pudo incluir». Usa pdf-lib (MIT; `docs/vendor/pdf-lib.js`, copiada por `dev/vendor.mjs`),
  que se carga recién al tocar el botón. Las aprueba o rechaza con una nota: los miembros solo pueden cambiar `estado` y `nota`; quién y cuándo resolvió
  lo pone la base. **«Eliminar»** (con confirmación, en cualquier estado; pedido de la persona del 17/11/2026) la borra con
  sus documentos: la app pide a la función `agencias` la acción `eliminar` (solo miembros), que llama a
  `public.solicitud_eliminar` (migración 0031, solo para la clave de servicio; firma con el nombre del miembro) y borra los
  archivos de `solicitudes`. La fila queda en `gestor.cambios` (`gestor.deshacer` la restaura), los documentos no. La agencia ve en «Mis solicitudes» en qué quedó cada una. No hay aviso por mail ni WhatsApp de una solicitud
  nueva: se ve en Créditos y Cobros (la insignia de la solapa y el aviso de Inicio). Son datos personales y documentos de identidad e ingresos: no salen de ahí y no se
  copian al repositorio. El almacenamiento del plan gratuito es de 1 GB (una solicitud con fotos ocupa unos pocos MB).
- **Estados de la solicitud** (migración 0041, pedido de la persona del 23/11/2026): `cargando` (interno, la agencia sube archivos) → `pendiente` → `en_analisis` → `aprobada` | `rechazada`. La agencia ve `pendiente` como **«Recibida»** y `en_analisis` como **«En análisis»** (con la nota que haya dejado la Mutual); la Mutual tiene el botón «Pasar a en análisis» (solo desde recibida) y sigue pudiendo aprobar o rechazar desde cualquiera de las dos. **«En análisis» no es una resolución**: no pone `resuelto` ni `resuelto_por` (lo decide `gestor.tg_solicitud_resuelta`), cuenta como abierta para la solapa, la insignia y el aviso de Inicio (`solicitudAbierta` en `docs/cobranzas/agencias.js`, `contarSolicitudes` en `datos.js`) y, igual que «recibida», impide mandar otra solicitud del mismo cliente (`agencia_solicitar`). **Aviso a la agencia**: la solapa «Mis solicitudes» muestra un número cuando una solicitud cambió de estado desde la última vez que se miró; la app lo revisa al entrar, cada minuto y al volver a la pestaña (`mirarNovedades` en `docs/agencias/app.js`) y cambia solo el rótulo, sin volver a dibujar lo que se esté escribiendo. Lo ya visto se recuerda en el dispositivo (`agencias.vistas`). No hay aviso al celular de la agencia (el push es solo de la Mutual).

- **Vendedores** (migración 0042, pedido de la persona del 23/11/2026): cada agencia puede tener varios vendedores, cada uno con su propio
  usuario (`public.agencia_vendedores`: nombre, email, `user_id`, `activo`, `titular`). **Cada vendedor ve solo lo suyo**: sus solicitudes
  (`solicitudes_credito.vendedor_id`), sus cotizaciones y su chat con la Mutual (`chats_agencia.vendedor_id`, un chat abierto por vendedor).
  **La persona da el alta** (no la agencia): Créditos y Cobros → Agencias → «Agregar un vendedor a una agencia» (acción `crear_vendedor` de la
  función, solo miembros; crea la cuenta con clave provisoria al azar que se ve una sola vez, como `crear_agencia`). La cuenta con la que se
  dio de alta cada agencia es su **titular** (se creó sola en la migración; `gestor.autorizar_agencia` la crea también). Los topes son
  **por agencia**, no por vendedor (20 agencias activas, `tope_diario` de cotizaciones y consultas al BCRA). Pausar la agencia pausa a todos;
  pausar un vendedor (`agencia_vendedores.activo`) corta solo a ese. Solo se puede entrar con la cuenta de un vendedor activo de una agencia activa
  (`public.agencia_sesion`). Por SQL: `select gestor.autorizar_vendedor('titular@agencia.com', 'vendedor@agencia.com', 'Nombre')` y
  `select gestor.pausar_vendedor('vendedor@agencia.com')` (la cuenta de login hay que crearla antes). Publicar: migración 0042,
  `deploy_edge_function` de `agencias` (siete archivos) y subir la app. Pruebas: el test «vendedores» de `agencias.test.mjs` y el del panel en `agencias-admin.test.mjs`.

- **Cuota deseada** (pedido de la persona del 23/11/2026, sin migración): en el paso 2, bajo el título en negrita «También tenés la posibilidad de indicar
  simplemente la cuota que puede pagar el cliente y nosotros calculamos el resto», hay un campo opcional: «Cuota que quiere pagar (hasta)» manda `cuota_max` a
  `cotizar`: en cada plazo, la función busca (por mitades, de a $ 1.000 o el `redondeo`) el monto más alto cuya cuota no pase de lo pedido, sin pasar el
  máximo ni el monto solicitado; devuelve `cuota_max` y `opciones` con `monto` por plazo (sin `cuota_max`, todo igual que antes). **Precio de venta y
  anticipo** se sacaron el mismo día (pedido de la persona): no volver a sumarlos sin que los pida. Prueba: el test «cuota deseada» de `agencias.test.mjs` y `agencias-cotizar-app.test.mjs`.

- **Historial de cotizaciones** (migración 0043, pedido de la persona del 23/11/2026): pestaña «Mis cotizaciones» del cotizador. Acción `cotizaciones` de la
  función (`public.agencia_cotizaciones`, solo service_role): las últimas 50 del vendedor (cada uno ve solo las suyas; la vista previa de la Mutual no tiene),
  con vehículo, año, monto, cuotas, cuota, CUIT y fecha; sin valor ni CODIA. Es lo que se calculó ese día, no se recalcula; cada una tiene «Mandar por WhatsApp»
  (mismo texto que el resultado). No se puede «repetir» una cotización sin volver a elegir el auto: la tabla no guarda la referencia al vehículo, a propósito.
  Pruebas: el test «historial» de `agencias.test.mjs` y el paso 4 de `agencias-cotizar-app.test.mjs`. Publicar: migración 0043, `deploy_edge_function` de `agencias` y subir la app.
  **Eliminar** (migración 0045, pedido de la persona del 23/11/2026): cada cotización tiene «Eliminar» (con segundo toque). Acción `cotizacion_eliminar {id}` (sin `id`, las oculta todas; solo vendedores, no la vista previa de la Mutual) → `public.agencia_cotizacion_ocultar`: marca `cotizaciones_agencia.oculta`, **no borra la fila**, así el tope diario de la agencia no se reinicia y la Mutual la sigue viendo en Agencias → Cotizaciones. Cada vendedor solo toca las suyas. Prueba: «historial: eliminar…» de `agencias.test.mjs`. Publicar: migración 0045, `deploy_edge_function` de `agencias` y subir la app.

- **Estadísticas por agencia** (migración 0044, pedido de la persona del 23/11/2026): solapa «Estadísticas» de Créditos y Cobros → Agencias. Función `public.estadisticas_agencias(p_dias)` (SECURITY INVOKER: solo los miembros ven filas, por las políticas de las tablas; `null` = desde siempre) con, por agencia, cotizaciones, solicitudes mandadas, aprobadas, rechazadas, abiertas, monto aprobado y última cotización. La pantalla (`htmlAgencias`, `cargarEstadisticas` en `app.js`) ofrece 30 días, 90 días o desde siempre y muestra qué parte de las cotizaciones terminó en solicitud. Con gráficos de barras en SVG (`graficoBarras` en `agencias.js`, clases `.gr-*`): cotizaciones, solicitudes y aprobadas por agencia, y monto aprobado. Prueba: «estadísticas» de `agencias-admin.test.mjs`. Publicar: migración 0044 y subir la app (la función `agencias` no cambia).

### Chat «M» con la Mutual (migración 0038, pedido de la persona del 22/11/2026)

Botón flotante «M» en el cotizador (`docs/agencias/chat.js`): abre un chat con un asistente que responde dudas básicas y, si la
agencia lo pide («Hablar con un representante»), avisa a la Mutual; ahí contesta la persona desde Créditos y Cobros → Agencias →
**Chats** (`htmlChats` en `docs/cobranzas/agencias.js`). **Arranca apagado**: se prende con «Chat con la Mutual» en Parámetros
(`ajustes_agencias.chat_habilitado`).

- **El asistente** (`supabase/functions/agencias/chat.js`, API de Claude; modelo `claude-haiku-5-5`, `AGENCIAS_CHAT_MODELO` lo cambia;
  usa el secreto `ANTHROPIC_API_KEY`, el mismo de la función `chat`). Se apoya en la «hoja de respuestas» (`ajustes_agencias.ayuda`,
  editable en Parámetros). **No recibe** el % financiable, las tasas por año ni valores: revelarían el valor del vehículo
  (licencia de InfoAuto), y la respuesta se filtra por si nombra a InfoAuto o al CODIA. Termina con `[[REPRESENTANTE]]` cuando
  conviene una persona. Topes por agencia y día: 200 mensajes y 60 respuestas del asistente.
- **Eliminar conversaciones** (pedido de la persona del 23/11/2026): en Agencias → Chats, al abrir una conversación (abierta o cerrada) hay «Eliminar conversación», con confirmación. La acción `chat_eliminar {chat}` de la función (solo miembros) borra la fila de `chats_agencia` (los mensajes se van por la clave foránea) y los audios que hubiera. No queda historial y no se puede deshacer.
- **Estados** (`chats_agencia.estado`): `bot` → `espera` (pidió persona) → `humano` (la Mutual respondió) → `cerrado`. Un solo chat
  abierto por agencia. Con una persona en la conversación el asistente calla. Tablas `chats_agencia`, `mensajes_agencia`,
  `avisos_push` y `push_claves`: sin políticas ni permisos para la API (solo la función con la clave de servicio).
- **Avisos a la Mutual**: push al celular (Web Push hecho a mano con WebCrypto, `push.js`; claves VAPID creadas por la función la
  primera vez y guardadas en `push_claves`) y, si se configura, mail de respaldo por Resend (`RESEND_API_KEY`, `AVISO_EMAIL`,
  opcionales `AVISO_REMITENTE` y `RESEND_URL`; sin eso no hace nada). Avisa siempre al pedir representante; después, solo si la
  Mutual ya había leído lo anterior. **iPhone**: iOS 16.4 o más y Créditos y Cobros instalada en la pantalla de inicio; ahí se toca
  «Activar avisos» (Agencias → Chats). El service worker `docs/cobranzas/sw.js` atiende `push` y `notificationclick`.
- **Publicar**: migración 0038 y `deploy_edge_function` de `agencias` con **siete** archivos (`index.ts`, `credito.js`, `bcra.ts`,
  `solicitud.js`, `foto.js`, `chat.js`, `push.js`); después subir la app. `PUSH_PERMITIR_LOCAL=1` solo lo pone `dev/stack.sh`.
- Pruebas: `agencias-chat-puro`, `agencias-chat`, `agencias-chat-audio`, `agencias-chat-app` y `agencias-chat-voz-app` (incluidas en `npm run test:agencias`).
- **Sin voz ni audios** (pedido de la persona del 23/11/2026: «no hace falta»): el chat no tiene el botón «Escuchar» ni el micrófono, y
  la Mutual no tiene el botón de escuchar audios (se sacaron de `docs/agencias/chat.js`, `docs/cobranzas/app.js` y `agencias.js`). La
  función `agencias` todavía acepta `chat_audio` y `chat_audio_ver` (y existe la carpeta `chat-audios` y las columnas de la migración 0040): quedaron
  sin uso, sin pantalla que las llame; `agencias-chat-audio.test.mjs` sigue probando la función. No volver a sumar voz sin que la persona lo pida.

Para Claude, por el conector:

```sql
-- alta: lo normal es el botón «Crear agencia» de Créditos y Cobros → Agencias → Agencias (ver abajo). Si la cuenta ya existe
-- (creada en el panel de Supabase: Add user, Auto Confirm), solo se habilita con esto:
select gestor.autorizar_agencia('ventas@agencia.com', 'Agencia X', null);  -- 3.º: fecha del aviso a InfoAuto, ya no hace falta
select gestor.pausar_agencia('ventas@agencia.com');
select nombre, email, activa, informada_infoauto from public.agencias order by nombre;
select momento, agencia, vehiculo, anio, monto, cuotas, cuota from public.cotizaciones_agencia order by momento desc limit 50;
update public.ajustes_agencias set habilitado = true;   -- con set_config('gestor.autor', 'Claude', true)
select momento, agencia, cuit, denominacion, vehiculo, anio, monto, cuotas, cuota, estado from public.solicitudes_credito order by momento desc;
update public.solicitudes_credito set estado = 'aprobada', nota = '…' where id = '<id>';   -- solo si la persona lo decide
select name, metadata->>'size' tamano from storage.objects where bucket_id = 'solicitudes' order by created_at desc;  -- los archivos
```
Desde SQL no se abren los documentos: los enlaces los da la función (botón «Ver documentos» de Créditos y Cobros → Agencias).

- **Administración** (solapa «Agencias» de Créditos y Cobros, `vistaAgencias` en `docs/cobranzas/app.js`; el HTML y la lectura
  de los parámetros en `docs/cobranzas/agencias.js`, que importa los casilleros de `../agencias/solicitud.js`; lo que habla con la
  base y con la función en `docs/cobranzas/datos.js`: `leerAgencias`, `contarSolicitudes`, `guardarAjustesAgencias`, `altaAgencia`,
  `activarAgencia`, `resolverSolicitud`, `documentosSolicitud`). Cuatro pestañas: Solicitudes (pendientes primero, con BCRA,
  crédito, ingresos, datos, «Ver documentos», nota y Aprobar/Rechazar; abajo las resueltas), Parámetros, Agencias (alta, pausar y
  activar) y Cotizaciones. Las solicitudes pendientes se cuentan al entrar, cada minuto y al
  volver a la app: insignia en la solapa y aviso arriba de Inicio. `cobranzas/#agencias` abre la solapa. Usa la sesión de la
  persona (las mismas barreras); los documentos los pide a la función `agencias`. Pruebas en el navegador:
  `dev/tests/agencias-admin.test.mjs` (dentro de `npm run test:agencias`).
- **Crear agencia desde la app** (migración 0032, pedido de la persona del 17/11/2026): en la pestaña Agencias, «Crear agencia» pide
  nombre, email y notas (sin fecha de aviso a InfoAuto desde la migración 0034); la función `agencias` (acción `crear_agencia`, solo miembros) crea la cuenta
  con la API de administración del login (`/auth/v1/admin/users`, clave de servicio), con una **contraseña provisoria al azar de
  12 caracteres**, y la habilita con `public.agencia_alta` (solo `service_role`; firma con el nombre del miembro y llama a
  `gestor.autorizar_agencia`, que deja `clave_temporal`). Si la habilitación falla (por ejemplo, ya hay 20 activas), borra la cuenta
  recién creada. La contraseña se muestra **una sola vez** en pantalla (`S.ag.nueva`, nunca en el chat ni en la base ni en los
  registros): la persona se la manda a la agencia ella misma («Copiar los datos para enviar» arma el mensaje con usuario y contraseña, sin el enlace: la persona manda el QR aparte) y la
  agencia elige la suya al entrar (`clave_definida`). «Ya tiene cuenta: solo habilitar» sigue disponible. Prueba 18 de `agencias.test.mjs`.
- **Eliminar cotizaciones** (migración 0033, pedido de la persona del 17/11/2026): en la pestaña Cotizaciones, «Eliminar» en cada
  fila y «Eliminar todas», con confirmación. Se borra por la API con la sesión de la persona (política `miembros_eliminan`, con
  `es_miembro()`; las agencias no tienen acceso). Es solo un registro de simulaciones: **no queda historial** (`cotizaciones_agencia` no
  tiene el disparador `auditar`) y no se puede deshacer. Ojo: el tope diario de cada agencia cuenta estas filas, así que borrar las de
  hoy le devuelve cotizaciones del día.
- **Publicar la función**: `deploy_edge_function` con nombre `agencias`, `verify_jwt: true` y los siete archivos de
  `supabase/functions/agencias/` (`index.ts` de entrada, `credito.js`, `bcra.ts`, `solicitud.js`, `foto.js`, `chat.js` y `push.js`). Usa los secretos `INFOAUTO_USER` e `INFOAUTO_PASS`.
- **Pruebas**: `npm run test:agencias` (función de punta a punta contra `dev/infoauto-falso.mjs`, con vehículos y
  precios inventados, contra `dev/bcra-falso.mjs` para el BCRA y contra `dev/storage-falso.mjs` para el almacenamiento, que la
  base local no tiene; controla que ninguna respuesta a una agencia incluya un precio o un CODIA, la tasa por año, el semáforo,
  la relación cuota/ingreso, los documentos y las solicitudes).

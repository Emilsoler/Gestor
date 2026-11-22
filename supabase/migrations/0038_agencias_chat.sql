-- Chat de las agencias con la Mutual: el botón flotante «M» del cotizador (pedido de la persona del 21/11/2026).
--
-- La agencia escribe y le contesta primero un asistente (Claude) con la «hoja de respuestas» que la persona edita
-- en Créditos y Cobros → Agencias → Parámetros. Si la agencia lo pide, el chat pasa a un representante: la
-- conversación queda «en espera», la persona recibe un aviso (en la app, por notificación del celular y, si está
-- configurado, por mail) y le contesta desde Créditos y Cobros → Agencias → Chats.
--
-- Igual que el resto del cotizador, las agencias no tocan la base: todo pasa por la función `agencias` con la clave
-- de servicio. Estas tablas no tienen permisos para los roles de la API; la Mutual las lee y responde también por
-- la función. El chat arranca apagado (`chat_habilitado = false`): lo prende la persona cuando lo haya revisado.
--
--   chats_agencia      una conversación por fila. estado: bot (contesta el asistente) | espera (pidió un representante y
--                      nadie contestó) | humano (ya contestó la Mutual) | cerrado
--   mensajes_agencia   de: agencia | bot | mutual
--   avisos_push        los celulares de la Mutual registrados para recibir avisos (Web Push)
--   push_claves        el par de claves VAPID con que la función firma los avisos (una fila, solo para la función)

alter table public.ajustes_agencias
  add column chat_habilitado boolean not null default false,
  add column ayuda text not null default '' check (length(ayuda) <= 12000);
comment on column public.ajustes_agencias.chat_habilitado is
  'true: las agencias ven el botón «M» y pueden chatear. Arranca en false.';
comment on column public.ajustes_agencias.ayuda is
  'La hoja de respuestas del asistente del chat (texto libre que edita la persona). Vacía: se usa la hoja base de la función.';

-- ───────────────────────── Conversaciones ─────────────────────────
create table public.chats_agencia (
  id               uuid primary key default gen_random_uuid(),
  agencia_id       uuid not null references public.agencias (id) on delete cascade,
  agencia          text not null,
  estado           text not null default 'bot' check (estado in ('bot', 'espera', 'humano', 'cerrado')),
  creado           timestamptz not null default now(),
  actualizado      timestamptz not null default now(),
  espera_desde     timestamptz,
  sin_leer_mutual  boolean not null default false,
  sin_leer_agencia boolean not null default false
);
create index chats_agencia_agencia_idx on public.chats_agencia (agencia_id, estado);
create index chats_agencia_actualizado_idx on public.chats_agencia (actualizado desc);
-- Una sola conversación abierta por agencia: la que se retoma al volver a tocar la «M».
create unique index chats_agencia_una_abierta on public.chats_agencia (agencia_id) where estado <> 'cerrado';
comment on table public.chats_agencia is
  'Conversaciones del chat de las agencias (botón «M» del cotizador). Solo la función `agencias` las lee y escribe.';

create table public.mensajes_agencia (
  id      bigint generated always as identity primary key,
  chat_id uuid not null references public.chats_agencia (id) on delete cascade,
  de      text not null check (de in ('agencia', 'bot', 'mutual')),
  texto   text not null check (length(texto) between 1 and 4000),
  momento timestamptz not null default now()
);
create index mensajes_agencia_chat_idx on public.mensajes_agencia (chat_id, id);
comment on table public.mensajes_agencia is
  'Mensajes de los chats de las agencias. Sin valores de vehículos ni códigos: el asistente no los conoce.';

-- ───────────────────────── Avisos al celular ─────────────────────────
create table public.avisos_push (
  id       bigint generated always as identity primary key,
  user_id  uuid not null,
  endpoint text not null unique check (length(endpoint) between 20 and 2000),
  p256dh   text not null check (length(p256dh) between 20 and 200),
  auth     text not null check (length(auth) between 10 and 100),
  agente   text not null default '' check (length(agente) <= 300),
  creado   timestamptz not null default now()
);
comment on table public.avisos_push is
  'Celulares de los usuarios de la Mutual que activaron los avisos (Web Push). Solo la función `agencias` los lee.';

create table public.push_claves (
  id       int primary key default 1 check (id = 1),
  publica  text not null,
  privada  jsonb not null,
  creado   timestamptz not null default now()
);
comment on table public.push_claves is
  'Claves VAPID de los avisos al celular (la privada firma cada aviso). Las crea la función `agencias` la primera vez; no las lee ningún rol de la API.';

-- ───────────────────────── Permisos ─────────────────────────
alter table public.chats_agencia enable row level security;
alter table public.mensajes_agencia enable row level security;
alter table public.avisos_push enable row level security;
alter table public.push_claves enable row level security;
revoke all on public.chats_agencia, public.mensajes_agencia, public.avisos_push, public.push_claves from public, anon, authenticated;
grant all on public.chats_agencia, public.mensajes_agencia, public.avisos_push, public.push_claves to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ───────────────────────── Estadísticas ─────────────────────────
create or replace function gestor.sin_estadisticas() returns void
language plpgsql set search_path = ''
as $$
declare r record;
begin
  for r in
    select c.relname, a.attname
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('causas', 'acuerdos', 'plantillas', 'agenda', 'deudores', 'modelos_mensaje',
                         'ajustes_cobranzas', 'consultas_bcra', 'consultas_cheques', 'vehiculos', 'ubicaciones', 'ajustes_prenda', 'casos_refi',
                         'agencias', 'ajustes_agencias', 'cotizaciones_agencia', 'solicitudes_credito', 'descuentos_cheques',
                         'chats_agencia', 'mensajes_agencia', 'avisos_push', 'push_claves')
       and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('alter table public.%I alter column %I set statistics 0', r.relname, r.attname);
  end loop;
end $$;
select gestor.sin_estadisticas();

-- ───────────────────────── Hoja de respuestas inicial ─────────────────────────
-- Solo lo que el cotizador ya dice o hace (CLAUDE.md, «Cotizador para agencias»). No trae tasas, porcentajes del valor del
-- vehículo, plazos de aprobación ni condiciones comerciales: eso lo agrega la persona si quiere que el asistente lo diga.
select set_config('gestor.autor', 'Claude', true);
update public.ajustes_agencias set ayuda = $hoja$
CÓMO SE USA EL COTIZADOR
- Se entra con el usuario (mail) y la contraseña que dio la Mutual. La primera vez hay que elegir una contraseña propia de al menos 10 caracteres.
- Paso 1, el cliente: escribir el CUIT o CUIL y tocar «Consultar BCRA». Si el número está mal, la app avisa.
- Paso 2, el vehículo: elegir marca, modelo, año y versión (en la versión se puede escribir para buscar). Después elegir la cantidad de cuotas.
- Se ve el monto máximo que puede financiar la Mutual, la cuota, el total y, en letra chica, la TNA, la TEA y el CFT. Se puede pedir un monto menor al máximo.
- La cotización se puede mandar al cliente por WhatsApp (el mensaje lo envía el vendedor) o imprimir.
- Para instalarlo en el iPhone: abrirlo en Safari, tocar Compartir y «Agregar a pantalla de inicio».
- Hay un tope de cotizaciones por día por agencia; si se llega, hay que esperar al día siguiente o consultar con la Mutual.

SEMÁFORO DEL BCRA (el resultado de la consulta del CUIT)
- Verde: sin atrasos informados en el sistema financiero. Se puede continuar.
- Amarillo: tiene alguna observación. Se puede continuar, pero queda sujeto a revisión de la Mutual.
- Sin antecedentes: no figura con deudas. Se puede continuar, sujeto a revisión de la Mutual.
- Rojo: tiene atrasos o cheques rechazados informados. No apto: no se puede solicitar el crédito.

SOLICITUD DE CRÉDITO (cuando el cliente quiere avanzar)
- Se toca «Continuar con la solicitud» debajo de la cotización.
- Hace falta que el cliente tenga ingresos demostrables y que la cuota no supere el porcentaje de su ingreso mensual que indican los datos vigentes. Se pide el ingreso mensual aproximado y cómo lo obtiene (relación de dependencia, monotributo o responsable inscripto).
- Documentación, en PDF o fotos de hasta 10 MB cada uno (las fotos se achican solas), todo junto en un solo recuadro:
  1. DNI, ambos lados.
  2. Un impuesto o servicio que muestre el domicilio.
  3. Si es empleado en relación de dependencia: los últimos 6 recibos de sueldo. Si es monotributista: constancia de inscripción y los últimos 3 pagos. Si es responsable inscripto: constancia de inscripción y las últimas 3 DDJJ de IVA y Ganancias.
  4. Título del automotor.
- Se completan en el formulario: DNI, domicilio real, estado civil (si es casado/a, lugar y fecha del matrimonio), celular y, opcionalmente, el CBU o CVU donde se depositaría el crédito (hay que indicar si la cuenta es propia o de un tercero).
- Se pide la conformidad del cliente para enviar sus datos a la Mutual.
- La solicitud se puede enviar aunque falten documentos: la Mutual los pide por otra vía.
- En la pestaña «Mis solicitudes» se ve si cada una está pendiente, aprobada o rechazada.

LO QUE EL ASISTENTE NO HACE
- No aprueba ni promete créditos: toda cotización es de referencia y está sujeta a la aprobación de la Mutual.
- No informa valores, precios ni valuaciones de vehículos, ni códigos. El cotizador tampoco los muestra.
$hoja$ where ayuda = '';

-- ───────────────────────── Sesión de la agencia: ¿tiene chat? ─────────────────────────
-- `agencia_sesion` (0036) ya devuelve todos los ajustes de la fila (sin rev ni sello), así que `chat_habilitado` y
-- `ayuda` llegan solos a la función. Nada que cambiar acá.

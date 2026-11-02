-- Cotización de vehículos: el token de la API de InfoAuto (función `infoauto`). Una sola fila.
-- Solo lo usa la función con la clave de servicio: nadie más lo puede leer.
create table if not exists public.infoauto_token (
  id int primary key default 1 check (id = 1),
  access_token text,
  refresh_token text,
  access_vence timestamptz,
  refresh_vence timestamptz,
  actualizado timestamptz not null default now()
);
comment on table public.infoauto_token is 'Token de la API de InfoAuto (una sola fila). Solo lo usa la función infoauto con la clave de servicio: nadie más lo puede leer. El access token dura 1 hora y el refresh 24 horas; se reutiliza para no pedir uno nuevo en cada consulta (pedirlo de más es mal uso y bloquea las credenciales).';
alter table public.infoauto_token enable row level security;
revoke all on public.infoauto_token from anon, authenticated;

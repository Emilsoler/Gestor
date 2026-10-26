-- ARCA: el certificado y el permiso para consultar la constancia de inscripción (web service
-- ws_sr_constancia_inscripcion), que la función `bcra` suma a la consulta por CUIT.
--
-- Para consultar, la función firma un pedido de acceso con la clave de la app (el secreto ARCA_CLAVE de la
-- función: nunca pasa por la base) y el certificado que dio ARCA, que no es secreto y se guarda acá. ARCA
-- (WSAA) devuelve un permiso, token y sign, que vale 12 horas; mientras vale no da otro, así que también se
-- guarda acá y se reusa.
--
-- La tabla está en el esquema privado. La función la lee y escribe con la sesión de la persona, por dos
-- funciones públicas que exigen ser miembro (además de la puerta de la API). El certificado lo carga Claude
-- por el conector con gestor.arca_certificado (también al renovarlo, cada dos años).

create table gestor.arca (
  id          smallint primary key default 1 check (id = 1),
  certificado text not null default '' check (certificado = '' or certificado like '-----BEGIN CERTIFICATE-----%'),
  ticket      jsonb check (ticket is null or jsonb_typeof(ticket) = 'object'),
  actualizado timestamptz not null default now()
);
alter table gestor.arca enable row level security;
insert into gestor.arca (id) values (1);
comment on table gestor.arca is
  'ARCA (constancia de inscripción): `certificado` es el PEM que dio ARCA para el alias de la app (se carga con gestor.arca_certificado); `ticket` es el último permiso de WSAA ({token, sign, vence}), que vale 12 horas y se reusa mientras vale. La clave privada no está acá: es el secreto ARCA_CLAVE de la función bcra.';

-- Para la función: el certificado y, si todavía vale (con cinco minutos de margen), el permiso guardado.
create function public.arca_config() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not coalesce((select public.es_miembro()), false) then
    raise exception 'cuenta no autorizada' using errcode = '42501';
  end if;
  return (select jsonb_build_object(
            'certificado', a.certificado,
            'ticket', case when (a.ticket ->> 'vence')::timestamptz > now() + interval '5 minutes' then a.ticket end)
            from gestor.arca a where a.id = 1);
end $$;

create function public.arca_guardar_ticket(p_ticket jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_vence timestamptz;
begin
  if not coalesce((select public.es_miembro()), false) then
    raise exception 'cuenta no autorizada' using errcode = '42501';
  end if;
  if jsonb_typeof(p_ticket) is distinct from 'object'
     or coalesce(p_ticket ->> 'token', '') = '' or coalesce(p_ticket ->> 'sign', '') = '' then
    raise exception 'permiso de ARCA incompleto' using errcode = '22023';
  end if;
  v_vence := (p_ticket ->> 'vence')::timestamptz;
  if v_vence is null or v_vence > now() + interval '13 hours' then
    raise exception 'vencimiento del permiso de ARCA inválido' using errcode = '22023';
  end if;
  update gestor.arca
     set ticket = jsonb_build_object('token', p_ticket ->> 'token', 'sign', p_ticket ->> 'sign', 'vence', v_vence),
         actualizado = now()
   where id = 1;
end $$;

revoke all on function public.arca_config() from public, anon;
revoke all on function public.arca_guardar_ticket(jsonb) from public, anon;
grant execute on function public.arca_config() to authenticated;
grant execute on function public.arca_guardar_ticket(jsonb) to authenticated;

-- Para Claude, por el conector: cargar o cambiar el certificado. El permiso guardado se conserva: el padrón
-- no mira el certificado, y mientras el permiso vale ARCA no da otro (descartarlo dejaría a la app sin
-- consultar hasta 12 horas). Si el certificado nuevo es de otro CUIT, ARCA rechaza el permiso viejo y la
-- función pide uno nuevo.
create function gestor.arca_certificado(p_pem text) returns text
language plpgsql set search_path = ''
as $$
declare v text := btrim(coalesce(p_pem, ''), E' \t\r\n');
begin
  if v !~ '^-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----$' then
    raise exception 'Eso no es un certificado: tiene que ser el contenido del archivo .crt que dio ARCA, de -----BEGIN CERTIFICATE----- a -----END CERTIFICATE-----';
  end if;
  update gestor.arca set certificado = v || E'\n', actualizado = now() where id = 1;
  return 'Certificado de ARCA guardado.';
end $$;

-- Nada del esquema privado es alcanzable por los roles de la API (ver 0001).
revoke all on all tables in schema gestor from public, anon, authenticated;
revoke all on all functions in schema gestor from public, anon, authenticated;

notify pgrst, 'reload schema';

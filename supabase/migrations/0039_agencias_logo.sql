-- Logo de cada agencia en el cotizador (pedido de la persona del 23/11/2026): se ve en el encabezado, junto al nombre de la
-- agencia, y en la hoja que se imprime, al lado del escudo de la Mutual.
--
-- Va en su propia tabla y no como columna de `agencias`: la administración (Créditos y Cobros → Agencias) lee esa tabla
-- entera, y un logo pesa varios KB. Tampoco se sube al repositorio (es público y mostraría qué agencias trabajan con la
-- Mutual): los logos se cargan con `gestor.poner_logo`, desde el conector. Cada agencia recibe solo el suyo, por la función.
create table public.logos_agencia (
  agencia_id  uuid primary key references public.agencias(id) on delete cascade,
  imagen      text not null check (imagen ~ '^data:image/(webp|png|jpeg);base64,[A-Za-z0-9+/]+=*$' and length(imagen) <= 60000),
  actualizado timestamptz not null default now()
);
comment on table public.logos_agencia is
  'Logo de cada agencia como imagen en base64 (data:image/webp;base64,…), de hasta ~45 KB. Sin políticas ni permisos para la API: solo la función `agencias` (clave de servicio) la lee, vía public.agencia_logo.';
alter table public.logos_agencia enable row level security;
revoke all on public.logos_agencia from public, anon, authenticated;
grant all on public.logos_agencia to service_role;

-- El logo de la agencia de esa sesión ('' si no tiene o si la cuenta no es de una agencia activa).
create function public.agencia_logo(p_user uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce((select l.imagen from public.logos_agencia l join public.agencias a on a.id = l.agencia_id
                    where a.user_id = p_user and a.activa), '');
$$;
revoke all on function public.agencia_logo(uuid) from public, anon, authenticated;
grant execute on function public.agencia_logo(uuid) to service_role;

-- Para Claude, por el conector: poner o cambiar el logo de una agencia (por su email). Con p_imagen vacío lo quita.
create function gestor.poner_logo(p_email text, p_imagen text) returns text
language plpgsql set search_path = ''
as $$
declare v_id uuid; v_nombre text;
begin
  select id, nombre into v_id, v_nombre from public.agencias where email = lower(btrim(p_email));
  if v_id is null then raise exception 'No hay una agencia con el email %', p_email; end if;
  if coalesce(p_imagen, '') = '' then
    delete from public.logos_agencia where agencia_id = v_id;
    return format('Logo de %s quitado', v_nombre);
  end if;
  insert into public.logos_agencia (agencia_id, imagen) values (v_id, p_imagen)
  on conflict (agencia_id) do update set imagen = excluded.imagen, actualizado = now();
  return format('Logo de %s guardado (%s caracteres)', v_nombre, length(p_imagen));
end $$;
comment on function gestor.poner_logo(text, text) is
  'Guarda el logo de una agencia (data:image/webp;base64,…, hasta 60.000 caracteres). Vacío: lo quita.';

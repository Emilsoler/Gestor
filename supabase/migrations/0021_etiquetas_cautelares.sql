-- Etiquetas cautelares: se separa "hay que pedirlo" de "ya está hecho".
--
--   Sin Cautelar
--   Embargar sueldo            Hay que pedir el embargo de haberes (dispara la apertura de cuenta
--                              judicial y, con la cuenta abierta, el pedido de embargo).
--   Embargo de sueldo trabado  El embargo ya está trabado y con cuenta abierta. Es lo que hasta acá
--                              se llamaba "Embargo de sueldo".
--   Secuestrar vehículo        Hay que pedir un oficio de secuestro nuevo.
--   Vehículo secuestrado       Sin cambios.
--
-- El nombre anterior, "Embargo de sueldo", se sigue aceptando al escribir y se guarda como
-- "Embargo de sueldo trabado": una app que quedó abierta con la versión anterior, o una foto vieja
-- que restaura gestor.deshacer, no deben chocar con la regla nueva.

create or replace function gestor.cautelares() returns text[]
language sql immutable set search_path = ''
as $$ select array['Sin Cautelar','Embargar sueldo','Embargo de sueldo trabado','Secuestrar vehículo','Vehículo secuestrado'] $$;

-- Las fotos anteriores a 0007 traían la etiqueta libre "Embargo de sueldo": ahora es la trabada.
create or replace function gestor.forma_0007(p jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select case when p ? 'ubicacion' then p else
    (p - 'etiquetas') || jsonb_build_object(
      'ubicacion', case when (p ->> 'estado') in ('Casillero', 'A despacho') then p ->> 'estado' else 'Casillero' end,
      'estado', case
        when (p -> 'etiquetas') ? 'Martillero' then '5. Martillero Designado'
        when (p ->> 'estado') = 'Tramites p/ subasta' then '4. Ejecución de Sentencia'
        when (p ->> 'estado') = 'Sentencia' then '3. Sentencia'
        when (p ->> 'estado') = 'Notificando' then '1.1 Demanda'
        when (p ->> 'estado') = 'Iniciar' then '0. Iniciamos'
        else '' end,
      'cautelar', case
        when (p -> 'etiquetas') ? 'Secuestro / subasta' then 'Vehículo secuestrado'
        when (p -> 'etiquetas') ? 'Embargo de sueldo' then 'Embargo de sueldo trabado'
        else 'Sin Cautelar' end,
      'situacion', case
        when (p ->> 'estado') = 'Archivada' then 'Archivada'
        when (p ->> 'estado') = 'Acuerdo' or (p -> 'etiquetas') ? 'Acuerdo' then 'Acuerdo'
        else 'En trámite' end)
  end
$$;

-- El nombre anterior se traduce antes de guardar. Se llama "cautelar_nombre" para que corra antes
-- que "sello" (los disparadores van por orden alfabético): así un guardado que solo trae el nombre
-- viejo sobre una causa ya traducida no cuenta como cambio.
create function gestor.tg_cautelar_nombre() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.cautelar = 'Embargo de sueldo' then new.cautelar := 'Embargo de sueldo trabado'; end if;
  return new;
end
$$;

create trigger cautelar_nombre before insert or update on public.causas
  for each row execute function gestor.tg_cautelar_nombre();

alter table public.causas drop constraint causas_cautelar_check;

-- En un solo bloque, para que el cambio quede firmado por Claude en gestor.cambios. El disparador
-- de arriba hace la traducción: alcanza con volver a guardar el nombre viejo.
do $$
begin
  perform set_config('gestor.autor', 'Claude', true);
  update public.causas set cautelar = 'Embargo de sueldo trabado' where cautelar = 'Embargo de sueldo';
end $$;

alter table public.causas
  add constraint causas_cautelar_check check (cautelar in ('Sin Cautelar', 'Embargar sueldo', 'Embargo de sueldo trabado', 'Secuestrar vehículo', 'Vehículo secuestrado'));

comment on column public.causas.cautelar is
  'Etiqueta Cautelar: Sin Cautelar, Embargar sueldo (hay que pedirlo), Embargo de sueldo trabado (hecho, con cuenta abierta), Secuestrar vehículo (hay que pedir oficio nuevo) o Vehículo secuestrado.';

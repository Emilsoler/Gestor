-- Documentos de Drive en cada causa y autor de cada movimiento (nov 2026).
--
-- 1. causas.drive: lo que la revisión diaria de las 10:30 encontró en la carpeta de Drive del
--    demandado. La app lo cruza con la próxima acción para decir qué adjuntos hay y cuáles faltan.
--    La escribe Claude con gestor.drive(); la app solo la lee.
--    Que cambie no cuenta como modificación de la causa (no sube `rev` ni queda en gestor.cambios):
--    si contara, la revisión de las 10:30 haría saltar el aviso de «otro cambió la causa» a quien
--    la tuviera abierta, y llenaría el historial de cambios con una fila por causa por día.
--
-- 2. Cada movimiento nuevo del historial lleva `autor` (quién lo anotó: la persona, o «Claude» por
--    SQL o el chat). Lo pone un disparador, así sirve para la app, las funciones y el SQL directo.
--    Los movimientos que ya estaban quedan sin autor.

alter table public.causas add column if not exists drive jsonb;
comment on column public.causas.drive is
  'Lo que había en la carpeta de Drive del demandado en la última revisión: {revisado: timestamptz, carpeta, archivos: [nombres], constancias: [nombres de «Constancias Emiliano Soler»]}. Lo escribe gestor.drive(); null = nunca se revisó.';

-- Mismo sello que en 0001, sin contar `drive` como cambio.
create or replace function gestor.tg_sello() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'rev' - 'actualizado' - 'actualizado_por' - 'drive')
       = (to_jsonb(old) - 'rev' - 'actualizado' - 'actualizado_por' - 'drive') then
    new.rev := old.rev; new.actualizado := old.actualizado; new.actualizado_por := old.actualizado_por;
    return new;                         -- guardar sin cambios (o solo lo de Drive) no cuenta como modificación
  end if;
  new.rev := nextval('gestor.revisiones');
  new.actualizado := now();
  new.actualizado_por := gestor.autor();
  return new;
end $$;

create or replace function gestor.drive(p_expte text, p_carpeta text, p_archivos text[],
                                        p_constancias text[] default '{}', p_autor text default 'Claude')
returns jsonb
language plpgsql set search_path = ''
as $$
declare d jsonb;
begin
  perform set_config('gestor.autor', p_autor, true);
  d := jsonb_build_object(
    'revisado', now(),
    'carpeta', coalesce(btrim(p_carpeta), ''),
    'archivos', coalesce((select jsonb_agg(btrim(x) order by btrim(x)) from unnest(p_archivos) x where btrim(x) <> ''), '[]'::jsonb),
    'constancias', coalesce((select jsonb_agg(btrim(x) order by btrim(x)) from unnest(p_constancias) x where btrim(x) <> ''), '[]'::jsonb));
  update public.causas set drive = d where expte = p_expte;
  if not found then raise exception 'No existe la causa con expediente %', p_expte; end if;
  return d;
end $$;
comment on function gestor.drive(text, text, text[], text[], text) is
  'Anota qué archivos hay en la carpeta de Drive del demandado (y en «Constancias Emiliano Soler»), con la hora de la revisión. Reemplaza lo anterior. Solo los nombres de archivo, tal cual.';

-- Autor de los movimientos nuevos. Solo cuando el historial crece: deshacer o borrar un movimiento
-- (que lo achican) no le cambian el autor a nadie.
create or replace function gestor.tg_autor_movimientos() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare e jsonb; sale jsonb := '[]'::jsonb; quien text;
begin
  if jsonb_typeof(new.historial) <> 'array' then return new; end if;
  if tg_op = 'UPDATE' and jsonb_typeof(old.historial) = 'array'
     and jsonb_array_length(new.historial) <= jsonb_array_length(old.historial) then
    return new;
  end if;
  quien := gestor.autor();
  for e in select x from jsonb_array_elements(new.historial) x loop
    if jsonb_typeof(e) = 'object' and not e ? 'autor'
       and not (tg_op = 'UPDATE' and old.historial @> jsonb_build_array(e)) then
      e := e || jsonb_build_object('autor', quien);
    end if;
    sale := sale || jsonb_build_array(e);
  end loop;
  new.historial := sale;
  return new;
end $$;

drop trigger if exists autor_movimientos on public.causas;
-- «autor_…» corre antes que «sello» (orden alfabético), así el autor cuenta en el cambio.
create trigger autor_movimientos before insert or update of historial on public.causas
  for each row execute function gestor.tg_autor_movimientos();

comment on column public.causas.historial is
  'Movimientos: array de {fecha:"AAAA-MM-DD", texto, hecha?, autor?}. `autor` lo pone la base en los nuevos.';

select gestor.sin_estadisticas();

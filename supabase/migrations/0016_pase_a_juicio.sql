-- Pase a juicio: una causa del gestor puede salir de un deudor de Cobranzas.
--
-- `causas.deudor` dice de qué deudor salió la causa (null: se cargó a mano). Al crear una causa con
-- deudor, o al ponérselo a una que ya existía, el disparador `pase_a_juicio` deja a ese deudor
-- "En juicio", con el N° de expediente y una gestión anotada. Pasa en la misma transacción que la
-- causa: o quedan las dos cosas, o ninguna. Si el deudor ya está vinculado a otro expediente, la
-- causa no se guarda y el error lo dice.
--
-- Sin clave foránea, como `deudores.expte` y `acuerdos.expte`: el disparador controla que el deudor
-- exista al vincular. `gestor.deshacer` no toca esta columna: deshacer un cambio de la causa deja el
-- vínculo como está, y una causa eliminada vuelve sin él (el deudor conserva su expediente). El
-- deudor se corrige, si hace falta, deshaciendo su propio cambio.
--
-- El disparador corre con los permisos de su dueño (security definer), como el sello y la
-- auditoría: quien llega hasta acá ya pasó la puerta y las políticas de `causas`, que son las
-- mismas de `deudores`. El cambio del deudor queda firmado por quien guardó la causa
-- (gestor.autor(): el usuario de la app, o "Claude" por el conector).

alter table public.causas add column deudor uuid;
comment on column public.causas.deudor is
  'El deudor de Cobranzas del que salió la causa (null: se cargó a mano). Al ponerlo, el disparador pase_a_juicio deja al deudor En juicio, con este expediente y una gestión anotada.';

create function gestor.tg_pase_a_juicio() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_expte text;
begin
  if new.deudor is null or (tg_op = 'UPDATE' and new.deudor is not distinct from old.deudor) then
    return new;
  end if;
  select d.expte into v_expte from public.deudores d where d.id = new.deudor for update;
  if not found then
    raise exception 'No existe el deudor de Cobranzas %', new.deudor;
  end if;
  if v_expte = new.expte then return new; end if;    -- ya estaba vinculado a esta causa
  if v_expte <> '' then
    raise exception 'Ese deudor ya está vinculado al expediente %', v_expte;
  end if;
  update public.deudores
     set estado = 'En juicio',
         expte = new.expte,
         gestiones = gestiones || jsonb_build_array(jsonb_build_object(
           'id', gestor.id_corto(), 'creado', gestor.ahora(), 'fecha', to_char(gestor.hoy(), 'YYYY-MM-DD'),
           'tipo', 'Nota', 'texto', format('Pasó a juicio: expte. N° %s', new.expte)))
   where id = new.deudor;
  return new;
end $$;
comment on function gestor.tg_pase_a_juicio() is
  'Al crear una causa con deudor (o al ponérselo), deja al deudor de Cobranzas En juicio con ese expediente y anota la gestión.';

create trigger pase_a_juicio after insert or update of deudor on public.causas
  for each row execute function gestor.tg_pase_a_juicio();

-- La columna nueva también queda sin estadísticas del planificador (ver 0001).
select gestor.sin_estadisticas();

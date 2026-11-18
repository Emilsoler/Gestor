-- InfoAuto ya no pide que se le avise por escrito antes de activar una agencia (lo confirmó a la persona el 18/11/2026).
-- La fecha del aviso (`informada_infoauto`) deja de ser obligatoria: la app ya no la pide. La columna queda, con lo que
-- tenga cargado, y si alguien la escribe sigue sin poder ser futura. El tope de 20 agencias activas no cambia.
create or replace function gestor.tg_agencias_reglas() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  if new.activa then
    if new.informada_infoauto > gestor.hoy() then
      raise exception 'La fecha en que se informó a InfoAuto no puede ser futura.' using errcode = '23514';
    end if;
    select count(*) into n from public.agencias a where a.activa and a.id <> new.id;
    if n >= 20 then
      raise exception 'Ya hay 20 agencias activas: es el tope de la licencia de InfoAuto. Pausá una o consultá con InfoAuto la ampliación.'
        using errcode = '23514';
    end if;
  end if;
  if new.user_id is not null and exists (select 1 from gestor.miembros m where m.user_id = new.user_id) then
    raise exception 'Esa cuenta es de un usuario del gestor: una agencia necesita una cuenta propia.' using errcode = '23514';
  end if;
  return new;
end $$;

comment on column public.agencias.informada_infoauto is
  'Fecha en que se informó a InfoAuto (opcional desde el 18/11/2026: InfoAuto dijo que no hace falta avisarles).';

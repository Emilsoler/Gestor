-- El cheque como tercer tipo de título, junto al pagaré y la prenda.
--
-- Los títulos siguen siendo el mismo array en `causas.titulos`: lo único nuevo es que `tipo`
-- también puede valer "cheque". Como el pagaré, el cheque no lleva vehículo, y su interés se
-- calcula igual (gestor.reclamado no mira el tipo). Por eso alcanza con que la función que
-- los carga lo acepte y con poner al día los comentarios que describen la columna.
--
-- La app tiene que conocer el tipo antes de que haya cheques cargados: la versión anterior
-- guardaba como pagaré todo lo que no fuera prenda.
--
-- (Con `create or replace` la función conserva sus permisos: sigue sin poder ejecutarla
-- nadie desde la API.)
--
-- En el proyecto real se aplicó el 8/10/2026 como gestor_13_titulo_cheque; este archivo es copia fiel.
create or replace function gestor.agregar_titulo(
  p_expte text, p_tipo text, p_monto numeric, p_vence date default null,
  p_descripcion text default '', p_vehiculo text default '', p_autor text default 'Claude'
) returns text
language plpgsql set search_path = ''
as $$
begin
  -- (`is null` aparte: con un tipo nulo, `not in` no da verdadero y el título entraba sin tipo)
  if p_tipo is null or p_tipo not in ('pagare', 'cheque', 'prenda') then
    raise exception 'El tipo tiene que ser "pagare", "cheque" o "prenda" (llegó "%")', p_tipo;
  end if;
  if p_monto is null or p_monto < 0 then raise exception 'El monto tiene que ser un número no negativo'; end if;
  perform set_config('gestor.autor', p_autor, true);
  update public.causas
     set titulos = titulos || jsonb_build_array(jsonb_build_object(
           'tipo', p_tipo, 'monto', p_monto, 'vence', coalesce(p_vence::text, ''),
           'descripcion', coalesce(p_descripcion, ''), 'vehiculo', case when p_tipo = 'prenda' then coalesce(p_vehiculo, '') else '' end))
   where expte = p_expte;
  if not found then raise exception 'No existe la causa %', p_expte; end if;
  return format('Causa %s: %s por %s agregado', p_expte, p_tipo, p_monto);
end $$;
comment on function gestor.agregar_titulo(text, text, numeric, date, text, text, text) is
  'Agrega un pagaré, un cheque o una prenda (con su monto y vencimiento) a una causa.';

comment on column public.causas.titulos is
  'Títulos reclamados: array de {tipo:"pagare"|"cheque"|"prenda", monto, vence:"AAAA-MM-DD", descripcion, vehiculo}. El vehículo solo se usa en las prendas. El monto reclamado con intereses sale de gestor.reclamado. Para cargar uno usar gestor.agregar_titulo.';

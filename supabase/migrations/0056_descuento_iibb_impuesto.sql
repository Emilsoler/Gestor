-- Descuento de cheques: dos conceptos nuevos (pedido de la persona del 26/11/2026).
--   iibb        % sobre (interés + gastos cheque; la columna de gastos cheque sigue siendo `comision`)
--   imp_cheque  impuesto al cheque, % sobre el valor
--   cuota_social  pesos, una vez por operación
--   calculo     1: interés simple sobre el valor (lo guardado hasta acá); 2: interés descontado y compuesto,
--               total de gastos redondeado para arriba al peso. La app manda 2 en las operaciones nuevas.
-- Con 0 por defecto, las operaciones ya guardadas dan los mismos importes que antes (la liquidación
-- se calcula siempre desde estos datos: lo que se le pagó al socio no puede cambiar).
alter table public.descuentos_cheques
  add column iibb       numeric not null default 0 check (iibb >= 0 and iibb <= 100),
  add column imp_cheque numeric not null default 0 check (imp_cheque >= 0 and imp_cheque <= 100),
  add column cuota_social numeric not null default 0 check (cuota_social >= 0),
  add column calculo      smallint not null default 1 check (calculo in (1, 2));

select gestor.sin_estadisticas();

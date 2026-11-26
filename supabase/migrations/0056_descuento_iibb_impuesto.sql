-- Descuento de cheques: dos conceptos nuevos (pedido de la persona del 26/11/2026).
--   iibb        % sobre (interés + gastos cheque; la columna de gastos cheque sigue siendo `comision`)
--   imp_cheque  impuesto al cheque, % sobre el valor
-- Con 0 por defecto, las operaciones ya guardadas dan los mismos importes que antes (la liquidación
-- se calcula siempre desde estos datos: lo que se le pagó al socio no puede cambiar).
alter table public.descuentos_cheques
  add column iibb       numeric not null default 0 check (iibb >= 0 and iibb <= 100),
  add column imp_cheque numeric not null default 0 check (imp_cheque >= 0 and imp_cheque <= 100);

select gestor.sin_estadisticas();

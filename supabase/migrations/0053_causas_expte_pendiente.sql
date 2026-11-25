-- Causas con el N° de expediente todavía pendiente (pedido de la persona del 25/11/2026).
--
-- Al armar una demanda desde «Nueva causa» (botón «Hacer demanda») la causa se carga antes de presentarla, y el número
-- de expediente lo da el SAC recién al presentar. Hasta entonces la causa lleva una clave provisoria `PEND-<n>`
-- (la app la muestra como «pendiente»). Cuando llega el número real, la ficha lo cambia: la clave se actualiza y
-- `agenda.expte` la sigue por su clave foránea (on update cascade, migración 0005).
--
-- Solo se afloja la forma de la clave: sigue siendo única y las demás tablas no cambian.
alter table public.causas drop constraint if exists causas_expte_check;
alter table public.causas add constraint causas_expte_check check (expte ~ '^[0-9]+$' or expte ~ '^PEND-[0-9]+$');

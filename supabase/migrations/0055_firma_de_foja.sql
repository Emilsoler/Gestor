-- Firma suelta para el foliado de la demanda y su documental (pedido de la persona del 26/11/2026).
--
-- Cada hoja lleva arriba a la derecha el número de foja y, al lado, la firma con el sello. El sello (texto) lo dibuja la app;
-- la firma es un PNG transparente en base64 que, como la del pie, no puede estar en el repositorio (es público). Va en la
-- misma fila y con las mismas políticas de `ajustes_firma`.
alter table public.ajustes_firma add column if not exists trazo text not null default '' check (length(trazo) <= 400000);
comment on column public.ajustes_firma.trazo is 'Firma sola, PNG transparente en base64, para el foliado de cada hoja.';

select gestor.sin_estadisticas();

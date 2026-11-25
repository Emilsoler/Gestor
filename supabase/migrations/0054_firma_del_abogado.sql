-- Firma del abogado para las demandas en PDF (pedido de la persona del 25/11/2026).
--
-- «Hacer demanda» arma el Word y también la demanda en PDF con la firma y el sello del abogado al pie. La imagen de la
-- firma no puede estar en el repositorio (es público), así que vive acá, en una sola fila que solo leen los miembros
-- (misma política que el resto: `es_miembro()`). La app la pide recién al armar el PDF.
--
-- `imagen` es el JPEG en base64 (unos 20 KB), `ancho` y `alto` los píxeles de la imagen. No entra en `gestor.cambios`
-- (no se usa `auditar`): no tiene sentido guardar copias de una imagen cada vez que se toca.
create table public.ajustes_firma (
  id              integer primary key default 1 check (id = 1),
  nombre          text not null default '',
  imagen          text not null default '' check (length(imagen) <= 400000),
  rev             bigint not null default 0,
  actualizado     timestamptz not null default now(),
  actualizado_por text not null default ''
);
comment on table public.ajustes_firma is
  'Firma y sello del abogado (una sola fila) para las demandas en PDF. `imagen`: JPEG en base64. Solo la leen los miembros.';

create trigger sello before insert or update on public.ajustes_firma for each row execute function gestor.tg_sello();

alter table public.ajustes_firma enable row level security;
create policy solo_miembros on public.ajustes_firma for all to authenticated
  using ((select public.es_miembro())) with check ((select public.es_miembro()));
revoke all on public.ajustes_firma from public, anon, authenticated;
grant select, insert, update on public.ajustes_firma to authenticated;
grant all on public.ajustes_firma to service_role;

select gestor.sin_estadisticas();

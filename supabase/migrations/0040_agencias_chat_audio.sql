-- Mensajes de voz de la agencia en el chat «M» (pedido de la persona del 22/11/2026).
--
-- La agencia graba un audio y se lo manda a la Mutual SOLO cuando ya hay una persona en la conversación (estado espera o
-- humano): el asistente automático no escucha audios. La Mutual contesta por escrito, y la agencia puede escuchar cada
-- respuesta con la voz del celular (eso es del navegador, no toca la base).
--
-- El audio no va en la tabla: queda en una carpeta privada del almacenamiento (`chat-audios`, sin políticas: solo la función
-- con la clave de servicio) y el mensaje guarda dónde está y cuánto dura. Las agencias nunca ven la ruta: piden el audio a
-- la función, que se lo da solo si es de su propia conversación.

alter table public.mensajes_agencia
  add column audio_path text check (audio_path is null or length(audio_path) between 10 and 200),
  add column audio_seg  integer check (audio_seg is null or audio_seg between 1 and 180),
  add column audio_tipo text check (audio_tipo is null or audio_tipo in ('audio/mp4', 'audio/webm', 'audio/ogg')),
  -- o es un audio completo, o no es nada de audio
  add constraint mensajes_agencia_audio_completo check ((audio_path is null) = (audio_seg is null) and (audio_path is null) = (audio_tipo is null)),
  -- solo la agencia manda audios
  add constraint mensajes_agencia_audio_de_agencia check (audio_path is null or de = 'agencia');

comment on column public.mensajes_agencia.audio_path is
  'Ruta del audio en la carpeta privada `chat-audios` del almacenamiento. null: mensaje de texto. El texto del mensaje dice «Mensaje de voz».';

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('chat-audios', 'chat-audios', false, 3145728, array['audio/mp4', 'audio/webm', 'audio/ogg'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;

select gestor.sin_estadisticas();

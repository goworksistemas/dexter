-- Imagens geradas no chat (públicas via URL; upload só com service_role).
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-images', 'chat-images', true, 15728640)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

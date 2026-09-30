-- Perfil propio (Configuración personal): foto del usuario.

alter table public.usuarios add column if not exists avatar_url text;

-- Bucket de fotos de perfil (AuthService.subirAvatar). Público: la foto se
-- muestra con su URL directa.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatares', 'avatares', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- REVERSA:
--   alter table public.usuarios drop column avatar_url;
--   delete from storage.buckets where id = 'avatares';

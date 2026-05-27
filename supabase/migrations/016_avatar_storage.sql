-- ============================================================
-- Migration 016: Storage bucket pra avatares de usuário
-- ============================================================
-- Site é estático (Netlify) → avatares de usuário não podem ir pra assets/.
-- Criamos bucket Storage 'avatars' (leitura pública, escrita autenticada).
--
-- Convenção de path: avatars/{user_id}/avatar.{ext}
--   → policy permite que cada user só escreva na PRÓPRIA pasta (foldername = uid)
--
-- Limite: 2MB, apenas PNG/JPEG/WEBP.

-- ===== 1) Bucket =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,                                  -- leitura pública (img src direto)
  2097152,                               -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = true,
  file_size_limit = 2097152,
  allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp'];

-- ===== 2) RLS policies em storage.objects (bucket avatars) =====

-- Leitura pública (qualquer um vê os avatares)
drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read"
  on storage.objects for select
  using (bucket_id = 'avatars');

-- Upload: usuário autenticado só na PRÓPRIA pasta ({uid}/...)
drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Update: idem (pra trocar o avatar / upsert)
drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Delete: idem
drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

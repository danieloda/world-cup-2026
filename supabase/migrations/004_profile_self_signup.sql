-- ============================================================
-- Allow new authenticated users to auto-create their own profile
-- (with safe defaults: is_admin = false, paid = false)
-- ============================================================

create policy "profiles_insert_self_safe"
  on public.profiles for insert
  to authenticated
  with check (
    id = auth.uid()
    and is_admin = false
    and paid = false
  );

-- Tighten update: user cannot change their own paid or is_admin flags
drop policy if exists "profiles_update_self" on public.profiles;

create policy "profiles_update_self_safe"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and is_admin = (select is_admin from public.profiles where id = auth.uid())
    and paid = (select paid from public.profiles where id = auth.uid())
  );

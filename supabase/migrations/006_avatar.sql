-- ============================================================
-- Avatar URL para profiles
-- ============================================================
alter table public.profiles
  add column if not exists avatar_url text;

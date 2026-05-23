-- ============================================================
-- Bolão Copa 2026 — Row Level Security
-- ============================================================
-- Run AFTER 001_schema.sql

-- Enable RLS on every table
alter table public.profiles          enable row level security;
alter table public.matches           enable row level security;
alter table public.predictions       enable row level security;
alter table public.players           enable row level security;
alter table public.champion_picks    enable row level security;
alter table public.top_scorer_picks  enable row level security;
alter table public.player_goals      enable row level security;
alter table public.settings          enable row level security;

-- ===== Helper: is_admin() =====
create or replace function public.is_admin()
returns boolean language sql security definer stable as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ============================================================
-- PROFILES: everyone authenticated can read, only self can update,
-- only admin can insert/delete.
-- ============================================================
create policy "profiles_select_authenticated"
  on public.profiles for select
  to authenticated using (true);

create policy "profiles_update_self"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and is_admin = (select is_admin from public.profiles where id = auth.uid()));
  -- prevents users from self-promoting to admin

create policy "profiles_admin_all"
  on public.profiles for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- MATCHES: read-all-authenticated, write-admin-only
-- ============================================================
create policy "matches_select_all"
  on public.matches for select
  to authenticated using (true);

create policy "matches_admin_write"
  on public.matches for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- PREDICTIONS:
--   SELECT: own predictions always; others' predictions only after match kickoff
--   INSERT/UPDATE: only own, only before match kickoff
-- ============================================================
create policy "predictions_select_own_or_locked"
  on public.predictions for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.matches m
      where m.id = predictions.match_id
        and m.match_date <= now()
    )
    or public.is_admin()
  );

create policy "predictions_insert_own_before_kickoff"
  on public.predictions for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.matches m
      where m.id = match_id
        and m.match_date > now()
    )
  );

create policy "predictions_update_own_before_kickoff"
  on public.predictions for update
  to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.matches m
      where m.id = match_id
        and m.match_date > now()
    )
  );

create policy "predictions_admin_all"
  on public.predictions for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- PLAYERS: read-all, write-admin
-- ============================================================
create policy "players_select_all"
  on public.players for select to authenticated using (true);

create policy "players_admin_write"
  on public.players for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- CHAMPION_PICKS & TOP_SCORER_PICKS:
--   SELECT: own always; others only after deadline (10/jun 23:59 BRT)
--   INSERT/UPDATE: only own, only before deadline
-- ============================================================
create or replace function public.cs_deadline()
returns timestamptz language sql stable as $$
  select coalesce(
    (select (value->>'deadline_champion_scorer')::timestamptz from public.settings where key = 'deadline_champion_scorer'),
    '2026-06-11 02:59:00+00'::timestamptz  -- 10/jun 23:59 BRT = 11/jun 02:59 UTC
  );
$$;

create policy "champion_select"
  on public.champion_picks for select to authenticated
  using (user_id = auth.uid() or now() >= public.cs_deadline() or public.is_admin());

create policy "champion_upsert_self"
  on public.champion_picks for insert to authenticated
  with check (user_id = auth.uid() and now() < public.cs_deadline());

create policy "champion_update_self"
  on public.champion_picks for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and now() < public.cs_deadline());

create policy "scorer_select"
  on public.top_scorer_picks for select to authenticated
  using (user_id = auth.uid() or now() >= public.cs_deadline() or public.is_admin());

create policy "scorer_upsert_self"
  on public.top_scorer_picks for insert to authenticated
  with check (user_id = auth.uid() and now() < public.cs_deadline());

create policy "scorer_update_self"
  on public.top_scorer_picks for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and now() < public.cs_deadline());

-- ============================================================
-- PLAYER_GOALS: read-all, write-admin
-- ============================================================
create policy "goals_select_all"
  on public.player_goals for select to authenticated using (true);

create policy "goals_admin_write"
  on public.player_goals for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- SETTINGS: read-all, write-admin
-- ============================================================
create policy "settings_select_all"
  on public.settings for select to authenticated using (true);

create policy "settings_admin_write"
  on public.settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- Bolão Copa 2026 — Schema
-- ============================================================
-- Run this in Supabase SQL Editor BEFORE 002_rls.sql

-- ===== PROFILES =====
-- Extends auth.users with app-specific fields.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null unique,
  is_admin boolean not null default false,
  paid boolean not null default false,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_profiles_paid on public.profiles(paid);

-- ===== MATCHES =====
-- All 104 World Cup matches. Knockout matches have slot identifiers
-- (e.g., "1A", "2B", "W101") until teams resolve from group stage.
create table public.matches (
  id int primary key,                          -- sequential 1..104
  stage text not null,                         -- 'group' | 'r32' | 'r16' | 'qf' | 'sf' | 'third' | 'final'
  round_label text not null,                   -- "Matchday 1", "Round of 32", etc.
  group_name text,                             -- 'A'..'L' for group matches
  match_date timestamptz not null,             -- ISO timestamp with TZ
  ground text,                                 -- venue
  -- Team identifiers (slot like "1A" or real team like "Mexico")
  team_home text not null,
  team_away text not null,
  -- Actual result (filled by admin after match)
  actual_home int,
  actual_away int,
  pen_winner text,                             -- 'home' | 'away' | null (only for knockout draws)
  finished boolean not null default false,
  finished_at timestamptz
);

create index idx_matches_date on public.matches(match_date);
create index idx_matches_stage on public.matches(stage);
create index idx_matches_finished on public.matches(finished);

-- ===== PREDICTIONS =====
-- One prediction per (user, match). Locked at match kickoff via RLS.
create table public.predictions (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  match_id int not null references public.matches(id) on delete cascade,
  pred_home int not null check (pred_home >= 0 and pred_home <= 20),
  pred_away int not null check (pred_away >= 0 and pred_away <= 20),
  pred_pen_winner text check (pred_pen_winner in ('home','away')),
  points_earned int,                           -- computed when match finishes
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, match_id)
);

create index idx_predictions_user on public.predictions(user_id);
create index idx_predictions_match on public.predictions(match_id);

-- Auto-update updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger trg_predictions_touch
before update on public.predictions
for each row execute function public.touch_updated_at();

-- ===== PLAYERS =====
-- Top candidate top-scorer picks. Seed with ~50-100 stars.
-- Admin can add more later.
create table public.players (
  id serial primary key,
  full_name text not null,
  team text not null,                          -- country
  position text,                               -- 'ATA', 'MEI', 'DEF', 'GOL'
  shirt_number int,
  unique(full_name, team)
);

create index idx_players_team on public.players(team);

-- ===== CHAMPION & TOP-SCORER PICKS =====
-- Each user makes ONE pick of each, locked at deadline (jun 10).
create table public.champion_picks (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  team text not null,                          -- country name
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.top_scorer_picks (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  player_id int not null references public.players(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_champion_touch
before update on public.champion_picks
for each row execute function public.touch_updated_at();

create trigger trg_scorer_touch
before update on public.top_scorer_picks
for each row execute function public.touch_updated_at();

-- ===== PLAYER GOALS =====
-- Admin logs goals per (player, match) after each game.
create table public.player_goals (
  id bigserial primary key,
  player_id int not null references public.players(id) on delete cascade,
  match_id int not null references public.matches(id) on delete cascade,
  goals int not null check (goals >= 1),
  created_at timestamptz not null default now(),
  unique(player_id, match_id)
);

create index idx_player_goals_player on public.player_goals(player_id);
create index idx_player_goals_match on public.player_goals(match_id);

-- ===== SETTINGS =====
-- Key-value store for app config.
-- Keys: 'deadline_champion_scorer' (timestamptz), 'fee_amount' (number),
--       'prize_split' (jsonb {first:70, second:20, third:10}),
--       'pool_name' (text)
create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create trigger trg_settings_touch
before update on public.settings
for each row execute function public.touch_updated_at();

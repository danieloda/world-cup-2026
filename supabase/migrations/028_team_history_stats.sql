-- ============================================================
-- Migration 028: tabela team_history_stats
-- ============================================================
-- Cache do desempenho de cada seleção em Copas anteriores.
-- Alimentado por GET /teams/statistics?league=1&season=YYYY&team=ID.
-- Renderizado no card de palpite ("Como X foi em 2022").

create table if not exists public.team_history_stats (
  -- "team" usa o nome da seleção como aparece em matches.team_home
  -- (mesma normalização). Composto com season vira PK.
  team           text not null,
  season         int  not null,         -- ex: 2022, 2018
  api_team_id    int  not null,
  played         int  not null default 0,
  wins           int  not null default 0,
  draws          int  not null default 0,
  losses         int  not null default 0,
  goals_for      int  not null default 0,
  goals_against  int  not null default 0,
  form           text,                  -- ex: 'WWLWD' (mais recente à direita)
  reached_stage  text,                  -- 'group' | 'r16' | 'qf' | 'sf' | 'final' | 'champion'
  fetched_at     timestamptz not null default now(),
  primary key (team, season)
);

create index if not exists idx_team_history_team on public.team_history_stats(team);

alter table public.team_history_stats enable row level security;

create policy "team_history_select_all"
  on public.team_history_stats for select
  to authenticated using (true);

create policy "team_history_admin_write"
  on public.team_history_stats for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

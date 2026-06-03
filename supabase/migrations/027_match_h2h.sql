-- ============================================================
-- Migration 027: tabela match_h2h + api_player_id em players
-- ============================================================
-- 1) match_h2h: últimos confrontos diretos entre as duas seleções
--    de cada partida. Alimentado por GET /fixtures/headtohead?h2h=A-B
--    (API-Football). Renderizado no card de palpite.
--
-- 2) players.api_player_id: id estável da API-Football. Permite o
--    sync-squads upsertar sem TRUNCATE (preserva FKs de
--    top_scorer_picks e player_goals).

-- 1) Tabela H2H — 1 linha por jogo, payload já formatado pra UI
create table if not exists public.match_h2h (
  match_id      int primary key references public.matches(id) on delete cascade,
  -- Array de objetos { date, home, away, home_goals, away_goals, competition }
  -- ordenados do mais recente para o mais antigo, limitado aos últimos 5.
  fixtures      jsonb not null,
  -- Resumo agregado: { home_wins, draws, away_wins, total }
  -- "home" refere-se ao mandante da partida do bolão (team_home).
  summary       jsonb not null,
  api_team_home int not null,           -- id API-Football do mandante
  api_team_away int not null,           -- id API-Football do visitante
  fetched_at    timestamptz not null default now()
);

create index if not exists idx_match_h2h_fetched on public.match_h2h(fetched_at);

-- RLS — leitura para autenticados, escrita só admin
alter table public.match_h2h enable row level security;

create policy "match_h2h_select_all"
  on public.match_h2h for select
  to authenticated using (true);

create policy "match_h2h_admin_write"
  on public.match_h2h for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 2) api_player_id em players (nullable; populado pelo sync-squads)
alter table public.players
  add column if not exists api_player_id int;

create unique index if not exists uniq_players_api_id
  on public.players(api_player_id)
  where api_player_id is not null;

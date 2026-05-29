-- ============================================================
-- Migration 020: api_fixture_id em matches + tabela match_odds
-- ============================================================
-- Adiciona linkage com a API-Football (v3.football.api-sports.io)
-- e cria armazenamento para as odds pre-match (mercado "Match Winner").
--
-- Fonte: GET /odds?fixture={api_fixture_id}&bet=1&bookmaker=32 (Betano)

-- 1) Link com a API
alter table public.matches
  add column if not exists api_fixture_id int unique;

create index if not exists idx_matches_api_fixture_id
  on public.matches(api_fixture_id);

-- 2) Tabela de odds (1 linha por jogo)
create table if not exists public.match_odds (
  match_id      int primary key references public.matches(id) on delete cascade,
  odd_home      numeric(6,2) not null,
  odd_draw      numeric(6,2) not null,
  odd_away      numeric(6,2) not null,
  bookmaker_id  int not null,
  bookmaker_name text not null,
  api_updated_at timestamptz,           -- "update" devolvido pela API
  fetched_at    timestamptz not null default now()
);

-- 3) RLS — leitura pública (autenticados), escrita só admin
alter table public.match_odds enable row level security;

create policy "match_odds_select_all"
  on public.match_odds for select
  to authenticated using (true);

create policy "match_odds_admin_write"
  on public.match_odds for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

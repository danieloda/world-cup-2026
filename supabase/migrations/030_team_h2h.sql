-- ============================================================
-- Migration 030: tabela team_h2h (confronto direto por par de times)
-- ============================================================
-- O mata-mata resolve os times dinamicamente (palpite/resultado), então o
-- H2H não pode ser keyed por match_id como em match_h2h. Aqui guardamos o
-- histórico por PAR de seleções, em ordem canônica (team_a < team_b).
--
-- O front (palpites-mata) busca on-demand ao abrir o Raio-X:
--   select fixtures, summary from team_h2h where team_a=? and team_b=?
-- e reorienta o summary para a ótica do mandante do confronto.
--
-- Fonte: GET /fixtures/headtohead?h2h={idA-idB}&last=5 (API-Football).

create table if not exists public.team_h2h (
  team_a       text not null,            -- par canônico: team_a < team_b (alfabético)
  team_b       text not null,
  -- Últimos confrontos (até 5), { date, home, away, home_goals, away_goals, competition }
  fixtures     jsonb not null,
  -- Agregado na ótica de team_a: { home_wins, draws, away_wins, total }
  summary      jsonb not null,
  api_team_a   int,
  api_team_b   int,
  fetched_at   timestamptz not null default now(),
  primary key (team_a, team_b)
  -- ordem canônica (team_a < team_b) é garantida pela app, não por CHECK:
  -- a ordenação de string do JS diverge da collation do Postgres em pares
  -- como "USA"/"Uruguay" (ver migration 031).
);

alter table public.team_h2h enable row level security;

create policy "team_h2h_select_all"
  on public.team_h2h for select
  to authenticated using (true);

create policy "team_h2h_admin_write"
  on public.team_h2h for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

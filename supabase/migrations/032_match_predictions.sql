-- ============================================================
-- Migration 032: tabela match_predictions
-- ============================================================
-- Previsão pré-jogo da API-Football (GET /predictions?fixture={id}),
-- já NORMALIZADA no formato que o front consome (ver js/raiox.js /
-- renderPredictionsBlock). Alimentada por scripts/fetch-predictions.js
-- e renderizada no painel Raio-X (barra 1X2 + radar de força).
--
-- Mesmo padrão de match_odds / match_h2h: 1 linha por jogo, leitura
-- pública (autenticados), escrita só admin. O script só grava quando a
-- API devolve previsão ÚTIL — sem dado, não há linha (e o front não mostra
-- nada), igual às odds.

create table if not exists public.match_predictions (
  match_id   int primary key references public.matches(id) on delete cascade,
  -- Shape normalizado:
  --   { source, pHome, pDraw, pAway, favored:'home'|'draw'|'away',
  --     comparison:[{ label, home, away }], radar:{ axes, home[], away[] } }
  -- percentuais na ótica do mandante do bolão (team_home).
  payload    jsonb not null,
  advice     text,                       -- "advice" cru da API (auditoria/debug)
  fetched_at timestamptz not null default now()
);

create index if not exists idx_match_predictions_fetched
  on public.match_predictions(fetched_at);

-- RLS — leitura para autenticados, escrita só admin
alter table public.match_predictions enable row level security;

create policy "match_predictions_select_all"
  on public.match_predictions for select
  to authenticated using (true);

create policy "match_predictions_admin_write"
  on public.match_predictions for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

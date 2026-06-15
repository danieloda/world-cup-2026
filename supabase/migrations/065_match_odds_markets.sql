-- ============================================================
-- Migration 065: coluna `markets` (jsonb) em match_odds
-- ============================================================
-- Guarda os mercados EXTRA de odds (além do 1X2) já NORMALIZADOS no shape que o
-- Raio-X consome: placar provável (Exact Score), perfil de gols (Over/Under,
-- Both Teams Score, distribuição de gols, gols por seleção).
--
-- Fonte: GET /odds?fixture={api_fixture_id}&bookmaker=32 (Betano) — a MESMA
-- chamada que já traz o 1X2; só deixamos de filtrar por &bet=1 e capturamos os
-- mercados extras. Normalização em scripts/lib/normalize-odds-markets.js.
--
-- Nullable e aditivo: linhas antigas seguem válidas (markets = null → o front
-- mostra só a barra 1X2, sem os blocos novos — gating de sempre).

alter table public.match_odds
  add column if not exists markets jsonb;

-- RLS já cobre a tabela inteira (migration 020): leitura autenticada, escrita
-- admin. A nova coluna herda essas policies; nada a adicionar.

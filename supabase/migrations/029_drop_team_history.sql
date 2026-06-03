-- ============================================================
-- Migration 029: remove team_history_stats (Copa 2022)
-- ============================================================
-- A seção "Campanha na Copa 2022" do Raio-X foi descontinuada.
-- Removemos a tabela e seus dados (era apenas cache da API-Football).

drop table if exists public.team_history_stats cascade;

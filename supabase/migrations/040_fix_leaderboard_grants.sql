-- ============================================================
-- Migration 040: corrige regressão de grants da 034 (pega no E2E completo)
-- ============================================================
-- A 034 revogou champion_bonus_for/scorer_bonus_for/stage_multiplier de
-- authenticated como "deny-by-default" (H2). Mas essas funções são chamadas
-- DENTRO de v_leaderboard / v_scorer_ranking, e o EXECUTE de uma função usada
-- numa view é checado contra o INVOKER (o usuário logado), não contra o dono da
-- view — mesmo a view sendo security definer. Resultado: a página de ranking
-- dava 403 (permission denied for function champion_bonus_for) pra todo usuário.
--
-- Reconcede o EXECUTE: essas 3 funções NÃO vazam nada além do que o próprio
-- leaderboard já expõe (champion_pts/scorer_pts por usuário). As realmente
-- sensíveis (compute_predicted_slots, qualifier_bonus_for, recompute_*) seguem
-- revogadas — elas rodam só em contexto de dono (triggers/funções definer).

grant execute on function public.champion_bonus_for(uuid) to authenticated;
grant execute on function public.scorer_bonus_for(uuid)   to authenticated;
grant execute on function public.stage_multiplier(text)   to authenticated;  -- chamada por scorer_bonus_for

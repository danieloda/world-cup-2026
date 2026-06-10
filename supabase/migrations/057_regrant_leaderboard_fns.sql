-- ============================================================
-- Migration 057: HOTFIX do incidente de 2026-06-09 (~22h BRT) — ranking fora
--                do ar com "permission denied for function champion_bonus_for"
-- ============================================================
-- O QUE ACONTECEU: prod aplica migrations à mão no SQL Editor. Nesta noite, uma
-- migration antiga que contém REVOKE do trio do leaderboard (039 — ou 034) foi
-- reaplicada DEPOIS da 040, e `authenticated` perdeu o EXECUTE de novo. Como o
-- EXECUTE de função chamada por view é checado contra o INVOKER (ver header da
-- 040), v_leaderboard passou a falhar pra TODO usuário logado:
--   • ranking.html → tela de erro (FATAL — é o throw do leaderRes)
--   • inicio.html  → "Sua posição" e o gráfico "Sua jornada" somem (degradação
--     silenciosa: leaderRes.data ?? [] / progression retorna null)
--   • demais páginas: ilesas (v_pool_stats só faz counts; RPCs do front são
--     admin_*/report_signup_failure, re-concedidas nas próprias migrations)
-- Nenhum dado foi perdido/corrompido — é só grant de leitura.
--
-- POR QUE O MONITOR NÃO PEGOU: prod-smoke/prod-verify rodam como service_role,
-- que tem grant PRÓPRIO (default privileges) — verde às 21:27, site quebrado.
--
-- FIX (idêntico à 040, idempotente):
grant execute on function public.champion_bonus_for(uuid) to authenticated;
grant execute on function public.scorer_bonus_for(uuid)   to authenticated;
grant execute on function public.stage_multiplier(text)   to authenticated;  -- chamada por scorer_bonus_for

-- PREVENÇÃO (junto com esta migration):
--   • 034 e 039 ganharam um bloco final com o estado CANÔNICO dos grants —
--     reaplicá-las à mão deixou de derrubar o ranking.
--   • grants_health() abaixo: o prod-smoke (30 em 30 min) passa a enxergar os
--     grants do role authenticated mesmo rodando como service_role.

-- ============================================================
-- grants_health(): sonda definer dos grants que mantêm o site de pé.
-- NÃO é RPC de usuário: só service_role executa (superfície = monitor).
-- KEEP IN SYNC: scripts/e2e/prod-smoke.js (MUST_TRUE/MUST_FALSE).
-- ============================================================
create or replace function public.grants_health()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- precisam ser TRUE — sem eles ranking.html cai e inicio.html degrada
    'champion_bonus_for__auth_exec', has_function_privilege('authenticated', 'public.champion_bonus_for(uuid)', 'execute'),
    'scorer_bonus_for__auth_exec',   has_function_privilege('authenticated', 'public.scorer_bonus_for(uuid)',   'execute'),
    'stage_multiplier__auth_exec',   has_function_privilege('authenticated', 'public.stage_multiplier(text)',   'execute'),
    'v_leaderboard__auth_select',    has_table_privilege('authenticated', 'public.v_leaderboard',    'select'),
    'v_scorer_ranking__auth_select', has_table_privilege('authenticated', 'public.v_scorer_ranking', 'select'),
    'v_pool_stats__auth_select',     has_table_privilege('authenticated', 'public.v_pool_stats',     'select'),
    -- precisam ser FALSE — deny-by-default da 034 (sensíveis seguem trancadas)
    'score_prediction__auth_exec',             has_function_privilege('authenticated', 'public.score_prediction(int,int,text,int,int,text,text)', 'execute'),
    'recompute_prediction_points__auth_exec',  has_function_privilege('authenticated', 'public.recompute_prediction_points(int)', 'execute'),
    'compute_predicted_slots__auth_exec',      has_function_privilege('authenticated', 'public.compute_predicted_slots(uuid)', 'execute')
  );
$$;

revoke all on function public.grants_health() from public, anon, authenticated;
grant execute on function public.grants_health() to service_role;

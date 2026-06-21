-- ============================================================
-- Migration 070: views passam a SECURITY INVOKER (advisor CRITICAL)
-- ============================================================
-- O Security Advisor do Supabase marcou as 4 views públicas como CRITICAL
-- "Security Definer View": v_leaderboard, v_scorer_ranking, v_pool_stats,
-- v_revealed_matches. Motivo: `create view` sem `security_invoker` cai no
-- default do Postgres (security_invoker=OFF) → a view lê as tabelas-base como
-- o DONO (postgres) e BYPASSA o RLS de quem consulta. É exatamente o que o
-- linter aponta.
--
-- POR QUE É SEGURO HOJE (e não era um vazamento ativo):
--   • v_pool_stats / v_revealed_matches: só leem tabelas com SELECT using(true)
--     p/ authenticated (profiles[sem email]/settings/matches/integrity_publications)
--     e funções puras (prediction_deadline). Flip = ZERO mudança de saída.
--   • v_leaderboard: agrega predictions SÓ de jogos finished (≠ void) — e jogo
--     finished tem match_date no passado, então o RLS de predictions
--     (predictions_select_own_or_revealed, 060) JÁ revela essas linhas a qualquer
--     logado. Só emite agregados (nenhum palpite individual); email saiu na 037.
--   • v_scorer_ranking: o único dado sensível (palpite de artilheiro) abre p/
--     todos em now() >= cs_deadline() (11/jun), que já passou. Pós-prazo as
--     top_scorer_picks são world-readable; flip = ZERO mudança.
--   As funções de bônus (champion_bonus_for/scorer_bonus_for) JÁ são SECURITY
--   INVOKER → sempre rodaram no contexto do CALLER; o flip da view não muda elas.
--
-- POR QUE INVOKER É A POSTURA DURÁVEL: passa a honrar o RLS do usuário, então a
-- view se auto-protege se um RLS futuro apertar (ex.: rodar este repo num bolão
-- novo ANTES do cs_deadline esconderia corretamente os palpites alheios).
--
-- ⚠ CAVEAT CONHECIDO (v_leaderboard/v_scorer_ranking): sob invoker, o match_pts
-- do ranking passa a depender do RLS de revelação. Hoje coincide com o definer
-- porque resultado entra DEPOIS do apito (match_date<=now()). Um estado anômalo
-- — admin cravando resultado ANTES do match_date, ou jogo finished com match_date
-- empurrado pra frente — deixaria esse jogo "finished mas não revelado": sob
-- invoker o ponto sai do agregado p/ o usuário comum, divergindo do snapshot
-- service_role (que bypassa RLS). Em operação normal isso não ocorre. Se um dia
-- quiser blindar, force `finished ⇒ match_date<=now()` via trigger. Não há
-- constraint hoje; é convenção operacional.
--
-- IMPORTANTE: usar ALTER VIEW ... SET, NUNCA `create or replace view` — um
-- create/replace POSTERIOR zera o flag silenciosamente (volta o CRITICAL) e
-- ainda trip o sentinela da leaderboard-parity.test.js (fixado na 039).
--
-- KEEP IN SYNC:
--   • tests/unit/rls-invariants.test.js (guard estático: invoker=on é a última palavra)
--   • scripts/dev/prod-parity-audit.mjs (shape das views; já guarda email fora)
--   • grants_health() / scripts/e2e/prod-smoke.js (grants das views/funções)

-- ============================================================
-- 1) Flip das 4 views para security_invoker (honra o RLS do caller)
-- ============================================================
alter view public.v_leaderboard      set (security_invoker = on);
alter view public.v_scorer_ranking   set (security_invoker = on);
alter view public.v_pool_stats        set (security_invoker = on);
alter view public.v_revealed_matches  set (security_invoker = on);

-- ============================================================
-- 2) Re-assert dos grants de SELECT (idempotente / re-paste safe).
--    Imagens novas do Supabase (CLI ≥ ~2.1xx) não dão SELECT por default
--    privilege; sem o grant a view some do PostgREST. service_role lê o
--    v_leaderboard no snapshot de integridade (bypassa RLS mesmo sob invoker).
-- ============================================================
grant select on public.v_leaderboard      to authenticated, service_role;
grant select on public.v_scorer_ranking   to authenticated, service_role;
grant select on public.v_pool_stats        to authenticated, service_role;
grant select on public.v_revealed_matches  to authenticated, service_role;

-- ============================================================
-- 3) Re-assert do EXECUTE das funções INVOKER usadas DENTRO das views.
--    Sob invoker, o EXECUTE é checado contra o usuário; sem ele a view inteira
--    dá 403 p/ todo mundo (lição do incidente de 2026-06-09, ver addendum da 039).
--    NÃO mexer nas funções SECURITY DEFINER deny-by-default (recompute_*,
--    compute_predicted_slots, qualifier_bonus_for) — seguem revogadas (034).
-- ============================================================
grant execute on function public.champion_bonus_for(uuid) to authenticated;
grant execute on function public.scorer_bonus_for(uuid)   to authenticated;
grant execute on function public.stage_multiplier(text)   to authenticated;

-- ============================================================
-- 4) Confirmação: o SELECT abaixo mostra as reloptions resultantes. Cada uma das
--    4 linhas deve trazer security_invoker (=on/=true conforme o render do PG)
--    em `reloptions` e `invoker_on = true`. SEM raise/rollback de propósito —
--    uma verificação frágil NÃO pode reverter um ALTER que funcionou (foi o que
--    derrubou a 1ª tentativa: `reloptions @> '{security_invoker=true}'` não casou
--    com a string real e o RAISE reverteu a transação inteira no SQL Editor).
-- ============================================================
select
  c.relname                                                   as view,
  c.reloptions                                                as reloptions,
  exists (
    select 1 from unnest(coalesce(c.reloptions, '{}'::text[])) as opt
    where split_part(opt, '=', 1) = 'security_invoker'
      and lower(split_part(opt, '=', 2)) in ('true','on','1','yes')
  )                                                            as invoker_on
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('v_leaderboard','v_scorer_ranking','v_pool_stats','v_revealed_matches')
order by c.relname;

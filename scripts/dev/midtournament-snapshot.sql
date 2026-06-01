-- ============================================================
-- DEV ONLY — Snapshot "torneio em andamento" (fim da fase de grupos)
-- ============================================================
-- Transforma o banco LOCAL (que após um E2E completo fica 100% finalizado)
-- num estado de meio-de-torneio, útil pra desenhar Histórico e Ranking.
-- IDEMPOTENTE: pode rodar quantas vezes quiser, sempre converge pro mesmo estado.
--
-- Estado resultante:
--   • Grupos, exceto a última rodada do Grupo L: FINALIZADOS (resultado, gols,
--     palpites pontuados) → no Histórico aparecem como "Finalizada".
--   • Grupo L (ids 67–72): SEM resultado, com data no passado → "Esperando resultado"
--     no Histórico (mostra o palpite de todos, sem pontos).
--   • Mata-mata (r32..final): SEM resultado e com data NO FUTURO → ainda não começou,
--     então fica FORA do Histórico (aparece só no bracket de palpites-mata).
--   • Campeão: indefinido (final não terminou) → champion_pts = 0 (estado "em aberto").
--   • Artilheiro: pontua só com gols da fase de grupos.
--
-- Pré-requisito: base já populada por um run E2E completo (104 jogos).
-- NÃO toca produção: rode via psql no container LOCAL (supabase_db_world-cup-2026).
-- Reversível: `supabase db reset` + re-seed + re-run E2E.
--
-- Uso (stdin evita conversão de path do Windows):
--   CID=supabase_db_world-cup-2026
--   docker exec -i $CID psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < scripts/dev/midtournament-snapshot.sql
-- ============================================================

-- Silencia os NOTICE de "relation already exists" dos triggers de classificados.
set client_min_messages = warning;

begin;

-- ------------------------------------------------------------
-- 1) Mata-mata (stage <> 'group'): des-finaliza + joga a data pro FUTURO.
--    Datas determinísticas (12h de intervalo a partir de um âncora fixo) →
--    idempotente e na ordem das fases (ids 73..104 crescem por fase).
-- ------------------------------------------------------------
update public.matches
   set finished    = false,
       finished_at = null,
       actual_home = null,
       actual_away = null,
       pen_winner  = null,
       match_date  = timestamptz '2026-06-20 18:00:00-03' + ((id - 73) * interval '12 hours')
 where stage <> 'group';

-- ------------------------------------------------------------
-- 2) Última rodada de grupos (Grupo L, ids 67–72): des-finaliza, MAS mantém a
--    data no passado → vira "Esperando resultado" no Histórico (palpites visíveis).
-- ------------------------------------------------------------
update public.matches
   set finished=false, finished_at=null, actual_home=null, actual_away=null, pen_winner=null
 where id between 67 and 72;

-- ------------------------------------------------------------
-- 3) Limpa o que não pode mais pontuar: gols e pontos cacheados dos jogos
--    que deixaram de estar finalizados.
-- ------------------------------------------------------------
delete from public.player_goals
 where match_id in (select id from public.matches where not finished);
update public.predictions
   set points_earned = null
 where match_id in (select id from public.matches where not finished);

-- ------------------------------------------------------------
-- 4) Recalcula o que sobrou (só grupos finalizados pontuam) + classificados.
-- ------------------------------------------------------------
select public.recompute_prediction_points();
select public.recompute_qualifier_points();

commit;

-- Resumo
\echo '--- Jogos por estado ---'
select
  case when finished then 'finalizado'
       when match_date <= now() then 'aguardando (no histórico)'
       else 'futuro (fora do histórico)' end as estado,
  count(*)
from public.matches group by 1 order by 1;

\echo '--- Top do ranking (v_leaderboard) ---'
select full_name, match_pts, champion_pts, scorer_pts, qualifier_pts, total_pts
from public.v_leaderboard limit 10;

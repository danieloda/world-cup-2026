-- ============================================================
-- Migration 074: acertar o EMPATE no mata-mata vale o ponto de RESULTADO,
--                mesmo errando quem passou nos pênaltis.
-- ============================================================
-- A 056 já dava o resultado (ave) a quem CRAVAVA o placar do tempo normal de um
-- KO empatado. Mas quem acertava que o jogo terminaria empatado SEM cravar o
-- placar (ex.: palpitou 2×2, deu 1×1 nos pênaltis) e errava o pênalti ainda
-- perdia o ave — recebia só o saldo (dg). No R32 isso é 1 ponto em vez de 7.
--
-- Isso contradizia a regra-título "Pontos por jogo": "Acertou quem vence — OU
-- que o jogo terminaria empatado". Decisão (Daniel, 2026-06-30): o ponto de
-- RESULTADO passa a valer pelo DESFECHO do tempo normal/prorrogação
-- (vitória mandante / vitória visitante / EMPATE), IGNORANDO o pênalti. O palpite
-- de pênalti continua valendo, mas só para a CHAVE / bônus de classificado
-- (compute_predicted_slots), não para a pontuação do jogo.
--
-- Como placar exato tem sempre o MESMO sinal de saldo do real, esta regra
-- SUBSUME a 056 (cravar continua garantindo o resultado). p_pen/a_pen viram
-- argumentos inertes em score_prediction (mantidos na assinatura p/ não mexer em
-- recompute_prediction_points nem nos chamadores).
--
-- Caso real coberto: M75 Países Baixos 1×1 Marrocos (pen→Marrocos): 5 palpites de
-- 2×2 que escolheram Países Baixos sobem de 1 → 7. Ninguém perde pontos.
--
-- KEEP IN SYNC: src/js/scoring.js (scorePrediction/scoreBreakdown),
-- scripts/e2e/lib/scoring.js, tests/unit/scoring*.test.js, src/js/pages/regras.js.
-- ============================================================

-- ============================================================
-- 1) score_prediction: ave pelo desfecho (sinal do saldo), sem pênalti
-- ============================================================
create or replace function public.score_prediction(
  ph int, pa int, p_pen text,
  ah int, aw int, a_pen text,
  stage text
) returns int language plpgsql immutable as $$
declare
  ag int; ave int; dg int;
  pts int := 0;
begin
  if ph is null or pa is null or ah is null or aw is null then
    return 0;
  end if;

  ag := case stage
    when 'group' then 1 when 'r32' then 1 when 'r16' then 3 when 'qf' then 5
    when 'sf' then 8 when 'third' then 4 when 'final' then 12 else 1 end;
  ave := case stage
    when 'group' then 4 when 'r32' then 6 when 'r16' then 12 when 'qf' then 20
    when 'sf' then 32 when 'third' then 16 when 'final' then 48 else 4 end;
  dg := case stage when 'qf' then 2 when 'sf' then 2 when 'final' then 4 else 1 end;

  -- AG: um pacote por LADO acertado (0, 1 ou 2 lados)
  if ph = ah then pts := pts + ag; end if;
  if pa = aw then pts := pts + ag; end if;

  -- AVE: ponto de RESULTADO pelo desfecho do tempo normal/prorrogação
  -- (mandante vence / visitante vence / EMPATE), IGNORANDO o pênalti. Acertar
  -- que terminou empatado leva o resultado mesmo errando quem passou nos
  -- pênaltis; o pênalti decide só a chave/classificado. (Placar exato tem o
  -- mesmo sinal de saldo → subsume a 056 "cravou = exato".) p_pen/a_pen inertes.
  if (case when ph > pa then 'h' when pa > ph then 'a' else 'd' end)
   = (case when ah > aw then 'h' when aw > ah then 'a' else 'd' end)
  then pts := pts + ave; end if;

  -- DG: saldo de gols (inclui empate, saldo 0)
  if (ph - pa) = (ah - aw) then pts := pts + dg; end if;

  return pts;
end $$;

-- SECURITY-sensível: segue sem EXECUTE p/ public/anon/authenticated (034).
-- create or replace PRESERVA grants; re-revoga por garantia (re-paste safe).
revoke execute on function public.score_prediction(int,int,text,int,int,text,text)
  from public, anon, authenticated;

-- ============================================================
-- 2) v_leaderboard: winner_ok também passa a ignorar o pênalti, para a
--    classificação "vencedor/empate" (desempate V+S) bater com o ave acima.
--    Sem isto, os 5 palpites de 2×2 ganhariam o ave mas seriam contados como
--    ERRO TOTAL (miss) no desempate — pior incoerência que a do bug original.
--    Corpo idêntico ao da 039, exceto o CASE de winner_ok (sem o ramo pen).
-- ============================================================
create or replace view public.v_leaderboard as
with pred_classified as (
  select
    p.user_id,
    p.points_earned,
    (p.pred_home = m.actual_home and p.pred_away = m.actual_away) as is_exact,
    (case when p.pred_home > p.pred_away then 'h' when p.pred_away > p.pred_home then 'a' else 'd' end)
      =
    (case when m.actual_home > m.actual_away then 'h' when m.actual_away > m.actual_home then 'a' else 'd' end)
      as winner_ok,
    ((p.pred_home - p.pred_away) = (m.actual_home - m.actual_away)) as diff_ok,
    (p.pred_home = m.actual_home or p.pred_away = m.actual_away) as side_ok
  from public.predictions p
  join public.matches m on m.id = p.match_id
  where m.finished = true and m.status <> 'void' and p.points_earned is not null
),
prediction_pts as (
  select user_id,
         coalesce(sum(points_earned), 0)::int as match_pts,
         count(*) filter (where is_exact)::int as exact_count,
         count(*) filter (where not is_exact and winner_ok and diff_ok)::int as w_sg_count,
         count(*) filter (where not is_exact and winner_ok and not diff_ok)::int as w_count,
         count(*) filter (where not winner_ok and side_ok)::int as side_count,
         count(*) filter (where not winner_ok and not side_ok)::int as zero_count
  from pred_classified
  group by user_id
)
select
  p.id              as user_id,
  p.full_name,
  p.paid,
  coalesce(pp.match_pts, 0) as match_pts,
  public.champion_bonus_for(p.id) as champion_pts,
  public.scorer_bonus_for(p.id) as scorer_pts,
  coalesce(uqp.points, 0) as qualifier_pts,
  (coalesce(pp.match_pts, 0)
    + public.champion_bonus_for(p.id)
    + public.scorer_bonus_for(p.id)
    + coalesce(uqp.points, 0)) as total_pts,
  coalesce(pp.exact_count, 0) as exact_count,
  coalesce(pp.w_sg_count, 0)  as winner_sg_count,
  coalesce(pp.w_count, 0)     as winner_count,
  coalesce(pp.side_count, 0)  as side_count,
  coalesce(pp.zero_count, 0)  as miss_count
from public.profiles p
left join prediction_pts pp on pp.user_id = p.id
left join public.user_qualifier_points uqp on uqp.user_id = p.id
where p.paid = true
order by total_pts desc, exact_count desc, winner_sg_count desc;
grant select on public.v_leaderboard to authenticated, service_role;

-- 'create or replace view' ZERA o security_invoker (ver 070) → reaplica, senão a
-- view volta a CRITICAL no advisor e trip a rls-invariants.test.js.
alter view public.v_leaderboard set (security_invoker = on);

-- Sob invoker, as funções INVOKER usadas na view têm EXECUTE checado contra o
-- caller; reasserta (lição do incidente 2026-06-09, ver 039/057/070).
grant execute on function public.champion_bonus_for(uuid) to authenticated;
grant execute on function public.scorer_bonus_for(uuid)   to authenticated;
grant execute on function public.stage_multiplier(text)   to authenticated;

-- ============================================================
-- 3) Re-pontua TODOS os palpites com a nova regra (mesmo recompute da 022/056;
--    idempotente). Sem isso, KOs já finalizados ficariam com os pontos antigos.
-- ============================================================
select public.recompute_prediction_points();

-- ============================================================
-- Migration 022: Pontuação ADITIVA por jogo (rebalanceada p/ emoção no fim)
-- ============================================================
-- Substitui o modelo "melhor-tier" (5/3/2/1) por um modelo ADITIVO em que
-- cada acerto SOMA, igual à regra do bolão de referência:
--   AG  (gols de um lado): +ag por LADO acertado
--   AVE (vencedor/empate): +ave   (= 4 × ag base, regra do screenshot)
--   DG  (saldo de gols):   +dg
--
-- Os PESOS por fase foram deixados mais íngremes (validado por simulação Monte
-- Carlo: ~55% dos pontos ficam em jogo APÓS os grupos, líder dos grupos vence só
-- ~8% das vezes) para que a emoção fique no fim e ninguém seja eliminado cedo.
--
--   Fase    | gols/lado(AG) | vencedor(AVE) | saldo(DG) | placar exato
--   group   |   1           |   4           |   1       |   7
--   r32     |   1           |   6           |   1       |   9
--   r16     |   3           |  12           |   1       |  19
--   qf      |   5           |  20           |   2       |  32
--   sf      |   8           |  32           |   2       |  50
--   third   |   4           |  16           |   1       |  25
--   final   |  12           |  48           |   4       |  76
--
-- Campeão: 50 → 40. Classificado (BPE/BP) e leaderboard recalibrados.
-- Artilheiro: inalterado (2 × gols × stage_multiplier).
-- KEEP IN SYNC: js/scoring.js (scorePrediction, championBonus, qualifierBonus)
--               e scripts/e2e/lib/scoring.js.

-- ============================================================
-- 1) score_prediction ADITIVO (mesma assinatura de 003)
-- ============================================================
create or replace function public.score_prediction(
  ph int, pa int, p_pen text,
  ah int, aw int, a_pen text,
  stage text
) returns int language plpgsql immutable as $$
declare
  ag int; ave int; dg int;
  pts int := 0;
  pred_w text; act_w text;
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

  -- AG: um ponto-pacote por LADO acertado (0, 1 ou 2 lados)
  if ph = ah then pts := pts + ag; end if;
  if pa = aw then pts := pts + ag; end if;

  -- AVE: vencedor/empate (mata-mata empatado usa pen_winner)
  pred_w := case when ph > pa then 'h' when pa > ph then 'a'
                 when stage <> 'group' and p_pen is not null then p_pen else 'd' end;
  act_w  := case when ah > aw then 'h' when aw > ah then 'a'
                 when stage <> 'group' and a_pen is not null then a_pen else 'd' end;
  if pred_w = act_w then pts := pts + ave; end if;

  -- DG: saldo de gols (inclui empate, saldo 0)
  if (ph - pa) = (ah - aw) then pts := pts + dg; end if;

  return pts;
end $$;

-- recompute_prediction_points e o trigger trg_match_finished continuam valendo
-- (chamam score_prediction). Recalcula tudo com a nova função:
select public.recompute_prediction_points();

-- ============================================================
-- 2) Campeão: 50 → 40
-- ============================================================
create or replace function public.champion_bonus_for(p_user_id uuid)
returns int language sql stable as $$
  select coalesce((
    with final_match as (
      select team_home, team_away, actual_home, actual_away, pen_winner, finished
      from public.matches where stage = 'final' limit 1
    ),
    champion as (
      select team from public.champion_picks where user_id = p_user_id
    )
    select case
      when fm.finished = false then 0
      when c.team is null then 0
      when fm.actual_home > fm.actual_away and c.team = fm.team_home then 40
      when fm.actual_away > fm.actual_home and c.team = fm.team_away then 40
      when fm.actual_home = fm.actual_away and fm.pen_winner = 'home' and c.team = fm.team_home then 40
      when fm.actual_home = fm.actual_away and fm.pen_winner = 'away' and c.team = fm.team_away then 40
      else 0
    end
    from final_match fm
    left join champion c on true
  ), 0);
$$;

-- ============================================================
-- 3) Classificado (BPE/BP) — valores recalibrados
--    r32 1/0 · r16 2/1 · qf 3/2 · sf 5/3 · third 3/2 · final 8/4
--    (BP nos 32-avos = 0: com 32 vagas, "time está nessa fase" é quase de graça.)
-- ============================================================
create or replace function public.qualifier_bonus_pts(p_phase text, p_exact boolean)
returns numeric language sql immutable as $$
  with b as (
    select case p_phase
      when 'r32' then 1 when 'r16' then 2 when 'qf' then 3
      when 'sf' then 5 when 'third' then 3 when 'final' then 8
      else 0
    end as bpe
  )
  select case
    when p_exact         then bpe::numeric
    when p_phase = 'r32' then 0          -- sem BP nos 32-avos
    else round(bpe / 2.0)
  end
  from b;
$$;

-- recalcula o cache do bônus de classificado com os novos valores
select public.recompute_qualifier_points();

-- ============================================================
-- 4) v_leaderboard — categorias por COMPARAÇÃO (não por valor de pontos)
-- ============================================================
-- Com pontuação aditiva, "placar exato" não vale mais 5 fixo; então as colunas
-- de estatística (exatos / vencedor+saldo / só vencedor / um lado) passam a ser
-- derivadas da comparação palpite × resultado, mutuamente exclusivas:
--   exato      : os dois placares certos
--   venc+saldo : vencedor certo E saldo certo, mas não exato
--   só vencedor: vencedor certo, saldo errado
--   um lado    : vencedor errado, mas um dos placares certo
--   erro       : nada
drop view if exists public.v_leaderboard;
create view public.v_leaderboard as
with pred_classified as (
  select
    p.user_id,
    p.points_earned,
    (p.pred_home = m.actual_home and p.pred_away = m.actual_away) as is_exact,
    (case when p.pred_home > p.pred_away then 'h' when p.pred_away > p.pred_home then 'a'
          when m.stage <> 'group' and p.pred_pen_winner is not null then p.pred_pen_winner else 'd' end)
      =
    (case when m.actual_home > m.actual_away then 'h' when m.actual_away > m.actual_home then 'a'
          when m.stage <> 'group' and m.pen_winner is not null then m.pen_winner else 'd' end)
      as winner_ok,
    ((p.pred_home - p.pred_away) = (m.actual_home - m.actual_away)) as diff_ok,
    (p.pred_home = m.actual_home or p.pred_away = m.actual_away) as side_ok
  from public.predictions p
  join public.matches m on m.id = p.match_id
  where m.finished = true and p.points_earned is not null
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
  p.email,
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

grant select on public.v_leaderboard to authenticated;

-- ============================================================
-- Migration 037: PII no leaderboard + guarda de fee_amount (M1, L3)
-- ============================================================
-- M1: v_leaderboard expunha `email` (grant select a authenticated + view roda
--     no contexto do dono → qualquer logado lia o e-mail de todos). A coluna
--     não é usada pelo front (ranking/rank-chart só usam full_name/avatar).
--     Removida. (O harvest direto via `select email from profiles` é fechado
--     na 038, que mexe em grants de coluna e precisa de validação local.)
-- L3: v_pool_stats lia fee_amount com `(value::text)::numeric`, que estoura se o
--     valor estiver duplo-codificado em jsonb (legado). Passa a usar a mesma
--     extração tolerante a aspas do cs_deadline (migration 024).

-- ============================================================
-- M1) v_leaderboard sem email
-- ============================================================
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

-- ============================================================
-- L3) v_pool_stats tolerante a fee_amount duplo-codificado
-- ============================================================
create or replace view public.v_pool_stats as
select
  (select count(*) from public.profiles where paid = true) as paid_users,
  (select count(*) from public.profiles) as total_users,
  ((select count(*) from public.profiles where paid = true)
    * coalesce(
        (select trim(both '"' from (value #>> '{}'))::numeric
           from public.settings where key = 'fee_amount'),
        0)
  )::numeric as total_pot,
  (select count(*) from public.matches where finished = true) as finished_matches,
  (select count(*) from public.matches) as total_matches,
  round(
    (select count(*) from public.matches where finished = true)::numeric * 100
    / nullif((select count(*) from public.matches), 0)
  , 1) as pct_played;

grant select on public.v_pool_stats to authenticated;

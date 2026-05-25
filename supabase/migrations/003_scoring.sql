-- ============================================================
-- Bolão Copa 2026 — Scoring & Leaderboard
-- ============================================================
-- Run AFTER 002_rls.sql

-- ===== Stage multiplier =====
create or replace function public.stage_multiplier(stage text)
returns numeric language sql immutable as $$
  select case stage
    when 'group' then 1.0
    when 'r32'   then 1.5
    when 'r16'   then 2.0
    when 'qf'    then 3.0    -- was 2.5, increased for comeback potential
    when 'sf'    then 4.0    -- was 3.0, increased for comeback potential
    when 'third' then 2.0
    when 'final' then 5.0    -- was 4.0, increased for comeback potential
    else 1.0
  end;
$$;

-- ===== Per-prediction scoring =====
-- Rules:
--   placar exato                                      → 5 pts × mult
--   vencedor correto + saldo de gols correto          → 3 pts × mult
--   vencedor correto (sem saldo)                      → 2 pts × mult
--   apenas gols de um lado corretos (sem vencedor)    → 1 pt  × mult
--   nada                                              → 0
-- For knockout: if regulation ended in draw, winner = pen_winner.
create or replace function public.score_prediction(
  ph int, pa int, p_pen text,
  ah int, aw int, a_pen text,
  stage text
) returns int language plpgsql immutable as $$
declare
  mult numeric := public.stage_multiplier(stage);
  pred_winner text;
  actual_winner text;
  base int := 0;
begin
  if ph is null or pa is null or ah is null or aw is null then
    return 0;
  end if;

  -- Determine winners (h/a/d for predictions; for actual KO use pen_winner if draw)
  pred_winner := case
    when ph > pa then 'h'
    when pa > ph then 'a'
    when stage <> 'group' and p_pen is not null then p_pen  -- predicted pen winner
    else 'd'
  end;

  actual_winner := case
    when ah > aw then 'h'
    when aw > ah then 'a'
    when stage <> 'group' and a_pen is not null then a_pen
    else 'd'
  end;

  -- Exact score
  if ph = ah and pa = aw then
    base := 5;
  -- Correct winner + correct goal diff (and same score not already caught above)
  elsif pred_winner = actual_winner and (ph - pa) = (ah - aw) then
    base := 3;
  -- Correct winner only
  elsif pred_winner = actual_winner then
    base := 2;
  -- Wrong winner, but one side's goals correct
  elsif ph = ah or pa = aw then
    base := 1;
  end if;

  return round(base * mult);
end $$;

-- ===== Recompute all prediction points (for given match or all) =====
create or replace function public.recompute_prediction_points(p_match_id int default null)
returns void language plpgsql security definer as $$
begin
  update public.predictions p
  set points_earned = public.score_prediction(
    p.pred_home, p.pred_away, p.pred_pen_winner,
    m.actual_home, m.actual_away, m.pen_winner,
    m.stage
  )
  from public.matches m
  where p.match_id = m.id
    and m.finished = true
    and (p_match_id is null or p.match_id = p_match_id);
end $$;

-- ===== Trigger: when match finishes, recompute that match's predictions =====
create or replace function public.on_match_finished()
returns trigger language plpgsql security definer as $$
begin
  if new.finished = true and (old.finished is null or old.finished = false
       or new.actual_home is distinct from old.actual_home
       or new.actual_away is distinct from old.actual_away
       or new.pen_winner is distinct from old.pen_winner) then
    perform public.recompute_prediction_points(new.id);
  end if;
  return new;
end $$;

create trigger trg_match_finished
after update on public.matches
for each row execute function public.on_match_finished();

-- ===== Champion bonus (computed when final ends) =====
-- +50 pts if champion pick matches actual final winner (increased for 48-team format & comeback potential)
create or replace function public.champion_bonus_for(p_user_id uuid)
returns int language sql stable as $$
  with final_match as (
    select team_home, team_away, actual_home, actual_away, pen_winner, finished
    from public.matches
    where stage = 'final' limit 1
  ),
  champion as (
    select team from public.champion_picks where user_id = p_user_id
  )
  select case
    when fm.finished = false then 0
    when c.team is null then 0
    when fm.actual_home > fm.actual_away and c.team = fm.team_home then 50
    when fm.actual_away > fm.actual_home and c.team = fm.team_away then 50
    when fm.actual_home = fm.actual_away and fm.pen_winner = 'home' and c.team = fm.team_home then 50
    when fm.actual_home = fm.actual_away and fm.pen_winner = 'away' and c.team = fm.team_away then 50
    else 0
  end
  from final_match fm, champion c;
$$;

-- ===== Top scorer bonus (per goal × stage multiplier) =====
-- +2 pts × stage_mult per goal scored by user's pick
create or replace function public.scorer_bonus_for(p_user_id uuid)
returns int language sql stable as $$
  select coalesce(sum(
    pg.goals * 2 * public.stage_multiplier(m.stage)
  )::int, 0)
  from public.top_scorer_picks tsp
  join public.player_goals pg on pg.player_id = tsp.player_id
  join public.matches m on m.id = pg.match_id and m.finished = true
  where tsp.user_id = p_user_id;
$$;

-- ===== LEADERBOARD VIEW =====
create or replace view public.v_leaderboard as
with prediction_pts as (
  select user_id, coalesce(sum(points_earned), 0)::int as match_pts,
         count(*) filter (where points_earned = 5)::int as exact_count,
         count(*) filter (where points_earned >= 3 and points_earned < 5)::int as w_sg_count,
         count(*) filter (where points_earned = 2)::int as w_count,
         count(*) filter (where points_earned = 1)::int as side_count,
         count(*) filter (where points_earned = 0)::int as zero_count
  from public.predictions
  where points_earned is not null
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
  (coalesce(pp.match_pts, 0)
    + public.champion_bonus_for(p.id)
    + public.scorer_bonus_for(p.id)) as total_pts,
  coalesce(pp.exact_count, 0) as exact_count,
  coalesce(pp.w_sg_count, 0)  as winner_sg_count,
  coalesce(pp.w_count, 0)     as winner_count,
  coalesce(pp.side_count, 0)  as side_count,
  coalesce(pp.zero_count, 0)  as miss_count
from public.profiles p
left join prediction_pts pp on pp.user_id = p.id
where p.paid = true
order by total_pts desc, exact_count desc, winner_sg_count desc;

grant select on public.v_leaderboard to authenticated;

-- ===== Top scorer ranking VIEW =====
create or replace view public.v_scorer_ranking as
select
  p.id as user_id,
  p.full_name,
  pl.full_name as player_name,
  pl.team as player_team,
  coalesce(sum(pg.goals), 0)::int as goals,
  public.scorer_bonus_for(p.id) as bonus_pts
from public.profiles p
left join public.top_scorer_picks tsp on tsp.user_id = p.id
left join public.players pl on pl.id = tsp.player_id
left join public.player_goals pg on pg.player_id = pl.id
left join public.matches m on m.id = pg.match_id and m.finished = true
where p.paid = true and pl.id is not null
group by p.id, p.full_name, pl.full_name, pl.team
order by goals desc nulls last, p.full_name;

grant select on public.v_scorer_ranking to authenticated;

-- ===== Pool stats VIEW =====
create or replace view public.v_pool_stats as
select
  (select count(*) from public.profiles where paid = true) as paid_users,
  (select count(*) from public.profiles) as total_users,
  ((select count(*) from public.profiles where paid = true)
    * coalesce((select (value::text)::numeric from public.settings where key = 'fee_amount'), 0)
  )::numeric as total_pot,
  (select count(*) from public.matches where finished = true) as finished_matches,
  (select count(*) from public.matches) as total_matches,
  round(
    (select count(*) from public.matches where finished = true)::numeric * 100
    / nullif((select count(*) from public.matches), 0)
  , 1) as pct_played;

grant select on public.v_pool_stats to authenticated;

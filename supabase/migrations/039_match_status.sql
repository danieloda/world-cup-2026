-- ============================================================
-- Migration 039: Estado de jogo anulado/adiado (achado M5)
-- ============================================================
-- Antes só existia `finished boolean` → não havia como representar jogo anulado
-- (não pontua) nem adiado. Adicionamos `status` como FLAG DE OVERRIDE:
--   scheduled | finished | postponed → pontuam normalmente (eixo = finished)
--   void                             → ANULADO: não conta em lugar nenhum
-- Só 'void' altera pontuação (mínimo blast radius). 'postponed' é informativo;
-- adiar de fato = mudar match_date (o deadline acompanha via prediction_deadline).
--
-- KEEP IN SYNC: scripts/e2e/05-audit.js (filtra void no agregado).

-- ============================================================
-- 1) Coluna status
-- ============================================================
alter table public.matches
  add column if not exists status text not null default 'scheduled';

alter table public.matches
  drop constraint if exists matches_status_domain;
alter table public.matches
  add constraint matches_status_domain check (
    status in ('scheduled', 'finished', 'void', 'postponed')
  );

-- ============================================================
-- 2) Excluir 'void' da pontuação (recompute + bônus + views)
-- ============================================================
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
    and m.status <> 'void'                       -- anulado não pontua
    and (p_match_id is null or p.match_id = p_match_id);
end $$;

create or replace function public.scorer_bonus_for(p_user_id uuid)
returns int language sql stable as $$
  select coalesce(sum(
    pg.goals * 2 * public.stage_multiplier(m.stage)
  )::int, 0)
  from public.top_scorer_picks tsp
  join public.player_goals pg on pg.player_id = tsp.player_id
  join public.matches m on m.id = pg.match_id and m.finished = true and m.status <> 'void'
  where tsp.user_id = p_user_id;
$$;

create or replace function public.champion_bonus_for(p_user_id uuid)
returns int language sql stable as $$
  select coalesce((
    with final_match as (
      select team_home, team_away, actual_home, actual_away, pen_winner, finished
      from public.matches where stage = 'final' and status <> 'void' limit 1
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
revoke execute on function public.scorer_bonus_for(uuid)   from public, anon, authenticated;
revoke execute on function public.champion_bonus_for(uuid) from public, anon, authenticated;

-- v_scorer_ranking exclui void
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
left join public.matches m on m.id = pg.match_id and m.finished = true and m.status <> 'void'
where p.paid = true and pl.id is not null
group by p.id, p.full_name, pl.full_name, pl.team
order by goals desc nulls last, p.full_name;
grant select on public.v_scorer_ranking to authenticated;

-- v_leaderboard: reproduz a 037 (sem email) + exclui void
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
grant select on public.v_leaderboard to authenticated;

-- ============================================================
-- 3) admin_set_match_status(match_id, status) — atômico, admin-only
-- ============================================================
create or replace function public.admin_set_match_status(p_match_id int, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_set_match_status: caller is not admin (RLS guard)';
  end if;
  if p_status not in ('scheduled', 'finished', 'void', 'postponed') then
    raise exception 'admin_set_match_status: status inválido %', p_status;
  end if;

  update public.matches set status = p_status where id = p_match_id;

  if p_status = 'void' then
    -- anulado: zera os pontos do jogo (não conta no ranking)
    update public.predictions set points_earned = null where match_id = p_match_id;
  else
    -- reativado: re-pontua se já estava finalizado (definer → pode chamar recompute)
    perform public.recompute_prediction_points(p_match_id);
  end if;
  perform public.recompute_qualifier_points(null);
end $$;

grant execute on function public.admin_set_match_status(int, text) to authenticated;

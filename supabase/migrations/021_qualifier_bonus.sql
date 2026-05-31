-- ============================================================
-- Migration 021: Bônus de seleção classificada (BPE / BP)
-- ============================================================
-- Premia o apostador por acertar QUAL seleção chega a cada vaga do mata-mata,
-- ADITIVO sobre placar + campeão + artilheiro (NÃO altera score_prediction).
--
--   BPE (Bônus Posição Exata): time previsto == time real NAQUELA vaga.
--   BP  (Bônus na fase, vaga errada): time previsto chegou à fase, em outra vaga (= metade do BPE).
--   Cumulativo por fase. Fases: r32, r16, qf, sf, third, final.
--
-- Escala "Equilibrada" (calibrada por simulação ~14% do total): o bônus do
-- mata-mata é sorte por natureza, então fica modesto e o placar segue decidindo.
--
-- ARQUITETURA: o bracket PREVISTO de cada usuário é computado em SQL
-- (compute_predicted_slots), espelhando resolve_match_slots (015) mas lendo
-- predictions. NÃO toca em resolve_match_slots. Resultado é cacheado em
-- user_qualifier_points e recomputado por trigger quando jogos resolvem.
-- v_leaderboard só LÊ o cache.
--
-- KEEP IN SYNC: js/scoring.js (qualifierBonus). Desempate usa public.fifa_rank()
-- idêntico a 015 / util.js (consistência crítica).

-- ============================================================
-- A) Lookup de pontos — fonte única dos valores
-- ============================================================
create or replace function public.qualifier_bonus_pts(p_phase text, p_exact boolean)
returns numeric language sql immutable as $$
  with b as (
    select case p_phase
      when 'r32'   then 1
      when 'r16'   then 2
      when 'qf'    then 3
      when 'sf'    then 4
      when 'third' then 3
      when 'final' then 6
      else 0
    end as bpe
  )
  select case
    when p_exact        then bpe::numeric
    when p_phase = 'r32' then 0          -- sem BP nos 32-avos (piso de sorte)
    else round(bpe / 2.0)
  end
  from b;
$$;

-- ============================================================
-- B') Backtracking dos 3ºs para o bracket PREVISTO
-- ============================================================
-- Cópia de _backtrack_thirds (015) lendo temp tables PRÓPRIAS (_pred_*),
-- pra nunca colidir com resolve_match_slots na mesma transação (Risco R1).
create or replace function public._backtrack_thirds_pred(
  p_idx int, p_max int, p_assignment jsonb, p_used text[]
) returns jsonb language plpgsql as $$
declare
  v_slot   record;
  v_third  record;
  v_result jsonb;
begin
  if p_idx > p_max then return p_assignment; end if;

  select valid_groups into v_slot from _pred_composite_slots where idx = p_idx;

  for v_third in
    select team, group_name from _pred_qualified_thirds order by rank_among_thirds
  loop
    if v_third.team = any(p_used) then continue; end if;
    if not (v_third.group_name = any(v_slot.valid_groups)) then continue; end if;

    v_result := public._backtrack_thirds_pred(
      p_idx + 1, p_max,
      p_assignment || jsonb_build_object(p_idx::text, v_third.team),
      array_append(p_used, v_third.team)
    );
    if v_result is not null then return v_result; end if;
  end loop;

  return null;
end $$;

-- ============================================================
-- B) Bracket previsto do usuário: retorna (slot -> team)
-- ============================================================
-- Espelha resolve_match_slots (015) mas lê predictions e RETORNA, não escreve.
-- VOLATILE: cria temp tables (side-effect de sessão) e deve reavaliar por usuário.
create or replace function public.compute_predicted_slots(p_user_id uuid)
returns table(slot text, team text)
language plpgsql security definer volatile as $$
#variable_conflict use_column
declare
  rec        record;
  n_slots    int;
  v_solution jsonb;
  v_team     text;
  ph int; pa int; ppen text;
  home_t text; away_t text; winner text; loser text;
  pass_count int;
  total_new  int;
  ins_count  int;
begin
  create temp table if not exists _pred_slots (slot text primary key, team text not null) on commit drop;
  create temp table if not exists _pred_group_standings (group_name text, team text, pos int, tp int, gd int, gff int) on commit drop;
  create temp table if not exists _pred_qualified_thirds (group_name text primary key, team text not null, rank_among_thirds int) on commit drop;
  create temp table if not exists _pred_composite_slots (idx int primary key, slot text not null, valid_groups text[]) on commit drop;
  truncate _pred_slots; truncate _pred_group_standings; truncate _pred_qualified_thirds; truncate _pred_composite_slots;

  -- ===== Step 1: standings previstas (só grupos 100% palpitados) =====
  insert into _pred_group_standings (group_name, team, pos, tp, gd, gff)
  with fully_pred_groups as (
    select m.group_name
    from public.matches m
    join public.predictions p on p.match_id = m.id and p.user_id = p_user_id
    where m.stage = 'group' and m.group_name is not null
    group by m.group_name
    having count(*) = (
      select count(*) from public.matches mm
      where mm.stage = 'group' and mm.group_name = m.group_name
    )
  ),
  team_rows as (
    select m.group_name as gname, m.team_home as team,
           case when p.pred_home > p.pred_away then 3 when p.pred_home = p.pred_away then 1 else 0 end as pts,
           p.pred_home as gf, p.pred_away as ga
    from public.matches m
    join public.predictions p on p.match_id = m.id and p.user_id = p_user_id
    where m.stage = 'group' and m.group_name in (select group_name from fully_pred_groups)
    union all
    select m.group_name, m.team_away,
           case when p.pred_away > p.pred_home then 3 when p.pred_home = p.pred_away then 1 else 0 end,
           p.pred_away, p.pred_home
    from public.matches m
    join public.predictions p on p.match_id = m.id and p.user_id = p_user_id
    where m.stage = 'group' and m.group_name in (select group_name from fully_pred_groups)
  )
  select gname, team,
         row_number() over (partition by gname
           order by sum(pts) desc, sum(gf) - sum(ga) desc, sum(gf) desc, public.fifa_rank(team) asc),
         sum(pts), sum(gf) - sum(ga), sum(gf)
  from team_rows group by gname, team;

  -- Slots de grupo 1X / 2X / 3X
  insert into _pred_slots (slot, team)
  select (case pos when 1 then '1' when 2 then '2' when 3 then '3' end) || group_name, team
  from _pred_group_standings where pos <= 3
  on conflict (slot) do nothing;

  -- ===== Step 2: 3ºs compostos (3A/B/C...) via backtracking =====
  insert into _pred_qualified_thirds (group_name, team, rank_among_thirds)
  select group_name, team, rk from (
    select group_name, team,
           row_number() over (order by tp desc, gd desc, gff desc, public.fifa_rank(team) asc) as rk
    from _pred_group_standings where pos = 3
  ) x where rk <= 8;

  -- ORDEM idêntica ao resolve_match_slots real (015): row_number() over (order by mid, side).
  -- O backtracking processa os slots nessa ordem; ordem diferente → atribuição diferente
  -- quando há múltiplas soluções válidas. Precisa bater com o path real pra o bracket
  -- previsto == real quando os palpites == resultados.
  insert into _pred_composite_slots (idx, slot, valid_groups)
  select row_number() over (order by mid, side), slot, string_to_array(substring(slot from 2), '/')
  from (
    select id as mid, slot_home as slot, 'home' as side
    from public.matches where slot_home like '3%/%' and stage <> 'group'
    union all
    select id as mid, slot_away as slot, 'away' as side
    from public.matches where slot_away like '3%/%' and stage <> 'group'
  ) s;

  select count(*) into n_slots from _pred_composite_slots;
  if n_slots > 0 and (select count(*) from _pred_qualified_thirds) >= n_slots then
    v_solution := public._backtrack_thirds_pred(1, n_slots, '{}'::jsonb, array[]::text[]);
    if v_solution is not null then
      for rec in select idx, slot from _pred_composite_slots loop
        v_team := v_solution ->> rec.idx::text;
        if v_team is not null then
          insert into _pred_slots (slot, team) values (rec.slot, v_team) on conflict (slot) do nothing;
        end if;
      end loop;
    end if;
  end if;

  -- ===== Step 3: W### / L### multi-pass (vencedor/perdedor pelo palpite) =====
  pass_count := 0;
  loop
    pass_count := pass_count + 1;
    total_new := 0;

    for rec in
      select id, slot_home, slot_away from public.matches
      where stage <> 'group' order by id
    loop
      select team into home_t from _pred_slots where slot = rec.slot_home;
      select team into away_t from _pred_slots where slot = rec.slot_away;
      if home_t is null or away_t is null then continue; end if;

      select pred_home, pred_away, pred_pen_winner into ph, pa, ppen
      from public.predictions where user_id = p_user_id and match_id = rec.id;
      if not found or ph is null or pa is null then continue; end if;

      if    ph > pa          then winner := home_t; loser := away_t;
      elsif pa > ph          then winner := away_t; loser := home_t;
      elsif ppen = 'home'    then winner := home_t; loser := away_t;
      elsif ppen = 'away'    then winner := away_t; loser := home_t;
      else  continue; end if;

      insert into _pred_slots (slot, team) values ('W' || rec.id, winner) on conflict (slot) do nothing;
      get diagnostics ins_count = row_count; total_new := total_new + ins_count;
      insert into _pred_slots (slot, team) values ('L' || rec.id, loser) on conflict (slot) do nothing;
      get diagnostics ins_count = row_count; total_new := total_new + ins_count;
    end loop;

    exit when total_new = 0 or pass_count >= 10;
  end loop;

  return query select s.slot, s.team from _pred_slots s;
end $$;

-- ============================================================
-- C) Bônus por usuário: compara bracket previsto x real
-- ============================================================
create or replace function public.qualifier_bonus_for(p_user_id uuid)
returns table(points int, breakdown jsonb)
language plpgsql security definer volatile as $$
declare
  rec     record;
  v_pred  text;
  v_pts   int;
  v_kind  text;
  v_total int := 0;
  v_items jsonb := '[]'::jsonb;
begin
  create temp table if not exists _qbf_pred (slot text primary key, team text) on commit drop;
  create temp table if not exists _qbf_phase_teams (phase text, team text) on commit drop;
  truncate _qbf_pred; truncate _qbf_phase_teams;

  insert into _qbf_pred select slot, team from public.compute_predicted_slots(p_user_id)
  on conflict (slot) do nothing;

  -- times REAIS já resolvidos por fase
  insert into _qbf_phase_teams
  select distinct m.stage, t.team
  from public.matches m, lateral (values (m.team_home), (m.team_away)) t(team)
  where m.stage in ('r32','r16','qf','sf','third','final')
    and t.team !~ '^[0-9LW]' and t.team not like '%/%';

  for rec in
    select m.id, m.stage, sd.side,
           case sd.side when 'home' then m.team_home else m.team_away end as actual_team,
           case sd.side when 'home' then coalesce(m.slot_home, m.team_home)
                                    else coalesce(m.slot_away, m.team_away) end as slot_ref
    from public.matches m, (values ('home'), ('away')) sd(side)
    where m.stage in ('r32','r16','qf','sf','third','final')
  loop
    -- vaga ainda não resolvida (time real) → pula
    if rec.actual_team is null or rec.actual_team ~ '^[0-9LW]' or rec.actual_team like '%/%' then continue; end if;

    select team into v_pred from _qbf_pred where slot = rec.slot_ref;
    if v_pred is null then continue; end if;

    if v_pred = rec.actual_team then
      v_pts := round(public.qualifier_bonus_pts(rec.stage, true))::int;  v_kind := 'bpe';
    elsif exists (select 1 from _qbf_phase_teams pt where pt.phase = rec.stage and pt.team = v_pred) then
      v_pts := round(public.qualifier_bonus_pts(rec.stage, false))::int; v_kind := 'bp';
    else
      continue;
    end if;

    if v_pts <= 0 then continue; end if;
    v_total := v_total + v_pts;
    v_items := v_items || jsonb_build_object(
      'match_id', rec.id, 'side', rec.side, 'slot', rec.slot_ref,
      'pred', v_pred, 'actual', rec.actual_team, 'phase', rec.stage,
      'kind', v_kind, 'pts', v_pts);
  end loop;

  points := v_total;
  breakdown := jsonb_build_object('total', v_total, 'items', v_items);
  return next;
end $$;

-- ============================================================
-- D) Cache + RLS
-- ============================================================
create table if not exists public.user_qualifier_points (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  points     int not null default 0,
  breakdown  jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_qualifier_points enable row level security;
drop policy if exists "uqp_select_all" on public.user_qualifier_points;
create policy "uqp_select_all"
  on public.user_qualifier_points for select
  to authenticated using (true);
-- sem policy de escrita: só via funções security definer.

grant select on public.user_qualifier_points to authenticated;

-- ============================================================
-- E) Recompute (espelha recompute_prediction_points)
-- ============================================================
create or replace function public.recompute_qualifier_points(p_user_id uuid default null)
returns void language plpgsql security definer as $$
begin
  insert into public.user_qualifier_points (user_id, points, breakdown, updated_at)
  select pr.id, q.points, q.breakdown, now()
  from public.profiles pr
  cross join lateral public.qualifier_bonus_for(pr.id) q
  where (p_user_id is null or pr.id = p_user_id)
    and pr.paid = true
  on conflict (user_id) do update
    set points = excluded.points, breakdown = excluded.breakdown, updated_at = now();
end $$;

-- ============================================================
-- F) Trigger — roda APÓS trg_resolve_slots e ANTES de trg_z_alert_*
-- ============================================================
-- Ordem alfabética dos triggers de matches:
--   trg_match_finished < trg_resolve_slots < trg_s_qualifier_bonus < trg_z_alert_*
-- O nome trg_s_... é ESSENCIAL: precisa ler as vagas já resolvidas (Risco R4).
create or replace function public.trigger_qualifier_bonus()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (
       old.finished    is distinct from new.finished
    or old.actual_home is distinct from new.actual_home
    or old.actual_away is distinct from new.actual_away
    or old.pen_winner  is distinct from new.pen_winner
  ) then
    perform public.recompute_qualifier_points(null);
  end if;
  return new;
end $$;

drop trigger if exists trg_s_qualifier_bonus on public.matches;
create trigger trg_s_qualifier_bonus
  after update on public.matches
  for each row execute function public.trigger_qualifier_bonus();

-- ============================================================
-- G) v_leaderboard — adiciona qualifier_pts e soma no total
-- ============================================================
drop view if exists public.v_leaderboard;
create view public.v_leaderboard as
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
-- H) Grants
-- ============================================================
grant execute on function public.qualifier_bonus_pts(text, boolean) to authenticated;
grant execute on function public.compute_predicted_slots(uuid) to authenticated;
grant execute on function public.qualifier_bonus_for(uuid) to authenticated;
grant execute on function public._backtrack_thirds_pred(int, int, jsonb, text[]) to authenticated;
-- recompute_qualifier_points: NÃO exposto a authenticated (só trigger/admin via service role).

-- ============================================================
-- I) Backfill inicial
-- ============================================================
select public.recompute_qualifier_points();

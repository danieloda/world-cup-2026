-- ============================================================
-- Bolão Copa 2026 — Classificação PREVISTA com confronto direto (igual à real)
-- ============================================================
-- A classificação REAL dos grupos usa o desempate oficial recursivo (confronto
-- direto re-aplicado → SG → GF → fair play → FIFA), via public.rank_group /
-- _resolve_tied (migrations 068/069). Mas a classificação PREVISTA de cada
-- usuário (compute_predicted_slots, mig 021/072) ainda ordenava só por saldo
-- simples. Como o bônus de classificado compara o bracket previsto com o real,
-- isso pontuava errado quem palpitou um grupo decidido por confronto direto.
-- (Medido em 28/jun/2026: 11 de 77 usuários com qualifier_pts errado.)
--
-- FIX: espelha 069 para o lado PREVISTO — funções *_pred que leem
-- predictions em vez de matches.actual_*, e rank_group_pred recursivo.
-- compute_predicted_slots passa a montar as standings com rank_group_pred.
-- (Fair play é impalpável — usuários não palpitam cartões — então o lado
-- previsto não tem esse critério; cai direto para o ranking FIFA, igual ao
-- cliente src/js/util.js.) No fim, recompute_qualifier_points() atualiza todos.
--
-- KEEP IN SYNC: src/js/util.js (resolveTiedOnPoints), public.rank_group (069).

-- ------------------------------------------------------------
-- Estatísticas do confronto direto PREVISTO (só jogos entre p_teams).
-- ------------------------------------------------------------
create or replace function public._h2h_stats_pred(p_user_id uuid, p_group text, p_teams text[])
returns table(team text, h2h_pts int, h2h_sg int, h2h_gf int)
language sql stable as $$
  select tt.team,
         coalesce(sum(x.pts), 0)::int            as h2h_pts,
         coalesce(sum(x.gf) - sum(x.ga), 0)::int as h2h_sg,
         coalesce(sum(x.gf), 0)::int             as h2h_gf
  from unnest(p_teams) tt(team)
  left join lateral (
    select case when m.team_home = tt.team
                then case when p.pred_home > p.pred_away then 3 when p.pred_home = p.pred_away then 1 else 0 end
                else case when p.pred_away > p.pred_home then 3 when p.pred_home = p.pred_away then 1 else 0 end end as pts,
           case when m.team_home = tt.team then p.pred_home else p.pred_away end as gf,
           case when m.team_home = tt.team then p.pred_away else p.pred_home end as ga
    from public.matches m
    join public.predictions p on p.match_id = m.id and p.user_id = p_user_id
    where m.group_name = p_group and m.stage = 'group'
      and m.team_home = any(p_teams) and m.team_away = any(p_teams)
      and (m.team_home = tt.team or m.team_away = tt.team)
  ) x on true
  group by tt.team
$$;

-- ------------------------------------------------------------
-- Estatísticas GERAIS PREVISTAS (todos os jogos do time no grupo).
-- fair play não é palpitável → 0 (cai para ranking FIFA, igual ao cliente).
-- ------------------------------------------------------------
create or replace function public._overall_stats_pred(p_user_id uuid, p_group text, p_teams text[])
returns table(team text, gd int, gf_total int, fairplay int)
language sql stable as $$
  select tt.team,
         coalesce(sum(x.gf) - sum(x.ga), 0)::int as gd,
         coalesce(sum(x.gf), 0)::int             as gf_total,
         0::int                                  as fairplay
  from unnest(p_teams) tt(team)
  left join lateral (
    select case when m.team_home = tt.team then p.pred_home else p.pred_away end as gf,
           case when m.team_home = tt.team then p.pred_away else p.pred_home end as ga
    from public.matches m
    join public.predictions p on p.match_id = m.id and p.user_id = p_user_id
    where m.group_name = p_group and m.stage = 'group'
      and (m.team_home = tt.team or m.team_away = tt.team)
  ) x on true
  group by tt.team
$$;

-- ------------------------------------------------------------
-- _resolve_tied_pred: confronto direto recursivo (espelha 069._resolve_tied).
-- ------------------------------------------------------------
create or replace function public._resolve_tied_pred(p_user_id uuid, p_group text, p_teams text[])
returns text[]
language plpgsql stable as $$
declare
  v_n      int := coalesce(array_length(p_teams, 1), 0);
  v_keys   int;
  v_out    text[] := '{}';
  v_block  text[] := '{}';
  v_curkey text := null;
  r record;
begin
  if v_n <= 1 then return p_teams; end if;

  select count(distinct (h.h2h_pts, h.h2h_sg, h.h2h_gf)) into v_keys
  from public._h2h_stats_pred(p_user_id, p_group, p_teams) h;

  if v_keys <= 1 then
    select array_agg(o.team order by o.gd desc, o.gf_total desc, o.fairplay desc, public.fifa_rank(o.team) asc)
      into v_out
    from public._overall_stats_pred(p_user_id, p_group, p_teams) o;
    return v_out;
  end if;

  for r in
    select h.team, (h.h2h_pts || '|' || h.h2h_sg || '|' || h.h2h_gf) as k
    from public._h2h_stats_pred(p_user_id, p_group, p_teams) h
    order by h.h2h_pts desc, h.h2h_sg desc, h.h2h_gf desc, h.team
  loop
    if v_curkey is null or r.k = v_curkey then
      v_block := v_block || r.team;
    else
      if coalesce(array_length(v_block, 1), 0) > 1
        then v_out := v_out || public._resolve_tied_pred(p_user_id, p_group, v_block);
        else v_out := v_out || v_block; end if;
      v_block := array[r.team];
    end if;
    v_curkey := r.k;
  end loop;
  if coalesce(array_length(v_block, 1), 0) > 1
    then v_out := v_out || public._resolve_tied_pred(p_user_id, p_group, v_block);
    else v_out := v_out || v_block; end if;

  return v_out;
end;
$$;

-- ------------------------------------------------------------
-- rank_group_pred: classificação prevista de UM grupo (só se 100% palpitado).
-- ------------------------------------------------------------
create or replace function public.rank_group_pred(p_user_id uuid, p_group text)
returns table(team text, pos int, tp int, gd int, gf int)
language plpgsql stable as $$
declare
  v_order text[] := '{}';
  v_total int;
  v_pred  int;
  r record;
begin
  -- grupo precisa estar 100% palpitado por este usuário
  select count(*) into v_total from public.matches where group_name = p_group and stage = 'group';
  select count(*) into v_pred from public.matches m
    join public.predictions p on p.match_id = m.id and p.user_id = p_user_id
    where m.group_name = p_group and m.stage = 'group';
  if v_pred < v_total or v_total = 0 then return; end if;

  -- resolve cada bloco de pontos (desc) pelo confronto direto recursivo
  for r in
    select b.total_pts as pts, array_agg(b.team order by b.team) as teams
    from (
      select t.team, sum(t.pts) as total_pts
      from (
        select m.team_home as team,
               case when p.pred_home > p.pred_away then 3 when p.pred_home = p.pred_away then 1 else 0 end as pts
        from public.matches m join public.predictions p on p.match_id = m.id and p.user_id = p_user_id
        where m.group_name = p_group and m.stage = 'group'
        union all
        select m.team_away,
               case when p.pred_away > p.pred_home then 3 when p.pred_home = p.pred_away then 1 else 0 end
        from public.matches m join public.predictions p on p.match_id = m.id and p.user_id = p_user_id
        where m.group_name = p_group and m.stage = 'group'
      ) t group by t.team
    ) b
    group by b.total_pts
    order by b.total_pts desc
  loop
    v_order := v_order || public._resolve_tied_pred(p_user_id, p_group, r.teams);
  end loop;

  return query
  select x.team,
         array_position(v_order, x.team)::int as pos,
         x.tp::int, x.gd::int, x.gf::int
  from (
    select t.team, sum(t.pts) as tp, sum(t.gf) - sum(t.ga) as gd, sum(t.gf) as gf
    from (
      select m.team_home as team,
             case when p.pred_home > p.pred_away then 3 when p.pred_home = p.pred_away then 1 else 0 end as pts,
             p.pred_home as gf, p.pred_away as ga
      from public.matches m join public.predictions p on p.match_id = m.id and p.user_id = p_user_id
      where m.group_name = p_group and m.stage = 'group'
      union all
      select m.team_away,
             case when p.pred_away > p.pred_home then 3 when p.pred_home = p.pred_away then 1 else 0 end,
             p.pred_away, p.pred_home
      from public.matches m join public.predictions p on p.match_id = m.id and p.user_id = p_user_id
      where m.group_name = p_group and m.stage = 'group'
    ) t group by t.team
  ) x
  order by array_position(v_order, x.team);
end;
$$;

-- ------------------------------------------------------------
-- compute_predicted_slots: Step 1 agora via rank_group_pred (Steps 2/3 = 072).
-- ------------------------------------------------------------
create or replace function public.compute_predicted_slots(p_user_id uuid)
returns table(slot text, team text)
language plpgsql security definer volatile as $$
#variable_conflict use_column
declare
  rec        record;
  n_slots    int;
  v_solution jsonb;
  v_team     text;
  v_combo    text;
  v_assign   jsonb;
  v_seed     text;
  v_group    text;
  ph int; pa int; ppen text;
  home_t text; away_t text; winner text; loser text;
  pass_count int;
  total_new  int;
  ins_count  int;
begin
  create temp table if not exists _pred_slots (slot text primary key, team text not null) on commit drop;
  create temp table if not exists _pred_group_standings (group_name text, team text, pos int, tp int, gd int, gff int) on commit drop;
  create temp table if not exists _pred_qualified_thirds (group_name text primary key, team text not null, rank_among_thirds int) on commit drop;
  create temp table if not exists _pred_composite_slots (idx int primary key, mid int, side text, slot text not null, valid_groups text[]) on commit drop;
  truncate _pred_slots; truncate _pred_group_standings; truncate _pred_qualified_thirds; truncate _pred_composite_slots;

  -- ===== Step 1: standings previstas (confronto direto recursivo, só grupos 100% palpitados) =====
  insert into _pred_group_standings (group_name, team, pos, tp, gd, gff)
  select g.group_name, r.team, r.pos, r.tp, r.gd, r.gf
  from (select distinct group_name from public.matches where stage = 'group' and group_name is not null) g
  cross join lateral public.rank_group_pred(p_user_id, g.group_name) r;

  insert into _pred_slots (slot, team)
  select (case pos when 1 then '1' when 2 then '2' when 3 then '3' end) || group_name, team
  from _pred_group_standings where pos <= 3
  on conflict (slot) do nothing;

  -- ===== Step 2: 3ºs compostos via TABELA OFICIAL (Annexe C) =====
  insert into _pred_qualified_thirds (group_name, team, rank_among_thirds)
  select group_name, team, rk from (
    select group_name, team,
           row_number() over (order by tp desc, gd desc, gff desc, public.fifa_rank(team) asc) as rk
    from _pred_group_standings where pos = 3
  ) x where rk <= 8;

  insert into _pred_composite_slots (idx, mid, side, slot, valid_groups)
  select row_number() over (order by mid, side), mid, side, slot, string_to_array(substring(slot from 2), '/')
  from (
    select id as mid, slot_home as slot, 'home' as side
    from public.matches where slot_home like '3%/%' and stage <> 'group'
    union all
    select id as mid, slot_away as slot, 'away' as side
    from public.matches where slot_away like '3%/%' and stage <> 'group'
  ) s;

  select count(*) into n_slots from _pred_composite_slots;
  if n_slots > 0 and (select count(*) from _pred_qualified_thirds) >= n_slots then
    select string_agg(group_name, '' order by group_name) into v_combo from _pred_qualified_thirds;
    select assignments into v_assign from public.third_place_allocation where combo = v_combo;

    if v_assign is not null then
      for rec in select idx, mid, side, slot from _pred_composite_slots loop
        if rec.side = 'home' then
          select slot_away into v_seed from public.matches where id = rec.mid;
        else
          select slot_home into v_seed from public.matches where id = rec.mid;
        end if;
        v_group := v_assign ->> v_seed;
        if v_group is null then continue; end if;
        select team into v_team from _pred_qualified_thirds where group_name = v_group;
        if v_team is not null then
          insert into _pred_slots (slot, team) values (rec.slot, v_team) on conflict (slot) do nothing;
        end if;
      end loop;
    else
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
  end if;

  -- ===== Step 3: W### / L### multi-pass =====
  pass_count := 0;
  loop
    pass_count := pass_count + 1;
    total_new := 0;
    for rec in
      select id, slot_home, slot_away from public.matches where stage <> 'group' order by id
    loop
      select team into home_t from _pred_slots where slot = rec.slot_home;
      select team into away_t from _pred_slots where slot = rec.slot_away;
      if home_t is null or away_t is null then continue; end if;

      select pred_home, pred_away, pred_pen_winner into ph, pa, ppen
      from public.predictions where user_id = p_user_id and match_id = rec.id;
      if not found or ph is null or pa is null then continue; end if;

      if    ph > pa       then winner := home_t; loser := away_t;
      elsif pa > ph       then winner := away_t; loser := home_t;
      elsif ppen = 'home' then winner := home_t; loser := away_t;
      elsif ppen = 'away' then winner := away_t; loser := home_t;
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

grant execute on function public._h2h_stats_pred(uuid, text, text[]) to authenticated;
grant execute on function public._overall_stats_pred(uuid, text, text[]) to authenticated;
grant execute on function public._resolve_tied_pred(uuid, text, text[]) to authenticated;
grant execute on function public.rank_group_pred(uuid, text) to authenticated;

-- Recomputa o bônus de classificado de todos com a classificação prevista correta.
select public.recompute_qualifier_points();

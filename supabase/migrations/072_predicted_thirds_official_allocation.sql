-- ============================================================
-- Bolão Copa 2026 — Bracket PREVISTO também pela tabela oficial (Annexe C)
-- ============================================================
-- A 071 corrigiu o bracket REAL (try_assign_thirds → tabela oficial). Mas o
-- bônus de classificado (021) compara o bracket real com o bracket PREVISTO de
-- cada usuário, e o previsto ainda era montado por BACKTRACKING
-- (compute_predicted_slots → _backtrack_thirds_pred). Com um lado oficial e o
-- outro por backtracking, a invariante "palpite perfeito → BPE cheio" quebra:
-- usuários que acertaram o 3º perdiam o BPE por ele cair num slot não-oficial.
-- (Medido em 28/jun/2026: 47 de 77 usuários com qualifier_pts errado.)
--
-- FIX: compute_predicted_slots passa a usar public.third_place_allocation
-- (mesma tabela da 071). O 1-seed de cada slot composto é o slot do lado
-- OPOSTO do mesmo jogo. Mantém _backtrack_thirds_pred como fallback defensivo.
-- No fim, recompute_qualifier_points() atualiza o cache de todos.

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

  -- ===== Step 2: 3ºs compostos (3A/B/C...) via TABELA OFICIAL (Annexe C) =====
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
    -- Chave da combinação dos 8 melhores 3ºs previstos.
    select string_agg(group_name, '' order by group_name) into v_combo from _pred_qualified_thirds;
    select assignments into v_assign from public.third_place_allocation where combo = v_combo;

    if v_assign is not null then
      for rec in select idx, mid, side, slot from _pred_composite_slots loop
        -- 1-seed = slot do lado OPOSTO do mesmo jogo.
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
      -- Fallback defensivo: backtracking antigo (combinação inesperada).
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

-- Recomputa o cache de bônus de classificado de todos os usuários pagos.
select public.recompute_qualifier_points();

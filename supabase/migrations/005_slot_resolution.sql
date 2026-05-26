-- ============================================================
-- Bolão Copa 2026 — Auto-resolve slots de mata-mata (CONSOLIDADO v2)
-- ============================================================
-- Versão consolidada que substitui o original + patches 011, 012, 013, 014.
-- Aplicável from-scratch em qualquer projeto Supabase novo.
--
-- Quando uma fase de grupos termina, slots como "1A", "2B" viram
-- nomes reais ("Mexico", "South Korea"). Quando um jogo de mata-mata
-- finaliza, slots "W73", "L101" viram vencedor/perdedor reais.
--
-- BUGS CORRIGIDOS (vs versão original):
--   1. resolve_match_slots Step 3 não fazia multi-pass (snapshot do for loop).
--      → FIX: loop ate total_updates = 0 (max 10 passes).
--   2. Step 2 (terceiros) usava UPDATE com sub-SELECT sem uniqueness.
--      → FIX: backtracking recursivo via _backtrack_thirds.
--   3. Greedy de terceiros falhava em casos extremos (beco sem saída).
--      → FIX: backtracking testa todas permutações até achar válida.
--
-- O trigger trg_resolve_slots roda APÓS trg_match_finished (ordem alfabética).

-- ===== 1) Colunas slot_home / slot_away =====
alter table public.matches
  add column if not exists slot_home text,
  add column if not exists slot_away text;

-- Backfill: copia team_home/away para slot_home/away quando ainda for slot
update public.matches
  set slot_home = team_home
  where slot_home is null
    and (team_home ~ '^[0-9LW]' or team_home like '%/%');

update public.matches
  set slot_away = team_away
  where slot_away is null
    and (team_away ~ '^[0-9LW]' or team_away like '%/%');

-- ===== 2) Função recursiva: _backtrack_thirds =====
-- Tenta atribuir slots compostos (3A/B/C/D/F) a terceiros qualificados.
-- Recebe p_idx (slot atual), p_max (total slots), assignment, used.
-- Retorna jsonb mapping slot_idx → team_name, ou NULL se nenhum válido.
create or replace function public._backtrack_thirds(
  p_idx int,
  p_max int,
  p_assignment jsonb,
  p_used text[]
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_slot record;
  v_third record;
  v_new_assignment jsonb;
  v_new_used text[];
  v_result jsonb;
begin
  if p_idx > p_max then return p_assignment; end if;

  select valid_groups into v_slot from _composite_slots where idx = p_idx;

  for v_third in
    select team, group_name from _qualified_thirds
    order by rank_among_thirds
  loop
    if v_third.team = any(p_used) then continue; end if;
    if not (v_third.group_name = any(v_slot.valid_groups)) then continue; end if;

    v_new_assignment := p_assignment || jsonb_build_object(p_idx::text, v_third.team);
    v_new_used := array_append(p_used, v_third.team);

    v_result := public._backtrack_thirds(p_idx + 1, p_max, v_new_assignment, v_new_used);
    if v_result is not null then return v_result; end if;
  end loop;

  return null;
end;
$$;

-- ===== 3) Função helper: try_assign_thirds =====
-- Le _qualified_thirds e _composite_slots (temp tables criadas pelo caller),
-- chama backtracking, e aplica solucao no DB.
create or replace function public.try_assign_thirds()
returns boolean
language plpgsql
security definer
as $$
declare
  n_slots int;
  v_solution jsonb;
  v_slot record;
  v_team text;
begin
  select count(*) into n_slots from _composite_slots;
  if n_slots = 0 then return true; end if;

  v_solution := public._backtrack_thirds(1, n_slots, '{}'::jsonb, ARRAY[]::text[]);
  if v_solution is null then
    raise warning '[try_assign_thirds] BACKTRACKING FALHOU — nenhuma atribuição válida';
    return false;
  end if;

  for v_slot in select idx, match_id, side from _composite_slots order by idx loop
    v_team := v_solution ->> v_slot.idx::text;
    if v_team is not null then
      if v_slot.side = 'home' then
        update public.matches set team_home = v_team where id = v_slot.match_id;
      else
        update public.matches set team_away = v_team where id = v_slot.match_id;
      end if;
    end if;
  end loop;

  return true;
end;
$$;

-- ===== 4) Função principal: resolve_match_slots =====
create or replace function public.resolve_match_slots()
returns void
language plpgsql
security definer
as $$
declare
  group_letter text;
  first_team   text;
  second_team  text;
  rec          record;
  winner       text;
  loser        text;
  updated_count int;
  pass_count int;
  total_updates int;
begin
  -- ===== Step 0: reset team_home/away para o slot original (idempotência) =====
  update public.matches
     set team_home = slot_home
   where slot_home is not null
     and team_home <> slot_home;
  update public.matches
     set team_away = slot_away
   where slot_away is not null
     and team_away <> slot_away;

  -- ===== Step 1: resolver 1X e 2X (grupos completos) =====
  for group_letter in
    select distinct group_name from public.matches where group_name is not null
  loop
    if (select count(*) from public.matches where group_name = group_letter and stage = 'group')
       = (select count(*) from public.matches where group_name = group_letter and stage = 'group' and finished = true)
    then
      with team_rows as (
        select team_home as team,
               case when actual_home > actual_away then 3
                    when actual_home = actual_away then 1
                    else 0 end as pts,
               actual_home as gf,
               actual_away as ga
        from public.matches
        where group_name = group_letter and stage = 'group' and finished = true
        union all
        select team_away as team,
               case when actual_away > actual_home then 3
                    when actual_home = actual_away then 1
                    else 0 end as pts,
               actual_away as gf,
               actual_home as ga
        from public.matches
        where group_name = group_letter and stage = 'group' and finished = true
      ),
      standings as (
        select team,
               sum(pts) as total_pts,
               sum(gf) - sum(ga) as gd,
               sum(gf) as gf_total,
               row_number() over (order by sum(pts) desc, sum(gf) - sum(ga) desc, sum(gf) desc) as pos
        from team_rows
        group by team
      )
      select (select team from standings where pos = 1), (select team from standings where pos = 2)
      into first_team, second_team;

      update public.matches set team_home = first_team where slot_home = '1' || group_letter;
      update public.matches set team_away = first_team where slot_away = '1' || group_letter;
      update public.matches set team_home = second_team where slot_home = '2' || group_letter;
      update public.matches set team_away = second_team where slot_away = '2' || group_letter;
    end if;
  end loop;

  -- ===== Step 2: resolver terceiros qualificados (8 melhores) com BACKTRACKING =====
  if (select count(distinct group_name) from public.matches where stage = 'group' and finished = true) = 12
     and (select count(*) from public.matches where stage = 'group' and finished = false) = 0
  then
    -- Cria temp tables
    create temp table if not exists _qualified_thirds (
      group_name text primary key,
      team text not null,
      rank_among_thirds int
    ) on commit drop;
    truncate _qualified_thirds;

    insert into _qualified_thirds (group_name, team, rank_among_thirds)
    with all_team_rows as (
      select mat.group_name, team_home as team,
             case when actual_home > actual_away then 3 when actual_home = actual_away then 1 else 0 end as pts,
             actual_home as gf, actual_away as ga
      from public.matches mat where stage = 'group' and finished = true
      union all
      select mat.group_name, team_away as team,
             case when actual_away > actual_home then 3 when actual_home = actual_away then 1 else 0 end as pts,
             actual_away as gf, actual_home as ga
      from public.matches mat where stage = 'group' and finished = true
    ),
    group_standings as (
      select group_name, team, sum(pts) as total_pts, sum(gf) - sum(ga) as gd, sum(gf) as gf_total,
             row_number() over (partition by group_name order by sum(pts) desc, sum(gf) - sum(ga) desc, sum(gf) desc) as pos
      from all_team_rows group by group_name, team
    ),
    third_placed as (
      select group_name, team, total_pts, gd, gf_total,
             row_number() over (order by total_pts desc, gd desc, gf_total desc, group_name) as rank_among_thirds
      from group_standings where pos = 3
    )
    select group_name, team, rank_among_thirds
    from third_placed where rank_among_thirds <= 8;

    create temp table if not exists _composite_slots (
      idx int primary key,
      match_id int not null,
      side text not null,
      slot text not null,
      valid_groups text[]
    ) on commit drop;
    truncate _composite_slots;

    insert into _composite_slots (idx, match_id, side, slot, valid_groups)
    select
      row_number() over (order by mid, side)::int as idx,
      mid, side, slot,
      string_to_array(substring(slot from 2), '/') as valid_groups
    from (
      select id as mid, slot_home as slot, 'home' as side
      from public.matches where slot_home like '3%/%' and stage <> 'group'
      union all
      select id as mid, slot_away as slot, 'away' as side
      from public.matches where slot_away like '3%/%' and stage <> 'group'
    ) s;

    -- Chama backtracking
    perform public.try_assign_thirds();
  end if;

  -- ===== Step 3: resolver W### e L### (MULTI-PASS) =====
  -- Roda múltiplas vezes até não haver mais updates (max 10 passes safety).
  pass_count := 0;
  loop
    pass_count := pass_count + 1;
    total_updates := 0;

    for rec in
      select id, team_home, team_away, actual_home, actual_away, pen_winner
      from public.matches
      where finished = true
        and stage <> 'group'
        and team_home !~ '^[0-9LW]'
        and team_away !~ '^[0-9LW]'
      order by id
    loop
      if rec.actual_home > rec.actual_away then
        winner := rec.team_home; loser := rec.team_away;
      elsif rec.actual_away > rec.actual_home then
        winner := rec.team_away; loser := rec.team_home;
      elsif rec.pen_winner = 'home' then
        winner := rec.team_home; loser := rec.team_away;
      elsif rec.pen_winner = 'away' then
        winner := rec.team_away; loser := rec.team_home;
      else
        continue;
      end if;

      update public.matches set team_home = winner
        where slot_home = 'W' || rec.id::text and team_home <> winner;
      get diagnostics updated_count = row_count;
      total_updates := total_updates + updated_count;

      update public.matches set team_away = winner
        where slot_away = 'W' || rec.id::text and team_away <> winner;
      get diagnostics updated_count = row_count;
      total_updates := total_updates + updated_count;

      update public.matches set team_home = loser
        where slot_home = 'L' || rec.id::text and team_home <> loser;
      get diagnostics updated_count = row_count;
      total_updates := total_updates + updated_count;

      update public.matches set team_away = loser
        where slot_away = 'L' || rec.id::text and team_away <> loser;
      get diagnostics updated_count = row_count;
      total_updates := total_updates + updated_count;
    end loop;

    exit when total_updates = 0 or pass_count >= 10;
  end loop;
end;
$$;

-- ===== 5) Trigger =====
-- Dispara quando finished/actual_*/pen_winner muda.
-- Roda APÓS trg_match_finished (ordem alfabética: m < r).
create or replace function public.trigger_resolve_slots()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (
       old.finished     is distinct from new.finished
    or old.actual_home  is distinct from new.actual_home
    or old.actual_away  is distinct from new.actual_away
    or old.pen_winner   is distinct from new.pen_winner
  ) then
    perform public.resolve_match_slots();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_resolve_slots on public.matches;
create trigger trg_resolve_slots
  after update on public.matches
  for each row
  execute function public.trigger_resolve_slots();

-- ===== 6) Roda uma vez agora para resolver grupos já completos =====
select public.resolve_match_slots();

-- Grants
grant execute on function public.resolve_match_slots() to authenticated;
grant execute on function public.try_assign_thirds() to authenticated;
grant execute on function public._backtrack_thirds(int, int, jsonb, text[]) to authenticated;

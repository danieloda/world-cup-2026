-- ============================================================
-- Migration 015: FIFA World Ranking como tiebreaker oficial
-- ============================================================
-- Adiciona tabela team_fifa_rank com posicao no ranking FIFA pra cada uma das
-- 48 selecoes do Mundial 2026. Usado como tiebreaker apos pts/SG/GF nas
-- standings de grupo e ranking de terceiros.
--
-- Fonte: Transfermarkt snapshot 01/abr/2026 (proximo update FIFA: 11/jun/2026)
-- URL: https://www.transfermarkt.com.br/statistik/weltrangliste
--
-- IMPORTANTE: rank menor = melhor (1 = France #1 mundo).
-- Times nao listados retornam 999 (pior posicao possivel).

create table if not exists public.team_fifa_rank (
  team text primary key,
  rank int not null check (rank > 0),
  updated_at timestamptz not null default now()
);

-- Limpa pra repopular (idempotente)
truncate table public.team_fifa_rank;

insert into public.team_fifa_rank (team, rank) values
  ('France', 1), ('Spain', 2), ('Argentina', 3), ('England', 4), ('Portugal', 5),
  ('Brazil', 6), ('Netherlands', 7), ('Morocco', 8), ('Belgium', 9), ('Germany', 10),
  ('Croatia', 11), ('Colombia', 13), ('Senegal', 14), ('Mexico', 15), ('USA', 16),
  ('Uruguay', 17), ('Japan', 18), ('Switzerland', 19), ('Iran', 21), ('Türkiye', 22),
  ('Ecuador', 23), ('Austria', 24), ('South Korea', 25), ('Australia', 27),
  ('Algeria', 28), ('Egypt', 29), ('Canada', 30), ('Norway', 31), ('Panama', 33),
  ('Ivory Coast', 34), ('Sweden', 38), ('Paraguay', 40), ('Czech Republic', 41),
  ('Scotland', 43), ('Tunisia', 44), ('DR Congo', 46), ('Uzbekistan', 50),
  ('Qatar', 55), ('Iraq', 57), ('South Africa', 60), ('Saudi Arabia', 61),
  ('Jordan', 63), ('Bosnia & Herzegovina', 65), ('Cape Verde', 69), ('Ghana', 74),
  ('Curaçao', 82), ('Haiti', 83), ('New Zealand', 85);

-- Helper function: retorna rank do time (999 se nao listado)
create or replace function public.fifa_rank(p_team text)
returns int language sql stable as $$
  select coalesce((select rank from public.team_fifa_rank where team = p_team), 999);
$$;

grant execute on function public.fifa_rank(text) to authenticated;
grant select on public.team_fifa_rank to authenticated;

-- RLS: leitura pública (autenticados). Sem write policy → admins via service role.
alter table public.team_fifa_rank enable row level security;
drop policy if exists "team_fifa_rank_select_all" on public.team_fifa_rank;
create policy "team_fifa_rank_select_all"
  on public.team_fifa_rank for select
  to authenticated
  using (true);

-- ============================================================
-- Atualiza resolve_match_slots pra usar fifa_rank como tiebreaker
-- ============================================================
-- Mudanca minima: adiciona public.fifa_rank(team) ASC apos sum(gf) DESC no
-- ORDER BY de:
--   1. Standings de grupo (linha "row_number over (order by sum(pts) desc...")
--   2. Standings per-grupo do Step 2 (partition by group_name)
--   3. Rank entre terceiros qualificados (Step 2)

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
  -- Step 0: reset
  update public.matches set team_home = slot_home where slot_home is not null and team_home <> slot_home;
  update public.matches set team_away = slot_away where slot_away is not null and team_away <> slot_away;

  -- Step 1: 1X e 2X (com FIFA rank tiebreaker)
  for group_letter in select distinct group_name from public.matches where group_name is not null loop
    if (select count(*) from public.matches where group_name = group_letter and stage = 'group')
       = (select count(*) from public.matches where group_name = group_letter and stage = 'group' and finished = true)
    then
      with team_rows as (
        select team_home as team,
               case when actual_home > actual_away then 3 when actual_home = actual_away then 1 else 0 end as pts,
               actual_home as gf, actual_away as ga
        from public.matches where group_name = group_letter and stage = 'group' and finished = true
        union all
        select team_away as team,
               case when actual_away > actual_home then 3 when actual_home = actual_away then 1 else 0 end as pts,
               actual_away as gf, actual_home as ga
        from public.matches where group_name = group_letter and stage = 'group' and finished = true
      ),
      standings as (
        select team, sum(pts) as total_pts, sum(gf) - sum(ga) as gd, sum(gf) as gf_total,
               row_number() over (
                 order by sum(pts) desc, sum(gf) - sum(ga) desc, sum(gf) desc,
                          public.fifa_rank(team) asc
               ) as pos
        from team_rows group by team
      )
      select (select team from standings where pos = 1), (select team from standings where pos = 2)
      into first_team, second_team;

      update public.matches set team_home = first_team where slot_home = '1' || group_letter;
      update public.matches set team_away = first_team where slot_away = '1' || group_letter;
      update public.matches set team_home = second_team where slot_home = '2' || group_letter;
      update public.matches set team_away = second_team where slot_away = '2' || group_letter;
    end if;
  end loop;

  -- Step 2: terceiros qualificados com backtracking (FIFA rank no ranking dos terceiros)
  if (select count(distinct group_name) from public.matches where stage = 'group' and finished = true) = 12
     and (select count(*) from public.matches where stage = 'group' and finished = false) = 0
  then
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
             row_number() over (
               partition by group_name
               order by sum(pts) desc, sum(gf) - sum(ga) desc, sum(gf) desc,
                        public.fifa_rank(team) asc
             ) as pos
      from all_team_rows group by group_name, team
    ),
    third_placed as (
      select group_name, team, total_pts, gd, gf_total,
             row_number() over (
               order by total_pts desc, gd desc, gf_total desc,
                        public.fifa_rank(team) asc
             ) as rank_among_thirds
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

    perform public.try_assign_thirds();
  end if;

  -- Step 3: W/L resolution multi-pass
  pass_count := 0;
  loop
    pass_count := pass_count + 1;
    total_updates := 0;

    for rec in
      select id, team_home, team_away, actual_home, actual_away, pen_winner
      from public.matches
      where finished = true and stage <> 'group'
        and team_home !~ '^[0-9LW]' and team_away !~ '^[0-9LW]'
      order by id
    loop
      if rec.actual_home > rec.actual_away then winner := rec.team_home; loser := rec.team_away;
      elsif rec.actual_away > rec.actual_home then winner := rec.team_away; loser := rec.team_home;
      elsif rec.pen_winner = 'home' then winner := rec.team_home; loser := rec.team_away;
      elsif rec.pen_winner = 'away' then winner := rec.team_away; loser := rec.team_home;
      else continue; end if;

      update public.matches set team_home = winner where slot_home = 'W' || rec.id::text and team_home <> winner;
      get diagnostics updated_count = row_count; total_updates := total_updates + updated_count;
      update public.matches set team_away = winner where slot_away = 'W' || rec.id::text and team_away <> winner;
      get diagnostics updated_count = row_count; total_updates := total_updates + updated_count;
      update public.matches set team_home = loser where slot_home = 'L' || rec.id::text and team_home <> loser;
      get diagnostics updated_count = row_count; total_updates := total_updates + updated_count;
      update public.matches set team_away = loser where slot_away = 'L' || rec.id::text and team_away <> loser;
      get diagnostics updated_count = row_count; total_updates := total_updates + updated_count;
    end loop;

    exit when total_updates = 0 or pass_count >= 10;
  end loop;
end;
$$;

-- Backtracking precisa ser atualizado pra usar fifa_rank tambem
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

  -- Tenta cada terceiro qualificado em ordem rank_among_thirds (que ja inclui fifa_rank)
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

-- Roda pra aplicar novo tiebreaker em quaisquer resolucoes pendentes
select public.resolve_match_slots();

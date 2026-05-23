-- ============================================================
-- Bolão Copa 2026 — Auto-resolve slots de mata-mata
-- ============================================================
-- Quando uma fase de grupos termina, slots como "1A", "2B" viram
-- nomes reais ("Mexico", "South Korea"). Quando um jogo de mata-mata
-- finaliza, slots "W73", "L101" viram vencedor/perdedor reais.
--
-- Slots tipo "3A/B/C/D/F" (terceiro melhor entre vários grupos) ficam
-- como estão — requer algoritmo FIFA completo (v2).

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

-- ===== 2) Função resolve_match_slots() =====
create or replace function public.resolve_match_slots()
returns void
language plpgsql
security definer
as $$
declare
  group_letter text;
  first_team   text;
  second_team  text;
  m            record;
  winner       text;
  loser        text;
begin
  -- Step 0: reset team_home/away para o slot original (idempotência)
  update public.matches
     set team_home = slot_home
   where slot_home is not null
     and team_home <> slot_home;
  update public.matches
     set team_away = slot_away
   where slot_away is not null
     and team_away <> slot_away;

  -- Step 1: resolver 1X e 2X para grupos completos
  for group_letter in
    select distinct group_name from public.matches where group_name is not null
  loop
    -- Só processa se todos os 6 jogos do grupo estão finalizados
    if (select count(*) from public.matches where group_name = group_letter and stage = 'group')
       = (select count(*) from public.matches where group_name = group_letter and stage = 'group' and finished = true)
    then
      -- Compute standings: cada jogo gera 2 linhas (home + away)
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
               sum(pts)        as total_pts,
               sum(gf) - sum(ga) as gd,
               sum(gf)         as gf_total
        from team_rows
        group by team
        order by total_pts desc, gd desc, gf_total desc
      )
      select team into first_team  from standings limit 1;
      select team into second_team from standings offset 1 limit 1;

      raise notice 'Grupo %: 1º = %, 2º = %', group_letter, first_team, second_team;

      -- Aplica nas matches de mata-mata
      update public.matches set team_home = first_team
        where slot_home = '1' || group_letter;
      update public.matches set team_away = first_team
        where slot_away = '1' || group_letter;
      update public.matches set team_home = second_team
        where slot_home = '2' || group_letter;
      update public.matches set team_away = second_team
        where slot_away = '2' || group_letter;
    end if;
  end loop;

  -- Step 2: resolver W### e L### de jogos KO finalizados
  for m in
    select id, team_home, team_away, actual_home, actual_away, pen_winner, slot_home, slot_away
    from public.matches
    where finished = true and stage <> 'group'
  loop
    -- Skip se o time ainda não foi resolvido (ainda é slot)
    if m.team_home ~ '^[0-9LW]' or m.team_away ~ '^[0-9LW]' then
      continue;
    end if;

    -- Determina vencedor / perdedor
    if m.actual_home > m.actual_away then
      winner := m.team_home;
      loser  := m.team_away;
    elsif m.actual_away > m.actual_home then
      winner := m.team_away;
      loser  := m.team_home;
    elsif m.pen_winner = 'home' then
      winner := m.team_home;
      loser  := m.team_away;
    elsif m.pen_winner = 'away' then
      winner := m.team_away;
      loser  := m.team_home;
    else
      continue;  -- empate sem pen winner — pula
    end if;

    update public.matches set team_home = winner
      where slot_home = 'W' || m.id::text;
    update public.matches set team_away = winner
      where slot_away = 'W' || m.id::text;
    update public.matches set team_home = loser
      where slot_home = 'L' || m.id::text;
    update public.matches set team_away = loser
      where slot_away = 'L' || m.id::text;
  end loop;
end;
$$;

-- ===== 3) Trigger =====
-- Dispara quando finished/actual_*/pen_winner muda.
-- O próprio trigger NÃO modifica essas colunas → sem recursão.
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

-- ===== 4) Roda uma vez agora para resolver grupos já completos =====
select public.resolve_match_slots();

-- ============================================================
-- Migration 068: Desempate OFICIAL Copa do Mundo 2026
--   (confronto direto antes do saldo geral + fair play)
-- ============================================================
-- A FIFA mudou o regulamento para 2026: o confronto direto passou a ser o
-- PRIMEIRO desempate (antes do saldo geral). A ordem oficial dentro do grupo:
--   1) Pontos
--   2) Confronto direto entre os empatados (pts → SG → gols, só nos jogos
--      entre eles)
--   3) Saldo de gols geral
--   4) Gols marcados geral
--   5) Fair play (conduta — menos cartões)
--   6) Ranking FIFA
-- Para o RANKING DOS 3ºs (grupos diferentes) NÃO há confronto direto:
--   pts → SG → gols → fair play → ranking FIFA.
--
-- KEEP IN SYNC com src/js/util.js (computeStandings/rankGroupTeams), o simulador
-- (scripts/e2e/lib/tournament-simulator.js) e o oráculo (scripts/e2e/06-ui-assert.js).
--
-- Substitui a ordenação introduzida na migration 015 (pts → SG → GF → FIFA).

-- ------------------------------------------------------------
-- 1) Colunas de cartões / fair play em matches
-- ------------------------------------------------------------
-- Contagens cruas (amarelos/vermelhos) servem para exibição/transparência.
-- *_fairplay guarda os PONTOS de conduta já computados pela fórmula oficial da
-- FIFA na ingestão (scripts/data/fetch-cards.js): ≤ 0, quanto MAIOR (menos
-- negativo) melhor. Default 0 = sem cartões = melhor conduta (neutro até a
-- ingestão rodar; fair play só desempata em empate total, então é seguro).
alter table public.matches
  add column if not exists home_yellow   int not null default 0,
  add column if not exists home_red      int not null default 0,
  add column if not exists away_yellow   int not null default 0,
  add column if not exists away_red      int not null default 0,
  add column if not exists home_fairplay int not null default 0,
  add column if not exists away_fairplay int not null default 0,
  add column if not exists cards_fetched_at timestamptz;

-- ------------------------------------------------------------
-- 2) Helper: ordena UM grupo pela ordem oficial (com confronto direto)
-- ------------------------------------------------------------
-- Truque do confronto direto (idêntico ao JS): um jogo entra na mini-tabela
-- H2H se e só se os DOIS times têm os mesmos pontos-base. Como estão no mesmo
-- grupo, isso equivale a "estar no mesmo bloco de empate" e resolve de forma
-- uniforme empates de 2 ou de 3+ times.
create or replace function public.rank_group(p_group text)
returns table(team text, pos int, total_pts int, gd int, gf_total int, fairplay int)
language sql
stable
as $$
  with team_rows as (
    select team_home as team,
           case when actual_home > actual_away then 3 when actual_home = actual_away then 1 else 0 end as pts,
           actual_home as gf, actual_away as ga, coalesce(home_fairplay, 0) as fp
    from public.matches
    where group_name = p_group and stage = 'group' and finished = true
    union all
    select team_away as team,
           case when actual_away > actual_home then 3 when actual_home = actual_away then 1 else 0 end as pts,
           actual_away as gf, actual_home as ga, coalesce(away_fairplay, 0) as fp
    from public.matches
    where group_name = p_group and stage = 'group' and finished = true
  ),
  base as (
    select team, sum(pts) as total_pts, sum(gf) - sum(ga) as gd, sum(gf) as gf_total, sum(fp) as fairplay
    from team_rows
    group by team
  ),
  -- Confronto direto: só os jogos entre times de MESMA pontuação-base.
  h2h_rows as (
    select m.team_home as team,
           case when m.actual_home > m.actual_away then 3 when m.actual_home = m.actual_away then 1 else 0 end as pts,
           m.actual_home as gf, m.actual_away as ga
    from public.matches m
    join base bh on bh.team = m.team_home
    join base ba on ba.team = m.team_away
    where m.group_name = p_group and m.stage = 'group' and m.finished = true
      and bh.total_pts = ba.total_pts
    union all
    select m.team_away as team,
           case when m.actual_away > m.actual_home then 3 when m.actual_home = m.actual_away then 1 else 0 end as pts,
           m.actual_away as gf, m.actual_home as ga
    from public.matches m
    join base bh on bh.team = m.team_home
    join base ba on ba.team = m.team_away
    where m.group_name = p_group and m.stage = 'group' and m.finished = true
      and bh.total_pts = ba.total_pts
  ),
  h2h as (
    select team, sum(pts) as h2h_pts, sum(gf) - sum(ga) as h2h_gd, sum(gf) as h2h_gf
    from h2h_rows
    group by team
  )
  select b.team,
         (row_number() over (
            order by b.total_pts desc,
                     coalesce(h.h2h_pts, 0) desc,         -- confronto direto: pontos
                     coalesce(h.h2h_gd, 0) desc,          -- confronto direto: saldo
                     coalesce(h.h2h_gf, 0) desc,          -- confronto direto: gols
                     b.gd desc,                           -- saldo de gols geral
                     b.gf_total desc,                     -- gols marcados geral
                     b.fairplay desc,                     -- fair play (≤ 0, maior = melhor)
                     public.fifa_rank(b.team) asc         -- ranking FIFA
          ))::int as pos,
         b.total_pts::int, b.gd::int, b.gf_total::int, b.fairplay::int
  from base b
  left join h2h h on h.team = b.team
$$;

grant execute on function public.rank_group(text) to authenticated;

-- ------------------------------------------------------------
-- 3) resolve_match_slots() usando rank_group nos Steps 1 e 2
-- ------------------------------------------------------------
-- STEP 0/3 e o backtracking dos 3ºs são idênticos à migration 015 — só muda a
-- ORDENAÇÃO (agora via public.rank_group, com confronto direto + fair play).
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

  -- Step 1: 1X e 2X (ordem oficial via rank_group: pts → confronto direto → SG → GF → fair play → FIFA)
  for group_letter in select distinct group_name from public.matches where group_name is not null loop
    if (select count(*) from public.matches where group_name = group_letter and stage = 'group')
       = (select count(*) from public.matches where group_name = group_letter and stage = 'group' and finished = true)
    then
      select max(case when pos = 1 then team end), max(case when pos = 2 then team end)
        into first_team, second_team
        from public.rank_group(group_letter);

      update public.matches set team_home = first_team where slot_home = '1' || group_letter;
      update public.matches set team_away = first_team where slot_away = '1' || group_letter;
      update public.matches set team_home = second_team where slot_home = '2' || group_letter;
      update public.matches set team_away = second_team where slot_away = '2' || group_letter;
    end if;
  end loop;

  -- Step 2: terceiros qualificados (grupos diferentes → SEM confronto direto):
  -- pts → SG → GF → fair play → FIFA, depois backtracking nos slots compostos.
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
    with thirds as (
      select g.group_name, r.team, r.total_pts, r.gd, r.gf_total, r.fairplay
      from (select distinct group_name from public.matches where stage = 'group' and group_name is not null) g
      cross join lateral public.rank_group(g.group_name) r
      where r.pos = 3
    ),
    ranked as (
      select group_name, team,
             row_number() over (
               order by total_pts desc, gd desc, gf_total desc, fairplay desc,
                        public.fifa_rank(team) asc
             ) as rank_among_thirds
      from thirds
    )
    select group_name, team, rank_among_thirds
    from ranked where rank_among_thirds <= 8;

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

-- Aplica o novo desempate em quaisquer resoluções pendentes.
select public.resolve_match_slots();

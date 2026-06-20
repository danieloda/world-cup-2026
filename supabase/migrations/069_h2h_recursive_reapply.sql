-- ============================================================
-- Migration 069: confronto direto RE-APLICADO recursivamente (correção)
-- ============================================================
-- BUG corrigido: a 068 calculava o confronto direto numa passada só (mini-tabela
-- entre TODOS os empatados em pontos) e, para quem seguisse empatado, pulava
-- direto para o saldo GERAL. A regra oficial FIFA manda RE-APLICAR o confronto
-- direto exclusivamente ao SUBCONJUNTO que continua empatado.
--
-- Ex. real (Grupo B): Suíça, Canadá e Bósnia em 6 pts. A mini-tabela dos 3 é um
-- ciclo (mini pts/SG iguais); só o mini-gols separa a Bósnia (3º). Suíça e Canadá
-- seguem empatados → re-aplica o confronto direto SÓ entre os dois → Canadá
-- (venceu 2×1) passa. Antes a 068 ia pro saldo geral/FIFA e punha a Suíça.
--
-- Substitui rank_group da 068 por uma versão recursiva (_resolve_tied).
-- resolve_match_slots() continua igual (chama public.rank_group).
-- KEEP IN SYNC com src/js/util.js (resolveTiedOnPoints), o simulador e o oráculo.

-- ------------------------------------------------------------
-- _resolve_tied: ordena um conjunto de seleções empatadas em PONTOS.
-- ------------------------------------------------------------
-- Confronto direto (pts → SG → gols, só nos jogos entre p_teams). Particiona em
-- blocos de mesmo confronto direto; cada bloco ainda empatado é RE-RESOLVIDO
-- recursivamente. Se o confronto direto não separar ninguém (1 bloco só), cai
-- para saldo geral → gols geral → fair play → ranking FIFA.
create or replace function public._resolve_tied(p_group text, p_teams text[])
returns text[]
language plpgsql
stable
as $$
declare
  v_n     int := coalesce(array_length(p_teams, 1), 0);
  v_keys  int;
  v_out   text[] := '{}';
  v_block text[] := '{}';
  v_curkey text := null;
  r record;
begin
  if v_n <= 1 then return p_teams; end if;

  -- Quantos blocos distintos o confronto direto produz?
  select count(distinct (h.h2h_pts, h.h2h_sg, h.h2h_gf)) into v_keys
  from public._h2h_stats(p_group, p_teams) h;

  -- Confronto direto não separou ninguém → critérios gerais.
  if v_keys <= 1 then
    select array_agg(o.team order by o.gd desc, o.gf_total desc, o.fairplay desc, public.fifa_rank(o.team) asc)
      into v_out
    from public._overall_stats(p_group, p_teams) o;
    return v_out;
  end if;

  -- Percorre na ordem do confronto direto, agrupa em blocos e re-aplica.
  for r in
    select h.team, (h.h2h_pts || '|' || h.h2h_sg || '|' || h.h2h_gf) as k
    from public._h2h_stats(p_group, p_teams) h
    order by h.h2h_pts desc, h.h2h_sg desc, h.h2h_gf desc, h.team
  loop
    if v_curkey is null or r.k = v_curkey then
      v_block := v_block || r.team;
    else
      if coalesce(array_length(v_block, 1), 0) > 1
        then v_out := v_out || public._resolve_tied(p_group, v_block);
        else v_out := v_out || v_block; end if;
      v_block := array[r.team];
    end if;
    v_curkey := r.k;
  end loop;
  -- flush do último bloco
  if coalesce(array_length(v_block, 1), 0) > 1
    then v_out := v_out || public._resolve_tied(p_group, v_block);
    else v_out := v_out || v_block; end if;

  return v_out;
end;
$$;

-- Estatísticas do confronto direto (só jogos ENTRE os times de p_teams).
create or replace function public._h2h_stats(p_group text, p_teams text[])
returns table(team text, h2h_pts int, h2h_sg int, h2h_gf int)
language sql
stable
as $$
  select tt.team,
         coalesce(sum(x.pts), 0)::int            as h2h_pts,
         coalesce(sum(x.gf) - sum(x.ga), 0)::int as h2h_sg,
         coalesce(sum(x.gf), 0)::int             as h2h_gf
  from unnest(p_teams) tt(team)
  left join lateral (
    select case when m.team_home = tt.team
                then case when m.actual_home > m.actual_away then 3 when m.actual_home = m.actual_away then 1 else 0 end
                else case when m.actual_away > m.actual_home then 3 when m.actual_home = m.actual_away then 1 else 0 end end as pts,
           case when m.team_home = tt.team then m.actual_home else m.actual_away end as gf,
           case when m.team_home = tt.team then m.actual_away else m.actual_home end as ga
    from public.matches m
    where m.group_name = p_group and m.stage = 'group' and m.finished = true
      and m.team_home = any(p_teams) and m.team_away = any(p_teams)
      and (m.team_home = tt.team or m.team_away = tt.team)
  ) x on true
  group by tt.team
$$;

-- Estatísticas GERAIS (todos os jogos de grupo do time).
create or replace function public._overall_stats(p_group text, p_teams text[])
returns table(team text, gd int, gf_total int, fairplay int)
language sql
stable
as $$
  select tt.team,
         coalesce(sum(x.gf) - sum(x.ga), 0)::int as gd,
         coalesce(sum(x.gf), 0)::int             as gf_total,
         coalesce(sum(x.fp), 0)::int             as fairplay
  from unnest(p_teams) tt(team)
  left join lateral (
    select case when m.team_home = tt.team then m.actual_home else m.actual_away end as gf,
           case when m.team_home = tt.team then m.actual_away else m.actual_home end as ga,
           case when m.team_home = tt.team then coalesce(m.home_fairplay, 0) else coalesce(m.away_fairplay, 0) end as fp
    from public.matches m
    where m.group_name = p_group and m.stage = 'group' and m.finished = true
      and (m.team_home = tt.team or m.team_away = tt.team)
  ) x on true
  group by tt.team
$$;

-- ------------------------------------------------------------
-- rank_group: usa o confronto direto recursivo
-- ------------------------------------------------------------
create or replace function public.rank_group(p_group text)
returns table(team text, pos int, total_pts int, gd int, gf_total int, fairplay int)
language plpgsql
stable
as $$
declare
  v_order text[] := '{}';
  r record;
begin
  -- Resolve cada bloco de pontos (desc) pelo confronto direto recursivo.
  for r in
    select b.total_pts as pts, array_agg(b.team order by b.team) as teams
    from (
      select t.team, sum(t.pts) as total_pts
      from (
        select team_home as team,
               case when actual_home > actual_away then 3 when actual_home = actual_away then 1 else 0 end as pts
        from public.matches where group_name = p_group and stage = 'group' and finished = true
        union all
        select team_away,
               case when actual_away > actual_home then 3 when actual_home = actual_away then 1 else 0 end
        from public.matches where group_name = p_group and stage = 'group' and finished = true
      ) t group by t.team
    ) b
    group by b.total_pts
    order by b.total_pts desc
  loop
    v_order := v_order || public._resolve_tied(p_group, r.teams);
  end loop;

  return query
  select x.team,
         array_position(v_order, x.team)::int as pos,
         x.total_pts::int, x.gd::int, x.gf_total::int, x.fairplay::int
  from (
    select t.team,
           sum(t.pts) as total_pts,
           sum(t.gf) - sum(t.ga) as gd,
           sum(t.gf) as gf_total,
           sum(t.fp) as fairplay
    from (
      select team_home as team,
             case when actual_home > actual_away then 3 when actual_home = actual_away then 1 else 0 end as pts,
             actual_home as gf, actual_away as ga, coalesce(home_fairplay, 0) as fp
      from public.matches where group_name = p_group and stage = 'group' and finished = true
      union all
      select team_away,
             case when actual_away > actual_home then 3 when actual_home = actual_away then 1 else 0 end,
             actual_away, actual_home, coalesce(away_fairplay, 0)
      from public.matches where group_name = p_group and stage = 'group' and finished = true
    ) t group by t.team
  ) x
  order by array_position(v_order, x.team);
end;
$$;

grant execute on function public._resolve_tied(text, text[]) to authenticated;
grant execute on function public._h2h_stats(text, text[]) to authenticated;
grant execute on function public._overall_stats(text, text[]) to authenticated;
grant execute on function public.rank_group(text) to authenticated;

-- Aplica a correção em quaisquer resoluções pendentes.
select public.resolve_match_slots();

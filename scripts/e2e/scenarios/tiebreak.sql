-- ============================================================
-- Fase 2: Cenários determinísticos de empate + desempate FIFA
-- ============================================================
-- Roda contra o DB LOCAL via psql (postgres superuser). Tudo numa transação
-- com ROLLBACK no final → não deixa resíduo pra Fase 3.
--
-- Expectativas são INDEPENDENTES da implementação:
--   - ordem FIFA derivada direto de team_fifa_rank
--   - standings do cenário B calculados à mão (placares fixos)
-- Assim, se resolve_match_slots() estiver errado, o teste pega.

\set ON_ERROR_STOP on
\timing off
set client_min_messages = warning;

begin;

create temp table _res(id serial, check_name text, pass boolean, detail text) on commit drop;

-- Helper de reset (restaura slots KO, zera resultados)
create or replace function pg_temp.reset_all() returns void language plpgsql as $$
begin
  update public.matches set team_home = slot_home where slot_home is not null and team_home <> slot_home;
  update public.matches set team_away = slot_away where slot_away is not null and team_away <> slot_away;
  update public.matches set actual_home=null, actual_away=null, pen_winner=null, finished=false, finished_at=null
    where finished or actual_home is not null or actual_away is not null or pen_winner is not null;
end $$;

-- Standings esperados por FIFA (todos empatados em pts/SG/GF)
create temp view _fifa_pos as
  select group_name, team,
         row_number() over (partition by group_name order by public.fifa_rank(team) asc) as pos
  from (
    select group_name, team_home team from public.matches where stage='group'
    union select group_name, team_away from public.matches where stage='group'
  ) s;

-- ============================================================
-- CENÁRIO A — Todos os jogos de grupo 1-1 → FIFA decide tudo
-- ============================================================
select pg_temp.reset_all();
alter table public.matches disable trigger trg_resolve_slots;
update public.matches set actual_home=1, actual_away=1, pen_winner=null, finished=true, finished_at=now()
  where stage='group';
alter table public.matches enable trigger trg_resolve_slots;
select public.resolve_match_slots();

-- A1: vencedores (1X) e vices (2X) nas vagas do R32 == ordem FIFA
insert into _res(check_name, pass, detail)
select 'A1: 1X/2X do R32 seguem ordem FIFA',
       bool_and(ok), 'mismatches=' || count(*) filter (where not ok)
from (
  select fp.team = ko.team as ok
  from (
    select substr(slot_home,1,1)::int p, substr(slot_home,2,1) g, team_home team
      from public.matches where stage='r32' and slot_home ~ '^[12][A-L]$'
    union all
    select substr(slot_away,1,1)::int, substr(slot_away,2,1), team_away
      from public.matches where stage='r32' and slot_away ~ '^[12][A-L]$'
  ) ko
  join _fifa_pos fp on fp.group_name = ko.g and fp.pos = ko.p
) t;

-- A2: os 8 terceiros classificados == 8 melhores 3ºs por FIFA
insert into _res(check_name, pass, detail)
with exp_thirds as (
  select team from _fifa_pos where pos=3 order by public.fifa_rank(team) asc limit 8
),
act_thirds as (
  select team_home team from public.matches where stage='r32' and slot_home like '3%/%'
  union select team_away from public.matches where stage='r32' and slot_away like '3%/%'
)
select 'A2: 8 terceiros classificados = 8 melhores por FIFA',
       (select count(*) from act_thirds)=8
   and not exists(select team from exp_thirds except select team from act_thirds)
   and not exists(select team from act_thirds except select team from exp_thirds),
       'qtd_terceiros=' || (select count(*) from act_thirds);

-- A3: nenhuma vaga do R32 ficou presa (slot não resolvido)
insert into _res(check_name, pass, detail)
select 'A3: R32 sem slot não resolvido',
       not exists(
         select 1 from public.matches where stage='r32'
           and (team_home ~ '^[0-9WL]' or team_away ~ '^[0-9WL]'
                or team_home like '%/%' or team_away like '%/%')),
       'stuck=' || (select count(*) from public.matches where stage='r32'
           and (team_home ~ '^[0-9WL]' or team_away ~ '^[0-9WL]'
                or team_home like '%/%' or team_away like '%/%'));

-- A4: todo time do R32 tem rank FIFA (< 999) — pega o bug Turkey/999
insert into _res(check_name, pass, detail)
select 'A4: todos os times do R32 têm rank FIFA',
       not exists(
         select 1 from (
           select team_home t from public.matches where stage='r32'
           union select team_away from public.matches where stage='r32'
         ) x where public.fifa_rank(t) = 999),
       'sem_rank=' || (select count(*) from (
           select team_home t from public.matches where stage='r32'
           union select team_away from public.matches where stage='r32'
         ) x where public.fifa_rank(t)=999);

-- A5: idempotência — rodar resolve de novo não muda nada
create temp table _snap_a as
  select id, stage, team_home, team_away from public.matches where stage='r32' order by id;
select public.resolve_match_slots();
insert into _res(check_name, pass, detail)
select 'A5: resolve_match_slots idempotente (R32)',
       not exists(
         select 1 from public.matches m join _snap_a s on s.id=m.id
         where m.team_home <> s.team_home or m.team_away <> s.team_away),
       'diffs=' || (select count(*) from public.matches m join _snap_a s on s.id=m.id
         where m.team_home <> s.team_home or m.team_away <> s.team_away);

-- ============================================================
-- CENÁRIO B — pts e SG dominam o FIFA (FIFA é só último critério)
-- Grupo A: Mexico(15) KOR(25) CZE(41) RSA(60)
-- Placares fixos → standings à mão: RSA 1º (9pts), CZE 2º (2pts,SG-1),
-- KOR 3º (2,-2), MEX 4º (2,-3). Ordem != ordem FIFA → prova precedência.
-- ============================================================
select pg_temp.reset_all();
alter table public.matches disable trigger trg_resolve_slots;
-- RSA vence todos por margens diferentes (define SG dos demais)
update public.matches set actual_home=(case when team_home='South Africa' then 3 else 0 end),
                          actual_away=(case when team_away='South Africa' then 3 else 0 end),
                          finished=true, finished_at=now()
  where group_name='A' and stage='group'
    and ((team_home='South Africa' and team_away='Mexico') or (team_home='Mexico' and team_away='South Africa'));
update public.matches set actual_home=(case when team_home='South Africa' then 2 else 0 end),
                          actual_away=(case when team_away='South Africa' then 2 else 0 end),
                          finished=true, finished_at=now()
  where group_name='A' and stage='group'
    and ((team_home='South Africa' and team_away='South Korea') or (team_home='South Korea' and team_away='South Africa'));
update public.matches set actual_home=(case when team_home='South Africa' then 1 else 0 end),
                          actual_away=(case when team_away='South Africa' then 1 else 0 end),
                          finished=true, finished_at=now()
  where group_name='A' and stage='group'
    and ((team_home='South Africa' and team_away='Czech Republic') or (team_home='Czech Republic' and team_away='South Africa'));
-- Empates 1-1 entre os outros três
update public.matches set actual_home=1, actual_away=1, finished=true, finished_at=now()
  where group_name='A' and stage='group'
    and ((team_home='Mexico' and team_away='South Korea') or (team_home='South Korea' and team_away='Mexico')
      or (team_home='Mexico' and team_away='Czech Republic') or (team_home='Czech Republic' and team_away='Mexico')
      or (team_home='South Korea' and team_away='Czech Republic') or (team_home='Czech Republic' and team_away='South Korea'));
alter table public.matches enable trigger trg_resolve_slots;
select public.resolve_match_slots();

-- B1: 1A == South Africa (pior FIFA do grupo, 1º por pontos)
insert into _res(check_name, pass, detail)
select 'B1: 1A=South Africa (pts dominam FIFA)',
       bool_or(t='South Africa'), coalesce(string_agg(t,','),'<vazio>')
from (
  select team_home t from public.matches where stage='r32' and slot_home='1A'
  union all select team_away from public.matches where stage='r32' and slot_away='1A'
) x;

-- B2: 2A == Czech Republic (SG melhor que KOR apesar de pior FIFA)
insert into _res(check_name, pass, detail)
select 'B2: 2A=Czech Republic (SG domina FIFA)',
       bool_or(t='Czech Republic'), coalesce(string_agg(t,','),'<vazio>')
from (
  select team_home t from public.matches where stage='r32' and slot_home='2A'
  union all select team_away from public.matches where stage='r32' and slot_away='2A'
) x;

-- ============================================================
-- CENÁRIO C — Final nos pênaltis → champion_bonus_for usa pen_winner
-- ============================================================
select pg_temp.reset_all();
alter table public.matches disable trigger trg_resolve_slots;
update public.matches set team_home='Brazil', team_away='France',
       actual_home=1, actual_away=1, pen_winner='home', finished=true, finished_at=now()
  where stage='final';
-- mantém trg_resolve_slots DESLIGADO durante todo o cenário C: senão o Step 0 do
-- resolve resetaria team_home/away da final pros slots W101/W102.

-- usa o user admin (profile real já existe)
do $$
declare v_uid uuid;
begin
  select id into v_uid from public.profiles where is_admin = true limit 1;
  delete from public.champion_picks where user_id = v_uid;
  insert into public.champion_picks(user_id, team) values (v_uid, 'Brazil');
end $$;

insert into _res(check_name, pass, detail)
select 'C1: final 1-1 pen=home, pick=Brazil → bônus 50',
       public.champion_bonus_for((select id from public.profiles where is_admin limit 1)) = 50,
       'bonus=' || public.champion_bonus_for((select id from public.profiles where is_admin limit 1));

-- troca o palpite pro perdedor → 0
update public.champion_picks set team='France'
  where user_id = (select id from public.profiles where is_admin limit 1);
insert into _res(check_name, pass, detail)
select 'C2: pick=France (perdeu nos pênaltis) → bônus 0',
       public.champion_bonus_for((select id from public.profiles where is_admin limit 1)) = 0,
       'bonus=' || public.champion_bonus_for((select id from public.profiles where is_admin limit 1));

-- inverte o pen_winner → France campeã → pick=France volta a 50
update public.matches set pen_winner='away' where stage='final';
insert into _res(check_name, pass, detail)
select 'C3: pen=away → France campeã, pick=France → bônus 50',
       public.champion_bonus_for((select id from public.profiles where is_admin limit 1)) = 50,
       'bonus=' || public.champion_bonus_for((select id from public.profiles where is_admin limit 1));

-- ============================================================
-- CENÁRIO D — Re-resolução da cascata quando admin corrige resultado
-- ============================================================
alter table public.matches enable trigger trg_resolve_slots;  -- reativa (estava off no cenário C)
select pg_temp.reset_all();
alter table public.matches disable trigger trg_resolve_slots;
update public.matches set actual_home=1, actual_away=1, finished=true, finished_at=now() where stage='group';
alter table public.matches enable trigger trg_resolve_slots;
select public.resolve_match_slots();

-- pega um R32 cujo vencedor alimenta um R16 (slot W<id>)
create temp table _dsel as
  select m.id as r32id, m.team_home as home, m.team_away as away
  from public.matches m
  where m.stage='r32' and exists(
    select 1 from public.matches k where k.slot_home='W'||m.id or k.slot_away='W'||m.id)
  order by m.id limit 1;
-- home vence
update public.matches set actual_home=2, actual_away=0, finished=true, finished_at=now()
  where id = (select r32id from _dsel);
select public.resolve_match_slots();

insert into _res(check_name, pass, detail)
select 'D1: vencedor do R32 propaga pro R16 (W<id>)',
       bool_and(ok), coalesce(string_agg(detail,'; '),'')
from (
  select (km.team_home = d.home or km.team_away = d.home) as ok,
         'R16#'||km.id||' home='||km.team_home||' away='||km.team_away as detail
  from public.matches km, _dsel d
  where km.slot_home = 'W'||d.r32id or km.slot_away = 'W'||d.r32id
) x;

-- corrige: agora o AWAY vence → R16 deve trocar pro away
update public.matches set actual_home=0, actual_away=2 where id = (select r32id from _dsel);
select public.resolve_match_slots();
insert into _res(check_name, pass, detail)
select 'D2: corrigir resultado re-resolve cascata (away agora)',
       bool_and(ok), coalesce(string_agg(detail,'; '),'')
from (
  select (km.team_home = d.away or km.team_away = d.away) as ok,
         'R16#'||km.id||' home='||km.team_home||' away='||km.team_away as detail
  from public.matches km, _dsel d
  where km.slot_home = 'W'||d.r32id or km.slot_away = 'W'||d.r32id
) x;

-- ============================================================
-- RESULTADO
-- ============================================================
select id, case when pass then 'PASS' else 'FAIL' end as status, check_name, detail
from _res order by id;

select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from _res;

rollback;

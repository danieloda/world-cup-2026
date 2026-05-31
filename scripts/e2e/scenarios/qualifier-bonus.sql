-- ============================================================
-- Cenários determinísticos do bônus de seleção classificada (BPE/BP)
-- ============================================================
-- Roda contra o DB LOCAL via psql (postgres superuser). Tudo numa transação
-- com ROLLBACK no final → não deixa resíduo.
--
-- Cobre o que os testes unitários (qualifier.test.js) NÃO cobrem:
--   - resolução do bracket PREVISTO em SQL (compute_predicted_slots)
--   - ordenação do trigger (resolve_match_slots ANTES de qualifier — Risco R4)
--   - gating (grupo incompleto não resolve vaga)
--   - idempotência do recompute
-- Os VALORES de BPE/BP têm um check de paridade direto no fim (Q4).
--
-- Setup base: todos os jogos de grupo 1-1 → standings empatadas → FIFA decide
-- tudo (igual cenário A do tiebreak). O admin palpita 1-1 em TODOS os grupos,
-- então o bracket previsto do admin == bracket real → todas as 32 vagas dos
-- 32-avos são BPE (×1) = 32 pontos.

\set ON_ERROR_STOP on
\timing off
set client_min_messages = warning;

begin;

create temp table _res(id serial, check_name text, pass boolean, detail text) on commit drop;

create or replace function pg_temp.reset_all() returns void language plpgsql as $$
begin
  update public.matches set team_home = slot_home where slot_home is not null and team_home <> slot_home;
  update public.matches set team_away = slot_away where slot_away is not null and team_away <> slot_away;
  update public.matches set actual_home=null, actual_away=null, pen_winner=null, finished=false, finished_at=null
    where finished or actual_home is not null or actual_away is not null or pen_winner is not null;
end $$;

-- uid do admin (reusado em vários selects)
create temp view _admin as select id as uid from public.profiles where is_admin limit 1;

-- ============================================================
-- SETUP — admin paga, palpita 1-1 em todos os grupos, e UM UPDATE
-- real dispara a cadeia de triggers (resolve_slots → qualifier).
-- NÃO chamamos resolve_match_slots()/recompute manualmente de propósito:
-- assim Q1 prova a ORDEM dos triggers de ponta a ponta.
-- ============================================================
select pg_temp.reset_all();
update public.profiles set paid = true where is_admin;

do $$
declare v_uid uuid;
begin
  select uid into v_uid from _admin;
  delete from public.predictions where user_id = v_uid;
  insert into public.predictions (user_id, match_id, pred_home, pred_away)
  select v_uid, id, 1, 1 from public.matches where stage = 'group';
end $$;

-- dispara a cadeia (triggers ligados): cada row update roda resolve + qualifier
update public.matches set actual_home=1, actual_away=1, pen_winner=null, finished=true, finished_at=now()
  where stage='group';

-- ============================================================
-- Q1 — trigger ordering + BPE: admin all-correct → cache = 32
-- (16 jogos r32 × 2 lados × BPE r32(1) = 32). Prova: a cadeia
-- resolve→qualifier rodou na ordem certa e o bracket previsto == real.
-- ============================================================
insert into _res(check_name, pass, detail)
select 'Q1: trigger resolve→qualifier; admin all-correct → cache=32',
       (select points from public.user_qualifier_points where user_id=(select uid from _admin)) = 32,
       'points=' || coalesce((select points::text from public.user_qualifier_points where user_id=(select uid from _admin)), 'NULL (cache vazio → trigger não rodou ou ordem errada)');

-- Q1b — todas as vagas marcadas são 'bpe' (nenhum bp/miss quando 100% certo)
insert into _res(check_name, pass, detail)
select 'Q1b: todas as 32 vagas r32 são BPE',
       (select count(*) from jsonb_array_elements((select breakdown->'items' from public.user_qualifier_points where user_id=(select uid from _admin))) it
          where it->>'kind'='bpe') = 32
   and not exists (select 1 from jsonb_array_elements((select breakdown->'items' from public.user_qualifier_points where user_id=(select uid from _admin))) it
          where it->>'kind'<>'bpe'),
       'bpe=' || (select count(*) from jsonb_array_elements((select breakdown->'items' from public.user_qualifier_points where user_id=(select uid from _admin))) it where it->>'kind'='bpe');

-- Q1c — só fases com vaga resolvida pontuam (r16+ ainda são W### → 0 itens fora de r32)
insert into _res(check_name, pass, detail)
select 'Q1c: só r32 pontua (r16+ ainda não resolvido)',
       not exists (select 1 from jsonb_array_elements((select breakdown->'items' from public.user_qualifier_points where user_id=(select uid from _admin))) it
          where it->>'phase' <> 'r32'),
       'fases=' || coalesce((select string_agg(distinct it->>'phase', ',') from jsonb_array_elements((select breakdown->'items' from public.user_qualifier_points where user_id=(select uid from _admin))) it), '<vazio>');

-- ============================================================
-- Q2 — idempotência: recomputar de novo não muda o total
-- ============================================================
select public.recompute_qualifier_points();
insert into _res(check_name, pass, detail)
select 'Q2: recompute_qualifier_points idempotente',
       (select points from public.user_qualifier_points where user_id=(select uid from _admin)) = 32,
       'points=' || (select points from public.user_qualifier_points where user_id=(select uid from _admin));

-- ============================================================
-- Q3 — gating: grupo A não palpitado → vagas 1A/2A/3A somem do
-- bracket previsto e o bônus cai abaixo de 32.
-- ============================================================
insert into _res(check_name, pass, detail)
select 'Q3-pre: com grupo A palpitado, 1A está no bracket previsto',
       exists (select 1 from public.compute_predicted_slots((select uid from _admin)) where slot='1A'),
       'tem_1A=' || exists (select 1 from public.compute_predicted_slots((select uid from _admin)) where slot='1A')::text;

do $$
declare v_uid uuid;
begin
  select uid into v_uid from _admin;
  delete from public.predictions
   where user_id = v_uid
     and match_id in (select id from public.matches where group_name='A' and stage='group');
end $$;

insert into _res(check_name, pass, detail)
select 'Q3: grupo A incompleto → 1A/2A/3A ausentes do bracket previsto',
       not exists (select 1 from public.compute_predicted_slots((select uid from _admin)) where slot in ('1A','2A','3A')),
       'slots_A=' || (select count(*) from public.compute_predicted_slots((select uid from _admin)) where slot in ('1A','2A','3A'));

insert into _res(check_name, pass, detail)
select 'Q3b: gating reduz o bônus (<32)',
       (select points from public.qualifier_bonus_for((select uid from _admin))) < 32,
       'points=' || (select points from public.qualifier_bonus_for((select uid from _admin)));

-- ============================================================
-- Q4 — valores de qualifier_bonus_pts (paridade com js/scoring.js)
--   BPE: r32 1 · r16 2 · qf 3 · sf 4 · third 3 · final 6
--   BP  = round(BPE/2), exceto r32 = 0
-- ============================================================
insert into _res(check_name, pass, detail)
select 'Q4: BPE por fase corretos',
       public.qualifier_bonus_pts('r32',true)=1 and public.qualifier_bonus_pts('r16',true)=2
   and public.qualifier_bonus_pts('qf',true)=3 and public.qualifier_bonus_pts('sf',true)=4
   and public.qualifier_bonus_pts('third',true)=3 and public.qualifier_bonus_pts('final',true)=6,
       'r32/r16/qf/sf/third/final = '
       || public.qualifier_bonus_pts('r32',true)||'/'||public.qualifier_bonus_pts('r16',true)||'/'
       || public.qualifier_bonus_pts('qf',true)||'/'||public.qualifier_bonus_pts('sf',true)||'/'
       || public.qualifier_bonus_pts('third',true)||'/'||public.qualifier_bonus_pts('final',true);

insert into _res(check_name, pass, detail)
select 'Q4b: BP = metade (r32=0; r16 1; qf 2; sf 2; third 2; final 3)',
       public.qualifier_bonus_pts('r32',false)=0 and public.qualifier_bonus_pts('r16',false)=1
   and public.qualifier_bonus_pts('qf',false)=2 and public.qualifier_bonus_pts('sf',false)=2
   and public.qualifier_bonus_pts('third',false)=2 and public.qualifier_bonus_pts('final',false)=3,
       'r32/r16/qf/sf/third/final = '
       || public.qualifier_bonus_pts('r32',false)||'/'||public.qualifier_bonus_pts('r16',false)||'/'
       || public.qualifier_bonus_pts('qf',false)||'/'||public.qualifier_bonus_pts('sf',false)||'/'
       || public.qualifier_bonus_pts('third',false)||'/'||public.qualifier_bonus_pts('final',false);

insert into _res(check_name, pass, detail)
select 'Q4c: group/desconhecido = 0',
       public.qualifier_bonus_pts('group',true)=0 and public.qualifier_bonus_pts('group',false)=0
   and public.qualifier_bonus_pts('xyz',true)=0,
       'ok';

-- ============================================================
-- Q5 — cumulativo r32→r16: exercita o multi-pass de W/L (Step 3) e
-- fase posterior. Admin acerta grupos (1-1) e r32 (casa vence 1-0):
-- 32 (r32 BPE×1) + 16 vagas r16 × BPE r16(2) = 32 → total 64.
-- ============================================================
do $$
declare v_uid uuid;
begin
  select uid into v_uid from _admin;
  delete from public.predictions where user_id = v_uid;
  insert into public.predictions (user_id, match_id, pred_home, pred_away)
    select v_uid, id, 1, 1 from public.matches where stage='group';
  insert into public.predictions (user_id, match_id, pred_home, pred_away)
    select v_uid, id, 1, 0 from public.matches where stage='r32';
end $$;
update public.matches set actual_home=1, actual_away=1, pen_winner=null, finished=true, finished_at=now() where stage='group';
-- finalizar r32 (mudança real) dispara resolve→r16 + recompute do qualifier
update public.matches set actual_home=1, actual_away=0, pen_winner=null, finished=true, finished_at=now() where stage='r32';

insert into _res(check_name, pass, detail)
select 'Q5: cumulativo r32→r16 (multi-pass W/L) → 64 (32 r32 + 32 r16)',
       (select points from public.user_qualifier_points where user_id=(select uid from _admin)) = 64,
       'points=' || coalesce((select points::text from public.user_qualifier_points where user_id=(select uid from _admin)), 'NULL')
       || ' r16_itens=' || (select count(*) from jsonb_array_elements((select breakdown->'items' from public.user_qualifier_points where user_id=(select uid from _admin))) i where i->>'phase'='r16');

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

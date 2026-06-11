-- ════════════════════════════════════════════════════════════════════
-- Cenário E2E: revelação dos palpites pós-PUBLICAÇÃO do lacre (migration 060)
--
-- Valida, direto no banco, a semântica completa da revelação:
--   1. deadline passada SEM lacre publicado → palpite alheio INVISÍVEL
--   2. lacre publicado (integrity_publications) → palpite alheio VISÍVEL
--      antes do apito; v_revealed_matches contém o jogo
--   3. jogo re-agendado pro futuro → re-esconde MESMO publicado
--      (defesa em profundidade: prediction_deadline re-checada na leitura)
--   4. jogo já começado SEM publicação → visível (fallback do apito)
--   5. authenticated NÃO escreve em integrity_publications (só service_role)
--   6. grants_health() vigia os grants novos da 060
--
-- Pré-requisito: seed 01_matches.sql aplicado (usa o jogo id=1).
-- Roda numa transação com ROLLBACK — não deixa rastro. Os triggers de
-- alerta são desligados DENTRO da transação (rollback restaura), então
-- nada chega perto do edge de produção (pg_net).
--
-- Uso: docker exec -i supabase_db_world-cup-2026 psql -U postgres -d postgres \
--        -v ON_ERROR_STOP=1 < scripts/e2e/scenarios/reveal-publication.sql
-- KEEP IN SYNC: supabase/migrations/060_reveal_after_publication.sql.
-- ════════════════════════════════════════════════════════════════════
begin;

-- Alertas off só nesta transação: as escritas abaixo (profiles/matches/
-- predictions) não devem enfileirar POSTs no pg_net (URL de prod hardcoded
-- no fallback de send_alert — ver LOCAL-E2E.md, passo 3).
alter table public.matches     disable trigger user;
alter table public.predictions disable trigger user;
alter table public.profiles    disable trigger user;

-- ----- fixtures: Alice (observadora) e Bob (palpiteiro) -----
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice-reveal@testuser.com', '', now(), now(), now()),
  ('00000000-0000-4000-8000-0000000000bb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob-reveal@testuser.com',   '', now(), now(), now());

insert into public.profiles (id, full_name, email, is_admin, paid) values
  ('00000000-0000-4000-8000-0000000000aa', 'Alice Reveal', 'alice-reveal@testuser.com', false, true),
  ('00000000-0000-4000-8000-0000000000bb', 'Bob Reveal',   'bob-reveal@testuser.com',   false, true);

-- Jogo-teste: daqui a 30 min → deadline (véspera 23h59 BRT) JÁ passou, apito não.
-- (Rodando entre 23h29–23h59 BRT o jogo cai no dia BRT seguinte e o cenário 2
--  falharia — janela de 30 min/dia, aceitável pra um cenário manual.)
update public.matches set match_date = now() + interval '30 minutes', finished = false where id = 1;

insert into public.predictions (user_id, match_id, pred_home, pred_away)
values ('00000000-0000-4000-8000-0000000000bb', 1, 2, 1);

create temp table _checks (seq serial, name text, pass bool);

-- ════ [1] deadline passada, SEM publicação → invisível ════
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select count(*) as q1_pred from public.predictions where user_id = '00000000-0000-4000-8000-0000000000bb' \gset
select count(*) as q1_view from public.v_revealed_matches where id = 1 \gset
-- dono sempre vê o próprio palpite, publicado ou não
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000bb","role":"authenticated"}';
select count(*) as q1_own from public.predictions where user_id = '00000000-0000-4000-8000-0000000000bb' \gset
reset role;
insert into _checks (name, pass) values
  ('1a. sem publicação → Alice não vê palpite do Bob',      :q1_pred = 0),
  ('1b. sem publicação → v_revealed_matches sem o jogo',    :q1_view = 0),
  ('1c. Bob sempre vê o próprio palpite',                   :q1_own  = 1);

-- ════ [2] lacre publicado → visível antes do apito ════
insert into public.integrity_publications (seq, report_file, chain_hash, locked_match_ids)
values (424242, 'reports/teste-cenario.md', 'hash-de-teste', array[1]);

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select count(*) as q2_pred from public.predictions where user_id = '00000000-0000-4000-8000-0000000000bb' \gset
select count(*) as q2_view from public.v_revealed_matches where id = 1 \gset
reset role;
insert into _checks (name, pass) values
  ('2a. lacre publicado → Alice VÊ palpite do Bob pré-apito', :q2_pred = 1),
  ('2b. lacre publicado → v_revealed_matches contém o jogo',  :q2_view = 1);

-- ════ [3] jogo re-agendado pro futuro → re-esconde mesmo publicado ════
update public.matches set match_date = '2027-01-01T00:00:00+00:00' where id = 1;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select count(*) as q3_pred from public.predictions where user_id = '00000000-0000-4000-8000-0000000000bb' \gset
select count(*) as q3_view from public.v_revealed_matches where id = 1 \gset
reset role;
insert into _checks (name, pass) values
  ('3a. jogo adiado → re-esconde mesmo constando no lote',    :q3_pred = 0),
  ('3b. jogo adiado → some da v_revealed_matches',            :q3_view = 0);

-- ════ [4] apito SEM publicação → visível (fallback) ════
delete from public.integrity_publications where seq = 424242;
update public.matches set match_date = '2020-01-01T00:00:00+00:00' where id = 1;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select count(*) as q4_pred from public.predictions where user_id = '00000000-0000-4000-8000-0000000000bb' \gset
select count(*) as q4_view from public.v_revealed_matches where id = 1 \gset
reset role;
insert into _checks (name, pass) values
  ('4a. jogo começado sem publicação → vê (fallback apito)',  :q4_pred = 1),
  ('4b. jogo começado → presente na v_revealed_matches',      :q4_view = 1);

-- ════ [5] authenticated não escreve em integrity_publications ════
do $$
declare blocked bool := false;
begin
  begin
    set local role authenticated;
    insert into public.integrity_publications (seq, report_file, chain_hash)
    values (424243, 'reports/hack.md', 'hack');
  exception when insufficient_privilege then
    blocked := true;   -- sem grant de INSERT → 42501 (esperado)
  end;
  reset role;
  insert into _checks (name, pass)
  values ('5.  authenticated não escreve em integrity_publications', blocked);
end $$;

-- ════ [6] grants_health vigia os grants novos ════
insert into _checks (name, pass) values
  ('6a. grants_health: v_revealed_matches__auth_select',
   coalesce((public.grants_health()->>'v_revealed_matches__auth_select')::bool, false)),
  ('6b. grants_health: integrity_publications__auth_select',
   coalesce((public.grants_health()->>'integrity_publications__auth_select')::bool, false));

-- ----- resultado -----
select (case when pass then 'OK  ' else 'FAIL' end) as status, name from _checks order by seq;

do $$
declare nf int;
begin
  select count(*) into nf from _checks where not pass;
  if nf > 0 then
    raise exception 'reveal-publication: % check(s) FALHARAM', nf;
  end if;
  raise notice 'reveal-publication: todos os checks passaram ✓';
end $$;

rollback;

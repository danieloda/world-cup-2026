-- ============================================================
-- Migration 026: Revamp dos alertas (foco em monitoramento DIÁRIO)
-- ============================================================
-- Contexto: os alertas do Telegram agora são VISÍVEIS PROS PARTICIPANTES,
-- não só pro admin. Então:
--   • Os alertas `info` ganham formato amigável (ver edge function: sem
--     cabeçalho técnico, com CTA clicável via context.cta_url).
--   • Alertas que VAZAM palpites em tempo real são removidos.
--   • Monitoramento de pagamento/completude vira DIÁRIO (não na hora).
--
-- O QUE MUDA:
--   REMOVE (tempo real / 5min — vazavam palpite ou eram ruído):
--     - trg_alert_champion_change   (vazava o campeão antes do prazo)
--     - trg_alert_scorer_change      (vazava o artilheiro antes do prazo)
--     - trg_alert_picks_complete     (milestone na hora)
--     - cron alerts_pick_activity    (5 min)
--     - cron alerts_daily_digest     (substituído pelos 3 dedicados abaixo)
--   MANTÉM (tempo real):
--     - signup_success (melhorado: amigável, sem expor email no corpo)
--     - signup_failure, e os bugs/segurança da 007 (orphan/unresolved/overwrite/auth)
--   ADICIONA (cron diário, amigável):
--     1. daily_payments      → quem pagou / quem falta + PIX + CTA cadastro
--     2. group_completeness  → progresso de TODOS os usuários + data limite
--     3. cs_completeness     → falta campeão / falta artilheiro + data limite
--     4. deadline_countdown  → contagem regressiva (só ≤3 dias do prazo)
--     5. lock_tonight        → "palpites travam HOJE 23h59" (só se há jogos amanhã)
--     6. daily_recap         → resultados das últimas 24h + líder do bolão
--     7. heartbeat           → (admin/warn) avisa se um cron diário parou
--
-- IMPORTANTE: NUNCA modifica os bugs/segurança da 007. Reusa send_alert().

-- ============================================================
-- Settings novos (idempotente)
-- ============================================================
insert into public.settings (key, value) values
  ('pix_key',  '"05960278189"'::jsonb),
  ('site_url', '"https://bolaobsbcopadomundo2026.netlify.app"'::jsonb)
on conflict (key) do nothing;  -- não sobrescreve se o admin já ajustou

-- ============================================================
-- Helpers internos
-- ============================================================

-- Marca a última execução de um cron (pro heartbeat detectar paradas).
create or replace function public.mark_cron_run(p_name text)
returns void language sql security definer as $$
  insert into public.settings(key, value)
  values ('cron_lastrun_' || p_name, to_jsonb(now()::text))
  on conflict (key) do update set value = excluded.value, updated_at = now();
$$;

-- URL do site (CTA). Tolera valor com/sem aspas; fallback pro prod.
create or replace function public._site_url()
returns text language sql stable as $$
  select coalesce(
    nullif(trim(both '"' from (select value #>> '{}' from public.settings where key = 'site_url')), ''),
    'https://bolaobsbcopadomundo2026.netlify.app'
  );
$$;

-- Formata inteiro no padrão pt-BR (milhar com ponto): 1200 → "1.200".
-- (to_char 'G' depende de lc_numeric do servidor e pode virar vírgula.)
create or replace function public._fmt_int(p numeric)
returns text language sql immutable as $$
  select regexp_replace(round(coalesce(p, 0))::bigint::text, '(\d)(?=(\d{3})+$)', '\1.', 'g');
$$;

-- Chave PIX (pode estar vazia). Retorna '' se não configurada.
create or replace function public._pix_key()
returns text language sql stable as $$
  select coalesce(trim(both '"' from (select value #>> '{}' from public.settings where key = 'pix_key')), '');
$$;

-- Dias (calendário, BRT) até o prazo de campeão/artilheiro. 0 = é hoje, <0 = passou.
create or replace function public._days_to_cs_deadline()
returns int language sql stable as $$
  select ((public.cs_deadline() at time zone 'America/Sao_Paulo')::date
          - (now() at time zone 'America/Sao_Paulo')::date)::int;
$$;

-- ============================================================
-- REMOÇÕES (idempotente)
-- ============================================================
drop trigger if exists trg_alert_champion_change on public.champion_picks;
drop function if exists public.alert_champion_change();

drop trigger if exists trg_alert_scorer_change on public.top_scorer_picks;
drop function if exists public.alert_scorer_change();

drop trigger if exists trg_alert_picks_complete on public.predictions;
drop function if exists public.alert_picks_complete();

do $$
begin
  begin perform cron.unschedule('alerts_pick_activity'); exception when others then null; end;
  begin perform cron.unschedule('alerts_daily_digest');  exception when others then null; end;
end $$;

drop function if exists public.cron_alert_pick_activity();
drop function if exists public.cron_alert_daily_digest();

-- ============================================================
-- signup_success — MELHORADO (amigável, sem expor email no corpo)
-- ============================================================
create or replace function public.alert_signup_success()
returns trigger
language plpgsql
security definer
as $$
declare
  v_total int;
begin
  select count(*) into v_total from public.profiles;

  perform public.send_alert(
    'info',
    'signup_success',
    format('✨ Novo participante: %s', new.full_name),
    format('%s acabou de entrar no bolão! Já somos %s jogador(es) na disputa. 🎉',
           new.full_name, v_total),
    jsonb_build_object(
      'cta_url',     public._site_url(),
      'cta_label',   'Ver o bolão',
      'user_id',     new.id,
      'full_name',   new.full_name,
      'total_users', v_total
    ),
    0  -- sem dedup: cada signup é único
  );

  return new;
end $$;
-- (trigger trg_alert_signup_success já existe da 019; CREATE OR REPLACE basta)

-- ============================================================
-- CRON 1: daily_payments — quem pagou / quem falta
-- ============================================================
create or replace function public.cron_alert_daily_payments()
returns void
language plpgsql
security definer
as $$
declare
  v_total int;
  v_paid  int;
  v_fee   numeric;
  v_pot   numeric;
  v_pix   text;
  v_body  text;
  v_pix_line text := '';
  r record;
begin
  select count(*) into v_total from public.profiles;
  select count(*) into v_paid  from public.profiles where paid;
  select coalesce((value #>> '{}')::numeric, 100) into v_fee
    from public.settings where key = 'fee_amount';
  v_fee := coalesce(v_fee, 100);
  v_pot := v_paid * v_fee;
  v_pix := public._pix_key();

  v_body := format('💰 PAGAMENTOS: %s de %s em dia · caixa R$ %s',
                   v_paid, v_total, public._fmt_int(v_pot));

  -- Quem já pagou (cap 60)
  if v_paid > 0 then
    v_body := v_body || E'\n\n✅ JÁ PAGARAM (' || v_paid || '):';
    for r in
      select full_name from public.profiles where paid
      order by full_name asc limit 60
    loop
      v_body := v_body || E'\n• ' || r.full_name;
    end loop;
  end if;

  -- Quem falta pagar (cap 60)
  if v_paid < v_total then
    v_body := v_body || E'\n\n⏳ FALTAM PAGAR (' || (v_total - v_paid) || '):';
    for r in
      select full_name from public.profiles where not paid
      order by full_name asc limit 60
    loop
      v_body := v_body || E'\n• ' || r.full_name;
    end loop;
  else
    v_body := v_body || E'\n\n🎉 Todo mundo já pagou!';
  end if;

  -- Linha do PIX (só se configurado)
  if v_pix <> '' then
    v_pix_line := format(E'\n\n💸 Inscrição R$ %s · PIX: %s',
                         public._fmt_int(v_fee), v_pix);
  else
    v_pix_line := format(E'\n\n💸 Inscrição R$ %s', public._fmt_int(v_fee));
  end if;
  v_body := v_body || v_pix_line;
  v_body := v_body || E'\n\n👉 Ainda não está na lista? Cadastre-se no botão abaixo.';

  perform public.send_alert(
    'info',
    'daily_payments',
    format('💰 Pagamentos do bolão — %s', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM')),
    v_body,
    jsonb_build_object(
      'cta_url',   public._site_url(),
      'cta_label', 'Entrar no bolão',
      'paid', v_paid, 'total', v_total, 'pot', v_pot
    ),
    0
  );

  perform public.mark_cron_run('daily_payments');
end $$;

comment on function public.cron_alert_daily_payments is
'Cron diário 09h BRT. Lista quem pagou/quem falta + PIX + CTA de cadastro. Visível pros participantes.';

-- ============================================================
-- CRON 2: group_completeness — progresso de TODOS os usuários
-- ============================================================
create or replace function public.cron_alert_group_completeness()
returns void
language plpgsql
security definer
as $$
declare
  v_total_group int;
  v_total_users int;
  v_complete    int;
  v_first_date  timestamptz;
  v_first_lock  timestamptz;
  v_days        int;
  v_body        text;
  v_emoji       text;
  r record;
begin
  select count(*) into v_total_group from public.matches where stage = 'group';
  select count(*) into v_total_users from public.profiles;

  if v_total_group = 0 or v_total_users = 0 then return; end if;

  select min(match_date) into v_first_date from public.matches where stage = 'group';
  v_first_lock := public.prediction_deadline(v_first_date);
  v_days := ((v_first_lock at time zone 'America/Sao_Paulo')::date
             - (now() at time zone 'America/Sao_Paulo')::date)::int;

  select count(*) into v_complete from (
    select p.user_id
    from public.predictions p
    join public.matches m on m.id = p.match_id and m.stage = 'group'
    group by p.user_id
    having count(*) >= v_total_group
  ) sub;

  v_body := format('⏰ Cada jogo trava 23h59 da véspera.%s1º jogo trava %s%s',
                   E'\n',
                   to_char(v_first_lock at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24"h"MI'),
                   case
                     when v_days > 1  then format(' (faltam %s dias)', v_days)
                     when v_days = 1  then ' (falta 1 dia!)'
                     when v_days = 0  then ' (é HOJE!)'
                     else ' (prazo do 1º jogo já passou)'
                   end);

  v_body := v_body || E'\n\n📋 PROGRESSO (' || v_total_group || ' jogos de grupo):';

  for r in
    select pr.full_name, coalesce(c.cnt, 0) as cnt
    from public.profiles pr
    left join (
      select p.user_id, count(*) as cnt
      from public.predictions p
      join public.matches m on m.id = p.match_id and m.stage = 'group'
      group by p.user_id
    ) c on c.user_id = pr.id
    order by coalesce(c.cnt, 0) asc, pr.full_name asc
    limit 100
  loop
    v_emoji := case
                 when r.cnt >= v_total_group then '✅'
                 when r.cnt = 0 then '🔴'
                 else '🟡'
               end;
    v_body := v_body || E'\n' || v_emoji || ' ' || r.full_name || ' — ' || r.cnt || '/' || v_total_group;
  end loop;

  v_body := v_body || E'\n\n' || v_complete || '/' || v_total_users || ' fecharam todos os palpites.';

  perform public.send_alert(
    'info',
    'group_completeness',
    format('📋 Palpites de grupo — %s', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM')),
    v_body,
    jsonb_build_object(
      'cta_url', public._site_url(), 'cta_label', 'Fazer meus palpites',
      'complete', v_complete, 'total_users', v_total_users, 'group_total', v_total_group
    ),
    0
  );

  perform public.mark_cron_run('group_completeness');
end $$;

comment on function public.cron_alert_group_completeness is
'Cron diário 09h BRT. Progresso de TODOS os usuários nos palpites de grupo + data limite do 1º jogo.';

-- ============================================================
-- CRON 3: cs_completeness — falta campeão / falta artilheiro
-- ============================================================
create or replace function public.cron_alert_cs_completeness()
returns void
language plpgsql
security definer
as $$
declare
  v_total_users int;
  v_with_champ  int;
  v_with_scorer int;
  v_no_champ    int;
  v_no_scorer   int;
  v_days        int;
  v_dl_txt      text;
  v_body        text;
  r record;
begin
  select count(*) into v_total_users from public.profiles;
  if v_total_users = 0 then return; end if;

  select count(*) into v_with_champ  from public.champion_picks;
  select count(*) into v_with_scorer from public.top_scorer_picks;
  v_no_champ  := v_total_users - v_with_champ;
  v_no_scorer := v_total_users - v_with_scorer;

  v_days := public._days_to_cs_deadline();
  v_dl_txt := to_char(public.cs_deadline() at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24"h"MI');

  v_body := format('⏰ Data limite: %s%s', v_dl_txt,
                   case
                     when v_days > 1  then format(' (faltam %s dias)', v_days)
                     when v_days = 1  then ' (falta 1 dia!)'
                     when v_days = 0  then ' (é HOJE!)'
                     else ' (prazo encerrado)'
                   end);

  if v_no_champ > 0 then
    v_body := v_body || E'\n\n🏆 FALTA ESCOLHER CAMPEÃO (' || v_no_champ || '):';
    for r in
      select pr.full_name
      from public.profiles pr
      left join public.champion_picks cp on cp.user_id = pr.id
      where cp.user_id is null
      order by pr.full_name asc limit 60
    loop
      v_body := v_body || E'\n• ' || r.full_name;
    end loop;
  end if;

  if v_no_scorer > 0 then
    v_body := v_body || E'\n\n⚽ FALTA ESCOLHER ARTILHEIRO (' || v_no_scorer || '):';
    for r in
      select pr.full_name
      from public.profiles pr
      left join public.top_scorer_picks tsp on tsp.user_id = pr.id
      where tsp.user_id is null
      order by pr.full_name asc limit 60
    loop
      v_body := v_body || E'\n• ' || r.full_name;
    end loop;
  end if;

  if v_no_champ = 0 and v_no_scorer = 0 then
    v_body := v_body || E'\n\n🎉 Todo mundo já escolheu campeão e artilheiro!';
  else
    v_body := v_body || format(E'\n\n%s/%s com campeão · %s/%s com artilheiro.',
                               v_with_champ, v_total_users, v_with_scorer, v_total_users);
  end if;

  perform public.send_alert(
    'info',
    'cs_completeness',
    format('🏆 Campeão & ⚽ Artilheiro — %s', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM')),
    v_body,
    jsonb_build_object(
      'cta_url', public._site_url(), 'cta_label', 'Escolher campeão/artilheiro',
      'no_champion', v_no_champ, 'no_scorer', v_no_scorer, 'total_users', v_total_users
    ),
    0
  );

  perform public.mark_cron_run('cs_completeness');
end $$;

comment on function public.cron_alert_cs_completeness is
'Cron diário 09h BRT. Quem falta escolher campeão/artilheiro + data limite (cs_deadline).';

-- ============================================================
-- CRON 4: deadline_countdown — só nos últimos 3 dias do prazo
-- ============================================================
create or replace function public.cron_alert_deadline_countdown()
returns void
language plpgsql
security definer
as $$
declare
  v_days   int;
  v_missing int;
  v_title  text;
  v_lead   text;
  v_body   text;
  v_dl_txt text;
  r record;
begin
  v_days := public._days_to_cs_deadline();
  -- Só dispara na reta final (≤3 dias) e enquanto não passou.
  if v_days < 0 or v_days > 3 then return; end if;

  select count(*) into v_missing
  from public.profiles pr
  where not exists (select 1 from public.champion_picks   cp  where cp.user_id  = pr.id)
     or not exists (select 1 from public.top_scorer_picks tsp where tsp.user_id = pr.id);

  -- Se ninguém está pendente, não precisa cobrar.
  if v_missing = 0 then perform public.mark_cron_run('deadline_countdown'); return; end if;

  v_dl_txt := to_char(public.cs_deadline() at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24"h"MI');

  if v_days = 0 then
    v_title := '🚨 HOJE é o último dia pra travar Campeão & Artilheiro!';
    v_lead  := format('O prazo é HOJE, %s. Depois disso não dá mais pra escolher.', v_dl_txt);
  elsif v_days = 1 then
    v_title := '⏰ Falta 1 dia pra travar Campeão & Artilheiro!';
    v_lead  := format('O prazo é amanhã, %s.', v_dl_txt);
  else
    v_title := format('⏳ Faltam %s dias pra travar Campeão & Artilheiro!', v_days);
    v_lead  := format('O prazo é %s.', v_dl_txt);
  end if;

  v_body := v_lead || E'\n\nAinda sem palpite de campeão e/ou artilheiro:';
  for r in
    select pr.full_name
    from public.profiles pr
    where not exists (select 1 from public.champion_picks   cp  where cp.user_id  = pr.id)
       or not exists (select 1 from public.top_scorer_picks tsp where tsp.user_id = pr.id)
    order by pr.full_name asc limit 60
  loop
    v_body := v_body || E'\n• ' || r.full_name;
  end loop;
  v_body := v_body || E'\n\nNão deixe pra última hora! 👇';

  perform public.send_alert(
    'info',
    'deadline_countdown',
    v_title,
    v_body,
    jsonb_build_object(
      'cta_url', public._site_url(), 'cta_label', 'Garantir meu palpite',
      'days_left', v_days, 'missing', v_missing
    ),
    0
  );

  perform public.mark_cron_run('deadline_countdown');
end $$;

comment on function public.cron_alert_deadline_countdown is
'Cron diário. Cobrança urgente nos últimos 3 dias antes do prazo de campeão/artilheiro.';

-- ============================================================
-- CRON 5: lock_tonight — palpites que travam HOJE 23h59
-- ============================================================
create or replace function public.cron_alert_lock_tonight()
returns void
language plpgsql
security definer
as $$
declare
  v_body  text;
  v_count int := 0;
  r record;
begin
  -- Jogos cujo prazo (véspera 23h59) cai HOJE (BRT) e ainda não acabaram
  -- = jogos de AMANHÃ. Trava à noite de hoje.
  v_body := '🌙 ATENÇÃO: os palpites destes jogos travam HOJE às 23h59!';
  for r in
    select id, team_home, team_away, match_date
    from public.matches m
    where not finished
      and (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date
          = (now() at time zone 'America/Sao_Paulo')::date
    order by match_date asc
    limit 30
  loop
    v_body := v_body || E'\n• ' ||
              to_char(r.match_date at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24"h"MI') ||
              ' — ' || r.team_home || ' x ' || r.team_away;
    v_count := v_count + 1;
  end loop;

  -- Nenhum jogo travando hoje → não manda nada.
  if v_count = 0 then perform public.mark_cron_run('lock_tonight'); return; end if;

  v_body := v_body || E'\n\nAinda dá tempo de palpitar até 23h59. 👇';

  perform public.send_alert(
    'info',
    'lock_tonight',
    format('🌙 Palpites travam hoje — %s jogo(s)', v_count),
    v_body,
    jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Palpitar agora', 'count', v_count),
    0
  );

  perform public.mark_cron_run('lock_tonight');
end $$;

comment on function public.cron_alert_lock_tonight is
'Cron diário 09h BRT. Avisa quais palpites travam hoje 23h59 (jogos de amanhã). Só dispara se houver jogos.';

-- ============================================================
-- CRON 6: daily_recap — resultados das últimas 24h + líder
-- ============================================================
create or replace function public.cron_alert_daily_recap()
returns void
language plpgsql
security definer
as $$
declare
  v_body  text;
  v_count int := 0;
  v_maxpts int;
  v_medals text[] := array['🥇','🥈','🥉'];
  v_i int := 0;
  r record;
begin
  -- Jogos finalizados nas últimas 24h (admin lança resultado manualmente)
  v_body := '📊 RESULTADOS (últimas 24h):';
  for r in
    select team_home, team_away, actual_home, actual_away, pen_winner, match_date
    from public.matches
    where finished
      and finished_at is not null
      and finished_at > now() - interval '24 hours'
    order by match_date asc
    limit 30
  loop
    v_body := v_body || E'\n• ' || r.team_home || ' ' ||
              coalesce(r.actual_home::text, '?') || ' x ' ||
              coalesce(r.actual_away::text, '?') || ' ' || r.team_away ||
              case
                when r.pen_winner = 'home' then ' (pên: ' || r.team_home || ')'
                when r.pen_winner = 'away' then ' (pên: ' || r.team_away || ')'
                else ''
              end;
    v_count := v_count + 1;
  end loop;

  -- Sem jogos novos → não manda nada.
  if v_count = 0 then perform public.mark_cron_run('daily_recap'); return; end if;

  -- Líder do bolão (só faz sentido depois que alguém pontuou)
  select max(total_pts) into v_maxpts from public.v_leaderboard;
  if coalesce(v_maxpts, 0) > 0 then
    v_body := v_body || E'\n\n🏆 TOP DO BOLÃO:';
    for r in
      select full_name, total_pts from public.v_leaderboard
      order by total_pts desc, exact_count desc, winner_sg_count desc
      limit 3
    loop
      v_i := v_i + 1;
      v_body := v_body || E'\n' || v_medals[v_i] || ' ' || r.full_name || ' — ' || r.total_pts || ' pts';
    end loop;
  end if;

  perform public.send_alert(
    'info',
    'daily_recap',
    format('📊 Resumo do dia — %s', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM')),
    v_body,
    jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Ver classificação', 'matches', v_count),
    0
  );

  perform public.mark_cron_run('daily_recap');
end $$;

comment on function public.cron_alert_daily_recap is
'Cron diário (manhã). Resultados lançados nas últimas 24h + top 3 do bolão. Só dispara se houve jogo.';

-- ============================================================
-- CRON 7: heartbeat — avisa (admin/warn) se um cron diário parou
-- ============================================================
create or replace function public.cron_heartbeat()
returns void
language plpgsql
security definer
as $$
declare
  v_name text;
  v_last timestamptz;
  v_stale text := '';
  v_names text[] := array['daily_payments','group_completeness','cs_completeness'];
begin
  foreach v_name in array v_names loop
    select (trim(both '"' from (value #>> '{}')))::timestamptz into v_last
    from public.settings where key = 'cron_lastrun_' || v_name;

    if v_last is null or v_last < now() - interval '26 hours' then
      v_stale := v_stale || E'\n• ' || v_name || ': ' ||
                 coalesce(to_char(v_last at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'nunca rodou');
    end if;
  end loop;

  if v_stale <> '' then
    perform public.send_alert(
      'warn',
      'cron_heartbeat',
      'Cron(s) de alerta diário possivelmente parado(s)',
      'Os seguintes crons não rodam há mais de 26h:' || v_stale ||
      E'\n\nVerifique pg_cron (cron.job / cron.job_run_details) no dashboard.',
      jsonb_build_object('stale', v_stale),
      21600  -- dedup 6h pra não floodar
    );
  end if;
end $$;

comment on function public.cron_heartbeat is
'Cron a cada 6h. Dead-man-switch: avisa admin (warn) se daily_payments/group/cs não rodaram em 26h.';

-- ============================================================
-- Seed: marca os crons diários como "rodaram agora" pra evitar
-- falso-positivo do heartbeat logo após o deploy.
-- ============================================================
select public.mark_cron_run('daily_payments');
select public.mark_cron_run('group_completeness');
select public.mark_cron_run('cs_completeness');

-- ============================================================
-- Agendamento via pg_cron (UTC). 12:00 UTC = 09:00 BRT.
-- Manhã escalonada em minutos pra mensagens chegarem em ordem.
-- ============================================================
do $$
begin
  begin perform cron.unschedule('alerts_daily_payments');     exception when others then null; end;
  begin perform cron.unschedule('alerts_group_completeness'); exception when others then null; end;
  begin perform cron.unschedule('alerts_cs_completeness');    exception when others then null; end;
  begin perform cron.unschedule('alerts_deadline_countdown'); exception when others then null; end;
  begin perform cron.unschedule('alerts_lock_tonight');       exception when others then null; end;
  begin perform cron.unschedule('alerts_daily_recap');        exception when others then null; end;
  begin perform cron.unschedule('alerts_heartbeat');          exception when others then null; end;
end $$;

select cron.schedule('alerts_daily_payments',     '0 12 * * *',  $cmd$ select public.cron_alert_daily_payments(); $cmd$);
select cron.schedule('alerts_group_completeness', '1 12 * * *',  $cmd$ select public.cron_alert_group_completeness(); $cmd$);
select cron.schedule('alerts_cs_completeness',    '2 12 * * *',  $cmd$ select public.cron_alert_cs_completeness(); $cmd$);
select cron.schedule('alerts_deadline_countdown', '3 12 * * *',  $cmd$ select public.cron_alert_deadline_countdown(); $cmd$);
select cron.schedule('alerts_lock_tonight',       '4 12 * * *',  $cmd$ select public.cron_alert_lock_tonight(); $cmd$);
-- Recap de manhã cedo (08:30 BRT = 11:30 UTC): pega jogos lançados de madrugada.
select cron.schedule('alerts_daily_recap',        '30 11 * * *', $cmd$ select public.cron_alert_daily_recap(); $cmd$);
-- Heartbeat a cada 6h.
select cron.schedule('alerts_heartbeat',          '0 */6 * * *', $cmd$ select public.cron_heartbeat(); $cmd$);

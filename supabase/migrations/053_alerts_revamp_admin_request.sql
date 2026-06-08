-- ============================================================
-- Migration 053: Revamp dos alertas do Telegram (pedido do admin)
-- ============================================================
-- Ajuste fino de TODOS os alertas voltados aos participantes, a partir de uma
-- revisão item-a-item. Reusa send_alert (007/045), os helpers da 026/042 e as
-- views v_leaderboard/v_pool_stats. NÃO toca nos alertas de bug/segurança da
-- 007, nem no fio client_error (048/049). Idempotente (CREATE OR REPLACE / DROP
-- IF EXISTS / unschedule protegido).
--
-- DECISÕES (numeração = catálogo de alertas):
--   MANTÉM inalterado: 1 signup_success · 2 signup_failure · 8 daily_payments
--                      · 10 cs_completeness · 11 deadline_countdown
--   REMOVE:  4 result_corrected · 6 champion_revealed · 7 ko_phase_opens
--            · 12 lock_tonight (dobrado no #9) · 14 round_movers (dobrado no #13)
--            · 18 inactive_paid
--   MODIFICA:
--     3  result_confirmed     → link p/ /historico.html ("ver pontuações dos outros")
--     5  match_status         → no adiado, mostra DATA ANTERIOR + NOVA DATA
--     9  group_completeness   → QUEBRADO EM 2 MSGS por janela: ≤24h e 1–3 dias
--                               (cada uma lista pessoa + jogos; absorve o lock_tonight)
--     13 daily_recap          → + quem mais pontuou (24h) + placares exatos do dia
--                               + gap no topo + link /historico.html
--     15 leader_change        → + vantagem pro 2º + % de pontos ainda em jogo
--     16 group_stage_done     → + gap no pódio + % de pontos restante (dinâmico)
--     17 pool_settled         → + gap no pódio + placares exatos do campeão
--   ADICIONA (admin):
--     cron_job_failure        → ⚠️ avisa quando uma execução de pg_cron FALHA
--                               (complementa o heartbeat, que só pega "parou há 26h")
--
-- LINKS: por decisão do admin, os alertas de RESULTADO/RANKING apontam pro
--   /historico.html ("ver pontuações dos outros"). Os de "vá palpitar" (#9/#10/#11)
--   e cadastro/pagamento (#1/#8) seguem na home — mandar quem está SEM palpite
--   pra tela de pontuação dos outros seria contraditório.
--
-- KEEP IN SYNC: scripts/e2e/{playout.sql,seed-scale.js,seed-harness-state.js}
--   (listas de triggers de alerta — os 3 removidos saíram de lá nesta mesma mudança).

-- ============================================================
-- Helpers novos
-- ============================================================

-- URL da página de histórico/pontuações (CTA dos alertas de ranking).
create or replace function public._historico_url()
returns text language sql stable as $$
  select rtrim(public._site_url(), '/') || '/historico.html';
$$;

-- Peso máximo de placar por fase (mesma tabela do README; soma = 1129).
create or replace function public._stage_max_pts(s text)
returns int language sql immutable as $$
  select case s
    when 'group' then 7  when 'r32'   then 9  when 'r16' then 19
    when 'qf'    then 32 when 'sf'    then 50 when 'third' then 25
    when 'final' then 76 else 0 end;
$$;

-- % dos pontos de PLACAR ainda em jogo (jogos não finalizados ÷ total),
-- ponderado pelo peso da fase. Ex.: pós-grupos ≈ 55%. 0 quando tudo acabou.
create or replace function public._match_pts_remaining_pct()
returns int language sql stable as $$
  select coalesce(round(
    100.0
    * coalesce(sum(public._stage_max_pts(stage)) filter (where not finished and status <> 'void'), 0)
    / nullif(sum(public._stage_max_pts(stage)) filter (where status <> 'void'), 0)
  )::int, 0)
  from public.matches;
$$;

-- ============================================================
-- REMOÇÕES (idempotentes)
-- ============================================================
drop trigger if exists trg_z_alert_result_corrected on public.matches;
drop function if exists public.alert_result_corrected();

drop trigger if exists trg_z_alert_champion_revealed on public.matches;
drop function if exists public.alert_champion_revealed();

drop trigger if exists trg_z_alert_ko_phase_opens on public.matches;
drop function if exists public.alert_ko_phase_opens();

do $$
begin
  begin perform cron.unschedule('alerts_lock_tonight');  exception when others then null; end;
  begin perform cron.unschedule('alerts_round_movers');  exception when others then null; end;
  begin perform cron.unschedule('alerts_inactive_paid'); exception when others then null; end;
end $$;
drop function if exists public.cron_alert_lock_tonight();
drop function if exists public.cron_alert_round_movers();
drop function if exists public.cron_alert_inactive_paid();

-- ============================================================
-- #3 result_confirmed — fim de jogo + link p/ histórico
-- ============================================================
create or replace function public.alert_result_confirmed()
returns trigger
language plpgsql
security definer
as $$
declare
  v_exact int; v_winner int; v_total int;
  v_body text; v_pen text := '';
begin
  if new.finished is not true then return new; end if;
  if old.finished is true then return new; end if;
  if new.status = 'void' then return new; end if;
  if new.actual_home is null or new.actual_away is null then return new; end if;
  -- A final TAMBÉM entra aqui agora (o champion_revealed foi removido na 053).

  select count(*) into v_total
  from public.predictions p
  join public.profiles pr on pr.id = p.user_id and pr.paid
  where p.match_id = new.id;

  select count(*) into v_exact
  from public.predictions p
  join public.profiles pr on pr.id = p.user_id and pr.paid
  where p.match_id = new.id
    and p.pred_home = new.actual_home and p.pred_away = new.actual_away;

  if    new.pen_winner = 'home' then v_pen := ' (pên: ' || new.team_home || ')';
  elsif new.pen_winner = 'away' then v_pen := ' (pên: ' || new.team_away || ')';
  end if;

  v_body := format('✅ Resultado oficial: %s %s x %s %s%s',
                   new.team_home, new.actual_home, new.actual_away, new.team_away, v_pen);

  if v_total > 0 then
    if v_exact > 0 then
      v_body := v_body || E'\n\n🎯 ' || v_exact || ' de ' || v_total || ' cravaram o placar exato!';
    else
      v_body := v_body || E'\n\nNinguém cravou o placar exato dessa vez.';
    end if;
  end if;

  if new.stage <> 'group' and v_total > 0 then
    select count(*) into v_winner
    from public.predictions p
    join public.profiles pr on pr.id = p.user_id and pr.paid
    where p.match_id = new.id
      and (case when p.pred_home > p.pred_away then 'h' when p.pred_away > p.pred_home then 'a'
                when p.pred_pen_winner is not null then p.pred_pen_winner else 'd' end)
        = (case when new.actual_home > new.actual_away then 'h' when new.actual_away > new.actual_home then 'a'
                when new.pen_winner is not null then new.pen_winner else 'd' end);
    v_body := v_body || E'\n🛡️ ' || v_winner || ' acertaram quem avançou.';
  end if;

  v_body := v_body || E'\n\nPontos recalculados e lacrados. 🔒';
  v_body := v_body || E'\n\n👉 Para ver as pontuações dos outros participantes, acesse:';

  perform public.send_alert(
    'info', 'result_confirmed',
    format('✅ Fim de jogo: %s x %s', new.team_home, new.team_away),
    v_body,
    jsonb_build_object('cta_url', public._historico_url(),
                       'match_id', new.id, 'exact', v_exact),
    120
  );
  return new;
end $$;
-- (trigger trg_z_alert_result_confirmed já existe da 042; CREATE OR REPLACE basta)

-- ============================================================
-- #5 match_status — anulado / adiado (adiado mostra data anterior + nova)
-- ============================================================
create or replace function public.alert_match_status_changed()
returns trigger
language plpgsql
security definer
as $$
declare v_title text; v_body text; v_old text; v_new text;
begin
  if old.status is not distinct from new.status then return new; end if;
  if new.status not in ('void', 'postponed') then return new; end if;

  v_old := to_char(old.match_date at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24"h"MI');
  v_new := to_char(new.match_date at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24"h"MI');

  if new.status = 'void' then
    v_title := format('🚫 Jogo anulado: %s x %s', new.team_home, new.team_away);
    v_body  := format('O jogo %s x %s (%s) foi ANULADO. Ele não vale pontos pra ninguém e saiu do cálculo da classificação — os palpites desse jogo ficam sem efeito para todos, por igual.',
                      new.team_home, new.team_away, v_old);
  else
    v_title := format('⏳ Jogo adiado: %s x %s', new.team_home, new.team_away);
    v_body  := format('O jogo %s x %s foi ADIADO.', new.team_home, new.team_away)
               || E'\n📅 Data anterior: ' || v_old
               || (case when new.match_date is distinct from old.match_date
                        then E'\n📅 Nova data: ' || v_new
                        else E'\n📅 Nova data: a definir' end)
               || E'\n\nO prazo de palpite acompanha a nova data (trava 23h59 da véspera). Por enquanto nada muda na sua pontuação.';
  end if;

  perform public.send_alert(
    'info', 'match_status', v_title, v_body,
    jsonb_build_object('cta_url', public._site_url(),
                       'match_id', new.id, 'status', new.status),
    60
  );
  return new;
end $$;
-- (trigger trg_z_alert_match_status já existe da 042; CREATE OR REPLACE basta)

-- ============================================================
-- #9 group_completeness — QUEBRADO EM 2 MSGS por janela de trava
--   Msg 1: travam HOJE 23h59 (≤24h)         → urgência
--   Msg 2: travam em 1 a 3 dias              → próximos
-- Cada msg: lista PESSOA + os JOGOS que ela ainda não palpitou. Silenciosa se vazia.
-- Absorve o antigo lock_tonight (#12).
-- ============================================================
create or replace function public.cron_alert_group_completeness()
returns void
language plpgsql
security definer
as $$
declare
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_body  text;
  v_n     int;
  v_cur   date;
  r record;
begin
  -- ===== MSG 1: TRAVAM HOJE ÀS 23H59 (≤24h) — todos a mesma data =====
  -- Lista por PESSOA (cada nome 1x): "• Fulano — Jogo A, Jogo B".
  v_body := ''; v_n := 0;
  for r in
    select pr.full_name,
           string_agg(m.team_home || ' x ' || m.team_away, ', ' order by m.match_date) as games
    from public.profiles pr
    join public.matches m
      on not m.finished and m.status <> 'void'
     and (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date = v_today
     and not exists (
           select 1 from public.predictions p
           where p.user_id = pr.id and p.match_id = m.id)
    group by pr.id, pr.full_name
    order by pr.full_name asc
  loop
    v_body := v_body || E'\n• ' || r.full_name || ' — ' || r.games;
    v_n := v_n + 1;
  end loop;

  if v_n > 0 then
    perform public.send_alert(
      'info', 'group_lock_24h',
      '🚨 Palpites travam HOJE às 23h59',
      'Ainda sem palpite (estes jogos fecham hoje à meia-noite):'
        || E'\n' || v_body
        || E'\n\n👉 Dá tempo: abra e palpite antes das 23h59.',
      jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Fazer meus palpites', 'count', v_n),
      0
    );
  end if;

  -- ===== MSG 2: TRAVAM EM 1 A 3 DIAS — agrupado por DIA de trava =====
  -- Cabeçalho "📅 Trava DD/MM" → pessoas (com seus jogos) embaixo.
  v_body := ''; v_n := 0; v_cur := null;
  for r in
    select (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date as lock_date,
           pr.full_name,
           string_agg(m.team_home || ' x ' || m.team_away, ', ' order by m.match_date) as games
    from public.profiles pr
    join public.matches m
      on not m.finished and m.status <> 'void'
     and (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date
         between v_today + 1 and v_today + 3
     and not exists (
           select 1 from public.predictions p
           where p.user_id = pr.id and p.match_id = m.id)
    group by lock_date, pr.id, pr.full_name
    order by lock_date asc, pr.full_name asc
  loop
    if v_cur is null or r.lock_date <> v_cur then
      v_body := v_body || E'\n\n📅 Trava ' || to_char(r.lock_date, 'DD/MM')
                || case when r.lock_date = v_today + 1 then ' (amanhã)' else '' end || ':';
      v_cur := r.lock_date;
    end if;
    v_body := v_body || E'\n• ' || r.full_name || ' — ' || r.games;
    v_n := v_n + 1;
  end loop;

  if v_n > 0 then
    perform public.send_alert(
      'info', 'group_lock_3d',
      '⏳ Palpites travando nos próximos dias',
      'Cada jogo trava às 23h59 da véspera. Ainda sem palpite:'
        || v_body
        || E'\n\n👉 Não deixe acumular — palpite com antecedência.',
      jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Fazer meus palpites', 'count', v_n),
      0
    );
  end if;

  perform public.mark_cron_run('group_completeness');
end $$;

comment on function public.cron_alert_group_completeness is
'Cron diário 09h BRT. DUAS mensagens: (1) quem está sem palpite em jogos que travam HOJE 23h59; (2) quem está sem palpite em jogos que travam em 1–3 dias. Cada uma lista pessoa + jogos. Silenciosa se vazia. Absorve o lock_tonight.';

-- ============================================================
-- #13 daily_recap — resultados 24h + destaques + exatos + topo (link histórico)
-- ============================================================
create or replace function public.cron_alert_daily_recap()
returns void
language plpgsql
security definer
as $$
declare
  v_body text; v_count int := 0; v_exact_day int := 0;
  v_maxpts int; v_medals text[] := array['🥇','🥈','🥉']; v_i int := 0; v_prev int;
  r record;
begin
  -- Resultados das últimas 24h
  v_body := '📊 RESULTADOS (últimas 24h):';
  for r in
    select team_home, team_away, actual_home, actual_away, pen_winner, match_date
    from public.matches
    where finished and status <> 'void' and finished_at is not null
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

  if v_count = 0 then perform public.mark_cron_run('daily_recap'); return; end if;

  -- Quantos placares exatos foram cravados nesses jogos (pagantes)
  select count(*) into v_exact_day
  from public.predictions p
  join public.matches m on m.id = p.match_id and m.finished and m.status <> 'void'
       and m.finished_at > now() - interval '24 hours'
  join public.profiles pr on pr.id = p.user_id and pr.paid
  where p.pred_home = m.actual_home and p.pred_away = m.actual_away;
  if v_exact_day > 0 then
    v_body := v_body || E'\n\n🎯 ' || v_exact_day || ' placar(es) exato(s) cravado(s) no período.';
  end if;

  -- Quem mais pontuou nas últimas 24h (absorve o antigo round_movers)
  v_i := 0;
  for r in
    select pr.full_name, sum(p.points_earned)::int as pts
    from public.predictions p
    join public.matches m on m.id = p.match_id and m.finished and m.status <> 'void'
         and m.finished_at > now() - interval '24 hours'
    join public.profiles pr on pr.id = p.user_id and pr.paid
    where p.points_earned is not null
    group by pr.full_name
    having sum(p.points_earned) > 0
    order by pts desc, pr.full_name asc
    limit 3
  loop
    v_i := v_i + 1;
    if v_i = 1 then v_body := v_body || E'\n\n🔥 QUEM MAIS PONTUOU (24h):'; end if;
    v_body := v_body || E'\n' || coalesce(v_medals[v_i], '•') || ' ' || r.full_name || ' — +' || r.pts || ' pts';
  end loop;

  -- Top do bolão (com gap pro líder)
  select max(total_pts) into v_maxpts from public.v_leaderboard;
  if coalesce(v_maxpts, 0) > 0 then
    v_body := v_body || E'\n\n🏆 TOP DO BOLÃO:';
    v_i := 0; v_prev := null;
    for r in
      select full_name, total_pts from public.v_leaderboard
      order by total_pts desc, exact_count desc, winner_sg_count desc
      limit 3
    loop
      v_i := v_i + 1;
      v_body := v_body || E'\n' || v_medals[v_i] || ' ' || r.full_name || ' — ' || r.total_pts || ' pts'
                || case when v_prev is not null and r.total_pts < v_prev
                        then ' (-' || (v_prev - r.total_pts) || ')' else '' end;
      v_prev := r.total_pts;
    end loop;
  end if;

  v_body := v_body || E'\n\n👉 Para ver as pontuações dos outros participantes, acesse:';

  perform public.send_alert(
    'info', 'daily_recap',
    format('📊 Resumo do dia — %s', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM')),
    v_body,
    jsonb_build_object('cta_url', public._historico_url(), 'matches', v_count),
    0
  );
  perform public.mark_cron_run('daily_recap');
end $$;

comment on function public.cron_alert_daily_recap is
'Cron diário (08h30 BRT). Resultados 24h + nº de exatos do dia + quem mais pontuou (24h) + top 3 com gap. Link p/ /historico.html. Silencioso se não houve jogo.';

-- ============================================================
-- #15 leader_change — nova liderança + vantagem + pontos em jogo
-- ============================================================
create or replace function public.cron_alert_leader_change()
returns void
language plpgsql
security definer
as $$
declare
  v_uid uuid; v_name text; v_pts int; v_prev uuid; v_prev_name text;
  v_recent int; v_second int; v_margin int; v_rem int; v_body text;
begin
  select count(*) into v_recent from public.matches
   where finished and status <> 'void' and finished_at > now() - interval '24 hours';
  if v_recent = 0 then perform public.mark_cron_run('leader_change'); return; end if;

  select user_id, full_name, total_pts into v_uid, v_name, v_pts
  from public.v_leaderboard limit 1;
  if v_uid is null or coalesce(v_pts, 0) <= 0 then perform public.mark_cron_run('leader_change'); return; end if;

  select trim(both '"' from (value #>> '{}'))::uuid into v_prev
  from public.settings where key = 'last_leader_user_id';

  if v_prev is null then
    insert into public.settings(key, value) values('last_leader_user_id', to_jsonb(v_uid::text))
      on conflict (key) do update set value = excluded.value, updated_at = now();
    perform public.mark_cron_run('leader_change'); return;
  end if;

  if v_prev = v_uid then perform public.mark_cron_run('leader_change'); return; end if;

  select full_name into v_prev_name from public.profiles where id = v_prev;
  select total_pts into v_second from public.v_leaderboard offset 1 limit 1;
  v_margin := v_pts - coalesce(v_second, 0);
  v_rem := public._match_pts_remaining_pct();

  v_body := format('%s assumiu a liderança com %s pts, passando %s! 🔥',
                   v_name, v_pts, coalesce(v_prev_name, 'o antigo líder'));
  if v_margin > 0 then
    v_body := v_body || format(E'\n\n📊 Vantagem de %s pts pro 2º lugar.', v_margin);
  else
    v_body := v_body || E'\n\n📊 Empate em pontos no topo — desempate no detalhe (placares exatos)!';
  end if;
  if v_rem > 0 then
    v_body := v_body || format(E'\n📈 Ainda restam ~%s%% dos pontos de placar em jogo. Tudo pode virar!', v_rem);
  end if;
  v_body := v_body || E'\n\n👉 Para ver as pontuações dos outros participantes, acesse:';

  perform public.send_alert(
    'info', 'leader_change',
    '🔄 Temos um novo líder no bolão!',
    v_body,
    jsonb_build_object('cta_url', public._historico_url(), 'leader', v_name, 'pts', v_pts),
    0
  );

  insert into public.settings(key, value) values('last_leader_user_id', to_jsonb(v_uid::text))
    on conflict (key) do update set value = excluded.value, updated_at = now();
  perform public.mark_cron_run('leader_change');
end $$;

comment on function public.cron_alert_leader_change is
'Cron diário pós-recap (08h36 BRT). Troca de liderança + vantagem pro 2º + % de pontos ainda em jogo. Só dispara se houve jogo nas 24h e o líder mudou.';

-- ============================================================
-- #16 group_stage_done — fim dos grupos + pódio com gap + % dinâmico
-- ============================================================
create or replace function public.cron_alert_group_stage_done()
returns void
language plpgsql
security definer
as $$
declare
  v_total int; v_done int; v_body text; v_i int := 0; v_prev int;
  v_medals text[] := array['🥇','🥈','🥉']; v_rem int; r record;
begin
  if public._milestone_seen('group_stage_done') then return; end if;

  select count(*), count(*) filter (where finished or status = 'void')
    into v_total, v_done
  from public.matches where stage = 'group';
  if v_total = 0 or v_done < v_total then return; end if;

  v_body := 'A fase de grupos acabou! 🏁 Hora do mata-mata.';
  v_i := 0; v_prev := null;
  for r in
    select full_name, total_pts from public.v_leaderboard
    order by total_pts desc, exact_count desc, winner_sg_count desc limit 3
  loop
    v_i := v_i + 1;
    if v_i = 1 then v_body := v_body || E'\n\n🏆 LÍDER PROVISÓRIO (prêmio parcial):'; end if;
    v_body := v_body || E'\n' || v_medals[v_i] || ' ' || r.full_name || ' — ' || r.total_pts || ' pts'
              || case when v_prev is not null and r.total_pts < v_prev
                      then ' (-' || (v_prev - r.total_pts) || ')' else '' end;
    v_prev := r.total_pts;
  end loop;

  v_rem := public._match_pts_remaining_pct();
  v_body := v_body || format(E'\n\nMas calma: ainda restam ~%s%% dos pontos de placar no mata-mata. Tudo pode virar! 🔥', v_rem);
  v_body := v_body || E'\n\n👉 Para ver as pontuações dos outros participantes, acesse:';

  perform public.send_alert(
    'info', 'group_stage_done',
    '🏁 Fase de grupos encerrada!',
    v_body,
    jsonb_build_object('cta_url', public._historico_url()),
    0
  );
  perform public._mark_milestone('group_stage_done');
  perform public.mark_cron_run('group_stage_done');
end $$;

comment on function public.cron_alert_group_stage_done is
'Cron diário (09h10 BRT). Milestone set-once: fim dos grupos + líder provisório (pódio c/ gap) + % de pontos restante (dinâmico). Link /historico.html.';

-- ============================================================
-- #17 pool_settled — pódio final + premiação + gap + exatos do campeão
-- ============================================================
create or replace function public.cron_alert_pool_settled()
returns void
language plpgsql
security definer
as $$
declare
  v_fin record; v_pot numeric; v_split jsonb;
  v_first numeric; v_second numeric; v_third numeric;
  v_body text; v_i int := 0; v_medals text[] := array['🥇','🥈','🥉']; r record;
  v_pts int[]; v_names text[]; v_champ_exact int;
begin
  if public._milestone_seen('pool_settled') then return; end if;

  select finished, status into v_fin from public.matches where stage = 'final' limit 1;
  if v_fin is null or v_fin.finished is not true or v_fin.status = 'void' then return; end if;

  select total_pot into v_pot from public.v_pool_stats;
  select value into v_split from public.settings where key = 'prize_split';
  v_first  := coalesce((v_split->>'first')::numeric, 70);
  v_second := coalesce((v_split->>'second')::numeric, 20);
  v_third  := coalesce((v_split->>'third')::numeric, 10);

  v_body := '🏁 É OFICIAL — o bolão da Copa 2026 chegou ao fim! Pódio final:';
  for r in
    select full_name, total_pts, exact_count from public.v_leaderboard
    order by total_pts desc, exact_count desc, winner_sg_count desc limit 3
  loop
    v_i := v_i + 1;
    v_body := v_body || E'\n' || v_medals[v_i] || ' ' || r.full_name || ' — ' || r.total_pts || ' pts'
              || case when v_i > 1 and v_pts[v_i-1] > r.total_pts
                      then ' (-' || (v_pts[v_i-1] - r.total_pts) || ')' else '' end;
    v_pts[v_i] := r.total_pts; v_names[v_i] := r.full_name;
    if v_i = 1 then v_champ_exact := r.exact_count; end if;
  end loop;
  if v_i = 0 then perform public.mark_cron_run('pool_settled'); return; end if;

  if coalesce(v_pot, 0) > 0 then
    v_body := v_body || E'\n\n💰 PREMIAÇÃO (caixa R$ ' || public._fmt_int(v_pot) || '):';
    if v_i >= 1 then v_body := v_body || E'\n🥇 ' || v_names[1] || ' — R$ ' || public._fmt_int(v_pot * v_first  / 100); end if;
    if v_i >= 2 then v_body := v_body || E'\n🥈 ' || v_names[2] || ' — R$ ' || public._fmt_int(v_pot * v_second / 100); end if;
    if v_i >= 3 then v_body := v_body || E'\n🥉 ' || v_names[3] || ' — R$ ' || public._fmt_int(v_pot * v_third  / 100); end if;
  end if;

  if coalesce(v_champ_exact, 0) > 0 then
    v_body := v_body || format(E'\n\n🎯 O campeão do bolão cravou %s placar(es) exato(s) na Copa.', v_champ_exact);
  end if;

  if v_i >= 2 and v_pts[1] = v_pts[2] then
    v_body := v_body || E'\n\n⚖️ Empate em pontos no topo! Desempate pelo nº de placares exatos (e depois vencedor+saldo).';
  end if;

  v_body := v_body || E'\n\nObrigado a todos que jogaram! 🏆 Até a próxima Copa.';
  v_body := v_body || E'\n\n👉 Para ver a classificação final completa, acesse:';

  perform public.send_alert(
    'info', 'pool_settled',
    '🏆 Resultado FINAL do bolão — pódio + premiação',
    v_body,
    jsonb_build_object('cta_url', public._historico_url()),
    0
  );
  perform public._mark_milestone('pool_settled');
  perform public.mark_cron_run('pool_settled');
end $$;

comment on function public.cron_alert_pool_settled is
'Cron diário (09h15 BRT). Milestone set-once: pódio final c/ gap + premiação R$ + placares exatos do campeão + desempate. Link /historico.html.';

-- ============================================================
-- ADMIN: cron_job_failure — avisa quando uma execução de pg_cron FALHA
-- Complementa o heartbeat (026), que só detecta "parou há >26h", não erros.
-- ============================================================
create or replace function public.cron_check_job_failures(p_window_minutes int default 70)
returns int
language plpgsql
security definer
as $$
declare v_n int; v_body text := ''; r record;
begin
  select count(*) into v_n
  from cron.job_run_details d
  where d.status = 'failed'
    and d.end_time > now() - (p_window_minutes || ' minutes')::interval;

  if coalesce(v_n, 0) = 0 then return 0; end if;

  v_body := format('%s execução(ões) de cron falharam na última hora:', v_n);
  for r in
    select coalesce(j.jobname, d.jobid::text) as jobname,
           left(coalesce(d.return_message, '(sem mensagem)'), 140) as msg
    from cron.job_run_details d
    left join cron.job j on j.jobid = d.jobid
    where d.status = 'failed'
      and d.end_time > now() - (p_window_minutes || ' minutes')::interval
    order by d.end_time desc
    limit 10
  loop
    v_body := v_body || E'\n• ' || r.jobname || ' — ' || r.msg;
  end loop;
  v_body := v_body || E'\n\nVeja cron.job_run_details no dashboard pra investigar.';

  perform public.send_alert(
    'warn', 'cron_job_failure',
    format('%s job(s) de cron falharam', v_n),
    v_body,
    jsonb_build_object('failed', v_n),
    3600  -- dedup 1h por nº de falhas
  );
  return v_n;
exception when others then
  -- cron.job_run_details pode não estar acessível em alguns ambientes; não propaga.
  raise warning '[cron_check_job_failures] %', sqlerrm;
  return 0;
end $$;

comment on function public.cron_check_job_failures is
'Cron horário. Avisa o admin (⚠️ warn) quando alguma execução de pg_cron falhou na última hora (cron.job_run_details.status=failed). Complementa o heartbeat.';

-- ============================================================
-- Agendamento (UTC). Mantém os horários da 026/042; só remove os 3 crons
-- apagados e adiciona o cron_job_failure (de hora em hora, no minuto 15).
-- ============================================================
do $$
begin
  begin perform cron.unschedule('alerts_cron_job_failures'); exception when others then null; end;
end $$;

select cron.schedule('alerts_cron_job_failures', '15 * * * *',
  $cmd$ select public.cron_check_job_failures(); $cmd$);

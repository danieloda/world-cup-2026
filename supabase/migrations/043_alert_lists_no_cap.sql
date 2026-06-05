-- ============================================================
-- Migration 043: remove o CAP das listas de USUÁRIOS nos alertas
-- ============================================================
-- Pedido: as listas de cobrança/celebração devem mostrar SEMPRE TODOS os
-- usuários, sem teto. Reaplica as funções tirando os `limit N` das listas de
-- nomes de gente. CREATE OR REPLACE — não mexe em triggers nem em agendamento.
--
-- REMOVE cap das listas de USUÁRIOS:
--   • daily_payments      → JÁ PAGARAM / FALTAM PAGAR        (era 60)
--   • cs_completeness     → falta campeão / falta artilheiro (era 60)
--   • deadline_countdown  → pendentes de campeão/artilheiro  (era 60)
--   • group_completeness  → trava hoje / trava amanhã        (era 100)
--   • champion_revealed   → quem cravou o campeão            (era 40)
--   • inactive_paid       → pagos sem nenhum palpite          (era 60)
--
-- MANTÉM (não são listas de "todos os usuários"):
--   • round_movers, group_stage_done, pool_settled → top 3 (medalhas 🥇🥈🥉)
--   • daily_recap → top 3 + jogos
--   • lock_tonight / ko_phase_opens → listas de JOGOS (cap de jogos), não de gente
--
-- ⚠️ Telegram corta msg em 4096 chars. Com pool de dezenas isso é tranquilo;
--    se um dia passar de ~100 nomes numa seção, a msg pode estourar — aí vale
--    paginar. Pra um bolão de amigos não chega lá.

-- ============================================================
-- daily_payments — sem cap nas duas listas
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
  v_split jsonb;
  v_p1 numeric; v_p2 numeric; v_p3 numeric;
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

  -- Quem já pagou (TODOS)
  if v_paid > 0 then
    v_body := v_body || E'\n\n✅ JÁ PAGARAM (' || v_paid || '):';
    for r in
      select full_name from public.profiles where paid
      order by full_name asc
    loop
      v_body := v_body || E'\n• ' || r.full_name;
    end loop;
  end if;

  -- Quem falta pagar (TODOS)
  if v_paid < v_total then
    v_body := v_body || E'\n\n⏳ FALTAM PAGAR (' || (v_total - v_paid) || '):';
    for r in
      select full_name from public.profiles where not paid
      order by full_name asc
    loop
      v_body := v_body || E'\n• ' || r.full_name;
    end loop;
  else
    v_body := v_body || E'\n\n🎉 Todo mundo já pagou!';
  end if;

  if v_pix <> '' then
    v_pix_line := format(E'\n\n💸 Inscrição R$ %s · PIX: %s',
                         public._fmt_int(v_fee), v_pix);
  else
    v_pix_line := format(E'\n\n💸 Inscrição R$ %s', public._fmt_int(v_fee));
  end if;
  v_body := v_body || v_pix_line;

  -- Premiação ESTIMADA com a caixa atual (prize_split × caixa). Cresce a cada pagamento.
  if v_pot > 0 then
    select value into v_split from public.settings where key = 'prize_split';
    v_p1 := v_pot * coalesce((v_split->>'first')::numeric,  70) / 100;
    v_p2 := v_pot * coalesce((v_split->>'second')::numeric, 20) / 100;
    v_p3 := v_pot * coalesce((v_split->>'third')::numeric,  10) / 100;
    v_body := v_body
      || E'\n\n🏆 PREMIAÇÃO ESTIMADA (com a caixa atual):'
      || E'\n🥇 1º lugar — R$ ' || public._fmt_int(v_p1)
      || E'\n🥈 2º lugar — R$ ' || public._fmt_int(v_p2)
      || E'\n🥉 3º lugar — R$ ' || public._fmt_int(v_p3)
      || E'\n(quanto mais gente pagar, maior o prêmio 💸)';
  end if;

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

-- ============================================================
-- cs_completeness — sem cap (campeão / artilheiro)
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
      order by pr.full_name asc
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
      order by pr.full_name asc
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

-- ============================================================
-- deadline_countdown — sem cap
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
  if v_days < 0 or v_days > 3 then return; end if;

  select count(*) into v_missing
  from public.profiles pr
  where not exists (select 1 from public.champion_picks   cp  where cp.user_id  = pr.id)
     or not exists (select 1 from public.top_scorer_picks tsp where tsp.user_id = pr.id);

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
    order by pr.full_name asc
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

-- ============================================================
-- group_completeness — sem cap (trava hoje / trava amanhã)
-- ============================================================
create or replace function public.cron_alert_group_completeness()
returns void
language plpgsql
security definer
as $$
declare
  v_today      date := (now() at time zone 'America/Sao_Paulo')::date;
  v_urgent     text := '';
  v_warn       text := '';
  v_n_urgent   int  := 0;
  v_n_warn     int  := 0;
  v_body       text;
  v_title      text;
  r record;
begin
  -- 🚨 URGENTE: travam HOJE 23h59
  for r in
    select pr.full_name,
           string_agg(m.team_home || ' x ' || m.team_away, ', '
                      order by m.match_date) as games
    from public.profiles pr
    join public.matches m
      on not m.finished
     and (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date = v_today
     and not exists (
           select 1 from public.predictions p
           where p.user_id = pr.id and p.match_id = m.id
         )
    group by pr.id, pr.full_name
    order by pr.full_name asc
  loop
    if v_n_urgent = 0 then
      v_urgent := E'\n\n🚨 TRAVA HOJE ÀS 23H59 — ainda sem palpite:';
    end if;
    v_urgent := v_urgent || E'\n• ' || r.full_name || ' — ' || r.games;
    v_n_urgent := v_n_urgent + 1;
  end loop;

  -- ⚠️ ATENÇÃO: travam AMANHÃ 23h59
  for r in
    select pr.full_name,
           string_agg(m.team_home || ' x ' || m.team_away, ', '
                      order by m.match_date) as games
    from public.profiles pr
    join public.matches m
      on not m.finished
     and (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date = v_today + 1
     and not exists (
           select 1 from public.predictions p
           where p.user_id = pr.id and p.match_id = m.id
         )
    group by pr.id, pr.full_name
    order by pr.full_name asc
  loop
    if v_n_warn = 0 then
      v_warn := E'\n\n⚠️ TRAVA AMANHÃ ÀS 23H59 — ainda sem palpite:';
    end if;
    v_warn := v_warn || E'\n• ' || r.full_name || ' — ' || r.games;
    v_n_warn := v_n_warn + 1;
  end loop;

  if v_n_urgent = 0 and v_n_warn = 0 then
    perform public.mark_cron_run('group_completeness');
    return;
  end if;

  if v_n_urgent > 0 then
    v_title := '🚨 Palpites travando — não deixe pra última hora!';
  else
    v_title := '⚠️ Palpites travando amanhã';
  end if;

  v_body := 'Lembrete: cada jogo trava às 23h59 da véspera.'
            || v_urgent || v_warn
            || E'\n\nAinda dá tempo — é só abrir e palpitar. 👇';

  perform public.send_alert(
    'info',
    'group_completeness',
    v_title,
    v_body,
    jsonb_build_object(
      'cta_url', public._site_url(), 'cta_label', 'Fazer meus palpites',
      'urgent_count', v_n_urgent, 'warn_count', v_n_warn
    ),
    0
  );

  perform public.mark_cron_run('group_completeness');
end $$;

-- ============================================================
-- champion_revealed — sem cap em quem cravou o campeão
-- ============================================================
create or replace function public.alert_champion_revealed()
returns trigger
language plpgsql
security definer
as $$
declare
  v_champ text; v_n int; v_total int; v_body text; v_pen text := ''; r record;
begin
  if new.stage <> 'final' then return new; end if;
  if new.finished is not true then return new; end if;
  if old.finished is true then return new; end if;
  if new.status = 'void' then return new; end if;
  if new.actual_home is null or new.actual_away is null then return new; end if;
  if public._milestone_seen('champion_revealed') then return new; end if;

  if    new.actual_home > new.actual_away then v_champ := new.team_home;
  elsif new.actual_away > new.actual_home then v_champ := new.team_away;
  elsif new.pen_winner = 'home' then v_champ := new.team_home; v_pen := ' (nos pênaltis)';
  elsif new.pen_winner = 'away' then v_champ := new.team_away; v_pen := ' (nos pênaltis)';
  else return new;
  end if;

  select count(*) into v_total
  from public.champion_picks cp join public.profiles pr on pr.id = cp.user_id and pr.paid;
  select count(*) into v_n
  from public.champion_picks cp join public.profiles pr on pr.id = cp.user_id and pr.paid
  where cp.team = v_champ;

  v_body := format('🏆 %s é CAMPEÃ da Copa do Mundo 2026!%s', v_champ, v_pen);

  if v_n > 0 then
    v_body := v_body || E'\n\n🎯 ' || v_n || ' de ' || v_total || ' cravaram o campeão (+40 pts):';
    for r in
      select pr.full_name
      from public.champion_picks cp join public.profiles pr on pr.id = cp.user_id and pr.paid
      where cp.team = v_champ order by pr.full_name asc
    loop
      v_body := v_body || E'\n• ' || r.full_name;
    end loop;
  else
    v_body := v_body || E'\n\nNinguém cravou o campeão dessa vez! Os +40 ficaram na mesa.';
  end if;
  v_body := v_body || E'\n\nO pódio final do bolão sai já já. 🏅';

  perform public.send_alert(
    'info', 'champion_revealed',
    format('🏆 %s é campeã! E o bolão?', v_champ),
    v_body,
    jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Ver classificação',
                       'champion', v_champ, 'hits', v_n),
    0
  );
  perform public._mark_milestone('champion_revealed');
  return new;
end $$;
-- (trigger trg_z_alert_champion_revealed já existe da 042; CREATE OR REPLACE basta)

-- ============================================================
-- inactive_paid — sem cap (pagos sem nenhum palpite)
-- ============================================================
create or replace function public.cron_alert_inactive_paid()
returns void
language plpgsql
security definer
as $$
declare v_n int; v_body text; r record;
begin
  select count(*) into v_n
  from public.profiles pr
  where pr.paid
    and not exists (select 1 from public.predictions p where p.user_id = pr.id);

  if v_n = 0 then perform public.mark_cron_run('inactive_paid'); return; end if;

  v_body := format('%s já pagaram mas ainda não fizeram NENHUM palpite — é ponto de graça ficando na mesa:', v_n);
  for r in
    select pr.full_name
    from public.profiles pr
    where pr.paid
      and not exists (select 1 from public.predictions p where p.user_id = pr.id)
    order by pr.full_name asc
  loop
    v_body := v_body || E'\n• ' || r.full_name;
  end loop;
  v_body := v_body || E'\n\nBora abrir e palpitar! 👇';

  perform public.send_alert(
    'info', 'inactive_paid',
    format('⚽ %s pago(s) ainda sem nenhum palpite', v_n),
    v_body,
    jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Fazer meus palpites', 'count', v_n),
    0
  );
  perform public.mark_cron_run('inactive_paid');
end $$;

-- ============================================================
-- Migration 042: Alertas de RESULTADO, INTEGRIDADE e CLÍMAX
-- ============================================================
-- Os 13 alertas vivos cobrem bem o "antes do jogo" (cadastro, pagamento, prazos,
-- lock-tonight) + recap diário + bugs/segurança. Faltava o "depois do jogo" e o
-- fim do torneio. Esta migration preenche, num chat COMPARTILHADO, sem vazar
-- palpite antes do prazo (Regra de Ouro) e sem os pings de alta frequência que a
-- 026 removeu de propósito.
--
-- ADICIONA — triggers em tempo real (prefixo trg_z_ p/ rodar DEPOIS de
--   trg_match_finished + trg_resolve_slots, mesma convenção da 011):
--   1. result_confirmed   → fim de jogo: placar oficial + quantos cravaram (+ KO: quem avançou)
--   2. result_corrected   → admin altera placar JÁ finalizado → aviso público + "pontos recalculados"
--   3. match_status       → jogo anulado (void) / adiado (postponed) → aviso neutro (defensibilidade)
--   4. champion_revealed  → final acabou: revela campeã + quem cravou o campeão (+40)
--   5. ko_phase_opens     → fase do mata-mata definida (times reais) → "palpites abertos" (final = jogo de maior peso)
--
-- ADICIONA — crons:
--   6. leader_change      → diário pós-recap: nova liderança no ranking (rivalidade)
--   7. round_movers       → diário pós-recap: top 3 que mais pontuaram nas últimas 24h
--   8. group_stage_done   → milestone set-once: fim da fase de grupos + líder provisório (prêmio parcial)
--   9. pool_settled       → milestone set-once: pódio final + premiação em R$ (prize_split) + desempate
--  10. inactive_paid      → semanal: COUNT de quem pagou e não palpitou nada (sem nomes — não constrange)
--
-- MODIFICA:
--  - alert_signup_success → se a Copa já começou, orienta o "late joiner" (não vende falsa expectativa).
--
-- NÃO faz (rejeitado na análise): placar_aberto / ko_lock_imminent (alta freq = spam),
--   registrations_closing (não existe prazo de inscrição), recap_fim_de_rodada
--   (round_label é matchday GLOBAL da FIFA, não rodada por grupo).
--
-- Reusa: send_alert (007), _site_url/_fmt_int/mark_cron_run (026), prediction_deadline (023),
--   v_leaderboard (039), v_pool_stats (037). NUNCA toca nos bugs/segurança da 007.

-- ============================================================
-- Seed idempotente: prize_split (a 001 só documenta, não semeia)
-- ============================================================
insert into public.settings (key, value) values
  ('prize_split', '{"first":70,"second":20,"third":10}'::jsonb)
on conflict (key) do nothing;

-- ============================================================
-- Helpers
-- ============================================================

-- Detecta se um team_home/away ainda é um SLOT não resolvido (ex: '1A','2B','W101','L97','3ABC.../...')
-- e não um time real. Padrões precisos pra não confundir com seleções tipo "Wales".
create or replace function public._is_slot(t text)
returns boolean language sql immutable as $$
  select t is null or t ~ '^[0-9]' or t ~ '^[WL][0-9]' or t like '3%/%';
$$;

-- Nome amigável da fase.
create or replace function public._stage_label(s text)
returns text language sql immutable as $$
  select case s
    when 'group' then 'Fase de grupos'
    when 'r32'   then 'Round of 32 (32-avos)'
    when 'r16'   then 'Oitavas de final'
    when 'qf'    then 'Quartas de final'
    when 'sf'    then 'Semifinais'
    when 'third' then 'Disputa de 3º lugar'
    when 'final' then 'FINAL'
    else s end;
$$;

-- Marco set-once: marca/consulta um milestone via settings (key 'milestone_<nome>').
create or replace function public._milestone_seen(p_name text)
returns boolean language sql stable as $$
  select exists(select 1 from public.settings where key = 'milestone_' || p_name);
$$;

create or replace function public._mark_milestone(p_name text)
returns void language sql as $$
  insert into public.settings(key, value)
  values ('milestone_' || p_name, to_jsonb(now()::text))
  on conflict (key) do nothing;  -- set-once: nunca sobrescreve
$$;

-- ============================================================
-- TRIGGER 1: result_confirmed — fim de jogo (1ª finalização)
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
  if old.finished is true then return new; end if;            -- só a 1ª finalização
  if new.status = 'void' then return new; end if;
  if new.actual_home is null or new.actual_away is null then return new; end if;
  if new.stage = 'final' then return new; end if;             -- final tem alerta próprio (campeão)

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

  -- Mata-mata: quantos acertaram quem avançou
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

  perform public.send_alert(
    'info', 'result_confirmed',
    format('✅ Fim de jogo: %s x %s', new.team_home, new.team_away),
    v_body,
    jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Ver classificação',
                       'match_id', new.id, 'exact', v_exact),
    120  -- dedup 2min por match_id (rajada da mesma transação)
  );
  return new;
end $$;

drop trigger if exists trg_z_alert_result_confirmed on public.matches;
create trigger trg_z_alert_result_confirmed
  after update on public.matches
  for each row execute function public.alert_result_confirmed();

-- ============================================================
-- TRIGGER 2: result_corrected — placar de jogo JÁ finalizado mudou
-- ============================================================
create or replace function public.alert_result_corrected()
returns trigger
language plpgsql
security definer
as $$
declare v_pen text := '';
begin
  if old.finished is not true or new.finished is not true then return new; end if;  -- só correção
  if new.status = 'void' then return new; end if;
  if old.actual_home is not distinct from new.actual_home
     and old.actual_away is not distinct from new.actual_away
     and old.pen_winner  is not distinct from new.pen_winner then
    return new;
  end if;

  if    new.pen_winner = 'home' then v_pen := ' (pên: ' || new.team_home || ')';
  elsif new.pen_winner = 'away' then v_pen := ' (pên: ' || new.team_away || ')';
  end if;

  perform public.send_alert(
    'info', 'result_corrected',
    format('🔧 Resultado corrigido: %s x %s', new.team_home, new.team_away),
    format('O resultado de %s x %s foi ajustado pelo admin.%sAntes: %s x %s%sAgora: %s x %s%s%sTodos os pontos foram recalculados automaticamente — transparência total. 🔒',
           new.team_home, new.team_away, E'\n\n',
           coalesce(old.actual_home::text,'?'), coalesce(old.actual_away::text,'?'), E'\n',
           coalesce(new.actual_home::text,'?'), coalesce(new.actual_away::text,'?'), v_pen, E'\n\n'),
    jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Ver classificação', 'match_id', new.id),
    60
  );
  return new;
end $$;

drop trigger if exists trg_z_alert_result_corrected on public.matches;
create trigger trg_z_alert_result_corrected
  after update on public.matches
  for each row execute function public.alert_result_corrected();

-- ============================================================
-- TRIGGER 3: match_status — jogo anulado / adiado
-- ============================================================
create or replace function public.alert_match_status_changed()
returns trigger
language plpgsql
security definer
as $$
declare v_title text; v_body text; v_when text;
begin
  if old.status is not distinct from new.status then return new; end if;
  if new.status not in ('void', 'postponed') then return new; end if;

  v_when := to_char(new.match_date at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24"h"MI');

  if new.status = 'void' then
    v_title := format('🚫 Jogo anulado: %s x %s', new.team_home, new.team_away);
    v_body  := format('O jogo %s x %s (%s) foi ANULADO. Ele não vale pontos pra ninguém e saiu do cálculo da classificação — os palpites desse jogo ficam sem efeito para todos, por igual.',
                      new.team_home, new.team_away, v_when);
  else
    v_title := format('⏳ Jogo adiado: %s x %s', new.team_home, new.team_away);
    v_body  := format('O jogo %s x %s foi ADIADO. Quando a nova data sair, o prazo de palpite acompanha (trava 23h59 da véspera). Por enquanto nada muda na sua pontuação.',
                      new.team_home, new.team_away);
  end if;

  perform public.send_alert(
    'info', 'match_status', v_title, v_body,
    jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Ver jogos',
                       'match_id', new.id, 'status', new.status),
    60
  );
  return new;
end $$;

drop trigger if exists trg_z_alert_match_status on public.matches;
create trigger trg_z_alert_match_status
  after update on public.matches
  for each row execute function public.alert_match_status_changed();

-- ============================================================
-- TRIGGER 4: champion_revealed — final acabou
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
  else return new;  -- empate sem pen_winner definido: aguarda admin completar
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
      where cp.team = v_champ order by pr.full_name asc limit 40
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

drop trigger if exists trg_z_alert_champion_revealed on public.matches;
create trigger trg_z_alert_champion_revealed
  after update on public.matches
  for each row execute function public.alert_champion_revealed();

-- ============================================================
-- TRIGGER 5: ko_phase_opens — fase do mata-mata definida (times reais)
-- ============================================================
create or replace function public.alert_ko_phase_opens()
returns trigger
language plpgsql
security definer
as $$
declare
  v_stage text; v_total int; v_resolved int; v_body text; v_extra text; r record;
  v_stages text[] := array['r32','r16','qf','sf','final'];
begin
  foreach v_stage in array v_stages loop
    if public._milestone_seen('ko_open_' || v_stage) then continue; end if;

    select count(*),
           count(*) filter (where not public._is_slot(team_home) and not public._is_slot(team_away))
      into v_total, v_resolved
    from public.matches where stage = v_stage;

    if v_total = 0 or v_resolved < v_total then continue; end if;  -- ainda não 100% resolvido

    v_extra := '';
    if v_stage = 'final' then
      v_extra := E'\n⭐ É o jogo de MAIOR peso do bolão — o placar exato da final vale até 76 pts!';
    end if;

    v_body := format('🆕 %s definida! Os confrontos já têm times reais e os palpites estão ABERTOS.%s%s',
                     public._stage_label(v_stage), v_extra, E'\n');
    for r in
      select team_home, team_away, match_date
      from public.matches where stage = v_stage order by match_date asc, id asc limit 16
    loop
      v_body := v_body || E'\n• ' ||
                to_char(r.match_date at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24"h"MI') ||
                ' — ' || r.team_home || ' x ' || r.team_away;
    end loop;
    v_body := v_body || E'\n\nCada jogo trava 23h59 da véspera. 👇';

    perform public.send_alert(
      'info', 'ko_phase_opens',
      format('🆕 %s — palpites abertos', public._stage_label(v_stage)),
      v_body,
      jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Palpitar agora', 'stage', v_stage),
      0
    );
    perform public._mark_milestone('ko_open_' || v_stage);
  end loop;
  return new;
end $$;

drop trigger if exists trg_z_alert_ko_phase_opens on public.matches;
create trigger trg_z_alert_ko_phase_opens
  after update on public.matches
  for each row execute function public.alert_ko_phase_opens();

-- ============================================================
-- CRON 6: leader_change — nova liderança no ranking
-- ============================================================
create or replace function public.cron_alert_leader_change()
returns void
language plpgsql
security definer
as $$
declare
  v_uid uuid; v_name text; v_pts int; v_prev uuid; v_prev_name text; v_recent int;
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
    -- 1ª vez: registra sem anunciar (não existe "novo" líder ainda)
    insert into public.settings(key, value) values('last_leader_user_id', to_jsonb(v_uid::text))
      on conflict (key) do update set value = excluded.value, updated_at = now();
    perform public.mark_cron_run('leader_change'); return;
  end if;

  if v_prev = v_uid then perform public.mark_cron_run('leader_change'); return; end if;

  select full_name into v_prev_name from public.profiles where id = v_prev;

  perform public.send_alert(
    'info', 'leader_change',
    '🔄 Temos um novo líder no bolão!',
    format('%s assumiu a liderança com %s pts, passando %s! 🔥%sQuem vai reagir?',
           v_name, v_pts, coalesce(v_prev_name, 'o antigo líder'), E'\n\n'),
    jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Ver classificação',
                       'leader', v_name, 'pts', v_pts),
    0
  );

  insert into public.settings(key, value) values('last_leader_user_id', to_jsonb(v_uid::text))
    on conflict (key) do update set value = excluded.value, updated_at = now();
  perform public.mark_cron_run('leader_change');
end $$;

comment on function public.cron_alert_leader_change is
'Cron diário pós-recap (08h36 BRT). Anuncia troca de liderança (só se houve jogo nas 24h e o líder mudou). Guarda last_leader_user_id.';

-- ============================================================
-- CRON 7: round_movers — top 3 das últimas 24h
-- ============================================================
create or replace function public.cron_alert_round_movers()
returns void
language plpgsql
security definer
as $$
declare
  v_body text := ''; v_i int := 0; v_medals text[] := array['🥇','🥈','🥉']; r record;
begin
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
    if v_i = 1 then v_body := '🔥 QUEM MAIS PONTUOU (últimas 24h):'; end if;
    v_body := v_body || E'\n' || coalesce(v_medals[v_i], '•') || ' ' || r.full_name || ' — +' || r.pts || ' pts';
  end loop;

  if v_i = 0 then perform public.mark_cron_run('round_movers'); return; end if;

  v_body := v_body || E'\n\nBora pros próximos jogos! 👇';

  perform public.send_alert(
    'info', 'round_movers',
    '🔥 Os destaques da rodada',
    v_body,
    jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Ver classificação'),
    0
  );
  perform public.mark_cron_run('round_movers');
end $$;

comment on function public.cron_alert_round_movers is
'Cron diário pós-recap (08h33 BRT). Top 3 que mais pontuaram nas últimas 24h. Silencioso se não houve jogo.';

-- ============================================================
-- CRON 8: group_stage_done — fim da fase de grupos (set-once)
-- ============================================================
create or replace function public.cron_alert_group_stage_done()
returns void
language plpgsql
security definer
as $$
declare
  v_total int; v_done int; v_body text; v_i int := 0; v_medals text[] := array['🥇','🥈','🥉']; r record;
begin
  if public._milestone_seen('group_stage_done') then return; end if;

  select count(*), count(*) filter (where finished or status = 'void')
    into v_total, v_done
  from public.matches where stage = 'group';
  if v_total = 0 or v_done < v_total then return; end if;  -- grupos ainda não acabaram

  v_body := 'A fase de grupos acabou! 🏁 Hora do mata-mata.';
  for r in
    select full_name, total_pts from public.v_leaderboard
    order by total_pts desc, exact_count desc, winner_sg_count desc limit 3
  loop
    v_i := v_i + 1;
    if v_i = 1 then v_body := v_body || E'\n\n🏆 LÍDER PROVISÓRIO (prêmio parcial):'; end if;
    v_body := v_body || E'\n' || v_medals[v_i] || ' ' || r.full_name || ' — ' || r.total_pts || ' pts';
  end loop;
  v_body := v_body || E'\n\nMas calma: ~55% dos pontos ainda estão em jogo no mata-mata. Tudo pode virar! 🔥';

  perform public.send_alert(
    'info', 'group_stage_done',
    '🏁 Fase de grupos encerrada!',
    v_body,
    jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Ver classificação'),
    0
  );
  perform public._mark_milestone('group_stage_done');
  perform public.mark_cron_run('group_stage_done');
end $$;

comment on function public.cron_alert_group_stage_done is
'Cron diário (09h10 BRT). Milestone set-once: avisa fim da fase de grupos + líder provisório (prêmio parcial).';

-- ============================================================
-- CRON 9: pool_settled — pódio final + premiação em R$ (set-once)
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
  v_pts int[]; v_names text[];
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
    select full_name, total_pts from public.v_leaderboard
    order by total_pts desc, exact_count desc, winner_sg_count desc limit 3
  loop
    v_i := v_i + 1;
    v_body := v_body || E'\n' || v_medals[v_i] || ' ' || r.full_name || ' — ' || r.total_pts || ' pts';
    v_pts[v_i] := r.total_pts; v_names[v_i] := r.full_name;
  end loop;
  if v_i = 0 then perform public.mark_cron_run('pool_settled'); return; end if;

  if coalesce(v_pot, 0) > 0 then
    v_body := v_body || E'\n\n💰 PREMIAÇÃO (caixa R$ ' || public._fmt_int(v_pot) || '):';
    if v_i >= 1 then v_body := v_body || E'\n🥇 ' || v_names[1] || ' — R$ ' || public._fmt_int(v_pot * v_first  / 100); end if;
    if v_i >= 2 then v_body := v_body || E'\n🥈 ' || v_names[2] || ' — R$ ' || public._fmt_int(v_pot * v_second / 100); end if;
    if v_i >= 3 then v_body := v_body || E'\n🥉 ' || v_names[3] || ' — R$ ' || public._fmt_int(v_pot * v_third  / 100); end if;
  end if;

  -- Empate em pontos no topo → explica o desempate
  if v_i >= 2 and v_pts[1] = v_pts[2] then
    v_body := v_body || E'\n\n⚖️ Empate em pontos no topo! Desempate pelo nº de placares exatos (e depois vencedor+saldo).';
  end if;

  v_body := v_body || E'\n\nObrigado a todos que jogaram! 🏆 Até a próxima Copa.';

  perform public.send_alert(
    'info', 'pool_settled',
    '🏆 Resultado FINAL do bolão — pódio + premiação',
    v_body,
    jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Ver classificação final'),
    0
  );
  perform public._mark_milestone('pool_settled');
  perform public.mark_cron_run('pool_settled');
end $$;

comment on function public.cron_alert_pool_settled is
'Cron diário (09h15 BRT). Milestone set-once: pódio final + divisão do prêmio em R$ (prize_split × pote) + nota de desempate.';

-- ============================================================
-- CRON 10: inactive_paid — pagou e ainda não palpitou (LISTA nomes)
-- ============================================================
-- Não-pagantes já são listados nominalmente no cron daily_payments
-- ("⏳ FALTAM PAGAR"); aqui cobramos quem JÁ pagou mas não fez nenhum palpite.
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
    limit 60
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

comment on function public.cron_alert_inactive_paid is
'Cron semanal (domingo 10h BRT). LISTA por nome quem já pagou mas não fez nenhum palpite. Silencioso se ninguém. (Não-pagantes vão no daily_payments.)';

-- ============================================================
-- MODIFICA: alert_signup_success — orienta o "late joiner"
-- ============================================================
create or replace function public.alert_signup_success()
returns trigger
language plpgsql
security definer
as $$
declare
  v_total int; v_first timestamptz; v_late boolean := false; v_body text;
begin
  select count(*) into v_total from public.profiles;
  select min(match_date) into v_first from public.matches where stage = 'group';
  if v_first is not null and now() > public.prediction_deadline(v_first) then v_late := true; end if;

  v_body := format('%s acabou de entrar no bolão! Já somos %s jogador(es) na disputa. 🎉',
                   new.full_name, v_total);
  if v_late then
    v_body := v_body || E'\n\n👋 Aviso: a Copa já começou, então alguns palpites (e talvez campeão/artilheiro) já travaram. Mas ainda dá pra disputar os jogos que faltam — abre lá e não perca os próximos!';
  end if;

  perform public.send_alert(
    'info', 'signup_success',
    format('✨ Novo participante: %s', new.full_name),
    v_body,
    jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Ver o bolão',
                       'user_id', new.id, 'full_name', new.full_name,
                       'total_users', v_total, 'late', v_late),
    0
  );
  return new;
end $$;

-- ============================================================
-- Agendamento pg_cron (UTC; BRT = UTC-3). Recap roda 11:30 UTC (08:30 BRT).
-- ============================================================
do $$
begin
  begin perform cron.unschedule('alerts_round_movers');     exception when others then null; end;
  begin perform cron.unschedule('alerts_leader_change');    exception when others then null; end;
  begin perform cron.unschedule('alerts_group_stage_done'); exception when others then null; end;
  begin perform cron.unschedule('alerts_pool_settled');     exception when others then null; end;
  begin perform cron.unschedule('alerts_inactive_paid');    exception when others then null; end;
end $$;

select cron.schedule('alerts_round_movers',     '33 11 * * *', $cmd$ select public.cron_alert_round_movers(); $cmd$);
select cron.schedule('alerts_leader_change',    '36 11 * * *', $cmd$ select public.cron_alert_leader_change(); $cmd$);
select cron.schedule('alerts_group_stage_done', '10 12 * * *', $cmd$ select public.cron_alert_group_stage_done(); $cmd$);
select cron.schedule('alerts_pool_settled',     '15 12 * * *', $cmd$ select public.cron_alert_pool_settled(); $cmd$);
select cron.schedule('alerts_inactive_paid',    '0 13 * * 0',  $cmd$ select public.cron_alert_inactive_paid(); $cmd$);

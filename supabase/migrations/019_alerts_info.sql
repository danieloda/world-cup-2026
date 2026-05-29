-- ============================================================
-- Migration 019: Alertas INFO via Telegram (atividade dos usuários)
-- ============================================================
-- Adiciona alertas informativos (não-críticos) para visibilidade da
-- atividade dos usuários, complementando os alertas críticos da 007.
--
-- Eventos real-time (triggers):
--   1. signup_success         → novo profile criado
--   2. champion_changed       → user setou ou trocou campeão
--   3. artilheiro_changed     → user setou ou trocou artilheiro
--   4. picks_complete         → user fechou todos os palpites de grupo (milestone, one-shot)
--
-- Eventos real-time (RPC chamada pelo client):
--   5. signup_failure         → falha em tentativa de cadastro (chamado pelo signup.js)
--
-- Eventos agendados (pg_cron):
--   6. pick_activity          → a cada 5 min, sumário de quem mexeu em palpites
--   7. daily_digest           → 09:00 BRT (12:00 UTC), tabela de completude + stats
--
-- IMPORTANTE: NUNCA modifica triggers/funções existentes (007). Só adiciona.

-- ===== pg_cron =====
-- Cria schema `cron` automaticamente. Em Supabase, esta extensão está
-- disponível em todos os planos (incluindo free).
create extension if not exists pg_cron;

-- ============================================================
-- ALERTA 1: signup_success
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
    format('Nova conta: %s', new.full_name),
    format('%s (%s) acabou de criar conta. Total de usuários: %s.',
           new.full_name, new.email, v_total),
    jsonb_build_object(
      'user_id', new.id,
      'full_name', new.full_name,
      'email', new.email,
      'total_users', v_total
    ),
    0  -- sem dedup: cada signup é único
  );

  return new;
end $$;

drop trigger if exists trg_alert_signup_success on public.profiles;
create trigger trg_alert_signup_success
  after insert on public.profiles
  for each row
  execute function public.alert_signup_success();

-- ============================================================
-- ALERTA 2: signup_failure (RPC chamada pelo client)
-- ============================================================
-- Anon-callable. Client chama no catch do signup.
-- Dedup de 60s por email pra evitar flood (fat-finger / retries).
create or replace function public.report_signup_failure(
  p_email text,
  p_reason text default 'unknown'
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Sanitiza inputs (anon-callable, então vale ser paranoico)
  if p_email is null or length(p_email) > 320 then return; end if;
  if p_reason is null then p_reason := 'unknown'; end if;
  if length(p_reason) > 500 then p_reason := substring(p_reason, 1, 500); end if;

  perform public.send_alert(
    'info',
    'signup_failure',
    format('Falha no cadastro: %s', p_email),
    format('Tentativa de cadastro falhou. Email: %s. Motivo: %s.', p_email, p_reason),
    jsonb_build_object(
      'email', p_email,
      'reason', p_reason
    ),
    60  -- dedup 60s por mesmo email+reason
  );
end $$;

grant execute on function public.report_signup_failure(text, text) to anon, authenticated;

comment on function public.report_signup_failure is
'RPC chamada pelo client no erro de signUp. Anon-callable. Dedup 60s por email+reason.';

-- ============================================================
-- ALERTA 3: champion_changed
-- ============================================================
create or replace function public.alert_champion_change()
returns trigger
language plpgsql
security definer
as $$
declare
  v_name text;
  v_title text;
  v_body text;
begin
  -- Pega nome do usuário
  select full_name into v_name from public.profiles where id = new.user_id;
  v_name := coalesce(v_name, new.user_id::text);

  if tg_op = 'INSERT' then
    v_title := format('%s definiu campeão: %s', v_name, new.team);
    v_body  := format('%s acabou de escolher %s como campeão.', v_name, new.team);
  else
    -- UPDATE: só alerta se o team mudou
    if old.team is not distinct from new.team then return new; end if;
    v_title := format('%s trocou campeão: %s → %s', v_name, old.team, new.team);
    v_body  := format('%s trocou a aposta de campeão de %s para %s.', v_name, old.team, new.team);
  end if;

  perform public.send_alert(
    'info',
    'champion_changed',
    v_title,
    v_body,
    jsonb_build_object(
      'user_id', new.user_id,
      'full_name', v_name,
      'team_old', case when tg_op = 'UPDATE' then old.team else null end,
      'team_new', new.team,
      'op', tg_op
    ),
    0  -- sem dedup
  );

  return new;
end $$;

drop trigger if exists trg_alert_champion_change on public.champion_picks;
create trigger trg_alert_champion_change
  after insert or update on public.champion_picks
  for each row
  execute function public.alert_champion_change();

-- ============================================================
-- ALERTA 4: artilheiro_changed
-- ============================================================
create or replace function public.alert_scorer_change()
returns trigger
language plpgsql
security definer
as $$
declare
  v_name text;
  v_player_old text;
  v_player_new text;
  v_title text;
  v_body text;
begin
  select full_name into v_name from public.profiles where id = new.user_id;
  v_name := coalesce(v_name, new.user_id::text);

  select full_name || ' (' || team || ')' into v_player_new
  from public.players where id = new.player_id;
  v_player_new := coalesce(v_player_new, 'player#' || new.player_id::text);

  if tg_op = 'INSERT' then
    v_title := format('%s definiu artilheiro: %s', v_name, v_player_new);
    v_body  := format('%s acabou de escolher %s como artilheiro.', v_name, v_player_new);
  else
    if old.player_id is not distinct from new.player_id then return new; end if;
    select full_name || ' (' || team || ')' into v_player_old
    from public.players where id = old.player_id;
    v_player_old := coalesce(v_player_old, 'player#' || old.player_id::text);
    v_title := format('%s trocou artilheiro: %s → %s', v_name, v_player_old, v_player_new);
    v_body  := format('%s trocou o artilheiro de %s para %s.', v_name, v_player_old, v_player_new);
  end if;

  perform public.send_alert(
    'info',
    'artilheiro_changed',
    v_title,
    v_body,
    jsonb_build_object(
      'user_id', new.user_id,
      'full_name', v_name,
      'player_id_old', case when tg_op = 'UPDATE' then old.player_id else null end,
      'player_id_new', new.player_id,
      'op', tg_op
    ),
    0
  );

  return new;
end $$;

drop trigger if exists trg_alert_scorer_change on public.top_scorer_picks;
create trigger trg_alert_scorer_change
  after insert or update on public.top_scorer_picks
  for each row
  execute function public.alert_scorer_change();

-- ============================================================
-- ALERTA 5: picks_complete (milestone one-shot)
-- ============================================================
-- Dispara quando user fecha todos os palpites de fase de grupos
-- (72 no formato 12 grupos × 6 jogos da Copa 2026). Conta é dinâmica via
-- count(*) em matches where stage='group', então independe do nº de jogos.
-- Idempotente via dedup de 30 dias por user_id.
create or replace function public.alert_picks_complete()
returns trigger
language plpgsql
security definer
as $$
declare
  v_name text;
  v_user uuid;
  v_group_count int;
  v_group_total int;
begin
  v_user := new.user_id;

  -- Conta palpites de grupo deste user
  select count(*) into v_group_count
  from public.predictions p
  join public.matches m on m.id = p.match_id
  where p.user_id = v_user and m.stage = 'group';

  -- Total de jogos de grupo (72 na Copa 2026: 12 grupos × 6)
  select count(*) into v_group_total
  from public.matches where stage = 'group';

  if v_group_count < v_group_total then return new; end if;

  select full_name into v_name from public.profiles where id = v_user;
  v_name := coalesce(v_name, v_user::text);

  perform public.send_alert(
    'info',
    'picks_complete',
    format('🎯 %s completou todos os palpites de grupo!', v_name),
    format('%s acabou de fechar %s/%s palpites da fase de grupos.',
           v_name, v_group_count, v_group_total),
    jsonb_build_object(
      'user_id', v_user,
      'full_name', v_name,
      'milestone', 'group_complete'
    ),
    2592000  -- dedup 30 dias: garante one-shot por user
  );

  return new;
end $$;

drop trigger if exists trg_alert_picks_complete on public.predictions;
create trigger trg_alert_picks_complete
  after insert or update on public.predictions
  for each row
  execute function public.alert_picks_complete();

-- ============================================================
-- CRON 6: pick_activity (debounce 5 min)
-- ============================================================
-- A cada 5 min, sumariza quem mexeu em palpites de grupo no período.
-- Uma mensagem por user ativo: "João: +8 picks · 22/72 done".
create or replace function public.cron_alert_pick_activity()
returns int
language plpgsql
security definer
as $$
declare
  v_last_check timestamptz;
  v_now timestamptz := now();
  v_total_group int;
  r record;
  v_count int := 0;
  v_body text;
begin
  -- Lê última checagem (default: 6 min atrás)
  select (value #>> '{}')::timestamptz into v_last_check
  from public.settings where key = 'pick_activity_last_check';

  if v_last_check is null then
    v_last_check := v_now - interval '6 minutes';
  end if;

  select count(*) into v_total_group from public.matches where stage = 'group';

  -- Para cada user com atividade desde last_check
  for r in
    select p.user_id,
           pr.full_name,
           count(*) filter (where p.updated_at > v_last_check) as touched,
           count(*) as user_total
    from public.predictions p
    join public.matches m on m.id = p.match_id and m.stage = 'group'
    join public.profiles pr on pr.id = p.user_id
    group by p.user_id, pr.full_name
    having count(*) filter (where p.updated_at > v_last_check) > 0
  loop
    v_body := format('%s mexeu em %s palpite(s) nos últimos minutos. Status: %s/%s.',
                     r.full_name, r.touched, r.user_total, v_total_group);

    perform public.send_alert(
      'info',
      'pick_activity',
      format('%s: +%s palpites · %s/%s', r.full_name, r.touched, r.user_total, v_total_group),
      v_body,
      jsonb_build_object(
        'user_id', r.user_id,
        'full_name', r.full_name,
        'touched', r.touched,
        'user_total', r.user_total,
        'group_total', v_total_group,
        'window_start', v_last_check,
        'window_end', v_now
      ),
      0  -- sem dedup, cada janela é única
    );
    v_count := v_count + 1;
  end loop;

  -- Atualiza last_check
  insert into public.settings(key, value)
  values ('pick_activity_last_check', to_jsonb(v_now::text))
  on conflict (key) do update set value = excluded.value, updated_at = now();

  return v_count;
end $$;

comment on function public.cron_alert_pick_activity is
'Cron 5min. Sumariza palpites alterados na janela e dispara 1 alerta por user ativo.';

-- ============================================================
-- CRON 7: daily_digest (09:00 BRT = 12:00 UTC)
-- ============================================================
-- Foco em LAGGARDS: quem ainda não fechou palpites de grupo, campeão e artilheiro.
-- Não mostra distribuição (o que foi escolhido) — só quem está faltando.
create or replace function public.cron_alert_daily_digest()
returns void
language plpgsql
security definer
as $$
declare
  v_total_group int;
  v_total_users int;
  v_complete_users int;
  v_no_champion int;
  v_no_scorer int;
  v_body text := '';
  r record;
begin
  select count(*) into v_total_group from public.matches where stage = 'group';
  select count(*) into v_total_users from public.profiles;

  -- Quantos completaram todos os palpites de grupo?
  select count(*) into v_complete_users
  from (
    select p.user_id, count(*) as c
    from public.predictions p
    join public.matches m on m.id = p.match_id and m.stage = 'group'
    group by p.user_id
    having count(*) >= v_total_group
  ) sub;

  -- Quantos não escolheram campeão?
  select count(*) into v_no_champion
  from public.profiles pr
  left join public.champion_picks cp on cp.user_id = pr.id
  where cp.user_id is null;

  -- Quantos não escolheram artilheiro?
  select count(*) into v_no_scorer
  from public.profiles pr
  left join public.top_scorer_picks tsp on tsp.user_id = pr.id
  where tsp.user_id is null;

  -- IMPORTANTE: o edge function escapa MarkdownV2 no body. Não usar *markdown*
  -- aqui — viraria texto literal com backslashes. Usa headers em CAIXA ALTA.
  v_body := format(
    'RESUMO:%s• Palpites de grupo: %s/%s completos%s• Sem campeão: %s%s• Sem artilheiro: %s',
    E'\n', v_complete_users, v_total_users,
    E'\n', v_no_champion,
    E'\n', v_no_scorer
  );

  -- Lista de incompletos em palpites de grupo (cap 60)
  if v_complete_users < v_total_users then
    v_body := v_body || E'\n\nFALTAM PALPITES DE GRUPO:';
    for r in
      select pr.full_name,
             coalesce(c.cnt, 0) as cnt
      from public.profiles pr
      left join (
        select p.user_id, count(*) as cnt
        from public.predictions p
        join public.matches m on m.id = p.match_id and m.stage = 'group'
        group by p.user_id
      ) c on c.user_id = pr.id
      where coalesce(c.cnt, 0) < v_total_group
      order by coalesce(c.cnt, 0) asc, pr.full_name asc
      limit 60
    loop
      v_body := v_body || E'\n• ' || r.full_name || ': ' || r.cnt || '/' || v_total_group;
    end loop;
  end if;

  -- Lista de quem não escolheu campeão (cap 60)
  if v_no_champion > 0 then
    v_body := v_body || E'\n\nFALTA CAMPEÃO:';
    for r in
      select pr.full_name
      from public.profiles pr
      left join public.champion_picks cp on cp.user_id = pr.id
      where cp.user_id is null
      order by pr.full_name asc
      limit 60
    loop
      v_body := v_body || E'\n• ' || r.full_name;
    end loop;
  end if;

  -- Lista de quem não escolheu artilheiro (cap 60)
  if v_no_scorer > 0 then
    v_body := v_body || E'\n\nFALTA ARTILHEIRO:';
    for r in
      select pr.full_name
      from public.profiles pr
      left join public.top_scorer_picks tsp on tsp.user_id = pr.id
      where tsp.user_id is null
      order by pr.full_name asc
      limit 60
    loop
      v_body := v_body || E'\n• ' || r.full_name;
    end loop;
  end if;

  if v_complete_users = v_total_users and v_no_champion = 0 and v_no_scorer = 0 then
    v_body := v_body || E'\n\n🎉 Tudo em ordem! Ninguém pendente.';
  end if;

  perform public.send_alert(
    'info',
    'daily_digest',
    format('📊 Digest — grupos %s/%s · sem camp %s · sem art %s',
           v_complete_users, v_total_users, v_no_champion, v_no_scorer),
    v_body,
    jsonb_build_object(
      'total_users', v_total_users,
      'complete_users', v_complete_users,
      'group_total', v_total_group,
      'no_champion', v_no_champion,
      'no_scorer', v_no_scorer
    ),
    0  -- sem dedup
  );
end $$;

comment on function public.cron_alert_daily_digest is
'Cron diário 09h BRT. Foco em laggards: quem ainda não fechou grupos, campeão e artilheiro.';

-- ============================================================
-- Agendamento via pg_cron
-- ============================================================
-- Limpa schedule anterior (idempotente)
do $$
begin
  begin perform cron.unschedule('alerts_pick_activity'); exception when others then null; end;
  begin perform cron.unschedule('alerts_daily_digest');  exception when others then null; end;
end $$;

select cron.schedule(
  'alerts_pick_activity',
  '*/5 * * * *',                                  -- a cada 5 min
  $cmd$ select public.cron_alert_pick_activity(); $cmd$
);

select cron.schedule(
  'alerts_daily_digest',
  '0 12 * * *',                                   -- 12:00 UTC = 09:00 BRT
  $cmd$ select public.cron_alert_daily_digest(); $cmd$
);

-- ============================================================
-- Migration 007: Alertas via Telegram Edge Function
-- ============================================================
-- Adiciona 4 triggers de alerta que disparam mensagens pro Telegram
-- via a Edge Function `telegram-alert`.
--
-- Triggers (todos AFTER, não bloqueiam):
--   1. trg_alert_orphan_predictions  → points_earned NULL após match.finished
--   2. trg_alert_unresolved_slots    → W##/L## ainda visível em team_home/away
--   3. trg_alert_pred_overwrite      → UPDATE em pred_home/away após match.finished
--   4. trg_alert_auth_failures       → 5+ tentativas falhas em 5 min (via cron, ver final)
--
-- IMPORTANTE: NUNCA modifica triggers/funções existentes (003, 005). Só adiciona.

-- ===== 1) Extension pg_net (para http_post de triggers) =====
create extension if not exists pg_net with schema extensions;

-- ===== 2) Tabela de log de alertas (auditoria + dedupe) =====
create table if not exists public.alert_log (
  id           bigserial primary key,
  severity     text not null check (severity in ('critical', 'warn', 'info')),
  category     text not null,
  title        text not null,
  body         text not null,
  context      jsonb,
  request_id   bigint,                    -- ID retornado por pg_net (pra debug)
  created_at   timestamptz not null default now()
);

create index if not exists idx_alert_log_created_at on public.alert_log(created_at desc);
create index if not exists idx_alert_log_category_created on public.alert_log(category, created_at desc);

comment on table public.alert_log is 'Registro de todos os alertas disparados via telegram-alert edge function';

-- ===== 3) Wrapper: send_alert() =====
-- Idempotente, dedup-aware (não dispara se já mandou o mesmo alerta nos últimos
-- 5 min com mesma category+context).
create or replace function public.send_alert(
  p_severity text,
  p_category text,
  p_title    text,
  p_body     text,
  p_context  jsonb default '{}'::jsonb,
  p_dedup_seconds int default 300  -- 5 min default
) returns bigint
language plpgsql
security definer
as $$
declare
  v_request_id bigint;
  v_recent_count int;
  v_edge_url text;
  v_anon_key text;
  v_payload jsonb;
begin
  -- Dedup: se mesmo category+context já foi enviado nos últimos N segundos, pula
  if p_dedup_seconds > 0 then
    select count(*) into v_recent_count
    from public.alert_log
    where category = p_category
      and context = p_context
      and created_at > now() - (p_dedup_seconds || ' seconds')::interval;

    if v_recent_count > 0 then
      raise notice '[send_alert] Dedupe: skipped % (% recent matches)', p_category, v_recent_count;
      return null;
    end if;
  end if;

  -- Lê config do GUC (setado via supabase secrets ou settings table)
  -- Fallback: hardcoded URL do projeto. ANON key DEVE estar em settings table.
  begin
    v_edge_url := current_setting('app.edge_url', true);
  exception when others then
    v_edge_url := null;
  end;

  if v_edge_url is null or v_edge_url = '' then
    -- Hardcoded fallback (substitua se mudar de projeto)
    v_edge_url := 'https://dnhnzmdqqvvvphiijevl.supabase.co/functions/v1/telegram-alert';
  end if;

  begin
    v_anon_key := current_setting('app.anon_key', true);
  exception when others then
    v_anon_key := null;
  end;

  if v_anon_key is null or v_anon_key = '' then
    -- Tenta pegar de settings table
    select value::text into v_anon_key from public.settings where key = 'edge_anon_key';
    v_anon_key := trim(both '"' from coalesce(v_anon_key, ''));
  end if;

  v_payload := jsonb_build_object(
    'severity', p_severity,
    'category', p_category,
    'title',    p_title,
    'body',     p_body,
    'context',  p_context
  );

  -- pg_net é async, não trava trigger
  select net.http_post(
    url     := v_edge_url,
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'Authorization',  'Bearer ' || coalesce(v_anon_key, '')
    ),
    body    := v_payload
  ) into v_request_id;

  -- Log do disparo
  insert into public.alert_log(severity, category, title, body, context, request_id)
  values (p_severity, p_category, p_title, p_body, p_context, v_request_id);

  return v_request_id;
exception when others then
  -- NUNCA propagar erro pra trigger pai
  raise warning '[send_alert] Erro ao enviar alerta % - %: %', p_category, p_title, sqlerrm;
  return null;
end $$;

comment on function public.send_alert is
'Dispara alerta pro Telegram via Edge Function. Dedup automatico em janela de N segundos. Failure-safe (nunca propaga erro).';

-- ============================================================
-- ALERTA 1: orphan_predictions
-- Detecta predictions com points_earned NULL após match estar finished
-- ============================================================
-- Cenário: trigger on_match_finished falhou e o score_prediction não rodou.
-- Dispara: AFTER match passa para finished=true, conta predictions órfãs.

create or replace function public.alert_check_orphan_predictions()
returns trigger
language plpgsql
security definer
as $$
declare
  v_orphan_count int;
  v_total_predictions int;
begin
  -- Só executa quando match acabou de finalizar
  if new.finished is not true then return new; end if;
  if old.finished is true then return new; end if;  -- já estava finished antes

  -- Quantas predictions deste match ficaram com points_earned NULL?
  select count(*) into v_orphan_count
  from public.predictions
  where match_id = new.id and points_earned is null;

  select count(*) into v_total_predictions
  from public.predictions
  where match_id = new.id;

  if v_orphan_count > 0 then
    perform public.send_alert(
      'critical',
      'trigger_bug',
      format('Match #%s: %s palpite(s) sem pontos calculados', new.id, v_orphan_count),
      format('Match #%s (%s) foi finalizado, mas %s de %s palpites ainda têm points_earned NULL. Trigger on_match_finished pode ter falhado.',
             new.id, new.stage, v_orphan_count, v_total_predictions),
      jsonb_build_object(
        'match_id', new.id,
        'stage', new.stage,
        'team_home', new.team_home,
        'team_away', new.team_away,
        'orphan_count', v_orphan_count,
        'total_predictions', v_total_predictions
      )
    );
  end if;

  return new;
end $$;

drop trigger if exists trg_alert_orphan_predictions on public.matches;
-- Nome alfabético garante que roda DEPOIS de trg_match_finished (recompute_prediction_points)
create trigger trg_alert_orphan_predictions
  after update on public.matches
  for each row
  execute function public.alert_check_orphan_predictions();

-- ============================================================
-- ALERTA 2: unresolved_slot
-- Detecta W##/L## ainda como team_home/away após jogo de origem terminar
-- ============================================================
-- Cenário: trigger resolve_match_slots falhou. Match X (W##) terminou mas o
-- jogo Y que tem slot_home='WX' ainda mostra "WX" no team_home.

create or replace function public.alert_check_unresolved_slots()
returns trigger
language plpgsql
security definer
as $$
declare
  v_unresolved_count int;
  v_unresolved_ids int[];
begin
  -- Só executa pra knockout finalizados
  if new.finished is not true then return new; end if;
  if old.finished is true then return new; end if;
  if new.stage = 'group' then return new; end if;

  -- Procura matches downstream que deveriam ter sido resolvidos
  -- ('W'||new.id ou 'L'||new.id em slot_home/away, mas team_home/away ainda é W##/L##)
  select array_agg(id), count(*) into v_unresolved_ids, v_unresolved_count
  from public.matches
  where (
    (slot_home = 'W' || new.id::text and team_home ~ '^[WL][0-9]+$')
    or (slot_away = 'W' || new.id::text and team_away ~ '^[WL][0-9]+$')
    or (slot_home = 'L' || new.id::text and team_home ~ '^[WL][0-9]+$')
    or (slot_away = 'L' || new.id::text and team_away ~ '^[WL][0-9]+$')
  );

  if v_unresolved_count > 0 then
    perform public.send_alert(
      'critical',
      'unresolved_slot',
      format('Match #%s terminou mas slots W%s/L%s não resolvidos', new.id, new.id, new.id),
      format('Match #%s (%s vs %s) foi finalizado mas %s match(es) downstream ainda mostram W/L como time. Trigger resolve_match_slots pode ter falhado.',
             new.id, new.team_home, new.team_away, v_unresolved_count),
      jsonb_build_object(
        'match_id', new.id,
        'stage', new.stage,
        'unresolved_match_ids', v_unresolved_ids,
        'unresolved_count', v_unresolved_count
      )
    );
  end if;

  return new;
end $$;

drop trigger if exists trg_alert_unresolved_slots on public.matches;
create trigger trg_alert_unresolved_slots
  after update on public.matches
  for each row
  execute function public.alert_check_unresolved_slots();

-- ============================================================
-- ALERTA 3: pred_overwrite
-- Detecta UPDATE em predictions.pred_home/away após match terminar
-- ============================================================
-- Cenário: usuário (ou script bug) tentou modificar palpite após jogo finalizado.
-- Mesmo que RLS bloqueie, ainda é bom alertar — pode indicar tentativa maliciosa.

create or replace function public.alert_check_pred_overwrite()
returns trigger
language plpgsql
security definer
as $$
declare
  v_match record;
begin
  -- Só checa se pred_home OU pred_away realmente mudou
  if old.pred_home is not distinct from new.pred_home
     and old.pred_away is not distinct from new.pred_away
     and old.pred_pen_winner is not distinct from new.pred_pen_winner
  then
    return new;
  end if;

  -- Pega estado do match
  select finished, finished_at, stage, team_home, team_away
  into v_match
  from public.matches where id = new.match_id;

  -- Se match já está finalizado, é sobrescrita suspeita
  if v_match.finished is true then
    perform public.send_alert(
      'warn',
      'pred_overwrite',
      format('Palpite modificado APÓS jogo finalizado (match #%s)', new.match_id),
      format('Predictions row %s alterada após match.finished=true (terminou em %s). Antes: %s-%s. Depois: %s-%s.',
             new.id,
             coalesce(v_match.finished_at::text, '?'),
             coalesce(old.pred_home::text, '?'), coalesce(old.pred_away::text, '?'),
             coalesce(new.pred_home::text, '?'), coalesce(new.pred_away::text, '?')),
      jsonb_build_object(
        'prediction_id', new.id,
        'match_id', new.match_id,
        'user_id', new.user_id,
        'stage', v_match.stage,
        'teams', v_match.team_home || ' vs ' || v_match.team_away,
        'old_pred', coalesce(old.pred_home::text, '?') || '-' || coalesce(old.pred_away::text, '?'),
        'new_pred', coalesce(new.pred_home::text, '?') || '-' || coalesce(new.pred_away::text, '?'),
        'finished_at', v_match.finished_at
      ),
      60  -- dedup 1 min (caso múltiplas linhas alteradas em sequência)
    );
  end if;

  return new;
end $$;

drop trigger if exists trg_alert_pred_overwrite on public.predictions;
create trigger trg_alert_pred_overwrite
  after update on public.predictions
  for each row
  execute function public.alert_check_pred_overwrite();

-- ============================================================
-- ALERTA 4: auth_failures (poll-based, não trigger)
-- ============================================================
-- Detecta múltiplas tentativas de login falhas em janela curta.
-- auth.audit_log_entries não permite triggers de outros schemas, então
-- expomos uma função que pode ser chamada por cron job (pg_cron) ou
-- manualmente. Por simplicidade do v1, deixamos a função pronta mas
-- não agendamos automaticamente.

create or replace function public.check_auth_failures(
  p_window_minutes int default 5,
  p_threshold int default 5
) returns int
language plpgsql
security definer
as $$
declare
  v_attempts int;
  v_top_ip text;
begin
  -- Conta tentativas de login falhas na janela
  -- auth.audit_log_entries tem 'payload' jsonb com 'action' e 'actor_username'
  select count(*) into v_attempts
  from auth.audit_log_entries
  where payload->>'action' = 'login_failed'
    and created_at > now() - (p_window_minutes || ' minutes')::interval;

  if v_attempts >= p_threshold then
    -- Tenta achar o email mais frequente
    select payload->>'actor_username' into v_top_ip
    from auth.audit_log_entries
    where payload->>'action' = 'login_failed'
      and created_at > now() - (p_window_minutes || ' minutes')::interval
    group by payload->>'actor_username'
    order by count(*) desc
    limit 1;

    perform public.send_alert(
      'warn',
      'auth_failure',
      format('%s tentativas de login falhas em %s min', v_attempts, p_window_minutes),
      format('Detectadas %s tentativas falhas. Email mais frequente: %s. Possivel brute force?',
             v_attempts, coalesce(v_top_ip, '?')),
      jsonb_build_object(
        'window_minutes', p_window_minutes,
        'attempts', v_attempts,
        'threshold', p_threshold,
        'top_email', v_top_ip
      ),
      300  -- dedup 5 min
    );
  end if;

  return v_attempts;
end $$;

comment on function public.check_auth_failures is
'Detecta brute force. Chame periodicamente (pg_cron ou external scheduler). Default: 5+ tentativas em 5 min.';

-- ============================================================
-- RLS para alert_log (admin-only)
-- ============================================================
alter table public.alert_log enable row level security;

create policy "alert_log_select_admin"
  on public.alert_log for select
  to authenticated
  using (public.is_admin());

-- ============================================================
-- Settings: edge_anon_key (NECESSARIO antes de testar)
-- ============================================================
-- Adicione manualmente no Dashboard ou via:
--   INSERT INTO settings(key, value) VALUES ('edge_anon_key', '"YOUR_ANON_KEY"');
-- ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Helper function: testa se alerts estão configurados corretamente
create or replace function public.test_alert(p_severity text default 'info')
returns bigint
language plpgsql
security definer
as $$
begin
  return public.send_alert(
    p_severity,
    'manual_test',
    'Teste manual do sistema de alertas',
    format('Disparado por test_alert(%L) em %s', p_severity, now()::text),
    jsonb_build_object('test', true, 'timestamp', now()),
    0  -- sem dedup pra teste
  );
end $$;

comment on function public.test_alert is
'Dispara um alerta de teste no Telegram. Uso: SELECT public.test_alert(''critical''); ';

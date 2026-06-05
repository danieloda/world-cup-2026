-- ============================================================
-- Migration 045: links SEMPRE explícitos/diretos em TODOS os alertas
-- ============================================================
-- Pedido: nenhum alerta deve usar "botão" com rótulo (ex: "Entrar no bolão",
-- "Ver classificação"); o texto do link deve ser o PRÓPRIO endereço, visível.
--
-- Em vez de reescrever cada função, centralizamos no send_alert: sempre que o
-- context trouxer cta_url, sobrescrevemos cta_label com o próprio cta_url. A
-- edge renderiza [label](url) → [https://...](https://...), ou seja, o link
-- direto aparece como texto clicável em TODOS os alertas, de uma vez.
--
-- Mantém TODO o resto do send_alert da 007 (dedup, GUC, pg_net, alert_log,
-- failure-safe). Idempotente (CREATE OR REPLACE, mesma assinatura).

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
  -- Links SEMPRE explícitos/diretos: o texto do link vira o próprio URL (não um
  -- rótulo). Centralizado aqui → vale pra TODOS os alertas que mandam cta_url.
  if p_context ? 'cta_url' and nullif(p_context->>'cta_url', '') is not null then
    p_context := p_context || jsonb_build_object('cta_label', p_context->>'cta_url');
  end if;

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
  begin
    v_edge_url := current_setting('app.edge_url', true);
  exception when others then
    v_edge_url := null;
  end;

  if v_edge_url is null or v_edge_url = '' then
    v_edge_url := 'https://dnhnzmdqqvvvphiijevl.supabase.co/functions/v1/telegram-alert';
  end if;

  begin
    v_anon_key := current_setting('app.anon_key', true);
  exception when others then
    v_anon_key := null;
  end;

  if v_anon_key is null or v_anon_key = '' then
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

  insert into public.alert_log(severity, category, title, body, context, request_id)
  values (p_severity, p_category, p_title, p_body, p_context, v_request_id);

  return v_request_id;
exception when others then
  raise warning '[send_alert] Erro ao enviar alerta % - %: %', p_category, p_title, sqlerrm;
  return null;
end $$;

comment on function public.send_alert is
'Dispara alerta pro Telegram via Edge Function. Força cta_label = cta_url (links diretos/explícitos). Dedup por janela. Failure-safe.';

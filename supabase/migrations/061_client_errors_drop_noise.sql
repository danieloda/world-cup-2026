-- ============================================================
-- Migration 061: Filtra ruído de terceiros nos alertas de erro do cliente
-- ============================================================
-- O alerta tempo-real (048) e o digest (049) estavam pingando no Telegram do
-- admin com erros que NÃO são do nosso app:
--   - "Script error.": erro de script cross-origin SEM CORS. O navegador esconde
--     mensagem/linha/stack por segurança (chega message='Script error.', stack
--     nulo). Nosso código é same-origin (reportaria detalhe real) → isso é sempre
--     terceiro: extensão do navegador, content blocker ou injeção de rede.
--   - Extensões do navegador injetando script (ex.: carteira cripto evmAsk.js que
--     disputa window.ethereum) — stack em chrome-extension://… / moz-extension://…
--
-- Casos reais (jun/2026): 8+ pings de "Script error." em 5 páginas distintas, só
-- iOS/Mac Safari, todos sem stack → puro ruído de extensão/blocker do visitante.
--
-- A 061 NÃO bloqueia a gravação: a tabela segue append-only (admin ainda enxerga
-- tudo via SELECT). Só para de PAGAR e de contar esse ruído nos resumos. O front
-- (error-reporter.js) já nem envia mais — esta guarda cobre clientes com JS em
-- cache (Safari) que continuam inserindo até o cache expirar.
--
-- KEEP IN SYNC: src/js/error-reporter.js (isNoise), 048 (trigger), 049 (digest).

-- Regra única, compartilhada pelo trigger e pelo digest.
create or replace function public.is_client_error_noise(p_message text, p_stack text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select
    -- "Script error." opaco (cross-origin sem CORS)
    coalesce(trim(p_message), '') ~* '^script error\.?$'
    -- stack originado em extensão do navegador (não é nosso código)
    or coalesce(p_stack, '') ~* '(chrome|moz|safari(-web)?|ms-browser|webkit-masked-url)-extension://';
$$;

-- ── Trigger tempo-real (048): não dispara Telegram para ruído ────────────────
create or replace function public.alert_client_error()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sig  text;
  v_page text;
  v_msg  text;
begin
  -- Ruído de terceiros (cross-origin opaco / extensão): grava mas não paga.
  if public.is_client_error_noise(new.message, new.stack) then
    return new;
  end if;

  v_msg := coalesce(nullif(trim(new.message), ''), '(sem mensagem)');

  -- Assinatura estável: tipo + mensagem com números/ids colapsados → variações
  -- ("...line 42" / "...line 87") viram o mesmo alerta.
  v_sig := new.kind || ':' || regexp_replace(v_msg, '[0-9a-f]{2,}', '#', 'gi');

  -- Página = só o path (sem origin nem query, que carregam ids/ruído).
  v_page := regexp_replace(split_part(coalesce(new.url, ''), '?', 1), '^https?://[^/]+', '', 'i');

  perform public.send_alert(
    'warn',
    'client_error',
    'Erro no app: ' || left(v_msg, 120),
    left(v_msg, 300) || ' — em ' || coalesce(nullif(v_page, ''), '?') || ' (' || new.kind || ')',
    jsonb_build_object('sig', v_sig),  -- SÓ a assinatura → dedupe correto
    21600                               -- 6h por assinatura distinta
  );

  return new;
exception when others then
  -- nunca propaga erro pro insert do client_errors (o reporter já é best-effort)
  raise warning '[alert_client_error] %', sqlerrm;
  return new;
end $$;

-- ── Digest diário (049): exclui ruído da contagem e do top-5 ─────────────────
create or replace function public.cron_alert_client_errors_digest()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total int;
  v_users int;
  v_body  text;
  r record;
begin
  select count(*), count(distinct user_id) into v_total, v_users
  from public.client_errors
  where created_at > now() - interval '24 hours'
    and not public.is_client_error_noise(message, stack);

  -- Dia limpo (ou só ruído) → não manda nada (só marca pro heartbeat).
  if coalesce(v_total, 0) = 0 then
    perform public.mark_cron_run('client_errors_digest');
    return;
  end if;

  v_body := format('🐞 %s erro(s) de %s usuário(s) nas últimas 24h.', v_total, v_users)
            || E'\n\nMais frequentes:';

  for r in
    with norm as (
      select regexp_replace(coalesce(message, ''), '[0-9a-f]{2,}', '#', 'gi') as sig,
             message,
             regexp_replace(split_part(coalesce(url, ''), '?', 1), '^https?://[^/]+', '', 'i') as page,
             user_id
      from public.client_errors
      where created_at > now() - interval '24 hours'
        and not public.is_client_error_noise(message, stack)
    )
    select count(*) as c, count(distinct user_id) as u,
           min(message) as msg, min(page) as page
    from norm
    group by sig
    order by count(*) desc
    limit 5
  loop
    v_body := v_body || E'\n• ' || r.c || '× '
              || left(coalesce(nullif(trim(r.msg), ''), '(sem mensagem)'), 100)
              || case when coalesce(r.page, '') <> '' then ' (em ' || r.page || ')' else '' end;
  end loop;

  v_body := v_body || E'\n\nDetalhe completo em public.client_errors.';

  perform public.send_alert(
    'warn',
    'client_errors_digest',
    format('🐞 Erros do app — %s', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM')),
    v_body,
    jsonb_build_object('total', v_total, 'users', v_users),
    43200  -- 12h: blinda contra duplo-disparo no mesmo dia
  );

  perform public.mark_cron_run('client_errors_digest');
end $$;

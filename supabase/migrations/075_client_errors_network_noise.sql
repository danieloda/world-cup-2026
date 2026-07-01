-- ============================================================
-- Migration 075: Erro de REDE do cliente não pinga o admin em tempo real
-- ============================================================
-- "TypeError: Failed to fetch" (e variantes por browser) é falha TRANSITÓRIA na
-- camada de rede do cliente — blip de wifi/4G, DNS, ERR_NETWORK_CHANGED, conexão
-- resetada, ad-blocker. NÃO é bug do nosso app: não há linha/arquivo/fix do nosso
-- lado. A prova é a própria gravação do erro: o insert em client_errors que gerou
-- o alerta é um fetch pro MESMO host Supabase que acabou de falhar — se tivesse
-- sucesso (e teve, senão não havia alerta), a rede voltou em ms. Outage/CORS/host
-- errado persistente mataria o insert também.
--
-- Hoje (048/061) qualquer "Failed to fetch" pinga o Telegram em tempo real e conta
-- no digest, igual a um bug fatal — puro ruído. Esta migration:
--   1) classifica erro de rede (por kind='network' que o front passa A PARTIR de
--      agora, OU por padrão de mensagem, p/ pegar clientes com JS antigo em cache);
--   2) trigger 048: NÃO dispara send_alert em tempo real p/ rede (igual ao early
--      return do ruído de terceiros) — mas grava a linha (append-only intacto);
--   3) digest 049: tira rede da contagem de BUGS e mostra numa LINHA SEPARADA
--      "📡 N erros de conexão" — assim um SURTO (= possível incidente real de
--      infra Supabase/Netlify, não usuário) continua visível, sem spam diário.
--
-- Mesma filosofia de "gravar mas não pagar" da 061 (Script error./extensões).
-- KEEP IN SYNC: src/js/error-reporter.js (isNetworkError + reportFatal kind),
-- 048 (trigger), 049/061 (digest), 047 (kinds da tabela: + 'network').

-- ── Classificador de erro de rede (compartilhado trigger + digest) ───────────
-- Conservador de propósito: 'load failed' (Safari, genérico) só casa ANCORADO no
-- fim da mensagem (ex.: "[historico] Load failed", "TypeError: Load failed") pra
-- não engolir falso-positivo tipo "Failed to load resource".
create or replace function public.is_client_error_network(p_message text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select
    coalesce(trim(p_message), '') ~* '(failed to fetch|networkerror when attempting to fetch|network request failed|the network connection was lost)'
    or coalesce(trim(p_message), '') ~* '(^|: |\] )load failed\.?$';
$$;

-- ── Trigger tempo-real (048/061): rede e ruído não disparam Telegram ─────────
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

  -- Erro de REDE transitório (kind do front OU padrão de mensagem p/ JS em cache):
  -- grava (append-only intacto, digest ainda agrega), mas NÃO pinga em tempo real.
  if new.kind = 'network' or public.is_client_error_network(new.message) then
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

-- ── Digest diário (049/061): bugs sem rede + linha separada de conexão ───────
create or replace function public.cron_alert_client_errors_digest()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total int;   -- bugs acionáveis (sem ruído, sem rede)
  v_users int;
  v_net   int;   -- erros de rede (não acionáveis, agregados)
  v_body  text;
  r record;
begin
  -- Bugs acionáveis: nem ruído de terceiros, nem rede transitória.
  select count(*), count(distinct user_id) into v_total, v_users
  from public.client_errors
  where created_at > now() - interval '24 hours'
    and not public.is_client_error_noise(message, stack)
    and not (kind = 'network' or public.is_client_error_network(message));

  -- Erros de rede no período (só p/ enxergar surto de infra, sem virar "bug").
  select count(*) into v_net
  from public.client_errors
  where created_at > now() - interval '24 hours'
    and (kind = 'network' or public.is_client_error_network(message));

  -- Sem bug acionável E sem rede → nada a reportar (só marca pro heartbeat).
  if coalesce(v_total, 0) = 0 and coalesce(v_net, 0) = 0 then
    perform public.mark_cron_run('client_errors_digest');
    return;
  end if;

  v_body := format('🐞 %s erro(s) de %s usuário(s) nas últimas 24h.', coalesce(v_total, 0), coalesce(v_users, 0));

  if coalesce(v_total, 0) > 0 then
    v_body := v_body || E'\n\nMais frequentes:';
    for r in
      with norm as (
        select regexp_replace(coalesce(message, ''), '[0-9a-f]{2,}', '#', 'gi') as sig,
               message,
               regexp_replace(split_part(coalesce(url, ''), '?', 1), '^https?://[^/]+', '', 'i') as page,
               user_id
        from public.client_errors
        where created_at > now() - interval '24 hours'
          and not public.is_client_error_noise(message, stack)
          and not (kind = 'network' or public.is_client_error_network(message))
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
  end if;

  -- Linha separada de rede (não-acionável). Surto aqui = olhar infra, não código.
  if coalesce(v_net, 0) > 0 then
    v_body := v_body || E'\n\n📡 ' || v_net || ' erro(s) de conexão (rede do usuário · não-acionável).';
  end if;

  v_body := v_body || E'\n\nDetalhe completo em public.client_errors.';

  perform public.send_alert(
    'warn',
    'client_errors_digest',
    format('🐞 Erros do app — %s', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM')),
    v_body,
    jsonb_build_object('total', v_total, 'users', v_users, 'net', v_net),
    43200  -- 12h: blinda contra duplo-disparo no mesmo dia
  );

  perform public.mark_cron_run('client_errors_digest');
end $$;

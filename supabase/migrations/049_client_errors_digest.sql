-- ============================================================
-- Migration 049: Digest diário de erros do cliente (rede de segurança)
-- ============================================================
-- Complementa o alerta tempo-real (048): um resumo diário "X erros nas últimas
-- 24h, top N mensagens" via o mesmo pipeline de cron + send_alert da 026.
-- Pega o que o dedupe de 6h do tempo-real possa ter agregado e dá uma visão
-- consolidada. Só dispara se houve erro (dia limpo = silêncio).
--
-- severity 'warn' → admin-facing, sem vazar context. Agrega por assinatura
-- normalizada (mensagem sem números/ids) p/ juntar variações do mesmo bug.
--
-- KEEP IN SYNC: 026 (padrão de cron/send_alert/mark_cron_run), 047/048.

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
  where created_at > now() - interval '24 hours';

  -- Dia limpo → não manda nada (só marca pro heartbeat).
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

comment on function public.cron_alert_client_errors_digest is
'Cron diário 09h05 BRT. Resumo de erros do cliente das últimas 24h (top 5 por assinatura). Só dispara se houve erro.';

-- Evita falso-positivo de heartbeat logo após o deploy.
select public.mark_cron_run('client_errors_digest');

-- Agendamento: 09:05 BRT = 12:05 UTC (depois dos outros crons da manhã).
do $$
begin
  begin perform cron.unschedule('alerts_client_errors_digest'); exception when others then null; end;
end $$;

select cron.schedule('alerts_client_errors_digest', '5 12 * * *',
  $cmd$ select public.cron_alert_client_errors_digest(); $cmd$);

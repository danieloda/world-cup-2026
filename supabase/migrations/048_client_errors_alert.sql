-- ============================================================
-- Migration 048: Erro de cliente → alerta no Telegram (reusa send_alert)
-- ============================================================
-- Liga a tabela client_errors (047) ao pipeline de alerts existente (007): um
-- erro não tratado do frontend dispara um ⚠️ warn no Telegram, pro admin ver o
-- bug ANTES do usuário reclamar.
--
-- Anti-spam (o chat é compartilhado com os participantes):
--   - severity 'warn' → a edge telegram-alert NÃO renderiza o bloco de context,
--     então NÃO vaza email/id/url; só emoji + título + corpo + link do dashboard.
--   - dedupe por ASSINATURA normalizada (mensagem sem números/ids) numa janela
--     de 6h: bug novo pinga na hora; repetições (mesmo de muitos usuários) ficam
--     quietas. send_alert compara category+context, então o context do dedupe é
--     SÓ a assinatura (estável); o detalhe rico vai no corpo/na tabela.
--
-- KEEP IN SYNC: src/js/error-reporter.js (produtor), 007_alerts.sql (send_alert).

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

drop trigger if exists trg_alert_client_error on public.client_errors;
create trigger trg_alert_client_error
  after insert on public.client_errors
  for each row
  execute function public.alert_client_error();

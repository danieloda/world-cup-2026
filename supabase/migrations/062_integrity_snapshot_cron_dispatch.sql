-- 062_integrity_snapshot_cron_dispatch.sql
--
-- Gatilho CONFIÁVEL do lacre diário (achado: cron interno do GitHub atrasa horas).
--
-- O workflow integrity-snapshot.yml está agendado p/ 03:09 UTC (00:09 BRT, "10 min
-- após a trava"), mas o scheduler do GitHub Actions é best-effort e neste repo vinha
-- disparando 4–8h atrasado todo dia (runs reais às 07–11 UTC). Resultado: o report,
-- a revelação no app (migration 060) e o post no grupo só saíam de madrugada —
-- DEPOIS de jogos que travam logo após a meia-noite (deadline véspera 23h59 BRT).
--
-- pg_cron do Supabase dispara no horário. Aqui ele chama o workflow_dispatch da
-- Action via pg_net às 00:10 BRT (10 min após a trava), tornando o lacre pontual.
-- O `schedule:` do GitHub fica como BACKSTOP: se o pg_cron falhar, o cron interno
-- ainda carimba (atrasado, mas a corrente não quebra). Disparo dobrado é inofensivo —
-- snapshot.js é content-addressed (dedupa) e confirm-publication tem guarda por seq.
--
-- ┌─ PRÉ-REQUISITO (uma vez, no SQL Editor de prod) ─────────────────────────────┐
-- │ 1. Crie um PAT fine-grained no GitHub com acesso SÓ ao repo                   │
-- │    danieloda/world-cup-2026 e SÓ a permissão "Actions: Read and write".       │
-- │    (Settings → Developer settings → Fine-grained tokens. Expiração curta —    │
-- │     dura só a Copa; é o único segredo e tem blast radius mínimo.)             │
-- │ 2. Guarde o PAT. Recomendado (Vault, criptografado):                          │
-- │      select vault.create_secret(                                              │
-- │        'github_pat_xxxxx', 'github_dispatch_pat',                             │
-- │        'PAT p/ workflow_dispatch do lacre de integridade');                   │
-- │    OU, paridade com app.anon_key (GUC, texto plano em pg_db_role_setting):    │
-- │      alter database postgres set app.github_dispatch_pat = 'github_pat_xxxxx';│
-- │      -- reabra a conexão/Editor depois; pg_cron pega em sessão nova.          │
-- └──────────────────────────────────────────────────────────────────────────────┘
--
-- KEEP IN SYNC: .github/workflows/integrity-snapshot.yml (workflow_dispatch + ref),
-- scripts/integrity/snapshot.js.

create or replace function public.cron_dispatch_integrity_snapshot()
returns bigint
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_pat        text;
  v_request_id bigint;
begin
  -- PAT: Vault primeiro (criptografado, recomendado); fallback no GUC app.*
  -- (mesma mecânica do app.anon_key dos alertas).
  begin
    select decrypted_secret into v_pat
    from vault.decrypted_secrets
    where name = 'github_dispatch_pat'
    limit 1;
  exception when others then
    v_pat := null;
  end;

  if v_pat is null or v_pat = '' then
    begin
      v_pat := current_setting('app.github_dispatch_pat', true);
    exception when others then
      v_pat := null;
    end;
  end if;

  if v_pat is null or v_pat = '' then
    raise notice '[integrity_dispatch] PAT ausente (vault github_dispatch_pat / app.github_dispatch_pat) — dispatch pulado.';
    return null;
  end if;

  -- workflow_dispatch da Action. GitHub exige User-Agent (sem ele → 403).
  -- Sucesso = HTTP 204 (ver net._http_response pelo request_id). pg_net é async.
  select net.http_post(
    url     := 'https://api.github.com/repos/danieloda/world-cup-2026/actions/workflows/integrity-snapshot.yml/dispatches',
    headers := jsonb_build_object(
      'Accept',               'application/vnd.github+json',
      'Authorization',        'Bearer ' || v_pat,
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent',           'world-cup-2026-integrity-cron',
      'Content-Type',         'application/json'
    ),
    body    := jsonb_build_object('ref', 'main')
  ) into v_request_id;

  raise notice '[integrity_dispatch] workflow_dispatch enviado (request_id=%).', v_request_id;
  return v_request_id;
exception when others then
  -- Nunca deixa o erro estourar no pg_cron — o backstop do GitHub cobre o dia.
  raise warning '[integrity_dispatch] falhou: %', sqlerrm;
  return null;
end;
$$;

-- 03:10 UTC = 00:10 BRT — 10 min após a trava. pg_cron agenda em UTC, igual aos
-- demais crons do projeto (026_alerts_daily_revamp). cron.schedule é idempotente
-- por nome (re-rodar a migration só reescreve o job).
select cron.schedule(
  'integrity_snapshot_dispatch',
  '10 3 * * *',
  $cmd$ select public.cron_dispatch_integrity_snapshot(); $cmd$
);

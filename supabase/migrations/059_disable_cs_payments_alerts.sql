-- ============================================================
-- Migration 059: desliga os alertas diários de campeão/artilheiro e pagamentos
-- ============================================================
-- Pedido do organizador (2026-06-11, Copa em andamento): os picks de campeão/
-- artilheiro travaram em 10/06 23h59 e a cobrança de pagamento não faz mais
-- sentido no grupo — os crons diários alerts_cs_completeness ("quem já
-- escolheu campeão & artilheiro") e alerts_daily_payments ("💰 Pagamentos do
-- bolão") viraram ruído. Desligamos só os AGENDAMENTOS; as funções ficam
-- intactas (reativar = re-agendar, instruções no fim).
--
-- ⚠️ HEARTBEAT: cron_heartbeat (026) é dead-man-switch e vigia EXATAMENTE
-- daily_payments/group_completeness/cs_completeness via settings.cron_lastrun_*.
-- Sem tirar os dois daqui, ~26h após o unschedule ele dispararia "cron de
-- alerta diário parado" — falso positivo. Re-declarado abaixo vigiando só
-- group_completeness (único dos três que segue agendado).
--
-- Os demais alertas de campeão/artilheiro NÃO precisam de nada:
--   • deadline_countdown se cala sozinho pós-prazo (_days_to_cs_deadline < 0);
--   • champion_revealed é evento de fim de Copa (deve continuar).
--
-- Seguro de re-colar isolado (lição 057/058): unschedule idempotente +
-- create or replace; nenhum grant é tocado.

do $$
begin
  begin perform cron.unschedule('alerts_cs_completeness'); exception when others then null; end;
  begin perform cron.unschedule('alerts_daily_payments');  exception when others then null; end;
end $$;

-- Idêntica à 026, exceto v_names: sai daily_payments e cs_completeness.
create or replace function public.cron_heartbeat()
returns void
language plpgsql
security definer
as $$
declare
  v_name text;
  v_last timestamptz;
  v_stale text := '';
  v_names text[] := array['group_completeness'];  -- era +daily_payments/cs_completeness (desligados na 059)
begin
  foreach v_name in array v_names loop
    select (trim(both '"' from (value #>> '{}')))::timestamptz into v_last
    from public.settings where key = 'cron_lastrun_' || v_name;

    if v_last is null or v_last < now() - interval '26 hours' then
      v_stale := v_stale || E'\n• ' || v_name || ': ' ||
                 coalesce(to_char(v_last at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'nunca rodou');
    end if;
  end loop;

  if v_stale <> '' then
    perform public.send_alert(
      'warn',
      'cron_heartbeat',
      'Cron(s) de alerta diário possivelmente parado(s)',
      'Os seguintes crons não rodam há mais de 26h:' || v_stale ||
      E'\n\nVerifique pg_cron (cron.job / cron.job_run_details) no dashboard.',
      jsonb_build_object('stale', v_stale),
      21600  -- dedup 6h pra não floodar
    );
  end if;
end $$;

comment on function public.cron_heartbeat is
'Cron a cada 6h. Dead-man-switch: avisa admin (warn) se group_completeness não rodou em 26h (daily_payments/cs_completeness desligados na 059).';

-- ============================================================
-- Pra REATIVAR no futuro (colar no SQL Editor):
--   select cron.schedule('alerts_daily_payments',  '0 12 * * *', $cmd$ select public.cron_alert_daily_payments(); $cmd$);
--   select cron.schedule('alerts_cs_completeness', '2 12 * * *', $cmd$ select public.cron_alert_cs_completeness(); $cmd$);
--   ...e re-colar o cron_heartbeat da 026 pra voltar a vigiá-los.
-- ============================================================

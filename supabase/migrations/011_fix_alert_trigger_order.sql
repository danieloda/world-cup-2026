-- ============================================================
-- Migration 011: Fix ordem de execucao dos alert triggers
-- ============================================================
-- HISTÓRICO: Esta migration corrigiu a ordem alfabética dos triggers de alerta
-- pra rodarem DEPOIS de trg_match_finished e trg_resolve_slots.
--
-- O fix foi INCORPORADO no migration 007_alerts.sql (que agora usa nomes
-- trg_z_alert_* já no momento da criação).
--
-- NO-OP — esta migration agora só re-aplica o fix por idempotência.
-- Safe rodar várias vezes.

drop trigger if exists trg_alert_orphan_predictions on public.matches;
drop trigger if exists trg_alert_unresolved_slots on public.matches;
drop trigger if exists trg_alert_pred_overwrite on public.predictions;

drop trigger if exists trg_z_alert_orphan_predictions on public.matches;
create trigger trg_z_alert_orphan_predictions
  after update on public.matches
  for each row
  execute function public.alert_check_orphan_predictions();

drop trigger if exists trg_z_alert_unresolved_slots on public.matches;
create trigger trg_z_alert_unresolved_slots
  after update on public.matches
  for each row
  execute function public.alert_check_unresolved_slots();

drop trigger if exists trg_z_alert_pred_overwrite on public.predictions;
create trigger trg_z_alert_pred_overwrite
  after update on public.predictions
  for each row
  execute function public.alert_check_pred_overwrite();

-- ============================================================
-- Migration 054: 2 alertas defensivos pro admin (pós-revisão dos testes)
-- ============================================================
-- A auditoria (docs/testing/AUDIT_REPORT_2026-06-07.md) achou 0 bug de produto
-- e cobertura forte. Estes 2 alertas são DEFENSE-IN-DEPTH: gritam se uma das
-- garantias testadas (trava de prazo / faixa de pontuação) for furada em prod.
-- Reusam send_alert (007/045) e _stage_max_pts (053). NÃO bloqueiam nada —
-- são AFTER + failure-safe. Idempotente.
--
-- 1. deadline_breach (⚠️ warn)  — palpite gravado APÓS o prazo, ANTES do jogo
--    acabar. O pred_overwrite (007) só pega UPDATE pós-finalizado; esta é a
--    janela do meio (RLS deveria barrar — se chegar aqui, é anomalia).
-- 2. scoring_anomaly (🚨 critical) — ao finalizar um jogo, algum points_earned
--    ficou fora de [0, máx-da-fase]. Sinal de bug no score_prediction.
--
-- KEEP IN SYNC: scripts/e2e/{seed-scale.js,seed-harness-state.js}
--   (trg_z_alert_scoring_anomaly entra nas listas de triggers de alerta
--    desligados durante o playout em massa).

-- ============================================================
-- 1) deadline_breach — palpite gravado fora do prazo (pré-fim)
-- ============================================================
create or replace function public.alert_pred_deadline_breach()
returns trigger
language plpgsql
security definer
as $$
declare
  v_match  record;
  v_action text;
begin
  -- Só interessa quando o CONTEÚDO do palpite muda (ou é novo). UPDATE que mexe
  -- só em points_earned (re-scoring) não conta.
  if tg_op = 'UPDATE'
     and old.pred_home       is not distinct from new.pred_home
     and old.pred_away       is not distinct from new.pred_away
     and old.pred_pen_winner is not distinct from new.pred_pen_winner
  then
    return new;
  end if;

  select match_date, finished, team_home, team_away
    into v_match
  from public.matches where id = new.match_id;

  -- Jogo já finalizado → é o território do pred_overwrite (007), não duplica.
  if v_match.finished is true then return new; end if;
  -- Dentro do prazo → tudo certo, palpite legítimo.
  if now() <= public.prediction_deadline(v_match.match_date) then return new; end if;

  v_action := case tg_op when 'INSERT' then 'inserida' else 'alterada' end;

  perform public.send_alert(
    'warn',
    'deadline_breach',
    format('Palpite gravado APÓS o prazo (match #%s)', new.match_id),
    format('A linha de predictions %s foi %s após o prazo do jogo %s x %s, que ainda não terminou. A trava de prazo (RLS) deveria ter bloqueado — convém investigar.',
           new.id, v_action, v_match.team_home, v_match.team_away),
    jsonb_build_object(
      'prediction_id', new.id,
      'match_id',      new.match_id,
      'user_id',       new.user_id,
      'op',            tg_op
    ),
    60  -- dedup 1 min por mesma combinação
  );
  return new;
exception when others then
  -- nunca propaga erro pro INSERT/UPDATE do palpite
  raise warning '[alert_pred_deadline_breach] %', sqlerrm;
  return new;
end $$;

drop trigger if exists trg_alert_deadline_breach on public.predictions;
create trigger trg_alert_deadline_breach
  after insert or update on public.predictions
  for each row
  execute function public.alert_pred_deadline_breach();

comment on function public.alert_pred_deadline_breach is
'AFTER INSERT/UPDATE em predictions. ⚠️ warn se um palpite for gravado/alterado após o prazo e antes do jogo acabar (a trava de prazo deveria barrar). Complementa o pred_overwrite (007), que só pega pós-finalização.';

-- ============================================================
-- 2) scoring_anomaly — points_earned fora de [0, máx-da-fase]
-- ============================================================
create or replace function public.alert_check_scoring_anomaly()
returns trigger
language plpgsql
security definer
as $$
declare
  v_max int;
  v_bad int;
  v_ids bigint[];
begin
  if new.finished is not true then return new; end if;
  if old.finished is true then return new; end if;   -- só a 1ª finalização
  if new.status = 'void' then return new; end if;

  v_max := public._stage_max_pts(new.stage);
  if v_max = 0 then return new; end if;               -- fase desconhecida: não avalia

  select count(*), array_agg(id)
    into v_bad, v_ids
  from public.predictions
  where match_id = new.id
    and points_earned is not null
    and (points_earned < 0 or points_earned > v_max);

  if coalesce(v_bad, 0) > 0 then
    perform public.send_alert(
      'critical',
      'scoring_anomaly',
      format('Pontuação fora da faixa no match #%s (%s)', new.id, new.stage),
      format('%s palpite(s) do match #%s (%s x %s) ficaram com points_earned fora de [0, %s] (máximo da fase %s). Possível bug no score_prediction — verifique antes que contamine o leaderboard.',
             v_bad, new.id, new.team_home, new.team_away, v_max, new.stage),
      jsonb_build_object(
        'match_id',       new.id,
        'stage',          new.stage,
        'bad_count',      v_bad,
        'max_pts',        v_max,
        'prediction_ids', v_ids
      ),
      0  -- sem dedup: cada jogo é único e isto é grave
    );
  end if;
  return new;
exception when others then
  raise warning '[alert_check_scoring_anomaly] %', sqlerrm;
  return new;
end $$;

-- trg_z_* → roda DEPOIS do trg_match_finished (recompute_prediction_points),
-- garantindo que points_earned já foi recalculado quando checamos.
drop trigger if exists trg_z_alert_scoring_anomaly on public.matches;
create trigger trg_z_alert_scoring_anomaly
  after update on public.matches
  for each row
  execute function public.alert_check_scoring_anomaly();

comment on function public.alert_check_scoring_anomaly is
'AFTER UPDATE em matches (1ª finalização). 🚨 critical se algum points_earned do jogo ficar fora de [0, _stage_max_pts(stage)]. Roda após o scoring (prefixo trg_z_).';

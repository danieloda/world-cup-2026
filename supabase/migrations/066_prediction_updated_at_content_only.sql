-- ============================================================
-- Migration 066: updated_at de palpite só muda quando o PALPITE muda
-- ============================================================
-- BUG (falso positivo na auditoria de prazo do lacre de integridade, 2026-06-17):
-- a auditoria em scripts/integrity/report.js usa predictions.updated_at como
-- "instante da última edição do palpite". Mas a coluna era bumpada por QUALQUER
-- UPDATE da linha, via o trigger COMPARTILHADO public.touch_updated_at()
-- (001_schema.sql:64) — inclusive pela ESCRITA DO SISTEMA em points_earned.
--
-- Quando um resultado entra, public.on_match_finished →
-- public.recompute_prediction_points (003_scoring.sql, SECURITY DEFINER, fura RLS)
-- faz `update predictions set points_earned=...`. Isso dispara touch_updated_at e
-- carimba updated_at = now() — sempre DEPOIS do prazo (o jogo já aconteceu). Logo
-- TODO palpite de jogo já pontuado passou a parecer "gravado após o prazo".
--
-- PROVA no snapshot lacrado: cada jogo FINALIZADO tem updated_at IDÊNTICO ao
-- microssegundo em todos os ~76 palpites (um único UPDATE em lote = o scoring);
-- jogos ABERTOS têm ~77 updated_at distintos (edições reais). Os palpites NÃO
-- foram alterados: a trava real (RLS predictions_update_own_before_deadline, 023)
-- e a trilha append-only (prediction_audit, 035) seguem intactas. Falhou só a
-- ESCOLHA da coluna na auditoria — uma coluna que o sistema também muta.
--
-- CORREÇÃO (duas partes, atômicas):
--   1) Trigger ESPECÍFICO de predictions que só move updated_at quando
--      pred_home/pred_away/pred_pen_winner mudam. (NÃO tocar no touch_updated_at
--      compartilhado por champion_picks/top_scorer_picks/settings — esses só são
--      escritos pelo usuário, nunca pelo scoring, e não têm o problema.)
--   2) BACKFILL: restaurar updated_at dos palpites já pontuados para o instante
--      REAL da última edição do palpite, recuperado da trilha prediction_audit
--      (último evento em que pred_* de fato mudou). Fallback: created_at (nunca é
--      mutado; é o instante do INSERT, sempre <= prazo por causa da RLS).
--   3) AUTOVERIFICAÇÃO: aborta (rollback) se sobrar QUALQUER palpite pontuado com
--      updated_at ainda > prazo. Fail-closed: ou cura tudo, ou não muda nada.
--
-- Idempotente: o guard `updated_at is distinct from` evita reescrita; reexecutar
-- não altera nada. KEEP IN SYNC: a semântica nova ("updated_at = última edição do
-- palpite") é o que scripts/integrity/{snapshot,report}.js assumem.
-- Aplicar no SQL Editor de prod.

-- ── 1) Trigger específico: updated_at acompanha só o conteúdo do palpite ──────
create or replace function public.touch_prediction_updated_at()
returns trigger language plpgsql as $$
begin
  if (new.pred_home, new.pred_away, new.pred_pen_winner)
       is distinct from (old.pred_home, old.pred_away, old.pred_pen_winner) then
    new.updated_at = now();
  end if;
  return new;
end $$;

drop trigger if exists trg_predictions_touch on public.predictions;
create trigger trg_predictions_touch
  before update on public.predictions
  for each row execute function public.touch_prediction_updated_at();

-- ── 2) Backfill: updated_at ← instante real da última edição do palpite ───────
-- Fonte da verdade: prediction_audit (035), que guarda old/new completos de toda
-- escrita. "Edição de palpite" = INSERT, ou UPDATE em que pred_* mudou de fato
-- (exclui a escrita de points_earned, em que pred_* fica igual).
update public.predictions p
set updated_at = healed.ts
from (
  select pr.id,
    coalesce(
      (select max(a.at)
         from public.prediction_audit a
        where a.table_name = 'predictions'
          and a.row_user_id = pr.user_id
          and a.match_id    = pr.match_id
          and (a.op = 'INSERT'
            or (a.new_data->>'pred_home')       is distinct from (a.old_data->>'pred_home')
            or (a.new_data->>'pred_away')       is distinct from (a.old_data->>'pred_away')
            or (a.new_data->>'pred_pen_winner') is distinct from (a.old_data->>'pred_pen_winner'))),
      pr.created_at  -- sem trilha (palpite anterior à 035): cai no INSERT, <= prazo
    ) as ts
  from public.predictions pr
  where pr.points_earned is not null  -- só os pontuados — os que o scoring carimbou
) healed
where p.id = healed.id
  and p.updated_at is distinct from healed.ts;

-- ── 3) Autoverificação: nenhum palpite pontuado pode sobrar após o prazo ──────
do $$
declare
  v_bad  int;
  v_total int;
begin
  select count(*) into v_total
  from public.predictions where points_earned is not null;

  select count(*) into v_bad
  from public.predictions p
  join public.matches m on m.id = p.match_id
  where p.points_earned is not null
    and p.updated_at > public.prediction_deadline(m.match_date);

  if v_bad > 0 then
    raise exception
      'Migration 066 ABORTADA: % de % palpites pontuados ainda com updated_at > prazo. Backfill incompleto — não comitar.',
      v_bad, v_total;
  end if;

  raise notice 'Migration 066 OK: % palpites pontuados, 0 com updated_at apos o prazo.', v_total;
end $$;

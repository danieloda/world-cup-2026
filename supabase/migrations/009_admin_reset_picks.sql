-- ============================================================
-- Migration 009: admin_reset_picks() — limpa picks/predictions/goals
-- ============================================================
-- Complementa admin_reset_matches: alem dos matches, limpa tambem
-- predictions, champion_picks, top_scorer_picks, player_goals.
--
-- Por que precisamos? RLS de champion_picks e top_scorer_picks nao tem
-- policy de DELETE — qualquer DELETE via API eh negado. Esta funcao
-- contorna isso de forma segura (SECURITY DEFINER + admin guard).

create or replace function public.admin_reset_picks()
returns table(
  predictions_deleted int,
  champion_picks_deleted int,
  scorer_picks_deleted int,
  player_goals_deleted int
)
language plpgsql
security definer
as $$
declare
  v_preds int;
  v_champ int;
  v_scorer int;
  v_goals int;
begin
  -- Guard: somente admin
  if not public.is_admin() then
    raise exception 'admin_reset_picks: caller is not admin (RLS guard)';
  end if;

  -- ORDEM IMPORTA: child tables primeiro
  -- (WHERE true necessario pelo guard "DELETE requires WHERE clause")
  delete from public.player_goals where true;
  get diagnostics v_goals = row_count;

  delete from public.predictions where true;
  get diagnostics v_preds = row_count;

  delete from public.champion_picks where true;
  get diagnostics v_champ = row_count;

  delete from public.top_scorer_picks where true;
  get diagnostics v_scorer = row_count;

  -- Loga
  perform public.send_alert(
    'info',
    'admin_reset',
    format('Admin reset_picks() executado'),
    format('Apagados: %s predictions, %s champion_picks, %s top_scorer_picks, %s player_goals',
           v_preds, v_champ, v_scorer, v_goals),
    jsonb_build_object(
      'predictions_deleted', v_preds,
      'champion_picks_deleted', v_champ,
      'scorer_picks_deleted', v_scorer,
      'player_goals_deleted', v_goals
    ),
    0
  );

  return query select v_preds, v_champ, v_scorer, v_goals;
end $$;

comment on function public.admin_reset_picks is
'E2E test helper: apaga TODAS predictions/champion_picks/top_scorer_picks/player_goals. Admin-only.';

grant execute on function public.admin_reset_picks() to authenticated;

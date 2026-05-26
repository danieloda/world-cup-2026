-- ============================================================
-- Migration 008: admin_reset_matches() — utilitario pra E2E test
-- ============================================================
-- Restaura matches pro estado inicial:
--   - team_home = COALESCE(slot_home, team_home)
--   - team_away = COALESCE(slot_away, team_away)
--   - actual_home, actual_away = NULL
--   - pen_winner = NULL
--   - finished = false
--   - finished_at = NULL
--
-- Security: SECURITY DEFINER + verificacao explicita de admin via public.is_admin().
-- Caller PRECISA estar logado como admin pra rodar.
--
-- Triggers (resolve_slots, on_match_finished, alerts) vao disparar mas serao
-- no-ops porque todos ficam com finished=false.

create or replace function public.admin_reset_matches()
returns table(
  matches_reset int,
  ko_slots_restored int
)
language plpgsql
security definer
as $$
declare
  v_total int;
  v_ko_restored int;
begin
  -- Guard: somente admin
  if not public.is_admin() then
    raise exception 'admin_reset_matches: caller is not admin (RLS guard)';
  end if;

  -- Restaura team_home/team_away pro slot original (apenas KO matches)
  update public.matches
     set team_home = slot_home
   where slot_home is not null
     and team_home <> slot_home;

  get diagnostics v_ko_restored = row_count;

  update public.matches
     set team_away = slot_away
   where slot_away is not null
     and team_away <> slot_away;

  -- Zera campos de resultado em TODOS os matches
  update public.matches
     set actual_home = null,
         actual_away = null,
         pen_winner  = null,
         finished    = false,
         finished_at = null
   where finished = true
      or actual_home is not null
      or actual_away is not null
      or pen_winner is not null;

  get diagnostics v_total = row_count;

  -- Loga via alert (opcional)
  perform public.send_alert(
    'info',
    'admin_reset',
    format('Admin reset_matches() executado: %s matches resetados', v_total),
    format('Restaurou %s slots KO. Zerou %s matches com finished/actual/pen_winner.', v_ko_restored, v_total),
    jsonb_build_object('matches_reset', v_total, 'ko_slots_restored', v_ko_restored),
    0  -- sem dedup
  );

  return query select v_total, v_ko_restored;
end $$;

comment on function public.admin_reset_matches is
'E2E test helper: restaura matches pro estado inicial. Admin-only. Dispara alerta no Telegram pra auditoria.';

-- Permite que authenticated chame (a propria funcao checa admin)
grant execute on function public.admin_reset_matches() to authenticated;

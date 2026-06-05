-- ============================================================
-- Migration 036: Integridade de resultado (achados M3, M4)
-- ============================================================
-- M3: "Limpar resultado" no admin eram DOIS requests separados (matches +
--     predictions.points_earned=null), sem transação → falha no meio deixa
--     estado inconsistente. Vira RPC atômica admin-only.
-- M4: não havia CHECK exigindo pen_winner num mata-mata empatado → admin podia
--     gravar (via curl) um KO 1x1 sem pen_winner, zerando o bônus de campeão
--     pra TODOS e distribuindo AVE errado.

-- ============================================================
-- M4) Resultado de mata-mata consistente
-- ============================================================
-- Empate (actual_home = actual_away) em jogo de mata-mata só é válido com
-- pen_winner definido. Grupos podem empatar sem pen_winner. Jogo sem resultado
-- (actual_home null) não é restringido.
alter table public.matches
  drop constraint if exists matches_ko_needs_pen_winner;
alter table public.matches
  add constraint matches_ko_needs_pen_winner check (
    stage = 'group'
    or actual_home is null
    or actual_home <> actual_away
    or pen_winner is not null
  );

-- Domínio de pen_winner (espelha o check de predictions.pred_pen_winner).
alter table public.matches
  drop constraint if exists matches_pen_winner_domain;
alter table public.matches
  add constraint matches_pen_winner_domain check (
    pen_winner is null or pen_winner in ('home', 'away')
  );

-- ============================================================
-- M3) admin_clear_result(match_id) — atômico, admin-only
-- ============================================================
-- Zera o resultado e os pontos numa única transação. O recompute oficial (null
-- nos points) roda como dono (SECURITY DEFINER), bypassando a policy do C1.
create or replace function public.admin_clear_result(p_match_id int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_clear_result: caller is not admin (RLS guard)';
  end if;

  update public.matches
     set actual_home = null,
         actual_away = null,
         pen_winner  = null,
         finished    = false,
         finished_at = null
   where id = p_match_id;

  update public.predictions
     set points_earned = null
   where match_id = p_match_id;

  delete from public.player_goals
   where match_id = p_match_id;
end $$;

-- admin-guard interno; exposto a authenticated (a própria função checa is_admin).
grant execute on function public.admin_clear_result(int) to authenticated;

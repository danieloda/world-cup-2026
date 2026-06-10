-- ============================================================
-- Migration 034: Blindagem de RLS (auditoria QA/pentest)
-- ============================================================
-- Fecha 3 achados:
--   C1 (Crítico): a RLS de predictions permitia o usuário gravar points_earned.
--   H1 (Alto):    compute_predicted_slots / qualifier_bonus_for eram SECURITY
--                 DEFINER e estavam GRANTed a authenticated → IDOR: qualquer
--                 logado lia o bracket PALPITADO de outro usuário antes do apito.
--   H2 (Alto):    nenhuma função tinha REVOKE → toda função (inclusive as
--                 SECURITY DEFINER) era chamável por anon/authenticated via RPC
--                 (vazamento + DoS de recompute).
--
-- PRESERVADO de propósito (NÃO revogar):
--   - report_signup_failure(text,text)  → chamada por anon na página de signup
--   - admin_pred_progress()             → chamada pelo admin (auto-gated)
--   - is_admin(), prediction_deadline(timestamptz), cs_deadline()
--       → usadas DENTRO de policies RLS; são avaliadas no contexto do CALLER
--         (role authenticated). Revogá-las quebraria toda a avaliação da policy.
--
-- VALIDAR no stack local antes de prod:
--   supabase db reset && node scripts/e2e/test-rls-hostile.js
--   + salvar um resultado no admin (exercita o trigger trg_s_qualifier_bonus).

-- ============================================================
-- C1) predictions: proibir o cliente de gravar points_earned
-- ============================================================
-- O upsert legítimo do palpite (palpites-grupos / palpites-mata) nunca manda
-- points_earned, e antes do prazo o jogo não terminou → a coluna é sempre NULL.
-- Forçar `points_earned is null` no WITH CHECK fecha a injeção sem afetar a UI.
-- O recompute oficial roda via trigger SECURITY DEFINER (dono da tabela, que
-- bypassa RLS), então continua podendo gravar os pontos corretos.
drop policy if exists "predictions_insert_own_before_deadline" on public.predictions;
create policy "predictions_insert_own_before_deadline"
  on public.predictions for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and points_earned is null
    and exists (
      select 1 from public.matches m
      where m.id = match_id
        and now() < public.prediction_deadline(m.match_date)
    )
  );

drop policy if exists "predictions_update_own_before_deadline" on public.predictions;
create policy "predictions_update_own_before_deadline"
  on public.predictions for update
  to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and points_earned is null
    and exists (
      select 1 from public.matches m
      where m.id = match_id
        and now() < public.prediction_deadline(m.match_date)
    )
  );

-- predictions_admin_all (FOR ALL, is_admin()) continua valendo: o admin pode
-- gravar points_earned (caminho confiável). A migration 035 audita essa escrita.

-- ============================================================
-- H1 + H2) trigger_qualifier_bonus vira SECURITY DEFINER
-- ============================================================
-- Pré-requisito pra revogar recompute_qualifier_points de authenticated SEM
-- quebrar o admin. Hoje este trigger roda no contexto de QUEM atualiza matches
-- (o admin = role 'authenticated') e chama recompute_qualifier_points; se esse
-- EXECUTE for revogado de authenticated, o trigger falha e salvar resultado
-- quebra. Tornando-o SECURITY DEFINER, a chamada aninhada roda como dono.
create or replace function public.trigger_qualifier_bonus()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and (
       old.finished    is distinct from new.finished
    or old.actual_home is distinct from new.actual_home
    or old.actual_away is distinct from new.actual_away
    or old.pen_winner  is distinct from new.pen_winner
  ) then
    perform public.recompute_qualifier_points(null);
  end if;
  return new;
end $$;
-- (trigger trg_s_qualifier_bonus continua apontando pra esta função; nome/ordem
--  inalterados.)

-- ============================================================
-- H1 + H2) REVOKE deny-by-default
-- ============================================================
-- Cadeia de execução que continua funcionando após o revoke (tudo roda como dono):
--   on_match_finished (SECURITY DEFINER) → recompute_prediction_points
--   trg_s_qualifier_bonus (agora DEFINER) → recompute_qualifier_points
--                                         → qualifier_bonus_for → compute_predicted_slots
--                                         → _backtrack_thirds_pred
--   v_leaderboard / v_scorer_ranking (views, contexto do dono) → *_bonus_for
revoke execute on function public.compute_predicted_slots(uuid)                  from public, anon, authenticated;
revoke execute on function public.qualifier_bonus_for(uuid)                      from public, anon, authenticated;
revoke execute on function public._backtrack_thirds_pred(int, int, jsonb, text[]) from public, anon, authenticated;
revoke execute on function public.recompute_prediction_points(int)               from public, anon, authenticated;
revoke execute on function public.recompute_qualifier_points(uuid)               from public, anon, authenticated;

-- Helpers de pontuação puros / usados só em views (contexto do dono).
-- Não vazam dados por usuário, mas deny-by-default por higiene (H2).
revoke execute on function public.score_prediction(int,int,text,int,int,text,text) from public, anon, authenticated;
revoke execute on function public.stage_multiplier(text)                          from public, anon, authenticated;
revoke execute on function public.champion_bonus_for(uuid)                        from public, anon, authenticated;
revoke execute on function public.scorer_bonus_for(uuid)                          from public, anon, authenticated;
revoke execute on function public.qualifier_bonus_pts(text, boolean)             from public, anon, authenticated;

-- Sanidade: confirme que os 2 RPCs do front continuam executáveis por quem precisa.
grant execute on function public.report_signup_failure(text, text) to anon, authenticated;
grant execute on function public.admin_pred_progress() to authenticated;

-- ============================================================
-- [Adendo 2026-06-09 — pós-incidente; ver headers da 040 e da 057]
-- Estado CANÔNICO do trio do leaderboard é COM grant: v_leaderboard e
-- v_scorer_ranking chamam essas funções e o EXECUTE é checado contra o INVOKER
-- (o usuário logado), então o revoke acima derruba a página de ranking. A 040
-- já reconcedia; este bloco existe porque prod aplica migrations À MÃO no SQL
-- Editor — REAPLICAR este arquivo depois da 040 revogava de novo e derrubou o
-- ranking de prod em 2026-06-09. Com o bloco, o arquivo é seguro de re-colar.
grant execute on function public.champion_bonus_for(uuid) to authenticated;
grant execute on function public.scorer_bonus_for(uuid)   to authenticated;
grant execute on function public.stage_multiplier(text)   to authenticated;

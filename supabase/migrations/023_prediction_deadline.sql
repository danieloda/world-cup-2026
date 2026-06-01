-- ============================================================
-- Migration 023: Trava de palpite na VÉSPERA (23h59 horário de Brasília)
-- ============================================================
-- Antes: palpite de um jogo travava no APITO INICIAL (match_date > now()).
-- Agora: trava às 23h59 (America/Sao_Paulo) do DIA ANTERIOR ao jogo.
--   Ex.: jogo 15/jun 16h → fecha 14/jun 23h59.
--
-- KEEP IN SYNC com js/util.js (predictionDeadline / isLocked).
-- A revelação dos palpites alheios (SELECT) continua no APITO (match_date <= now),
-- ou seja: trava na véspera, mas só fica visível quando o jogo começa.

-- Prazo do palpite = 23h59 (Brasília) da véspera do jogo.
create or replace function public.prediction_deadline(p_match_date timestamptz)
returns timestamptz language sql immutable as $$
  select ((date_trunc('day', p_match_date at time zone 'America/Sao_Paulo')
            - interval '1 day' + interval '23 hours 59 minutes')
          at time zone 'America/Sao_Paulo');
$$;

grant execute on function public.prediction_deadline(timestamptz) to authenticated;

-- INSERT: só o próprio, só antes do prazo (véspera 23h59)
drop policy if exists "predictions_insert_own_before_kickoff" on public.predictions;
drop policy if exists "predictions_insert_own_before_deadline" on public.predictions;
create policy "predictions_insert_own_before_deadline"
  on public.predictions for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.matches m
      where m.id = match_id
        and now() < public.prediction_deadline(m.match_date)
    )
  );

-- UPDATE: só o próprio, só antes do prazo (véspera 23h59)
drop policy if exists "predictions_update_own_before_kickoff" on public.predictions;
drop policy if exists "predictions_update_own_before_deadline" on public.predictions;
create policy "predictions_update_own_before_deadline"
  on public.predictions for update
  to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.matches m
      where m.id = match_id
        and now() < public.prediction_deadline(m.match_date)
    )
  );

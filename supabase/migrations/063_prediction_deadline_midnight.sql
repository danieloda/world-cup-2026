-- ============================================================
-- Migration 063: jogos à MEIA-NOITE travam com o lote do dia anterior
-- ============================================================
-- A 023 fixou o prazo em "23h59 BRT da véspera do jogo". Para jogos que começam
-- 00:00 BRT isso dá só 1 minuto de folga (apito às 00:00, prazo 23h59 da véspera)
-- e, pior, o lacre diário (00:10 BRT, migration 062) cai DEPOIS do apito — o
-- carimbo/revelação/post do grupo perderiam a janela.
--
-- Correção: jogos cuja hora de início (BRT) é 0 (00:00–00:59) travam um dia A MAIS
-- cedo — ou seja, junto com o LOTE DO DIA ANTERIOR. Aí o lacre das 00:10 da
-- véspera os sela ~24h antes do apito, reusando o pipeline atual sem cron novo.
--   Ex.: jogo 20/jun 00:00 BRT → fecha 18/jun 23:59 (não 19/jun).
--   Jogo 21/jun 01:00 BRT → INALTERADO, fecha 20/jun 23:59 (lacre 00:10 já é antes).
--
-- Só substitui a função; as policies de INSERT/UPDATE (023/034) já a CHAMAM, e
-- todo o resto (alertas, reveal 060, snapshot do lacre) também — a regra nova
-- propaga sozinha. Aplicar no SQL Editor de prod ANTES de 18/jun (1º prazo novo).
--
-- KEEP IN SYNC: src/js/util.js (predictionDeadline) e scripts/integrity/snapshot.js
-- (cópia própria) — cobertos por tests/unit/deadline-parity.test.js.

create or replace function public.prediction_deadline(p_match_date timestamptz)
returns timestamptz language sql immutable as $$
  select ((date_trunc('day', p_match_date at time zone 'America/Sao_Paulo')
            - case
                when extract(hour from p_match_date at time zone 'America/Sao_Paulo') = 0
                  then interval '2 days'   -- jogo à meia-noite: lote do dia anterior
                else interval '1 day'
              end
            + interval '23 hours 59 minutes')
          at time zone 'America/Sao_Paulo');
$$;

grant execute on function public.prediction_deadline(timestamptz) to authenticated;

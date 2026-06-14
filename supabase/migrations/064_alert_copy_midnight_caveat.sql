-- ============================================================
-- Migration 064: copy dos alertas — ressalva da meia-noite
-- ============================================================
-- A migration 063 fez jogos de meia-noite (00h BRT) travarem 1 dia antes (com o
-- lote do dia anterior). A copy genérica dos alertas ("cada jogo trava 23h59 da
-- véspera") ficou imprecisa pra esses 4 jogos. Esta migration acrescenta a
-- ressalva, mudando SÓ a string — sem tocar na lógica das funções.
--
-- Por que um DO-block em vez de re-`create or replace` das funções inteiras:
-- as 3 funções vivas são grandes (group_completeness ~118 linhas) e copiá-las à
-- mão arriscaria regredir lógica de alerta. Aqui lemos a definição VIVA de cada
-- função (pg_get_functiondef), trocamos apenas a frase e re-executamos — o corpo
-- vem do próprio banco, então é impossível alterar a lógica. Idempotente (rodar
-- de novo é no-op: as strings antigas já não existem) e auto-auditável (avisa se
-- alguma forma conhecida não casar).
--
-- Mudanças de copy (antigo → novo), por função:
--   cron_alert_group_completeness (055):
--     "Cada jogo trava às 23h59 da véspera."
--   → "Cada jogo trava às 23h59 da véspera (jogos de meia-noite, 1 dia antes)."
--   alert_match_status_changed (053, aviso de adiamento):
--     "(trava 23h59 da véspera)."
--   → "(trava 23h59 da véspera; jogos de meia-noite, 1 dia antes)."
--   alert_ko_phase_opens (042):
--     "Cada jogo trava 23h59 da véspera. 👇"
--   → "Cada jogo trava 23h59 da véspera (jogos de meia-noite, 1 dia antes). 👇"
--
-- O prazo exato de CADA jogo já é mostrado no app pelo countdown "Bloqueia em…"
-- (fonte autoritativa); esta copy é só o lembrete genérico.

do $mig$
declare
  fn  regprocedure;
  src text;
  out text;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and pg_get_functiondef(p.oid) like '%23h59 da véspera%'
  loop
    src := pg_get_functiondef(fn);
    out := src;
    out := replace(out,
      'Cada jogo trava às 23h59 da véspera.',
      'Cada jogo trava às 23h59 da véspera (jogos de meia-noite, 1 dia antes).');
    out := replace(out,
      'Cada jogo trava 23h59 da véspera. 👇',
      'Cada jogo trava 23h59 da véspera (jogos de meia-noite, 1 dia antes). 👇');
    out := replace(out,
      '(trava 23h59 da véspera).',
      '(trava 23h59 da véspera; jogos de meia-noite, 1 dia antes).');

    if out = src then
      raise warning '[064] % contém a copy mas nenhuma forma conhecida casou — revise.', fn;
    else
      execute out;
      raise notice '[064] copy refinada em %.', fn;
    end if;
  end loop;
end
$mig$;

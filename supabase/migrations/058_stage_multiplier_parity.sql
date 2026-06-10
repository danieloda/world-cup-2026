-- ============================================================
-- Migration 058: stage_multiplier — re-aplica os valores CANÔNICOS em prod
-- ============================================================
-- DRIFT achado pela auditoria de paridade de 2026-06-09 (scripts/dev/
-- prod-parity-audit.mjs): a 003 foi EDITADA NO REPO depois de aplicada
-- (comentários "was 2.5/3.0/4.0, increased for comeback potential"), mas a
-- função editada nunca foi re-colada em prod. Resultado: prod rodava os
-- multiplicadores ORIGINAIS do artilheiro enquanto site/regras/UI prometem
-- os novos (scoring.js stageMultiplier, campeao-artilheiro.js STAGE_MULT):
--
--   fase    prod (003 original)   canônico (repo)
--   qf      2.5                   3.0
--   sf      3.0                   4.0
--   final   4.0                   5.0     (demais fases já batiam)
--
-- IMPACTO se não corrigir: bônus de artilheiro subpago de quartas em diante
-- (ex.: gol na final pagaria 8 em vez de 10) e prod-verify quebrando no
-- primeiro gol de QF. NADA a recomputar: scorer_bonus_for calcula ao vivo
-- (nenhum valor persistido usa o multiplicador) e ainda não há gols.
--
-- LIÇÃO (dual do incidente 057): migration antiga editada no repo precisa
-- virar migration NOVA — prod não "puxa" edição de arquivo já aplicado.
-- KEEP IN SYNC: src/js/scoring.js (stageMultiplier) · src/js/pages/
-- campeao-artilheiro.js (STAGE_MULT) · tests/unit/scoring-parity.test.js
-- (sentinela: latest = 058).

create or replace function public.stage_multiplier(stage text)
returns numeric language sql immutable as $$
  select case stage
    when 'group' then 1.0
    when 'r32'   then 1.5
    when 'r16'   then 2.0
    when 'qf'    then 3.0
    when 'sf'    then 4.0
    when 'third' then 2.0
    when 'final' then 5.0
    else 1.0
  end;
$$;

-- Estado canônico dos grants (040/057): create or replace preserva, mas
-- re-assevera p/ este arquivo ser seguro de re-colar isolado.
grant execute on function public.stage_multiplier(text) to authenticated;

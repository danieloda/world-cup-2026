-- ════════════════════════════════════════════════════════════════════
-- Cenário E2E: a função public.score_prediction (DB) bate EXATAMENTE com
-- o espelho JS (js/scoring.js / scripts/e2e/lib/scoring.js) em todos os
-- componentes (ag por lado, ave vencedor/empate, dg saldo) e em todas as fases.
--
-- Por quê: o 05-audit só confere TOTAIS agregados via v_leaderboard. Uma
-- divergência rara no SQL (ex.: empate de KO decidido nos pênaltis, ou um
-- valor de fase trocado) passaria batido no agregado se os palpites de teste
-- não exercitassem aquele caso. Aqui chamamos score_prediction() direto com
-- entradas conhecidas e exigimos o valor esperado, fase por fase.
--
-- Roda numa transação que NÃO escreve nada (é tudo SELECT de função pura).
-- Modelo ADITIVO (migration 022). Valores canônicos por fase (ag/ave/dg):
--   group 1/4/1 · r32 1/6/1 · r16 3/12/1 · qf 5/20/2 · sf 8/32/2 · third 4/16/1 · final 12/48/4
-- Exato = 2*ag + ave + dg.   KEEP IN SYNC com 022_additive_scoring.sql + js/scoring.js.
-- ════════════════════════════════════════════════════════════════════
begin;

do $$
declare
  n_ok int := 0;
  n_fail int := 0;
  got int;
  exp int;
  -- fases e seus pesos canônicos (ag / ave / dg)
  stages text[] := array['group','r32','r16','qf','sf','third','final'];
  agv int[]  := array[1,1,3,5,8,4,12];
  avev int[] := array[4,6,12,20,32,16,48];
  dgv int[]  := array[1,1,1,2,2,1,4];
  i int;
  st text;
  vag int; vave int; vdg int;
begin
  for i in 1 .. array_length(stages,1) loop
    st := stages[i]; vag := agv[i]; vave := avev[i]; vdg := dgv[i];

    -- Caso 1: PLACAR EXATO (home win). pred 2-1 == real 2-1 → 2*ag + ave + dg
    got := public.score_prediction(2,1,null, 2,1,null, st);
    exp := 2*vag + vave + vdg;
    if got = exp then n_ok:=n_ok+1; else n_fail:=n_fail+1;
      raise warning 'FAIL [%/exato 2-1] got=% exp=%', st, got, exp; end if;

    -- Caso 2: vencedor + saldo certos, nenhum lado exato (pred 3-2 vs real 2-1) → ave + dg
    got := public.score_prediction(3,2,null, 2,1,null, st);
    exp := vave + vdg;
    if got = exp then n_ok:=n_ok+1; else n_fail:=n_fail+1;
      raise warning 'FAIL [%/vence+saldo 3-2v2-1] got=% exp=%', st, got, exp; end if;

    -- Caso 3: 1 lado exato + vencedor certo, saldo errado (pred 2-0 vs real 2-1) → ag + ave
    got := public.score_prediction(2,0,null, 2,1,null, st);
    exp := vag + vave;
    if got = exp then n_ok:=n_ok+1; else n_fail:=n_fail+1;
      raise warning 'FAIL [%/1lado+vence 2-0v2-1] got=% exp=%', st, got, exp; end if;

    -- Caso 4: tudo errado (pred 0-3 vs real 2-1) → 0
    got := public.score_prediction(0,3,null, 2,1,null, st);
    exp := 0;
    if got = exp then n_ok:=n_ok+1; else n_fail:=n_fail+1;
      raise warning 'FAIL [%/tudo errado 0-3v2-1] got=% exp=%', st, got, exp; end if;

    -- Caso 5: empate exato (pred 1-1 vs real 1-1) → 2*ag + ave + dg
    got := public.score_prediction(1,1,null, 1,1,null, st);
    exp := 2*vag + vave + vdg;
    if got = exp then n_ok:=n_ok+1; else n_fail:=n_fail+1;
      raise warning 'FAIL [%/empate exato 1-1] got=% exp=%', st, got, exp; end if;

    -- Caso 6: saldo certo via empates diferentes (pred 2-2 vs real 1-1) → ave + dg
    got := public.score_prediction(2,2,null, 1,1,null, st);
    exp := vave + vdg;
    if got = exp then n_ok:=n_ok+1; else n_fail:=n_fail+1;
      raise warning 'FAIL [%/empate saldo 2-2v1-1] got=% exp=%', st, got, exp; end if;
  end loop;

  -- ── KO decidido nos PÊNALTIS (r16: ag=3 ave=12 dg=1) ──
  -- 6a: pred 1-1 pen=home, real 1-1 pen=home → exato + vencedor pênalti certo
  got := public.score_prediction(1,1,'home', 1,1,'home', 'r16');
  exp := 2*3 + 12 + 1;
  if got = exp then n_ok:=n_ok+1; else n_fail:=n_fail+1;
    raise warning 'FAIL [r16/pen home==home] got=% exp=%', got, exp; end if;

  -- 6b: pred 1-1 pen=home, real 1-1 pen=away → placar exato (2ag + dg) mas vencedor errado → SEM ave
  got := public.score_prediction(1,1,'home', 1,1,'away', 'r16');
  exp := 2*3 + 1;
  if got = exp then n_ok:=n_ok+1; else n_fail:=n_fail+1;
    raise warning 'FAIL [r16/pen home!=away sem ave] got=% exp=%', got, exp; end if;

  -- 6c: GRUPO empate 1-1 vs 1-1 (pen irrelevante) → ave de empate conta
  got := public.score_prediction(1,1,null, 1,1,null, 'group');
  exp := 2*1 + 4 + 1;
  if got = exp then n_ok:=n_ok+1; else n_fail:=n_fail+1;
    raise warning 'FAIL [group/empate pen-irrelev] got=% exp=%', got, exp; end if;

  -- ── NULL guard: palpite incompleto → 0 ──
  got := public.score_prediction(null,1,null, 2,1,null, 'group');
  if got = 0 then n_ok:=n_ok+1; else n_fail:=n_fail+1;
    raise warning 'FAIL [null guard] got=% exp=0', got; end if;

  -- ── Fase desconhecida cai no default 'group' (igual ao JS matchPoints) ──
  if public.score_prediction(2,1,null,2,1,null,'group') = public.score_prediction(2,1,null,2,1,null,'xyz')
    then n_ok:=n_ok+1; else n_fail:=n_fail+1;
    raise warning 'FAIL [fase desconhecida != group default]'; end if;

  raise notice '────────────────────────────────────────────';
  raise notice 'score_prediction: % checks OK, % FALHAS', n_ok, n_fail;
  if n_fail > 0 then
    raise exception 'SCORING-SQL: % checks falharam (veja warnings acima)', n_fail;
  end if;
  raise notice 'OK: score_prediction (DB) bate com o canonico em todas as fases.';
end $$;

rollback;

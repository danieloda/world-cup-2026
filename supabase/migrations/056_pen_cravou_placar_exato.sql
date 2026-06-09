-- ============================================================
-- Migration 056: cravar o placar do tempo normal = placar exato CHEIO,
--                mesmo errando quem passou nos pênaltis.
-- ============================================================
-- A regra (regras.html#penaltis) sempre prometeu: "Se você cravar o placar do
-- tempo normal, leva o placar exato — mesmo que erre quem ganhou nos pênaltis."
-- Mas a engine (score_prediction de 022) só dava o ponto de RESULTADO (ave)
-- quando o vencedor — incluindo o pênalti — batia. Resultado: quem cravava um
-- empate de mata-mata e errava o pênalti perdia o ave (no R16, 7 de 19 pts) —
-- o oposto do que a regra promete.
--
-- Correção: o ponto de resultado (ave) também conta quando o PLACAR é exato
-- (ph = ah AND pa = aw), independente do pênalti. Espelha js/scoring.js.
-- KEEP IN SYNC com src/js/scoring.js (scorePrediction/scoreBreakdown).
-- ============================================================

create or replace function public.score_prediction(
  ph int, pa int, p_pen text,
  ah int, aw int, a_pen text,
  stage text
) returns int language plpgsql immutable as $$
declare
  ag int; ave int; dg int;
  pts int := 0;
  pred_w text; act_w text;
begin
  if ph is null or pa is null or ah is null or aw is null then
    return 0;
  end if;

  ag := case stage
    when 'group' then 1 when 'r32' then 1 when 'r16' then 3 when 'qf' then 5
    when 'sf' then 8 when 'third' then 4 when 'final' then 12 else 1 end;
  ave := case stage
    when 'group' then 4 when 'r32' then 6 when 'r16' then 12 when 'qf' then 20
    when 'sf' then 32 when 'third' then 16 when 'final' then 48 else 4 end;
  dg := case stage when 'qf' then 2 when 'sf' then 2 when 'final' then 4 else 1 end;

  -- AG: um ponto-pacote por LADO acertado (0, 1 ou 2 lados)
  if ph = ah then pts := pts + ag; end if;
  if pa = aw then pts := pts + ag; end if;

  -- AVE: vencedor/empate (mata-mata empatado usa pen_winner). CRAVAR o placar do
  -- tempo normal (ph=ah E pa=aw) garante o resultado MESMO errando o pênalti —
  -- regra "cravou = placar exato" (regras.html#penaltis).
  pred_w := case when ph > pa then 'h' when pa > ph then 'a'
                 when stage <> 'group' and p_pen is not null then p_pen else 'd' end;
  act_w  := case when ah > aw then 'h' when aw > ah then 'a'
                 when stage <> 'group' and a_pen is not null then a_pen else 'd' end;
  if (ph = ah and pa = aw) or pred_w = act_w then pts := pts + ave; end if;

  -- DG: saldo de gols (inclui empate, saldo 0)
  if (ph - pa) = (ah - aw) then pts := pts + dg; end if;

  return pts;
end $$;

-- A função é SECURITY-sensível: continua sem EXECUTE p/ public/anon/authenticated
-- (revogado em 034). create or replace PRESERVA os grants; re-revoga por garantia.
revoke execute on function public.score_prediction(int,int,text,int,int,text,text)
  from public, anon, authenticated;

-- Re-pontua TODOS os palpites já lançados com a nova regra (mesmo recompute que
-- 022 usa; idempotente). Sem isso, jogos de KO já finalizados ficariam com os
-- pontos antigos.
select public.recompute_prediction_points();

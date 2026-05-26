// Replica em JS as funcoes SQL stage_multiplier e score_prediction.
// Usado pra calcular pontuacao ESPERADA antes do E2E rodar, pra depois
// comparar contra o que o trigger SQL calculou.

export const STAGE_MULT = {
  group: 1.0,
  r32: 1.5,
  r16: 2.0,
  qf: 2.5,
  sf: 3.0,
  third: 2.0,
  final: 4.0,
};

export const CHAMPION_BONUS = 50;
export const SCORER_PER_GOAL_BASE = 2;

/**
 * Calcula pontos de um palpite vs resultado real.
 * Replica public.score_prediction() da migration 003_scoring.sql.
 *
 * Regras (base, antes do multiplier):
 *   placar exato                                      → 5
 *   vencedor correto + saldo correto                  → 3
 *   vencedor correto (sem saldo)                      → 2
 *   apenas gols de UM lado corretos (sem vencedor)    → 1
 *   nada                                              → 0
 *
 * Multiplica por STAGE_MULT[stage].
 */
export function scorePrediction(ph, pa, ppen, ah, aw, apen, stage) {
  if (ph == null || pa == null || ah == null || aw == null) return 0;
  const mult = STAGE_MULT[stage] ?? 1.0;

  // Determina vencedor predito
  let predWinner;
  if (ph > pa) predWinner = 'h';
  else if (pa > ph) predWinner = 'a';
  else if (stage !== 'group' && ppen) predWinner = ppen;
  else predWinner = 'd';

  // Determina vencedor real
  let actualWinner;
  if (ah > aw) actualWinner = 'h';
  else if (aw > ah) actualWinner = 'a';
  else if (stage !== 'group' && apen) actualWinner = apen;
  else actualWinner = 'd';

  let base = 0;
  if (ph === ah && pa === aw) {
    base = 5;
  } else if (predWinner === actualWinner && (ph - pa) === (ah - aw)) {
    base = 3;
  } else if (predWinner === actualWinner) {
    base = 2;
  } else if (ph === ah || pa === aw) {
    base = 1;
  }

  return Math.round(base * mult);
}

/**
 * Bonus do campeao: +50 se acertou, 0 c.c.
 */
export function championBonus(pickedTeam, actualChampion) {
  if (!pickedTeam || !actualChampion) return 0;
  return pickedTeam === actualChampion ? CHAMPION_BONUS : 0;
}

/**
 * Bonus do artilheiro: para cada gol do jogador escolhido,
 * +2 * stage_mult do jogo onde foi marcado.
 */
export function scorerBonus(pickedPlayerId, goalsByPlayer) {
  if (!pickedPlayerId) return 0;
  const goals = goalsByPlayer.filter((g) => g.player_id === pickedPlayerId);
  return goals.reduce((sum, g) => {
    const mult = STAGE_MULT[g.stage] ?? 1.0;
    return sum + Math.round(g.goals * SCORER_PER_GOAL_BASE * mult);
  }, 0);
}

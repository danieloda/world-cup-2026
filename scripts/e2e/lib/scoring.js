// Replica em JS as funcoes SQL de pontuacao. Usado pra calcular a pontuacao
// ESPERADA antes do E2E rodar e comparar contra o que o trigger SQL calculou.
// KEEP IN SYNC com 022_additive_scoring.sql e js/scoring.js.

// stage_multiplier (003) — usado SO pelo artilheiro (scorerBonus).
export const STAGE_MULT = {
  group: 1.0, r32: 1.5, r16: 2.0, qf: 3.0, sf: 4.0, third: 2.0, final: 5.0,
};

// Pontuacao ADITIVA por jogo (022): ag por lado + ave vencedor/empate + dg saldo.
export const MATCH_POINTS = {
  group: { ag: 1, ave: 4,  dg: 1 },
  r32:   { ag: 1, ave: 6,  dg: 1 },
  r16:   { ag: 3, ave: 12, dg: 1 },
  qf:    { ag: 5, ave: 20, dg: 2 },
  sf:    { ag: 8, ave: 32, dg: 2 },
  third: { ag: 4, ave: 16, dg: 1 },
  final: { ag: 12, ave: 48, dg: 4 },
};

export const CHAMPION_BONUS = 40;
export const SCORER_PER_GOAL_BASE = 2;

/**
 * Pontos de um palpite vs resultado real (ADITIVO). Replica score_prediction (022).
 *   +ag por LADO certo · +ave vencedor/empate · +dg saldo de gols.
 */
export function scorePrediction(ph, pa, ppen, ah, aw, apen, stage) {
  if (ph == null || pa == null || ah == null || aw == null) return 0;
  const v = MATCH_POINTS[stage] ?? MATCH_POINTS.group;
  let pts = 0;

  if (ph === ah) pts += v.ag;
  if (pa === aw) pts += v.ag;

  let predWinner;
  if (ph > pa) predWinner = 'h';
  else if (pa > ph) predWinner = 'a';
  else if (stage !== 'group' && ppen) predWinner = ppen;
  else predWinner = 'd';

  let actualWinner;
  if (ah > aw) actualWinner = 'h';
  else if (aw > ah) actualWinner = 'a';
  else if (stage !== 'group' && apen) actualWinner = apen;
  else actualWinner = 'd';

  if (predWinner === actualWinner) pts += v.ave;
  if ((ph - pa) === (ah - aw)) pts += v.dg;

  return pts;
}

/**
 * Bonus do campeao: +40 se acertou, 0 c.c.
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

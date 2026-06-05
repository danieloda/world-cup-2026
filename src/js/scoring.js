/**
 * Scoring logic ported from SQL to JavaScript.
 * Used for frontend calculations and unit testing.
 * KEEP IN SYNC with the database functions!
 *   - per-match additive scoring → 022_additive_scoring.sql (score_prediction)
 *   - champion bonus             → 022 (champion_bonus_for)
 *   - qualified-team bonus       → 022 (qualifier_bonus_pts)
 *   - top-scorer bonus           → 003 (scorer_bonus_for) — uses stageMultiplier
 */

/**
 * Stage multiplier — used ONLY for the top-scorer (artilheiro) bonus.
 * (Per-match scoring is additive and does NOT use this; see matchPoints.)
 * @param {string} stage
 * @returns {number}
 */
export function stageMultiplier(stage) {
  const multipliers = {
    group: 1.0, r32: 1.5, r16: 2.0, qf: 3.0, sf: 4.0, third: 2.0, final: 5.0,
  };
  return multipliers[stage] ?? 1.0;
}

/**
 * Per-match additive point values by stage (the screenshot rule, with the
 * phase weights tuned steeper so the emotion stays for the end):
 *   ag  = points per side whose goal count you got right (awarded per side)
 *   ave = points for the correct winner / draw
 *   dg  = points for the correct goal difference (includes 0-diff draws)
 * Placar exato = 2*ag + ave + dg.
 * KEEP IN SYNC with score_prediction in 022_additive_scoring.sql.
 */
const MATCH_POINTS = {
  group: { ag: 1, ave: 4,  dg: 1 },
  r32:   { ag: 1, ave: 6,  dg: 1 },
  r16:   { ag: 3, ave: 12, dg: 1 },
  qf:    { ag: 5, ave: 20, dg: 2 },
  sf:    { ag: 8, ave: 32, dg: 2 },
  third: { ag: 4, ave: 16, dg: 1 },
  final: { ag: 12, ave: 48, dg: 4 },
};

/**
 * Additive point values for a stage. Returns { ag, ave, dg, exact }.
 * @param {string} stage
 */
export function matchPoints(stage) {
  const v = MATCH_POINTS[stage] ?? MATCH_POINTS.group;
  return { ...v, exact: 2 * v.ag + v.ave + v.dg };
}

/**
 * Calculate points for a single prediction (ADDITIVE model).
 *
 * Each correct component SUMS:
 *   - +ag  for each side whose goal count is exactly right (0, 1 or 2 sides)
 *   - +ave if the winner/draw is right (knockout draw decided by pen winner)
 *   - +dg  if the goal difference is right (includes 0-diff draws)
 * So a perfect score = 2*ag + ave + dg.
 *
 * @param {number|null} predHome
 * @param {number|null} predAway
 * @param {string|null} predPen - 'h'/'a' (or 'home'/'away') for knockout draws
 * @param {number|null} actualHome
 * @param {number|null} actualAway
 * @param {string|null} actualPen
 * @param {string} stage
 * @returns {number} Points earned
 */
export function scorePrediction(predHome, predAway, predPen, actualHome, actualAway, actualPen, stage) {
  if (predHome == null || predAway == null || actualHome == null || actualAway == null) {
    return 0;
  }
  const { ag, ave, dg } = matchPoints(stage);
  let pts = 0;

  // AG — per side
  if (predHome === actualHome) pts += ag;
  if (predAway === actualAway) pts += ag;

  // AVE — winner / draw
  const predWinner = determineWinner(predHome, predAway, predPen, stage);
  const actualWinner = determineWinner(actualHome, actualAway, actualPen, stage);
  if (predWinner === actualWinner) pts += ave;

  // DG — goal difference
  if ((predHome - predAway) === (actualHome - actualAway)) pts += dg;

  return pts;
}

/**
 * Decompõe a pontuação aditiva de um palpite nas partes que acertaram.
 * Útil pra explicar de onde vieram os pontos (lado / resultado / saldo).
 * @returns {{ parts: {key:string,label:string,pts:number}[], pts:number }}
 */
export function scoreBreakdown(predHome, predAway, predPen, actualHome, actualAway, actualPen, stage) {
  if (predHome == null || predAway == null || actualHome == null || actualAway == null) {
    return { parts: [], pts: 0 };
  }
  const { ag, ave, dg } = matchPoints(stage);
  const parts = [];
  if (predHome === actualHome) parts.push({ key: 'side', label: 'Gols mandante', pts: ag });
  if (predAway === actualAway) parts.push({ key: 'side', label: 'Gols visitante', pts: ag });
  if (determineWinner(predHome, predAway, predPen, stage) === determineWinner(actualHome, actualAway, actualPen, stage)) {
    parts.push({ key: 'winner', label: 'Resultado', pts: ave });
  }
  if ((predHome - predAway) === (actualHome - actualAway)) {
    parts.push({ key: 'diff', label: 'Saldo', pts: dg });
  }
  return { parts, pts: parts.reduce((s, p) => s + p.pts, 0) };
}

/**
 * Determine winner from score.
 * @returns {string} 'h', 'a', 'd', or the pen value for knockout draws
 */
function determineWinner(home, away, pen, stage) {
  if (home > away) return 'h';
  if (away > home) return 'a';
  if (stage !== 'group' && pen) return pen; // draw decided by penalties
  return 'd';
}

/**
 * Champion bonus points.
 * @param {boolean} correct
 * @returns {number}
 */
export function championBonus(correct) {
  return correct ? 40 : 0; // big end-game swing (decided only at the final)
}

/**
 * Top scorer bonus points per goal (unchanged: 2 × goals × stage multiplier).
 * @param {number} goals
 * @param {string} stage
 * @returns {number}
 */
export function scorerBonus(goals, stage) {
  return Math.round(goals * 2 * stageMultiplier(stage));
}

/**
 * Qualified-team bonus (BPE/BP) for a single knockout slot.
 *   - exact === true  → BPE: predicted team is in that exact slot.
 *   - exact === false → BP : predicted team reached that phase, wrong slot (≈ half BPE).
 * KEEP IN SYNC with public.qualifier_bonus_pts in 022_additive_scoring.sql.
 * BP in r32 is 0 (with 32 slots, "team is somewhere in the round" is nearly free).
 *
 * @param {string} stage - 'r32' | 'r16' | 'qf' | 'sf' | 'third' | 'final'
 * @param {boolean} exact
 * @returns {number}
 */
export function qualifierBonus(stage, exact) {
  const bpe = { r32: 1, r16: 2, qf: 3, sf: 5, third: 3, final: 8 };
  const base = bpe[stage] ?? 0;
  if (exact) return base;
  if (stage === 'r32') return 0; // no BP in round of 32
  return Math.round(base / 2);
}

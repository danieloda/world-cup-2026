/**
 * Scoring logic ported from SQL (003_scoring.sql) to JavaScript.
 * Used for frontend calculations and unit testing.
 * KEEP IN SYNC with the database functions!
 */

/**
 * Stage multiplier for knockout rounds.
 * @param {string} stage - 'group', 'r32', 'r16', 'qf', 'sf', 'third', 'final'
 * @returns {number}
 */
export function stageMultiplier(stage) {
  const multipliers = {
    group: 1.0,
    r32: 1.5,
    r16: 2.0,
    qf: 3.0,    // increased from 2.5 for comeback potential
    sf: 4.0,    // increased from 3.0 for comeback potential
    third: 2.0,
    final: 5.0, // increased from 4.0 for comeback potential
  };
  return multipliers[stage] ?? 1.0;
}

/**
 * Calculate points for a single prediction.
 *
 * Rules:
 *   - Exact score:                           5 pts × mult
 *   - Correct winner + correct goal diff:    3 pts × mult
 *   - Correct winner only:                   2 pts × mult
 *   - One side's goals correct (no winner):  1 pt  × mult
 *   - Nothing:                               0
 *
 * For knockout matches, if regulation ends in draw, winner = pen_winner.
 *
 * @param {number|null} predHome - Predicted home goals
 * @param {number|null} predAway - Predicted away goals
 * @param {string|null} predPen - Predicted penalty winner ('h' or 'a')
 * @param {number|null} actualHome - Actual home goals
 * @param {number|null} actualAway - Actual away goals
 * @param {string|null} actualPen - Actual penalty winner ('h' or 'a')
 * @param {string} stage - Match stage
 * @returns {number} Points earned
 */
export function scorePrediction(predHome, predAway, predPen, actualHome, actualAway, actualPen, stage) {
  // Null check
  if (predHome == null || predAway == null || actualHome == null || actualAway == null) {
    return 0;
  }

  const mult = stageMultiplier(stage);

  // Determine winners
  const predWinner = determineWinner(predHome, predAway, predPen, stage);
  const actualWinner = determineWinner(actualHome, actualAway, actualPen, stage);

  let base = 0;

  // Exact score
  if (predHome === actualHome && predAway === actualAway) {
    base = 5;
  }
  // Correct winner + correct goal difference
  else if (predWinner === actualWinner && (predHome - predAway) === (actualHome - actualAway)) {
    base = 3;
  }
  // Correct winner only
  else if (predWinner === actualWinner) {
    base = 2;
  }
  // One side's goals correct (but wrong winner)
  else if (predHome === actualHome || predAway === actualAway) {
    base = 1;
  }

  return Math.round(base * mult);
}

/**
 * Determine winner from score.
 * @param {number} home - Home goals
 * @param {number} away - Away goals
 * @param {string|null} pen - Penalty winner ('h' or 'a') for knockout draws
 * @param {string} stage - Match stage
 * @returns {string} 'h', 'a', or 'd'
 */
function determineWinner(home, away, pen, stage) {
  if (home > away) return 'h';
  if (away > home) return 'a';
  // Draw in regulation
  if (stage !== 'group' && pen) return pen;
  return 'd';
}

/**
 * Champion bonus points.
 * @param {boolean} correct - Whether the pick was correct
 * @returns {number}
 */
export function championBonus(correct) {
  return correct ? 50 : 0; // increased from 30 for 48-team format
}

/**
 * Top scorer bonus points per goal.
 * @param {number} goals - Number of goals by the picked player
 * @param {string} stage - Stage where goals were scored
 * @returns {number}
 */
export function scorerBonus(goals, stage) {
  return Math.round(goals * 2 * stageMultiplier(stage));
}

/**
 * Qualified-team bonus (BPE/BP) for a single knockout slot.
 * Awarded per KO slot when the user correctly predicts WHICH team reaches it.
 *   - exact === true  → BPE: predicted team is in that exact slot.
 *   - exact === false → BP : predicted team reached that phase, wrong slot (= half BPE).
 *
 * KEEP IN SYNC with public.qualifier_bonus_pts in 021_qualifier_bonus.sql.
 * BP in r32 is 0 (almost every team is "in the r32", so it's a luck floor, not skill).
 * "Escala Equilibrada" — calibrated so the bonus is ~14% of total (rewards bold
 * bracket calls without overturning the score-driven leaderboard).
 *
 * @param {string} stage - 'r32' | 'r16' | 'qf' | 'sf' | 'third' | 'final'
 * @param {boolean} exact - true for BPE (exact slot), false for BP (right team, wrong slot)
 * @returns {number} Bonus points for this slot
 */
export function qualifierBonus(stage, exact) {
  const bpe = {
    r32: 1,
    r16: 2,
    qf: 3,
    sf: 4,
    third: 3,
    final: 6,
  };
  const base = bpe[stage] ?? 0;
  if (exact) return base;
  if (stage === 'r32') return 0; // no BP in round of 32
  return Math.round(base / 2);
}

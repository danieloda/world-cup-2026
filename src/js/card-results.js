// ============================================================
// Comparação palpite × resultado — classificação dos cards encerrados.
// Módulo PURO (sem DOM/Supabase): SSOT da cor/classe do card
// (dourado=exato · verde=pontuou · vermelho=zerou · "sem palpite") e dos
// bônus POR JOGO exibidos (classificado/artilheiro/campeão).
//
// Consumido por pages/palpites-grupos.js, pages/palpites-mata.js e pelo
// replay do ranking (progression.js) — antes a mesma regra vivia copiada
// inline em cada página. Ver tests/unit/card-results.test.js.
//
// ⚠️ O total do card NÃO é predictions.points_earned: é placar + classificado
// + artilheiro + campeão — mesma fórmula do matchDelta() do replay. Se a regra
// mudar, os dois lados mudam juntos AQUI. Ver docs/features/palpites-cards.md.
// ============================================================
import { isRealTeam } from './bracket.js';
import { scorerBonus, championBonus } from './scoring.js';

/**
 * Campeão real a partir do jogo da final (null enquanto não termina).
 * Empate no tempo normal decide por pen_winner ('home'/'away').
 */
export function championOf(finalMatch) {
  if (!finalMatch || !finalMatch.finished) return null;
  const { actual_home: h, actual_away: a, pen_winner: pen } = finalMatch;
  if (h == null || a == null) return null;
  if (h > a) return finalMatch.team_home;
  if (a > h) return finalMatch.team_away;
  if (pen === 'home') return finalMatch.team_home;
  if (pen === 'away') return finalMatch.team_away;
  return null;
}

/** Acertou o placar exato deste jogo? (só o placar — conta no KPI "placares exatos".) */
export function isExactPred(m, pred) {
  return !!pred && !!m.finished
    && pred.pred_home === m.actual_home && pred.pred_away === m.actual_away;
}

/**
 * Time que VOCÊ previu nesta vaga: o próprio (se a vaga já era time real) ou o
 * que a SUA simulação de bracket resolveu. null se a vaga não resolve.
 * @param {Map} predSlotResolution - computeSlotResolution(..., mode 'pred-only')
 */
export function predTeamForSide(m, side, predSlotResolution) {
  const realTeam = side === 'home' ? m.team_home : m.team_away;
  const slot = (side === 'home' ? m.slot_home : m.slot_away) || realTeam;
  return isRealTeam(slot) ? slot : (predSlotResolution.get(slot)?.team ?? null);
}

/**
 * PERFEITO (dourado) no mata-mata: placar exato E os DOIS times certos na vaga
 * — no KO você também palpita QUEM chega. Placar certo com 1 time errado NÃO é
 * perfeito.
 */
export function isPerfectKo(m, pred, predSlotResolution) {
  return isExactPred(m, pred)
    && predTeamForSide(m, 'home', predSlotResolution) === m.team_home
    && predTeamForSide(m, 'away', predSlotResolution) === m.team_away;
}

/** Bônus de artilheiro NESTE jogo: gols do escolhido × multiplicador da fase. */
export function matchScorerPts(m, scorerPickId, goalsByMatch) {
  if (!scorerPickId) return 0;
  const goal = (goalsByMatch.get(m.id) ?? []).find(g => g.player_id === scorerPickId);
  const n = goal?.goals ?? 0;
  return n > 0 ? scorerBonus(n, m.stage) : 0;
}

/**
 * Soma o bônus de classificado (BPE/BP) dos dois lados do confronto.
 * @param {Map} qualifierBySide - `${match_id}:${side}` -> item do breakdown SQL
 */
export function matchQualPts(m, qualifierBySide) {
  let sum = 0;
  for (const side of ['home', 'away']) {
    const q = qualifierBySide.get(`${m.id}:${side}`);
    if (q) sum += q.pts || 0;
  }
  return sum;
}

/** Bônus de campeão: cai SÓ no jogo da final, quando você acertou o campeão. */
export function matchChampionPts(m, championPickTeam, realChampion) {
  if (m.stage !== 'final' || !championPickTeam || !realChampion) return 0;
  return championPickTeam === realChampion ? championBonus(true) : 0;
}

/**
 * Card de GRUPO encerrado: pontos do jogo e classe visual.
 *   exato → 'exact' (dourado) · pontuou algo → 'partial' (verde)
 *   palpitou e zerou → 'miss' (vermelho) · nada em jogo → 'no-pred'
 * Bônus de artilheiro conta como acerto parcial mesmo sem palpite de placar.
 */
export function groupCardSummary(m, pred, scorerPts) {
  const placarPts = pred?.points_earned ?? 0;
  const pts = placarPts + scorerPts;
  const isExact = !!pred && pred.pred_home === m.actual_home && pred.pred_away === m.actual_away;
  const resultClass = !pred && scorerPts === 0 ? 'no-pred'
    : isExact ? 'exact'
    : (placarPts > 0 || scorerPts > 0) ? 'partial' : 'miss';
  return { placarPts, pts, isExact, resultClass };
}

/**
 * Card de MATA-MATA encerrado: total exibido (placar + bônus) e classe visual.
 * 'exact' (dourado) exige `perfect` (= isPerfectKo); classificado/artilheiro/
 * campeão contam como acerto parcial mesmo sem palpite de placar.
 */
export function koCardSummary(m, pred, { qualPts = 0, scorerPts = 0, champPts = 0, perfect = false } = {}) {
  const placarPts = pred?.points_earned ?? 0;
  const totalPts = placarPts + qualPts + scorerPts + champPts;
  const hasBonus = qualPts > 0 || scorerPts > 0 || champPts > 0;
  const hasAny = !!pred || hasBonus;
  const resultClass = !pred
    ? (hasBonus ? 'partial' : 'no-pred')
    : perfect ? 'exact'
    : (placarPts > 0 || hasBonus) ? 'partial' : 'miss';
  return { placarPts, totalPts, hasBonus, hasAny, resultClass };
}

// ============================================================
// Recompute independente da pontuação — SSOT compartilhado entre o audit LOCAL
// (scripts/dev/verify-data.mjs, com oráculo sintético) e o MONITOR de PRODUÇÃO
// (scripts/e2e/prod-verify.js, read-only). Ambos recalculam os pontos a partir
// dos palpites + resultados usando o MESMO módulo-fonte (src/js/scoring.js) e
// comparam com o que o banco gravou (= o que a UI mostra).
//
// Por que uma lib só: ter duas cópias do loop de recompute é exatamente o tipo
// de drift que este projeto combate (paridade explícita). A regra de pontos vive
// em scoring.js (1 lugar); aqui mora só a TRAVESSIA (somar por usuário/jogo).
// ============================================================
import { scorePrediction, scorerBonus } from '../../../src/js/scoring.js';

/**
 * Campeão real a partir do jogo da final (null enquanto não termina).
 * Empate no tempo normal decide por pen_winner. Espelha championOf de
 * src/js/card-results.js — em prod NÃO há oráculo, a final É a fonte.
 */
export function championFromFinal(matches) {
  const f = matches.find((m) => m.stage === 'final');
  if (!f || !f.finished || f.actual_home == null || f.actual_away == null) return null;
  if (f.actual_home > f.actual_away) return f.team_home;
  if (f.actual_away > f.actual_home) return f.team_away;
  if (f.pen_winner === 'home') return f.team_home;
  if (f.pen_winner === 'away') return f.team_away;
  return null;
}

/**
 * points_earned de cada palpite == scorePrediction() independente.
 * Valida o trigger SQL de scoring para TODOS os usuários, e que jogo não
 * finalizado NÃO tem pontos (anti-vazamento).
 * @returns {{ checked, wrong: Array, leaked: Array, sample: string[] }}
 */
export function auditPredictionPoints(preds, matchById) {
  let checked = 0;
  const wrong = [], leaked = [], sample = [];
  for (const p of preds) {
    const m = matchById.get(p.match_id);
    if (!m) continue;
    if (!m.finished) {
      if (p.points_earned != null) {
        leaked.push({ user_id: p.user_id, match_id: p.match_id, points_earned: p.points_earned });
      }
      continue;
    }
    checked++;
    const expected = scorePrediction(
      p.pred_home, p.pred_away, p.pred_pen_winner,
      m.actual_home, m.actual_away, m.pen_winner, m.stage,
    );
    const got = p.points_earned ?? 0;
    if (expected !== got) {
      wrong.push({ user_id: p.user_id, match_id: p.match_id, stage: m.stage, expected, got,
        pred: `${p.pred_home}-${p.pred_away}/${p.pred_pen_winner ?? ''}`,
        actual: `${m.actual_home}-${m.actual_away}/${m.pen_winner ?? ''}` });
    } else if (sample.length < 3 && expected > 0) {
      sample.push(`M${p.match_id} ${m.stage}: ${p.pred_home}-${p.pred_away} vs ${m.actual_home}-${m.actual_away} = ${expected}pts`);
    }
  }
  return { checked, wrong, leaked, sample };
}

/**
 * v_leaderboard por usuário == recompute independente das 4 parcelas
 * (placar + artilheiro + campeão + classificado-cache) e do total.
 * @returns {{ checked, diffs: Array, cols }}
 */
export function auditLeaderboard({ leaderboard, matches, matchById, predsByUser, goalsByMatch, scorerByUser, champByUser, qualByUser, realChampion, finalFinished }) {
  let checked = 0;
  const diffs = [];
  const cols = { match: 0, scorer: 0, champ: 0, qual: 0, total: 0 };
  for (const row of leaderboard) {
    checked++;
    const uid = row.user_id;

    let matchPts = 0;
    for (const p of (predsByUser.get(uid) ?? [])) {
      const m = matchById.get(p.match_id);
      if (m?.finished) {
        matchPts += scorePrediction(p.pred_home, p.pred_away, p.pred_pen_winner, m.actual_home, m.actual_away, m.pen_winner, m.stage);
      }
    }
    let scorerPts = 0;
    const pickPid = scorerByUser.get(uid);
    if (pickPid) {
      for (const m of matches) {
        if (!m.finished) continue;
        const g = (goalsByMatch.get(m.id) ?? []).find((x) => x.player_id === pickPid);
        if (g?.goals) scorerPts += scorerBonus(g.goals, m.stage);
      }
    }
    const myChampTeam = champByUser.get(uid) ?? null;
    const champPts = (finalFinished && myChampTeam && myChampTeam === realChampion) ? 40 : 0;
    const qualCache = qualByUser.get(uid) ?? 0;
    const expectedTotal = matchPts + scorerPts + champPts + qualCache;

    const parts = [];
    if (row.match_pts !== matchPts) { parts.push(`match ${row.match_pts}≠${matchPts}`); cols.match++; }
    if (row.scorer_pts !== scorerPts) { parts.push(`scorer ${row.scorer_pts}≠${scorerPts}`); cols.scorer++; }
    if (row.champion_pts !== champPts) { parts.push(`champ ${row.champion_pts}≠${champPts}`); cols.champ++; }
    if (row.qualifier_pts !== qualCache) { parts.push(`qual(view≠cache) ${row.qualifier_pts}≠${qualCache}`); cols.qual++; }
    if (row.total_pts !== expectedTotal) { parts.push(`TOTAL ${row.total_pts}≠${expectedTotal}`); cols.total++; }
    if (parts.length) diffs.push({ name: row.full_name || uid, parts });
  }
  return { checked, diffs, cols };
}

/**
 * Sanidades estruturais do ranking (independem do recompute por usuário):
 * só pagantes, ordenado desc, campeão zerado até a final, teto de placar.
 * @returns {{ name, pass, detail }[]}
 */
export function auditSanity({ leaderboard, profiles, matches, finalFinished }) {
  const out = [];
  const paidIds = new Set(profiles.filter((p) => p.paid).map((p) => p.id));
  const nonPaid = leaderboard.filter((r) => !paidIds.has(r.user_id)).length;
  out.push({ name: 'v_leaderboard só tem pagantes', pass: nonPaid === 0, detail: nonPaid ? `${nonPaid} não-pagantes` : '' });

  let sorted = true;
  for (let i = 1; i < leaderboard.length; i++) {
    if (leaderboard[i - 1].total_pts < leaderboard[i].total_pts) { sorted = false; break; }
  }
  out.push({ name: 'ranking ordenado por total_pts desc', pass: sorted, detail: sorted ? '' : 'fora de ordem' });

  const champNonzero = leaderboard.filter((r) => r.champion_pts !== 0).length;
  out.push({
    name: `champion_pts=0 p/ todos (final ${finalFinished ? 'jogada' : 'não jogada'})`,
    pass: finalFinished ? true : champNonzero === 0,
    detail: champNonzero && !finalFinished ? `${champNonzero} com champ≠0 sem final` : '',
  });

  let teto = 0;
  for (const m of matches.filter((x) => x.finished)) {
    teto += scorePrediction(m.actual_home, m.actual_away, m.pen_winner, m.actual_home, m.actual_away, m.pen_winner, m.stage);
  }
  const maxMatch = leaderboard.length ? Math.max(...leaderboard.map((r) => r.match_pts)) : 0;
  out.push({ name: `líder de placar ${maxMatch} ≤ teto ${teto}`, pass: maxMatch <= teto, detail: maxMatch > teto ? 'impossível!' : '' });
  return out;
}

// ============================================================
// Núcleo PURO do replay do ranking (extraído de progression.js).
// Sem DOM/Supabase: recebe os índices prontos e devolve as séries.
//
// INVARIANTE (testada em tests/unit/progression.test.js): a última coordenada
// de cada série == total_pts do v_leaderboard — tudo que o usuário pontuou é
// atribuído a ALGUM jogo disputado (bônus de vaga ainda não jogada entra como
// "spillover" no último jogo).
// ============================================================
import { championBonus, scorerBonus } from './scoring.js';

/**
 * Indexa o breakdown do bônus de classificado (user_qualifier_points.breakdown):
 *  - item cujo jogo da vaga JÁ FOI disputado → atribuído àquele jogo;
 *  - senão (match_id null ou jogo não disputado) → spillover do usuário.
 * @param {Array} qualRows - [{ user_id, breakdown: { items: [{match_id, pts}] } }]
 * @param {Set} finishedIds - ids dos jogos finalizados
 * @returns {{ qualByUserMatch: Map, qualSpill: Map }}
 */
export function indexQualifierBreakdown(qualRows, finishedIds) {
  const qualByUserMatch = new Map();   // `${user}|${match}` -> pts somados
  const qualSpill = new Map();         // user -> pts sem jogo disputado
  for (const row of (qualRows ?? [])) {
    for (const it of (row.breakdown?.items ?? [])) {
      const pts = it.pts ?? 0;
      if (pts === 0) continue;
      if (it.match_id != null && finishedIds.has(it.match_id)) {
        const k = `${row.user_id}|${it.match_id}`;
        qualByUserMatch.set(k, (qualByUserMatch.get(k) ?? 0) + pts);
      } else {
        qualSpill.set(row.user_id, (qualSpill.get(row.user_id) ?? 0) + pts);
      }
    }
  }
  return { qualByUserMatch, qualSpill };
}

/**
 * Tudo que é atribuível a UM jogo para UM usuário: pontos do palpite +
 * artilheiro (gols do escolhido neste jogo) + classificado (itens da vaga
 * deste jogo) + campeão (só no jogo da final).
 */
export function matchDelta(userId, m, {
  predPts, scorerPick, goalsByMatchPlayer, qualByUserMatch,
  champPick, realChampion, finalMatchId,
}) {
  let d = predPts.get(`${userId}|${m.id}`) ?? 0;
  const pid = scorerPick.get(userId);
  if (pid != null) {
    const goals = goalsByMatchPlayer.get(`${m.id}|${pid}`) ?? 0;
    if (goals > 0) d += scorerBonus(goals, m.stage);
  }
  d += qualByUserMatch.get(`${userId}|${m.id}`) ?? 0;
  if (m.id === finalMatchId && realChampion && champPick.get(userId) === realChampion) {
    d += championBonus(true);
  }
  return d;
}

// ============================================================
// Demo pros previews (pré-Copa): 6 jogadores × 12 jogos em 2
// semanas — datas reais de junho/2026 pro seletor de tempo
// funcionar igual ao gráfico de verdade.
// ============================================================
export function demoProgression() {
  const T = [
    ['Brazil', 'Argentina'], ['France', 'England'], ['Spain', 'Germany'],
    ['Portugal', 'Netherlands'], ['Mexico', 'USA'], ['Japan', 'Morocco'],
    ['Croatia', 'Uruguay'], ['Colombia', 'Belgium'], ['Brazil', 'France'],
    ['Argentina', 'Spain'], ['England', 'Portugal'], ['Germany', 'Mexico'],
  ];
  const DATES = ['2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14', '2026-06-15', '2026-06-16',
                 '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21', '2026-06-22', '2026-06-23'];
  const matches = T.map(([h, a], i) => ({
    id: `demo-${i}`, match_date: `${DATES[i]}T16:00:00+00:00`, stage: 'group',
    group_name: 'ABCDEF'[i % 6], team_home: h, team_away: a,
    actual_home: (i * 7 + 3) % 4, actual_away: (i * 5 + 1) % 3,
  }));
  const demo = [
    ['demo-me', 'Você',  [0, 7, 14, 21, 33, 40, 52, 62, 80, 92, 104, 122, 134]],
    ['demo-1',  'Diego', [0, 9, 12, 25, 28, 41, 47, 65, 73, 88, 101, 110, 125]],
    ['demo-2',  'Elis',  [0, 5, 16, 19, 31, 38, 50, 55, 70, 95, 99, 114, 130]],
    ['demo-3',  'Bia',   [0, 7, 11, 22, 30, 35, 44, 61, 78, 84, 97, 109, 118]],
    ['demo-4',  'Caio',  [0, 3, 13, 18, 26, 37, 48, 58, 66, 79, 93, 105, 112]],
    ['demo-5',  'Nina',  [0, 0, 10, 15, 27, 32, 39, 51, 64, 75, 86, 98, 107]],
  ];
  const series = demo.map(([userId, name, values]) => ({ userId, name, avatar_url: null, values }));
  return { series, matches };
}

/**
 * Monta as séries do replay: para cada usuário do ranking (já ordenado),
 * values[0] = 0 e values[i+1] = acumulado após o jogo i (ordem de `matches`).
 * O spillover entra no último jogo — fim de série == total do leaderboard.
 */
export function buildSeries({
  leaderboard, matches, avatarMap = new Map(),
  predPts, scorerPick, goalsByMatchPlayer, qualByUserMatch, qualSpill,
  champPick, realChampion, finalMatchId,
}) {
  const deps = { predPts, scorerPick, goalsByMatchPlayer, qualByUserMatch, champPick, realChampion, finalMatchId };
  const lastIdx = matches.length - 1;
  return leaderboard.map(u => {
    const spill = qualSpill.get(u.user_id) ?? 0;
    const values = [0];
    let acc = 0;
    matches.forEach((m, i) => {
      acc += matchDelta(u.user_id, m, deps);
      if (i === lastIdx) acc += spill;
      values.push(acc);
    });
    return { userId: u.user_id, name: u.full_name, avatar_url: avatarMap.get(u.user_id), values };
  });
}

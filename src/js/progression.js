// ============================================================
// Progressão de pontos por jogo — SSOT do replay do ranking
// ============================================================
// NÃO guardamos snapshots: a posição em qualquer momento é reconstruída
// somando, em ordem de DATA do jogo, tudo que é atribuível a um jogo:
//   • pontos do palpite (predictions.points_earned)
//   • artilheiro (gols do escolhido naquele jogo × multiplicador da fase)
//   • classificado (itens do breakdown, cada um com seu match_id)
//   • campeão (no jogo da final)
// A última coordenada de cada série == total_pts do v_leaderboard.
//
// Usado pelos dois gráficos (rank-chart no Ranking, journey-chart no Início).
// Self-contained: faz as próprias queries — as páginas chamam após o primeiro
// paint pra não atrasar o conteúdo principal.

import { supabase, fetchAllPages } from './supabase.js';
import { championBonus, scorerBonus } from './scoring.js';
import { sortLeaderboard } from './prize.js';

/**
 * Carrega tudo e devolve `{ series, matches }` — ou null se ainda não há
 * jogos finalizados ou jogadores no ranking.
 *  - series: [{ userId, name, avatar_url, values }] na ordem do ranking final,
 *    onde values[0] = 0 e values[i+1] = pontos acumulados após o jogo i.
 *  - matches: jogos finalizados, asc por data (com placar/fase/grupo).
 */
export async function loadProgression() {
  // Palpites pontuados de TODO o bolão: cresce com (usuários × jogos), então
  // PAGINA — sem isso o PostgREST corta em 1000 linhas e o gráfico subconta
  // os pontos (o fim das séries deixa de bater com o v_leaderboard).
  const predPtsPromise = fetchAllPages(() =>
    supabase.from('predictions').select('user_id, match_id, points_earned')
      .not('points_earned', 'is', null).order('id'));

  const [leaderRes, profilesRes, finMatchesRes, predPtsRows, goalsRes, qualRes,
         champRes, sPickRes, finalRes] = await Promise.all([
    supabase.from('v_leaderboard').select('*'),
    supabase.from('profiles').select('id, avatar_url'),
    supabase.from('matches')
      .select('id, match_date, stage, group_name, team_home, team_away, actual_home, actual_away')
      .eq('finished', true).order('match_date', { ascending: true }),
    predPtsPromise,
    supabase.from('player_goals').select('player_id, match_id, goals'),
    supabase.from('user_qualifier_points').select('user_id, breakdown'),
    supabase.from('champion_picks').select('user_id, team'),
    supabase.from('top_scorer_picks').select('user_id, player_id'),
    supabase.from('matches')
      .select('id, team_home, team_away, actual_home, actual_away, pen_winner, finished')
      .eq('stage', 'final').maybeSingle(),
  ]);

  const matches = finMatchesRes.data ?? [];
  const leaderboard = sortLeaderboard(leaderRes.data ?? []);
  if (matches.length === 0 || leaderboard.length === 0) return null;

  const avatarMap = new Map((profilesRes.data ?? []).map(p => [p.id, p.avatar_url]));

  // ----- índices do replay -----
  const finalMatchId = matches.find(m => m.stage === 'final')?.id ?? null;
  const finishedIds = new Set(matches.map(m => m.id));

  const predPts = new Map();   // `${user}|${match}` -> points_earned
  for (const p of (predPtsRows ?? [])) {
    predPts.set(`${p.user_id}|${p.match_id}`, p.points_earned ?? 0);
  }
  const goalsByMatchPlayer = new Map();   // `${match}|${player}` -> goals
  for (const g of (goalsRes.data ?? [])) {
    goalsByMatchPlayer.set(`${g.match_id}|${g.player_id}`, g.goals ?? 0);
  }
  // Bônus de classificado: cada item referencia o JOGO do mata-mata da vaga.
  // Se esse jogo já foi disputado, atribui ao jogo; senão vai pro "spillover"
  // (entra no último jogo disputado, garantindo fim de série == total_pts).
  const qualByUserMatch = new Map();
  const qualSpill = new Map();
  for (const row of (qualRes.data ?? [])) {
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
  const champPick = new Map((champRes.data ?? []).map(p => [p.user_id, p.team]));
  const scorerPick = new Map((sPickRes.data ?? []).map(p => [p.user_id, p.player_id]));

  // Campeão real (null enquanto a final não termina)
  let realChampion = null;
  const fm = finalRes.data;
  if (fm?.finished) {
    if (fm.actual_home > fm.actual_away) realChampion = fm.team_home;
    else if (fm.actual_away > fm.actual_home) realChampion = fm.team_away;
    else if (fm.pen_winner === 'home') realChampion = fm.team_home;
    else if (fm.pen_winner === 'away') realChampion = fm.team_away;
  }

  function matchDelta(userId, m) {
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

  const lastIdx = matches.length - 1;
  const series = leaderboard.map(u => {
    const spill = qualSpill.get(u.user_id) ?? 0;
    const values = [0];
    let acc = 0;
    matches.forEach((m, i) => {
      acc += matchDelta(u.user_id, m);
      if (i === lastIdx) acc += spill;
      values.push(acc);
    });
    return { userId: u.user_id, name: u.full_name, avatar_url: avatarMap.get(u.user_id), values };
  });

  return { series, matches };
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

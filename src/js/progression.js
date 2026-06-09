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
import { sortLeaderboard } from './prize.js';
import { indexQualifierBreakdown, buildSeries } from './progression-core.js';
import { championOf } from './card-results.js';

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
  const { qualByUserMatch, qualSpill } = indexQualifierBreakdown(qualRes.data, finishedIds);
  const champPick = new Map((champRes.data ?? []).map(p => [p.user_id, p.team]));
  const scorerPick = new Map((sPickRes.data ?? []).map(p => [p.user_id, p.player_id]));

  // Campeão real (null enquanto a final não termina)
  const realChampion = championOf(finalRes.data);

  // O acúmulo em si é puro e testado (progression-core.js).
  const series = buildSeries({
    leaderboard, matches, avatarMap,
    predPts, scorerPick, goalsByMatchPlayer, qualByUserMatch, qualSpill,
    champPick, realChampion, finalMatchId,
  });

  return { series, matches };
}

// Demo dos previews (pré-Copa): vive no núcleo puro (testável); re-exporta
// daqui pra manter o import único de ranking.js/inicio.js.
export { demoProgression } from './progression-core.js';

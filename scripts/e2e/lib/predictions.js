// Geradores de palpites pra cada strategy definida em test-users.json.
// Dado (match, actualResult, strategy) → retorna {pred_home, pred_away, pred_pen_winner}.

import { mulberry32, hashSeed } from './prng.js';

/**
 * Gera 1 palpite seguindo a strategy.
 * @param {object} match — { id, stage }
 * @param {object} actual — { actual_home, actual_away, pen_winner }
 * @param {string} strategy — 'exact_all' | 'winner_only' | 'winner_sg' | 'one_side_only' | 'mixed_50' | 'random' | 'exact_groups_only'
 * @param {function} rng — PRNG
 */
export function genPrediction(match, actual, strategy, rng) {
  const { stage } = match;
  const ah = actual.actual_home;
  const aw = actual.actual_away;
  const apen = actual.pen_winner;

  const isKO = stage !== 'group';

  switch (strategy) {
    case 'exact_all': {
      return { pred_home: ah, pred_away: aw, pred_pen_winner: apen };
    }

    case 'exact_groups_only': {
      if (stage === 'group') {
        return { pred_home: ah, pred_away: aw, pred_pen_winner: null };
      }
      return null;  // Nao palpita KO
    }

    case 'winner_only': {
      // Acerta vencedor, mas placar diferente (sem saldo igual)
      if (ah > aw) {
        // Casa vence. Palpita placar diferente com casa vencendo.
        const ph = Math.max(1, ah + (rng() < 0.5 ? 1 : -1));
        const pa = Math.max(0, aw + (rng() < 0.5 ? 1 : 0));
        const finalPh = ph > pa ? ph : pa + 1;
        const finalPa = pa < finalPh ? pa : finalPh - 1;
        // Garante que saldo eh diferente
        if (finalPh - finalPa === ah - aw) {
          return { pred_home: finalPh + 1, pred_away: finalPa, pred_pen_winner: null };
        }
        return { pred_home: finalPh, pred_away: finalPa, pred_pen_winner: null };
      } else if (aw > ah) {
        // Fora vence
        const pa = Math.max(1, aw + (rng() < 0.5 ? 1 : -1));
        const ph = Math.max(0, ah + (rng() < 0.5 ? 1 : 0));
        const finalPa = pa > ph ? pa : ph + 1;
        const finalPh = ph < finalPa ? ph : finalPa - 1;
        if (finalPa - finalPh === aw - ah) {
          return { pred_home: finalPh, pred_away: finalPa + 1, pred_pen_winner: null };
        }
        return { pred_home: finalPh, pred_away: finalPa, pred_pen_winner: null };
      } else {
        // Empate na realidade. KO: palpita empate com mesmo pen_winner.
        if (isKO && apen) {
          return { pred_home: 1, pred_away: 1, pred_pen_winner: apen };  // placar diferente, mesmo pen
        }
        // Grupo: palpita 0-0 (mesmo placar = exato; vou diferenciar)
        return { pred_home: 1, pred_away: 1, pred_pen_winner: null };
      }
    }

    case 'winner_sg': {
      // Acerta vencedor + saldo, placar diferente
      const diff = ah - aw;
      // Adiciona 1 gol pra cada lado
      const ph = ah + 1;
      const pa = aw + 1;
      // Mantem o saldo
      if (ph - pa !== diff) {
        return { pred_home: ph, pred_away: ah + 1 - diff, pred_pen_winner: apen };
      }
      return { pred_home: ph, pred_away: pa, pred_pen_winner: apen };
    }

    case 'one_side_only': {
      // Erra vencedor mas acerta gols de um lado
      // Estrategia: troca o vencedor mas mantem gols de um dos lados
      if (ah > aw) {
        // Real: casa vence. Palpita: fora vence (mantém home goals)
        return { pred_home: ah, pred_away: ah + 1, pred_pen_winner: null };
      } else if (aw > ah) {
        // Real: fora vence. Palpita: casa vence (mantém away goals)
        return { pred_home: aw + 1, pred_away: aw, pred_pen_winner: null };
      } else {
        // Empate. Palpita casa vence.
        return { pred_home: ah + 1, pred_away: aw, pred_pen_winner: null };
      }
    }

    case 'mixed_50': {
      // 50% chance de palpitar. Quando palpita, gera placar semi-aleatorio.
      if (rng() < 0.5) return null;
      const ph = Math.floor(rng() * 4);
      const pa = Math.floor(rng() * 4);
      let pen = null;
      if (isKO && ph === pa) pen = rng() < 0.5 ? 'home' : 'away';
      return { pred_home: ph, pred_away: pa, pred_pen_winner: pen };
    }

    case 'random': {
      const ph = Math.floor(rng() * 4);
      const pa = Math.floor(rng() * 4);
      let pen = null;
      if (isKO && ph === pa) pen = rng() < 0.5 ? 'home' : 'away';
      return { pred_home: ph, pred_away: pa, pred_pen_winner: pen };
    }

    default:
      throw new Error(`Unknown strategy: ${strategy}`);
  }
}

/**
 * Resolve a estrategia de campeao: 'match_winner' | 'non_winner' | null
 */
export function genChampionPick(strategy, actualChampion, allTeams, rng) {
  if (strategy === null) return null;
  if (strategy === 'match_winner') return actualChampion;
  if (strategy === 'non_winner') {
    // Pega um time aleatório que NÃO seja o campeão
    const candidates = allTeams.filter((t) => t !== actualChampion);
    if (candidates.length === 0) return null;
    return candidates[Math.floor(rng() * candidates.length)];
  }
  throw new Error(`Unknown champion strategy: ${strategy}`);
}

/**
 * Resolve a estrategia de artilheiro.
 * @param {string} strategy 'actual_top' | 'no_goals' | null
 * @param {object} actualTopScorer { player_id, full_name, team, total_goals }
 * @param {Array} allPlayers [{ id, full_name, team, position }]
 */
export function genScorerPick(strategy, actualTopScorer, allPlayers, rng) {
  if (strategy === null) return null;
  if (strategy === 'actual_top') {
    return actualTopScorer ? actualTopScorer.player_id : null;
  }
  if (strategy === 'no_goals') {
    // Pega um goalkeeper aleatório (nao vai marcar)
    const goalkeepers = allPlayers.filter((p) => p.position === 'GOL');
    if (goalkeepers.length === 0) {
      // Sem GK, pega um defender
      const defs = allPlayers.filter((p) => p.position === 'DEF');
      if (defs.length === 0) return null;
      return defs[Math.floor(rng() * defs.length)].id;
    }
    return goalkeepers[Math.floor(rng() * goalkeepers.length)].id;
  }
  throw new Error(`Unknown scorer strategy: ${strategy}`);
}

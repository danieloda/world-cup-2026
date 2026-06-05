// Simula offline o torneio inteiro: gera resultados de todos os 104 jogos,
// resolve standings dos grupos, terceiros melhores, e cascata de W##/L##.
//
// Replica em JS:
//   - util.computeStandings (do app)
//   - resolve_match_slots SQL (Step 1 grupos, Step 2 thirds, Step 3 KO)
//
// Input: lista de matches do DB (com slot_home/slot_away preservados)
// Output: { matches: [com actual_home/away/pen_winner + scorers], topScorer }

import { mulberry32, hashSeed } from './prng.js';
import { fifaRank } from '../../../src/js/fifa-rank.js';

const REALISTIC_SCORES = [
  [0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2],
  [2, 1], [1, 2], [2, 2], [3, 0], [0, 3], [3, 1], [1, 3],
  [3, 2], [2, 3], [4, 0], [0, 4], [4, 1], [1, 4], [4, 2],
  [3, 3], [5, 0], [0, 5],
];

const POS_ORDER = { ATA: 0, MEI: 1, DEF: 2, GOL: 3 };

function pickScore(rng, stage) {
  const pool = stage === 'group' ? REALISTIC_SCORES : REALISTIC_SCORES.slice(0, 15);
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * Replica computeStandings da app pra grupos.
 */
function computeGroupStandings(groupMatches) {
  const stats = new Map();
  const ensure = (team) => {
    if (!stats.has(team)) stats.set(team, { team, pts: 0, gp: 0, gc: 0, sg: 0 });
    return stats.get(team);
  };
  for (const m of groupMatches) {
    const sh = ensure(m.team_home);
    const sa = ensure(m.team_away);
    sh.gp += m.actual_home; sh.gc += m.actual_away;
    sa.gp += m.actual_away; sa.gc += m.actual_home;
    if (m.actual_home > m.actual_away) sh.pts += 3;
    else if (m.actual_away > m.actual_home) sa.pts += 3;
    else { sh.pts += 1; sa.pts += 1; }
  }
  for (const s of stats.values()) s.sg = s.gp - s.gc;
  return [...stats.values()].sort((x, y) =>
    // Tiebreaker oficial: pts → SG → GF → FIFA rank (igual ao SQL resolve_match_slots / migration 015)
    y.pts - x.pts || y.sg - x.sg || y.gp - x.gp || fifaRank(x.team) - fifaRank(y.team)
  );
}

/**
 * Gera scorers pra um match. Distribui homeGoals entre home team players,
 * awayGoals entre away team players. Usa viés pra ATA.
 */
function generateScorers(rng, homeTeam, awayTeam, homeGoals, awayGoals, playersByTeam, goalCounts) {
  const scorers = [];
  const distribute = (team, goals) => {
    const teamPlayers = playersByTeam[team];
    if (!teamPlayers || teamPlayers.length === 0) return;
    let remaining = goals;
    const playerGoals = new Map();
    while (remaining > 0) {
      // Pega aleatorio do top-10 (ATA tem prioridade)
      const player = teamPlayers[Math.floor(rng() * Math.min(10, teamPlayers.length))];
      const g = Math.min(remaining, rng() < 0.7 ? 1 : 2);
      playerGoals.set(player.id, (playerGoals.get(player.id) || 0) + g);
      goalCounts[player.id] = (goalCounts[player.id] || 0) + g;
      remaining -= g;
    }
    for (const [pid, g] of playerGoals) {
      const p = teamPlayers.find((x) => x.id === pid);
      scorers.push({ player_id: pid, full_name: p.full_name, team: p.team, goals: g });
    }
  };
  distribute(homeTeam, homeGoals);
  distribute(awayTeam, awayGoals);
  return scorers;
}

/**
 * Resolve slot composto de 3os (3A/B/C/D/F, etc).
 * @param slotStr ex: "3A/B/C/D/F"
 * @param thirds ordered [{group, team, pts, sg, gp}]
 * @param used Set de team names ja usados
 */
function resolveThirdSlot(slotStr, thirds, used) {
  const groups = slotStr.slice(1).split('/');
  const candidate = thirds.find((t) => groups.includes(t.group) && !used.has(t.team));
  return candidate ? candidate.team : null;
}

/**
 * Recebe lista bruta de matches do DB e simula todo o torneio.
 * Retorna matches preenchidos + topScorer.
 */
export function simulateTournament(matches, players, seed = 'wc2026-e2e-v1') {
  const rng = mulberry32(hashSeed(seed));

  // Index players por team
  // ALIAS: alguns nomes diferem entre matches e players (e.g. matches="USA", players="United States")
  const TEAM_ALIAS = {
    USA: ['United States', 'USA'],
    'United States': ['USA', 'United States'],
    Türkiye: ['Türkiye', 'Turkey'],
    Turkey: ['Türkiye', 'Turkey'],
    Curaçao: ['Curaçao', 'Curacao'],
    Curacao: ['Curaçao', 'Curacao'],
    'Cape Verde': ['Cape Verde', 'Cape Verde Islands'],
    'Cape Verde Islands': ['Cape Verde', 'Cape Verde Islands'],
    'Congo DR': ['Congo DR', 'DR Congo'],
    'DR Congo': ['Congo DR', 'DR Congo'],
  };
  const playersByTeam = {};
  for (const p of players) {
    if (!playersByTeam[p.team]) playersByTeam[p.team] = [];
    playersByTeam[p.team].push(p);
  }
  // Adiciona aliases — mesmos players acessíveis pelos 2 nomes
  for (const [name, aliases] of Object.entries(TEAM_ALIAS)) {
    for (const alias of aliases) {
      if (playersByTeam[alias] && !playersByTeam[name]) {
        playersByTeam[name] = playersByTeam[alias];
      }
    }
  }
  for (const team in playersByTeam) {
    playersByTeam[team].sort((a, b) => (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9));
  }

  const goalCounts = {};  // player_id -> total goals
  const simulated = new Map();  // match_id -> { actual_home, actual_away, pen_winner, team_home, team_away, scorers }
  const slotMap = new Map();    // slot -> team name

  // === STEP 1: Simula grupos ===
  const groupMatches = matches.filter((m) => m.stage === 'group');
  const byGroup = {};
  for (const m of groupMatches) {
    if (!byGroup[m.group_name]) byGroup[m.group_name] = [];
    byGroup[m.group_name].push(m);
  }

  // Gera placares pra todos os grupos
  for (const m of groupMatches) {
    const [h, a] = pickScore(rng, 'group');
    const scorers = generateScorers(rng, m.team_home, m.team_away, h, a, playersByTeam, goalCounts);
    simulated.set(m.id, {
      id: m.id, stage: 'group',
      team_home: m.team_home, team_away: m.team_away,
      actual_home: h, actual_away: a, pen_winner: null,
      scorers,
    });
  }

  // === STEP 2: Resolve 1A, 2A, 3A pra cada grupo ===
  const thirds = [];
  for (const group in byGroup) {
    const matchesWithResults = byGroup[group].map((m) => {
      const sim = simulated.get(m.id);
      return { ...m, actual_home: sim.actual_home, actual_away: sim.actual_away };
    });
    const standings = computeGroupStandings(matchesWithResults);
    if (standings.length >= 2) {
      slotMap.set('1' + group, standings[0].team);
      slotMap.set('2' + group, standings[1].team);
    }
    if (standings[2]) {
      slotMap.set('3' + group, standings[2].team);
      thirds.push({
        group,
        team: standings[2].team,
        pts: standings[2].pts,
        sg: standings[2].sg,
        gp: standings[2].gp,
      });
    }
  }

  // === STEP 3: Resolve slots compostos 3X/Y/Z usando BACKTRACKING ===
  // Mesmo tiebreaker do SQL (migration 015): pts → SG → GF → FIFA rank
  thirds.sort((a, b) => b.pts - a.pts || b.sg - a.sg || b.gp - a.gp || fifaRank(a.team) - fifaRank(b.team));

  // Lista de slots compostos a resolver (ordem do id)
  const koMatches = matches.filter((m) => m.stage !== 'group').sort((a, b) => a.id - b.id);
  const compositeSlots = [];
  for (const m of koMatches) {
    for (const slot of [m.slot_home, m.slot_away]) {
      if (!slot || !slot.startsWith('3') || !slot.includes('/')) continue;
      if (slotMap.has(slot)) continue;
      if (compositeSlots.some(s => s.slot === slot)) continue;
      compositeSlots.push({ slot, validGroups: slot.slice(1).split('/') });
    }
  }

  // Backtracking: tenta atribuir cada slot a um third valido
  function backtrack(idx, assignment, used) {
    if (idx >= compositeSlots.length) return assignment;
    const { slot, validGroups } = compositeSlots[idx];
    // Tenta cada third compatível (em ordem da classificação FIFA)
    for (const third of thirds) {
      if (used.has(third.team)) continue;
      if (!validGroups.includes(third.group)) continue;
      assignment.set(slot, third.team);
      used.add(third.team);
      const result = backtrack(idx + 1, assignment, used);
      if (result) return result;
      assignment.delete(slot);
      used.delete(third.team);
    }
    return null;  // sem solução nesse branch
  }

  const result = backtrack(0, new Map(), new Set());
  if (result) {
    for (const [slot, team] of result) {
      slotMap.set(slot, team);
    }
  } else {
    console.error('[simulator] BACKTRACKING falhou — nenhuma atribuicao valida de terceiros');
  }

  // === STEP 4: Cascata de W##/L## (round by round) ===
  // Processa em ordem de match_date pra garantir que dependencias resolvem antes
  const sortedKO = [...koMatches].sort((a, b) => new Date(a.match_date) - new Date(b.match_date));
  for (const m of sortedKO) {
    // Resolve team_home e team_away
    const homeSlot = m.slot_home;
    const awaySlot = m.slot_away;
    const teamHome = slotMap.get(homeSlot) ?? homeSlot;
    const teamAway = slotMap.get(awaySlot) ?? awaySlot;

    // Se nao resolveu, pula (vai aparecer no error log)
    if (/^[0-9WL]/.test(teamHome) || /^[0-9WL]/.test(teamAway) || teamHome.includes('/') || teamAway.includes('/')) {
      console.error(`[simulator] Slot nao resolvido pra match ${m.id}: ${teamHome} vs ${teamAway}`);
      continue;
    }

    // Gera placar
    const [h, a] = pickScore(rng, m.stage);
    const penWinner = (h === a) ? (rng() < 0.5 ? 'home' : 'away') : null;
    const scorers = generateScorers(rng, teamHome, teamAway, h, a, playersByTeam, goalCounts);

    simulated.set(m.id, {
      id: m.id,
      stage: m.stage,
      team_home: teamHome,
      team_away: teamAway,
      actual_home: h,
      actual_away: a,
      pen_winner: penWinner,
      scorers,
    });

    // Determina W## e L##
    let winner, loser;
    if (h > a) { winner = teamHome; loser = teamAway; }
    else if (a > h) { winner = teamAway; loser = teamHome; }
    else if (penWinner === 'home') { winner = teamHome; loser = teamAway; }
    else { winner = teamAway; loser = teamHome; }

    slotMap.set('W' + m.id, winner);
    slotMap.set('L' + m.id, loser);
  }

  // === STEP 5: Determina top scorer ===
  let topScorer = null;
  let maxGoals = 0;
  for (const [pid, count] of Object.entries(goalCounts)) {
    if (count > maxGoals) {
      maxGoals = count;
      const player = players.find((p) => p.id === parseInt(pid, 10));
      if (player) topScorer = { player_id: player.id, full_name: player.full_name, team: player.team, total_goals: count };
    }
  }

  // Determina campeao real
  const finalMatch = simulated.get(matches.find((m) => m.stage === 'final').id);
  let champion = null;
  if (finalMatch) {
    if (finalMatch.actual_home > finalMatch.actual_away) champion = finalMatch.team_home;
    else if (finalMatch.actual_away > finalMatch.actual_home) champion = finalMatch.team_away;
    else if (finalMatch.pen_winner === 'home') champion = finalMatch.team_home;
    else champion = finalMatch.team_away;
  }

  return {
    matches: Array.from(simulated.values()).sort((a, b) => a.id - b.id),
    slotMap: Object.fromEntries(slotMap),
    topScorer,
    champion,
    seed,
  };
}

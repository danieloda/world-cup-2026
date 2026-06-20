// ============================================================
// Resolução do bracket (PURA — sem DOM, sem Supabase)
// ============================================================
// Dado o conjunto de partidas + palpites, computa qual time ocupa cada slot
// ("1A", "2B", "3A/B/C/D", "W73", "L101") propagando grupos → mata-mata.
//
// Extraído de pages/palpites-mata.js para ser testável isoladamente: é o
// coração do produto (foi onde nasceu o bug do M85 / campeão sumindo) e antes
// vivia acoplado ao render + estado de módulo, impossível de testar por unit.
//
// Os desempates e a atribuição de 3ºs vêm dos módulos já testados
// (util.computeStandings, thirds-assign, fifa-rank) — aqui só orquestramos.

import { computeStandings as utilComputeStandings } from './util.js';
import { fifaRank } from './fifa-rank.js';
import { assignCompositeThirds } from './thirds-assign.js';

/**
 * Um nome é "time real" (não um slot) quando não começa com dígito/L/W e não
 * contém '/'. Ex.: "Brazil" é real; "1A", "W73", "3A/B/C/D" são slots.
 */
export function isRealTeam(name) {
  if (!name) return false;
  return !/^[\dLW]/.test(name) && !name.includes('/');
}

/**
 * Resolve uma string de slot para o nome do time, se possível.
 * Retorna null se ainda não dá pra resolver.
 * @param {string} slot
 * @param {Map<string, {team:string, source:string}>} res
 */
export function resolveSlotToTeam(slot, res) {
  if (!slot) return null;
  if (isRealTeam(slot)) return slot;
  const entry = res.get(slot);
  return entry?.team ?? null;
}

/**
 * Computa qual time deveria ocupar cada slot ("1A", "W73") com base nos
 * resultados reais e/ou palpites. Retorna Map<slot, {team, source}>.
 *   source: 'pred-group' | 'pred-ko' | 'real'
 *
 * @param {object}  args
 * @param {Array}   args.allMatches  Todas as partidas (104, incluindo grupos).
 * @param {Array}   args.matches     Só as 32 de mata-mata.
 * @param {Map}     args.predsByMatch  match_id -> prediction row.
 * @param {string} [args.mode]       'real-first' (default): usa resultado real
 *                                   se houver, senão palpite. 'pred-only':
 *                                   sempre usa o palpite (ignora resultado).
 * @returns {Map<string, {team:string, source:string}>}
 */
export function computeSlotResolution({ allMatches, matches, predsByMatch, mode = 'real-first' }) {
  const res = new Map();
  const thirdsRanked = [];  // [{ group, team, pts, sg, gp, fairPlay, source }]
  const usePredOnly = mode === 'pred-only';

  // Adapter local: computeStandings do util com o formato esperado aqui.
  const computeStandings = (groupMatches, useReal) =>
    utilComputeStandings(groupMatches, useReal ? 'real' : 'sim', predsByMatch);

  // === 1) Group winners (1X), runners-up (2X) e third (3X) ===
  const groupLetters = [...new Set(allMatches.filter(m => m.group_name).map(m => m.group_name))];
  for (const g of groupLetters) {
    const groupMatches = allMatches.filter(m => m.group_name === g && m.stage === 'group');
    const allFinished = groupMatches.every(m => m.finished);
    const allPredicted = groupMatches.every(m => predsByMatch.has(m.id));

    let standings, source;
    if (!usePredOnly && allFinished) {
      standings = computeStandings(groupMatches, /* useReal= */ true);
      source = 'real';
    } else if (allPredicted) {
      standings = computeStandings(groupMatches, /* useReal= */ false);
      source = 'pred-group';
    } else {
      continue;  // dados incompletos pra esse grupo
    }

    if (standings.length >= 2) {
      res.set('1' + g, { team: standings[0].team, source });
      res.set('2' + g, { team: standings[1].team, source });
    }
    if (standings[2]) {
      res.set('3' + g, { team: standings[2].team, source });
      thirdsRanked.push({
        group: g,
        team: standings[2].team,
        pts: standings[2].pts,
        sg: standings[2].sg,
        gp: standings[2].gp,
        fairPlay: standings[2].fairPlay ?? 0,
        source,
      });
    }
  }

  // === 1.5) Slots compostos de 3ºs lugares (3A/B/C/D/F, 3C/D/F/G/H, etc.) ===
  // Ranking dos 3ºs (grupos diferentes → SEM confronto direto): pts → SG → GF →
  // fair play → FIFA rank (igual DB resolve_match_slots e standings-view.js).
  thirdsRanked.sort((a, b) =>
    b.pts - a.pts || b.sg - a.sg || b.gp - a.gp
    || (b.fairPlay ?? 0) - (a.fairPlay ?? 0)
    || fifaRank(a.team) - fifaRank(b.team)
  );
  // Slots compostos distintos, em ordem de match id (= ordem do servidor/simulador).
  // Usa slot_home/slot_away (slot original) — team_home/away pode já estar resolvido.
  const compositeSlots = [];
  for (const m of [...matches].sort((a, b) => a.id - b.id)) {
    for (const slotKey of [m.slot_home, m.slot_away]) {
      if (!slotKey || !slotKey.startsWith('3') || !slotKey.includes('/')) continue;
      if (compositeSlots.some(s => s.slot === slotKey)) continue;
      compositeSlots.push({ slot: slotKey, validGroups: slotKey.slice(1).split('/') });
    }
  }
  for (const [slotKey, third] of assignCompositeThirds(compositeSlots, thirdsRanked)) {
    res.set(slotKey, { team: third.team, source: third.source });
  }

  // === 2) W### e L### dos jogos de mata-mata ===
  // Usa slot_home/slot_away (referências originais) em vez de team_home/away
  // (que o trigger do DB pode já ter sobrescrito com o time real).
  const koSorted = [...matches].sort((a, b) => new Date(a.match_date) - new Date(b.match_date));
  for (const m of koSorted) {
    const homeSlot = m.slot_home || m.team_home;
    const awaySlot = m.slot_away || m.team_away;
    const homeTeam = resolveSlotToTeam(homeSlot, res);
    const awayTeam = resolveSlotToTeam(awaySlot, res);

    if (!homeTeam || !awayTeam) continue;

    let winner, loser, source = 'pred-ko';
    if (!usePredOnly && m.finished && m.actual_home != null && m.actual_away != null) {
      if (m.actual_home > m.actual_away) { winner = homeTeam; loser = awayTeam; source = 'real'; }
      else if (m.actual_away > m.actual_home) { winner = awayTeam; loser = homeTeam; source = 'real'; }
      else if (m.pen_winner === 'home') { winner = homeTeam; loser = awayTeam; source = 'real'; }
      else if (m.pen_winner === 'away') { winner = awayTeam; loser = homeTeam; source = 'real'; }
    } else {
      const p = predsByMatch.get(m.id);
      if (!p || p.pred_home == null || p.pred_away == null) continue;
      if (p.pred_home > p.pred_away) { winner = homeTeam; loser = awayTeam; }
      else if (p.pred_away > p.pred_home) { winner = awayTeam; loser = homeTeam; }
      else if (p.pred_pen_winner === 'home') { winner = homeTeam; loser = awayTeam; }
      else if (p.pred_pen_winner === 'away') { winner = awayTeam; loser = homeTeam; }
      else continue;
    }

    res.set('W' + m.id, { team: winner, source });
    res.set('L' + m.id, { team: loser, source });
  }

  return res;
}

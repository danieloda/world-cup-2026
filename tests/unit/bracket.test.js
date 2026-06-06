import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSlotResolution } from '../../src/js/bracket.js';
import { makeRng } from '../../scripts/e2e/lib/prng.js';

/**
 * Testes do coração do produto: a resolução do bracket (src/js/bracket.js).
 *
 * Duas frentes:
 *  A) EQUIVALÊNCIA — bracket.js, alimentado com os resultados do torneio dourado
 *     (scripts/e2e/expected-tournament.json, gerado por um simulador
 *     INDEPENDENTE), tem de reproduzir exatamente o slotMap e o campeão. Isso
 *     valida a cascata grupos→mata e a paridade util.computeStandings ↔ SQL.
 *  B) INVARIANTES — sobre N conjuntos de palpites completos e aleatórios, certas
 *     verdades NUNCA podem quebrar: o campeão sempre resolve, os 32 entrantes do
 *     R32 são distintos, todo W## e todo slot composto de 3º resolvem. O bug do
 *     M85 (campeão sumindo) é exatamente a violação da primeira invariante.
 *
 * A topologia do bracket (quais slots alimentam cada jogo) vem do seed do DB
 * (supabase/seed/01_matches.sql) — fonte da verdade da estrutura.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED_SQL = join(REPO, 'supabase', 'seed', '01_matches.sql');
// Cópia CONGELADA do torneio dourado (o original em scripts/e2e/ é gitignored,
// então ausente no CI). Determinístico (seed wc2026-e2e-v1). Regenerar com:
//   cp scripts/e2e/expected-tournament.json tests/fixtures/
const GOLDEN = join(REPO, 'tests', 'fixtures', 'expected-tournament.json');

// ---- Topologia: parse do seed -------------------------------------------------
// Linhas: (id, 'stage', 'round', GROUP, 'date'::timestamptz, 'ground', 'home', 'away')
// Nenhum valor contém aspas simples ou vírgula → o split por campo aspeado é seguro.
const ROW_RE = /\(\s*(\d+),\s*'([^']*)',\s*'[^']*',\s*(NULL|'[^']*'),\s*'([^']*)'::timestamptz,\s*'[^']*',\s*'([^']*)',\s*'([^']*)'\s*\)/g;

function parseTopology() {
  const sql = readFileSync(SEED_SQL, 'utf8');
  const out = [];
  let m;
  while ((m = ROW_RE.exec(sql)) !== null) {
    const [, id, stage, groupRaw, matchDate, home, away] = m;
    const isKO = stage !== 'group';
    out.push({
      id: Number(id),
      stage,
      group_name: groupRaw === 'NULL' ? null : groupRaw.slice(1, -1),
      match_date: matchDate,
      // Em KO, home/away do seed SÃO os slots ("2A", "3A/B/C/D/F", "W101").
      slot_home: isKO ? home : null,
      slot_away: isKO ? away : null,
      team_home: home,
      team_away: away,
    });
  }
  return out;
}

const TOPOLOGY = parseTopology();
const KO_STAGES = new Set(['r32', 'r16', 'qf', 'sf', 'third', 'final']);
const koTopo = TOPOLOGY.filter((m) => KO_STAGES.has(m.stage));
const finalId = TOPOLOGY.find((m) => m.stage === 'final').id;

// Slots compostos de 3º distintos presentes na topologia (ex.: "3A/B/C/D/F").
const compositeThirdSlots = [...new Set(
  koTopo.flatMap((m) => [m.slot_home, m.slot_away])
        .filter((s) => s && s.startsWith('3') && s.includes('/'))
)];

const isResolvedTeam = (name) =>
  typeof name === 'string' && name.length > 0 && !/^[\dWL]/.test(name) && !name.includes('/');

describe('topologia do seed (sentinela)', () => {
  it('parseia 104 matches, 32 de mata-mata e ≥1 slot composto de 3º', () => {
    expect(TOPOLOGY.length).toBe(104);
    expect(koTopo.length).toBe(32);
    expect(compositeThirdSlots.length).toBeGreaterThan(0);
    expect(finalId).toBe(104);
  });
});

// ---- A) Equivalência com o torneio dourado ------------------------------------
describe('bracket.js reproduz o oráculo independente (expected-tournament.json)', () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const resultById = new Map(golden.matches.map((m) => [m.id, m]));

  // Topologia + resultados reais do golden, tudo finished.
  const allMatches = TOPOLOGY.map((t) => {
    const r = resultById.get(t.id);
    return {
      ...t,
      finished: true,
      actual_home: r.actual_home,
      actual_away: r.actual_away,
      pen_winner: r.pen_winner,
    };
  });
  const matches = allMatches.filter((m) => KO_STAGES.has(m.stage));
  const res = computeSlotResolution({ allMatches, matches, predsByMatch: new Map(), mode: 'real-first' });

  it('todo slot do golden resolve para o mesmo time', () => {
    const mismatches = [];
    for (const [slot, team] of Object.entries(golden.slotMap)) {
      const got = res.get(slot)?.team;
      if (got !== team) mismatches.push(`${slot}: esperado ${team}, veio ${got ?? '(não resolvido)'}`);
    }
    expect(mismatches, `divergências de slot:\n${mismatches.join('\n')}`).toEqual([]);
  });

  it('o campeão (vencedor da final) bate com o golden', () => {
    expect(res.get('W' + finalId)?.team).toBe(golden.champion);
  });
});

// ---- B) Invariantes sobre palpites completos aleatórios -----------------------
function randomCompletePreds(rng) {
  const preds = new Map();
  for (const m of TOPOLOGY) {
    const h = Math.floor(rng() * 5);
    const a = Math.floor(rng() * 5);
    // Mata-mata precisa de vencedor: se empatou no placar, define o pênalti.
    const pen = (KO_STAGES.has(m.stage) && h === a) ? (rng() < 0.5 ? 'home' : 'away') : null;
    preds.set(m.id, { pred_home: h, pred_away: a, pred_pen_winner: pen });
  }
  return preds;
}

describe('invariantes do bracket (palpites completos aleatórios)', () => {
  const N = 150;
  for (let i = 0; i < N; i++) {
    const seed = `inv-${i}`;
    it(`seed ${seed}: torneio totalmente resolvido e consistente`, () => {
      const preds = randomCompletePreds(makeRng(seed));
      const res = computeSlotResolution({
        allMatches: TOPOLOGY, matches: koTopo, predsByMatch: preds, mode: 'pred-only',
      });

      // 1) Campeão existe e é um time real (o bug do M85 viola isto).
      const champion = res.get('W' + finalId)?.team;
      expect(isResolvedTeam(champion), `campeão não resolveu: ${champion}`).toBe(true);

      // 2) Todo jogo de mata-mata produziu vencedor E perdedor reais.
      for (const m of koTopo) {
        expect(isResolvedTeam(res.get('W' + m.id)?.team), `W${m.id} (${m.stage}) não resolveu`).toBe(true);
        expect(isResolvedTeam(res.get('L' + m.id)?.team), `L${m.id} (${m.stage}) não resolveu`).toBe(true);
      }

      // 3) Todo slot composto de 3º foi atribuído a um time real.
      for (const slot of compositeThirdSlots) {
        expect(isResolvedTeam(res.get(slot)?.team), `slot ${slot} não resolveu`).toBe(true);
      }

      // 4) Os 32 entrantes do R32 são 32 times reais DISTINTOS (ninguém 2x).
      const r32 = koTopo.filter((m) => m.stage === 'r32');
      const entrants = r32.flatMap((m) => [
        res.get(m.slot_home)?.team ?? (isResolvedTeam(m.slot_home) ? m.slot_home : undefined),
        res.get(m.slot_away)?.team ?? (isResolvedTeam(m.slot_away) ? m.slot_away : undefined),
      ]);
      expect(entrants.every(isResolvedTeam), 'entrante do R32 não resolvido').toBe(true);
      expect(new Set(entrants).size, 'time repetido entre os entrantes do R32').toBe(entrants.length);
    });
  }
});

// ---- C) Invariantes sobre estados PARCIAIS (greedy fallback + real-first) ------
// O bloco B só testa palpites COMPLETOS (todo grupo decidível → existe
// emparelhamento perfeito dos 3ºs). Mas na vida real a pessoa preenche aos
// poucos: grupos incompletos, mistura de resultado real + palpite. Aí o
// thirds-assign cai no fallback greedy e a cascata KO resolve só em parte.
// Invariante: resolução parcial NUNCA pode produzir lixo — todo slot resolvido
// é um time REAL (nunca um slot tipo "3A/B/C" ou "W101" vazando como time) e
// nenhum time aparece duas vezes. O campeão pode ficar irresolvido (ok).

// Palpites incompletos: pula ~40% dos jogos → grupos meio-preenchidos.
function randomPartialPreds(rng, fillProb = 0.6) {
  const preds = new Map();
  for (const m of TOPOLOGY) {
    if (rng() > fillProb) continue;  // deixa buracos de propósito
    const h = Math.floor(rng() * 5);
    const a = Math.floor(rng() * 5);
    const pen = (KO_STAGES.has(m.stage) && h === a) ? (rng() < 0.5 ? 'home' : 'away') : null;
    preds.set(m.id, { pred_home: h, pred_away: a, pred_pen_winner: pen });
  }
  return preds;
}

// Topologia com um subconjunto aleatório de jogos já FINALIZADOS (resultado real).
function randomMixedMatches(rng, finishProb = 0.5) {
  return TOPOLOGY.map((m) => {
    if (rng() < finishProb) {
      const h = Math.floor(rng() * 4), a = Math.floor(rng() * 4);
      const pen = (KO_STAGES.has(m.stage) && h === a) ? (rng() < 0.5 ? 'home' : 'away') : null;
      return { ...m, finished: true, actual_home: h, actual_away: a, pen_winner: pen };
    }
    return { ...m, finished: false, actual_home: null, actual_away: null, pen_winner: null };
  });
}

function assertNoGarbage(res, label) {
  // 1) todo slot resolvido é um time REAL (nunca um slot vazando como time)
  for (const [slot, v] of res) {
    expect(isResolvedTeam(v.team), `${label}: slot ${slot} resolveu p/ não-time "${v.team}"`).toBe(true);
  }
  // 2) sem time repetido entre os entrantes RESOLVIDOS do R32
  const r32 = koTopo.filter((m) => m.stage === 'r32');
  const entrants = [];
  for (const m of r32) {
    for (const s of [m.slot_home, m.slot_away]) {
      const t = res.get(s)?.team ?? (isResolvedTeam(s) ? s : null);
      if (t) entrants.push(t);
    }
  }
  expect(new Set(entrants).size, `${label}: time repetido entre entrantes resolvidos do R32`).toBe(entrants.length);
  // 3) sem time repetido entre os slots compostos de 3º já atribuídos
  const thirds = compositeThirdSlots.map((s) => res.get(s)?.team).filter(Boolean);
  expect(new Set(thirds).size, `${label}: time repetido entre slots de 3º`).toBe(thirds.length);
}

describe('invariantes do bracket — estados PARCIAIS (greedy fallback)', () => {
  const N = 120;
  for (let i = 0; i < N; i++) {
    const seed = `partial-${i}`;
    it(`seed ${seed}: palpites incompletos não produzem lixo`, () => {
      const preds = randomPartialPreds(makeRng(seed));
      let res;
      expect(() => {
        res = computeSlotResolution({ allMatches: TOPOLOGY, matches: koTopo, predsByMatch: preds, mode: 'pred-only' });
      }, `seed ${seed} lançou exceção`).not.toThrow();
      assertNoGarbage(res, seed);
    });
  }

  it('é determinístico em estado parcial (mesma entrada, mesma saída)', () => {
    const preds = randomPartialPreds(makeRng('partial-determinism'));
    const a = computeSlotResolution({ allMatches: TOPOLOGY, matches: koTopo, predsByMatch: preds, mode: 'pred-only' });
    const b = computeSlotResolution({ allMatches: TOPOLOGY, matches: koTopo, predsByMatch: preds, mode: 'pred-only' });
    expect([...a.entries()].map(([s, v]) => [s, v.team]))
      .toEqual([...b.entries()].map(([s, v]) => [s, v.team]));
  });
});

describe('invariantes do bracket — REAL-FIRST misto (resultado + palpite)', () => {
  const N = 80;
  for (let i = 0; i < N; i++) {
    const seed = `mixed-${i}`;
    it(`seed ${seed}: cascata real+palpite nunca produz lixo`, () => {
      const rng = makeRng(seed);
      const allMatches = randomMixedMatches(rng);
      const matches = allMatches.filter((m) => KO_STAGES.has(m.stage));
      const preds = randomPartialPreds(rng);
      let res;
      expect(() => {
        res = computeSlotResolution({ allMatches, matches, predsByMatch: preds, mode: 'real-first' });
      }, `seed ${seed} lançou exceção`).not.toThrow();
      assertNoGarbage(res, seed);
    });
  }
});

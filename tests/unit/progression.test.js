// ============================================================
// progression-core.js — o replay do ranking (SSOT dos 2 gráficos).
// Invariante central: a última coordenada de cada série == total do
// leaderboard — TUDO que o usuário pontuou cai em algum jogo disputado
// (bônus de vaga não disputada entra como spillover no último jogo).
// ============================================================
import { describe, it, expect } from 'vitest';
import { indexQualifierBreakdown, matchDelta, buildSeries, demoProgression } from '../../src/js/progression-core.js';
import { scorerBonus, championBonus } from '../../src/js/scoring.js';

// ---------- fixture determinística (3 usuários × 4 jogos) ----------
const MATCHES = [
  { id: 1, stage: 'group', match_date: '2026-06-11T16:00:00+00:00' },
  { id: 2, stage: 'group', match_date: '2026-06-12T16:00:00+00:00' },
  { id: 3, stage: 'r16',   match_date: '2026-06-29T16:00:00+00:00' },
  { id: 4, stage: 'final', match_date: '2026-07-19T16:00:00+00:00' },
];
const FINISHED_IDS = new Set([1, 2, 3, 4]);

const QUAL_ROWS = [
  // u1: vaga do jogo 3 (disputado) + vaga de jogo 99 (NÃO disputado → spillover)
  { user_id: 'u1', breakdown: { items: [{ match_id: 3, pts: 2 }, { match_id: 99, pts: 5 }] } },
  // u2: item sem jogo (match_id null) → spillover; item com 0 pts é ignorado
  { user_id: 'u2', breakdown: { items: [{ match_id: null, pts: 3 }, { match_id: 3, pts: 0 }] } },
  // linha sem breakdown não explode
  { user_id: 'u3', breakdown: null },
];

function makeDeps() {
  const { qualByUserMatch, qualSpill } = indexQualifierBreakdown(QUAL_ROWS, FINISHED_IDS);
  return {
    predPts: new Map([
      ['u1|1', 7], ['u1|2', 4], ['u1|3', 19], ['u1|4', 76],
      ['u2|3', 3],
    ]),
    scorerPick: new Map([['u1', 9], ['u2', 5]]),
    goalsByMatchPlayer: new Map([['1|9', 1], ['4|9', 2]]),  // u2 escolheu o 5: nunca marcou
    qualByUserMatch, qualSpill,
    champPick: new Map([['u1', 'Brazil'], ['u2', 'France']]),
    realChampion: 'Brazil',
    finalMatchId: 4,
  };
}

const LEADERBOARD = [
  { user_id: 'u1', full_name: 'Alice' },
  { user_id: 'u2', full_name: 'Bob' },
  { user_id: 'u3', full_name: 'Carol' },
];

// Totais à mão (oráculo independente do código):
//   u1 = 7+4+19+76 (placar) + 2+20 (artilheiro: 1 gol grupo, 2 gols final)
//        + 2 (vaga do jogo 3) + 5 (spill) + 40 (campeão) = 175
//   u2 = 3 (placar) + 3 (spill) = 6   (campeão errado → 0)
//   u3 = 0
const TOTALS = { u1: 175, u2: 6, u3: 0 };

describe('indexQualifierBreakdown', () => {
  it('atribui ao jogo quando a vaga já foi disputada; senão vira spillover', () => {
    const { qualByUserMatch, qualSpill } = indexQualifierBreakdown(QUAL_ROWS, FINISHED_IDS);
    expect(qualByUserMatch.get('u1|3')).toBe(2);
    expect(qualSpill.get('u1')).toBe(5);
    expect(qualSpill.get('u2')).toBe(3);          // match_id null → spill
    expect(qualByUserMatch.has('u2|3')).toBe(false); // pts 0 ignorado
  });
  it('soma itens repetidos da mesma vaga e tolera entrada vazia', () => {
    const rows = [{ user_id: 'x', breakdown: { items: [{ match_id: 3, pts: 2 }, { match_id: 3, pts: 1 }] } }];
    expect(indexQualifierBreakdown(rows, FINISHED_IDS).qualByUserMatch.get('x|3')).toBe(3);
    expect(indexQualifierBreakdown(null, FINISHED_IDS).qualSpill.size).toBe(0);
    expect(indexQualifierBreakdown([], new Set()).qualByUserMatch.size).toBe(0);
  });
});

describe('matchDelta — tudo que é atribuível a um jogo', () => {
  const deps = makeDeps();
  it('placar + artilheiro no jogo de grupo', () => {
    expect(matchDelta('u1', MATCHES[0], deps)).toBe(7 + scorerBonus(1, 'group'));
  });
  it('campeão cai SÓ no jogo da final (por id), junto com placar/artilheiro', () => {
    expect(matchDelta('u1', MATCHES[3], deps)).toBe(76 + scorerBonus(2, 'final') + championBonus(true));
  });
  it('campeão errado não ganha nada na final', () => {
    expect(matchDelta('u2', MATCHES[3], deps)).toBe(0);
  });
  it('usuário sem nada no jogo → 0', () => {
    expect(matchDelta('u3', MATCHES[1], deps)).toBe(0);
  });
});

describe('buildSeries — séries acumuladas do replay', () => {
  const series = buildSeries({ leaderboard: LEADERBOARD, matches: MATCHES, ...makeDeps() });

  it('forma: 1 série por usuário do ranking, na mesma ordem, ids únicos', () => {
    expect(series.map(s => s.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(new Set(series.map(s => s.userId)).size).toBe(series.length);
  });

  it('values[0]=0 e comprimento = jogos + 1', () => {
    for (const s of series) {
      expect(s.values[0]).toBe(0);
      expect(s.values).toHaveLength(MATCHES.length + 1);
    }
  });

  it('INVARIANTE: fim da série == total do usuário (nada se perde, nada se inventa)', () => {
    for (const s of series) {
      expect(s.values[s.values.length - 1]).toBe(TOTALS[s.userId]);
    }
  });

  it('pontos nunca regridem (deltas são sempre ≥ 0)', () => {
    for (const s of series) {
      for (let i = 1; i < s.values.length; i++) {
        expect(s.values[i]).toBeGreaterThanOrEqual(s.values[i - 1]);
      }
    }
  });

  it('trajetória exata da Alice (oráculo à mão, jogo a jogo)', () => {
    const u1 = series.find(s => s.userId === 'u1');
    // jogo1: 7+2 · jogo2: +4 · jogo3: +19+2 · final: +76+20+40 + spill 5
    expect(u1.values).toEqual([0, 9, 13, 34, 175]);
  });

  it('spillover entra APENAS no último jogo (Bob: vaga sem jogo disputado)', () => {
    const u2 = series.find(s => s.userId === 'u2');
    expect(u2.values).toEqual([0, 0, 0, 3, 6]);   // +3 placar no jogo 3; +3 spill só no fim
  });

  it('usuário sem palpites segue no gráfico com linha zerada', () => {
    const u3 = series.find(s => s.userId === 'u3');
    expect(u3.values).toEqual([0, 0, 0, 0, 0]);
  });

  it('sem jogos → série só com o 0 inicial (loadProgression devolve null antes disso)', () => {
    const empty = buildSeries({ leaderboard: LEADERBOARD, matches: [], ...makeDeps() });
    expect(empty[0].values).toEqual([0]);
  });
});

describe('demoProgression — preview pré-Copa coerente com o formato real', () => {
  const { series, matches } = demoProgression();
  it('mesmo contrato do replay real: values.length == matches.length + 1, ids únicos', () => {
    expect(matches.length).toBeGreaterThan(0);
    for (const s of series) expect(s.values).toHaveLength(matches.length + 1);
    expect(new Set(series.map(s => s.userId)).size).toBe(series.length);
  });
  it('datas em ordem e dentro da janela da Copa', () => {
    const dates = matches.map(m => new Date(m.match_date).getTime());
    expect([...dates].sort((a, b) => a - b)).toEqual(dates);
  });
});

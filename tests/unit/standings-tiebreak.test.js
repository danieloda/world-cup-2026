// ============================================================
// computeStandings — o desempate de grupos que ALIMENTA o mata-mata.
// Critério (igual ao SQL resolve_match_slots): PTS → SG → GF → rank FIFA.
// Cada nível é exercitado ISOLADO (os anteriores empatados de propósito),
// num grupo completo de 4 — não só miniaturas de 2 times.
// ============================================================
import { describe, it, expect } from 'vitest';
import { computeStandings } from '../../src/js/util.js';
import { fifaRank } from '../../src/js/fifa-rank.js';

// Round-robin completo de um grupo (6 jogos), todos encerrados.
function groupMatches(teams, scores) {
  const pairs = [
    [0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2],
  ];
  return pairs.map(([h, a], i) => ({
    id: i + 1, finished: true,
    team_home: teams[h], team_away: teams[a],
    actual_home: scores[i][0], actual_away: scores[i][1],
  }));
}

describe('nível 1 — pontos decidem', () => {
  it('campanha 3V > 2V > 1V > 0V, independente de FIFA', () => {
    // South Africa (FIFA 60) ganha tudo; France (FIFA 1) perde tudo.
    const teams = ['France', 'South Africa', 'Mexico', 'Japan'];
    // Campanhas à mão: Mexico 3V (9) · Japan 2V (6) · South Africa 1V (3) · France 0 —
    // ordem INVERSA ao rank FIFA de propósito (France #1 em último).
    const st = computeStandings(groupMatches(teams, [
      [0, 1], // France 0×1 South Africa
      [2, 0], // Mexico 2×0 Japan
      [0, 2], // France 0×2 Mexico
      [0, 1], // South Africa 0×1 Japan
      [0, 1], // France 0×1 Japan
      [0, 1], // South Africa 0×1 Mexico
    ]), 'real');
    expect(st.map(s => s.team)).toEqual(['Mexico', 'Japan', 'South Africa', 'France']);
    expect(st.map(s => s.pts)).toEqual([9, 6, 3, 0]);
  });
});

describe('nível 2 — pontos iguais, saldo decide', () => {
  it('vitória mais gorda fica na frente', () => {
    // A e B com 1 vitória cada (3 pts), mas A ganhou de 3 e B de 1.
    const matches = [
      { id: 1, finished: true, team_home: 'Japan', team_away: 'Mexico', actual_home: 3, actual_away: 0 },
      { id: 2, finished: true, team_home: 'France', team_away: 'Senegal', actual_home: 1, actual_away: 0 },
    ];
    const st = computeStandings(matches, 'real');
    expect(st[0].team).toBe('Japan');     // SG +3 supera França (FIFA 1) com SG +1
    expect(st[1].team).toBe('France');
    expect(st[0].pts).toBe(st[1].pts);
  });
});

describe('nível 3 — pontos e saldo iguais, gols-pró decide', () => {
  it('empate movimentado fica na frente do 0×0', () => {
    const matches = [
      { id: 1, finished: true, team_home: 'Japan', team_away: 'Mexico', actual_home: 2, actual_away: 2 },
      { id: 2, finished: true, team_home: 'France', team_away: 'Senegal', actual_home: 0, actual_away: 0 },
    ];
    const st = computeStandings(matches, 'real');
    // Todos com 1 pt e SG 0 — Japan/Mexico (GF 2) acima de France/Senegal (GF 0).
    expect(st.slice(0, 2).map(s => s.team).sort()).toEqual(['Japan', 'Mexico']);
    expect(st.slice(2).map(s => s.team).sort()).toEqual(['France', 'Senegal']);
  });
});

describe('nível 4 — tudo igual, rank FIFA decide', () => {
  it('grupo inteiro 1×1: ordem final == ordem FIFA (menor = melhor)', () => {
    const teams = ['South Africa', 'France', 'Japan', 'Mexico'];   // entrada embaralhada
    const st = computeStandings(groupMatches(teams, [
      [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1],
    ]), 'real');
    const expected = [...teams].sort((a, b) => fifaRank(a) - fifaRank(b));
    expect(st.map(s => s.team)).toEqual(expected);                 // France, Mexico, Japan, SAf
    // E os 4 estão de fato 100% empatados nos 3 critérios anteriores:
    for (const s of st) { expect(s.pts).toBe(3); expect(s.sg).toBe(0); expect(s.gp).toBe(3); }
  });
});

describe('grupo parcial — jogos não encerrados não contam', () => {
  it('time com jogo pendente aparece na tabela com a campanha só dos encerrados', () => {
    const matches = [
      { id: 1, finished: true, team_home: 'France', team_away: 'Japan', actual_home: 2, actual_away: 0 },
      { id: 2, finished: false, team_home: 'Mexico', team_away: 'Senegal', actual_home: null, actual_away: null },
    ];
    const st = computeStandings(matches, 'real');
    expect(st).toHaveLength(4);                                    // todos inicializados
    const mex = st.find(s => s.team === 'Mexico');
    expect(mex.j).toBe(0);
    expect(mex.pts).toBe(0);
    expect(st[0].team).toBe('France');
  });
  it('modo pred usa o palpite do usuário no lugar do resultado', () => {
    const matches = [
      { id: 1, finished: false, team_home: 'France', team_away: 'Japan', actual_home: null, actual_away: null },
    ];
    const preds = new Map([[1, { pred_home: 0, pred_away: 2 }]]);
    const st = computeStandings(matches, 'pred', preds);
    expect(st[0].team).toBe('Japan');
    expect(st[0].pts).toBe(3);
  });
});

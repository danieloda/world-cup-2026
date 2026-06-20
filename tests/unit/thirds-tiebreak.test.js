// ============================================================
// Ranking dos MELHORES 3ºs colocados (entre grupos) — Copa 2026.
// Regra oficial (grupos diferentes → SEM confronto direto):
//   pts → SG geral → gols geral → FAIR PLAY → ranking FIFA.
// Aqui isolamos o 4º critério (fair play), que decide ANTES do ranking FIFA.
// Espelha o SQL third_placed (migration 068) e o sort de bracket.js.
// ============================================================
import { describe, it, expect } from 'vitest';
import { computeThirds } from '../../src/js/standings-view.js';
import { fifaRank } from '../../src/js/fifa-rank.js';

// Grupo transitivo: teams[0] > teams[1] > teams[2] > teams[3] (o melhor vence
// 1×0 todos abaixo). Posições decididas por PONTOS → o 3º é sempre teams[2],
// independente de fair play. `fp` injeta a conduta de um time (no 1º jogo dele).
function transitiveGroup(group, teams, baseId, fp = {}) {
  const pairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  const used = new Set();
  return pairs.map(([h, a], k) => {
    const m = {
      id: baseId + k, stage: 'group', group_name: group, finished: true,
      team_home: teams[h], team_away: teams[a],
      actual_home: 1, actual_away: 0,            // mandante (melhor) vence
      home_fairplay: 0, away_fairplay: 0,
    };
    if (fp[teams[h]] != null && !used.has(teams[h])) { m.home_fairplay = fp[teams[h]]; used.add(teams[h]); }
    if (fp[teams[a]] != null && !used.has(teams[a])) { m.away_fairplay = fp[teams[a]]; used.add(teams[a]); }
    return m;
  });
}

describe('3ºs colocados — fair play decide antes do ranking FIFA', () => {
  it('3º com melhor conduta passa na frente, mesmo com FIFA muito pior', () => {
    // Grupo A: 3º = Ghana (FIFA 74), sem cartões (fair play 0).
    // Grupo B: 3º = Japan (FIFA 18, MUITO melhor), mas com fair play −5.
    // Ambos empatam em pts(3)/SG(−1)/GF(1). Pelo fair play, Ghana passa na frente
    // do Japan — provando que o fair play decide ANTES do ranking FIFA.
    const groupA = transitiveGroup('A', ['France', 'Spain', 'Ghana', 'New Zealand'], 1);
    const groupB = transitiveGroup('B', ['England', 'Portugal', 'Japan', 'Haiti'], 11, { Japan: -5 });
    const all = [...groupA, ...groupB];

    const thirds = computeThirds(all, 'real', new Map());
    const [first, second] = thirds;

    expect(first.team).toBe('Ghana');   // fair play 0
    expect(second.team).toBe('Japan');  // fair play −5
    expect(first.fairPlay).toBe(0);
    expect(second.fairPlay).toBe(-5);

    // empatados em tudo antes do fair play:
    expect(first.pts).toBe(3); expect(second.pts).toBe(3);
    expect(first.sg).toBe(second.sg);
    expect(first.gp).toBe(second.gp);

    // e o FIFA, se fosse aplicado antes, INVERTERIA (Japan 18 << Ghana 74):
    expect(fifaRank('Japan')).toBeLessThan(fifaRank('Ghana'));
  });

  it('sem cartões, o desempate dos 3ºs cai no ranking FIFA (controle)', () => {
    // Mesma montagem, mas sem injetar fair play → os dois 3ºs (Ghana 74, Japan 18)
    // empatam em pts/SG/GF e fair play (0) → FIFA decide: Japan (18) na frente.
    const groupA = transitiveGroup('A', ['France', 'Spain', 'Ghana', 'New Zealand'], 1);
    const groupB = transitiveGroup('B', ['England', 'Portugal', 'Japan', 'Haiti'], 11);
    const thirds = computeThirds([...groupA, ...groupB], 'real', new Map());
    expect(thirds[0].team).toBe('Japan');   // melhor FIFA, fair play empatado
    expect(thirds[1].team).toBe('Ghana');
  });
});

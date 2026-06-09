import { describe, it, expect } from 'vitest';
import { sortLeaderboard, tiedPair, assignRanksAndPrizes } from '../../src/js/prize.js';

// Linha de leaderboard mínima (só os campos que o desempate/rateio usam).
const U = (id, total_pts, exact_count = 0, winner_sg_count = 0) =>
  ({ user_id: id, total_pts, exact_count, winner_sg_count });

// Prêmios de exemplo da página de Regras: bolso R$ 2.000 em 70/20/10.
const PRIZE_2000 = [1400, 400, 200];

describe('sortLeaderboard — desempate de participantes (Regras: total → exatos → V+S)', () => {
  it('1º critério: mais pontos no total', () => {
    const out = sortLeaderboard([U('a', 148), U('b', 152), U('c', 150)]);
    expect(out.map(u => u.user_id)).toEqual(['b', 'c', 'a']);
  });

  it('2º critério: empate no total → mais placares exatos', () => {
    const out = sortLeaderboard([U('a', 150, 9), U('b', 150, 11), U('c', 150, 10)]);
    expect(out.map(u => u.user_id)).toEqual(['b', 'c', 'a']);
  });

  it('3º critério: empate em total e exatos → mais (vencedor + saldo)', () => {
    const out = sortLeaderboard([U('a', 150, 9, 17), U('b', 150, 9, 20), U('c', 150, 9, 18)]);
    expect(out.map(u => u.user_id)).toEqual(['b', 'c', 'a']);
  });

  it('empate TOTAL nos 3 critérios → ordem de entrada preservada (sort estável)', () => {
    const out = sortLeaderboard([U('a', 150, 9, 20), U('b', 150, 9, 20)]);
    expect(out.map(u => u.user_id)).toEqual(['a', 'b']);
  });

  it('não muta a lista de entrada', () => {
    const input = [U('a', 100), U('b', 200)];
    const copy = input.map(u => ({ ...u }));
    sortLeaderboard(input);
    expect(input).toEqual(copy);
  });

  it('trata campos ausentes como 0 (robustez)', () => {
    const out = sortLeaderboard([{ user_id: 'a', total_pts: 10 }, { user_id: 'b', total_pts: 10, exact_count: 1 }]);
    expect(out.map(u => u.user_id)).toEqual(['b', 'a']);
  });

  it('linhas totalmente vazias não quebram (todos os campos nulos → 0)', () => {
    const out = sortLeaderboard([{ user_id: 'a' }, { user_id: 'b' }]);
    expect(out.map(u => u.user_id)).toEqual(['a', 'b']); // tudo 0 → estável
  });
});

describe('tiedPair — empate de verdade exige igualdade nos 3 critérios', () => {
  it('iguais nos 3 → true', () => {
    expect(tiedPair(U('a', 150, 9, 20), U('b', 150, 9, 20))).toBe(true);
  });
  it('difere no total → false', () => {
    expect(tiedPair(U('a', 150, 9, 20), U('b', 151, 9, 20))).toBe(false);
  });
  it('difere nos exatos → false', () => {
    expect(tiedPair(U('a', 150, 9, 20), U('b', 150, 10, 20))).toBe(false);
  });
  it('difere no V+S → false', () => {
    expect(tiedPair(U('a', 150, 9, 20), U('b', 150, 9, 21))).toBe(false);
  });
  it('campos ausentes contam como 0', () => {
    expect(tiedPair({ total_pts: 10 }, { total_pts: 10, exact_count: 0, winner_sg_count: 0 })).toBe(true);
  });
  it('duas linhas vazias empatam (tudo 0)', () => {
    expect(tiedPair({}, {})).toBe(true);
  });
});

describe('assignRanksAndPrizes — rateio do prêmio (regra SBC 2022)', () => {
  it('sem empate: posições 1,2,3 e prêmios cheios', () => {
    const rows = sortLeaderboard([U('a', 300), U('b', 200), U('c', 100)]);
    assignRanksAndPrizes(rows, PRIZE_2000);
    expect(rows.map(r => [r.pos, r.tied, r.prizeShare]))
      .toEqual([[1, false, 1400], [2, false, 400], [3, false, 200]]);
  });

  // Exemplo da Regras: "Dois empatam em 1º: somam R$1.400 + R$400 e dividem → R$900
  // cada; o próximo cai para 3º e leva R$200."
  it('dois empatam em 1º → R$ 900 cada; próximo vira 3º com R$ 200', () => {
    const rows = sortLeaderboard([U('a', 300, 9, 5), U('b', 300, 9, 5), U('c', 200)]);
    assignRanksAndPrizes(rows, PRIZE_2000);
    expect(rows.map(r => [r.pos, r.tied, r.tieSize, r.prizeShare]))
      .toEqual([[1, true, 2, 900], [1, true, 2, 900], [3, false, 1, 200]]);
  });

  // Exemplo da Regras: "Dois empatam em 2º: o 1º leva R$1.400; (R$400 + R$200)/2 =
  // R$300 cada."
  it('dois empatam em 2º → 1º cheio; empatados levam R$ 300 cada', () => {
    const rows = sortLeaderboard([U('a', 300), U('b', 200, 8, 4), U('c', 200, 8, 4)]);
    assignRanksAndPrizes(rows, PRIZE_2000);
    expect(rows.map(r => [r.pos, r.tied, r.prizeShare]))
      .toEqual([[1, false, 1400], [2, true, 300], [2, true, 300]]);
  });

  it('três empatam em 1º → somam as 3 casas premiadas e dividem por 3', () => {
    const rows = sortLeaderboard([U('a', 300, 9, 5), U('b', 300, 9, 5), U('c', 300, 9, 5)]);
    assignRanksAndPrizes(rows, PRIZE_2000);
    // (1400 + 400 + 200) / 3 = 666.67; todos pos 1
    expect(rows.map(r => r.pos)).toEqual([1, 1, 1]);
    expect(rows.every(r => Math.abs(r.prizeShare - 2000 / 3) < 1e-9)).toBe(true);
    expect(rows.every(r => r.tied && r.tieSize === 3)).toBe(true);
  });

  it('empate FORA das casas premiadas → prêmio 0 (mas posição compartilhada)', () => {
    const rows = sortLeaderboard([U('a', 300), U('b', 200), U('c', 100, 2, 1), U('d', 100, 2, 1)]);
    assignRanksAndPrizes(rows, PRIZE_2000);
    expect(rows.map(r => r.pos)).toEqual([1, 2, 3, 3]);
    // 3º e 4º empatados ocupam casas 3 e 4: (200 + 0)/2 = 100 cada.
    expect(rows[2].prizeShare).toBe(100);
    expect(rows[3].prizeShare).toBe(100);
  });
});

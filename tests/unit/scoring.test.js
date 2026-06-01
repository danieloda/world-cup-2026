import { describe, it, expect } from 'vitest';
import { matchPoints, scorePrediction, championBonus, scorerBonus, stageMultiplier } from '../../js/scoring.js';

// Modelo ADITIVO (022_additive_scoring.sql): cada acerto SOMA.
//   +ag por LADO certo · +ave vencedor/empate · +dg saldo de gols.
//   placar exato = 2*ag + ave + dg.

describe('matchPoints (tabela por fase)', () => {
  it('grupos = 1/4/1 → exato 7', () => {
    expect(matchPoints('group')).toEqual({ ag: 1, ave: 4, dg: 1, exact: 7 });
  });
  it('32-avos = 1/6/1 → exato 9', () => {
    expect(matchPoints('r32')).toEqual({ ag: 1, ave: 6, dg: 1, exact: 9 });
  });
  it('oitavas = 3/12/1 → exato 19', () => {
    expect(matchPoints('r16')).toEqual({ ag: 3, ave: 12, dg: 1, exact: 19 });
  });
  it('quartas = 5/20/2 → exato 32', () => {
    expect(matchPoints('qf')).toEqual({ ag: 5, ave: 20, dg: 2, exact: 32 });
  });
  it('semis = 8/32/2 → exato 50', () => {
    expect(matchPoints('sf')).toEqual({ ag: 8, ave: 32, dg: 2, exact: 50 });
  });
  it('3º lugar = 4/16/1 → exato 25', () => {
    expect(matchPoints('third')).toEqual({ ag: 4, ave: 16, dg: 1, exact: 25 });
  });
  it('final = 12/48/4 → exato 76', () => {
    expect(matchPoints('final')).toEqual({ ag: 12, ave: 48, dg: 4, exact: 76 });
  });
  it('fase desconhecida cai em grupos', () => {
    expect(matchPoints('xyz').exact).toBe(7);
  });
});

describe('scorePrediction — null handling', () => {
  it('retorna 0 quando palpite é nulo', () => {
    expect(scorePrediction(null, null, null, 2, 1, null, 'group')).toBe(0);
  });
  it('retorna 0 quando resultado é nulo', () => {
    expect(scorePrediction(2, 1, null, null, null, null, 'group')).toBe(0);
  });
});

describe('scorePrediction — placar exato (2*ag + ave + dg)', () => {
  it('grupos 2-1 = 7', () => {
    expect(scorePrediction(2, 1, null, 2, 1, null, 'group')).toBe(7);
  });
  it('grupos 0-0 = 7', () => {
    expect(scorePrediction(0, 0, null, 0, 0, null, 'group')).toBe(7);
  });
  it('oitavas 2-1 = 19', () => {
    expect(scorePrediction(2, 1, null, 2, 1, null, 'r16')).toBe(19);
  });
  it('final 1-0 = 76', () => {
    expect(scorePrediction(1, 0, null, 1, 0, null, 'final')).toBe(76);
  });
  it('semis 3-2 = 50', () => {
    expect(scorePrediction(3, 2, null, 3, 2, null, 'sf')).toBe(50);
  });
  it('32-avos 2-1 = 9', () => {
    expect(scorePrediction(2, 1, null, 2, 1, null, 'r32')).toBe(9);
  });
});

describe('scorePrediction — componentes aditivos (grupos)', () => {
  it('vencedor + saldo, sem lado (3-1 vs 2-0) = ave4 + dg1 = 5', () => {
    expect(scorePrediction(3, 1, null, 2, 0, null, 'group')).toBe(5);
  });
  it('vencedor + saldo away (0-2 vs 1-3) = 5', () => {
    expect(scorePrediction(0, 2, null, 1, 3, null, 'group')).toBe(5);
  });
  it('empate com saldo certo (1-1 vs 2-2) = ave4(empate) + dg1 = 5', () => {
    expect(scorePrediction(1, 1, null, 2, 2, null, 'group')).toBe(5);
  });
  it('só vencedor, saldo errado, sem lado (3-0 vs 2-1) = ave4 = 4', () => {
    expect(scorePrediction(3, 0, null, 2, 1, null, 'group')).toBe(4);
  });
  it('vencedor + 1 lado (2-0 vs 1-0) = ag1(away) + ave4 = 5', () => {
    expect(scorePrediction(2, 0, null, 1, 0, null, 'group')).toBe(5);
  });
  it('só 1 lado, vencedor errado (2-0 vs 2-3) = ag1 = 1', () => {
    expect(scorePrediction(2, 0, null, 2, 3, null, 'group')).toBe(1);
  });
  it('erro total (3-0 vs 0-2) = 0', () => {
    expect(scorePrediction(3, 0, null, 0, 2, null, 'group')).toBe(0);
  });
});

describe('scorePrediction — escala por fase (vencedor+saldo)', () => {
  it('oitavas 3-1 vs 2-0 = ave12 + dg1 = 13', () => {
    expect(scorePrediction(3, 1, null, 2, 0, null, 'r16')).toBe(13);
  });
  it('quartas 3-1 vs 2-0 = ave20 + dg2 = 22', () => {
    expect(scorePrediction(3, 1, null, 2, 0, null, 'qf')).toBe(22);
  });
  it('final 3-1 vs 2-0 = ave48 + dg4 = 52', () => {
    expect(scorePrediction(3, 1, null, 2, 0, null, 'final')).toBe(52);
  });
});

describe('scorePrediction — mata-mata com pênaltis', () => {
  it('1-1(h) vs 1-1(h) oitavas = exato = 19', () => {
    expect(scorePrediction(1, 1, 'h', 1, 1, 'h', 'r16')).toBe(19);
  });
  it('placar exato mas pênalti errado (1-1 h vs 1-1 a) = 2*ag + dg, sem ave = 7', () => {
    expect(scorePrediction(1, 1, 'h', 1, 1, 'a', 'r16')).toBe(7);
  });
  it('vencedor por pênalti certo, sem lado (2-2 h vs 1-1 h) = ave12 + dg1 = 13', () => {
    expect(scorePrediction(2, 2, 'h', 1, 1, 'h', 'r16')).toBe(13);
  });
  it('pênalti errado e nada bate (2-2 h vs 1-1 a) = só dg1 = 1', () => {
    expect(scorePrediction(2, 2, 'h', 1, 1, 'a', 'r16')).toBe(1);
  });
  it('grupos não tem pênalti: empate é empate (1-1 vs 1-1) = 7', () => {
    expect(scorePrediction(1, 1, null, 1, 1, null, 'group')).toBe(7);
  });
});

describe('championBonus', () => {
  it('40 quando acerta', () => { expect(championBonus(true)).toBe(40); });
  it('0 quando erra', () => { expect(championBonus(false)).toBe(0); });
});

describe('scorerBonus (inalterado: 2 × gols × multiplicador)', () => {
  it('grupos: 2 por gol', () => { expect(scorerBonus(1, 'group')).toBe(2); expect(scorerBonus(3, 'group')).toBe(6); });
  it('oitavas: 4 por gol', () => { expect(scorerBonus(1, 'r16')).toBe(4); });
  it('final: 10 por gol', () => { expect(scorerBonus(1, 'final')).toBe(10); expect(scorerBonus(2, 'final')).toBe(20); });
  it('0 gols = 0', () => { expect(scorerBonus(0, 'final')).toBe(0); });
});

describe('stageMultiplier (só usado pelo artilheiro)', () => {
  it('mantém a escala antiga', () => {
    expect(stageMultiplier('group')).toBe(1.0);
    expect(stageMultiplier('final')).toBe(5.0);
    expect(stageMultiplier('xyz')).toBe(1.0);
  });
});

describe('equilíbrio: emoção no fim', () => {
  it('placar exato na final vale muito mais que nos grupos', () => {
    expect(matchPoints('final').exact / matchPoints('group').exact).toBeCloseTo(76 / 7, 5);
  });
  it('progressão crescente do mata-mata', () => {
    const ex = s => matchPoints(s).exact;
    expect(ex('final')).toBeGreaterThan(ex('sf'));
    expect(ex('sf')).toBeGreaterThan(ex('qf'));
    expect(ex('qf')).toBeGreaterThan(ex('r16'));
    expect(ex('r16')).toBeGreaterThan(ex('r32'));
  });
});

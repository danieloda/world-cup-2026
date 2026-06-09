import { describe, it, expect } from 'vitest';
import { matchPoints, scorePrediction, scoreBreakdown, championBonus, scorerBonus, stageMultiplier } from '../../src/js/scoring.js';

// Modelo ADITIVO (022_additive_scoring.sql): cada acerto SOMA.
//   +ag por LADO certo · +ave vencedor/empate · +dg saldo de gols.
//   placar exato = 2*ag + ave + dg.
//
// Os VALORES por fase aqui são literais (= a spec). A garantia de que batem com
// o servidor (v_leaderboard/points_earned) NÃO está aqui — está em
// scoring-parity.test.js, que parseia as funções SQL. Sem ela, função e teste
// poderiam derivar juntos sem ninguém notar.

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
  it('cravou o empate mas errou o pênalti (1-1 h vs 1-1 a) → placar exato CHEIO = 19', () => {
    // Regra (regras.html#penaltis): cravar o placar do tempo normal leva o ponto de
    // RESULTADO mesmo errando quem passou nos pênaltis. r16: 2*ag(3)+ave(12)+dg(1)=19.
    expect(scorePrediction(1, 1, 'h', 1, 1, 'a', 'r16')).toBe(19);
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

  it('aceita o encoding REAL do DB (home/away), não só o atalho h/a', () => {
    // Em produção pred_pen_winner/pen_winner são 'home'/'away' (não 'h'/'a').
    // determineWinner compara por igualdade, então o resultado deve ser idêntico
    // ao dos casos h/a acima — este caso garante fidelidade ao dado de produção.
    expect(scorePrediction(2, 2, 'home', 1, 1, 'home', 'r16')).toBe(13); // vencedor por pênalti certo
    expect(scorePrediction(2, 2, 'home', 1, 1, 'away', 'r16')).toBe(1);  // pênalti errado, só dg1
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

// scoreBreakdown decompõe a pontuação aditiva nas partes que acertaram.
// É o que alimenta os popovers de "de onde vieram os pontos" no histórico
// (Palpites da galera) e o drill-down do ranking.
describe('scoreBreakdown — decomposição aditiva', () => {
  const labels = (b) => b.parts.map(p => p.label);
  const keys = (b) => b.parts.map(p => p.key);

  it('palpite/resultado nulo → sem partes, 0 pts', () => {
    expect(scoreBreakdown(null, null, null, 2, 1, null, 'group')).toEqual({ parts: [], pts: 0 });
    expect(scoreBreakdown(2, 1, null, null, null, null, 'group')).toEqual({ parts: [], pts: 0 });
  });

  it('placar exato (grupo 2-1) → lados + resultado + saldo, soma 7', () => {
    const b = scoreBreakdown(2, 1, null, 2, 1, null, 'group');
    expect(labels(b)).toEqual(['Gols mandante', 'Gols visitante', 'Resultado', 'Saldo']);
    expect(keys(b)).toEqual(['side', 'side', 'winner', 'diff']);
    expect(b.parts.map(p => p.pts)).toEqual([1, 1, 4, 1]);
    expect(b.pts).toBe(7);
  });

  it('vencedor + saldo sem lado (grupo 3-1 vs 2-0) → [Resultado, Saldo] = 5', () => {
    const b = scoreBreakdown(3, 1, null, 2, 0, null, 'group');
    expect(labels(b)).toEqual(['Resultado', 'Saldo']);
    expect(b.pts).toBe(5);
  });

  it('só um lado, vencedor errado (grupo 2-0 vs 2-3) → [Gols mandante] = 1', () => {
    const b = scoreBreakdown(2, 0, null, 2, 3, null, 'group');
    expect(labels(b)).toEqual(['Gols mandante']);
    expect(b.parts[0].pts).toBe(1);
    expect(b.pts).toBe(1);
  });

  it('erro total (grupo 3-0 vs 0-2) → sem partes, 0 pts', () => {
    expect(scoreBreakdown(3, 0, null, 0, 2, null, 'group')).toEqual({ parts: [], pts: 0 });
  });

  it('pênalti certo no KO conta como Resultado (r16 2-2 h vs 1-1 h) → [Resultado, Saldo] = 13', () => {
    const b = scoreBreakdown(2, 2, 'h', 1, 1, 'h', 'r16');
    expect(labels(b)).toEqual(['Resultado', 'Saldo']);
    expect(b.pts).toBe(13); // ave12 + dg1
  });

  it('cravou o empate mas errou o pênalti (r16 1-1 h vs 1-1 a) → exato cheio (lados+resultado+saldo) = 19', () => {
    // Regra: cravar o placar do tempo normal leva o Resultado mesmo errando o pênalti.
    const b = scoreBreakdown(1, 1, 'h', 1, 1, 'a', 'r16');
    expect(keys(b)).toEqual(['side', 'side', 'winner', 'diff']); // 3+3+12+1
    expect(b.pts).toBe(19);
  });

  // Propriedade: a soma do breakdown SEMPRE bate com scorePrediction.
  it('soma do breakdown == scorePrediction (varredura de casos/fases)', () => {
    const stages = ['group', 'r32', 'r16', 'qf', 'sf', 'third', 'final'];
    for (const stage of stages) {
      for (let ph = 0; ph <= 3; ph++) for (let pa = 0; pa <= 3; pa++)
        for (let ah = 0; ah <= 3; ah++) for (let aw = 0; aw <= 3; aw++) {
          const pen = stage !== 'group' ? 'h' : null;
          const apen = stage !== 'group' ? 'a' : null;
          expect(scoreBreakdown(ph, pa, pen, ah, aw, apen, stage).pts)
            .toBe(scorePrediction(ph, pa, pen, ah, aw, apen, stage));
        }
    }
  });
});

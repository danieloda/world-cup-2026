// ============================================================
// card-results.js — comparação palpite × resultado dos cards encerrados.
// Regras testadas (as dos commits de jun/2026 que repaginaram os cards):
//   - dourado ('exact') no mata-mata EXIGE placar exato + os 2 times da vaga;
//   - classificado/artilheiro contam como acerto parcial sem palpite de placar;
//   - total do card = placar + classificado + artilheiro + campeão — e tem que
//     bater com o matchDelta() do replay do ranking (mesma fórmula, 2 lugares).
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  championOf, isExactPred, predTeamForSide, isPerfectKo,
  matchScorerPts, matchQualPts, matchChampionPts,
  groupCardSummary, koCardSummary,
} from '../../src/js/card-results.js';
import { matchDelta } from '../../src/js/progression-core.js';
import { scorerBonus } from '../../src/js/scoring.js';

const FINAL = {
  id: 104, stage: 'final', finished: true,
  team_home: 'Brazil', team_away: 'France',
  actual_home: 2, actual_away: 1, pen_winner: null,
};

describe('championOf — campeão real a partir da final', () => {
  it('null sem jogo ou com final não terminada', () => {
    expect(championOf(null)).toBeNull();
    expect(championOf(undefined)).toBeNull();
    expect(championOf({ ...FINAL, finished: false })).toBeNull();
  });
  it('vitória no tempo normal (casa e fora)', () => {
    expect(championOf(FINAL)).toBe('Brazil');
    expect(championOf({ ...FINAL, actual_home: 0, actual_away: 3 })).toBe('France');
  });
  it('empate decide nos pênaltis', () => {
    expect(championOf({ ...FINAL, actual_home: 1, actual_away: 1, pen_winner: 'home' })).toBe('Brazil');
    expect(championOf({ ...FINAL, actual_home: 1, actual_away: 1, pen_winner: 'away' })).toBe('France');
  });
  it('empate sem pen_winner (estado inválido) → null, não um chute', () => {
    expect(championOf({ ...FINAL, actual_home: 1, actual_away: 1, pen_winner: null })).toBeNull();
  });
});

describe('isExactPred', () => {
  const m = { id: 1, finished: true, actual_home: 2, actual_away: 0 };
  it('exato apenas com os DOIS lados certos e jogo encerrado', () => {
    expect(isExactPred(m, { pred_home: 2, pred_away: 0 })).toBe(true);
    expect(isExactPred(m, { pred_home: 2, pred_away: 1 })).toBe(false);
    expect(isExactPred(m, { pred_home: 0, pred_away: 2 })).toBe(false);
    expect(isExactPred({ ...m, finished: false }, { pred_home: 2, pred_away: 0 })).toBe(false);
    expect(isExactPred(m, null)).toBe(false);
    expect(isExactPred(m, undefined)).toBe(false);
  });
});

describe('predTeamForSide — time que o usuário previu na vaga', () => {
  const resolution = new Map([
    ['W89', { team: 'Argentina' }],
    ['1A', { team: 'Mexico' }],
  ]);
  it('slot resolvido pela SUA simulação (mesmo que o real divirja)', () => {
    const m = { team_home: 'Brazil', team_away: 'Spain', slot_home: 'W89', slot_away: '1A' };
    expect(predTeamForSide(m, 'home', resolution)).toBe('Argentina');
    expect(predTeamForSide(m, 'away', resolution)).toBe('Mexico');
  });
  it('vaga que já nasceu como time real (sem slot) → o próprio time', () => {
    const m = { team_home: 'Brazil', team_away: 'Spain', slot_home: null, slot_away: null };
    expect(predTeamForSide(m, 'home', new Map())).toBe('Brazil');
    expect(predTeamForSide(m, 'away', new Map())).toBe('Spain');
  });
  it('vaga não resolvida na simulação → null', () => {
    const m = { team_home: 'W99', team_away: 'Spain', slot_home: 'W99', slot_away: null };
    expect(predTeamForSide(m, 'home', new Map())).toBeNull();
  });
});

describe('isPerfectKo — dourado exige placar exato + os 2 times da vaga', () => {
  const m = {
    id: 90, stage: 'r16', finished: true,
    team_home: 'Brazil', team_away: 'France',
    slot_home: 'W81', slot_away: 'W82',
    actual_home: 1, actual_away: 0,
  };
  const exact = { pred_home: 1, pred_away: 0 };
  const both = new Map([['W81', { team: 'Brazil' }], ['W82', { team: 'France' }]]);
  const oneWrong = new Map([['W81', { team: 'Brazil' }], ['W82', { team: 'Germany' }]]);

  it('placar exato + 2 times certos → perfeito', () => {
    expect(isPerfectKo(m, exact, both)).toBe(true);
  });
  it('placar exato com 1 time errado NÃO é perfeito (regra do commit caa09df)', () => {
    expect(isPerfectKo(m, exact, oneWrong)).toBe(false);
  });
  it('2 times certos sem placar exato NÃO é perfeito', () => {
    expect(isPerfectKo(m, { pred_home: 2, pred_away: 0 }, both)).toBe(false);
  });
  it('vaga não resolvida na simulação → não é perfeito', () => {
    expect(isPerfectKo(m, exact, new Map())).toBe(false);
  });
});

describe('matchScorerPts — bônus do artilheiro por jogo', () => {
  const goals = new Map([
    [7, [{ player_id: 9, goals: 2 }, { player_id: 5, goals: 1 }]],
    [8, [{ player_id: 9, goals: 0 }]],
  ]);
  it('gols do escolhido × multiplicador da fase', () => {
    expect(matchScorerPts({ id: 7, stage: 'group' }, 9, goals)).toBe(scorerBonus(2, 'group')); // 4
    expect(matchScorerPts({ id: 7, stage: 'r16' }, 9, goals)).toBe(scorerBonus(2, 'r16'));     // 8
    expect(matchScorerPts({ id: 7, stage: 'final' }, 5, goals)).toBe(scorerBonus(1, 'final')); // 10
  });
  it('0 sem pick, sem gol do pick, com 0 gols ou sem registro do jogo', () => {
    expect(matchScorerPts({ id: 7, stage: 'group' }, null, goals)).toBe(0);
    expect(matchScorerPts({ id: 7, stage: 'group' }, 123, goals)).toBe(0);
    expect(matchScorerPts({ id: 8, stage: 'group' }, 9, goals)).toBe(0);
    expect(matchScorerPts({ id: 99, stage: 'group' }, 9, goals)).toBe(0);
  });
});

describe('matchQualPts — bônus de classificado dos 2 lados', () => {
  const bySide = new Map([
    ['50:home', { kind: 'bpe', pts: 2 }],
    ['50:away', { kind: 'bp', pts: 1 }],
    ['51:home', { kind: 'bpe' }],            // sem pts gravado → 0, não NaN
  ]);
  it('soma os dois lados / um lado / nenhum', () => {
    expect(matchQualPts({ id: 50 }, bySide)).toBe(3);
    expect(matchQualPts({ id: 51 }, bySide)).toBe(0);
    expect(matchQualPts({ id: 52 }, bySide)).toBe(0);
  });
});

describe('matchChampionPts — só na final, só se acertou', () => {
  it('+40 apenas na final com pick == campeão real', () => {
    expect(matchChampionPts({ stage: 'final' }, 'Brazil', 'Brazil')).toBe(40);
    expect(matchChampionPts({ stage: 'final' }, 'France', 'Brazil')).toBe(0);
    expect(matchChampionPts({ stage: 'sf' }, 'Brazil', 'Brazil')).toBe(0);
    expect(matchChampionPts({ stage: 'final' }, null, 'Brazil')).toBe(0);
    expect(matchChampionPts({ stage: 'final' }, 'Brazil', null)).toBe(0);  // final ainda não acabou
  });
});

describe('groupCardSummary — classe visual do card de grupo', () => {
  const m = { id: 1, stage: 'group', finished: true, actual_home: 2, actual_away: 1 };
  it('exato → dourado, total = placar + artilheiro', () => {
    const s = groupCardSummary(m, { pred_home: 2, pred_away: 1, points_earned: 7 }, 2);
    expect(s).toEqual({ placarPts: 7, pts: 9, isExact: true, resultClass: 'exact' });
  });
  it('pontuou sem cravar → verde (partial)', () => {
    const s = groupCardSummary(m, { pred_home: 1, pred_away: 0, points_earned: 4 }, 0);
    expect(s.resultClass).toBe('partial');
    expect(s.pts).toBe(4);
  });
  it('palpitou e zerou → vermelho (miss)', () => {
    const s = groupCardSummary(m, { pred_home: 0, pred_away: 3, points_earned: 0 }, 0);
    expect(s.resultClass).toBe('miss');
    expect(s.pts).toBe(0);
  });
  it('sem palpite e sem bônus → no-pred', () => {
    expect(groupCardSummary(m, null, 0).resultClass).toBe('no-pred');
  });
  it('sem palpite MAS com gol do artilheiro → partial (ganhou algo no jogo)', () => {
    const s = groupCardSummary(m, null, 2);
    expect(s.resultClass).toBe('partial');
    expect(s.pts).toBe(2);
  });
  it('palpite ainda não pontuado (points_earned null) não vira NaN', () => {
    const s = groupCardSummary(m, { pred_home: 2, pred_away: 1, points_earned: null }, 0);
    expect(s.pts).toBe(0);
    expect(Number.isNaN(s.pts)).toBe(false);
  });
});

describe('koCardSummary — classe visual do card de mata-mata', () => {
  const m = { id: 90, stage: 'r16', finished: true, actual_home: 1, actual_away: 0 };
  const pred = { pred_home: 1, pred_away: 0, points_earned: 19 };

  it('perfeito → dourado; total soma placar + todos os bônus', () => {
    const s = koCardSummary(m, pred, { qualPts: 3, scorerPts: 8, champPts: 0, perfect: true });
    expect(s.resultClass).toBe('exact');
    expect(s.totalPts).toBe(30);
    expect(s.hasAny).toBe(true);
  });
  it('placar exato mas 1 time errado (perfect=false) → verde, NÃO dourado', () => {
    const s = koCardSummary(m, pred, { qualPts: 0, scorerPts: 0, champPts: 0, perfect: false });
    expect(s.resultClass).toBe('partial');
    expect(s.totalPts).toBe(19);
  });
  it('sem palpite de placar mas com bônus de classificado → partial', () => {
    const s = koCardSummary(m, null, { qualPts: 2, perfect: false });
    expect(s.resultClass).toBe('partial');
    expect(s.hasAny).toBe(true);
    expect(s.totalPts).toBe(2);
  });
  it('sem palpite e sem bônus → no-pred ("sem palpite")', () => {
    const s = koCardSummary(m, null, {});
    expect(s.resultClass).toBe('no-pred');
    expect(s.hasAny).toBe(false);
  });
  it('palpitou, zerou o placar e nenhum bônus → miss', () => {
    const s = koCardSummary(m, { pred_home: 0, pred_away: 2, points_earned: 0 }, { perfect: false });
    expect(s.resultClass).toBe('miss');
  });
  it('defaults seguros sem objeto de bônus', () => {
    const s = koCardSummary(m, pred);
    expect(s.totalPts).toBe(19);
    expect(s.resultClass).toBe('partial');
  });
});

// ============================================================
// PARIDADE card ↔ replay: o total exibido no card tem que ser exatamente o
// delta que o gráfico de ranking atribui ao mesmo jogo (mesma fórmula em
// card-results e progression-core — docs/features/palpites-cards.md).
// ============================================================
describe('paridade: total do card == matchDelta do replay', () => {
  it('jogo de final com placar + artilheiro + classificado + campeão', () => {
    const m = {
      id: 104, stage: 'final', finished: true,
      team_home: 'Brazil', team_away: 'France',
      actual_home: 2, actual_away: 1, pen_winner: null,
    };
    const pred = { pred_home: 2, pred_away: 1, points_earned: 76 };
    const user = 'u1';

    // — lado do card —
    const goalsByMatch = new Map([[104, [{ player_id: 9, goals: 2 }]]]);
    const qualifierBySide = new Map([
      ['104:home', { kind: 'bpe', pts: 8 }],
      ['104:away', { kind: 'bp', pts: 4 }],
    ]);
    const card = koCardSummary(m, pred, {
      qualPts: matchQualPts(m, qualifierBySide),
      scorerPts: matchScorerPts(m, 9, goalsByMatch),
      champPts: matchChampionPts(m, 'Brazil', championOf(m)),
      perfect: true,
    });

    // — lado do replay (progression-core) —
    const delta = matchDelta(user, m, {
      predPts: new Map([[`${user}|104`, 76]]),
      scorerPick: new Map([[user, 9]]),
      goalsByMatchPlayer: new Map([['104|9', 2]]),
      qualByUserMatch: new Map([[`${user}|104`, 12]]),   // 8 + 4 dos dois lados
      champPick: new Map([[user, 'Brazil']]),
      realChampion: championOf(m),
      finalMatchId: 104,
    });

    expect(card.totalPts).toBe(delta);
    expect(card.totalPts).toBe(76 + 20 + 12 + 40);  // placar + artilheiro(2 gols × 2 × 5) + vaga + campeão
  });
});

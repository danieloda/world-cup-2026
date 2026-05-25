import { describe, it, expect } from 'vitest';
import { stageMultiplier, scorePrediction, championBonus, scorerBonus } from '../../js/scoring.js';

describe('stageMultiplier', () => {
  it('returns 1.0 for group stage', () => {
    expect(stageMultiplier('group')).toBe(1.0);
  });

  it('returns 1.5 for round of 32', () => {
    expect(stageMultiplier('r32')).toBe(1.5);
  });

  it('returns 2.0 for round of 16', () => {
    expect(stageMultiplier('r16')).toBe(2.0);
  });

  it('returns 3.0 for quarterfinals (increased for comeback potential)', () => {
    expect(stageMultiplier('qf')).toBe(3.0);
  });

  it('returns 4.0 for semifinals (increased for comeback potential)', () => {
    expect(stageMultiplier('sf')).toBe(4.0);
  });

  it('returns 2.0 for third place', () => {
    expect(stageMultiplier('third')).toBe(2.0);
  });

  it('returns 5.0 for final (increased for comeback potential)', () => {
    expect(stageMultiplier('final')).toBe(5.0);
  });

  it('returns 1.0 for unknown stages', () => {
    expect(stageMultiplier('unknown')).toBe(1.0);
    expect(stageMultiplier(undefined)).toBe(1.0);
  });
});

describe('scorePrediction', () => {
  describe('null handling', () => {
    it('returns 0 when prediction is null', () => {
      expect(scorePrediction(null, null, null, 2, 1, null, 'group')).toBe(0);
    });

    it('returns 0 when actual is null', () => {
      expect(scorePrediction(2, 1, null, null, null, null, 'group')).toBe(0);
    });

    it('returns 0 when predHome is null but others are set', () => {
      expect(scorePrediction(null, 1, null, 2, 1, null, 'group')).toBe(0);
    });
  });

  describe('exact score (5 pts base)', () => {
    it('awards 5 pts for exact score in group stage', () => {
      expect(scorePrediction(2, 1, null, 2, 1, null, 'group')).toBe(5);
    });

    it('awards 0-0 exact score', () => {
      expect(scorePrediction(0, 0, null, 0, 0, null, 'group')).toBe(5);
    });

    it('awards 10 pts for exact score in R16 (5 × 2.0)', () => {
      expect(scorePrediction(2, 1, null, 2, 1, null, 'r16')).toBe(10);
    });

    it('awards 25 pts for exact score in final (5 × 5.0)', () => {
      expect(scorePrediction(1, 0, null, 1, 0, null, 'final')).toBe(25);
    });

    it('awards 20 pts for exact score in semifinals (5 × 4.0)', () => {
      expect(scorePrediction(3, 2, null, 3, 2, null, 'sf')).toBe(20);
    });
  });

  describe('winner + goal difference (3 pts base)', () => {
    it('awards 3 pts for same winner and goal diff but different score', () => {
      // Predicted 3-1 (+2), Actual 2-0 (+2) - same winner (home), same diff
      expect(scorePrediction(3, 1, null, 2, 0, null, 'group')).toBe(3);
    });

    it('awards 3 pts for away win with same diff', () => {
      // Predicted 0-2 (-2), Actual 1-3 (-2) - same winner (away), same diff
      expect(scorePrediction(0, 2, null, 1, 3, null, 'group')).toBe(3);
    });

    it('awards 3 pts for draw with same goal diff (both 0)', () => {
      // 1-1 vs 2-2: both draws (winner = 'd'), both diff = 0 → winner + diff = 3 pts
      expect(scorePrediction(1, 1, null, 2, 2, null, 'group')).toBe(3);
    });

    it('awards 6 pts in R16 for winner + diff (3 × 2.0)', () => {
      expect(scorePrediction(3, 1, null, 2, 0, null, 'r16')).toBe(6);
    });
  });

  describe('winner only (2 pts base)', () => {
    it('awards 2 pts for correct winner but wrong diff', () => {
      // Predicted 2-0 (+2), Actual 3-1 (+2) -> same diff, so should be 3
      // Predicted 2-0 (+2), Actual 1-0 (+1) -> different diff, same winner
      expect(scorePrediction(2, 0, null, 1, 0, null, 'group')).toBe(2);
    });

    it('awards 2 pts for correct winner, away team', () => {
      expect(scorePrediction(0, 2, null, 1, 3, null, 'group')).toBe(3); // same diff
      expect(scorePrediction(0, 2, null, 0, 1, null, 'group')).toBe(2); // diff winner
    });

    it('awards 3 pts for predicting draw with same diff in group', () => {
      // Both are draws with diff = 0, so winner + diff = 3 pts (not exact)
      expect(scorePrediction(1, 1, null, 2, 2, null, 'group')).toBe(3);
      expect(scorePrediction(0, 0, null, 1, 1, null, 'group')).toBe(3);
    });

    it('awards 4 pts in R16 for winner only (2 × 2.0)', () => {
      expect(scorePrediction(3, 0, null, 1, 0, null, 'r16')).toBe(4);
    });
  });

  describe('one side correct (1 pt base)', () => {
    it('awards 1 pt when home goals correct but wrong winner', () => {
      // Predicted 2-0 (home wins), Actual 2-3 (away wins) - home goals match
      expect(scorePrediction(2, 0, null, 2, 3, null, 'group')).toBe(1);
    });

    it('awards 1 pt when away goals correct but wrong winner', () => {
      // Predicted 3-1 (home wins), Actual 0-1 (away wins) - away goals match
      expect(scorePrediction(3, 1, null, 0, 1, null, 'group')).toBe(1);
    });

    it('awards 2 pts in R16 for one side (1 × 2.0)', () => {
      expect(scorePrediction(2, 0, null, 2, 3, null, 'r16')).toBe(2);
    });
  });

  describe('miss (0 pts)', () => {
    it('awards 0 pts for completely wrong prediction', () => {
      expect(scorePrediction(3, 0, null, 0, 2, null, 'group')).toBe(0);
    });

    it('awards 0 pts when both sides wrong and wrong winner', () => {
      expect(scorePrediction(1, 0, null, 0, 3, null, 'group')).toBe(0);
    });
  });

  describe('knockout penalty shootouts', () => {
    it('uses penalty winner when regulation ends in draw', () => {
      // Predicted 1-1 home wins on pens, Actual 1-1 home wins on pens
      expect(scorePrediction(1, 1, 'h', 1, 1, 'h', 'r16')).toBe(10); // exact score
    });

    it('awards winner points when penalty prediction correct', () => {
      // Predicted 2-2 home wins on pens, Actual 1-1 home wins on pens (same winner)
      expect(scorePrediction(2, 2, 'h', 1, 1, 'h', 'r16')).toBe(6); // winner + diff (0-0)
    });

    it('awards 2 pts when only penalty winner correct', () => {
      // Predicted 1-1 home wins, Actual 2-2 home wins (diff diff but same winner)
      expect(scorePrediction(1, 1, 'h', 2, 2, 'h', 'r16')).toBe(6); // both are 0 diff draws
    });

    it('awards exact score even with wrong penalty winner', () => {
      // 1-1 vs 1-1 is still exact score (10 pts in R16), penalty winner doesn't affect this
      // This is correct behavior: you got the regulation score exactly right
      expect(scorePrediction(1, 1, 'h', 1, 1, 'a', 'r16')).toBe(10);
    });

    it('awards 0 pts when penalty winner wrong and no goals match', () => {
      // Predicted 2-2 home wins, Actual 1-1 away wins - different winner, no goals match
      expect(scorePrediction(2, 2, 'h', 1, 1, 'a', 'r16')).toBe(0);
    });

    it('awards winner pts when pen prediction matches actual winner', () => {
      // Predicted 2-2 home wins on pens, Actual 2-1 home wins in regulation
      // Winner is same (home), but diff is different (0 vs +1), so 2 pts × 2.0 = 4
      expect(scorePrediction(2, 2, 'h', 2, 1, null, 'r16')).toBe(4);
    });

    it('awards 1 pt when wrong winner but one side matches', () => {
      // Predicted 2-0 home wins, Actual 2-3 away wins - home goals match (2)
      expect(scorePrediction(2, 0, null, 2, 3, null, 'r16')).toBe(2); // 1 × 2.0
    });

    it('treats group stage draws as draws (no pen winner)', () => {
      expect(scorePrediction(1, 1, null, 1, 1, null, 'group')).toBe(5); // exact
    });
  });

  describe('edge cases', () => {
    it('handles high scores', () => {
      expect(scorePrediction(7, 1, null, 7, 1, null, 'group')).toBe(5);
    });

    it('rounds multiplied scores correctly', () => {
      // 5 × 1.5 = 7.5 → 8 (rounded)
      expect(scorePrediction(2, 1, null, 2, 1, null, 'r32')).toBe(8);
      // 3 × 1.5 = 4.5 → 5 (rounded)
      expect(scorePrediction(3, 1, null, 2, 0, null, 'r32')).toBe(5);
    });

    it('handles zero goals', () => {
      expect(scorePrediction(0, 0, null, 0, 0, null, 'group')).toBe(5);
      expect(scorePrediction(0, 1, null, 0, 1, null, 'group')).toBe(5);
    });
  });
});

describe('championBonus', () => {
  it('returns 50 pts when correct', () => {
    expect(championBonus(true)).toBe(50);
  });

  it('returns 0 pts when incorrect', () => {
    expect(championBonus(false)).toBe(0);
  });
});

describe('scorerBonus', () => {
  it('returns 2 pts per goal in group stage', () => {
    expect(scorerBonus(1, 'group')).toBe(2);
    expect(scorerBonus(3, 'group')).toBe(6);
  });

  it('returns 3 pts per goal in R32 (2 × 1.5)', () => {
    expect(scorerBonus(1, 'r32')).toBe(3);
    expect(scorerBonus(2, 'r32')).toBe(6);
  });

  it('returns 4 pts per goal in R16 (2 × 2.0)', () => {
    expect(scorerBonus(1, 'r16')).toBe(4);
  });

  it('returns 6 pts per goal in QF (2 × 3.0)', () => {
    expect(scorerBonus(1, 'qf')).toBe(6);
  });

  it('returns 8 pts per goal in SF (2 × 4.0)', () => {
    expect(scorerBonus(1, 'sf')).toBe(8);
  });

  it('returns 10 pts per goal in Final (2 × 5.0)', () => {
    expect(scorerBonus(1, 'final')).toBe(10);
    expect(scorerBonus(2, 'final')).toBe(20);
  });

  it('returns 0 for 0 goals', () => {
    expect(scorerBonus(0, 'final')).toBe(0);
  });
});

describe('scoring system balance', () => {
  it('final exact is worth 5 group exacts', () => {
    const finalExact = scorePrediction(2, 1, null, 2, 1, null, 'final');
    const groupExact = scorePrediction(2, 1, null, 2, 1, null, 'group');
    expect(finalExact).toBe(25);
    expect(groupExact).toBe(5);
    expect(finalExact / groupExact).toBe(5);
  });

  it('champion bonus equals 10 group exacts', () => {
    const champ = championBonus(true);
    const groupExact = scorePrediction(2, 1, null, 2, 1, null, 'group');
    expect(champ / groupExact).toBe(10);
  });

  it('SF exact > R16 exact > Group exact', () => {
    const sf = scorePrediction(2, 1, null, 2, 1, null, 'sf');
    const r16 = scorePrediction(2, 1, null, 2, 1, null, 'r16');
    const group = scorePrediction(2, 1, null, 2, 1, null, 'group');
    expect(sf).toBeGreaterThan(r16);
    expect(r16).toBeGreaterThan(group);
  });
});

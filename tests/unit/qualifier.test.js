import { describe, it, expect } from 'vitest';
import { qualifierBonus } from '../../js/scoring.js';

// Mirror of public.qualifier_bonus_pts (021_qualifier_bonus.sql).
// "Escala Equilibrada": BPE r32:1 r16:2 qf:3 sf:4 third:3 final:6.
// BP = round(BPE/2), EXCEPT r32 where BP = 0.

describe('qualifierBonus — BPE (exact slot)', () => {
  it('awards the exact-slot value per phase', () => {
    expect(qualifierBonus('r32', true)).toBe(1);
    expect(qualifierBonus('r16', true)).toBe(2);
    expect(qualifierBonus('qf', true)).toBe(3);
    expect(qualifierBonus('sf', true)).toBe(4);
    expect(qualifierBonus('third', true)).toBe(3);
    expect(qualifierBonus('final', true)).toBe(6);
  });
});

describe('qualifierBonus — BP (right team, wrong slot)', () => {
  it('is half of BPE, rounded', () => {
    // r16 BPE 2 → BP 1; qf 3 → 2 (round 1.5); sf 4 → 2; third 3 → 2; final 6 → 3
    expect(qualifierBonus('r16', false)).toBe(1);
    expect(qualifierBonus('qf', false)).toBe(2);
    expect(qualifierBonus('sf', false)).toBe(2);
    expect(qualifierBonus('third', false)).toBe(2);
    expect(qualifierBonus('final', false)).toBe(3);
  });

  it('is 0 in the round of 32 (luck floor, no BP)', () => {
    expect(qualifierBonus('r32', false)).toBe(0);
  });
});

describe('qualifierBonus — non-bonus phases', () => {
  it('returns 0 for group stage and unknown stages', () => {
    expect(qualifierBonus('group', true)).toBe(0);
    expect(qualifierBonus('group', false)).toBe(0);
    expect(qualifierBonus('unknown', true)).toBe(0);
    expect(qualifierBonus(undefined, false)).toBe(0);
  });
});

describe('qualifierBonus — balance sanity', () => {
  it('BP never exceeds BPE', () => {
    for (const stage of ['r32', 'r16', 'qf', 'sf', 'third', 'final']) {
      expect(qualifierBonus(stage, false)).toBeLessThanOrEqual(qualifierBonus(stage, true));
    }
  });

  it('final is the most valuable slot', () => {
    const finalE = qualifierBonus('final', true);
    for (const stage of ['r32', 'r16', 'qf', 'sf', 'third']) {
      expect(finalE).toBeGreaterThanOrEqual(qualifierBonus(stage, true));
    }
  });
});

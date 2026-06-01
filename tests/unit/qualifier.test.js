import { describe, it, expect } from 'vitest';
import { qualifierBonus } from '../../js/scoring.js';

// Mirror of public.qualifier_bonus_pts (022_additive_scoring.sql).
// BPE: r32 1 · r16 2 · qf 3 · sf 5 · third 3 · final 8.
// BP = round(BPE/2), EXCETO r32 onde BP = 0 (32 vagas → "está na fase" é quase de graça).

describe('qualifierBonus — BPE (posição exata)', () => {
  it('valor por fase', () => {
    expect(qualifierBonus('r32', true)).toBe(1);
    expect(qualifierBonus('r16', true)).toBe(2);
    expect(qualifierBonus('qf', true)).toBe(3);
    expect(qualifierBonus('sf', true)).toBe(5);
    expect(qualifierBonus('third', true)).toBe(3);
    expect(qualifierBonus('final', true)).toBe(8);
  });
});

describe('qualifierBonus — BP (time certo, vaga errada)', () => {
  it('= metade arredondada do BPE', () => {
    expect(qualifierBonus('r16', false)).toBe(1);   // round(1)
    expect(qualifierBonus('qf', false)).toBe(2);    // round(1.5)
    expect(qualifierBonus('sf', false)).toBe(3);    // round(2.5)
    expect(qualifierBonus('third', false)).toBe(2); // round(1.5)
    expect(qualifierBonus('final', false)).toBe(4); // round(4)
  });
  it('= 0 nos 32-avos', () => {
    expect(qualifierBonus('r32', false)).toBe(0);
  });
});

describe('qualifierBonus — fases sem bônus', () => {
  it('grupos e desconhecido = 0', () => {
    expect(qualifierBonus('group', true)).toBe(0);
    expect(qualifierBonus('group', false)).toBe(0);
    expect(qualifierBonus('xyz', true)).toBe(0);
    expect(qualifierBonus(undefined, false)).toBe(0);
  });
});

describe('qualifierBonus — sanidade', () => {
  it('BP nunca passa o BPE', () => {
    for (const s of ['r32', 'r16', 'qf', 'sf', 'third', 'final']) {
      expect(qualifierBonus(s, false)).toBeLessThanOrEqual(qualifierBonus(s, true));
    }
  });
  it('final é a vaga mais valiosa', () => {
    const f = qualifierBonus('final', true);
    for (const s of ['r32', 'r16', 'qf', 'sf', 'third']) {
      expect(f).toBeGreaterThanOrEqual(qualifierBonus(s, true));
    }
  });
});

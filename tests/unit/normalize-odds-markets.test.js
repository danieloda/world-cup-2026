import { describe, it, expect } from 'vitest';
import { normalizeOddsMarkets } from '../../scripts/lib/normalize-odds-markets.js';

/**
 * Normalização dos mercados EXTRA de odds (Raio-X enriquecido). Espelha o formato
 * real da resposta da API-Football (Betano) capturado em 2026-06-15 no jogo
 * Bélgica × Egito. Cobre o de-margining, os buckets de gols e o GATING (sem dado
 * útil → null, como as odds/predictions).
 */

// `bets` de uma só bookmaker, com os mercados que consumimos (ids estáveis).
const betanoBets = [
  { id: 1, name: 'Match Winner', values: [
    { value: 'Home', odd: '1.67' }, { value: 'Draw', odd: '4.05' }, { value: 'Away', odd: '5.60' },
  ]},
  { id: 10, name: 'Exact Score', values: [
    { value: '1:0', odd: '6.30' }, { value: '2:0', odd: '7.70' }, { value: '2:1', odd: '8.75' },
    { value: '0:0', odd: '9.50' }, { value: '1:1', odd: '7.00' }, { value: '3:0', odd: '12.50' },
    { value: '0:1', odd: '13.00' },
  ]},
  { id: 5, name: 'Goals Over/Under', values: [
    { value: 'Over 1.5', odd: '1.31' }, { value: 'Under 1.5', odd: '3.45' },
    { value: 'Over 2.5', odd: '1.95' }, { value: 'Under 2.5', odd: '1.85' },
    { value: 'Over 3.5', odd: '3.20' }, { value: 'Under 3.5', odd: '1.33' },
  ]},
  { id: 8, name: 'Both Teams Score', values: [
    { value: 'Yes', odd: '1.90' }, { value: 'No', odd: '1.83' },
  ]},
  { id: 38, name: 'Exact Goals Number', values: [
    { value: '0', odd: '9.00' }, { value: '1', odd: '4.65' }, { value: '2', odd: '3.55' },
    { value: '3', odd: '4.00' }, { value: '4', odd: '5.80' }, { value: '5', odd: '10.50' },
    { value: '6', odd: '21.00' },
  ]},
  { id: 40, name: 'Home Team Exact Goals Number', values: [
    { value: '0', odd: '4.75' }, { value: '1', odd: '2.95' }, { value: '2', odd: '3.25' },
    { value: '3', odd: '5.30' }, { value: 'more 4', odd: '6.50' },
  ]},
  { id: 41, name: 'Away Team Exact Goals Number', values: [
    { value: '0', odd: '2.15' }, { value: '1', odd: '2.45' }, { value: '2', odd: '5.20' },
    { value: '3', odd: '15.50' }, { value: 'more 4', odd: '13.50' },
  ]},
];

const sumClose = (n, target, tol = 2) => expect(Math.abs(n - target)).toBeLessThanOrEqual(tol);

describe('normalizeOddsMarkets — caso real (Bélgica × Egito)', () => {
  const m = normalizeOddsMarkets(betanoBets);

  it('devolve um objeto com todos os mercados', () => {
    expect(m).toBeTruthy();
    expect(m).toHaveProperty('scorelines');
    expect(m).toHaveProperty('overUnder');
    expect(m).toHaveProperty('btts');
    expect(m).toHaveProperty('totalGoals');
    expect(m).toHaveProperty('teamGoals');
  });

  it('placar provável: top ≤6, ordenado desc, formato "h-a"', () => {
    expect(m.scorelines.length).toBeLessThanOrEqual(6);
    expect(m.scorelines.length).toBeGreaterThanOrEqual(3);
    expect(m.scorelines[0].score).toBe('1-0');                 // menor odd = mais provável
    for (let i = 1; i < m.scorelines.length; i++) {
      expect(m.scorelines[i - 1].prob).toBeGreaterThanOrEqual(m.scorelines[i].prob);
    }
    for (const s of m.scorelines) expect(s.score).toMatch(/^\d+-\d+$/);
  });

  it('over/under usa a linha 2.5 e soma ~100%', () => {
    expect(m.overUnder.line).toBe(2.5);
    sumClose(m.overUnder.over + m.overUnder.under, 100);
    expect(m.overUnder.over).toBeGreaterThan(40);
  });

  it('ambas marcam soma ~100% (≈ 49/51 no jogo real)', () => {
    sumClose(m.btts.yes + m.btts.no, 100);
    expect(m.btts.no).toBeGreaterThanOrEqual(m.btts.yes - 4);
  });

  it('distribuição do total: buckets 0..4 + "5+" (5 e 6 colapsados)', () => {
    const keys = m.totalGoals.map(t => t.goals);
    expect(keys).toContain(0);
    expect(keys).toContain('5+');
    expect(keys).not.toContain(5);
    expect(keys).not.toContain(6);
    const peak = m.totalGoals.reduce((a, b) => b.prob > a.prob ? b : a);
    expect(peak.goals).toBe(2);                                 // mais provável: 2 gols
  });

  it('gols por seleção: exp plausível (casa ~1.8 > fora ~1.0) e dist com "4+"', () => {
    expect(m.teamGoals.home.exp).toBeGreaterThan(m.teamGoals.away.exp);
    expect(m.teamGoals.home.exp).toBeGreaterThan(1.3);
    expect(m.teamGoals.home.exp).toBeLessThan(2.6);
    expect(m.teamGoals.home.dist.map(d => d.goals)).toContain('4+');
  });
});

describe('normalizeOddsMarkets — gating e robustez', () => {
  it('sem mercados úteis (só 1X2) → null', () => {
    expect(normalizeOddsMarkets([{ id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: '1.5' }] }])).toBeNull();
  });

  it('entrada vazia / inválida → null', () => {
    expect(normalizeOddsMarkets([])).toBeNull();
    expect(normalizeOddsMarkets(null)).toBeNull();
    expect(normalizeOddsMarkets(undefined)).toBeNull();
  });

  it('placar exato com <3 placares não vira scorelines', () => {
    const m = normalizeOddsMarkets([
      { id: 10, name: 'Exact Score', values: [{ value: '1:0', odd: '5' }, { value: '2:0', odd: '6' }] },
      { id: 8, name: 'Both Teams Score', values: [{ value: 'Yes', odd: '1.9' }, { value: 'No', odd: '1.9' }] },
    ]);
    expect(m.scorelines).toBeUndefined();
    expect(m.btts).toBeTruthy();
  });

  it('odds malformadas/≤1 são ignoradas sem quebrar', () => {
    const m = normalizeOddsMarkets([
      { id: 8, name: 'Both Teams Score', values: [{ value: 'Yes', odd: 'x' }, { value: 'No', odd: '1.0' }] },
    ]);
    expect(m).toBeNull(); // nenhuma odd válida → mercado descartado → nada útil
  });

  it('só parte dos mercados presentes → objeto parcial', () => {
    const m = normalizeOddsMarkets([
      { id: 8, name: 'Both Teams Score', values: [{ value: 'Yes', odd: '2.0' }, { value: 'No', odd: '1.8' }] },
    ]);
    expect(m).toEqual({ btts: expect.objectContaining({ yes: expect.any(Number), no: expect.any(Number) }) });
  });
});

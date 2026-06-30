import { describe, it, expect } from 'vitest';
import { flipMarkets } from '../../scripts/lib/normalize-odds-markets.js';
import { flipPrediction } from '../../scripts/lib/normalize-prediction.js';
import { buildForecast } from '../../src/js/util.js';

// ============================================================
// Orientação casa↔fora do Raio-X "Previsão" no mata-mata
// ============================================================
// No KO a fixture da API pode ter o mando OPOSTO ao nosso team_home; os scripts
// reorientam odds/previsão pela nossa ótica via flipMarkets/flipPrediction. Aqui
// garantimos que o flip troca o que tem lado e PRESERVA o que é simétrico — e que
// é involução (flip duas vezes = original), a prova de que não corrompe dado.

describe('flipMarkets — inverte a ótica dos mercados', () => {
  const mk = {
    scorelines: [{ score: '2-1', prob: 30 }, { score: '1-0', prob: 20 }],
    teamGoals: {
      home: { exp: 1.8, dist: [{ goals: 1, prob: 40 }] },
      away: { exp: 0.9, dist: [{ goals: 0, prob: 55 }] },
    },
    overUnder: { line: 2.5, over: 55, under: 45 },
    btts: { yes: 60, no: 40 },
    totalGoals: [{ goals: 2, prob: 30 }, { goals: 3, prob: 25 }],
  };

  it('inverte os dígitos do placar provável (mantém a prob)', () => {
    const f = flipMarkets(mk);
    expect(f.scorelines).toEqual([{ score: '1-2', prob: 30 }, { score: '0-1', prob: 20 }]);
  });

  it('troca teamGoals home↔away', () => {
    const f = flipMarkets(mk);
    expect(f.teamGoals.home).toEqual(mk.teamGoals.away);
    expect(f.teamGoals.away).toEqual(mk.teamGoals.home);
  });

  it('preserva mercados simétricos (over/under, btts, total)', () => {
    const f = flipMarkets(mk);
    expect(f.overUnder).toEqual(mk.overUnder);
    expect(f.btts).toEqual(mk.btts);
    expect(f.totalGoals).toEqual(mk.totalGoals);
  });

  it('null → null; flip é involução', () => {
    expect(flipMarkets(null)).toBe(null);
    expect(flipMarkets(flipMarkets(mk))).toEqual(mk);
  });

  it('não muta o objeto original', () => {
    const copy = JSON.parse(JSON.stringify(mk));
    flipMarkets(mk);
    expect(mk).toEqual(copy);
  });
});

describe('flipPrediction — inverte a ótica da previsão', () => {
  const p = {
    source: 'API-Football',
    pHome: 60, pDraw: 20, pAway: 20, favored: 'home',
    comparison: [{ label: 'Forma', home: 70, away: 30 }, { label: 'Ataque', home: 55, away: 45 }],
    radar: { axes: ['Forma', 'Ataque'], home: [70, 55], away: [30, 45] },
  };

  it('troca pHome↔pAway e o favorito', () => {
    const f = flipPrediction(p);
    expect(f.pHome).toBe(20);
    expect(f.pAway).toBe(60);
    expect(f.pDraw).toBe(20);
    expect(f.favored).toBe('away');
  });

  it('empate continua empate', () => {
    expect(flipPrediction({ ...p, favored: 'draw' }).favored).toBe('draw');
  });

  it('troca o lado de cada eixo do comparison e do radar', () => {
    const f = flipPrediction(p);
    expect(f.comparison).toEqual([
      { label: 'Forma', home: 30, away: 70 },
      { label: 'Ataque', home: 45, away: 55 },
    ]);
    expect(f.radar).toEqual({ axes: ['Forma', 'Ataque'], home: [30, 45], away: [70, 55] });
  });

  it('null → null; flip é involução', () => {
    expect(flipPrediction(null)).toBe(null);
    expect(flipPrediction(flipPrediction(p))).toEqual(p);
  });
});

describe('buildForecast — une barra 1X2 + radar + mercados', () => {
  const odds = { odd_home: 1.50, odd_draw: 4.00, odd_away: 6.00, bookmaker_name: 'Betano' };
  const apiPred = {
    pHome: 33, pDraw: 33, pAway: 34, favored: 'away', source: 'API-Football',
    radar: { axes: ['Forma'], home: [50], away: [60] }, comparison: [{ label: 'Forma', home: 50, away: 60 }],
  };
  // markets vem FLAT do normalizeOddsMarkets (sem wrapper `goals`).
  const markets = {
    scorelines: [{ score: '1-0', prob: 18 }],
    overUnder: { line: 2.5, over: 60, under: 40 },
    btts: { yes: 55, no: 45 },
    totalGoals: [{ goals: 2, prob: 30 }],
    teamGoals: { home: { exp: 1.6, dist: [] }, away: { exp: 0.9, dist: [] } },
  };

  it('sem nenhuma fonte → null', () => {
    expect(buildForecast(null, undefined, null)).toBe(null);
  });

  it('reagrupa os mercados FLAT em pred.goals (fix do perfil de gols)', () => {
    const f = buildForecast(null, odds, markets);
    expect(f.goals).toEqual({
      overUnder: markets.overUnder, btts: markets.btts,
      totalGoals: markets.totalGoals, teamGoals: markets.teamGoals,
    });
  });

  it('markets só com scorelines (sem mercados de gol) → goals null', () => {
    const f = buildForecast(null, odds, { scorelines: [{ score: '1-0', prob: 18 }] });
    expect(f.scorelines).toBeTruthy();
    expect(f.goals).toBe(null);
  });

  it('a barra vem das ODDS (favorito do mercado), com bookmaker_name', () => {
    const f = buildForecast(null, odds, null);
    expect(f.favored).toBe('home');           // odd_home menor = favorito
    expect(f.source).toBe('Betano');
    expect(Math.round(f.pHome)).toBeGreaterThan(Math.round(f.pAway));
    expect(f.radar).toBe(null);
  });

  it('sem odds, cai pro % da API (fallback)', () => {
    const f = buildForecast(apiPred, undefined, null);
    expect(f.pHome).toBe(33);
    expect(f.source).toBe('API-Football');
    expect(f.radar).toEqual(apiPred.radar);
  });

  it('odds mandam na barra; radar/mercados anexam das outras fontes', () => {
    const f = buildForecast(apiPred, odds, markets);
    expect(f.source).toBe('Betano');          // barra = odds
    expect(f.favored).toBe('home');
    expect(f.radar).toEqual(apiPred.radar);   // radar = predictions
    expect(f.comparison).toEqual(apiPred.comparison);
    expect(f.scorelines).toEqual(markets.scorelines);
    expect(f.goals.btts).toEqual(markets.btts);
    expect(f.goals.overUnder).toEqual(markets.overUnder);
  });

  it('só mercados (sem odds nem API) já renderiza (placar provável)', () => {
    const f = buildForecast(null, undefined, markets);
    expect(f).not.toBe(null);
    expect(f.scorelines).toEqual(markets.scorelines);
    expect(f.source).toBe('Betano');
  });
});

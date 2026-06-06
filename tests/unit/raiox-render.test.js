import { describe, it, expect } from 'vitest';
import {
  renderPredictionsBlock, renderRecentBlock, renderH2HBlock, renderQualifiersBlock,
} from '../../src/js/raiox.js';

/**
 * RENDER ADVERSARIAL do Raio-X (parte do ponto "admin/raio-x").
 *
 * Ao contrário das páginas, os blocos do Raio-X são funções PURAS exportadas
 * (montam string HTML, sem DOM) → dá pra unit-testar com dado FALTANTE/RUIM, que
 * é o estado real quando a API de previsão/h2h/recentes falha ou volta parcial.
 * Invariante: nunca lança e nunca vaza undefined/NaN/[object Object] na string.
 */

const BAD = ['undefined', 'NaN', '[object Object]'];
function clean(html, label) {
  expect(typeof html, `${label}: deveria retornar string`).toBe('string');
  for (const tok of BAD) {
    expect(html.includes(tok), `${label}: vazou "${tok}"`).toBe(false);
  }
}
const noThrow = (fn, label) => {
  let out;
  expect(() => { out = fn(); }, `${label}: lançou exceção`).not.toThrow();
  return out;
};

describe('Raio-X renderPredictionsBlock — dado faltante/ruim', () => {
  it('pred null/vazio → string vazia, sem throw', () => {
    clean(noThrow(() => renderPredictionsBlock('Brazil', 'Argentina', null), 'null'), 'null');
    clean(noThrow(() => renderPredictionsBlock('Brazil', 'Argentina', {}), 'vazio'), 'vazio');
    clean(noThrow(() => renderPredictionsBlock('Brazil', 'Argentina', undefined), 'undef'), 'undef');
  });

  it('barra 1X2 com percentuais válidos e com lixo', () => {
    clean(noThrow(() => renderPredictionsBlock('Brazil', 'Argentina',
      { pHome: '60%', pDraw: '20%', pAway: '20%', favored: 'home', source: 'mercado' }), 'ok'), 'ok');
    clean(noThrow(() => renderPredictionsBlock('Brazil', 'Argentina',
      { pHome: undefined, pDraw: null, pAway: 'x', favored: 'away' }), 'lixo'), 'lixo');
  });

  it('radar com valores undefined/null/string não vira NaN', () => {
    clean(noThrow(() => renderPredictionsBlock('Brazil', 'Argentina',
      { radar: { axes: ['Ataque', 'Defesa', 'Forma'], home: [50, undefined, 'x'], away: [null, 90, 30] } }),
      'radar'), 'radar');
  });
});

describe('Raio-X renderRecentBlock — dado faltante/ruim', () => {
  it('recentByTeam ausente (load falhou) → estado vazio, sem throw (fix)', () => {
    clean(noThrow(() => renderRecentBlock('Brazil', undefined), 'undef-map'), 'undef-map');
    clean(noThrow(() => renderRecentBlock('Brazil', null), 'null-map'), 'null-map');
    clean(noThrow(() => renderRecentBlock('Brazil', new Map()), 'empty-map'), 'empty-map');
  });

  it('partidas com score/data/competição malformados', () => {
    const m = new Map([['Brazil', [
      { date: '2026-06-01', opponent: 'Argentina', home: true, score: '2-1', competition: 'World Cup' },
      { date: undefined, opponent: undefined, home: false, score: undefined, competition: undefined },
      { date: 'xx', opponent: 'Chile', home: true, score: 'a-b', competition: 'Friendly' },
    ]]]);
    clean(noThrow(() => renderRecentBlock('Brazil', m), 'malformado'), 'malformado');
  });
});

describe('Raio-X renderH2HBlock — dado faltante/ruim', () => {
  it('h2h null/sem fixtures → string vazia', () => {
    clean(noThrow(() => renderH2HBlock('Brazil', 'Argentina', null), 'null'), 'null');
    clean(noThrow(() => renderH2HBlock('Brazil', 'Argentina', { fixtures: [] }), 'vazio'), 'vazio');
  });

  it('fixtures com gols null e summary ausente', () => {
    clean(noThrow(() => renderH2HBlock('Brazil', 'Argentina', {
      fixtures: [
        { date: '2024-01-01', home: 'Brazil', away: 'Argentina', home_goals: 2, away_goals: 1, competition: 'Friendly' },
        { date: undefined, home: 'Brazil', away: 'Argentina', home_goals: null, away_goals: null, competition: undefined },
        { date: 'xx', home: 'Brazil', away: 'Chile', home_goals: 0, away_goals: 0, competition: 'World Cup' },
      ],
    }), 'sem-summary'), 'sem-summary');
  });
});

describe('Raio-X renderQualifiersBlock — dado faltante/ruim', () => {
  it('qualifiers null/vazio/sem o time → string vazia, sem throw', () => {
    clean(noThrow(() => renderQualifiersBlock('Brazil', 'Argentina', null), 'null'), 'null');
    clean(noThrow(() => renderQualifiersBlock('Brazil', 'Argentina', {}), 'vazio'), 'vazio');
    clean(noThrow(() => renderQualifiersBlock('Brazil', 'Argentina', { teams: {} }), 'sem-time'), 'sem-time');
  });
});

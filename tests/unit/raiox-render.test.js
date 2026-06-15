import { describe, it, expect } from 'vitest';
import {
  renderPredictionsBlock, renderRecentBlock, renderH2HBlock, renderQualifiersBlock,
  renderRaioXContent,
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

describe('Raio-X enriquecido — placar provável + perfil de gols (markets)', () => {
  const fullPred = {
    pHome: 58, pDraw: 25, pAway: 17, favored: 'home', source: 'Betano',
    scorelines: [{ score: '1-0', prob: 27 }, { score: '2-0', prob: 22 }, { score: '2-1', prob: 20 }],
    goals: {
      overUnder: { line: 2.5, over: 65, under: 35 },
      btts: { yes: 49, no: 51 },
      totalGoals: [{ goals: 0, prob: 10 }, { goals: 2, prob: 25 }, { goals: '5+', prob: 8 }],
      teamGoals: {
        home: { exp: 1.8, dist: [{ goals: 0, prob: 18 }, { goals: 1, prob: 28 }, { goals: '4+', prob: 13 }] },
        away: { exp: 1.0, dist: [{ goals: 0, prob: 39 }, { goals: 1, prob: 34 }, { goals: '4+', prob: 6 }] },
      },
    },
  };

  it('renderiza placar + perfil sem vazar lixo, com a barra 1X2', () => {
    const html = noThrow(() => renderPredictionsBlock('Brazil', 'Argentina', fullPred), 'full');
    clean(html, 'full');
    expect(html).toContain('Placar provável');
    expect(html).toContain('1–0');                 // en-dash no placar
    expect(html).toContain('Perfil de gols');
    expect(html).toContain('Gols esperados');
  });

  it('markets sem 1X2 (só scorelines/goals) ainda renderiza, sem throw', () => {
    const html = noThrow(() => renderPredictionsBlock('Brazil', 'Argentina',
      { scorelines: fullPred.scorelines, goals: fullPred.goals }), 'só-markets');
    clean(html, 'só-markets');
    expect(html).toContain('Placar provável');
  });

  it('markets vazios/ruins não viram NaN nem quebram', () => {
    clean(noThrow(() => renderPredictionsBlock('Brazil', 'Argentina',
      { pHome: 50, pDraw: 30, pAway: 20, favored: 'home',
        scorelines: [{ score: '2-1', prob: 'x' }], goals: { overUnder: null, btts: undefined, totalGoals: [], teamGoals: { home: null, away: null } } }),
      'ruim'), 'ruim');
  });
});

describe('Raio-X renderRaioXContent — grupo ao vivo + tendências', () => {
  const recent = new Map([
    ['Brazil', [
      { date: '2026-06-01', opponent: 'Chile', home: true, score: '3-0', competition: 'Amistoso' },
      { date: '2026-05-20', opponent: 'Peru', home: false, score: '1-1', competition: 'Amistoso' },
    ]],
    ['Argentina', [
      { date: '2026-06-02', opponent: 'Uruguay', home: true, score: '2-1', competition: 'Amistoso' },
    ]],
  ]);
  const standings = { updated_at: 'x', groups: { G: [
    { rank: 1, team: 'Brazil', played: 2, win: 1, draw: 1, lose: 0, gf: 4, ga: 2, gd: 2, points: 4, form: 'WD' },
    { rank: 2, team: 'Argentina', played: 2, win: 1, draw: 1, lose: 0, gf: 3, ga: 2, gd: 1, points: 4, form: 'DW' },
  ]}};

  it('com grupo jogado + recentes → mostra tabela do grupo e tendências, sem lixo', () => {
    const html = noThrow(() => renderRaioXContent('Brazil', 'Argentina',
      { recentByTeam: recent, h2h: null, predictions: null, qualifiers: null, standings }), 'grupo');
    clean(html, 'grupo');
    expect(html).toContain('Grupo G');
    expect(html).toContain('Tendências');
  });

  it('grupo zerado (nenhum jogo) → não mostra a tabela (gating)', () => {
    const zero = { groups: { G: [
      { rank: 1, team: 'Brazil', played: 0, win: 0, draw: 0, lose: 0, gf: 0, ga: 0, gd: 0, points: 0, form: null },
      { rank: 2, team: 'Argentina', played: 0, win: 0, draw: 0, lose: 0, gf: 0, ga: 0, gd: 0, points: 0, form: null },
    ]}};
    const html = noThrow(() => renderRaioXContent('Brazil', 'Argentina',
      { recentByTeam: new Map(), h2h: null, predictions: null, qualifiers: null, standings: zero }), 'zero');
    clean(html, 'zero');
    expect(html).not.toContain('Grupo G');
  });

  it('standings ausente (load falhou) → sem throw, sem grupo', () => {
    const html = noThrow(() => renderRaioXContent('Brazil', 'Argentina',
      { recentByTeam: new Map(), h2h: null, predictions: null, qualifiers: null, standings: undefined }), 'no-stand');
    clean(html, 'no-stand');
  });
});

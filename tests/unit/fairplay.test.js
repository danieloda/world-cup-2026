// ============================================================
// Fair play (conduta) — fórmula oficial FIFA, por jogador e por time.
// Critério #5 do desempate de grupos da Copa 2026. Ver scripts/lib/fairplay.js.
// ============================================================
import { describe, it, expect } from 'vitest';
import { playerFairPlay, summarizeCards } from '../../scripts/lib/fairplay.js';

describe('playerFairPlay — dedução por jogador (regra oficial)', () => {
  it('sem cartão → 0', () => {
    expect(playerFairPlay([])).toBe(0);
    expect(playerFairPlay(undefined)).toBe(0);
  });
  it('1 amarelo → −1', () => {
    expect(playerFairPlay(['Yellow Card'])).toBe(-1);
  });
  it('2 amarelos (vermelho indireto) → −3, não −2', () => {
    expect(playerFairPlay(['Yellow Card', 'Yellow Card'])).toBe(-3);
  });
  it('detail "Second Yellow card" → −3', () => {
    expect(playerFairPlay(['Yellow Card', 'Second Yellow card'])).toBe(-3);
    expect(playerFairPlay(['Second Yellow card'])).toBe(-3);
  });
  it('vermelho direto seco → −4', () => {
    expect(playerFairPlay(['Red Card'])).toBe(-4);
  });
  it('amarelo + vermelho direto → −5', () => {
    expect(playerFairPlay(['Yellow Card', 'Red Card'])).toBe(-5);
  });
  it('maior pontuação = melhor: −1 > −3 > −4 > −5', () => {
    const seq = [['Yellow Card'], ['Yellow Card', 'Yellow Card'], ['Red Card'], ['Yellow Card', 'Red Card']]
      .map(playerFairPlay);
    expect(seq).toEqual([-1, -3, -4, -5]);
    // estritamente decrescente
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeLessThan(seq[i - 1]);
  });
});

describe('summarizeCards — agrega por time a partir de /fixtures/events', () => {
  const ev = (team, player, detail) => ({ type: 'Card', team: { name: team }, player: { id: player }, detail });

  it('soma deduções de vários jogadores do mesmo time', () => {
    const events = [
      ev('Brazil', 10, 'Yellow Card'),                       // jogador 10: −1
      ev('Brazil', 5, 'Yellow Card'), ev('Brazil', 5, 'Yellow Card'), // jogador 5: 2 amarelos → −3
      ev('Croatia', 7, 'Red Card'),                          // jogador 7: vermelho direto −4
    ];
    const s = summarizeCards(events, 'Brazil', 'Croatia');
    expect(s.home).toEqual({ yellow: 3, red: 0, fairplay: -4 }); // −1 + −3
    expect(s.away).toEqual({ yellow: 0, red: 1, fairplay: -4 });
  });

  it('jogo sem cartões → tudo zero (melhor conduta)', () => {
    const s = summarizeCards([], 'Japan', 'Mexico');
    expect(s.home).toEqual({ yellow: 0, red: 0, fairplay: 0 });
    expect(s.away).toEqual({ yellow: 0, red: 0, fairplay: 0 });
  });

  it('ignora eventos que não são cartão e times de fora', () => {
    const events = [
      { type: 'Goal', team: { name: 'Japan' }, player: { id: 1 }, detail: 'Normal Goal' },
      ev('Japan', 9, 'Yellow Card'),
      ev('Outsider', 1, 'Red Card'),  // time que não está no jogo → ignorado
    ];
    const s = summarizeCards(events, 'Japan', 'Mexico');
    expect(s.home).toEqual({ yellow: 1, red: 0, fairplay: -1 });
    expect(s.away).toEqual({ yellow: 0, red: 0, fairplay: 0 });
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assignCompositeThirds } from '../../src/js/thirds-assign.js';

// Slots compostos reais do bracket WC2026, em ordem de match id (= ordem do
// servidor/simulador). Derivados de worldcup.json p/ o teste seguir o dado real.
// (jsdom troca import.meta.url por http: — daí o path via cwd, que é a raiz do repo.)
const worldcup = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/assets/data/worldcup.json'), 'utf8')
);
const COMPOSITE_SLOTS = worldcup.matches
  .map((m, i) => ({ id: i + 1, team1: m.team1, team2: m.team2 }))
  .flatMap(m => [m.team1, m.team2].filter(s => /^3[A-L/]+$/.test(s) && s.includes('/')).map(slot => ({ id: m.id, slot })))
  .sort((a, b) => a.id - b.id)
  .map(({ slot }) => ({ slot, validGroups: slot.slice(1).split('/') }));

// Greedy ingênuo (lógica ANTIGA da página) — usado só p/ provar o contraste.
function greedy(slots, thirds) {
  const out = new Map(), used = new Set();
  for (const { slot, validGroups } of slots) {
    const c = thirds.find(t => validGroups.includes(t.group) && !used.has(t.team));
    if (c) { out.set(slot, c); used.add(c.team); }
  }
  return out;
}

describe('assignCompositeThirds — slots compostos do bracket', () => {
  it('o bracket tem 8 slots de 3º, incluindo M85=3E/F/G/I/J', () => {
    expect(COMPOSITE_SLOTS).toHaveLength(8);
    expect(COMPOSITE_SLOTS.map(s => s.slot)).toContain('3E/F/G/I/J');
  });

  // Caso real reportado por anapaula.gervasio@gmail.com (08/jun/2026).
  // Os 8 melhores 3ºs dela, já na ordem de classificação (pts→SG→GF→FIFA):
  const anaThirds = [
    { group: 'F', team: 'Sweden' },
    { group: 'G', team: 'Egypt' },
    { group: 'A', team: 'Czech Republic' },
    { group: 'E', team: 'Ivory Coast' },
    { group: 'I', team: 'Senegal' },
    { group: 'J', team: 'Algeria' },
    { group: 'C', team: 'Scotland' },
    { group: 'B', team: 'Bosnia & Herzegovina' },
  ];

  it('REGRESSÃO: o greedy antigo deixava M85 e M87 vazios (beco sem saída)', () => {
    const g = greedy(COMPOSITE_SLOTS, anaThirds);
    expect(g.has('3E/F/G/I/J')).toBe(false);  // M85 — bug reportado
    expect(g.has('3D/E/I/J/L')).toBe(false);  // M87
    expect(g.size).toBe(6);                   // 6/8 — incompleto
  });

  it('backtracking resolve os 8/8 e preenche o M85', () => {
    const r = assignCompositeThirds(COMPOSITE_SLOTS, anaThirds);
    expect(r.size).toBe(COMPOSITE_SLOTS.length);
    // todo 3º atribuído respeita os grupos válidos da vaga
    for (const { slot, validGroups } of COMPOSITE_SLOTS) {
      expect(validGroups).toContain(r.get(slot).group);
    }
    // sem reuso de time entre vagas
    const teams = [...r.values()].map(t => t.team);
    expect(new Set(teams).size).toBe(teams.length);
    // M85 resolvido (era o sintoma)
    expect(r.get('3E/F/G/I/J').team).toBe('Senegal');
  });

  it('é determinístico — mesma entrada, mesma saída', () => {
    const a = assignCompositeThirds(COMPOSITE_SLOTS, anaThirds);
    const b = assignCompositeThirds(COMPOSITE_SLOTS, anaThirds);
    expect([...a.entries()].map(([s, t]) => [s, t.team]))
      .toEqual([...b.entries()].map(([s, t]) => [s, t.team]));
  });

  it('prioriza o 3º mais bem classificado quando há folga (greedy ok)', () => {
    // 8 thirds "fáceis" — um por grupo numa ordem sem conflito.
    const easy = [
      { group: 'A', team: 'tA' }, { group: 'B', team: 'tB' }, { group: 'C', team: 'tC' },
      { group: 'D', team: 'tD' }, { group: 'E', team: 'tE' }, { group: 'F', team: 'tF' },
      { group: 'G', team: 'tG' }, { group: 'H', team: 'tH' },
    ];
    const r = assignCompositeThirds(COMPOSITE_SLOTS, easy);
    expect(r.size).toBe(8);
    // M74 (3A/B/C/D/F) deve pegar o 1º elegível por ranking = tA
    expect(r.get('3A/B/C/D/F').team).toBe('tA');
  });

  it('estado parcial (poucos 3ºs) → preenche o máximo possível, sem erro', () => {
    const few = [{ group: 'A', team: 'onlyA' }, { group: 'F', team: 'onlyF' }];
    const r = assignCompositeThirds(COMPOSITE_SLOTS, few);
    expect(r.size).toBeGreaterThanOrEqual(1);   // não trava nem zera tudo
    expect(r.size).toBeLessThanOrEqual(2);       // no máx. um por 3º disponível
    for (const t of r.values()) expect(['onlyA', 'onlyF']).toContain(t.team);
  });

  it('sem 3ºs → mapa vazio', () => {
    expect(assignCompositeThirds(COMPOSITE_SLOTS, []).size).toBe(0);
  });
});

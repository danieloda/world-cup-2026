import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assignCompositeThirds } from '../../src/js/thirds-assign.js';
import { THIRDS_ALLOCATION, MATCH_COLS } from '../../src/js/thirds-allocation.js';

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

// Mapa slot composto -> 1-seed daquele jogo (qual coluna da tabela oficial).
const SLOT_SEED = {
  '3A/B/C/D/F': '1E', '3C/D/F/G/H': '1I', '3C/E/F/H/I': '1A', '3E/H/I/J/K': '1L',
  '3B/E/F/I/J': '1D', '3A/E/H/I/J': '1G', '3E/F/G/I/J': '1B', '3D/E/I/J/L': '1K',
};

// Helper: monta thirds {group, team} a partir de uma lista de grupos (team = "t"+grupo).
const thirdsFromGroups = (groups) => groups.map(g => ({ group: g, team: 't' + g }));

describe('THIRDS_ALLOCATION — tabela oficial da FIFA (Annexe C)', () => {
  it('tem exatamente as 495 combinações C(12,8)', () => {
    expect(Object.keys(THIRDS_ALLOCATION)).toHaveLength(495);
  });

  it('cada combinação é uma bijeção: os 8 jogos usam exatamente os 8 grupos da combinação', () => {
    for (const [combo, row] of Object.entries(THIRDS_ALLOCATION)) {
      const assigned = MATCH_COLS.map(c => row[c]);
      expect(new Set(assigned).size, `${combo}: 3ºs repetidos`).toBe(8);
      expect([...assigned].sort().join(''), `${combo}: grupos ≠ combinação`).toBe(combo);
    }
  });

  it('toda atribuição respeita os grupos válidos do slot daquele jogo', () => {
    const validBySeed = Object.fromEntries(
      COMPOSITE_SLOTS.map(s => [SLOT_SEED[s.slot], s.validGroups])
    );
    for (const [combo, row] of Object.entries(THIRDS_ALLOCATION)) {
      for (const col of MATCH_COLS) {
        expect(validBySeed[col], `${combo}: ${col} fora dos grupos válidos`).toContain(row[col]);
      }
    }
  });

  // Linhas conferidas à mão contra a fonte (Wikipedia/Annexe C).
  it('bate com linhas oficiais conhecidas', () => {
    expect(THIRDS_ALLOCATION['EFGHIJKL']).toEqual({ '1A': 'E', '1B': 'J', '1D': 'I', '1E': 'F', '1G': 'H', '1I': 'G', '1K': 'L', '1L': 'K' });
    expect(THIRDS_ALLOCATION['ABCDEFJL']).toEqual({ '1A': 'C', '1B': 'J', '1D': 'B', '1E': 'D', '1G': 'A', '1I': 'F', '1K': 'L', '1L': 'E' });
  });
});

describe('assignCompositeThirds — usa a tabela oficial, não um matching qualquer', () => {
  it('o bracket tem 8 slots de 3º, incluindo M85=3E/F/G/I/J', () => {
    expect(COMPOSITE_SLOTS).toHaveLength(8);
    expect(COMPOSITE_SLOTS.map(s => s.slot)).toContain('3E/F/G/I/J');
  });

  // REGRESSÃO do bug de produção (fim da fase de grupos, 28/jun/2026): os 8
  // melhores 3ºs vieram dos grupos A,B,C,D,E,F,J,L. O backtracking trocava
  // Suécia(F)/Paraguai(D) entre Alemanha(1E) e França(1I). A tabela oficial:
  // 1E↔3D, 1I↔3F.
  it('combinação real ABCDEFJL → atribuição OFICIAL (1E↔3D, 1I↔3F)', () => {
    const thirds = thirdsFromGroups(['A', 'B', 'C', 'D', 'E', 'F', 'J', 'L']);
    const r = assignCompositeThirds(COMPOSITE_SLOTS, thirds);
    const groupOf = (slot) => r.get(slot)?.group;
    expect(groupOf('3A/B/C/D/F')).toBe('D');  // 1E vs 3D  (era 'F' no bug)
    expect(groupOf('3C/D/F/G/H')).toBe('F');  // 1I vs 3F  (era 'D' no bug)
    expect(groupOf('3C/E/F/H/I')).toBe('C');  // 1A
    expect(groupOf('3E/H/I/J/K')).toBe('E');  // 1L
    expect(groupOf('3B/E/F/I/J')).toBe('B');  // 1D
    expect(groupOf('3A/E/H/I/J')).toBe('A');  // 1G
    expect(groupOf('3E/F/G/I/J')).toBe('J');  // 1B
    expect(groupOf('3D/E/I/J/L')).toBe('L');  // 1K
  });

  it('resolve sempre os 8/8 e bate slot-a-slot com THIRDS_ALLOCATION (todas as 495 combinações)', () => {
    for (const combo of Object.keys(THIRDS_ALLOCATION)) {
      const groups = combo.split('');
      const r = assignCompositeThirds(COMPOSITE_SLOTS, thirdsFromGroups(groups));
      expect(r.size, `${combo}: não resolveu 8/8`).toBe(8);
      const teams = [...r.values()].map(t => t.team);
      expect(new Set(teams).size, `${combo}: time repetido`).toBe(teams.length);
      for (const { slot } of COMPOSITE_SLOTS) {
        expect(r.get(slot).group, `${combo}: ${slot}`).toBe(THIRDS_ALLOCATION[combo][SLOT_SEED[slot]]);
      }
    }
  });

  it('escolhe os 8 MELHORES 3ºs (corte por classificação) quando há 9+ grupos', () => {
    // 9 grupos com 3º; o pior (último na ordem do caller) deve ficar de fora.
    // Ordem do caller = classificação; passamos A..I, I é o 9º → cai fora.
    const nine = thirdsFromGroups(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    const r = assignCompositeThirds(COMPOSITE_SLOTS, nine);
    expect(r.size).toBe(8);
    const used = new Set([...r.values()].map(t => t.group));
    expect(used.has('I')).toBe(false);  // 9º colocado não entra
    // E bate com a combinação oficial ABCDEFGH.
    for (const { slot } of COMPOSITE_SLOTS) {
      expect(r.get(slot).group).toBe(THIRDS_ALLOCATION['ABCDEFGH'][SLOT_SEED[slot]]);
    }
  });

  it('é determinístico — mesma entrada, mesma saída', () => {
    const t = thirdsFromGroups(['A', 'B', 'C', 'D', 'E', 'F', 'J', 'L']);
    const a = assignCompositeThirds(COMPOSITE_SLOTS, t);
    const b = assignCompositeThirds(COMPOSITE_SLOTS, t);
    expect([...a.entries()].map(([s, x]) => [s, x.team]))
      .toEqual([...b.entries()].map(([s, x]) => [s, x.team]));
  });

  it('estado parcial (< 8 grupos com 3º) → fallback greedy, preenche o máximo sem erro', () => {
    const few = thirdsFromGroups(['A', 'F']);
    const r = assignCompositeThirds(COMPOSITE_SLOTS, few);
    expect(r.size).toBeGreaterThanOrEqual(1);
    expect(r.size).toBeLessThanOrEqual(2);
    for (const t of r.values()) expect(['tA', 'tF']).toContain(t.team);
  });

  it('sem 3ºs → mapa vazio', () => {
    expect(assignCompositeThirds(COMPOSITE_SLOTS, []).size).toBe(0);
  });
});

// ============================================================
// Atribuição dos 3ºs colocados aos slots compostos do mata-mata
// ============================================================
// Na Copa 2026 (48 seleções, 12 grupos), os 8 melhores 3ºs avançam.
// Cada vaga de 32-avos que recebe um 3º aceita só certos grupos
// (ex.: "3E/F/G/I/J" = 3º colocado de E, F, G, I ou J).
//
// REGRA OFICIAL (e ARMADILHA): a atribuição NÃO é "qualquer emparelhamento
// válido". A FIFA publica a Annexe C — uma tabela fixa de 495 combinações
// (C(12,8)=495). Para CADA conjunto de 8 grupos qualificados existe UMA
// atribuição oficial. Para a mesma combinação há vários matchings válidos; só
// um é o oficial. (Bug histórico: backtracking escolhia um matching válido mas
// não-oficial → trocou Suécia/Paraguai entre Alemanha×França nas oitavas 2026.)
//
// FONTE ÚNICA da lógica. A tabela vive em thirds-allocation.js (gerada de
// scripts/data/gen-thirds-allocation.mjs). Espelha:
//   - public.third_place_allocation (supabase/migrations/069_*.sql)
//   - simulateTournament STEP 3 (scripts/e2e/lib/tournament-simulator.js)

import { THIRDS_ALLOCATION } from './thirds-allocation.js';

// Mapa: conjunto de grupos válidos do slot (ordenado, ex.: "ABCDF") -> 1-seed
// daquele jogo nas 32-avos (a coluna na tabela oficial). Os 8 slots compostos
// são fixos no bracket WC2026; cada um pertence ao jogo de um 1-seed distinto.
const SEED_BY_GROUPS = {
  ABCDF: '1E',
  CDFGH: '1I',
  CEFHI: '1A',
  EHIJK: '1L',
  BEFIJ: '1D',
  AEHIJ: '1G',
  EFGIJ: '1B',
  DEIJL: '1K',
};

function slotSeed(validGroups) {
  return SEED_BY_GROUPS[[...validGroups].sort().join('')];
}

/**
 * Atribui 3ºs qualificados aos slots compostos via TABELA OFICIAL (Annexe C).
 *
 * Os parâmetros já vêm ordenados pelo caller (mesma ordem do servidor):
 *   - `slots`        slots compostos do bracket ({ slot, validGroups });
 *   - `thirdsRanked` os 3ºs por classificação (pts → SG → GF → fair play →
 *                    FIFA rank). Essa ordem decide só QUAIS 8 grupos passam
 *                    (o corte) — a atribuição em si vem da tabela, não da ordem.
 *
 * Quando há >= 8 terceiros (corte definido), pega os 8 melhores, monta a chave
 * da combinação (grupos ordenados) e consulta a tabela oficial. Retorna o mesmo
 * bracket que a FIFA, o servidor e o simulador.
 *
 * Fallback greedy: enquanto a usuária ainda preenche (< 8 grupos com 3º, sem
 * combinação definida) não dá pra usar a tabela; aí preenche o máximo possível
 * por elegibilidade para não regredir a UX da previsão.
 *
 * @template {{ group: string, team: string }} T
 * @param {{ slot: string, validGroups: string[] }[]} slots
 * @param {T[]} thirdsRanked
 * @returns {Map<string, T>} slot composto -> objeto do 3º atribuído
 */
export function assignCompositeThirds(slots, thirdsRanked) {
  // Caminho oficial: 8+ terceiros → combinação definida → lookup na Annexe C.
  if (thirdsRanked.length >= 8) {
    const top8 = thirdsRanked.slice(0, 8);
    const combo = top8.map(t => t.group).sort().join('');
    const row = THIRDS_ALLOCATION[combo];
    if (row) {
      const thirdByGroup = new Map(top8.map(t => [t.group, t]));
      const out = new Map();
      let complete = true;
      for (const { slot, validGroups } of slots) {
        const seed = slotSeed(validGroups);
        const group = seed && row[seed];
        const third = group && thirdByGroup.get(group);
        if (third) out.set(slot, third);
        else complete = false;  // slot desconhecido / dado inconsistente
      }
      // Só confia na tabela se resolveu todos os slots pedidos; senão cai no
      // greedy (defensivo — combinação/slot fora do esperado não some calado).
      if (complete) return out;
    }
  }

  // Sem combinação definida (predições incompletas) → greedy best-effort.
  const out = new Map();
  const used = new Set();
  for (const { slot, validGroups } of slots) {
    const c = thirdsRanked.find(t => validGroups.includes(t.group) && !used.has(t.team));
    if (c) { out.set(slot, c); used.add(c.team); }
  }
  return out;
}

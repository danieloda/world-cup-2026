// ============================================================
// Atribuição dos 3ºs colocados aos slots compostos do mata-mata
// ============================================================
// Na Copa 2026 (48 seleções, 12 grupos), os 8 melhores 3ºs avançam.
// Cada vaga de 32-avos que recebe um 3º aceita só certos grupos
// (ex.: "3E/F/G/I/J" = 3º colocado de E, F, G, I ou J). Atribuir os 8
// terceiros às 8 vagas é um emparelhamento (matching): precisa olhar o
// conjunto todo, não escolher vaga a vaga.
//
// FONTE ÚNICA da lógica. Espelha:
//   - public._backtrack_thirds  (supabase/migrations/005_slot_resolution.sql)
//   - simulateTournament STEP 3 (scripts/e2e/lib/tournament-simulator.js)
//
// HISTÓRICO: a página usava um greedy (pega o 1º 3º elegível por vaga, em
// ordem de id). O greedy chega a beco sem saída — uma vaga anterior consome
// o único 3º elegível de uma vaga posterior, que fica vazia. Isso cascateava
// W##/L## até a final e o campeão sumia (bug do M85). Backtracking resolve.

/**
 * Atribui 3ºs qualificados aos slots compostos via BACKTRACKING.
 *
 * Os parâmetros já vêm ordenados pelo caller (mesma ordem do servidor):
 *   - `slots`        por match id crescente (a ordem define o desempate quando
 *                    há mais de um emparelhamento perfeito);
 *   - `thirdsRanked` por classificação dos 3ºs (pts → SG → GF → FIFA rank).
 * Retorna a 1ª atribuição completa encontrada por DFS — a mesma escolha que o
 * servidor e o simulador fazem, garantindo bracket consistente com o placar.
 *
 * Fallback greedy: enquanto a usuária ainda preenche (grupos incompletos) pode
 * não existir emparelhamento perfeito; aí preenche o máximo possível para não
 * regredir a UX (mesma cobertura parcial de antes).
 *
 * @template {{ group: string, team: string }} T
 * @param {{ slot: string, validGroups: string[] }[]} slots
 * @param {T[]} thirdsRanked
 * @returns {Map<string, T>} slot composto -> objeto do 3º atribuído
 */
export function assignCompositeThirds(slots, thirdsRanked) {
  function backtrack(idx, assignment, used) {
    if (idx >= slots.length) return assignment;
    const { slot, validGroups } = slots[idx];
    for (const t of thirdsRanked) {
      if (used.has(t.team)) continue;
      if (!validGroups.includes(t.group)) continue;
      assignment.set(slot, t);
      used.add(t.team);
      const result = backtrack(idx + 1, assignment, used);
      if (result) return result;
      assignment.delete(slot);
      used.delete(t.team);
    }
    return null;  // sem solução nesse branch
  }

  const full = backtrack(0, new Map(), new Set());
  if (full) return full;

  // Sem emparelhamento perfeito (predições ainda incompletas) → greedy best-effort.
  const out = new Map();
  const used = new Set();
  for (const { slot, validGroups } of slots) {
    const c = thirdsRanked.find(t => validGroups.includes(t.group) && !used.has(t.team));
    if (c) { out.set(slot, c); used.add(c.team); }
  }
  return out;
}

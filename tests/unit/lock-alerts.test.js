import { describe, it, expect, vi } from 'vitest';

// lock-alerts.js importa supabase.js, que no frontend (no-build) importa o
// supabase-js via URL https — o loader ESM do vitest não aceita. O núcleo puro
// não usa supabase, então mockamos o módulo p/ poder importar.
vi.mock('../../src/js/supabase.js', () => ({ supabase: {} }));

import { classifyLockAlerts } from '../../src/js/lock-alerts.js';
import { predictionDeadline } from '../../src/js/util.js';

/**
 * Regra de alerta de BLOQUEIO (SSOT — sidebar badge + banner do Início).
 * Badge errado = usuário acha que ainda dá tempo e PERDE o palpite → reclamação.
 * Núcleo puro testado com `now` injetado (determinístico). predictionDeadline é
 * o real (já coberto por deadline-parity), então isto valida o filtro/ordem/urgência.
 */

// now fixo: 15/jun/2026 09:00 BRT (12:00 UTC).
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const mk = (id, matchDate, extra = {}) => ({ match_id: id, match_date: matchDate, stage: 'group', ...extra });

describe('classifyLockAlerts', () => {
  it('classifica urgente (<48h), soon (<1 semana) e exclui distante/vencido', () => {
    const matches = [
      mk(1, '2026-06-16T18:00:00-03:00'),  // trava 15/jun 23:59 BRT → ~15h → URGENTE
      mk(2, '2026-06-18T18:00:00-03:00'),  // trava 17/jun 23:59 BRT → ~63h → soon
      mk(3, '2026-07-01T18:00:00-03:00'),  // trava 30/jun → >1 semana → excluído
      mk(4, '2026-06-10T18:00:00-03:00'),  // trava 9/jun → já passou → excluído
    ];
    const r = classifyLockAlerts(matches, new Set(), NOW);
    expect(r.total).toBe(2);
    expect(r.urgent).toBe(1);
    expect(r.soon).toBe(1);
    expect(r.matches.map(m => m.match_id)).toEqual([1, 2]);  // ordenado pelo prazo
    expect(r.nextDeadline).toBe(predictionDeadline('2026-06-16T18:00:00-03:00').getTime());
  });

  it('exclui jogos já palpitados', () => {
    const matches = [mk(1, '2026-06-16T18:00:00-03:00'), mk(2, '2026-06-18T18:00:00-03:00')];
    const r = classifyLockAlerts(matches, new Set([1]), NOW);
    expect(r.total).toBe(1);
    expect(r.matches.map(m => m.match_id)).toEqual([2]);
  });

  it('entradas vazias/nulas → tudo zero, sem throw', () => {
    for (const arg of [[], null, undefined]) {
      const r = classifyLockAlerts(arg, new Set(), NOW);
      expect(r).toEqual({ urgent: 0, soon: 0, total: 0, matches: [], nextDeadline: null });
    }
  });

  it('cada item carrega deadline e diff coerentes', () => {
    const r = classifyLockAlerts([mk(1, '2026-06-16T18:00:00-03:00')], new Set(), NOW);
    const m = r.matches[0];
    expect(m.deadline).toBe(predictionDeadline('2026-06-16T18:00:00-03:00').getTime());
    expect(m.diff).toBe(m.deadline - NOW);
    expect(m.diff).toBeGreaterThan(0);
  });
});

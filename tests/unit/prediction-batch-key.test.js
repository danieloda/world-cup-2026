import { describe, it, expect } from 'vitest';
import { makeRng } from '../../scripts/e2e/lib/prng.js';
import { predictionBatchKey, predictionDeadline } from '../../src/js/util.js';

/**
 * predictionBatchKey: DIA DE LISTAGEM (lote de bloqueio) de cada partida.
 *
 * Regra: dia-calendário de SP do APITO — exceto jogo à meia-noite (hora 0 BRT,
 * 00:00–00:59), que cai no dia ANTERIOR (lote da véspera, junto com os jogos que
 * travam na MESMA noite). Ex.: 20/jun 00:00 → lote 19/jun; 20/jun 16:00 → 20/jun.
 *
 * NÃO pode duplicar a regra da meia-noite: é DERIVADO de predictionDeadline (que
 * já tem paridade testada com o SQL 023/063). Por isso o invariante central é
 * estrutural — batchKey == dia SEGUINTE ao prazo (o prazo é 23h59 da véspera do
 * lote) — com um oráculo independente (via Intl) por cima. Se a regra da
 * meia-noite mudar no SQL/JS, este teste e o deadline-parity avisam juntos.
 */
const SP = 'America/Sao_Paulo';
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function spParts(iso, opts) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: SP, ...opts }).formatToParts(new Date(iso));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { get };
}

// Oráculo independente: dia-calendário SP do apito, menos 1 dia se hora 0 BRT.
function expectedBatchKey(iso) {
  const { get } = spParts(iso, {
    hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  });
  const y = get('year'), m = get('month'), d = get('day'), h = get('hour');
  if (h !== 0) return keyOf(y, m, d);
  const prev = new Date(Date.UTC(y, m - 1, d));
  prev.setUTCDate(prev.getUTCDate() - 1);  // véspera (com rollover de mês/ano)
  return keyOf(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate());
}

// Dia-calendário SP do PRAZO + 1 dia (cross-check estrutural via predictionDeadline).
function dayAfterDeadline(iso) {
  const { get } = spParts(predictionDeadline(iso).toISOString(), {
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const base = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  base.setUTCDate(base.getUTCDate() + 1);
  return keyOf(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
}

const EDGES = [
  '2026-06-20T00:00:00-03:00',  // meia-noite → lote 19/jun (o caso do Turquia×Paraguai)
  '2026-06-20T16:00:00-03:00',  // normal     → lote 20/jun
  '2026-06-27T00:00:00-03:00',  // meia-noite → lote 26/jun
  '2026-06-23T00:00:00-03:00',  // meia-noite → lote 22/jun
  '2026-07-03T00:00:00-03:00',  // meia-noite (mata) → lote 02/jul
  '2026-06-15T00:30:00-03:00',  // toda a hora 00 desloca → lote 14/jun
  '2026-06-01T00:00:00-03:00',  // rollover de mês → lote 31/mai
  '2026-06-21T01:00:00-03:00',  // 01h → INALTERADO → lote 21/jun
  '2026-06-15T19:00:00-03:00',  // 19h → lote 15/jun
  '2026-06-16T02:00:00Z',       // 23h SP 15/jun (UTC já é 16) → lote 15/jun
];
const START = Date.UTC(2026, 5, 11), END = Date.UTC(2026, 6, 19, 23);
const rng = makeRng('batch-key-v1');
const RANDOM = Array.from({ length: 50 }, () => new Date(START + Math.floor(rng() * (END - START))).toISOString());
const BATTERY = [...EDGES, ...RANDOM];

describe('predictionBatchKey: dia de listagem (lote de bloqueio)', () => {
  it('bate com o oráculo-spec independente (dia SP do apito; −1 dia na meia-noite)', () => {
    const drift = [];
    for (const iso of BATTERY) {
      const got = predictionBatchKey(iso);
      const exp = expectedBatchKey(iso);
      if (got !== exp) drift.push(`${iso}: got=${got} exp=${exp}`);
    }
    expect(drift, `lote diverge da spec:\n${drift.join('\n')}`).toEqual([]);
  });

  it('é sempre o dia SEGUINTE ao prazo (derivado de predictionDeadline)', () => {
    for (const iso of BATTERY) {
      expect(predictionBatchKey(iso), iso).toBe(dayAfterDeadline(iso));
    }
  });

  it('casos citados: 20/jun 00:00 → 19/jun; 20/jun 16:00 → 20/jun', () => {
    expect(predictionBatchKey('2026-06-20T00:00:00-03:00')).toBe('2026-06-19');
    expect(predictionBatchKey('2026-06-20T16:00:00-03:00')).toBe('2026-06-20');
  });
});

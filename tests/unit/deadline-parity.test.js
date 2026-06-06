import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { predictionDeadline } from '../../src/js/util.js';
import { makeRng } from '../../scripts/e2e/lib/prng.js';

/**
 * PARIDADE de PRAZO cliente↔servidor (ponto 2 do hardening).
 *
 * O JS predictionDeadline (usado p/ travar a UI, mostrar "Bloqueia em…") e o SQL
 * public.prediction_deadline() (usado na RLS de INSERT/UPDATE de predictions —
 * migration 023) precisam concordar no INSTANTE exato. Se divergirem, o usuário
 * vê "ainda dá pra palpitar" e o servidor recusa (ou o contrário) → disputa.
 *
 * Regra (023): 23h59 de Brasília (America/Sao_Paulo) do DIA ANTERIOR ao jogo,
 * pelo dia-calendário de SP. Ex.: jogo 15/jun 16h → fecha 14/jun 23h59.
 *
 * Estratégia: (A) oráculo-spec INDEPENDENTE — deriva a data-calendário de SP via
 * Intl (caminho diferente do JS, que usa offset fixo) e exige que o JS bata,
 * inclusive em jogos perto da meia-noite de SP (onde mora o bug). (B) assert
 * ESTRUTURAL no corpo SQL — se a regra do servidor mudar (horário, dia, fuso),
 * o JS deixa de corresponder à spec e o teste avisa.
 *
 * Nota: predictionDeadline só usa getUTC..., Date.UTC e getTime → é TZ-independente
 * por construção (não lê o relógio local). Brasil sem DST desde 2019; jun/jul de
 * 2026 é UTC-3 garantido.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG_023 = join(REPO, 'supabase', 'migrations', '023_prediction_deadline.sql');
const SP_OFFSET_MS = 3 * 3600000;  // UTC-3 (SP em 2026)

// Oráculo independente: 23h59 SP da véspera do dia-calendário SP do jogo.
function expectedDeadline(matchIso) {
  const spDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(matchIso));
  const [y, m, d] = spDate.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d));
  prev.setUTCDate(prev.getUTCDate() - 1);  // véspera (com rollover de mês/ano)
  return new Date(
    Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate(), 23, 59, 0) + SP_OFFSET_MS,
  );
}

// Bateria: bordas de meia-noite SP (onde a data-calendário diverge de UTC) + aleatórios.
const EDGES = [
  '2026-06-15T19:00:00-03:00',  // 19h SP 15/jun → fecha 14/jun
  '2026-06-15T00:30:00-03:00',  // 00h30 SP 15/jun → fecha 14/jun
  '2026-06-16T02:00:00Z',       // 23h SP 15/jun (UTC já é 16!) → fecha 14/jun
  '2026-07-01T00:00:00Z',       // 21h SP 30/jun → fecha 29/jun
  '2026-06-11T23:59:00-03:00',  // exatamente meia-noite-1 SP
];
const START = Date.UTC(2026, 5, 11), END = Date.UTC(2026, 6, 19, 23);
const rng = makeRng('deadline-parity-v1');
const RANDOM = Array.from({ length: 50 }, () => new Date(START + Math.floor(rng() * (END - START))).toISOString());
const BATTERY = [...EDGES, ...RANDOM];

describe('paridade de prazo: predictionDeadline (JS) ↔ regra do SQL (023)', () => {
  it('JS bate com o oráculo-spec independente em toda a bateria', () => {
    const drift = [];
    for (const iso of BATTERY) {
      const js = predictionDeadline(iso).getTime();
      const spec = expectedDeadline(iso).getTime();
      if (js !== spec) {
        drift.push(`${iso}: JS=${new Date(js).toISOString()} spec=${new Date(spec).toISOString()}`);
      }
    }
    expect(drift, `prazo diverge da spec:\n${drift.join('\n')}`).toEqual([]);
  });

  it('o prazo é sempre 23:59 (Brasília) e antes do jogo', () => {
    for (const iso of BATTERY) {
      const dl = predictionDeadline(iso);
      const hhmm = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(dl);
      expect(hhmm, `prazo de ${iso} não é 23:59 SP`).toBe('23:59');
      expect(dl.getTime(), `prazo de ${iso} não é antes do jogo`).toBeLessThan(new Date(iso).getTime());
    }
  });

  it('o SQL ainda codifica a MESMA regra (23h59 · véspera · America/Sao_Paulo)', () => {
    const sql = readFileSync(MIG_023, 'utf8');
    // pega só o corpo da função
    const i = sql.indexOf('create or replace function public.prediction_deadline(');
    const body = sql.slice(sql.indexOf('as $$', i), sql.indexOf('$$;', i));
    expect(body).toMatch(/23 hours 59 minutes/);
    expect(body).toMatch(/interval '1 day'/);
    expect(body).toMatch(/America\/Sao_Paulo/);
    expect(body).toMatch(/date_trunc\('day'/);
  });
});

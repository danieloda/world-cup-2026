import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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
 * Regra (023 + 063): 23h59 de Brasília (America/Sao_Paulo) do DIA ANTERIOR ao
 * jogo, pelo dia-calendário de SP. Ex.: jogo 15/jun 16h → fecha 14/jun 23h59.
 * EXCEÇÃO (063): jogo à meia-noite (hora 0 BRT, 00:00–00:59) trava com o LOTE DO
 * DIA ANTERIOR (véspera da véspera). Ex.: jogo 20/jun 00:00 → fecha 18/jun 23h59.
 *
 * Estratégia: (A) oráculo-spec INDEPENDENTE — deriva data-calendário E hora de SP
 * via Intl (caminho diferente do JS, que usa offset fixo) e exige que o JS bata,
 * inclusive em jogos perto da meia-noite de SP (onde mora o bug). (B) assert
 * ESTRUTURAL no corpo SQL da ÚLTIMA migration que define a função — se a regra do
 * servidor mudar (horário, dia, fuso, exceção da meia-noite), o JS deixa de
 * corresponder à spec e o teste avisa.
 *
 * Nota: predictionDeadline só usa getUTC..., Date.UTC e getTime → é TZ-independente
 * por construção (não lê o relógio local). Brasil sem DST desde 2019; jun/jul de
 * 2026 é UTC-3 garantido.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG_DIR = join(REPO, 'supabase', 'migrations');
const SP_OFFSET_MS = 3 * 3600000;  // UTC-3 (SP em 2026)

// Campos civis de SP via Intl (h23 garante 00–23, não "24" na meia-noite).
function spParts(matchIso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(new Date(matchIso));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') };
}

// Oráculo independente: 23h59 SP da véspera do dia-calendário SP — ou da véspera
// da véspera, se o jogo é à meia-noite (hora 0 BRT, regra 063).
function expectedDeadline(matchIso) {
  const { y, m, d, h } = spParts(matchIso);
  const daysBack = h === 0 ? 2 : 1;
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() - daysBack);  // véspera (com rollover de mês/ano)
  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 23, 59, 0) + SP_OFFSET_MS,
  );
}

// Bateria: bordas de meia-noite SP (onde a data-calendário diverge de UTC) + aleatórios.
const EDGES = [
  '2026-06-15T19:00:00-03:00',  // 19h SP 15/jun → fecha 14/jun (lote normal)
  '2026-06-16T02:00:00Z',       // 23h SP 15/jun (UTC já é 16!) → fecha 14/jun
  '2026-07-01T00:00:00Z',       // 21h SP 30/jun → fecha 29/jun
  '2026-06-11T23:59:00-03:00',  // 23:59 SP → fecha 10/jun (lote normal)
  '2026-06-21T01:00:00-03:00',  // 01h SP → INALTERADO (lacre 00:10 já é antes), fecha 20/jun
  // meia-noite (hora 0 BRT, 00:00–00:59): trava com o LOTE DO DIA ANTERIOR
  '2026-06-20T00:00:00-03:00',  // jogo real → fecha 18/jun 23:59
  '2026-06-27T00:00:00-03:00',  // jogo real → fecha 25/jun 23:59
  '2026-06-15T00:30:00-03:00',  // toda a hora 00 desloca → fecha 13/jun
  '2026-06-01T00:00:00-03:00',  // rollover de mês → fecha 30/mai 23:59
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

  it('o SQL (última migration que define a fn) codifica a regra + exceção da meia-noite', () => {
    // Varre as migrations e pega o corpo da ÚLTIMA que (re)define a função — é
    // ela que vale em prod. Evita validar uma migration estática/velha (023) se
    // a regra mudar numa migration posterior (063+).
    const files = readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    let body = null;
    for (const f of files) {
      const sql = readFileSync(join(MIG_DIR, f), 'utf8');
      const i = sql.indexOf('create or replace function public.prediction_deadline(');
      if (i === -1) continue;
      const start = sql.indexOf('as $$', i);
      const end = sql.indexOf('$$;', start);
      if (start !== -1 && end !== -1) body = sql.slice(start, end);
    }
    expect(body, 'nenhuma migration define public.prediction_deadline').not.toBeNull();
    expect(body).toMatch(/23 hours 59 minutes/);
    expect(body).toMatch(/America\/Sao_Paulo/);
    expect(body).toMatch(/date_trunc\('day'/);
    expect(body).toMatch(/interval '1 day'/);    // lote normal (véspera)
    expect(body).toMatch(/interval '2 days'/);   // meia-noite: lote do dia anterior
    expect(body).toMatch(/extract\(hour/);       // gatilho da exceção (hora 0 BRT)
  });
});

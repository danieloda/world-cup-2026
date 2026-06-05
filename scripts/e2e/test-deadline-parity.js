#!/usr/bin/env node
/**
 * PARIDADE do prazo de palpite: frontend (js/util.js) ↔ banco (SQL prediction_deadline()).
 *
 * Por que existe: o prazo do palpite é calculado em DOIS lugares que precisam concordar
 * ao MINUTO, ou a UI mostra "aberto" e o DB rejeita (ou vice-versa) na virada do prazo:
 *   - FRONT: js/util.js  → predictionDeadline()  (fuso BRT manual via offset)
 *   - DB:    migration 023 → public.prediction_deadline()  (at time zone 'America/Sao_Paulo')
 * O unit test (tests/unit/util.test.js) prova o FRONT contra valores fixos; o
 * test-deadline-boundary.js prova UM valor no DB. NENHUM alimenta o MESMO conjunto de
 * datas nas duas implementações e compara. É o que este teste faz.
 *
 * Cobre também:
 *   - "1 dia antes da copa": predictionDeadline(abertura) == deadline canônico do campeão
 *     (fallback de cs_deadline(), migration 017 = 2026-06-11 02:59:00+00).
 *   - Todos os match_date REAIS do DB local, alimentados nas duas implementações.
 *
 * Read-only (não escreve nada). Uso: source .env.e2e.local && node scripts/e2e/test-deadline-parity.js
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { makeAdminClient } from './lib/admin-client.js';
import { predictionDeadline } from '../../src/js/util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const C = { r: '\x1b[31m', g: '\x1b[32m', b: '\x1b[34m', d: '\x1b[2m', x: '\x1b[0m', bold: '\x1b[1m' };
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`   ${pass ? C.g + '✓' : C.r + '✗'} ${name}${detail ? C.d + ' — ' + detail : ''}${C.x}`);
};

// Deadline canônico campeão/artilheiro = "1 dia antes da copa" (migration 017 fallback).
const OPENER_KICKOFF = '2026-06-11T19:00:00Z'; // abertura WC2026 (tarde no BRT)
const CHAMPION_DEADLINE_CANON = '2026-06-11T02:59:00.000Z'; // = véspera 23h59 BRT

// Matriz de datas-borda (match_date em UTC). O teste NÃO hardcoda o resultado: compara
// as DUAS implementações entre si. Cada uma estressa um aspecto do cálculo de fuso.
const EDGE_DATES = [
  '2026-06-11T19:00:00Z', // abertura, tarde BRT
  '2026-06-15T19:00:00Z', // âncora conhecida do test-deadline-boundary (→ 15/jun 02:59Z)
  '2026-06-12T01:00:00Z', // apito UTC vira o dia, mas BRT ainda é 11/jun 22h
  '2026-06-15T02:00:00Z', // apito UTC madrugada, BRT é véspera 23h → testa offset
  '2026-07-01T00:30:00Z', // virada de mês (BRT = 30/jun 21:30)
  '2027-01-01T02:00:00Z', // virada de ano (BRT = 31/dez 23h)
  '2026-03-01T12:00:00Z', // 1º de março (sem horário de verão no BR desde 2019)
];

async function main() {
  console.log(`${C.b}${C.bold}🕒 Paridade do prazo de palpite: frontend ↔ banco${C.x}`);
  const admin = makeAdminClient();

  // ── helper: chama o SQL e devolve ISO normalizado ─────────────────────────
  const dbDeadline = async (matchDate) => {
    const { data, error } = await admin.rpc('prediction_deadline', { p_match_date: matchDate });
    if (error) throw new Error(`rpc prediction_deadline(${matchDate}): ${error.message}`);
    return new Date(data).toISOString();
  };

  // ── 1) "1 dia antes da copa": fórmula bate com o deadline canônico do campeão ──
  console.log(`\n${C.b}1) "1 dia antes da copa" (campeão/artilheiro)${C.x}`);
  {
    const feOpener = predictionDeadline(OPENER_KICKOFF).toISOString();
    check('FE: predictionDeadline(abertura) == deadline canônico (véspera 23h59 BRT)',
      feOpener === CHAMPION_DEADLINE_CANON, `fe=${feOpener} canon=${CHAMPION_DEADLINE_CANON}`);
    const dbOpener = await dbDeadline(OPENER_KICKOFF);
    check('DB: prediction_deadline(abertura) == deadline canônico',
      dbOpener === CHAMPION_DEADLINE_CANON, `db=${dbOpener} canon=${CHAMPION_DEADLINE_CANON}`);
  }

  // ── 2) Paridade FE↔DB nas datas-borda ─────────────────────────────────────
  console.log(`\n${C.b}2) Paridade FE↔DB nas datas-borda${C.x}`);
  for (const md of EDGE_DATES) {
    const fe = predictionDeadline(md).toISOString();
    const db = await dbDeadline(md);
    check(`${md}  →  ${fe}`, fe === db, fe === db ? '' : `fe=${fe} db=${db}`);
  }

  // ── 3) Paridade FE↔DB em TODOS os match_date reais do DB ──────────────────
  console.log(`\n${C.b}3) Paridade FE↔DB em todos os match_date do DB${C.x}`);
  {
    const { data: matches, error } = await admin.from('matches').select('id, match_date').order('id');
    if (error) throw new Error(`load matches: ${error.message}`);
    let mismatches = 0;
    let firstBad = '';
    for (const m of matches) {
      const fe = predictionDeadline(m.match_date).toISOString();
      const db = await dbDeadline(m.match_date);
      if (fe !== db) {
        mismatches++;
        if (!firstBad) firstBad = `m#${m.id} ${m.match_date}: fe=${fe} db=${db}`;
      }
    }
    check(`${matches.length} jogos: FE e DB concordam ao minuto`, mismatches === 0,
      mismatches === 0 ? `${matches.length}/${matches.length} ok` : `${mismatches} divergem — ${firstBad}`);
  }

  // ── resumo ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${C.b}${C.bold}Resumo: ${results.length - failed.length}/${results.length} OK${C.x}`);
  if (failed.length) {
    console.log(`${C.r}FALHAS: ${failed.map((f) => f.name).join('; ')}${C.x}`);
    process.exit(1);
  }
  console.log(`${C.g}${C.bold}🎉 Frontend e banco calculam o MESMO prazo ao minuto.${C.x}`);
  process.exit(0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

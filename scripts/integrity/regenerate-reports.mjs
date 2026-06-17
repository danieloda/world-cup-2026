#!/usr/bin/env node
/**
 * Re-gera os relatórios LEGÍVEIS (integrity/reports/NNNN_*.md) a partir dos
 * snapshots JÁ LACRADOS, sem tocar em snapshots/ nem manifest.json (que são a
 * prova e NÃO podem mudar). Usado uma vez (2026-06-17) para:
 *   1) corrigir o falso positivo "gravado APÓS o prazo" (carimbo de scoring em
 *      jogos pontuados — ver migration 066 e a errata); e
 *   2) passar a mostrar o LEDGER completo (palpites de todos os jogos travados),
 *      não só os jogos novos de cada lacre.
 *
 * O relatório é DERIVADO e não entra no hash — re-gerá-lo não afeta `verify`.
 * Cada relatório re-gerado ganha um aviso explicando a re-geração.
 *
 * READ-ONLY no banco (só lê matches/settings p/ nomes e prazos). Usage:
 *   node scripts/integrity/regenerate-reports.mjs
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (.env aponta pra prod).
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { buildReport, brtDateStamp } from './report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const INTEGRITY_DIR = join(__dirname, '..', '..', 'integrity');
const MANIFEST = join(INTEGRITY_DIR, 'manifest.json');
const REPORT_DIR = join(INTEGRITY_DIR, 'reports');
const REPO_URL = 'https://github.com/danieloda/world-cup-2026';
const BRANCH = 'main';
const ERRATA = `${REPO_URL}/blob/${BRANCH}/integrity/reports/ERRATA_2026-06-17_falso-positivo-prazo.md`;
const FROM_SEQ = 6; // primeiros relatórios .md começam no lacre #6

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// IGUAL a scripts/integrity/snapshot.js (migrations 023+063).
const BRT_OFFSET_MS = 3 * 3600000;
function predictionDeadline(matchDate) {
  const brt = new Date(new Date(matchDate).getTime() - BRT_OFFSET_MS);
  const daysBack = brt.getUTCHours() === 0 ? 2 : 1;
  const wall = Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate() - daysBack, 23, 59, 0);
  return new Date(wall + BRT_OFFSET_MS);
}
function parseCsDeadline(raw) {
  if (raw == null) return null;
  const d = new Date(String(raw).replace(/^"|"$/g, ''));
  return isNaN(d.getTime()) ? null : d;
}

function regeneratedNoteFor(content) {
  const hasFinished = (content.results ?? []).length > 0;
  return '> 🔄 **Relatório re-gerado em 17/06/2026.** Agora inclui o **ledger completo** '
    + '(palpites de todos os jogos travados até este lacre), não só os jogos novos do lacre.'
    + (hasFinished
      ? ` A **auditoria de prazo foi corrigida**: os avisos anteriores de "gravado APÓS o `
        + 'prazo" eram **falso positivo** do carimbo de pontuação (escrita de pontos pelo '
        + 'sistema após o jogo, corrigida na migration 066) — **nenhum palpite foi alterado**. '
        + `Detalhes e prova na [errata](${ERRATA}).`
      : '')
    + ' O **arquivo lacrado e a corrente de hashes NÃO mudaram** — este texto é derivado dos '
    + 'dados lacrados e não entra no hash.';
}

async function main() {
  const { data: matches, error } = await admin
    .from('matches')
    .select('id, stage, match_date, team_home, team_away, actual_home, actual_away, pen_winner, finished, status')
    .order('id');
  if (error) throw new Error(error.message);

  const { data: csRow } = await admin.from('settings').select('value').eq('key', 'deadline_champion_scorer').maybeSingle();
  const csDeadline = parseCsDeadline(csRow?.value);

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const bySeq = new Map(manifest.entries.map((e) => [e.seq, e]));
  let n = 0;

  for (const entry of manifest.entries) {
    if (entry.seq < FROM_SEQ) continue;
    const content = JSON.parse(readFileSync(join(INTEGRITY_DIR, entry.file), 'utf8'));
    const prevEntry = bySeq.get(entry.seq - 1);
    let prevContent = null;
    if (prevEntry) {
      try { prevContent = JSON.parse(readFileSync(join(INTEGRITY_DIR, prevEntry.file), 'utf8')); } catch { /* sem prev */ }
    }
    const fname = `${String(entry.seq).padStart(4, '0')}_${brtDateStamp(entry.taken_at)}.md`;
    writeFileSync(join(REPORT_DIR, fname), buildReport({
      entry, content, matches, prevContent, csDeadline, predictionDeadline,
      repoUrl: REPO_URL, branch: BRANCH, regeneratedNote: regeneratedNoteFor(content),
    }));
    n++;
    console.log(`re-gerado: integrity/reports/${fname}  (lacre #${entry.seq})`);
  }
  console.log(`\n✅ ${n} relatório(s) re-gerado(s). snapshots/ e manifest.json intactos.`);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });

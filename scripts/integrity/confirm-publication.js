#!/usr/bin/env node
/**
 * Confirma a PUBLICAÇÃO do lacre no GitHub e a registra no banco — é esse
 * registro (public.integrity_publications) que revela os palpites no app
 * ANTES do apito inicial (migration 060). Sem registro, o app fica no
 * fallback: palpites alheios só aparecem quando o jogo começa.
 *
 * Roda como passo da Action (integrity-snapshot.yml) DEPOIS do commit/push:
 *   1. lê integrity/manifest.json (última entrada = lacre corrente);
 *   2. baixa o report correspondente do GitHub RAW com retry (o raw pode
 *      demorar alguns segundos após o push) e exige HTTP 200 + o chain_hash
 *      do manifest presente no corpo — prova de que é ESTE lacre, não um
 *      arquivo velho em cache;
 *   3. upsert em integrity_publications (service_role) com os
 *      locked_match_ids lidos do próprio snapshot lacrado.
 *
 * Snapshot dedupado (sem entrada nova) → upsert idempotente do lacre corrente.
 * Lacre sem jogo travado → nada a revelar, não registra, exit 0.
 * Confirmação falhou → exit 1 (passo vermelho na Action; o app segue seguro
 * no fallback do apito — ninguém vê nada antes da hora).
 *
 * KEEP IN SYNC: supabase/migrations/060_reveal_after_publication.sql,
 * .github/workflows/integrity-snapshot.yml, scripts/integrity/snapshot.js.
 *
 * Usage: node scripts/integrity/confirm-publication.js
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const INTEGRITY_DIR = join(__dirname, '..', '..', 'integrity');
const REPORT_DIR = join(INTEGRITY_DIR, 'reports');
const MANIFEST = join(INTEGRITY_DIR, 'manifest.json');

// Mesmo fallback de repositório/branch do snapshot.js (runs manuais fora da Action).
const REPO = process.env.GITHUB_REPOSITORY || 'danieloda/world-cup-2026';
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

// Raw do GitHub pode levar alguns segundos pra refletir o push — tenta por ~2 min.
const RETRIES = 12;
const RETRY_MS = 10_000;

function fail(msg) { console.error('ERRO:', msg); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SUPABASE_URL) fail('SUPABASE_URL ausente em .env/secrets');
if (!SERVICE_KEY) fail('SUPABASE_SERVICE_ROLE_KEY ausente em .env/secrets');

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  if (!existsSync(MANIFEST)) fail('integrity/manifest.json não existe — rode o snapshot antes.');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const entry = manifest.entries[manifest.entries.length - 1];
  if (!entry) fail('manifest sem entradas — nada a confirmar.');

  // locked_match_ids vêm do PRÓPRIO snapshot lacrado (não recalcula do banco:
  // o registro tem que espelhar exatamente o que o report publicou).
  const snapshot = JSON.parse(readFileSync(join(INTEGRITY_DIR, entry.file), 'utf8'));
  const lockedIds = snapshot.locked_match_ids ?? [];
  if (lockedIds.length === 0) {
    console.log(`Lacre #${entry.seq} não tem jogo travado — nada a revelar, nada a registrar.`);
    return;
  }

  // Report do lacre corrente: NNNN_*.md (gerado pelo snapshot.js no mesmo run).
  const prefix = `${String(entry.seq).padStart(4, '0')}_`;
  const reportFname = existsSync(REPORT_DIR)
    ? readdirSync(REPORT_DIR).find((f) => f.startsWith(prefix) && f.endsWith('.md'))
    : null;
  if (!reportFname) fail(`report do lacre #${entry.seq} (reports/${prefix}*.md) não encontrado localmente.`);
  const reportPath = `reports/${reportFname}`;

  // Idempotência: lacre já registrado (re-run da Action, snapshot dedupado) → no-op.
  const { data: existing, error: exErr } = await admin
    .from('integrity_publications').select('seq, chain_hash').eq('seq', entry.seq).maybeSingle();
  if (exErr) fail(`lendo integrity_publications: ${exErr.message} (migration 060 aplicada?)`);
  if (existing) {
    if (existing.chain_hash !== entry.chain_hash) {
      fail(`lacre #${entry.seq} registrado com chain_hash DIFERENTE — manifest reescrito? Investigue antes de continuar.`);
    }
    console.log(`Lacre #${entry.seq} já registrado como publicado. Nada a fazer.`);
    return;
  }

  // Confirmação de existência no GitHub: 200 + chain_hash deste lacre no corpo.
  const url = `${RAW_BASE}/integrity/${reportPath}`;
  let confirmed = false;
  for (let i = 1; i <= RETRIES; i++) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const body = await res.text();
        if (body.includes(entry.chain_hash)) { confirmed = true; break; }
        console.log(`   tentativa ${i}/${RETRIES}: report no ar mas sem o chain_hash deste lacre (cache?).`);
      } else {
        console.log(`   tentativa ${i}/${RETRIES}: HTTP ${res.status}.`);
      }
    } catch (e) {
      console.log(`   tentativa ${i}/${RETRIES}: ${e.message}`);
    }
    if (i < RETRIES) await sleep(RETRY_MS);
  }
  if (!confirmed) fail(`report não confirmado no GitHub após ${RETRIES} tentativas: ${url}`);

  const { error: insErr } = await admin.from('integrity_publications').insert({
    seq: entry.seq,
    report_file: reportPath,
    chain_hash: entry.chain_hash,
    locked_match_ids: lockedIds,
  });
  if (insErr) fail(`registrando publicação: ${insErr.message}`);

  console.log(`✅ Lacre #${entry.seq} confirmado no GitHub e registrado.`);
  console.log(`   ${lockedIds.length} jogo(s) revelado(s) no app: [${lockedIds.join(', ')}]`);
  console.log(`   report: ${url}`);
}

main().catch((e) => fail(e.message));

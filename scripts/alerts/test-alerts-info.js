#!/usr/bin/env node
// Smoke test pra alertas INFO da migration 019.
// Dispara cada categoria via send_alert direto (simulação) e roda os crons
// manualmente pra ver que retornam algo. Não testa triggers reais — esses
// disparam naturalmente quando o app é usado.
//
// Uso: node scripts/test-alerts-info.js
//      node scripts/test-alerts-info.js --only=digest
//      node scripts/test-alerts-info.js --dry-run

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const DRY_RUN = args['dry-run'] === true;
const ONLY = args.only || null;

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const supabase = createClient(SUPABASE_URL, ANON_KEY);

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m' };
const log = (lvl, msg) => console.log(`${({ ok: C.green, fail: C.red, warn: C.yellow, info: C.blue })[lvl] || ''}${msg}${C.reset}`);

async function login() {
  log('info', '\n🔐 Logando como admin...');
  const { error } = await supabase.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (error) throw new Error('Login falhou: ' + error.message);
  log('ok', `   ✓ Logado como ${ADMIN_EMAIL}`);
}

async function testSignupSuccess() {
  log('info', '\n📤 [1] signup_success (simulado)...');
  if (DRY_RUN) { log('warn', '   DRY-RUN'); return true; }
  const { error } = await supabase.rpc('send_alert', {
    p_severity: 'info',
    p_category: 'signup_success',
    p_title: 'TESTE: Nova conta: Fulano da Silva',
    p_body: 'Fulano da Silva (fulano@example.com) acabou de criar conta. Total: 42.',
    p_context: { full_name: 'Fulano da Silva', email: 'fulano@example.com', total_users: 42, simulated: true },
    p_dedup_seconds: 0,
  });
  if (error) { log('fail', `   ✗ ${error.message}`); return false; }
  log('ok', '   ✓ Enviado'); return true;
}

async function testSignupFailure() {
  log('info', '\n📤 [2] signup_failure (via RPC report_signup_failure)...');
  if (DRY_RUN) { log('warn', '   DRY-RUN'); return true; }
  // Logout pra testar como anon (que é como o client real chama)
  await supabase.auth.signOut();
  const { error } = await supabase.rpc('report_signup_failure', {
    p_email: 'teste-falha@example.com',
    p_reason: 'TESTE: Email já cadastrado',
  });
  if (error) { log('fail', `   ✗ ${error.message}`); await login(); return false; }
  log('ok', '   ✓ Enviado como anon');
  await login();
  return true;
}

async function testChampionChange() {
  log('info', '\n📤 [3] champion_changed (simulado)...');
  if (DRY_RUN) { log('warn', '   DRY-RUN'); return true; }
  const { error } = await supabase.rpc('send_alert', {
    p_severity: 'info',
    p_category: 'champion_changed',
    p_title: 'TESTE: Maria trocou campeão: Argentina → Brasil',
    p_body: 'Maria trocou a aposta de campeão de Argentina para Brasil.',
    p_context: { full_name: 'Maria', team_old: 'Argentina', team_new: 'Brasil', op: 'UPDATE', simulated: true },
    p_dedup_seconds: 0,
  });
  if (error) { log('fail', `   ✗ ${error.message}`); return false; }
  log('ok', '   ✓ Enviado'); return true;
}

async function testScorerChange() {
  log('info', '\n📤 [4] artilheiro_changed (simulado)...');
  if (DRY_RUN) { log('warn', '   DRY-RUN'); return true; }
  const { error } = await supabase.rpc('send_alert', {
    p_severity: 'info',
    p_category: 'artilheiro_changed',
    p_title: 'TESTE: João definiu artilheiro: Mbappé (France)',
    p_body: 'João acabou de escolher Mbappé (France) como artilheiro.',
    p_context: { full_name: 'João', player_id_new: 1, op: 'INSERT', simulated: true },
    p_dedup_seconds: 0,
  });
  if (error) { log('fail', `   ✗ ${error.message}`); return false; }
  log('ok', '   ✓ Enviado'); return true;
}

async function testPicksComplete() {
  log('info', '\n📤 [5] picks_complete (simulado)...');
  if (DRY_RUN) { log('warn', '   DRY-RUN'); return true; }
  const { error } = await supabase.rpc('send_alert', {
    p_severity: 'info',
    p_category: 'picks_complete',
    p_title: 'TESTE: 🎯 Pedro completou todos os palpites de grupo!',
    p_body: 'Pedro acabou de fechar 48/48 palpites da fase de grupos.',
    p_context: { full_name: 'Pedro', milestone: '48_group', simulated: true },
    p_dedup_seconds: 0,
  });
  if (error) { log('fail', `   ✗ ${error.message}`); return false; }
  log('ok', '   ✓ Enviado'); return true;
}

// NOTA: cron_alert_pick_activity e cron_alert_daily_digest foram REMOVIDOS na
// migration 026 (revamp). Os alertas diários agora vivem em scripts/test-alerts-daily.js.

async function main() {
  log('info', `${C.bold}🧪 Teste dos alertas INFO (migration 019)${C.reset}`);
  if (DRY_RUN) log('warn', '   MODO DRY-RUN');
  if (ONLY) log('info', `   Filtro: --only=${ONLY}`);

  await login();

  const tests = [
    { name: 'signup_success', fn: testSignupSuccess },
    { name: 'signup_failure', fn: testSignupFailure },
    { name: 'champion', fn: testChampionChange },
    { name: 'scorer', fn: testScorerChange },
    { name: 'complete', fn: testPicksComplete },
  ];

  const results = {};
  for (const t of tests) {
    if (ONLY && t.name !== ONLY) continue;
    try {
      results[t.name] = await t.fn();
    } catch (e) {
      log('fail', `   ✗ Erro: ${e.message}`);
      results[t.name] = false;
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  console.log('');
  log('info', `${C.bold}═══ Resumo ═══${C.reset}`);
  for (const [name, ok] of Object.entries(results)) {
    console.log(`   ${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${name}`);
  }
  const allOk = Object.values(results).every((v) => v);
  console.log('');
  if (allOk) log('ok', '✅ TODOS PASSARAM. Confere no Telegram.');
  else { log('fail', '⚠️  ALGUMAS FALHARAM.'); process.exit(1); }
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });

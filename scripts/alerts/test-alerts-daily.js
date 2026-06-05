#!/usr/bin/env node
// Dispara os alertas DIÁRIOS da migration 026 (revamp) de verdade, pra você
// conferir o visual no Telegram. Roda as funções cron_* via RPC como admin.
//
// Uso: node scripts/test-alerts-daily.js
//      node scripts/test-alerts-daily.js --only=payments
//      node scripts/test-alerts-daily.js --dry-run
//
// only: payments | group | cs | countdown | lock | recap | heartbeat | signup

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

// Cada teste roda a função cron real (que dispara o alerta de verdade).
const RPCS = {
  payments:  { name: 'cron_alert_daily_payments',     desc: '💰 Pagamentos' },
  group:     { name: 'cron_alert_group_completeness', desc: '⏰ Lembrete jogos travando (🚨 hoje / ⚠️ amanhã; só se há pendentes)' },
  cs:        { name: 'cron_alert_cs_completeness',     desc: '🏆 Campeão & Artilheiro' },
  countdown: { name: 'cron_alert_deadline_countdown',  desc: '⏳ Contagem regressiva (só ≤3 dias do prazo)' },
  lock:      { name: 'cron_alert_lock_tonight',        desc: '🌙 Trava de hoje (só se há jogos)' },
  recap:     { name: 'cron_alert_daily_recap',         desc: '📊 Recap (só se houve jogo nas 24h)' },
  heartbeat: { name: 'cron_heartbeat',                 desc: '❤️ Heartbeat (só se um cron parou)' },
};

async function runRpc(key) {
  const { name, desc } = RPCS[key];
  log('info', `\n📤 [${key}] ${desc} → ${name}()...`);
  if (DRY_RUN) { log('warn', '   DRY-RUN'); return true; }
  const { error } = await supabase.rpc(name);
  if (error) { log('fail', `   ✗ ${error.message}`); return false; }
  log('ok', '   ✓ Disparado (confere no Telegram)');
  return true;
}

async function main() {
  log('info', `${C.bold}🧪 Teste dos alertas DIÁRIOS (migration 026)${C.reset}`);
  if (DRY_RUN) log('warn', '   MODO DRY-RUN');
  if (ONLY) log('info', `   Filtro: --only=${ONLY}`);

  await login();

  const keys = ONLY ? [ONLY] : Object.keys(RPCS);
  const results = {};
  for (const k of keys) {
    if (!RPCS[k]) { log('fail', `   ✗ alerta desconhecido: ${k}`); results[k] = false; continue; }
    try {
      results[k] = await runRpc(k);
    } catch (e) {
      log('fail', `   ✗ Erro: ${e.message}`);
      results[k] = false;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('');
  log('info', `${C.bold}═══ Resumo ═══${C.reset}`);
  for (const [name, ok] of Object.entries(results)) {
    console.log(`   ${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${name}`);
  }
  const allOk = Object.values(results).every((v) => v);
  console.log('');
  if (allOk) log('ok', '✅ Todos dispararam. Lembre: countdown/lock/recap/heartbeat só mandam mensagem se a condição bater.');
  else { log('fail', '⚠️  Algumas falharam.'); process.exit(1); }
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });

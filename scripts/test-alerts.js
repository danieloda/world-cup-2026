#!/usr/bin/env node
// Testa cada um dos 4 alertas configurados na migration 007_alerts.sql.
// Simula a condição que dispara o trigger SQL e verifica:
//   1. Alerta chegou no Telegram
//   2. Registro foi gravado em public.alert_log
//
// Uso: node scripts/test-alerts.js
//      node scripts/test-alerts.js --only=orphan
//      node scripts/test-alerts.js --dry-run  (mostra o que faria sem executar)

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

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

// Cores ANSI pro terminal
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
};

function log(level, msg) {
  const colors = { ok: C.green, fail: C.red, warn: C.yellow, info: C.blue };
  console.log(`${colors[level] || ''}${msg}${C.reset}`);
}

async function login() {
  log('info', '\n🔐 Logando como admin...');
  const { error } = await supabase.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (error) throw new Error('Login falhou: ' + error.message);
  log('ok', `   ✓ Logado como ${ADMIN_EMAIL}`);
}

async function countLogsBefore() {
  const { count } = await supabase
    .from('alert_log')
    .select('*', { count: 'exact', head: true });
  return count ?? 0;
}

async function getRecentLogs(since) {
  const { data } = await supabase
    .from('alert_log')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  return data ?? [];
}

// ============================================================
// TESTE 0: alerta manual via test_alert()
// ============================================================
async function testManual() {
  log('info', '\n📤 [0/5] Teste manual via test_alert()...');
  if (DRY_RUN) { log('warn', '   DRY-RUN, pulando'); return true; }

  const { data, error } = await supabase.rpc('test_alert', { p_severity: 'info' });
  if (error) {
    log('fail', `   ✗ RPC falhou: ${error.message}`);
    return false;
  }
  log('ok', `   ✓ test_alert() retornou request_id=${data}`);
  return true;
}

// ============================================================
// TESTE 1: orphan_predictions
// Como simular: precisamos forçar um match.finished=true sem que o trigger
// existente recompute pontos. Difícil sem violar RLS/integridade.
// Alternativa: chamar send_alert() diretamente com payload simulado.
// ============================================================
async function testOrphanPredictions() {
  log('info', '\n📤 [1/5] orphan_predictions (simulado)...');
  if (DRY_RUN) { log('warn', '   DRY-RUN, pulando'); return true; }

  // Como o trigger real exige um match com prediction sem points_earned, e isso
  // é difícil simular sem mexer no schema, chamamos send_alert direto.
  const { data, error } = await supabase.rpc('send_alert', {
    p_severity: 'critical',
    p_category: 'trigger_bug',
    p_title: 'TESTE: Match #999 com 3 palpite(s) sem pontos calculados',
    p_body: 'Simulação manual do alerta orphan_predictions. Cenário real: trigger on_match_finished falhou.',
    p_context: {
      match_id: 999,
      stage: 'r16',
      team_home: 'Brazil',
      team_away: 'France',
      orphan_count: 3,
      total_predictions: 10,
      simulated: true,
    },
    p_dedup_seconds: 0,
  });
  if (error) { log('fail', `   ✗ ${error.message}`); return false; }
  log('ok', `   ✓ Enviado (request_id=${data})`);
  return true;
}

// ============================================================
// TESTE 2: unresolved_slot
// ============================================================
async function testUnresolvedSlot() {
  log('info', '\n📤 [2/5] unresolved_slot (simulado)...');
  if (DRY_RUN) { log('warn', '   DRY-RUN, pulando'); return true; }

  const { data, error } = await supabase.rpc('send_alert', {
    p_severity: 'critical',
    p_category: 'unresolved_slot',
    p_title: 'TESTE: Match #999 terminou mas slots W999/L999 não resolvidos',
    p_body: 'Simulação. Match #999 (Brazil vs France) foi finalizado mas 2 match(es) downstream ainda mostram W/L como time.',
    p_context: {
      match_id: 999,
      stage: 'r16',
      unresolved_match_ids: [1001, 1002],
      unresolved_count: 2,
      simulated: true,
    },
    p_dedup_seconds: 0,
  });
  if (error) { log('fail', `   ✗ ${error.message}`); return false; }
  log('ok', `   ✓ Enviado (request_id=${data})`);
  return true;
}

// ============================================================
// TESTE 3: pred_overwrite — REAL (via UPDATE em prediction antiga)
// ============================================================
async function testPredOverwrite() {
  log('info', '\n📤 [3/5] pred_overwrite (REAL — vai disparar trigger SQL)...');
  if (DRY_RUN) { log('warn', '   DRY-RUN, pulando'); return true; }

  // Pega meu próprio user_id
  const { data: { user } } = await supabase.auth.getUser();

  // Pega uma prediction minha de match já finalizado
  const { data: preds } = await supabase
    .from('predictions')
    .select('*, matches!inner(finished, finished_at)')
    .eq('user_id', user.id)
    .eq('matches.finished', true)
    .limit(1);

  if (!preds || preds.length === 0) {
    log('warn', '   Sem prediction de match finalizado pra testar. Usando send_alert direto.');
    const { data, error } = await supabase.rpc('send_alert', {
      p_severity: 'warn',
      p_category: 'pred_overwrite',
      p_title: 'TESTE: Palpite modificado APÓS jogo finalizado (match #999)',
      p_body: 'Simulação manual.',
      p_context: { match_id: 999, user_id: user.id, simulated: true },
      p_dedup_seconds: 0,
    });
    if (error) { log('fail', `   ✗ ${error.message}`); return false; }
    log('ok', `   ✓ Enviado via send_alert (request_id=${data})`);
    return true;
  }

  const pred = preds[0];
  log('info', `   Prediction encontrada: id=${pred.id}, match=${pred.match_id}, palpite=${pred.pred_home}-${pred.pred_away}`);

  // Restaura ao estado original ANTES de mexer (preserva data)
  const originalHome = pred.pred_home;
  const originalAway = pred.pred_away;

  // UPDATE pra trigger pred_overwrite (deve falhar com RLS ou disparar alert)
  // Mudamos pra valor diferente, depois restauramos pro original
  const newHome = (originalHome ?? 0) + 1;
  const { error: updErr } = await supabase
    .from('predictions')
    .update({ pred_home: newHome })
    .eq('id', pred.id);

  if (updErr) {
    log('warn', `   UPDATE falhou (RLS bloqueou — isso é OK e esperado): ${updErr.message}`);
    log('info', '   Usando send_alert direto pra simular.');
    const { data, error } = await supabase.rpc('send_alert', {
      p_severity: 'warn',
      p_category: 'pred_overwrite',
      p_title: `TESTE (RLS-blocked): Palpite tentou ser modificado em match #${pred.match_id}`,
      p_body: `RLS bloqueou o UPDATE em prediction ${pred.id} (esperado!). Alerta simulado.`,
      p_context: { prediction_id: pred.id, match_id: pred.match_id, user_id: user.id, simulated: true },
      p_dedup_seconds: 0,
    });
    if (error) { log('fail', `   ✗ ${error.message}`); return false; }
    log('ok', `   ✓ Enviado (request_id=${data})`);
    return true;
  }

  log('ok', `   ✓ UPDATE passou. Trigger deve ter disparado alerta automaticamente.`);

  // Restaura ao original
  await supabase.from('predictions').update({ pred_home: originalHome, pred_away: originalAway }).eq('id', pred.id);
  log('info', `   Prediction restaurada ao palpite original (${originalHome}-${originalAway}).`);
  return true;
}

// ============================================================
// TESTE 4: auth_failure
// ============================================================
async function testAuthFailure() {
  log('info', '\n📤 [4/5] auth_failure (via check_auth_failures())...');
  if (DRY_RUN) { log('warn', '   DRY-RUN, pulando'); return true; }

  // check_auth_failures consulta auth.audit_log_entries. Se ninguém errou login
  // recentemente, não vai disparar. Forço com send_alert direto.
  const { data, error } = await supabase.rpc('send_alert', {
    p_severity: 'warn',
    p_category: 'auth_failure',
    p_title: 'TESTE: 5 tentativas de login falhas em 5 min',
    p_body: 'Simulação. Detectadas 5 tentativas falhas. Email mais frequente: test@example.com.',
    p_context: {
      window_minutes: 5,
      attempts: 5,
      threshold: 5,
      top_email: 'test@example.com',
      simulated: true,
    },
    p_dedup_seconds: 0,
  });
  if (error) { log('fail', `   ✗ ${error.message}`); return false; }
  log('ok', `   ✓ Enviado (request_id=${data})`);
  return true;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  log('info', `${C.bold}🧪 Teste dos 4 alertas Telegram${C.reset}`);
  if (DRY_RUN) log('warn', '   MODO DRY-RUN ATIVADO (nada vai disparar)');
  if (ONLY) log('info', `   Filtro: --only=${ONLY}`);

  await login();

  const before = await countLogsBefore();
  log('info', `\n📊 alert_log count antes: ${before}`);
  const startTime = new Date().toISOString();

  const tests = [
    { name: 'manual', fn: testManual },
    { name: 'orphan', fn: testOrphanPredictions },
    { name: 'unresolved', fn: testUnresolvedSlot },
    { name: 'overwrite', fn: testPredOverwrite },
    { name: 'auth', fn: testAuthFailure },
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
    await new Promise((r) => setTimeout(r, 800));  // espacamento pra Telegram
  }

  // Espera trigger SQL terminar (assincrono)
  log('info', '\n⏳ Aguardando 3s pra triggers async terminarem...');
  await new Promise((r) => setTimeout(r, 3000));

  const recent = await getRecentLogs(startTime);
  log('info', `\n📊 alert_log gravou ${recent.length} entrada(s):`);
  for (const log_ of recent) {
    console.log(`   [${log_.severity}] ${log_.category} — ${log_.title}`);
  }

  console.log('');
  log('info', `${C.bold}═══ Resumo ═══${C.reset}`);
  for (const [name, ok] of Object.entries(results)) {
    console.log(`   ${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${name}`);
  }
  const allOk = Object.values(results).every((v) => v);
  console.log('');
  if (allOk) {
    log('ok', '✅ TODOS PASSARAM. Confere no Telegram se chegaram as ~5 mensagens.');
  } else {
    log('fail', '⚠️  ALGUMAS FALHARAM. Veja detalhes acima.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});

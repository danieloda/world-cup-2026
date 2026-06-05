#!/usr/bin/env node
/**
 * Reseta o DB pra estado de PRODUÇÃO:
 *   - Apaga predictions, picks (champion + scorer), player_goals
 *   - Apaga test users (auth.users e profiles) que matchem 'test-*@testuser.com'
 *   - Apaga alert_log (opcional via --keep-logs)
 *   - Restaura matches pro estado inicial (slot_home/away, sem actual scores)
 *   - Restaura datas dos matches pra 2026 (junho-julho)
 *   - Restaura settings.deadline_champion_scorer pra 2026-06-11 02:59 UTC
 *
 * PRESERVA:
 *   - admin user (danieloda35@gmail.com)
 *   - matches metadata (id, slot_home, slot_away, group_name, ground, etc)
 *   - players (todos os 1380)
 *   - settings (pool_name, fee_amount, prize_split, edge_anon_key)
 *   - team_fifa_rank
 *
 * Uso:
 *   node scripts/reset-for-production.js --dry-run  (mostra o que faria)
 *   node scripts/reset-for-production.js            (pede confirmação)
 *   node scripts/reset-for-production.js --force    (sem confirmação)
 *   node scripts/reset-for-production.js --keep-logs (preserva alert_log)
 *
 * ⚠ AVISO: Operação DESTRUTIVA. Use apenas pra preparar o ambiente
 *           de produção a partir de um estado de teste.
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const DRY_RUN = args['dry-run'] === true;
const FORCE = args.force === true;
const KEEP_LOGS = args['keep-logs'] === true;
const TARGET_M1_DATE = '2026-06-11T19:00:00+00:00';

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c] || ''}${m}${C.reset}`);

async function prompt(question) {
  if (FORCE) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'yes');
    });
  });
}

async function snapshot(label) {
  log('blue', `\n📊 ${label}:`);
  const tables = ['profiles', 'predictions', 'champion_picks', 'top_scorer_picks', 'player_goals', 'alert_log'];
  for (const t of tables) {
    const { count } = await admin.from(t).select('*', { count: 'exact', head: true });
    const expectNonZero = false;  // tudo deveria ser ~0 após reset (exceto profiles=1, alert_log se KEEP_LOGS)
    log('blue', `   ${t.padEnd(25)} ${String(count).padStart(6)}`);
  }
  const { count: fin } = await admin.from('matches').select('*', { count: 'exact', head: true }).eq('finished', true);
  log('blue', `   ${'matches finished'.padEnd(25)} ${String(fin).padStart(6)}`);
  const { data: m1 } = await admin.from('matches').select('match_date').eq('id', 1).single();
  log('blue', `   ${'M#1 date'.padEnd(25)} ${m1.match_date}`);
}

async function main() {
  log('blue', `${C.bold}🔄 Reset DB pra PRODUÇÃO${C.reset}`);
  if (DRY_RUN) log('yellow', '   ★ MODO DRY-RUN ★');
  if (FORCE) log('yellow', '   ★ MODO FORCE (sem confirmação) ★');
  if (KEEP_LOGS) log('yellow', '   ★ Vai PRESERVAR alert_log ★');

  log('blue', '\n🔐 Logando como admin...');
  const { error: authErr } = await admin.auth.signInWithPassword({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  if (authErr) {
    log('red', `   ✗ Login falhou: ${authErr.message}`);
    process.exit(1);
  }
  log('green', `   ✓ ${process.env.ADMIN_EMAIL}`);

  await snapshot('Estado ANTES');

  if (!DRY_RUN) {
    log('yellow', '\n⚠ Esta operação vai apagar:');
    log('yellow', '   - TODAS predictions');
    log('yellow', '   - TODOS champion_picks e top_scorer_picks');
    log('yellow', '   - TODOS player_goals');
    log('yellow', '   - Test users (test-*@testuser.com) + profiles deles');
    log('yellow', '   - alert_log' + (KEEP_LOGS ? ' (PRESERVADO via --keep-logs)' : ''));
    log('yellow', '   - Resetar matches (zero placares + restaurar slots)');
    log('yellow', '   - Restaurar match_date pra junho-julho 2026');
    log('yellow', '\n   Admin (' + process.env.ADMIN_EMAIL + ') e dados de jogos/jogadores são preservados.');
    const ok = await prompt('\n   Confirma? (digite "yes"): ');
    if (!ok) {
      log('red', '   ✗ Cancelado.');
      process.exit(1);
    }
  }

  if (DRY_RUN) {
    log('yellow', '\n🛑 DRY-RUN: nada será executado.');
    return;
  }

  // ============================================================
  // 1. Apagar test users (auth + profiles cascata)
  // ============================================================
  log('blue', '\n👥 Apagando test users...');
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
  const tests = users.users.filter((u) => u.email && u.email.startsWith('test-'));
  for (const u of tests) {
    await admin.auth.admin.deleteUser(u.id);
  }
  log('green', `   ✓ ${tests.length} test users deletados`);

  // ============================================================
  // 2. Apagar predictions/picks/goals via RPC admin
  // ============================================================
  log('blue', '\n🗑️  Apagando predictions/picks/goals...');
  const { data: resetData, error: rpcErr } = await admin.rpc('admin_reset_picks');
  if (rpcErr) {
    log('red', `   ✗ admin_reset_picks: ${rpcErr.message}`);
    process.exit(1);
  }
  const r = resetData?.[0] ?? {};
  log('green', `   ✓ predictions: ${r.predictions_deleted ?? 0}`);
  log('green', `   ✓ champion_picks: ${r.champion_picks_deleted ?? 0}`);
  log('green', `   ✓ top_scorer_picks: ${r.scorer_picks_deleted ?? 0}`);
  log('green', `   ✓ player_goals: ${r.player_goals_deleted ?? 0}`);

  // ============================================================
  // 3. Reset matches (restore slots + zerar placares)
  // ============================================================
  log('blue', '\n⚽ Resetando matches...');
  const { data: matchReset, error: mErr } = await admin.rpc('admin_reset_matches');
  if (mErr) {
    log('red', `   ✗ admin_reset_matches: ${mErr.message}`);
    process.exit(1);
  }
  const mr = matchReset?.[0] ?? {};
  log('green', `   ✓ matches resetados: ${mr.matches_reset ?? 0}`);
  log('green', `   ✓ KO slots restaurados: ${mr.ko_slots_restored ?? 0}`);

  // ============================================================
  // 4. Restaurar datas pra 2026
  // ============================================================
  log('blue', '\n📅 Restaurando datas pra 2026...');
  const { data: m1Now } = await admin.from('matches').select('match_date').eq('id', 1).single();
  const currentM1 = new Date(m1Now.match_date);
  const targetM1 = new Date(TARGET_M1_DATE);
  const diffDays = Math.round((targetM1 - currentM1) / 86400000);

  if (diffDays === 0) {
    log('green', `   ✓ Datas já em ${TARGET_M1_DATE.slice(0, 10)}`);
  } else {
    log('yellow', `   Diff: ${diffDays > 0 ? '+' : ''}${diffDays} dias`);
    const { data: allMatches } = await admin.from('matches').select('id, match_date').order('id');
    let ok = 0;
    for (const m of allMatches) {
      const newDate = new Date(new Date(m.match_date).getTime() + diffDays * 86400 * 1000).toISOString();
      const { error } = await admin.from('matches').update({ match_date: newDate }).eq('id', m.id);
      if (!error) ok++;
    }
    log('green', `   ✓ ${ok}/104 datas atualizadas`);
  }

  // ============================================================
  // 5. Restaurar deadline champion/scorer
  // ============================================================
  log('blue', '\n🔒 Restaurando deadline_champion_scorer...');
  const deadline = '2026-06-11T02:59:00+00:00';  // 10/jun 23:59 BRT
  const { error: dErr } = await admin
    .from('settings')
    .upsert({ key: 'deadline_champion_scorer', value: JSON.stringify(deadline) });
  if (dErr) {
    log('red', `   ✗ ${dErr.message}`);
  } else {
    log('green', `   ✓ deadline = ${deadline}`);
  }

  // ============================================================
  // 6. Limpar alert_log (opcional)
  // ============================================================
  if (!KEEP_LOGS) {
    log('blue', '\n🚨 Apagando alert_log...');
    const { error: aErr } = await admin.from('alert_log').delete().gte('id', 0);
    if (aErr) {
      log('yellow', `   ⚠ alert_log: ${aErr.message}`);
    } else {
      log('green', `   ✓ alert_log limpo`);
    }
  } else {
    log('dim', '\n   ⏭ alert_log preservado (--keep-logs)');
  }

  // ============================================================
  // Validação final
  // ============================================================
  await snapshot('Estado DEPOIS');

  log('blue', '\n🔍 Validação:');
  const checks = [];

  const { count: prof } = await admin.from('profiles').select('*', { count: 'exact', head: true });
  checks.push(['Profiles tem só admin', prof === 1]);

  const { count: pred } = await admin.from('predictions').select('*', { count: 'exact', head: true });
  checks.push(['Predictions zerou', pred === 0]);

  const { count: champ } = await admin.from('champion_picks').select('*', { count: 'exact', head: true });
  checks.push(['Champion picks zerou', champ === 0]);

  const { count: scorer } = await admin.from('top_scorer_picks').select('*', { count: 'exact', head: true });
  checks.push(['Scorer picks zerou', scorer === 0]);

  const { count: goals } = await admin.from('player_goals').select('*', { count: 'exact', head: true });
  checks.push(['Player goals zerou', goals === 0]);

  const { count: fin } = await admin.from('matches').select('*', { count: 'exact', head: true }).eq('finished', true);
  checks.push(['Matches finished zerou', fin === 0]);

  const { data: m1Final } = await admin.from('matches').select('match_date').eq('id', 1).single();
  checks.push(['M#1 date em 2026', m1Final.match_date.startsWith('2026-')]);

  const { data: settings } = await admin.from('settings').select('value').eq('key', 'deadline_champion_scorer').single();
  const dlValue = typeof settings.value === 'string' ? settings.value : JSON.stringify(settings.value);
  checks.push(['Deadline em 2026', dlValue.includes('2026-')]);

  const { count: players } = await admin.from('players').select('*', { count: 'exact', head: true });
  checks.push(['Players preservados (>1000)', players > 1000]);

  const { count: matches } = await admin.from('matches').select('*', { count: 'exact', head: true });
  checks.push(['Matches preservados (104)', matches === 104]);

  let allOk = true;
  for (const [name, ok] of checks) {
    log(ok ? 'green' : 'red', `   ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) allOk = false;
  }

  console.log('');
  if (allOk) {
    log('green', `${C.bold}🎉 RESET DE PRODUÇÃO COMPLETO. DB pronto pra usuários reais.${C.reset}`);
  } else {
    log('red', `${C.bold}⚠️  Algumas validações falharam. Reveja acima.${C.reset}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Testa os LOCKS DE DATA via RLS (a real fronteira de segurança server-side):
 *
 *   A) Predictions travam no kickoff de CADA jogo
 *      - match no FUTURO  → insert/update permitido
 *      - match no PASSADO → insert/update BLOQUEADO
 *
 *   B) Champion/Scorer picks travam no deadline global (cs_deadline)
 *      - antes do deadline → insert/update permitido
 *      - depois do deadline → BLOQUEADO
 *
 * Testa com cliente ANON autenticado como user comum (RLS aplica).
 * Admin/service role só pra setup/teardown + manipular datas.
 *
 * SEGURANÇA: salva valores originais (match_date, deadline) e RESTAURA no finally,
 * pra não deixar o DB de produção sujo.
 *
 * Uso: node scripts/e2e/test-date-locks.js
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const EMAIL = `test-locks-${Date.now()}@testuser.com`;
const PASSWORD = 'TestLocks2026!';

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c] || ''}${m}${C.reset}`);

let userId = null;
let userClient = null;
const TEST_MATCH_ID = 1;     // jogo de grupo que vamos manipular a data
let origMatchDate = null;
let origDeadline = null;
const checks = [];
function check(name, pass) {
  checks.push([name, pass]);
  log(pass ? 'green' : 'red', `   ${pass ? '✓' : '✗'} ${name}`);
}

const FUTURE = '2027-01-01T00:00:00+00:00';
const PAST = '2020-01-01T00:00:00+00:00';

async function setMatchDate(d) {
  await admin.from('matches').update({ match_date: d }).eq('id', TEST_MATCH_ID);
}
async function setDeadline(d) {
  await admin.from('settings').upsert({ key: 'deadline_champion_scorer', value: JSON.stringify(d) });
}

async function setup() {
  log('blue', '[setup] Criando user de teste (não-admin)...');
  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { full_name: 'Teste Locks' },
  });
  if (error) throw new Error('createUser: ' + error.message);
  userId = created.user.id;
  await admin.from('profiles').insert({ id: userId, email: EMAIL, full_name: 'Teste Locks', is_admin: false, paid: false });

  // Cliente ANON autenticado como esse user (RLS aplica)
  userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
  const { error: sErr } = await userClient.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (sErr) throw new Error('login: ' + sErr.message);
  log('green', `   ✓ user ${userId.slice(0, 8)}... logado (anon client)`);

  // Salva originais
  const { data: m } = await admin.from('matches').select('match_date').eq('id', TEST_MATCH_ID).single();
  origMatchDate = m.match_date;
  const { data: s } = await admin.from('settings').select('value').eq('key', 'deadline_champion_scorer').single();
  origDeadline = typeof s.value === 'string' ? s.value.replace(/^"|"$/g, '') : s.value;
  log('dim', `   originais salvos: match#${TEST_MATCH_ID}=${origMatchDate} | deadline=${origDeadline}`);
}

async function teardown() {
  log('blue', '\n[teardown] Restaurando + limpando...');
  try {
    if (origMatchDate) await setMatchDate(origMatchDate);
    if (origDeadline) await setDeadline(origDeadline);
    log('green', `   ✓ match_date e deadline restaurados`);
  } catch (e) { log('red', `   ⚠ restore falhou: ${e.message}`); }
  if (userId) {
    try {
      await admin.from('predictions').delete().eq('user_id', userId);
      await admin.from('champion_picks').delete().eq('user_id', userId);
      await admin.from('top_scorer_picks').delete().eq('user_id', userId);
      await admin.from('profiles').delete().eq('id', userId);
      await admin.auth.admin.deleteUser(userId);
      log('green', `   ✓ user de teste removido`);
    } catch (e) { log('yellow', `   ⚠ cleanup parcial: ${e.message}`); }
  }
}

async function main() {
  log('blue', `${C.bold}🔒 Teste de locks de data (RLS)${C.reset}`);
  await setup();

  // ============================================================
  // A) PREDICTIONS lock no kickoff
  // ============================================================
  log('blue', '\n[A] Predictions travam no kickoff:');

  // A1: match no FUTURO → insert permitido
  await setMatchDate(FUTURE);
  let r = await userClient.from('predictions').insert({
    user_id: userId, match_id: TEST_MATCH_ID, pred_home: 2, pred_away: 1,
  });
  check('Insert prediction em jogo FUTURO → permitido', !r.error);
  if (r.error) log('dim', `      erro: ${r.error.message}`);

  // A2: match no FUTURO → update permitido
  r = await userClient.from('predictions').update({ pred_home: 3 }).eq('user_id', userId).eq('match_id', TEST_MATCH_ID);
  check('Update prediction em jogo FUTURO → permitido', !r.error);

  // A3: move pro PASSADO → update BLOQUEADO
  await setMatchDate(PAST);
  r = await userClient.from('predictions').update({ pred_home: 5 }).eq('user_id', userId).eq('match_id', TEST_MATCH_ID);
  // RLS bloqueia: update não afeta nenhuma row (with check falha) — não retorna erro mas 0 rows
  const { data: afterUpdate } = await admin.from('predictions').select('pred_home').eq('user_id', userId).eq('match_id', TEST_MATCH_ID).single();
  check('Update prediction em jogo PASSADO → bloqueado (valor não mudou)', afterUpdate?.pred_home === 3);
  if (afterUpdate?.pred_home !== 3) log('dim', `      pred_home virou ${afterUpdate?.pred_home} (esperava 3)`);

  // A4: delete a prediction (via admin) e tenta INSERT em jogo passado → bloqueado
  await admin.from('predictions').delete().eq('user_id', userId).eq('match_id', TEST_MATCH_ID);
  r = await userClient.from('predictions').insert({
    user_id: userId, match_id: TEST_MATCH_ID, pred_home: 1, pred_away: 0,
  });
  check('Insert prediction em jogo PASSADO → bloqueado (erro RLS)', !!r.error);
  if (!r.error) log('dim', `      ⚠ insert passou (não deveria!)`);

  // Restaura data do match
  await setMatchDate(origMatchDate);

  // ============================================================
  // B) CHAMPION/SCORER picks lock no deadline
  // ============================================================
  log('blue', '\n[B] Champion/Scorer travam no deadline:');

  // Pega um time e um player válidos
  const { data: anyMatch } = await admin.from('matches').select('team_home').eq('stage', 'group').limit(1).single();
  const championTeam = anyMatch.team_home;
  const { data: anyPlayer } = await admin.from('players').select('id').limit(1).single();
  const playerId = anyPlayer.id;

  // B1: deadline no FUTURO → champion insert permitido
  await setDeadline(FUTURE);
  r = await userClient.from('champion_picks').insert({ user_id: userId, team: championTeam });
  check('Champion pick ANTES do deadline → permitido', !r.error);
  if (r.error) log('dim', `      erro: ${r.error.message}`);

  // B2: scorer insert permitido
  r = await userClient.from('top_scorer_picks').insert({ user_id: userId, player_id: playerId });
  check('Scorer pick ANTES do deadline → permitido', !r.error);
  if (r.error) log('dim', `      erro: ${r.error.message}`);

  // B3: deadline no PASSADO → update champion BLOQUEADO
  await setDeadline(PAST);
  const { data: champBefore } = await admin.from('champion_picks').select('team').eq('user_id', userId).single();
  // tenta trocar o time
  const otherTeam = championTeam === 'Brazil' ? 'France' : 'Brazil';
  r = await userClient.from('champion_picks').update({ team: otherTeam }).eq('user_id', userId);
  const { data: champAfter } = await admin.from('champion_picks').select('team').eq('user_id', userId).single();
  check('Champion update DEPOIS do deadline → bloqueado (não mudou)', champAfter?.team === champBefore?.team);

  // B4: deadline passado → INSERT novo (deletando antes) bloqueado
  await admin.from('champion_picks').delete().eq('user_id', userId);
  r = await userClient.from('champion_picks').insert({ user_id: userId, team: championTeam });
  check('Champion insert DEPOIS do deadline → bloqueado (erro RLS)', !!r.error);
  if (!r.error) log('dim', `      ⚠ insert passou (não deveria!)`);

  // Restaura deadline
  await setDeadline(origDeadline);

  // ============================================================
  // Resumo
  // ============================================================
  console.log('');
  const allOk = checks.every(([, p]) => p);
  if (allOk) {
    log('green', `${C.bold}🎉 LOCKS DE DATA FUNCIONANDO (${checks.length}/${checks.length})${C.reset}`);
  } else {
    const failed = checks.filter(([, p]) => !p).length;
    log('red', `${C.bold}⚠️ ${failed}/${checks.length} checks falharam${C.reset}`);
  }
}

main()
  .catch((e) => { log('red', `\n❌ ${e.message}`); })
  .finally(async () => { await teardown(); });

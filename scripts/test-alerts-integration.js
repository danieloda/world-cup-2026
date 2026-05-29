#!/usr/bin/env node
// Teste de integração dos alertas INFO da migration 019.
//
// Diferente do test-alerts-info.js (smoke test que só valida que send_alert
// retornou ok), este script:
//   1. Cria um usuário de teste via service role
//   2. Dispara as condições REAIS (insert/update nas tabelas-alvo)
//   3. Lê public.alert_log e faz assertions sobre o conteúdo
//   4. Limpa tudo no final
//
// Cobre:
//   - signup_success    — INSERT em profiles
//   - champion_changed  — INSERT, UPDATE (mudou), UPDATE (não mudou)
//   - scorer_changed    — INSERT, UPDATE (mudou)
//   - picks_complete    — 48 predictions de grupo → 1 alerta one-shot
//   - pick_activity     — cron pega o user de teste
//   - daily_digest      — counts batem com estado do DB
//   - signup_failure    — RPC anon + dedup
//
// Uso: node scripts/test-alerts-integration.js

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY ausente em .env. Necessário pra criar/deletar test user e ler alert_log.');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createClient(SUPABASE_URL, ANON_KEY);

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', dim: '\x1b[2m', bold: '\x1b[1m' };
const log = (lvl, msg) => console.log(`${({ ok: C.green, fail: C.red, warn: C.yellow, info: C.blue })[lvl] || ''}${msg}${C.reset}`);

// ============================================================
// Mini test harness
// ============================================================
const results = [];
let testUserId = null;
// Marco temporal pra isolar rows deste run. Subtrai 30s pra absorver
// clock skew entre cliente local e server Supabase (server pode estar
// alguns ms atrás, fazendo .gte excluir a linha recém-criada).
const testStart = new Date(Date.now() - 30000).toISOString();
const TEST_EMAIL = `alerttest_${Date.now()}@example.com`;
const TEST_NAME = `AlertTest_${Date.now()}`;

function assert(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  if (cond) log('ok', `   ✓ ${name}`);
  else log('fail', `   ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Lê o alerta mais recente pra (category, user_id) desde testStart.
// Filtra por context.user_id pra não pegar alertas de outros tests/cron.
async function getRecentAlertForUser(category, userId) {
  await sleep(400); // pg_net é async; log row é sync mas pode ter race
  const { data, error } = await admin
    .from('alert_log')
    .select('*')
    .eq('category', category)
    .gte('created_at', testStart)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`select alert_log: ${error.message}`);
  return (data || []).find((r) => r.context?.user_id === userId) ?? null;
}

async function getRecentAlertByCategory(category, sinceIso) {
  await sleep(400);
  // Buffer de 30s pra absorver clock skew entre cliente local e server Supabase.
  const since = sinceIso ? new Date(new Date(sinceIso).getTime() - 30000).toISOString() : null;
  let q = admin
    .from('alert_log')
    .select('*')
    .eq('category', category)
    .order('created_at', { ascending: false })
    .limit(1);
  if (since) q = q.gte('created_at', since);
  const { data, error } = await q;
  if (error) throw new Error(`select alert_log: ${error.message}`);
  return data?.[0] ?? null;
}

async function getRecentAlertByEmail(category, email) {
  // signup_failure não tem user_id, isolamos pelo email no context (único por test run)
  await sleep(400);
  const { data, error } = await admin
    .from('alert_log')
    .select('*')
    .eq('category', category)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`select alert_log: ${error.message}`);
  return (data || []).find((r) => r.context?.email === email) ?? null;
}

async function countAlertsByEmail(category, email) {
  const { data, error } = await admin
    .from('alert_log').select('id, context')
    .eq('category', category)
    .order('created_at', { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  return (data || []).filter((r) => r.context?.email === email).length;
}

async function countAlertsForUser(category, userId) {
  const { data, error } = await admin
    .from('alert_log')
    .select('id, context')
    .eq('category', category)
    .gte('created_at', testStart);
  if (error) throw new Error(`count alert_log: ${error.message}`);
  return (data || []).filter((r) => r.context?.user_id === userId).length;
}

// ============================================================
// Setup / Teardown
// ============================================================
async function setup() {
  log('info', `\n🔧 Setup: criando test user ${TEST_EMAIL}...`);
  const { data, error } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: 'test_password_1234',
    email_confirm: true,
    user_metadata: { full_name: TEST_NAME },
  });
  if (error) throw new Error('createUser falhou: ' + error.message);
  testUserId = data.user.id;
  log('ok', `   ✓ Auth user criado: ${testUserId}`);

  // Insere profile (isso dispara o trigger signup_success)
  const { error: profErr } = await admin.from('profiles').insert({
    id: testUserId,
    full_name: TEST_NAME,
    email: TEST_EMAIL,
    is_admin: false,
    paid: false,
  });
  if (profErr) throw new Error('insert profile falhou: ' + profErr.message);
  log('ok', `   ✓ Profile inserido (deve disparar signup_success)`);
}

async function teardown() {
  if (!testUserId) return;
  log('info', `\n🧹 Teardown: deletando test user...`);

  // Limpa picks/predictions/etc (cascade do profile FK, mas explicitamos)
  await admin.from('predictions').delete().eq('user_id', testUserId);
  await admin.from('champion_picks').delete().eq('user_id', testUserId);
  await admin.from('top_scorer_picks').delete().eq('user_id', testUserId);
  // Profile cascade-delete vem do auth.admin.deleteUser
  const { error } = await admin.auth.admin.deleteUser(testUserId);
  if (error) log('warn', `   ⚠ deleteUser falhou: ${error.message}`);
  else log('ok', `   ✓ User deletado`);

  // Limpa só alert_log que referenciam o test user ou emails de teste.
  // Evita varrer alertas reais que tenham disparado durante o test window.
  const { data: testRows } = await admin
    .from('alert_log').select('id, context')
    .gte('created_at', testStart);
  const toDelete = (testRows || []).filter((r) =>
    r.context?.user_id === testUserId ||
    r.context?.email === TEST_EMAIL ||
    (typeof r.context?.email === 'string' && r.context.email.startsWith('fail_'))
  ).map((r) => r.id);
  if (toDelete.length > 0) {
    await admin.from('alert_log').delete().in('id', toDelete);
  }
  log('ok', `   ✓ alert_log limpado (${toDelete.length} rows)`);
}

// ============================================================
// Test 1: signup_success
// ============================================================
async function testSignupSuccess() {
  log('info', '\n▶ TEST 1: signup_success');
  const a = await getRecentAlertForUser('signup_success', testUserId);
  assert('alerta criado em alert_log', a !== null);
  if (!a) return;
  assert('severity=info', a.severity === 'info');
  assert('title contém nome', a.title.includes(TEST_NAME), `title=${a.title}`);
  assert('body menciona email', a.body.includes(TEST_EMAIL));
  assert('context.user_id correto', a.context?.user_id === testUserId);
  assert('context.email correto', a.context?.email === TEST_EMAIL);
  assert('context.total_users > 0', typeof a.context?.total_users === 'number' && a.context.total_users > 0);
}

// ============================================================
// Test 2: champion_changed (INSERT + UPDATE com mudança + sem mudança)
// ============================================================
async function testChampionChanged() {
  log('info', '\n▶ TEST 2: champion_changed');

  // 2a) INSERT
  const ins = await admin.from('champion_picks').insert({ user_id: testUserId, team: 'Brazil' });
  assert('INSERT champion_picks ok', !ins.error, ins.error?.message);
  const a1 = await getRecentAlertForUser('champion_changed', testUserId);
  assert('INSERT gerou alerta', a1 !== null);
  if (a1) {
    assert('INSERT title diz "definiu"', a1.title.includes('definiu campeão'));
    assert('INSERT context.op=INSERT', a1.context?.op === 'INSERT');
    assert('INSERT context.team_new=Brazil', a1.context?.team_new === 'Brazil');
    assert('INSERT context.team_old is null', a1.context?.team_old === null);
  }

  // 2b) UPDATE com mudança
  const beforeUpdCount = await countAlertsForUser('champion_changed', testUserId);
  const upd = await admin.from('champion_picks').update({ team: 'Argentina' }).eq('user_id', testUserId);
  assert('UPDATE (mudou) champion_picks ok', !upd.error, upd.error?.message);
  await sleep(400);
  const afterUpdCount = await countAlertsForUser('champion_changed', testUserId);
  assert('UPDATE (mudou) gerou +1 alerta', afterUpdCount === beforeUpdCount + 1, `before=${beforeUpdCount} after=${afterUpdCount}`);

  const { data: recentList } = await admin
    .from('alert_log').select('*')
    .eq('category', 'champion_changed').gte('created_at', testStart)
    .order('created_at', { ascending: false }).limit(5);
  const a2 = (recentList || []).find((r) => r.context?.user_id === testUserId && r.context?.op === 'UPDATE');
  if (a2) {
    assert('UPDATE title diz "trocou"', a2.title.includes('trocou campeão'));
    assert('UPDATE context.team_old=Brazil', a2.context?.team_old === 'Brazil');
    assert('UPDATE context.team_new=Argentina', a2.context?.team_new === 'Argentina');
  } else {
    assert('UPDATE row encontrada', false, 'sem row UPDATE em alert_log');
  }

  // 2c) UPDATE sem mudança (touch — não deve disparar)
  const beforeTouchCount = await countAlertsForUser('champion_changed', testUserId);
  const touch = await admin.from('champion_picks').update({ team: 'Argentina' }).eq('user_id', testUserId);
  assert('UPDATE (touch) champion_picks ok', !touch.error);
  await sleep(400);
  const afterTouchCount = await countAlertsForUser('champion_changed', testUserId);
  assert('UPDATE (sem mudar team) NÃO gerou alerta', afterTouchCount === beforeTouchCount, `before=${beforeTouchCount} after=${afterTouchCount}`);
}

// ============================================================
// Test 3: artilheiro_changed (INSERT + UPDATE com mudança)
// ============================================================
async function testScorerChanged() {
  log('info', '\n▶ TEST 3: artilheiro_changed');

  // Pega dois player_ids distintos pra usar
  const { data: players } = await admin.from('players').select('id, full_name, team').limit(2);
  if (!players || players.length < 2) {
    log('warn', '   ⚠ <2 players no DB; pulando teste');
    return;
  }
  const [p1, p2] = players;

  // INSERT
  const ins = await admin.from('top_scorer_picks').insert({ user_id: testUserId, player_id: p1.id });
  assert('INSERT top_scorer_picks ok', !ins.error, ins.error?.message);
  const a1 = await getRecentAlertForUser('artilheiro_changed', testUserId);
  assert('INSERT gerou alerta', a1 !== null);
  if (a1) {
    assert('INSERT title diz "definiu"', a1.title.includes('definiu artilheiro'));
    assert('INSERT title contém player', a1.title.includes(p1.full_name));
    assert('INSERT context.op=INSERT', a1.context?.op === 'INSERT');
    assert('INSERT context.player_id_new', a1.context?.player_id_new === p1.id);
  }

  // UPDATE com mudança
  const beforeUpd = await countAlertsForUser('artilheiro_changed', testUserId);
  const upd = await admin.from('top_scorer_picks').update({ player_id: p2.id }).eq('user_id', testUserId);
  assert('UPDATE top_scorer_picks ok', !upd.error, upd.error?.message);
  await sleep(400);
  const afterUpd = await countAlertsForUser('artilheiro_changed', testUserId);
  assert('UPDATE (mudou) gerou +1 alerta', afterUpd === beforeUpd + 1);
}

// ============================================================
// Test 4: picks_complete (one-shot via dedup 30 dias)
// ============================================================
async function testPicksComplete() {
  log('info', '\n▶ TEST 4: picks_complete (one-shot)');

  // Pega TODOS os match ids da fase de grupos (esperado: 48)
  const { data: groupMatches } = await admin.from('matches').select('id').eq('stage', 'group');
  const total = groupMatches?.length || 0;
  assert('matches de grupo encontrados', total > 0, `total=${total}`);
  if (total === 0) return;

  // Insere predictions pra TODOS os jogos de grupo (placar 0-0)
  // Em batches pra não tomar timeout
  const rows = groupMatches.map((m) => ({ user_id: testUserId, match_id: m.id, pred_home: 0, pred_away: 0 }));
  const chunkSize = 50;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await admin.from('predictions').insert(chunk);
    if (error) {
      assert(`insert chunk [${i},${i+chunkSize})`, false, error.message);
      return;
    }
  }
  assert(`inseriu ${total} predictions`, true);

  // Espera um pouco e checa que houve EXATAMENTE 1 alerta picks_complete
  await sleep(800);
  const count = await countAlertsForUser('picks_complete', testUserId);
  assert('exatamente 1 alerta picks_complete (one-shot)', count === 1, `count=${count}`);

  const a = await getRecentAlertForUser('picks_complete', testUserId);
  if (a) {
    assert('milestone=group_complete', a.context?.milestone === 'group_complete');
    assert('title contém nome', a.title.includes(TEST_NAME));
  }

  // UPDATE em uma prediction NÃO deve disparar de novo (dedup 30 dias)
  const { error: updErr } = await admin
    .from('predictions')
    .update({ pred_home: 1 })
    .eq('user_id', testUserId)
    .eq('match_id', groupMatches[0].id);
  assert('UPDATE prediction após complete ok', !updErr, updErr?.message);
  await sleep(800);
  const countAfter = await countAlertsForUser('picks_complete', testUserId);
  assert('UPDATE NÃO disparou novo picks_complete (dedup)', countAfter === 1, `count=${countAfter}`);
}

// ============================================================
// Test 5: pick_activity cron
// ============================================================
async function testPickActivityCron() {
  log('info', '\n▶ TEST 5: cron_alert_pick_activity');

  // Reseta last_check pra 10 min atrás pra garantir que pega as nossas mudanças
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { error: setErr } = await admin
    .from('settings')
    .upsert({ key: 'pick_activity_last_check', value: JSON.stringify(tenMinAgo) });
  assert('reset settings.pick_activity_last_check', !setErr, setErr?.message);

  // Roda o cron
  const { error: cronErr } = await admin.rpc('cron_alert_pick_activity');
  assert('cron_alert_pick_activity ok', !cronErr, cronErr?.message);

  await sleep(800);
  const a = await getRecentAlertForUser('pick_activity', testUserId);
  assert('cron gerou alerta pro test user', a !== null);
  if (a) {
    assert('touched > 0', typeof a.context?.touched === 'number' && a.context.touched > 0);
    assert('user_total = group_total', a.context?.user_total === a.context?.group_total);
    assert('title contém nome', a.title.includes(TEST_NAME));
  }
}

// ============================================================
// Test 6: daily_digest cron
// ============================================================
async function testDailyDigestCron() {
  log('info', '\n▶ TEST 6: cron_alert_daily_digest');

  const since = new Date().toISOString();
  const { error: cronErr } = await admin.rpc('cron_alert_daily_digest');
  assert('cron_alert_daily_digest ok', !cronErr, cronErr?.message);
  await sleep(800);

  const a = await getRecentAlertByCategory('daily_digest', since);
  assert('digest criado', a !== null);
  if (!a) return;

  // Compara context com o estado real do DB
  const { count: totalUsers } = await admin.from('profiles').select('*', { count: 'exact', head: true });
  assert('context.total_users bate com DB',
    a.context?.total_users === totalUsers, `ctx=${a.context?.total_users} db=${totalUsers}`);

  assert('context.no_champion presente', typeof a.context?.no_champion === 'number');
  assert('context.no_scorer presente', typeof a.context?.no_scorer === 'number');
  assert('context.group_total presente', typeof a.context?.group_total === 'number');
  assert('title começa com 📊', a.title.startsWith('📊'));

  // Test user tem champion e scorer (setados nos tests 2/3), e 48/48 (test 4)
  // Logo não deve aparecer em FALTA CAMPEÃO nem FALTA ARTILHEIRO nem FALTAM PALPITES
  assert('body NÃO lista test user como faltando campeão',
    !a.body.includes(`FALTA CAMPEÃO`) || !a.body.split('FALTA CAMPEÃO')[1].split('\n\n')[0].includes(TEST_NAME));
  assert('body NÃO lista test user como faltando artilheiro',
    !a.body.includes(`FALTA ARTILHEIRO`) || !a.body.split('FALTA ARTILHEIRO')[1].split('\n\n')[0].includes(TEST_NAME));
}

// ============================================================
// Test 7: signup_failure RPC + dedup
// ============================================================
async function testSignupFailureRpc() {
  log('info', '\n▶ TEST 7: signup_failure (RPC anon + dedup)');

  // Email único por test run — usamos como chave de isolamento (não timestamp).
  const email = `fail_${Date.now()}@example.com`;
  const reason = 'Email já cadastrado (TESTE)';

  const { error: e1 } = await anon.rpc('report_signup_failure', { p_email: email, p_reason: reason });
  assert('1ª chamada ok', !e1, e1?.message);
  await sleep(500);
  const a1 = await getRecentAlertByEmail('signup_failure', email);
  assert('1ª chamada gerou alerta', a1 !== null);
  if (a1) {
    assert('context.email correto', a1.context?.email === email);
    assert('context.reason correto', a1.context?.reason === reason);
  }

  // 2ª chamada idêntica: dedup (60s) deve bloquear
  const { error: e2 } = await anon.rpc('report_signup_failure', { p_email: email, p_reason: reason });
  assert('2ª chamada ok (não erra)', !e2);
  await sleep(500);
  const sameCount = await countAlertsByEmail('signup_failure', email);
  assert('dedup bloqueou 2ª chamada idêntica', sameCount === 1, `count=${sameCount}`);

  // 3ª chamada com reason diferente: passa pelo dedup
  const { error: e3 } = await anon.rpc('report_signup_failure', { p_email: email, p_reason: 'outro motivo' });
  assert('3ª chamada (reason diferente) ok', !e3);
  await sleep(500);
  const distinctCount = await countAlertsByEmail('signup_failure', email);
  assert('reason diferente passa pelo dedup', distinctCount === 2, `count=${distinctCount}`);
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  log('info', `${C.bold}🧪 Teste de integração — alertas INFO (migration 019)${C.reset}`);
  log('info', `   Test user: ${TEST_NAME} (${TEST_EMAIL})`);

  try {
    await setup();
    await testSignupSuccess();
    await testChampionChanged();
    await testScorerChanged();
    await testPicksComplete();
    await testPickActivityCron();
    await testDailyDigestCron();
    await testSignupFailureRpc();
  } catch (e) {
    log('fail', `\n💥 Erro fatal: ${e.message}`);
    console.error(e);
  } finally {
    try { await teardown(); } catch (e) { log('warn', `Teardown erro: ${e.message}`); }
  }

  console.log('');
  log('info', `${C.bold}═══ Resumo ═══${C.reset}`);
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  log('ok', `   Passou: ${passed}/${results.length}`);
  if (failed.length > 0) {
    log('fail', `   Falhou: ${failed.length}`);
    for (const f of failed) console.log(`     ${C.red}✗${C.reset} ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  } else {
    log('ok', '\n✅ Todos os asserts passaram!');
  }
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

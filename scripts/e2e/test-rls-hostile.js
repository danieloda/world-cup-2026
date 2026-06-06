#!/usr/bin/env node
/**
 * Testa RLS HOSTIL — proteção de dados entre usuários comuns.
 * (Não tem a ver com admin — é user-vs-user, relevante pros ~30 jogadores.)
 *
 * Cenários (Alice e Bob = 2 users comuns):
 *   1. Alice NÃO pode inserir prediction com user_id do Bob
 *   2. Alice NÃO pode editar prediction do Bob
 *   3. Alice NÃO vê predictions do Bob ANTES do kickoff
 *   4. Alice VÊ predictions do Bob DEPOIS do kickoff (esperado — histórico)
 *   5. Alice NÃO pode marcar a si mesma como paid/admin (escalonamento)
 *   6. Alice NÃO vê champion_pick do Bob antes do deadline
 *   7. Alice NÃO pode inserir champion_pick com user_id do Bob
 *   8. Alice NÃO pode gravar points_earned no próprio palpite (C1, migration 034)
 *   9. Alice NÃO lê o bracket palpitado do Bob via compute_predicted_slots (H1)
 *  10. Alice NÃO chama qualifier_bonus_for de outro usuário (H1)
 *  11. Alice NÃO chama recompute_* via RPC (H2)
 *  12. Alice NÃO escreve em settings/matches sem ser admin
 *  13. Toda escrita em palpite gera linha no prediction_audit (H3, migration 035)
 *  14. Alice NÃO lê o prediction_audit (só admin)
 *
 * Usa clientes ANON autenticados (RLS aplica). Admin só pra setup/teardown.
 * Salva/restaura match_date + deadline.
 *
 * Uso: node scripts/e2e/test-rls-hostile.js
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY;
const TS = Date.now();
const ALICE_EMAIL = `test-alice-${TS}@testuser.com`;
const BOB_EMAIL = `test-bob-${TS}@testuser.com`;
const PASSWORD = 'TestRls2026!';
const TEST_MATCH = 1;

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c] || ''}${m}${C.reset}`);

const checks = [];
function check(name, pass, detail) {
  checks.push([name, pass]);
  log(pass ? 'green' : 'red', `   ${pass ? '✓' : '✗'} ${name}`);
  if (!pass && detail) log('dim', `      ${detail}`);
}

let alice = null, bob = null;       // { id }
let aliceClient = null, bobClient = null;
let origMatchDate = null, origDeadline = null, origFinished = null;

async function mkUser(email) {
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: email.split('@')[0] },
  });
  if (error) throw new Error('createUser ' + email + ': ' + error.message);
  await admin.from('profiles').insert({ id: data.user.id, email, full_name: email.split('@')[0], is_admin: false, paid: true });
  const client = createClient(URL, ANON);
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  return { id: data.user.id, client };
}

async function setup() {
  log('blue', '[setup] Criando Alice e Bob (users comuns)...');
  const a = await mkUser(ALICE_EMAIL); alice = { id: a.id }; aliceClient = a.client;
  const b = await mkUser(BOB_EMAIL); bob = { id: b.id }; bobClient = b.client;
  log('green', `   ✓ Alice ${alice.id.slice(0, 8)}... | Bob ${bob.id.slice(0, 8)}...`);

  const { data: m } = await admin.from('matches').select('match_date, finished').eq('id', TEST_MATCH).single();
  origMatchDate = m.match_date;
  origFinished = m.finished;  // o banco local pode ter o match já finalizado de rodadas anteriores
  const { data: s } = await admin.from('settings').select('value').eq('key', 'deadline_champion_scorer').single();
  origDeadline = typeof s.value === 'string' ? s.value.replace(/^"|"$/g, '') : s.value;
}

async function teardown() {
  log('blue', '\n[teardown] Restaurando + limpando...');
  try {
    if (origMatchDate) await admin.from('matches').update({ match_date: origMatchDate }).eq('id', TEST_MATCH);
    if (origFinished !== null) await admin.from('matches').update({ finished: origFinished }).eq('id', TEST_MATCH);
    if (origDeadline) await admin.from('settings').upsert({ key: 'deadline_champion_scorer', value: JSON.stringify(origDeadline) });
  } catch (e) { log('red', `   ⚠ restore: ${e.message}`); }
  for (const u of [alice, bob]) {
    if (!u) continue;
    try {
      await admin.from('predictions').delete().eq('user_id', u.id);
      await admin.from('champion_picks').delete().eq('user_id', u.id);
      await admin.from('top_scorer_picks').delete().eq('user_id', u.id);
      await admin.from('prediction_audit').delete().eq('row_user_id', u.id);
      await admin.from('profiles').delete().eq('id', u.id);
      await admin.auth.admin.deleteUser(u.id);
    } catch {}
  }
  log('green', '   ✓ restaurado e usuários removidos');
}

async function main() {
  log('blue', `${C.bold}🛡️  Teste RLS hostil (user-vs-user)${C.reset}`);
  await setup();

  // garante match no futuro pra começar
  await admin.from('matches').update({ match_date: '2027-01-01T00:00:00+00:00' }).eq('id', TEST_MATCH);
  await admin.from('settings').upsert({ key: 'deadline_champion_scorer', value: JSON.stringify('2027-01-01T00:00:00+00:00') });

  // Bob cria um palpite (legítimo) pra termos algo pra Alice tentar bisbilhotar
  await bobClient.from('predictions').insert({ user_id: bob.id, match_id: TEST_MATCH, pred_home: 1, pred_away: 0 });
  await bobClient.from('champion_picks').insert({ user_id: bob.id, team: (await admin.from('matches').select('team_home').eq('stage','group').limit(1).single()).data.team_home });

  log('blue', '\n[1] Alice tenta INSERIR prediction com user_id do Bob:');
  let r = await aliceClient.from('predictions').insert({ user_id: bob.id, match_id: 2, pred_home: 9, pred_away: 9 });
  check('Insert spoofando user_id alheio → bloqueado', !!r.error, r.error ? '' : 'PASSOU (vulnerável!)');

  log('blue', '\n[2] Alice tenta EDITAR prediction do Bob:');
  r = await aliceClient.from('predictions').update({ pred_home: 7 }).eq('user_id', bob.id).eq('match_id', TEST_MATCH);
  const { data: bobPred } = await admin.from('predictions').select('pred_home').eq('user_id', bob.id).eq('match_id', TEST_MATCH).single();
  check('Update no palpite alheio → sem efeito (RLS)', bobPred?.pred_home === 1, `pred_home virou ${bobPred?.pred_home} (esperava 1)`);

  log('blue', '\n[3] Alice tenta VER predictions do Bob ANTES do kickoff:');
  const { data: seenBefore } = await aliceClient.from('predictions').select('*').eq('user_id', bob.id);
  check('Não vê palpites alheios antes do kickoff', (seenBefore?.length ?? 0) === 0, `viu ${seenBefore?.length} rows`);

  log('blue', '\n[4] Após kickoff, Alice VÊ predictions do Bob (histórico):');
  await admin.from('matches').update({ match_date: '2020-01-01T00:00:00+00:00' }).eq('id', TEST_MATCH);
  const { data: seenAfter } = await aliceClient.from('predictions').select('*').eq('user_id', bob.id).eq('match_id', TEST_MATCH);
  check('Vê palpite alheio após kickoff (esperado)', (seenAfter?.length ?? 0) === 1, `viu ${seenAfter?.length} rows`);
  await admin.from('matches').update({ match_date: '2027-01-01T00:00:00+00:00' }).eq('id', TEST_MATCH);

  log('blue', '\n[5] Alice tenta se promover a paid/admin (escalonamento):');
  r = await aliceClient.from('profiles').update({ paid: true, is_admin: true }).eq('id', alice.id);
  const { data: aliceProf } = await admin.from('profiles').select('is_admin').eq('id', alice.id).single();
  check('Não consegue virar admin via update próprio', aliceProf?.is_admin === false, `is_admin virou ${aliceProf?.is_admin}`);

  log('blue', '\n[6] Alice tenta VER champion_pick do Bob antes do deadline:');
  const { data: champSeen } = await aliceClient.from('champion_picks').select('*').eq('user_id', bob.id);
  check('Não vê champion pick alheio antes do deadline', (champSeen?.length ?? 0) === 0, `viu ${champSeen?.length} rows`);

  log('blue', '\n[7] Alice tenta INSERIR champion_pick com user_id do Bob:');
  r = await aliceClient.from('champion_picks').insert({ user_id: bob.id, team: 'Brazil' });
  check('Insert champion spoofando user_id → bloqueado', !!r.error, r.error ? '' : 'PASSOU (vulnerável!)');

  // ===== Achados da auditoria (migrations 034/035) =====

  log('blue', '\n[8] Alice tenta gravar points_earned no próprio palpite (C1):');
  let r8 = await aliceClient.from('predictions')
    .insert({ user_id: alice.id, match_id: TEST_MATCH, pred_home: 0, pred_away: 0, points_earned: 99999 });
  check('Insert com points_earned → bloqueado (C1)', !!r8.error, r8.error ? '' : 'PASSOU (vulnerável!)');
  // insert limpo, depois tenta forçar pontos via update
  await aliceClient.from('predictions').insert({ user_id: alice.id, match_id: TEST_MATCH, pred_home: 1, pred_away: 1 });
  await aliceClient.from('predictions').update({ points_earned: 99999 }).eq('user_id', alice.id).eq('match_id', TEST_MATCH);
  const { data: a1 } = await admin.from('predictions').select('points_earned').eq('user_id', alice.id).eq('match_id', TEST_MATCH).single();
  check('Update de points_earned → sem efeito (C1)', (a1?.points_earned ?? null) === null, `points_earned=${a1?.points_earned}`);

  log('blue', '\n[9] Alice chama compute_predicted_slots(bob) — IDOR do bracket (H1):');
  const r9 = await aliceClient.rpc('compute_predicted_slots', { p_user_id: bob.id });
  check('compute_predicted_slots alheio → negado (H1)', !!r9.error || (r9.data?.length ?? 0) === 0,
        r9.error ? '' : `retornou ${r9.data?.length} linhas do bracket alheio`);

  log('blue', '\n[10] Alice chama qualifier_bonus_for(bob) (H1):');
  const r10 = await aliceClient.rpc('qualifier_bonus_for', { p_user_id: bob.id });
  check('qualifier_bonus_for alheio → negado (H1)', !!r10.error, r10.error ? '' : 'PASSOU (vulnerável!)');

  log('blue', '\n[11] Alice chama recompute_* via RPC (H2 — DoS):');
  const r11a = await aliceClient.rpc('recompute_prediction_points', { p_match_id: null });
  const r11b = await aliceClient.rpc('recompute_qualifier_points', { p_user_id: null });
  check('recompute_prediction_points → negado (H2)', !!r11a.error, r11a.error ? '' : 'PASSOU (vulnerável!)');
  check('recompute_qualifier_points → negado (H2)', !!r11b.error, r11b.error ? '' : 'PASSOU (vulnerável!)');

  log('blue', '\n[12] Alice tenta escrever em settings / matches sem ser admin:');
  // Estado conhecido: garante match NÃO-finalizado antes do ataque (o banco local
  // pode tê-lo finalizado em rodadas anteriores). Sem isso, o check vira falso-positivo.
  await admin.from('matches').update({ finished: false }).eq('id', TEST_MATCH);
  const r12a = await aliceClient.from('settings').upsert({ key: 'fee_amount', value: 0 });
  await aliceClient.from('matches').update({ finished: true }).eq('id', TEST_MATCH);
  const { data: m1 } = await admin.from('matches').select('finished').eq('id', TEST_MATCH).single();
  check('Escrita em settings (não-admin) → bloqueada', !!r12a.error, r12a.error ? '' : 'PASSOU (vulnerável!)');
  check('Marcar match finished (não-admin) → sem efeito', m1?.finished === false, `finished=${m1?.finished} (ataque não foi bloqueado!)`);

  log('blue', '\n[13] Trilha de auditoria registra escrita em palpite (H3):');
  await admin.from('predictions').update({ pred_home: 5 }).eq('user_id', bob.id).eq('match_id', TEST_MATCH);
  const { data: audit } = await admin.from('prediction_audit').select('id')
    .eq('table_name', 'predictions').eq('row_user_id', bob.id).eq('match_id', TEST_MATCH);
  check('Mudança em palpite gera linha em prediction_audit (H3)', (audit?.length ?? 0) >= 1, `${audit?.length ?? 0} linhas`);

  log('blue', '\n[14] Alice (não-admin) NÃO lê o prediction_audit:');
  const { data: auditLeak } = await aliceClient.from('prediction_audit').select('id').limit(1);
  check('prediction_audit invisível a não-admin', (auditLeak?.length ?? 0) === 0, `viu ${auditLeak?.length} linhas`);

  console.log('');
  const allOk = checks.every(([, p]) => p);
  if (allOk) log('green', `${C.bold}🎉 RLS HOSTIL OK (${checks.length}/${checks.length}) — dados protegidos entre usuários${C.reset}`);
  else log('red', `${C.bold}⚠️ ${checks.filter(([, p]) => !p).length}/${checks.length} falharam — VULNERABILIDADE${C.reset}`);
}

main()
  .catch((e) => log('red', `\n❌ ${e.message}`))
  .finally(async () => { await teardown(); });

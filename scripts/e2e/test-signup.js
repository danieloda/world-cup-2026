#!/usr/bin/env node
// Sanity check: tenta signup + login imediato com user de teste.
// Se ambos funcionarem, "Confirm email" esta desligado e o E2E pode rodar.

import { makeClient, signupViaApi, loginAs } from './lib/supabase-client.js';

const TIMESTAMP = Date.now();
const CANDIDATES = [
  `test-${TIMESTAMP}@testuser.com`,
  `test-${TIMESTAMP}@bolao.test`,
  `bolao.test.${TIMESTAMP}@gmail.com`,
  `test-${TIMESTAMP}@mailinator.com`,
];
const PASSWORD = 'TestUser2026!';

async function tryEmail(client, email) {
  try {
    const user = await signupViaApi(client, email, PASSWORD, 'Sanity Test');
    return { ok: true, user, email };
  } catch (e) {
    return { ok: false, error: e.message, email };
  }
}

async function main() {
  console.log(`🧪 Testando 4 dominios de email...`);
  const client = makeClient();

  let user, EMAIL;
  for (const candidate of CANDIDATES) {
    console.log(`\n   Tentando ${candidate}...`);
    const r = await tryEmail(client, candidate);
    if (r.ok) {
      user = r.user;
      EMAIL = r.email;
      console.log(`   ✓ ACEITO: id=${user.id}, email_confirmed_at=${user.email_confirmed_at ?? 'NULL'}`);
      break;
    }
    console.log(`   ✗ ${r.error}`);
  }

  if (!user) {
    console.error('\n❌ Nenhum dominio funcionou. Verifique config do Supabase Auth.');
    process.exit(1);
  }

  // Confirma email via admin RPC (precisa estar logado como admin)
  console.log(`\n🔓 Confirmando email via admin_confirm_test_emails()...`);
  await client.auth.signOut();
  await client.auth.signInWithPassword({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  const { data: confirmed, error: cErr } = await client.rpc('admin_confirm_test_emails', { p_pattern: 'test-%@testuser.com' });
  if (cErr) {
    console.error(`✗ RPC falhou: ${cErr.message}`);
    process.exit(1);
  }
  console.log(`   ✓ ${confirmed} email(s) confirmado(s)`);
  await client.auth.signOut();

  // Tenta login imediato
  await client.auth.signOut();
  try {
    const loginUser = await loginAs(client, EMAIL, PASSWORD);
    console.log(`✓ Login imediato OK: id=${loginUser.id}`);
    console.log(`\n✅ "Confirm email" esta OFF. Signup automatico funciona pro E2E.`);

    // Limpa user de teste
    console.log(`\n🗑️  Limpando user de teste...`);
    // Nao da pra apagar auth.users sem service_role. So apago o profile (cascata)
    await client.from('profiles').delete().eq('id', loginUser.id);
    console.log(`   profile deletado (auth.users pode ficar como zombie, mas nao atrapalha)`);
  } catch (e) {
    console.error(`✗ Login falhou: ${e.message}`);
    if (e.message.includes('not confirmed') || e.message.includes('confirm')) {
      console.error(`\n⚠ "Confirm email" provavelmente esta ON. Precisamos desativar ou usar admin API.`);
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

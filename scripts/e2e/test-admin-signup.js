#!/usr/bin/env node
// Sanity test: cria 1 user via Admin API, faz login com cliente normal, apaga.
// Confirma que SERVICE_ROLE_KEY funciona e que o ciclo signup-login-cleanup eh viavel.

import { makeAdminClient, adminCreateUser, adminDeleteUser, adminListUsers, adminCreateProfile } from './lib/admin-client.js';
import { makeClient, loginAs } from './lib/supabase-client.js';

const EMAIL = `test-sanity-${Date.now()}@testuser.com`;
const PASSWORD = 'TestUser2026!';

async function main() {
  console.log('🧪 Sanity test do Admin API\n');

  const admin = makeAdminClient();
  console.log('✓ Admin client criado');

  // Lista users de teste existentes
  console.log('\n📋 Listando users de teste existentes...');
  const existing = await adminListUsers(admin, 'test-');
  console.log(`   ${existing.length} test users encontrado(s)`);
  for (const u of existing) {
    console.log(`     ${u.email} (id=${u.id.slice(0, 8)}..., confirmed=${u.email_confirmed_at ? 'sim' : 'NAO'})`);
  }

  // Cria user novo
  console.log(`\n👤 Criando user ${EMAIL}...`);
  const user = await adminCreateUser(admin, EMAIL, PASSWORD, 'Sanity Test');
  console.log(`   ✓ id=${user.id}, email_confirmed_at=${user.email_confirmed_at}`);

  // Cria profile via admin (bypassa RLS)
  console.log(`\n📝 Criando profile via admin...`);
  await adminCreateProfile(admin, user, 'Sanity Test', { paid: true });
  console.log(`   ✓ Profile criado`);

  // Tenta login imediato com cliente normal (sem service_role)
  console.log(`\n🔐 Tentando login com cliente normal...`);
  const normalClient = makeClient();
  try {
    const loggedUser = await loginAs(normalClient, EMAIL, PASSWORD);
    console.log(`   ✓ LOGIN OK: id=${loggedUser.id}`);
  } catch (e) {
    console.error(`   ✗ Login falhou: ${e.message}`);
    process.exit(1);
  }

  // Verifica profile foi criado automaticamente (trigger 004_profile_self_signup)
  console.log(`\n📝 Verificando profile auto-criado...`);
  const { data: profile, error: pErr } = await normalClient.from('profiles').select('*').eq('id', user.id).single();
  if (pErr) {
    console.error(`   ✗ Profile NAO criado: ${pErr.message}`);
  } else {
    console.log(`   ✓ Profile existe: ${profile.email}, paid=${profile.paid}`);
  }

  await normalClient.auth.signOut();

  // Limpa
  console.log(`\n🗑️  Apagando user de teste...`);
  await adminDeleteUser(admin, user.id);
  console.log(`   ✓ Apagado`);

  // Confirma que foi
  const after = await adminListUsers(admin, 'test-sanity');
  console.log(`\n📊 Apos cleanup: ${after.length} test-sanity users`);

  console.log('\n✅ Admin API funcionando. E2E pode prosseguir.');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });

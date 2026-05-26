#!/usr/bin/env node
// Testa o ciclo: confirm existing test user → login.
// Usa users ja criados anteriormente (pulando o rate limit do signup).

import { makeClient, loginAs } from './lib/supabase-client.js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

async function main() {
  const client = makeClient();

  // Login admin
  console.log('🔐 Logando como admin...');
  await client.auth.signInWithPassword({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });

  // Confirma todos os emails de teste
  console.log('\n🔓 Confirmando emails de teste...');
  const { data: count, error } = await client.rpc('admin_confirm_test_emails', { p_pattern: 'test-%@testuser.com' });
  if (error) {
    console.error('✗ RPC falhou:', error.message);
    process.exit(1);
  }
  console.log(`   ✓ ${count} email(s) confirmado(s)`);

  await client.auth.signOut();

  // Lista users de teste pra tentar login
  const emails = ['test-1779766917784@testuser.com'];
  const PASSWORD = 'TestUser2026!';

  for (const email of emails) {
    console.log(`\n🧪 Tentando login com ${email}...`);
    try {
      const user = await loginAs(client, email, PASSWORD);
      console.log(`   ✓ LOGIN OK: id=${user.id}, email_confirmed_at=${user.email_confirmed_at}`);
      console.log('\n✅ Ciclo funcionando: signup + admin_confirm + login.');
      await client.auth.signOut();
      return;
    } catch (e) {
      console.error(`   ✗ Login falhou: ${e.message}`);
    }
  }

  console.error('\n❌ Nenhum login funcionou.');
  process.exit(1);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

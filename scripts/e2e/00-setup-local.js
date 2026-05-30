#!/usr/bin/env node
/**
 * Fase 0: bootstrap do admin no DB LOCAL.
 * Cria o usuario admin (auth + profile is_admin/paid) usando ADMIN_EMAIL/ADMIN_PASSWORD do .env.
 * Idempotente: se ja existir, garante o profile correto.
 *
 * Requer env locais setados (SUPABASE_URL=http://127.0.0.1:54321 + SERVICE_ROLE local).
 * Uso: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/e2e/00-setup-local.js
 */
import { makeAdminClient } from './lib/admin-client.js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('ADMIN_EMAIL/ADMIN_PASSWORD ausentes no .env');

const admin = makeAdminClient();

// Procura user existente
const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 200 });
if (listErr) throw listErr;
let user = list.users.find((u) => u.email === EMAIL);

if (!user) {
  const { data, error } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { full_name: 'Admin (local)' },
  });
  if (error) throw error;
  user = data.user;
  console.log(`✅ admin auth criado: ${EMAIL} (${user.id})`);
} else {
  console.log(`ℹ️  admin auth ja existe: ${EMAIL} (${user.id})`);
}

const { error: upErr } = await admin.from('profiles').upsert({
  id: user.id, full_name: 'Admin (local)', email: EMAIL,
  is_admin: true, paid: true, paid_at: new Date().toISOString(),
}, { onConflict: 'id' });
if (upErr) throw upErr;
console.log('✅ profile admin garantido (is_admin=true, paid=true)');

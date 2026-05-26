// Cliente admin com SERVICE_ROLE_KEY. Bypassa RLS e rate limits.
// USAR APENAS em scripts E2E/admin local. NUNCA exposar essa key no frontend.

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '..', '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY nao encontrado em .env');
}

export function makeAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Cria user via Admin API (email confirmado, sem rate limit).
 * Bypassa o flow normal de signup.
 *
 * @returns { id, email, created_at }
 */
export async function adminCreateUser(adminClient, email, password, fullName) {
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,  // ja confirma
    user_metadata: { full_name: fullName },
  });
  if (error) throw new Error(`adminCreateUser ${email}: ${error.message}`);
  return data.user;
}

/**
 * Apaga user via Admin API (CASCADE limpa profile e dados).
 */
export async function adminDeleteUser(adminClient, userId) {
  const { error } = await adminClient.auth.admin.deleteUser(userId);
  if (error) throw new Error(`adminDeleteUser ${userId}: ${error.message}`);
}

/**
 * Cria profile pra user (admin bypassa RLS).
 * Por padrao paid=false, is_admin=false.
 */
export async function adminCreateProfile(adminClient, user, fullName, options = {}) {
  const { error } = await adminClient.from('profiles').insert({
    id: user.id,
    full_name: fullName,
    email: user.email,
    is_admin: options.is_admin ?? false,
    paid: options.paid ?? false,
  });
  if (error) throw new Error(`adminCreateProfile ${user.email}: ${error.message}`);
}

/**
 * Lista users com pattern de email.
 */
export async function adminListUsers(adminClient, pattern = 'test-') {
  const { data, error } = await adminClient.auth.admin.listUsers({ perPage: 200 });
  if (error) throw new Error(`adminListUsers: ${error.message}`);
  return data.users.filter((u) => u.email && u.email.startsWith(pattern));
}

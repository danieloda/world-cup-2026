// Cliente Supabase compartilhado pelo E2E orchestrator.
// Cada user de teste tem sua propria sessao.

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '..', '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

export function makeClient() {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function loginAs(client, email, password) {
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Login ${email}: ${error.message}`);
  const { data: { user } } = await client.auth.getUser();
  return user;
}

export async function signupViaApi(client, email, password, fullName) {
  // Tenta signup direto. Se falhar (email exists), tenta login.
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });
  if (error) {
    if (error.message.includes('already registered')) {
      // Email ja existe: faz login
      return await loginAs(client, email, password);
    }
    throw new Error(`Signup ${email}: ${error.message}`);
  }
  return data.user;
}

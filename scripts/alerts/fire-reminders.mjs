// Dispara os lembretes reais (palpites travando ≤24h/1-3d + campeão/artilheiro)
// chamando as funções cron via RPC com o SERVICE_ROLE (sem precisar de login admin).
// As funções são SECURITY DEFINER e sem guard interno de is_admin.
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('❌ faltando SUPABASE_URL/SERVICE_ROLE_KEY'); process.exit(1); }

const sb = createClient(url, key, { auth: { persistSession: false } });
const fns = ['cron_alert_group_completeness', 'cron_alert_cs_completeness'];

for (const fn of fns) {
  process.stdout.write(`📤 ${fn}() ... `);
  const { error } = await sb.rpc(fn);
  console.log(error ? `✗ ${error.message}` : '✓ disparado');
  if (error) process.exitCode = 1;
  await new Promise((r) => setTimeout(r, 1200));
}
console.log('\nConfere no Telegram do bolão. (silencioso se ninguém tiver pendência)');

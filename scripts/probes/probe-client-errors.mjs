// Probe READ-ONLY (prod): detalhes dos client_errors das últimas 48h.
// Investigação do alerta diário "Erros do app" — o site publica src/ sem
// minificar, então linha:coluna do stack batem 1:1 com o source.
// Uso: node scripts/probes/probe-client-errors.mjs
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createClient } from '@supabase/supabase-js';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes no .env');

const db = createClient(url, key, { auth: { persistSession: false } });

const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
const { data, error } = await db
  .from('client_errors')
  .select('*')
  .gte('created_at', since)
  .order('created_at', { ascending: false });
if (error) throw new Error(`client_errors: ${error.message}`);

console.log(`=== client_errors desde ${since} — ${data.length} linha(s) ===`);
for (const row of data) {
  console.log(JSON.stringify(row, null, 2));
  console.log('---');
}

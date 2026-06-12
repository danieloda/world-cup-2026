import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data, error } = await sb.from('alert_log')
  .select('created_at, category, severity, title')
  .order('created_at', { ascending: false }).limit(8);
if (error) { console.error('✗', error.message); process.exit(1); }
for (const r of data) console.log(`${r.created_at}  [${r.category}]  ${r.title}`);

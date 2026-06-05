#!/usr/bin/env node
/**
 * Insere odds fictícias em 3 partidas para validar visualmente a UI.
 * Use apenas para demo — `node scripts/fetch-odds.js` vai sobrescrever
 * com as odds reais assim que a Betano publicá-las.
 *
 * Para remover: DELETE FROM match_odds WHERE bookmaker_name = 'Betano (demo)';
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const demo = [
  // (Brazil x Morocco) — favoritismo claro do Brasil
  { match_id: 13, odd_home: 1.45, odd_draw: 4.50, odd_away: 7.50 },
  // (USA x Paraguay) — equilibrado
  { match_id: 19, odd_home: 2.10, odd_draw: 3.30, odd_away: 3.40 },
  // (Argentina x Algeria) — Argentina favorita
  { match_id: 55, odd_home: 1.55, odd_draw: 4.20, odd_away: 6.00 },
];

const rows = demo.map(d => ({
  ...d,
  bookmaker_id: 32,
  bookmaker_name: 'Betano (demo)',
  api_updated_at: new Date().toISOString(),
  fetched_at: new Date().toISOString(),
}));

const { error } = await admin.from('match_odds').upsert(rows, { onConflict: 'match_id' });
if (error) { console.error(error); process.exit(1); }
console.log(`✓ Demo odds inseridas para matches ${demo.map(d => d.match_id).join(', ')}`);

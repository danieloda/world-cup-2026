#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_PUBLISHABLE_KEY
);

async function checkDb() {
  console.log('Querying database...\n');

  const tables = ['profiles', 'predictions', 'champion_picks', 'top_scorer_picks', 'player_goals', 'matches', 'players', 'settings'];

  for (const table of tables) {
    const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    if (error) {
      console.log(`${table}: ERROR - ${error.message}`);
    } else {
      console.log(`${table}: ${count} rows`);
    }
  }

  // Show profiles detail
  console.log('\n--- Profiles ---');
  const { data: profiles } = await supabase.from('profiles').select('id, full_name, email, is_admin, paid');
  if (profiles) {
    profiles.forEach(p => console.log(`  ${p.full_name} (${p.email}) - admin:${p.is_admin} paid:${p.paid}`));
  }

  // Show match stats
  console.log('\n--- Matches ---');
  const { data: matches } = await supabase.from('matches').select('stage, finished');
  if (matches) {
    const finished = matches.filter(m => m.finished).length;
    const byStage = matches.reduce((acc, m) => { acc[m.stage] = (acc[m.stage] || 0) + 1; return acc; }, {});
    console.log(`  Total: ${matches.length}, Finished: ${finished}`);
    console.log(`  By stage:`, byStage);
  }
}

checkDb().catch(console.error);

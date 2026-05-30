// Backfilla em player_goals os scorers que o oráculo (expected-tournament.json)
// previu mas que não entraram no DB (gap intermitente do helper no step 4).
// Idempotente: só insere o que falta.
import { makeAdminClient } from './lib/admin-client.js';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url'; import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const admin = makeAdminClient();
const tour = JSON.parse(readFileSync(join(__dirname,'expected-tournament.json'),'utf8'));
const { data: existing } = await admin.from('player_goals').select('match_id, player_id, goals');
const haveKey = new Set((existing||[]).map(g => `${g.match_id}:${g.player_id}`));

const toInsert = [];
for (const m of tour.matches) {
  for (const s of (m.scorers||[])) {
    if (!haveKey.has(`${m.id}:${s.player_id}`)) {
      toInsert.push({ match_id: m.id, player_id: s.player_id, goals: s.goals });
    }
  }
}
console.log(`Scorers no oráculo ausentes no DB: ${toInsert.length}`);
for (const r of toInsert) console.log(`  match #${r.match_id} player ${r.player_id} (${r.goals}g)`);
if (toInsert.length) {
  const { error } = await admin.from('player_goals').insert(toInsert);
  if (error) { console.error('insert error:', error.message); process.exit(1); }
  console.log('✓ inseridos');
}
const totalNow = (await admin.from('player_goals').select('goals')).data.reduce((s,g)=>s+g.goals,0);
console.log(`Total de gols atribuídos agora: ${totalNow}`);

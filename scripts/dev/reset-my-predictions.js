#!/usr/bin/env node
/**
 * Zera os palpites de RESULTADOS (tabela predictions) de UM usuário.
 * PRESERVA champion_picks (campeão) e top_scorer_picks (artilheiro).
 *
 * Uso:
 *   node scripts/dev/reset-my-predictions.js <email> --dry-run
 *   node scripts/dev/reset-my-predictions.js <email> --force
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const email = process.argv[2];
const force = process.argv.includes('--force');
if (!email) {
  console.error('Faltou o email. Uso: node scripts/dev/reset-my-predictions.js <email> [--force]');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: profile, error: pErr } = await sb
  .from('profiles')
  .select('id, email, full_name')
  .eq('email', email)
  .single();
if (pErr || !profile) {
  console.error('Perfil não encontrado para', email, pErr?.message || '');
  process.exit(1);
}

const uid = profile.id;
const [{ count: preds }, { count: champ }, { count: scorer }] = await Promise.all([
  sb.from('predictions').select('*', { count: 'exact', head: true }).eq('user_id', uid),
  sb.from('champion_picks').select('*', { count: 'exact', head: true }).eq('user_id', uid),
  sb.from('top_scorer_picks').select('*', { count: 'exact', head: true }).eq('user_id', uid),
]);

console.log(`Usuário: ${profile.full_name || profile.email} (${uid})`);
console.log(`  predictions (palpites de resultado): ${preds}  -> serão APAGADOS`);
console.log(`  champion_picks (campeão): ${champ}  -> MANTIDO`);
console.log(`  top_scorer_picks (artilheiro): ${scorer}  -> MANTIDO`);

if (!force) {
  console.log('\n[dry-run] Nada apagado. Rode com --force para confirmar.');
  process.exit(0);
}

const { error: dErr, count: deleted } = await sb
  .from('predictions')
  .delete({ count: 'exact' })
  .eq('user_id', uid);
if (dErr) {
  console.error('Erro ao apagar:', dErr.message);
  process.exit(1);
}
console.log(`\n✅ Apagados ${deleted} palpites de resultado. Campeão e artilheiro preservados.`);

#!/usr/bin/env node
/**
 * seed-my-account.js — cria/garante UMA conta de jogador ("minha conta") no DB LOCAL
 * com TODOS os palpites preenchidos (placar 0-3 semi-aleatório, determinístico) +
 * palpite de campeão + artilheiro. Pensado pra VISUALIZAR a tela de mata-mata com
 * um mix realista de acertos/erros contra os resultados oficiais.
 *
 * NUNCA toca prod: makeAdminClient() aborta se SUPABASE_URL não for local.
 *
 * Uso (com env local carregado):
 *   set -a; source .env.e2e.local; set +a
 *   node scripts/e2e/seed-my-account.js [--email=eu@local.test] [--password=Palpite2026!]
 */
import { makeAdminClient, adminCreateProfile } from './lib/admin-client.js';
import { makeRng } from './lib/prng.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const EMAIL = args.email || 'eu@local.test';
const PASSWORD = args.password || 'Palpite2026!';
const FULL_NAME = 'Você (local)';

const admin = makeAdminClient();          // aborta se não for local
const rng = makeRng('minha-conta-v1');    // determinístico → reprodutível

// 1. user (cria ou reaproveita)
const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 500 });
if (listErr) throw listErr;
let user = list.users.find((u) => u.email === EMAIL);
if (!user) {
  const { data, error } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { full_name: FULL_NAME },
  });
  if (error) throw error;
  user = data.user;
  console.log(`✅ conta criada: ${EMAIL} (${user.id})`);
} else {
  await admin.auth.admin.updateUserById(user.id, { password: PASSWORD });
  console.log(`ℹ️  conta já existe, senha redefinida: ${EMAIL} (${user.id})`);
}

// 2. profile (paid → entra no ranking/relatórios)
const { error: profErr } = await admin.from('profiles').upsert({
  id: user.id, full_name: FULL_NAME, email: EMAIL,
  avatar_url: 'assets/avatars/daniel.png',   // pula o gate de foto do onboarding
  is_admin: false, paid: true, paid_at: new Date().toISOString(),
}, { onConflict: 'id' });
if (profErr) throw profErr;
console.log('✅ profile garantido (paid=true)');

// 3. palpites: TODOS os 104 jogos, placar 0-3 semi-aleatório (determinístico)
const { data: matches, error: mErr } = await admin
  .from('matches').select('id, stage').order('id');
if (mErr) throw mErr;

const preds = matches.map((m) => {
  const ph = Math.floor(rng() * 4);
  const pa = Math.floor(rng() * 4);
  const isKO = m.stage !== 'group';
  const pen = isKO && ph === pa ? (rng() < 0.5 ? 'home' : 'away') : null;
  return { user_id: user.id, match_id: m.id, pred_home: ph, pred_away: pa, pred_pen_winner: pen };
});
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
for (const c of chunk(preds, 500)) {
  const { error } = await admin.from('predictions').upsert(c, { onConflict: 'user_id,match_id' });
  if (error) throw new Error('predictions: ' + error.message);
}
console.log(`✅ ${preds.length} palpites de placar gravados (todos os jogos)`);

// 4. campeão + artilheiro (usa o oráculo → palpites "certos", pra ter o que pontuar)
const oracle = JSON.parse(readFileSync(join(__dirname, 'expected-tournament.json'), 'utf8'));
const { error: cErr } = await admin.from('champion_picks')
  .upsert({ user_id: user.id, team: oracle.champion }, { onConflict: 'user_id' });
if (cErr) throw new Error('champion: ' + cErr.message);
const { error: sErr } = await admin.from('top_scorer_picks')
  .upsert({ user_id: user.id, player_id: oracle.topScorer.player_id }, { onConflict: 'user_id' });
if (sErr) throw new Error('scorer: ' + sErr.message);
console.log(`✅ campeão=${oracle.champion}  artilheiro=${oracle.topScorer.full_name}`);

console.log(`\n🔑 Login local:  ${EMAIL}  /  ${PASSWORD}`);

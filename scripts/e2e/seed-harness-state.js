#!/usr/bin/env node
/**
 * seed-harness-state.js — Estado do GOLDEN-PATH via DB (rápido), sem a UI lenta.
 * ============================================================================
 * Replica o que 01-generate + 03-palpitar + 04-admin-results produzem, mas 100%
 * no DB: cria os 10 usuários do harness (test-<key>-2026@testuser.com, nomes de
 * test-users.json), gera os palpites de cada um contra o ORÁCULO DO HARNESS
 * (seed wc2026-e2e-v1) e JOGA o torneio (resultados + gols + scoring via trigger).
 *
 * É o pré-requisito dos testes de asserção do golden-path (test-historico-scorer,
 * test-rank-chart, test-admin-ui-penalty), que dependem dos usuários e dos
 * cenários específicos desse oráculo (ex.: artilheiro marca na final).
 *
 * USO: source .env.e2e.local && node scripts/e2e/seed-harness-state.js
 * Guard-rail: aborta se a URL não for local.
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { makeAdminClient, adminCreateUser, adminCreateProfile } from './lib/admin-client.js';
import { simulateTournament } from './lib/tournament-simulator.js';
import { genPrediction, genChampionPick, genScorerPick } from './lib/predictions.js';
import { makeRng } from './lib/prng.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const CID = 'supabase_db_world-cup-2026';
const SEED = 'wc2026-e2e-v1';           // oráculo do harness (mesmo de 01-generate)
const PASSWORD = 'TestUser2026!';
const C = { g: '\x1b[32m', b: '\x1b[34m', y: '\x1b[33m', x: '\x1b[0m', bold: '\x1b[1m' };
const log = (c, m) => console.log(`${C[c]}${m}${C.x}`);
const psql = (sql) => execFileSync('docker', ['exec', '-i', CID, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'],
  { input: 'set client_min_messages = warning;\n' + sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const admin = makeAdminClient();
log('b', `${C.bold}🎯 Seed do estado golden-path (harness) via DB${C.x}`);

// 1. oráculo do harness
const { data: matches } = await admin.from('matches').select('id, stage, group_name, team_home, team_away, slot_home, slot_away, match_date').order('id');
let players = [], pg = 0;
while (true) { const { data } = await admin.from('players').select('id, full_name, team, position').range(pg * 1000, pg * 1000 + 999); players = players.concat(data); if (data.length < 1000) break; pg++; }
const koDirty = matches.filter((m) => m.stage !== 'group' && m.slot_home && m.team_home !== m.slot_home);
if (koDirty.length) { log('y', `   ⚠ matches não estão em estado pré-torneio (${koDirty.length} KO resolvidos). Rode bootstrap-local.sh primeiro.`); process.exit(1); }
const oracle = simulateTournament(matches, players, SEED);
const oById = new Map(oracle.matches.map((m) => [m.id, m]));
// Escreve o oráculo no disco (= o que o playout aplica). Os testes de asserção do
// golden-path (ex.: test-admin-ui-penalty lê o placar de re-lançamento) consomem
// este arquivo — sem isto ele teria o oráculo SIM (outro seed) e divergiria do DB.
writeFileSync(join(__dirname, 'expected-tournament.json'), JSON.stringify(oracle, null, 2));
log('g', `   ✓ oráculo: campeão=${oracle.champion}, artilheiro=${oracle.topScorer?.full_name} (${oracle.topScorer?.total_goals}g)`);

// 2. usuários do harness (test-users.json)
const profiles = JSON.parse(readFileSync(join(__dirname, 'test-users.json'), 'utf8')).users;
const allTeams = [...new Set(matches.filter((m) => m.stage === 'group').flatMap((m) => [m.team_home, m.team_away]))];
const { data: existing } = await admin.auth.admin.listUsers({ perPage: 1000 });
for (const u of (existing?.users || [])) if (u.email?.includes('-2026@testuser.com')) await admin.auth.admin.deleteUser(u.id);

const preds = [], champs = [], scorers = [];
for (const p of profiles) {
  const email = `test-${p.key}-2026@testuser.com`;
  const user = await adminCreateUser(admin, email, PASSWORD, p.name);
  await adminCreateProfile(admin, user, p.name, { paid: p.paid, avatar_url: 'assets/avatars/daniel.png' });
  const rng = makeRng(`user-${p.key}-v1`);
  for (const m of oracle.matches) {
    const pred = genPrediction({ id: m.id, stage: m.stage }, m, p.strategy, rng);
    if (pred) preds.push({ user_id: user.id, match_id: m.id, pred_home: pred.pred_home, pred_away: pred.pred_away, pred_pen_winner: pred.pred_pen_winner });
  }
  const champ = genChampionPick(p.champion, oracle.champion, allTeams, rng);
  if (champ) champs.push({ user_id: user.id, team: champ });
  const sc = genScorerPick(p.topScorer, oracle.topScorer, players, rng);
  if (sc) scorers.push({ user_id: user.id, player_id: sc });
}
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
for (const c of chunk(preds, 500)) { const { error } = await admin.from('predictions').upsert(c, { onConflict: 'user_id,match_id' }); if (error) throw error; }
for (const c of chunk(champs, 500)) { const { error } = await admin.from('champion_picks').upsert(c, { onConflict: 'user_id' }); if (error) throw error; }
for (const c of chunk(scorers, 500)) { const { error } = await admin.from('top_scorer_picks').upsert(c, { onConflict: 'user_id' }); if (error) throw error; }
log('g', `   ✓ 10 usuários do harness + ${preds.length} palpites`);

// 3. playout do oráculo do harness (resultados + gols; triggers de negócio pontuam)
// result_corrected, champion_revealed e ko_phase_opens foram removidos na migration 053.
const ALERT = ['trg_z_alert_match_status', 'trg_z_alert_orphan_predictions', 'trg_z_alert_result_confirmed', 'trg_z_alert_unresolved_slots'];
const ordered = oracle.matches.slice().sort((a, b) => new Date(matches.find((m) => m.id === a.id).match_date) - new Date(matches.find((m) => m.id === b.id).match_date));
// finished_at por ID (espelha a ordem de ENTRADA do golden-path real, onde o admin
// lança jogo a jogo): id maior = mais recente. O "launched" do admin ordena por
// finished_at DESC com cap 60 → a final (id 104) fica no topo e os jogos id≥45
// (inclui grupos como o M#50 do teste) entram nos 60. Com finished_at=match_date,
// os grupos (datas antigas) cairiam fora; com now() p/ todos, o sort empata.
const upd = ordered.map((m) => `update public.matches set actual_home=${m.actual_home}, actual_away=${m.actual_away}, pen_winner=${m.pen_winner ? `'${m.pen_winner}'` : 'null'}, finished=true, status='finished', finished_at=now() - interval '${104 - m.id} minutes' where id=${m.id};`);
const goals = [];
for (const m of oracle.matches) for (const s of (m.scorers || [])) goals.push(`(${s.player_id}, ${m.id}, ${s.goals})`);
psql([
  'begin;',
  ...ALERT.map((t) => `alter table public.matches disable trigger ${t};`),
  // Time-warp -730 dias (igual 04-admin-results): joga as datas pro passado para
  // os jogos ficarem "revelados" (historico/ranking usam match_date <= now()) e os
  // prazos travados. Sem isso, finished=true mas data futura = jogo não revelado.
  "update public.matches set match_date = match_date - interval '730 days';",
  "update public.settings set value = '\"2020-01-01T00:00:00Z\"'::jsonb where key = 'deadline_champion_scorer';",
  ...upd,
  ...ALERT.map((t) => `alter table public.matches enable trigger ${t};`),
  `insert into public.player_goals (player_id, match_id, goals) values ${goals.join(',')} on conflict (player_id, match_id) do update set goals=excluded.goals;`,
  'commit;',
].join('\n'));
const fin = psql("select count(*) filter (where finished) from public.matches;").trim();
log('g', `   ✓ playout aplicado (${fin.split('\n').pop().trim()}/104 finalizados)`);
log('g', `\n${C.bold}✅ Estado golden-path pronto (usuários do harness + oráculo jogado).${C.x}`);

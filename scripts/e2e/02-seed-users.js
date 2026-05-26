#!/usr/bin/env node
/**
 * Step 2 do E2E: Cria 10 users de teste, gera predictions/picks por strategy.
 *
 * Read: scripts/e2e/test-users.json (perfis), expected-tournament.json (resultados)
 * Write: cria users via Admin API, INSERT predictions/picks via Admin API (bypassa RLS)
 * Output: scripts/e2e/user-tokens.json (id+email+token de cada user pra audit posterior)
 *
 * Uso: node scripts/e2e/02-seed-users.js
 *      node scripts/e2e/02-seed-users.js --only=perfect    # so 1 user
 *      node scripts/e2e/02-seed-users.js --dry-run          # nao escreve no DB
 */

import { makeAdminClient, adminCreateUser, adminCreateProfile, adminListUsers, adminDeleteUser } from './lib/admin-client.js';
import { genPrediction, genChampionPick, genScorerPick } from './lib/predictions.js';
import { makeRng } from './lib/prng.js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_USERS_PATH = join(__dirname, 'test-users.json');
const TOURNAMENT_PATH = join(__dirname, 'expected-tournament.json');
const OUTPUT_TOKENS = join(__dirname, 'user-tokens.json');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const DRY_RUN = args['dry-run'] === true;
const ONLY = args.only || null;

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c]}${m}${C.reset}`);

const PASSWORD = 'TestUser2026!';

async function main() {
  log('blue', `${C.bold}👥 Step 2: Seed 10 test users + predictions${C.reset}`);
  if (DRY_RUN) log('yellow', '   DRY-RUN ATIVADO');
  if (ONLY) log('blue', `   Filtro: --only=${ONLY}`);

  const admin = makeAdminClient();
  const testUsers = JSON.parse(readFileSync(TEST_USERS_PATH, 'utf8')).users;
  const tournament = JSON.parse(readFileSync(TOURNAMENT_PATH, 'utf8'));

  // Limpa test users existentes ANTES (caso reseed)
  log('blue', '\n🗑️  Removendo test users anteriores (caso existam)...');
  const existing = await adminListUsers(admin, 'test-');
  if (DRY_RUN) {
    log('yellow', `   Seriam apagados: ${existing.length}`);
  } else {
    for (const u of existing) {
      await adminDeleteUser(admin, u.id);
    }
    log('green', `   ✓ ${existing.length} apagados`);
  }

  // Lista de teams (pra champion pick non_winner)
  const allTeams = [...new Set(tournament.matches.filter(m => m.stage === 'group').flatMap(m => [m.team_home, m.team_away]))];

  // Carrega players (pra scorer pick no_goals)
  const { data: players } = await admin.from('players').select('id, full_name, team, position');

  const tokens = [];
  let usersToProcess = testUsers;
  if (ONLY) usersToProcess = testUsers.filter((u) => u.key === ONLY);

  // Processa cada user
  for (let i = 0; i < usersToProcess.length; i++) {
    const profile = usersToProcess[i];
    const tag = `[${i + 1}/${usersToProcess.length}]`;
    log('blue', `\n${tag} ${C.bold}${profile.key}${C.reset} ${C.blue}(${profile.name})${C.reset}`);
    log('dim', `       ${profile.expected_summary}`);

    const email = `test-${profile.key}-2026@testuser.com`;
    const rng = makeRng(`user-${profile.key}-v1`);

    if (DRY_RUN) {
      log('yellow', `       DRY-RUN: criaria user ${email}, paid=${profile.paid}, strategy=${profile.strategy}`);
      continue;
    }

    // 1. Cria user via Admin API
    const user = await adminCreateUser(admin, email, PASSWORD, profile.name);
    log('green', `       ✓ User criado: ${user.id.slice(0, 8)}...`);

    // 2. Cria profile
    await adminCreateProfile(admin, user, profile.name, { paid: profile.paid });
    log('green', `       ✓ Profile criado (paid=${profile.paid})`);

    // 3. Gera predictions
    const predictions = [];
    for (const m of tournament.matches) {
      const pred = genPrediction(
        { id: m.id, stage: m.stage },
        { actual_home: m.actual_home, actual_away: m.actual_away, pen_winner: m.pen_winner },
        profile.strategy,
        rng
      );
      if (pred !== null) {
        predictions.push({
          match_id: m.id,
          pred_home: pred.pred_home,
          pred_away: pred.pred_away,
          pred_pen_winner: pred.pred_pen_winner,
        });
      }
    }

    // 4. Insere predictions em batch (admin bypassa RLS)
    if (predictions.length > 0) {
      const rows = predictions.map((p) => ({ ...p, user_id: user.id }));
      const { error: insErr } = await admin.from('predictions').insert(rows);
      if (insErr) {
        log('red', `       ✗ Insert predictions falhou: ${insErr.message}`);
        throw insErr;
      }
    }
    log('green', `       ✓ ${predictions.length}/104 predictions inseridas`);

    // 5. Champion pick
    const champTeam = genChampionPick(profile.champion, tournament.champion, allTeams, rng);
    if (champTeam) {
      const { error: cErr } = await admin.from('champion_picks').insert({ user_id: user.id, team: champTeam });
      if (cErr) {
        log('red', `       ✗ Champion pick falhou: ${cErr.message}`);
        throw cErr;
      }
      log('green', `       ✓ Champion: ${champTeam}`);
    } else {
      log('dim', `       - Sem champion pick (strategy=${profile.champion})`);
    }

    // 6. Top scorer pick
    const scorerId = genScorerPick(profile.topScorer, tournament.topScorer, players, rng);
    if (scorerId) {
      const { error: sErr } = await admin.from('top_scorer_picks').insert({ user_id: user.id, player_id: scorerId });
      if (sErr) {
        log('red', `       ✗ Scorer pick falhou: ${sErr.message}`);
        throw sErr;
      }
      const player = players.find((p) => p.id === scorerId);
      log('green', `       ✓ Top scorer: ${player.full_name} (${player.team})`);
    } else {
      log('dim', `       - Sem scorer pick (strategy=${profile.topScorer})`);
    }

    tokens.push({
      key: profile.key,
      name: profile.name,
      email,
      password: PASSWORD,
      user_id: user.id,
      profile: profile,
    });
  }

  // Salva tokens pra audit posterior
  if (!DRY_RUN) {
    writeFileSync(OUTPUT_TOKENS, JSON.stringify({ users: tokens }, null, 2));
    log('green', `\n✅ Tokens salvos em ${OUTPUT_TOKENS}`);
  }

  log('blue', `\n${C.bold}📊 Resumo${C.reset}`);
  log('green', `   ✓ ${tokens.length} users criados e populados`);
  if (DRY_RUN) {
    log('yellow', '   DRY-RUN: nada foi escrito no DB.');
  }
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

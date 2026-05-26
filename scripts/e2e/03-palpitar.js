#!/usr/bin/env node
/**
 * Step 3 do E2E: Cria 10 users (Admin API) + palpita via UI (Playwright).
 *
 * Read: expected-tournament.json, test-users.json
 * Write: cria users, escreve predictions/picks via UI no DB
 * Output: user-tokens.json, errors.json (tracker de todos os erros)
 *
 * Uso:
 *   node scripts/e2e/03-palpitar.js                  # todos os 10, headless
 *   node scripts/e2e/03-palpitar.js --headed         # com janela visivel
 *   node scripts/e2e/03-palpitar.js --only=perfect   # so 1 user
 *   node scripts/e2e/03-palpitar.js --dry-run        # nao escreve no DB
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';

import { makeAdminClient, adminCreateUser, adminCreateProfile, adminListUsers, adminDeleteUser } from './lib/admin-client.js';
import { genPrediction, genChampionPick, genScorerPick } from './lib/predictions.js';
import { makeRng } from './lib/prng.js';
import { ErrorTracker } from './lib/error-tracker.js';
import { login, fillGroupPredictions, fillKnockoutPredictions, fillChampionScorer } from './lib/playwright-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const TEST_USERS_PATH = join(__dirname, 'test-users.json');
const TOURNAMENT_PATH = join(__dirname, 'expected-tournament.json');
const OUTPUT_TOKENS = join(__dirname, 'user-tokens.json');
const ERRORS_PATH = join(__dirname, 'errors.json');
const SCREENSHOTS_DIR = join(__dirname, 'screenshots');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const HEADED = args.headed === true;
const ONLY = args.only || null;
const DRY_RUN = args['dry-run'] === true;
const PASSWORD = 'TestUser2026!';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c]}${m}${C.reset}`);

mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function checkServerUp() {
  try {
    const res = await fetch(`${BASE_URL}/login.html`);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureCleanTestUsers(admin) {
  log('blue', '🗑️  Limpando test users anteriores...');
  const existing = await adminListUsers(admin, 'test-');
  for (const u of existing) {
    if (u.email.includes('-2026@testuser.com')) {
      await adminDeleteUser(admin, u.id);
    }
  }
  log('green', `   ✓ ${existing.length} test users removidos`);
}

async function createUsers(admin, profiles, tournament) {
  log('blue', `\n👥 Criando ${profiles.length} test user(s) via Admin API...`);
  const tokens = [];
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    const email = `test-${p.key}-2026@testuser.com`;
    const tag = `[${i + 1}/${profiles.length}]`;

    const user = await adminCreateUser(admin, email, PASSWORD, p.name);
    await adminCreateProfile(admin, user, p.name, { paid: p.paid });

    tokens.push({
      key: p.key, name: p.name, email, password: PASSWORD,
      user_id: user.id, profile: p,
    });
    log('green', `   ${tag} ${p.key.padEnd(20)} ${email} → ${user.id.slice(0, 8)}...`);
  }
  return tokens;
}

function generatePredictionsForUser(profile, tournament) {
  const rng = makeRng(`user-${profile.key}-v1`);
  const predictions = [];
  for (const m of tournament.matches) {
    const pred = genPrediction(
      { id: m.id, stage: m.stage },
      { actual_home: m.actual_home, actual_away: m.actual_away, pen_winner: m.pen_winner },
      profile.strategy,
      rng,
    );
    if (pred !== null) {
      predictions.push({
        match_id: m.id,
        stage: m.stage,
        pred_home: pred.pred_home,
        pred_away: pred.pred_away,
        pred_pen_winner: pred.pred_pen_winner,
      });
    }
  }
  // Champion / scorer
  const allTeams = [...new Set(tournament.matches.filter(m => m.stage === 'group').flatMap(m => [m.team_home, m.team_away]))];
  const championPick = genChampionPick(profile.champion, tournament.champion, allTeams, rng);

  return { predictions, championPick, rngForScorer: rng };
}

async function fillUserViaUI(browser, token, tournament, players, tracker) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  tracker.attachPlaywright(page);
  tracker.setContext({ user_key: token.key });

  try {
    // 1. Login
    log('blue', `   🔐 Login...`);
    await login(page, token.email, token.password, tracker);
    log('green', `      ✓ Logado`);

    // 2. Gera predictions
    const { predictions, championPick, rngForScorer } = generatePredictionsForUser(token.profile, tournament);
    const groupPreds = predictions.filter(p => p.stage === 'group');
    const koPreds = predictions.filter(p => p.stage !== 'group');

    // 3. Palpitar grupos
    if (groupPreds.length > 0) {
      log('blue', `   📝 Palpitar ${groupPreds.length} grupos...`);
      await fillGroupPredictions(page, groupPreds, tracker);
      log('green', `      ✓ Grupos preenchidos`);
    } else {
      log('dim', `   - Sem palpites de grupo (strategy=${token.profile.strategy})`);
    }

    // 4. Palpitar mata-mata
    if (koPreds.length > 0) {
      log('blue', `   ⚔️  Palpitar ${koPreds.length} mata-mata...`);
      await fillKnockoutPredictions(page, koPreds, tracker);
      log('green', `      ✓ Mata-mata preenchido`);
    } else {
      log('dim', `   - Sem palpites de mata (strategy=${token.profile.strategy})`);
    }

    // 5. Champion / artilheiro
    const scorerPlayerId = genScorerPick(token.profile.topScorer, tournament.topScorer, players, rngForScorer);
    const scorerObj = scorerPlayerId ? (() => {
      const p = players.find((x) => x.id === scorerPlayerId);
      return p ? { id: p.id, team: p.team, name: p.full_name } : null;
    })() : null;
    if (championPick || scorerObj) {
      log('blue', `   🏆 Champion: ${championPick ?? '(skip)'}, ⚽ Scorer: ${scorerObj ? scorerObj.name + ' (' + scorerObj.team + ')' : '(skip)'}`);
      await fillChampionScorer(page, championPick, scorerObj, tracker);
      log('green', `      ✓ Bonus picks definidos`);
    } else {
      log('dim', `   - Sem champion/scorer (profile esquecimento)`);
    }

    // 6. Screenshot final
    await page.screenshot({ path: join(SCREENSHOTS_DIR, `${token.key}-final.png`), fullPage: false });
  } catch (e) {
    tracker.track('assertion', `Exception em fillUserViaUI: ${e.message}`, { stack: e.stack });
    await page.screenshot({ path: join(SCREENSHOTS_DIR, `${token.key}-ERROR.png`), fullPage: true });
    log('red', `   ✗ Erro: ${e.message}`);
  } finally {
    tracker.clearContext(['user_key']);
    await context.close();
  }
}

async function main() {
  log('blue', `${C.bold}🎭 Step 3: Palpitar via UI (Playwright)${C.reset}`);
  log('blue', `   Headless: ${!HEADED}`);
  log('blue', `   Base URL: ${BASE_URL}`);
  if (ONLY) log('yellow', `   Filtro: --only=${ONLY}`);
  if (DRY_RUN) log('yellow', '   DRY-RUN ATIVADO');

  // Pre-flight: server up?
  log('blue', '\n🩺 Verificando server localhost...');
  const up = await checkServerUp();
  if (!up) {
    log('red', `   ✗ Server não responde em ${BASE_URL}`);
    log('yellow', '   Inicie o server: npm start (ou seu comando equivalente) e rode novamente.');
    process.exit(1);
  }
  log('green', `   ✓ Server respondendo em ${BASE_URL}`);

  // Carrega artefatos
  const allProfiles = JSON.parse(readFileSync(TEST_USERS_PATH, 'utf8')).users;
  const tournament = JSON.parse(readFileSync(TOURNAMENT_PATH, 'utf8'));
  const profiles = ONLY ? allProfiles.filter(p => p.key === ONLY) : allProfiles;

  if (profiles.length === 0) {
    log('red', `   ✗ Nenhum perfil bate com filter --only=${ONLY}`);
    process.exit(1);
  }

  const admin = makeAdminClient();
  const tracker = new ErrorTracker(ERRORS_PATH);

  // Cleanup + criar users
  await ensureCleanTestUsers(admin);
  const tokens = await createUsers(admin, profiles, tournament);
  writeFileSync(OUTPUT_TOKENS, JSON.stringify({ users: tokens }, null, 2));

  // Carrega players (pra scorer pick)
  // Paginate (Supabase default limit = 1000)
  let players = [];
  let pPage = 0;
  while (true) {
    const { data } = await admin.from('players').select('id, full_name, team, position').range(pPage * 1000, (pPage + 1) * 1000 - 1);
    players = players.concat(data);
    if (data.length < 1000) break;
    pPage++;
  }

  // Lança Playwright
  log('blue', '\n🚀 Iniciando Playwright...');
  const browser = await chromium.launch({ headless: !HEADED });
  log('green', '   ✓ Browser iniciado');

  // Loop nos users
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    log('blue', `\n${C.bold}[${i + 1}/${tokens.length}] ${token.key}${C.reset} (${token.name})`);
    log('dim', `       ${token.profile.expected_summary}`);

    if (DRY_RUN) {
      log('yellow', '   DRY-RUN: pulando UI fill');
      continue;
    }

    const t0 = Date.now();
    await fillUserViaUI(browser, token, tournament, players, tracker);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log('green', `   ✓ Concluido em ${elapsed}s`);
  }

  await browser.close();
  log('blue', '\n🛑 Browser fechado');

  // Coleta alertas do DB
  log('blue', '\n📡 Coletando alertas do DB...');
  await tracker.pollDbAlerts(admin);

  // Print summary
  tracker.flush();
  tracker.print();

  log('green', `\n${C.bold}✅ Step 3 concluido. ${tokens.length} users palpitaram.${C.reset}`);
  log('blue', `   Tokens:      ${OUTPUT_TOKENS}`);
  log('blue', `   Errors:      ${ERRORS_PATH}`);
  log('blue', `   Screenshots: ${SCREENSHOTS_DIR}`);

  if (tracker.summary().total > 0) {
    log('yellow', `\n⚠ ${tracker.summary().total} erro(s) capturado(s). Veja ${ERRORS_PATH}`);
  }
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

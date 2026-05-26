#!/usr/bin/env node
/**
 * Step 4 do E2E: Simula deadline + admin lança 104 resultados via UI.
 *
 * Read: expected-tournament.json
 * Pre-step: UPDATE matches.match_date pro passado + settings.deadline pro passado
 * Then: Playwright loga como admin, vai pra admin.html, lança cada resultado pela UI
 *
 * Uso:
 *   node scripts/e2e/04-admin-results.js              # todos via UI, headless
 *   node scripts/e2e/04-admin-results.js --headed     # janela visivel
 *   node scripts/e2e/04-admin-results.js --limit=10   # só primeiros 10 matches
 *   node scripts/e2e/04-admin-results.js --skip-time-warp  # não simula passar deadline
 */

import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';

import { makeAdminClient } from './lib/admin-client.js';
import { ErrorTracker } from './lib/error-tracker.js';
import { login } from './lib/playwright-helpers.js';
import { openAdminResults, listPendingMatchIds, fillSingleResult, countPending } from './lib/admin-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const TOURNAMENT_PATH = join(__dirname, 'expected-tournament.json');
const ERRORS_PATH = join(__dirname, 'errors.json');
const SCREENSHOTS_DIR = join(__dirname, 'screenshots');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const HEADED = args.headed === true;
const LIMIT = args.limit ? parseInt(args.limit, 10) : null;
const SKIP_TIME_WARP = args['skip-time-warp'] === true;

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c]}${m}${C.reset}`);

mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function timeWarp(admin) {
  log('blue', '\n🕒 Time warp: simulando passagem do tempo...');

  // 1. Move deadline pro passado
  log('blue', '   Movendo deadline_champion_scorer pro passado...');
  const pastDate = '2020-01-01T00:00:00Z';
  const { error: dErr } = await admin
    .from('settings')
    .upsert({ key: 'deadline_champion_scorer', value: JSON.stringify(pastDate) });
  if (dErr) throw new Error('Update deadline: ' + dErr.message);
  log('green', `      ✓ deadline_champion_scorer = ${pastDate}`);

  // 2. Move match_date dos 104 jogos pra past (preserva ordem relativa)
  log('blue', '   Movendo match_date dos 104 jogos pro passado...');
  // Usa intervalo retroativo: subtrai 2 anos de cada match_date original
  // Como SUPABASE não permite UPDATE col = col - interval via API REST, uso RPC
  const { data: matches } = await admin.from('matches').select('id, match_date').order('id');
  const updates = matches.map((m) => ({
    id: m.id,
    match_date: new Date(new Date(m.match_date).getTime() - 730 * 86400000).toISOString(),
  }));
  // Update um por um (mais rápido seria batch upsert)
  let updated = 0;
  for (const u of updates) {
    const { error } = await admin.from('matches').update({ match_date: u.match_date }).eq('id', u.id);
    if (error) {
      log('yellow', `      ⚠ Update match #${u.id}: ${error.message}`);
    } else {
      updated++;
    }
  }
  log('green', `      ✓ ${updated}/104 match_date no passado`);
}

async function main() {
  log('blue', `${C.bold}🎬 Step 4: Admin lança resultados via UI${C.reset}`);
  log('blue', `   Headless: ${!HEADED}`);
  if (LIMIT) log('yellow', `   Limit: ${LIMIT} matches`);
  if (SKIP_TIME_WARP) log('yellow', '   Time warp DESATIVADO');

  const tournament = JSON.parse(readFileSync(TOURNAMENT_PATH, 'utf8'));
  const totalToProcess = LIMIT ?? tournament.matches.length;

  const admin = makeAdminClient();
  const tracker = new ErrorTracker(ERRORS_PATH);

  // 1. Time warp
  if (!SKIP_TIME_WARP) {
    await timeWarp(admin);
  } else {
    log('yellow', '\n⏭ Pulei time warp (--skip-time-warp). Admin bypassa RLS de qualquer forma.');
  }

  // 2. Lança Playwright
  log('blue', '\n🚀 Iniciando Playwright...');
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  tracker.attachPlaywright(page);
  tracker.setContext({ session: 'admin' });

  // 3. Login admin
  log('blue', '🔐 Login admin...');
  await login(page, ADMIN_EMAIL, ADMIN_PASSWORD, tracker);
  log('green', `   ✓ ${ADMIN_EMAIL}`);

  // 4. Vai pra admin/resultados
  log('blue', '\n📋 Abrindo admin → Resultados...');
  await openAdminResults(page);
  await page.screenshot({ path: join(SCREENSHOTS_DIR, 'admin-results-initial.png') });

  // 5. Loop: lança resultados em ordem ESTRITA de stage pra cascade dos triggers funcionar.
  // Ordem: group → r32 → r16 → qf → sf → third → final
  // Dentro de cada stage, ordem por id (que tem ordem cronologica).
  //
  // CRITICO: nao usar ordem de id porque grupos D,E,etc (ids tardios) terminariam DEPOIS
  // de KO R32 (ids 73+), e a resolucao de slots W##/L## quebraria.
  const STAGE_ORDER = { group: 1, r32: 2, r16: 3, qf: 4, sf: 5, third: 6, final: 7 };
  const matchesById = new Map(tournament.matches.map((m) => [m.id, m]));
  const allIds = [...matchesById.keys()].sort((a, b) => {
    const ma = matchesById.get(a);
    const mb = matchesById.get(b);
    return (STAGE_ORDER[ma.stage] - STAGE_ORDER[mb.stage]) || (a - b);
  });
  const idsToProcess = LIMIT ? allIds.slice(0, LIMIT) : allIds;

  log('blue', `\n🎯 Vou processar ${idsToProcess.length} matches...\n`);

  let processed = 0;
  let failed = 0;
  let currentStage = null;  // detecta mudança de stage pra fazer reload
  const t0 = Date.now();

  while (processed + failed < idsToProcess.length) {
    // Lista pending atualmente visiveis
    const pendingNow = await listPendingMatchIds(page);

    if (pendingNow.length === 0) {
      log('yellow', '   Nenhum pending visivel — refresh');
      await page.reload();
      await openAdminResults(page);
      const stillEmpty = (await listPendingMatchIds(page)).length === 0;
      if (stillEmpty) {
        log('yellow', '   Tudo processado segundo a UI. Encerrando loop.');
        break;
      }
      continue;
    }

    // Pega o proximo id da nossa lista que ainda esta pending
    const remainingIds = idsToProcess.filter((id) => !matchesById.get(id)._processed);
    const target = remainingIds.find((id) => pendingNow.includes(id));
    if (!target) {
      // Match que queremos nao esta na lista — talvez precisa scroll/refresh
      log('yellow', `   Próximo target (${remainingIds[0]}) não visível, refresh...`);
      await page.reload();
      await openAdminResults(page);
      continue;
    }

    const match = matchesById.get(target);

    // CRÍTICO: ao mudar de stage (group → r32 → r16 → ...), reload a UI pra
    // garantir que cache.matches do admin esteja com slots já resolvidos.
    if (match.stage !== currentStage) {
      log('yellow', `\n   ⟳ Mudando para stage "${match.stage}" — reload pra refrescar cache + esperar trigger...`);
      await page.waitForTimeout(2000);  // espera resolve_match_slots terminar
      await page.reload();
      await openAdminResults(page);
      currentStage = match.stage;
    }

    const tag = `[${processed + failed + 1}/${idsToProcess.length}]`;
    log('blue', `${tag} M#${target} (${match.stage}) ${match.team_home} ${match.actual_home}-${match.actual_away} ${match.team_away}${match.pen_winner ? ' [pen:' + match.pen_winner + ']' : ''}`);

    const result = await fillSingleResult(page, match, tracker);
    matchesById.get(target)._processed = true;
    if (result.ok) {
      processed++;
      log('green', `   ✓ OK`);
    } else {
      failed++;
      log('red', `   ✗ FALHOU${result.errReason ? ': ' + result.errReason : ''}`);
      // Screenshot do erro
      await page.screenshot({ path: join(SCREENSHOTS_DIR, `admin-err-m${target}.png`), fullPage: false });
    }

    // KO: reload depois de cada match pra garantir slots downstream
    if (match.stage !== 'group') {
      await page.waitForTimeout(500);  // espera trigger
      await page.reload();
      await openAdminResults(page);
    } else if ((processed + failed) % 25 === 0 && processed + failed < idsToProcess.length) {
      // Grupos: refresh a cada 25 pra trazer novos pending (UI cap em 30)
      log('dim', `   ⟳ Refresh (${processed + failed}/${idsToProcess.length})...`);
      await page.reload();
      await openAdminResults(page);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log('blue', `\n⏱  Total: ${elapsed}s`);
  log('green', `   ✓ ${processed} processados`);
  if (failed > 0) log('red', `   ✗ ${failed} falharam`);

  await page.screenshot({ path: join(SCREENSHOTS_DIR, 'admin-results-final.png'), fullPage: true });
  await browser.close();

  // 6. Coleta alertas DB
  log('blue', '\n📡 Coletando alertas do DB...');
  await tracker.pollDbAlerts(admin);

  tracker.flush();
  tracker.print();

  // 7. Verifica DB final
  log('blue', '\n🔍 Validação final:');
  const { count: finishedCount } = await admin.from('matches').select('*', { count: 'exact', head: true }).eq('finished', true);
  log(finishedCount === idsToProcess.length ? 'green' : 'red',
    `   Matches finished: ${finishedCount}/${idsToProcess.length}`);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

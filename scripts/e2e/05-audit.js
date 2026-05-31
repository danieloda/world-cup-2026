#!/usr/bin/env node
/**
 * Step 5 do E2E: Audita a matematica de pontos pra cada um dos 10 users.
 *
 * Reads:
 *   - expected-tournament.json  → resultados oficiais
 *   - test-users.json           → strategies
 *   - user-tokens.json          → user_ids dos test users
 *   - DB                        → predictions/picks/points_earned/leaderboard
 *
 * Compute:
 *   Pra cada user:
 *     1. Calcula points_earned esperado (replica score_prediction em JS)
 *     2. Calcula champion_bonus esperado
 *     3. Calcula scorer_bonus esperado
 *     4. Total esperado = soma
 *     5. Compara contra v_leaderboard.total_pts
 *
 * Output:
 *   - scripts/e2e/audit-report.json (relatorio detalhado)
 *   - Print tabela comparativa
 *   - Exit code 0 se tudo bater, 1 se houver discrepancias
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';
import { chromium } from 'playwright';

import { makeAdminClient } from './lib/admin-client.js';
import { makeClient, loginAs } from './lib/supabase-client.js';
import { scorePrediction, championBonus, scorerBonus, STAGE_MULT, CHAMPION_BONUS } from './lib/scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const TOURNAMENT_PATH = join(__dirname, 'expected-tournament.json');
const TEST_USERS_PATH = join(__dirname, 'test-users.json');
const TOKENS_PATH = join(__dirname, 'user-tokens.json');
const OUTPUT = join(__dirname, 'audit-report.json');

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c]}${m}${C.reset}`);

function fmtPts(actual, expected) {
  if (actual === expected) return `${C.green}${actual}${C.reset}`;
  return `${C.red}${actual} ≠ ${expected}${C.reset}`;
}

async function main() {
  log('blue', `${C.bold}🔍 Step 5: Audit math vs expected${C.reset}`);

  const admin = makeAdminClient();
  await admin.auth.signInWithPassword({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });

  const tournament = JSON.parse(readFileSync(TOURNAMENT_PATH, 'utf8'));
  const tokens = JSON.parse(readFileSync(TOKENS_PATH, 'utf8')).users;

  // Carrega DB completo
  log('blue', '\n📥 Carregando DB...');
  const [{ data: predictions }, { data: champPicks }, { data: scorerPicks }, { data: leaderboard }, { data: playerGoals }] = await Promise.all([
    admin.from('predictions').select('*'),
    admin.from('champion_picks').select('*'),
    admin.from('top_scorer_picks').select('*'),
    admin.from('v_leaderboard').select('*'),
    admin.from('player_goals').select('*, matches!inner(stage)'),
  ]);

  const predsByUser = {};
  for (const p of predictions) {
    if (!predsByUser[p.user_id]) predsByUser[p.user_id] = [];
    predsByUser[p.user_id].push(p);
  }
  const champByUser = Object.fromEntries(champPicks.map((c) => [c.user_id, c]));
  const scorerByUser = Object.fromEntries(scorerPicks.map((s) => [s.user_id, s]));
  const lbByUser = Object.fromEntries(leaderboard.map((l) => [l.user_id, l]));

  // Index goals: { player_id → [{ stage, goals }] }
  const goalsByPlayer = playerGoals.map((g) => ({
    player_id: g.player_id,
    stage: g.matches.stage,
    goals: g.goals,
  }));

  // Index expected matches por id
  const matchesById = Object.fromEntries(tournament.matches.map((m) => [m.id, m]));

  // ============================================================
  // Loop pelos users
  // ============================================================
  const report = [];
  let allOk = true;

  log('blue', '\n📊 Audit por user:\n');
  log('dim', '   key                       paid  match_pts_calc  match_pts_db  champ_calc  champ_db  scorer_calc  scorer_db  TOTAL_calc  TOTAL_db');
  log('dim', '   ' + '─'.repeat(160));

  for (const token of tokens) {
    const userId = token.user_id;
    const profile = token.profile;
    const userPreds = predsByUser[userId] ?? [];

    // 1. Match pts esperado (recalcula via scorePrediction local)
    let matchPtsCalc = 0;
    for (const p of userPreds) {
      const m = matchesById[p.match_id];
      if (!m) continue;
      const pts = scorePrediction(
        p.pred_home, p.pred_away, p.pred_pen_winner,
        m.actual_home, m.actual_away, m.pen_winner,
        m.stage,
      );
      matchPtsCalc += pts;
    }

    // 2. Champion bonus esperado
    const champ = champByUser[userId];
    const champPtsCalc = champ ? championBonus(champ.team, tournament.champion) : 0;

    // 3. Scorer bonus esperado
    const scorer = scorerByUser[userId];
    const scorerPtsCalc = scorer ? scorerBonus(scorer.player_id, goalsByPlayer) : 0;

    // 4. Comparar com leaderboard (se paid; senao não aparece la)
    const lb = lbByUser[userId];
    const matchPtsDb = lb?.match_pts ?? 0;
    const champPtsDb = lb?.champion_pts ?? 0;
    const scorerPtsDb = lb?.scorer_pts ?? 0;
    // Bônus de classificado (BPE/BP): a correção própria é verificada por
    // scenarios/qualifier-bonus.sql. Aqui usamos o valor do DB para conferir
    // a ARITMÉTICA do v_leaderboard (total = match + champ + scorer + qualifier).
    const qualifierPtsDb = lb?.qualifier_pts ?? 0;
    const totalDb = lb?.total_pts ?? 0;

    const totalCalc = matchPtsCalc + champPtsCalc + scorerPtsCalc + qualifierPtsDb;
    const inLeaderboard = !!lb;

    const matchOk = matchPtsCalc === matchPtsDb;
    const champOk = champPtsCalc === champPtsDb;
    const scorerOk = scorerPtsCalc === scorerPtsDb;
    const totalOk = totalCalc === totalDb;

    // Validacao: user not_paid NAO deve aparecer no leaderboard
    let extraNote = '';
    if (!profile.paid && inLeaderboard) {
      extraNote = ' ⚠ paid=false mas APARECE em v_leaderboard!';
      allOk = false;
    } else if (profile.paid && !inLeaderboard) {
      extraNote = ' ⚠ paid=true mas NÃO APARECE em v_leaderboard!';
      allOk = false;
    }

    // Se nao paid, leaderboard não tem entrada — tudo OK
    if (!profile.paid) {
      // mesma logica: nao audita pts vs lb (não está la)
    } else {
      if (!matchOk || !champOk || !scorerOk || !totalOk) allOk = false;
    }

    const ok = (matchOk || !profile.paid) && (champOk || !profile.paid) && (scorerOk || !profile.paid) && (totalOk || !profile.paid);

    // Pra user not_paid: esperado é estar AUSENTE do leaderboard.
    // Reporta como OK se: paid=false E inLeaderboard=false (independente do calc).
    let displayMatch, displayChamp, displayScorer, displayTotal;
    if (!profile.paid) {
      const ok2 = !inLeaderboard;
      const tag = ok2 ? `${C.green}filtrado${C.reset}` : `${C.red}NO LB!${C.reset}`;
      displayMatch = tag.padEnd(25);
      displayChamp = '—'.padEnd(25);
      displayScorer = '—'.padEnd(25);
      displayTotal = `(esperado ${totalCalc})`.padEnd(25);
    } else {
      displayMatch = fmtPts(matchPtsDb, matchPtsCalc).padEnd(25);
      displayChamp = fmtPts(champPtsDb, champPtsCalc).padEnd(25);
      displayScorer = fmtPts(scorerPtsDb, scorerPtsCalc).padEnd(25);
      displayTotal = fmtPts(totalDb, totalCalc).padEnd(25);
    }

    const status = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`   ${status} ${profile.key.padEnd(22)} ${(profile.paid ? 'sim' : 'NAO').padEnd(5)} ${displayMatch} ${displayChamp} ${displayScorer} ${displayTotal}${extraNote}`);

    report.push({
      key: profile.key,
      paid: profile.paid,
      strategy: profile.strategy,
      champion_strategy: profile.champion,
      scorer_strategy: profile.topScorer,
      user_id: userId,
      predictions_count: userPreds.length,
      champion_pick: champ?.team ?? null,
      scorer_pick_id: scorer?.player_id ?? null,
      calc: {
        match_pts: matchPtsCalc,
        champion_pts: champPtsCalc,
        scorer_pts: scorerPtsCalc,
        total_pts: totalCalc,
      },
      db: {
        in_leaderboard: inLeaderboard,
        match_pts: matchPtsDb,
        champion_pts: champPtsDb,
        scorer_pts: scorerPtsDb,
        qualifier_pts: qualifierPtsDb,
        total_pts: totalDb,
      },
      checks: { matchOk, champOk, scorerOk, totalOk },
      notes: extraNote || null,
    });
  }

  // ============================================================
  // Validações globais
  // ============================================================
  log('blue', '\n🔬 Validações globais (matemática):');
  const expectedTestPaid = tokens.filter((t) => t.profile.paid).length;
  const expectedPaid = expectedTestPaid + 1;  // +1 admin (sempre paid)
  const lbCount = leaderboard.length;
  log(lbCount === expectedPaid ? 'green' : 'red',
    `   v_leaderboard count: ${lbCount} (esperado: ${expectedPaid} = ${expectedTestPaid} test paid + 1 admin)`);
  if (lbCount !== expectedPaid) allOk = false;

  // Verifica que matches finished = 104
  const { count: finCount } = await admin.from('matches').select('*', { count: 'exact', head: true }).eq('finished', true);
  log(finCount === 104 ? 'green' : 'red', `   Matches finished: ${finCount}/104`);
  if (finCount !== 104) allOk = false;

  // Verifica points_earned NULL em predictions de matches finished
  const { count: orphanCount } = await admin
    .from('predictions')
    .select('*, matches!inner(finished)', { count: 'exact', head: true })
    .is('points_earned', null)
    .eq('matches.finished', true);
  log(orphanCount === 0 ? 'green' : 'red',
    `   Predictions órfãs (NULL apos finished): ${orphanCount}`);
  if (orphanCount > 0) allOk = false;

  // ============================================================
  // Estado dos matches: slots resolvidos, scorers atribuídos
  // ============================================================
  log('blue', '\n🎯 Estado final dos matches:');

  // Matches com slot ainda no team_home/away (não resolveu)
  const { data: allMatches } = await admin.from('matches').select('id, stage, team_home, team_away, actual_home, actual_away, pen_winner, finished');
  const stuckOnSlot = allMatches.filter((m) =>
    /^[0-9LW]/.test(m.team_home) || /^[0-9LW]/.test(m.team_away) ||
    m.team_home.includes('/') || m.team_away.includes('/')
  );
  log(stuckOnSlot.length === 0 ? 'green' : 'red',
    `   Matches com slot não resolvido: ${stuckOnSlot.length}`);
  if (stuckOnSlot.length > 0) {
    for (const m of stuckOnSlot.slice(0, 5)) {
      log('red', `     M#${m.id} (${m.stage}): ${m.team_home} vs ${m.team_away}`);
    }
    allOk = false;
  }

  // Matches sem actual scores
  const noScore = allMatches.filter((m) => m.actual_home == null || m.actual_away == null);
  log(noScore.length === 0 ? 'green' : 'red',
    `   Matches sem placar (actual NULL): ${noScore.length}`);
  if (noScore.length > 0) allOk = false;

  // Champion real
  const finalMatch = allMatches.find((m) => m.stage === 'final');
  // Campeão: se empate na regulamentar, decide pelo pen_winner (igual champion_bonus_for no DB)
  let actualChampionDb = null;
  if (finalMatch && finalMatch.finished) {
    if (finalMatch.actual_home > finalMatch.actual_away) actualChampionDb = finalMatch.team_home;
    else if (finalMatch.actual_away > finalMatch.actual_home) actualChampionDb = finalMatch.team_away;
    else if (finalMatch.pen_winner === 'home') actualChampionDb = finalMatch.team_home;
    else if (finalMatch.pen_winner === 'away') actualChampionDb = finalMatch.team_away;
  }
  const championMatch = actualChampionDb === tournament.champion;
  log(championMatch ? 'green' : 'red',
    `   Campeão DB (${actualChampionDb}) == expected (${tournament.champion}): ${championMatch}`);
  if (!championMatch) allOk = false;

  // ============================================================
  // Player goals: total scorers vs total goals
  // ============================================================
  log('blue', '\n⚽ Player goals:');
  const totalGoals = allMatches.reduce((s, m) => s + (m.actual_home ?? 0) + (m.actual_away ?? 0), 0);
  const totalScorerGoals = playerGoals.reduce((s, g) => s + g.goals, 0);
  // Pode ter diferença se algum match teve times sem players cadastrados
  log('blue', `   Total gols (sum actual_home/away): ${totalGoals}`);
  log('blue', `   Total scorer goals atribuídos:     ${totalScorerGoals}`);
  log(totalScorerGoals <= totalGoals ? 'green' : 'red',
    `   Sem over-attribution: ${totalScorerGoals <= totalGoals}`);
  if (totalScorerGoals > totalGoals) allOk = false;

  // Scorers esperados (oráculo) vs DB — pega atribuições FALTANDO (o check DB-vs-DB
  // acima não pegava: missing scorers passavam silenciosos e mexem no bônus de artilheiro).
  const dbByMatchPlayer = new Map();
  {
    const { data: rawGoals } = await admin.from('player_goals').select('match_id, player_id, goals');
    for (const g of (rawGoals || [])) dbByMatchPlayer.set(`${g.match_id}:${g.player_id}`, g.goals);
  }
  const missingScorers = [];
  for (const m of tournament.matches) {
    for (const s of (m.scorers || [])) {
      const got = dbByMatchPlayer.get(`${m.id}:${s.player_id}`) ?? 0;
      if (got < s.goals) missingScorers.push(`m#${m.id} p${s.player_id} esperado=${s.goals} db=${got}`);
    }
  }
  log(missingScorers.length === 0 ? 'green' : 'red',
    `   Scorers esperados presentes no DB: ${missingScorers.length === 0 ? 'todos' : missingScorers.length + ' faltando'}`);
  for (const mm of missingScorers.slice(0, 5)) log('red', `     ${mm}`);
  if (missingScorers.length > 0) allOk = false;

  // ============================================================
  // Alert log: criticos novos desde Step 4
  // ============================================================
  log('blue', '\n🚨 Alertas:');
  const { data: recentAlerts } = await admin
    .from('alert_log')
    .select('*')
    .gte('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())  // ultima 1h
    .in('severity', ['critical', 'warn']);
  const realAlerts = (recentAlerts ?? []).filter((a) =>
    !String(a.title).includes('TESTE') && !(a.context?.simulated === true)
  );
  log(realAlerts.length === 0 ? 'green' : 'red',
    `   Alertas críticos/warn na última 1h (real, não-teste): ${realAlerts.length}`);
  for (const a of realAlerts.slice(0, 5)) {
    log('red', `     [${a.severity}] ${a.category}: ${a.title}`);
  }
  if (realAlerts.length > 0) allOk = false;

  // ============================================================
  // RLS check: user normal não pode ver predictions de outros
  // (exceto matches passados, mas como ALL matches estão finished=true, todos visíveis)
  // ============================================================
  log('blue', '\n🔒 RLS check:');
  try {
    const aliceClient = makeClient();
    const alice = tokens[0];  // perfect
    const bob = tokens[3];    // half_predictor
    await loginAs(aliceClient, alice.email, alice.password);

    // Alice tenta SELECT predictions do Bob
    const { data: bobPreds, error: rlsErr } = await aliceClient
      .from('predictions')
      .select('match_id, pred_home, pred_away')
      .eq('user_id', bob.user_id);

    if (rlsErr) {
      log('red', `   RLS retornou erro: ${rlsErr.message}`);
      allOk = false;
    } else {
      // Após kickoff, RLS PERMITE ver palpites alheios — esperado
      // Como todos matches estão finished (após Step 4), Alice deveria ver TODAS predictions do Bob
      const bobTotalPreds = predsByUser[bob.user_id]?.length ?? 0;
      log(bobPreds.length === bobTotalPreds ? 'green' : 'yellow',
        `   Alice vê predictions do Bob (todos jogos passados): ${bobPreds.length}/${bobTotalPreds} ${bobPreds.length === bobTotalPreds ? '(esperado)' : '(checar RLS — esperado total já que matches finished)'}`);
    }
    await aliceClient.auth.signOut();
  } catch (e) {
    log('red', `   RLS check exception: ${e.message}`);
    allOk = false;
  }

  // ============================================================
  // Ranking ordering: ordem correta por total_pts DESC
  // ============================================================
  log('blue', '\n🏆 Ranking ordering:');
  const sorted = [...leaderboard].sort((a, b) =>
    b.total_pts - a.total_pts ||
    b.exact_count - a.exact_count ||
    b.winner_sg_count - a.winner_sg_count
  );
  const isOrdered = JSON.stringify(leaderboard.map(u => u.user_id)) === JSON.stringify(sorted.map(u => u.user_id));
  log(isOrdered ? 'green' : 'red',
    `   v_leaderboard ordenado corretamente: ${isOrdered}`);
  if (!isOrdered) allOk = false;

  // ============================================================
  // not_paid: NÃO deve aparecer em leaderboard
  // ============================================================
  const notPaidUser = tokens.find(t => t.key === 'not_paid');
  if (notPaidUser) {
    const inLb = leaderboard.some(u => u.user_id === notPaidUser.user_id);
    log(!inLb ? 'green' : 'red',
      `   User not_paid filtrado do leaderboard: ${!inLb}`);
    if (inLb) allOk = false;
  }

  // ============================================================
  // Final ranking podium (top 3)
  // ============================================================
  log('blue', '\n🥇 Top 3 ranking:');
  for (let i = 0; i < Math.min(3, leaderboard.length); i++) {
    const u = leaderboard[i];
    const tok = tokens.find(t => t.user_id === u.user_id);
    log('blue', `   ${i+1}. ${u.full_name.padEnd(28)} ${u.total_pts} pts (match=${u.match_pts}, champ=${u.champion_pts}, scorer=${u.scorer_pts}, qualif=${u.qualifier_pts ?? 0}) [${tok?.key}]`);
  }

  // ============================================================
  // UI smoke: ranking.html mostra mesma ordem
  // ============================================================
  log('blue', '\n🌐 UI smoke (ranking.html):');
  const screenshotsDir = join(__dirname, 'screenshots');
  mkdirSync(screenshotsDir, { recursive: true });
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Login como admin (vê todo mundo)
    await page.goto(`${process.env.BASE_URL || 'http://localhost:3000'}/login.html`);
    await page.fill('#email', process.env.ADMIN_EMAIL);
    await page.fill('#password', process.env.ADMIN_PASSWORD);
    await page.click('#submitBtn');
    await page.waitForURL(/\/inicio/, { timeout: 10000 });

    // Vai pra ranking
    await page.goto(`${process.env.BASE_URL || 'http://localhost:3000'}/ranking.html`);
    await page.waitForSelector('.rank-table, .podium-card, table', { timeout: 15000 });

    // Conta rows visiveis
    const uiRowCount = await page.$$eval('tr[data-user-id], .rank-row, tbody tr', (els) => els.length);
    log(uiRowCount >= expectedPaid ? 'green' : 'red',
      `   UI ranking mostra ${uiRowCount} rows (esperado >= ${expectedPaid})`);

    await page.screenshot({ path: join(screenshotsDir, 'audit-ranking.png'), fullPage: true });
    log('green', '   ✓ Screenshot salvo em screenshots/audit-ranking.png');

    await browser.close();
  } catch (e) {
    log('yellow', `   UI smoke pulado: ${e.message}`);
  }

  // Save
  writeFileSync(OUTPUT, JSON.stringify({ ok: allOk, users: report }, null, 2));
  log('blue', `\n📄 Relatório salvo: ${OUTPUT}`);

  if (allOk) {
    log('green', `\n${C.bold}🎉 TUDO BATE. Matematica está perfeita.${C.reset}`);
    process.exit(0);
  } else {
    log('red', `\n${C.bold}⚠️  Discrepancias encontradas. Veja audit-report.json.${C.reset}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

#!/usr/bin/env node
/**
 * E2E: Gráfico de evolução do ranking (bump chart) em ranking.html.
 *
 * Cobre a feature nova (commit "gráfico de evolução do ranking"):
 *   - ADICIONA ~10 usuários voláteis, cada um com pico de pontuação numa fase
 *     diferente (ás dos grupos, ás das oitavas, rei da final + campeão, artilheiro,
 *     etc.) pra FORÇAR muitas viradas de posição ao longo da Copa.
 *   - valida no DOM: SVG renderiza; nº de linhas == usuários pagos; a legenda
 *     mostra, por série, o MESMO total do v_leaderboard (invariante "fim da série
 *     == tabela"); muitas trocas de posição (lê a geometria das polylines);
 *     modos "Por jogo"/"Por dia"; foco/isolar via legenda; hover com tooltip de
 *     standings + confronto; linha "Você" destacada.
 *
 * MUTA o DB: cria usuários (paid) + palpites e roda recompute. Limpa tudo no
 * finally (apaga os vol-*@testuser.com e recomputa), voltando ao baseline.
 *
 * NB (preferência do Daniel): triggers de alerta FICAM LIGADOS — criar os
 * fixtures dispara alertas de "novo participante" no Telegram, e isso é desejado.
 *
 * Pré-req: pipeline já rodado (104 jogos finalizados, leaderboard populado).
 *   source .env.e2e.local && node scripts/e2e/test-rank-chart.js
 */
import { chromium } from 'playwright';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { makeAdminClient, adminCreateUser, adminCreateProfile, adminDeleteUser, adminListUsers } from './lib/admin-client.js';
import { genPrediction } from './lib/predictions.js';
import { makeRng } from './lib/prng.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CID = 'supabase_db_world-cup-2026';
const PASSWORD = 'TestUser2026!';
const AVATAR = 'assets/avatars/daniel.png';
const C = { r: '\x1b[31m', g: '\x1b[32m', b: '\x1b[34m', d: '\x1b[2m', y: '\x1b[33m', x: '\x1b[0m', bold: '\x1b[1m' };

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`   ${pass ? C.g + '✓' : C.r + '✗'} ${name}${detail ? C.d + ' — ' + detail : ''}${C.x}`);
};
const log = (c, m) => console.log(`${C[c]}${m}${C.x}`);

const admin = makeAdminClient();
const shotsDir = join(__dirname, 'screenshots'); mkdirSync(shotsDir, { recursive: true });

function runSql(sql) {
  return execFileSync('docker', ['exec', '-i', CID, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'],
    { input: sql, encoding: 'utf8' });
}

async function cleanVolUsers() {
  const existing = await adminListUsers(admin, 'vol-');
  for (const u of existing) {
    if (u.email.endsWith('@testuser.com')) await adminDeleteUser(admin, u.id);
  }
  return existing.length;
}

// ----- perfis voláteis: cada um pica numa fase distinta → trajetórias se cruzam -----
// exactPhases: fases onde crava o placar; elseStrategy: o que faz nas demais.
const CHAMP = 'Cape Verde';   // campeão real
const TOP_SCORER = 1054;      // artilheiro real (Garry Rodrigues, 6 gols)
const PROFILES = [
  { key: 'groups-ace',  name: '🅰 Ás dos Grupos',     exactPhases: ['group'], elseStrategy: null },
  { key: 'r32-ace',     name: '🅱 Ás dos 32-avos',     exactPhases: ['r32'],  elseStrategy: 'one_side_only' },
  { key: 'r16-ace',     name: '🅲 Ás das Oitavas',     exactPhases: ['r16'],  elseStrategy: 'one_side_only' },
  { key: 'qf-ace',      name: '🅳 Ás das Quartas',     exactPhases: ['qf'],   elseStrategy: 'winner_only' },
  { key: 'sf-ace',      name: '🅴 Ás das Semis',       exactPhases: ['sf', 'third'], elseStrategy: 'winner_only' },
  { key: 'final-king',  name: '👑 Rei da Final',       exactPhases: ['final'], elseStrategy: 'winner_only', champion: CHAMP },
  { key: 'scorer-king', name: '⚽ Dono do Artilheiro', exactPhases: [],       elseStrategy: 'winner_only', scorer: TOP_SCORER },
  { key: 'steady',      name: '📈 Constante',          exactPhases: [],       elseStrategy: 'winner_sg' },
  { key: 'faller',      name: '📉 Começou e Caiu',     exactPhases: ['group'], elseStrategy: 'one_side_only', champion: 'Egypt' },
  { key: 'wild',        name: '🎲 Maluco',             exactPhases: [],       elseStrategy: 'random' },
];

function genForProfile(profile, m, rng) {
  const actual = { actual_home: m.actual_home, actual_away: m.actual_away, pen_winner: m.pen_winner };
  if (profile.exactPhases.includes(m.stage)) return genPrediction({ id: m.id, stage: m.stage }, actual, 'exact_all', rng);
  if (profile.elseStrategy) return genPrediction({ id: m.id, stage: m.stage }, actual, profile.elseStrategy, rng);
  return null;
}

let baselineCount = 0;
const browser = await chromium.launch({ headless: true });

try {
  log('b', `${C.bold}📈 Gráfico de evolução do ranking — adiciona voláteis + valida${C.x}`);

  // baseline + matches
  const { data: lb0 } = await admin.from('v_leaderboard').select('user_id');
  baselineCount = lb0.length;
  log('d', `   baseline: ${baselineCount} usuários no leaderboard`);

  await cleanVolUsers(); // limpa restos de uma run anterior

  const { data: matches } = await admin.from('matches')
    .select('id, stage, actual_home, actual_away, pen_winner, match_date')
    .eq('finished', true).order('match_date', { ascending: true });

  // ----- cria os voláteis + palpites -----
  log('b', `\n👥 Criando ${PROFILES.length} usuários voláteis (alertas de signup vão disparar — desejado)...`);
  const created = [];
  for (const p of PROFILES) {
    const email = `vol-${p.key}@testuser.com`;
    const user = await adminCreateUser(admin, email, PASSWORD, p.name);
    await adminCreateProfile(admin, user, p.name, { paid: true, avatar_url: AVATAR });

    const rng = makeRng(`vol-${p.key}-v1`);
    const rows = [];
    for (const m of matches) {
      const pred = genForProfile(p, m, rng);
      if (pred) rows.push({ user_id: user.id, match_id: m.id, pred_home: pred.pred_home, pred_away: pred.pred_away, pred_pen_winner: pred.pred_pen_winner });
    }
    if (rows.length) {
      const { error } = await admin.from('predictions').insert(rows);
      if (error) throw new Error(`insert preds ${p.key}: ${error.message}`);
    }
    if (p.champion) await admin.from('champion_picks').insert({ user_id: user.id, team: p.champion });
    if (p.scorer) await admin.from('top_scorer_picks').insert({ user_id: user.id, player_id: p.scorer });

    created.push({ ...p, email, user_id: user.id });
    log('g', `   ✓ ${p.key.padEnd(12)} ${rows.length} palpites${p.champion ? ' +campeão' : ''}${p.scorer ? ' +artilheiro' : ''}`);
  }

  // ----- recomputa pontos + bônus de classificado (palpites inseridos contra jogo já finalizado) -----
  log('b', '\n🔢 Recomputando points_earned + qualifier...');
  runSql('select public.recompute_prediction_points(); select public.recompute_qualifier_points();');

  const { data: lb } = await admin.from('v_leaderboard').select('user_id, full_name, total_pts').order('total_pts', { ascending: false });
  const N = lb.length;
  const lbPts = new Map(lb.map(u => [u.user_id, u.total_pts]));
  check('leaderboard cresceu com os voláteis', N === baselineCount + PROFILES.length, `N=${N} (baseline ${baselineCount} + ${PROFILES.length})`);

  // ----- login como "Rei da Final" (linha "Você" com virada dramática no fim) -----
  const me = created.find(c => c.key === 'final-king');
  const page = await browser.newPage({ viewport: { width: 1366, height: 1200 } });
  await page.goto(`${BASE}/login.html`);
  await page.fill('#email', me.email);
  await page.fill('#password', PASSWORD);
  await page.click('#submitBtn');
  await page.waitForURL(/\/inicio(\.html)?$/, { timeout: 15000 });

  await page.goto(`${BASE}/ranking.html`);
  await page.waitForSelector('#rankChart .rc-svg', { timeout: 15000 });
  await page.locator('#rankChart').screenshot({ path: join(shotsDir, 'rank-chart-game.png') }).catch(() => {});

  // (1) nº de linhas == usuários pagos
  const lineCount = await page.locator('#rankChart polyline.rc-line').count();
  check('SVG: 1 linha por usuário pago', lineCount === N, `linhas=${lineCount} N=${N}`);

  // (2) legenda: pts de cada série == v_leaderboard.total_pts  (invariante central do gráfico)
  const legend = await page.$$eval('#rankChart .rc-leg', els => els.map(e => ({
    uid: e.dataset.user,
    pt: parseInt((e.querySelector('.rc-pt')?.textContent || '').replace(/\D+/g, ''), 10),
    nm: e.querySelector('.rc-nm')?.textContent?.trim() || '',
  })));
  const legPtsOk = legend.length === N && legend.every(l => lbPts.get(l.uid) === l.pt);
  const mism = legend.filter(l => lbPts.get(l.uid) !== l.pt).slice(0, 3)
    .map(l => `${l.nm}: leg=${l.pt} lb=${lbPts.get(l.uid)}`);
  check('legenda: fim de cada série == total_pts do v_leaderboard', legPtsOk,
    legPtsOk ? `${N} séries conferem` : mism.join(' | '));
  check('legenda: ordenada desc por pontos', legend.every((l, i) => i === 0 || legend[i - 1].pt >= l.pt));
  const leaderUid = lb[0].user_id;
  check('legenda: topo == líder do v_leaderboard', legend[0]?.uid === leaderUid);

  // (3) MUITAS viradas: lê a geometria das polylines e conta trocas de posição por coluna
  const polys = await page.$$eval('#rankChart polyline.rc-line', els =>
    els.map(e => e.getAttribute('points').trim().split(/\s+/).map(pt => Number(pt.split(',')[1]))));
  const S = polys[0]?.length || 0;
  const sameLen = polys.every(p => p.length === S);
  let changeEvents = 0, prevRank = null;
  for (let c = 0; c < S; c++) {
    const order = polys.map((ys, li) => ({ li, y: ys[c] })).sort((a, b) => a.y - b.y || a.li - b.li);
    const rank = new Array(polys.length);
    order.forEach((o, r) => { rank[o.li] = r; });
    if (prevRank) for (let li = 0; li < rank.length; li++) if (rank[li] !== prevRank[li]) changeEvents++;
    prevRank = rank;
  }
  check('SVG: todas as polylines têm o mesmo nº de colunas', sameLen && S > 1, `cols=${S}`);
  check(`gráfico: MUITAS viradas de posição (${changeEvents} eventos em ${S} colunas)`, changeEvents >= 30,
    `linhas=${polys.length}`);

  // (4) linha "Você" destacada + legenda "Você"
  check('linha "Você" destacada (classe .me)', await page.locator('#rankChart polyline.rc-line.me').count() === 1);
  check('legenda mostra "Você"', legend.some(l => l.nm === 'Você'));

  // (5) modos: Por dia / Por jogo
  await page.click('#rankChart .rc-mode[data-mode="day"]');
  await page.waitForSelector('#rankChart .rc-mode[data-mode="day"].active', { timeout: 5000 });
  check('modo "Por dia": mantém N linhas', await page.locator('#rankChart polyline.rc-line').count() === N);
  const xDay = await page.$$eval('#rankChart .rc-xlbl', els => els.map(e => e.textContent.trim()));
  check('modo "Por dia": rótulos X são datas (d/m)', xDay.length > 0 && xDay.every(t => /^\d{1,2}\/\d{1,2}$/.test(t)),
    `x=[${xDay.slice(0, 4).join(', ')}]`);
  await page.locator('#rankChart').screenshot({ path: join(shotsDir, 'rank-chart-day.png') }).catch(() => {});
  await page.click('#rankChart .rc-mode[data-mode="game"]');
  await page.waitForSelector('#rankChart .rc-mode[data-mode="game"].active', { timeout: 5000 });
  const xGame = await page.$$eval('#rankChart .rc-xlbl', els => els.map(e => e.textContent.trim()));
  check('modo "Por jogo": rótulos X são "Jogo N"', xGame.some(t => /^Jogo \d+$/.test(t)), `x=[${xGame.slice(0, 3).join(', ')}]`);

  // (6) foco/isolar via legenda
  const firstLeg = page.locator('#rankChart .rc-leg').first();
  const firstUid = await firstLeg.getAttribute('data-user');
  await firstLeg.click();
  await page.waitForSelector(`#rankChart .rc-leg.active[data-user="${firstUid}"]`, { timeout: 5000 });
  check('foco: isola 1 série (N-1 linhas .dim)', await page.locator('#rankChart polyline.rc-line.dim').count() === N - 1);
  check('foco: botão "Ver todos" aparece', await page.locator('#rankChart .rc-clear').count() === 1);
  await page.locator('#rankChart').screenshot({ path: join(shotsDir, 'rank-chart-focus.png') }).catch(() => {});
  await page.click('#rankChart .rc-clear');
  await page.waitForSelector('#rankChart .rc-clear', { state: 'detached', timeout: 5000 }).catch(() => {});
  check('foco: "Ver todos" limpa o isolamento', await page.locator('#rankChart polyline.rc-line.dim').count() === 0);

  // (7) hover: linha-guia + tooltip de standings + confronto (modo por jogo)
  await page.locator('#rankChart').scrollIntoViewIfNeeded();  // o handler lê e.clientX real → chart precisa estar no viewport
  const hit = page.locator('#rankChart .rc-hit').first();
  const box = await hit.boundingBox();
  // move em 2 passos (com steps) p/ garantir que o mousemove dispare em headless
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 8 });
  await page.waitForFunction(() => {
    const t = document.querySelector('#rankChart .rc-tip');
    return t && !t.hidden && t.querySelector('.rc-tip-r');
  }, { timeout: 5000 }).catch(() => {});
  const tip = await page.evaluate(() => {
    const t = document.querySelector('#rankChart .rc-tip');
    return { hidden: t?.hidden, rows: t ? t.querySelectorAll('.rc-tip-r').length : 0, hasMatch: !!t?.querySelector('.rc-tip-match') };
  });
  check('hover: tooltip aparece com standings da coluna', tip.hidden === false && tip.rows > 0, `linhas no tip=${tip.rows}`);
  check('hover (por jogo): header mostra o confronto', tip.hasMatch);
  await page.locator('#rankChart').screenshot({ path: join(shotsDir, 'rank-chart-hover.png') }).catch(() => {});

  // (8) MESMO bug de paginação afeta "Palpites da galera": com >1000 palpites no
  // bolão, o card da Final tem que mostrar TODOS os palpiteiros pagos (sem corte).
  const { count: totalPreds } = await admin.from('predictions').select('*', { count: 'exact', head: true });
  const { data: finalPreds } = await admin.from('predictions').select('user_id, profiles!inner(paid)').eq('match_id', 104);
  const expFinalRows = (finalPreds ?? []).filter(p => p.profiles?.paid).length;
  await page.goto(`${BASE}/historico.html`);
  await page.waitForSelector('.history-card', { timeout: 15000 });
  await page.click('[data-stage="ko"]');
  const { data: fm } = await admin.from('matches').select('match_date').eq('id', 104).single();
  const fDay = (() => { const d = new Date(fm.match_date); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  await page.click(`#dayTabs .day-tab[data-day="${fDay}"]`);
  await page.waitForSelector('.history-card.final', { timeout: 8000 });
  const domFinalRows = await page.locator('.history-card.final .hb-row').count();
  check(`historico (escala, ${totalPreds} palpites > 1000): card da Final mostra todos os pagos`,
    domFinalRows === expFinalRows && expFinalRows > 8, `dom=${domFinalRows} exp=${expFinalRows}`);

  log('d', `\n   screenshots: rank-chart-{game,day,focus,hover}.png em scripts/e2e/screenshots/`);
} finally {
  await browser.close();
  // ----- cleanup: apaga voláteis e volta ao baseline -----
  log('b', '\n🧹 Limpando usuários voláteis...');
  const removed = await cleanVolUsers();
  runSql('select public.recompute_prediction_points(); select public.recompute_qualifier_points();');
  const { data: lbEnd } = await admin.from('v_leaderboard').select('user_id');
  log(lbEnd.length === baselineCount ? 'g' : 'y', `   ✓ ${removed} removidos · leaderboard de volta a ${lbEnd.length} (baseline ${baselineCount})`);
}

// ===== resumo =====
const failed = results.filter(r => !r.pass);
console.log(`\n${C.b}${C.bold}Resumo: ${results.length - failed.length}/${results.length} OK${C.x}`);
if (failed.length) { console.log(`${C.r}Falhas: ${failed.map(f => f.name).join('; ')}${C.x}`); process.exit(1); }
console.log(`${C.g}${C.bold}🎉 Bump chart bate com a tabela e mostra muitas viradas.${C.x}`);
process.exit(0);

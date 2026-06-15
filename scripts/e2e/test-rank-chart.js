#!/usr/bin/env node
/**
 * E2E: Gráfico de evolução do ranking (bump chart) em ranking.html.
 *
 * Cobre a feature nova (commit "gráfico de evolução do ranking"):
 *   - ADICIONA ~10 usuários voláteis, cada um com pico de pontuação numa fase
 *     diferente (ás dos grupos, ás das oitavas, rei da final + campeão, artilheiro,
 *     etc.) pra FORÇAR muitas viradas de posição ao longo da Copa.
 *   - valida no DOM (bump focado · zoom no foco 2026-06): SVG renderiza; foco
 *     colorido com eixo Y enquadrado nos selecionados (o espaguete cinza some
 *     com seleção ativa; padrão Pódio+Você); grade horizontal; legenda mostra, por
 *     série, o MESMO total do v_leaderboard (invariante "fim da série ==
 *     tabela"); muitas trocas de posição (geometria das polylines); zooms
 *     "Por semana"/"Jogos da semana"; seleção livre via legenda + presets como
 *     reset; hover com tooltip de standings + confronto; linha "Você" com glow;
 *     card "Sua jornada" no Início (KPIs com partida real + linha + dropdown).
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

  // (1) zoom no foco: com seleção ativa o pelotão cinza some (o eixo Y enquadra
  //     só os selecionados). Padrão = Pódio + Você (3 ou 4 linhas, conforme
  //     "Você" ∈ top 3). Contexto cinza só reaparece quando nada está selecionado.
  const ctxCount = await page.locator('#rankChart polyline.rc-ctx').count();
  const focCount = await page.locator('#rankChart polyline.rc-foc').count();
  const top3 = lb.slice(0, 3).map(u => u.user_id);
  const expFoc = top3.includes(me.user_id) ? 3 : 4;
  check('SVG (zoom no foco): espaguete cinza some com seleção ativa', ctxCount === 0, `ctx=${ctxCount}`);
  check(`foco padrão = Pódio + Você (${expFoc} linhas)`, focCount === expFoc, `foc=${focCount} N=${N}`);
  check('SVG: grade horizontal presente', await page.locator('#rankChart line.rc-grid').count() > 0);

  // (2) legenda EXPANDIDA: pts de cada série == v_leaderboard.total_pts
  //     (invariante central do gráfico)
  await page.click('#rankChart [data-action="toggle-all"]');
  await page.waitForFunction((n) =>
    document.querySelectorAll('#rankChart .rc-leg[data-user]').length === n, N, { timeout: 5000 });
  const legend = await page.$$eval('#rankChart .rc-leg[data-user]', els => els.map(e => ({
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

  // (3) MUITAS viradas: como o zoom no foco descartou o contexto cinza, a
  //     volatilidade se lê no recorte — seleciona Top 10 (10+ linhas focadas) e
  //     conta trocas de posição por coluna na geometria das polylines.
  await page.click('#rankChart .rc-chip[data-p="top10"]');
  await page.waitForFunction(() =>
    document.querySelectorAll('#rankChart polyline.rc-foc').length >= 10, null, { timeout: 5000 }).catch(() => {});
  const polys = await page.$$eval('#rankChart polyline.rc-foc', els =>
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
  check('SVG: todas as polylines focadas têm o mesmo nº de colunas', sameLen && S > 1, `cols=${S}`);
  check(`gráfico: viradas de posição no foco (${changeEvents} eventos · ${S} colunas · ${polys.length} linhas)`,
    changeEvents >= 15, `linhas=${polys.length}`);
  await page.click('#rankChart .rc-chip[data-p="podio"]');  // volta ao padrão p/ os próximos checks
  await page.waitForFunction((n) =>
    document.querySelectorAll('#rankChart polyline.rc-foc').length === n, expFoc, { timeout: 5000 }).catch(() => {});

  // (4) linha "Você" com glow + legenda "Você"
  check('linha "Você" destacada (classe .me)', await page.locator('#rankChart polyline.rc-foc.me').count() === 1);
  check('legenda mostra "Você"', legend.some(l => /Você$/.test(l.nm)));

  // (5) zooms de tempo: Por semana (padrão) / Jogos da semana
  const xWeek = await page.$$eval('#rankChart .rc-xlbl', els => els.map(e => e.textContent.trim()));
  check('zoom "Por semana" (padrão): rótulos X são "Semana N"', xWeek.length > 0 && xWeek.every(t => /^Semana \d+$/.test(t)),
    `x=[${xWeek.slice(0, 4).join(', ')}]`);
  await page.locator('#rankChart').screenshot({ path: join(shotsDir, 'rank-chart-week.png') }).catch(() => {});
  await page.click('#rankChart .rc-seg button[data-g="jogo"]');
  await page.waitForSelector('#rankChart .rc-seg button[data-g="jogo"].on', { timeout: 5000 });
  check('zoom "Jogos da semana": mantém o foco (sem espaguete)',
    await page.locator('#rankChart polyline.rc-foc').count() === expFoc
    && await page.locator('#rankChart polyline.rc-ctx').count() === 0);
  const xGame = await page.$$eval('#rankChart .rc-xlbl', els => els.map(e => e.textContent.trim()));
  check('zoom "Jogos da semana": rótulos X são "Jogo N"', xGame.some(t => /^Jogo \d+$/.test(t)), `x=[${xGame.slice(0, 3).join(', ')}]`);
  await page.locator('#rankChart').screenshot({ path: join(shotsDir, 'rank-chart-games.png') }).catch(() => {});

  // (6) seleção LIVRE via legenda + presets como reset
  const leaderLeg = page.locator(`#rankChart .rc-leg[data-user="${leaderUid}"]`).first();
  await leaderLeg.click();  // desliga o líder (estava no foco padrão)
  await page.waitForFunction((n) =>
    document.querySelectorAll('#rankChart polyline.rc-foc').length === n, expFoc - 1, { timeout: 5000 });
  check('legenda desliga QUALQUER um (líder saiu do foco)',
    await page.locator(`#rankChart .rc-leg[data-user="${leaderUid}"][aria-pressed="false"]`).count() === 1);
  await page.locator('#rankChart').screenshot({ path: join(shotsDir, 'rank-chart-focus.png') }).catch(() => {});
  await page.click('#rankChart .rc-chip[data-p="podio"]');  // reset
  await page.waitForFunction((n) =>
    document.querySelectorAll('#rankChart polyline.rc-foc').length === n, expFoc, { timeout: 5000 });
  check('preset "Pódio + Você" reseta a seleção',
    await page.locator('#rankChart polyline.rc-foc').count() === expFoc);

  // (7) hover: linha-guia + tooltip de standings + confronto (zoom por jogo)
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
  check('hover: tooltip aparece com standings do foco', tip.hidden === false && tip.rows > 0, `linhas no tip=${tip.rows}`);
  check('hover (jogos da semana): header mostra o confronto', tip.hasMatch);
  await page.locator('#rankChart').screenshot({ path: join(shotsDir, 'rank-chart-hover.png') }).catch(() => {});

  // (7-neon) a linha sob o cursor acende em neon (.hot); as outras do foco apagam
  //   (.dim). Mira no topo do plot, onde a linha do líder (rank rLo) está cravada.
  await page.mouse.move(box.x + box.width * 0.5, box.y + 3, { steps: 4 });
  await page.waitForFunction(() => document.querySelector('#rankChart polyline.rc-foc.hot'), null, { timeout: 3000 }).catch(() => {});
  const hotN = await page.locator('#rankChart polyline.rc-foc.hot').count();
  const dimN = await page.locator('#rankChart polyline.rc-foc.dim').count();
  check('hover neon: a linha sob o cursor acende (.hot) e as outras apagam (.dim)',
    hotN === 1 && dimN === expFoc - 1, `hot=${hotN} dim=${dimN} expFoc=${expFoc}`);
  await page.mouse.move(box.x - 50, box.y - 50);  // sai do gráfico → reseta o neon
  check('hover neon: sair do gráfico apaga o neon',
    await page.locator('#rankChart polyline.rc-foc.hot').count() === 0);

  // (7b) "Sua jornada" no Início: linha + KPIs com partida real + dropdown
  await page.goto(`${BASE}/inicio.html`);
  await page.waitForSelector('#journeyChart .jc-svg', { timeout: 15000 });
  check('jornada: linha principal renderiza', await page.locator('#journeyChart .jc-journey').count() === 1);
  const kpiN = await page.locator('#journeyChart .jc-kpi').count();
  check('jornada: 5 KPIs (agora/melhor/pior/arrancada/tombo)', kpiN === 5, `kpis=${kpiN}`);
  check('jornada: KPIs mostram partida real (bandeiras)', await page.locator('#journeyChart .jc-mtx .fi').count() >= 4);
  check('jornada: dropdown de rival presente', await page.locator('#journeyChart .jc-dd-btn').count() === 1);
  await page.locator('#journeyChart').screenshot({ path: join(shotsDir, 'journey-inicio.png') }).catch(() => {});

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
  await page.click(`.cal-day[data-date="${fDay}"]`);
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

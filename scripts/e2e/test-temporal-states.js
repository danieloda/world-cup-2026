#!/usr/bin/env node
/**
 * ESTADOS TEMPORAIS — o que a suíte E2E padrão NÃO cobre.
 *
 * Toda a pipeline 00→06 valida o estado FINAL (torneio 100% terminado, tudo no passado).
 * Mas o medo real é "quando a copa COMEÇAR". Aqui simulamos, com snapshot/restore do
 * matches inteiro, os dois estados que faltavam:
 *
 *   FASE A — PRÉ-TORNEIO (dia 1): nada finished, datas no futuro, KO sem slot resolvido.
 *     - ranking.html      → estado gracioso (sem pontos, sem crash)
 *     - historico.html    → vazio ("nenhum jogo começou")
 *     - palpites-grupos   → inputs de placar ABERTOS e editáveis
 *     - palpites-mata     → chaveamento TBD ("Venc. M..", "1º Grupo .."), sem slot cru
 *     - inicio.html       → seção "próximos jogos" povoada, sem "hoje"
 *
 *   FASE B — PARCIAL: grupos terminados, mata-mata ainda no futuro.
 *     - palpites-grupos → Resultados → Classificação renderiza as tabelas dos grupos
 *     - historico       → mostra só os jogos de grupo (finalizados)
 *     - palpites-mata   → R32 resolvido pra times reais; rodadas seguintes ainda TBD
 *     - ranking         → já há pontuação (> 0) de alguém
 *
 * SEGURANÇA:
 *   - Backup do matches inteiro em _matches_backup; restaura no finally (recomputa pontos
 *     via on_match_finished). Também deixa um JSON de recuperação em .tmp/.
 *   - DESLIGA os 3 triggers de alerta de escrita (matches x2 + predictions) durante o teste:
 *     mutar 104 jogos 2x dispararia ~centenas de POSTs ao Telegram de PRODUÇÃO (send_alert
 *     tem a URL de prod hardcoded). Religa no finally. Ver memory local-e2e-setup.
 *
 * Uso: source .env.e2e.local && node scripts/e2e/test-temporal-states.js [--headed]
 */
import { chromium } from 'playwright';
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';
import { makeAdminClient } from './lib/admin-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CID = 'supabase_db_world-cup-2026';
const HEADED = process.argv.includes('--headed');
const C = { r: '\x1b[31m', g: '\x1b[32m', b: '\x1b[34m', d: '\x1b[2m', x: '\x1b[0m', bold: '\x1b[1m' };
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`   ${pass ? C.g + '✓' : C.r + '✗'} ${name}${detail ? C.d + ' — ' + detail : ''}${C.x}`);
};

// roda SQL no Postgres local via stdin (sem inferno de quoting no Windows)
function psql(sql) {
  return execFileSync('docker', ['exec', '-i', CID, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8' });
}

const ALERT_TRIGGERS = [
  ['matches', 'trg_z_alert_orphan_predictions'],
  ['matches', 'trg_z_alert_unresolved_slots'],
  ['predictions', 'trg_z_alert_pred_overwrite'],
];
const toggleAlerts = (action) =>
  psql(ALERT_TRIGGERS.map(([t, trg]) => `alter table public.${t} ${action} trigger ${trg};`).join('\n'));

async function loginAdmin(page) {
  await page.goto(`${BASE}/login.html`);
  await page.fill('#email', process.env.ADMIN_EMAIL);
  await page.fill('#password', process.env.ADMIN_PASSWORD);
  await page.click('#submitBtn');
  await page.waitForURL(/\/inicio(\.html)?$/, { timeout: 15000 });
  await page.waitForSelector('.sidebar, [class*="sidebar"]', { timeout: 15000 });
}

// Navega pro chaveamento e mede vazamento de slot cru no NOME dos times.
// Escaneia .team-name (resolvidos) e .nm.slot (TBD c/ label amigável); ignora
// o .slot-badge (código curto exibido de propósito).
async function assertBracketNoRawLeak(page) {
  await page.goto(`${BASE}/palpites-mata.html`);
  await page.waitForSelector('.bracket-match', { timeout: 15000 });
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('.bm-team .team-name, .bm-team .nm.slot')];
    const texts = els.map((n) => (n.textContent || '').trim()).filter(Boolean);
    const raw = /^(W\d+|L\d+|[123][A-L](\/|$))/;
    const tbd = texts.filter((t) => /^(Venc\.|Perd\.|\dº Grupo|3º )/.test(t)).length;
    return { total: texts.length, tbdCount: tbd, rawLeak: texts.filter((t) => raw.test(t)).slice(0, 5) };
  });
}

async function main() {
  console.log(`${C.b}${C.bold}🕰️  Estados temporais (pré-torneio + parcial)${C.x}`);
  const admin = makeAdminClient();
  const tmpDir = join(__dirname, '.tmp');
  mkdirSync(tmpDir, { recursive: true });

  // ── backup + safety net ────────────────────────────────────────────────────
  console.log(`\n${C.b}[setup] backup de matches + desliga alert triggers${C.x}`);
  const { data: backupRows } = await admin.from('matches').select('*').order('id');
  writeFileSync(join(tmpDir, 'matches-backup.json'), JSON.stringify(backupRows, null, 2));
  psql('drop table if exists _matches_backup; create table _matches_backup as select * from public.matches;');
  toggleAlerts('disable');
  console.log(`   ${C.g}✓${C.x} backup em DB (_matches_backup) + .tmp/matches-backup.json (${backupRows.length} rows); alertas OFF`);

  const browser = await chromium.launch({ headless: !HEADED });
  const page = await browser.newPage();

  try {
    // ============================================================
    // FASE A — PRÉ-TORNEIO
    // ============================================================
    console.log(`\n${C.b}${C.bold}═══ FASE A: PRÉ-TORNEIO (nada jogado) ═══${C.x}`);
    // tudo no futuro, nada finished, sem placar; KO volta pro slot cru (TBD)
    psql(`
      update public.matches set
        finished = false, finished_at = null,
        actual_home = null, actual_away = null, pen_winner = null,
        match_date = now() + (id * interval '6 hours') + interval '10 days';
      update public.matches set
        team_home = coalesce(slot_home, team_home),
        team_away = coalesce(slot_away, team_away)
      where stage <> 'group';
    `);
    await loginAdmin(page);

    // A1 — ranking gracioso (sem pontos, sem crash)
    console.log(`\n${C.b}A1) ranking.html — estado pré-torneio${C.x}`);
    await page.goto(`${BASE}/ranking.html`);
    await page.waitForSelector('#rankTable, .empty', { timeout: 15000 });
    const maxPts = await page.$$eval('#rankBody tr td.pts', tds =>
      tds.length ? Math.max(...tds.map(t => parseInt(t.textContent || '0', 10) || 0)) : 0);
    check('ranking renderiza sem pontos (ninguém pontuou ainda)', maxPts === 0, `maxPts=${maxPts}`);

    // A2 — historico vazio
    console.log(`\n${C.b}A2) historico.html — vazio${C.x}`);
    await page.goto(`${BASE}/historico.html`);
    await page.waitForSelector('.history-card, .empty', { timeout: 15000 });
    const histCards = await page.$$eval('.history-card', els => els.length);
    check('historico sem cards de jogo (nenhum começou)', histCards === 0, `cards=${histCards}`);

    // A3 — palpites-grupos com inputs ABERTOS
    console.log(`\n${C.b}A3) palpites-grupos.html — inputs abertos${C.x}`);
    await page.goto(`${BASE}/palpites-grupos.html`);
    await page.waitForSelector('.score-input, .match, .empty', { timeout: 15000 });
    const openInputs = await page.$$eval('.score-input', els =>
      els.filter(e => !e.disabled && !e.readOnly).length);
    check('placar editável em jogos abertos (futuro)', openInputs > 0, `editáveis=${openInputs}`);

    // A4 — palpites-mata TBD sem slot cru. O bracket reflete os palpites do user:
    // slots resolvidos → .team-name; não-resolvidos → .nm.slot com label amigável.
    // O .slot-badge mostra o código curto DE PROPÓSITO (não conta como vazamento).
    console.log(`\n${C.b}A4) palpites-mata.html — chaveamento TBD${C.x}`);
    const mataInfo = await assertBracketNoRawLeak(page);
    check('palpites-mata renderiza os nomes do chaveamento', mataInfo.total > 0, `nomes=${mataInfo.total}`);
    check('nenhum slot cru no nome (não-resolvidos viram "Venc. M..", "1º Grupo ..")',
      mataInfo.rawLeak.length === 0, mataInfo.rawLeak.length ? `vazou: ${mataInfo.rawLeak.join(',')}` : `tbd=${mataInfo.tbdCount}`);

    // A5 — inicio: próximos sim, hoje não
    console.log(`\n${C.b}A5) inicio.html — próximos jogos${C.x}`);
    await page.goto(`${BASE}/inicio.html`);
    await page.waitForSelector('.sidebar', { timeout: 15000 });
    await page.waitForTimeout(800); // deixa o render assíncrono assentar
    // "Próximos jogos" = renderMatchRow → <div class="match">; "Hoje" = <div class="today-card">
    const inicio = await page.evaluate(() => ({
      upcoming: document.querySelectorAll('.match').length,
      today: document.querySelectorAll('.today-card').length,
    }));
    check('inicio mostra próximos jogos (futuro)', inicio.upcoming > 0, `upcoming=${inicio.upcoming}`);
    check('inicio não mostra jogos de "hoje" (tudo no futuro)', inicio.today === 0, `today=${inicio.today}`);

    // ============================================================
    // FASE B — PARCIAL (grupos terminados, KO no futuro)
    // ============================================================
    console.log(`\n${C.b}${C.bold}═══ FASE B: PARCIAL (grupos done, KO por vir) ═══${C.x}`);
    psql(`
      -- restaura grupos ao estado original (finished + placares)
      update public.matches m set
        actual_home = b.actual_home, actual_away = b.actual_away, pen_winner = b.pen_winner,
        finished = b.finished, finished_at = b.finished_at, match_date = b.match_date
      from _matches_backup b
      where m.id = b.id and m.stage = 'group';
      -- KO continua no futuro, sem placar, com slot cru (deixa a resolução client-side/trigger atuar nos grupos)
      update public.matches set
        finished = false, finished_at = null,
        actual_home = null, actual_away = null, pen_winner = null,
        match_date = now() + (id * interval '6 hours') + interval '10 days'
      where stage <> 'group';
    `);

    // B1 — classificação dos grupos renderiza
    console.log(`\n${C.b}B1) palpites-grupos → Resultados → Classificação${C.x}`);
    await page.goto(`${BASE}/palpites-grupos.html`);
    await page.waitForSelector('.admin-tabs', { timeout: 15000 });
    await page.click('[data-tab="resultados"]');
    await page.waitForSelector('.group-card .group-table', { timeout: 15000 });
    const groupCount = await page.$$eval('.group-card', els => els.length);
    check('classificação renderiza tabelas dos 12 grupos', groupCount === 12, `grupos=${groupCount}`);

    // B2 — historico (filtrado por dia) mostra grupos e NÃO vaza KO futuro
    console.log(`\n${C.b}B2) historico.html — grupos sim, KO futuro não${C.x}`);
    await page.goto(`${BASE}/historico.html`);
    await page.waitForSelector('.history-card, .empty', { timeout: 15000 });
    const histB = await page.$$eval('.history-card', els => ({
      total: els.length,
      ko: els.filter(c => !c.classList.contains('group')).length,
    }));
    check('historico exibe cards de jogos de grupo', histB.total > 0, `cards=${histB.total}`);
    check('nenhum jogo de KO (futuro, não-revelado) vazou no historico', histB.ko === 0, `ko=${histB.ko}`);

    // B3 — bracket: grupos terminados, KO ainda no futuro → sem slot cru
    console.log(`\n${C.b}B3) palpites-mata.html — fase parcial sem slot cru${C.x}`);
    const bInfo = await assertBracketNoRawLeak(page);
    check('palpites-mata renderiza os nomes do chaveamento (parcial)', bInfo.total > 0, `nomes=${bInfo.total}`);
    check('nenhum slot cru vazado na fase parcial', bInfo.rawLeak.length === 0,
      bInfo.rawLeak.length ? bInfo.rawLeak.join(',') : `tbd=${bInfo.tbdCount}`);

    // B4 — ranking já pontua (grupos valeram pontos)
    console.log(`\n${C.b}B4) ranking.html — já há pontuação${C.x}`);
    await page.goto(`${BASE}/ranking.html`);
    await page.waitForSelector('#rankTable, .empty', { timeout: 15000 });
    const maxPtsB = await page.$$eval('#rankBody tr td.pts', tds =>
      tds.length ? Math.max(...tds.map(t => parseInt(t.textContent || '0', 10) || 0)) : 0);
    check('ranking pontua após grupos (algum total > 0)', maxPtsB > 0, `maxPts=${maxPtsB}`);

  } finally {
    await browser.close().catch(() => {});
    // ── restore ────────────────────────────────────────────────────────────
    console.log(`\n${C.b}[teardown] restaura matches + religa alertas${C.x}`);
    try {
      psql(`
        update public.matches m set
          match_date = b.match_date, ground = b.ground,
          team_home = b.team_home, team_away = b.team_away,
          slot_home = b.slot_home, slot_away = b.slot_away,
          actual_home = b.actual_home, actual_away = b.actual_away,
          pen_winner = b.pen_winner, finished = b.finished, finished_at = b.finished_at
        from _matches_backup b where m.id = b.id;
        drop table if exists _matches_backup;
      `);
      console.log(`   ${C.g}✓${C.x} matches restaurado do backup (pontos recomputados via trigger)`);
    } catch (e) {
      console.log(`   ${C.r}⚠ restore via DB falhou: ${e.message}. Recupere de .tmp/matches-backup.json${C.x}`);
    }
    try { toggleAlerts('enable'); console.log(`   ${C.g}✓${C.x} alert triggers religados`); }
    catch (e) { console.log(`   ${C.r}⚠ religar alertas falhou: ${e.message}${C.x}`); }
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${C.b}${C.bold}Resumo: ${results.length - failed.length}/${results.length} OK${C.x}`);
  if (failed.length) {
    console.log(`${C.r}FALHAS: ${failed.map(f => f.name).join('; ')}${C.x}`);
    process.exit(1);
  }
  console.log(`${C.g}${C.bold}🎉 Estados temporais (pré + parcial) corretos.${C.x}`);
  process.exit(0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

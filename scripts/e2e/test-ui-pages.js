#!/usr/bin/env node
/**
 * Asserções de UI que faltavam (fora do 06-ui-assert.js):
 *
 *   1) inicio.html      — KPIs (4 cards), "Copa disputada" N/104 bate com o DB,
 *                         seção de jogos (hoje OU próximos) renderiza.
 *   2) campeao-artilheiro.html (LADO USUÁRIO) — com snapshot/restore do deadline:
 *        ABERTO  (deadline futuro): UI de seleção, busca habilitada, grade de times
 *                clicável; CLICAR num time grava champion_picks (valida o write via UI).
 *        TRAVADO (deadline passado): card vira "🔒 Travado", busca some/desabilita.
 *   3) recent.json ("últimos jogos") — integridade do arquivo (shape + cobertura dos
 *        times de grupo) e o tooltip de forma recente aparecendo no DOM (hover).
 *
 * Usa um usuário descartável (Admin API) e restaura o deadline no finally.
 * Uso: source .env.e2e.local && node scripts/e2e/test-ui-pages.js [--headed]
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';
import { makeAdminClient } from './lib/admin-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const HEADED = process.argv.includes('--headed');
const C = { r: '\x1b[31m', g: '\x1b[32m', b: '\x1b[34m', d: '\x1b[2m', x: '\x1b[0m', bold: '\x1b[1m' };
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`   ${pass ? C.g + '✓' : C.r + '✗'} ${name}${detail ? C.d + ' — ' + detail : ''}${C.x}`);
};
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;

const TEST_EMAIL = 'ui-pages@testuser.com';
const TEST_PASS = 'UiPages2026!';

async function uiLogin(page, email, password) {
  await page.goto(`${BASE}/login.html`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#submitBtn');
  await page.waitForURL(/\/inicio(\.html)?$/, { timeout: 15000 });
  await page.waitForSelector('.sidebar', { timeout: 15000 });
}

async function main() {
  console.log(`${C.b}${C.bold}🖥️  Asserções de UI: início, campeão/artilheiro, recent${C.x}`);
  const admin = makeAdminClient();

  // ── usuário descartável (confirmado, pago, com avatar p/ passar o gate) ──────
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existing = list?.users?.find((u) => u.email === TEST_EMAIL);
  if (existing) await admin.auth.admin.deleteUser(existing.id);
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: TEST_EMAIL, password: TEST_PASS, email_confirm: true, user_metadata: { full_name: 'UI Pages' },
  });
  if (cErr) throw new Error(`createUser: ${cErr.message}`);
  const userId = created.user.id;
  await admin.from('profiles').upsert(
    { id: userId, full_name: 'UI Pages', email: TEST_EMAIL, paid: true, avatar_url: 'https://example.com/a.png' },
    { onConflict: 'id' });

  // snapshot do deadline p/ restaurar
  const { data: setRow } = await admin.from('settings').select('value').eq('key', 'deadline_champion_scorer').single();
  const origDeadline = setRow.value;
  const setDeadline = (ms) => admin.from('settings').update({ value: iso(ms) }).eq('key', 'deadline_champion_scorer');

  // snapshot da final p/ restaurar. Os estados ABERTO/TRAVADO do card de campeão só
  // renderizam enquanto a final NÃO terminou (isFinalDone() === finalMatch.finished).
  // No DB pós-pipeline a final já acabou, então desfinalizamos só o flag `finished`
  // (placar intacto) durante essas checagens e restauramos no finally — os triggers
  // recomputam os pontos a partir do placar preservado.
  const { data: finalRow } = await admin.from('matches').select('id, finished').eq('stage', 'final').single();
  const origFinalFinished = finalRow?.finished ?? true;
  const setFinalFinished = (v) => admin.from('matches').update({ finished: v }).eq('id', finalRow.id);

  const browser = await chromium.launch({ headless: !HEADED });
  const page = await browser.newPage();

  try {
    // ============================================================
    // 1) inicio.html — KPIs + seção de jogos
    // ============================================================
    console.log(`\n${C.b}1) inicio.html — KPIs${C.x}`);
    await uiLogin(page, TEST_EMAIL, TEST_PASS);
    await page.goto(`${BASE}/inicio.html`);
    await page.waitForSelector('.kpis', { timeout: 15000 });
    const { data: poolStats } = await admin.from('v_pool_stats').select('*').single();
    const kpis = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.kpi')];
      const labels = cards.map((c) => (c.querySelector('.kpi-label')?.textContent || '').trim());
      const copa = cards.find((c) => /Copa disputada/i.test(c.textContent || ''));
      return {
        labels,
        copaSub: copa ? (copa.querySelector('.kpi-sub')?.textContent || '').trim() : '',
        hasMatches: !!document.querySelector('.match, .today-card, .empty'),
      };
    });
    const expectedKpis = ['Sua posição', 'Seus pontos', 'Placares exatos', 'Copa disputada'];
    const missingKpis = expectedKpis.filter((l) => !kpis.labels.includes(l));
    check('inicio renderiza os 4 KPIs esperados', missingKpis.length === 0,
      missingKpis.length ? `faltam: ${missingKpis.join(', ')}` : kpis.labels.filter(Boolean).join(' · '));
    check('KPI "Copa disputada" mostra N/total do DB', kpis.copaSub.includes(`${poolStats.finished_matches}/${poolStats.total_matches}`),
      `dom="${kpis.copaSub}" db=${poolStats.finished_matches}/${poolStats.total_matches}`);
    check('inicio mostra seção de jogos (hoje/próximos/vazio)', kpis.hasMatches);

    // ============================================================
    // 2) campeao-artilheiro.html — ABERTO (deadline no futuro)
    // ============================================================
    console.log(`\n${C.b}2A) campeao-artilheiro — ABERTO (deadline futuro)${C.x}`);
    await setFinalFinished(false); // final "em aberto" p/ exercitar os estados do card de campeão
    await setDeadline(Date.now() + 2 * DAY);
    await page.goto(`${BASE}/campeao-artilheiro.html`);
    await page.waitForSelector('#cardChampion', { timeout: 15000 });
    const openState = await page.evaluate(() => ({
      searchEnabled: !!document.querySelector('#searchTeam') && !document.querySelector('#searchTeam').disabled,
      teamRows: document.querySelectorAll('.cs-row[data-action="pick-team"]').length,
      heroOpen: /Trava/i.test(document.querySelector('.hero-meta')?.textContent || ''),
      locked: !!document.querySelector('#cardChampion.cs-locked'),
    }));
    check('campeão ABERTO: busca de seleção habilitada', openState.searchEnabled);
    check('campeão ABERTO: grade de times clicável', openState.teamRows > 0, `times=${openState.teamRows}`);
    check('campeão ABERTO: hero indica prazo ("Trava …")', openState.heroOpen);
    check('campeão ABERTO: card NÃO está travado', !openState.locked);

    // clica num time → grava champion_picks (valida write via UI)
    await page.click('.cs-row[data-action="pick-team"]');
    await page.waitForTimeout(800);
    const { data: champAfter } = await admin.from('champion_picks').select('team').eq('user_id', userId).maybeSingle();
    check('campeão ABERTO: clicar grava champion_picks no DB', !!champAfter?.team, `pick=${champAfter?.team ?? '(nada)'}`);
    const selectedDom = await page.$$eval('.cs-row.selected', els => els.length);
    check('campeão ABERTO: time clicado fica .selected no DOM', selectedDom === 1, `selected=${selectedDom}`);

    // ============================================================
    // 2B) campeao-artilheiro.html — TRAVADO (deadline no passado)
    // ============================================================
    console.log(`\n${C.b}2B) campeao-artilheiro — TRAVADO (deadline passado)${C.x}`);
    await setDeadline(Date.now() - 1 * DAY);
    await page.goto(`${BASE}/campeao-artilheiro.html`);
    await page.waitForSelector('#cardChampion', { timeout: 15000 });
    const lockedState = await page.evaluate(() => ({
      locked: !!document.querySelector('#cardChampion.cs-locked'),
      searchGone: !document.querySelector('#searchTeam') || document.querySelector('#searchTeam').disabled,
      heroClosed: /fecharam|Travado|🔒/i.test(document.querySelector('.hero-meta')?.textContent || ''),
    }));
    check('campeão TRAVADO: card vira "🔒 Travado"', lockedState.locked);
    check('campeão TRAVADO: busca some/desabilita', lockedState.searchGone);
    check('campeão TRAVADO: hero indica fechado', lockedState.heroClosed);

    // ============================================================
    // 3) recent.json — integridade + tooltip
    // ============================================================
    console.log(`\n${C.b}3) recent.json — integridade + tooltip${C.x}`);
    // 3a) integridade do arquivo
    const recentRaw = JSON.parse(readFileSync(join(__dirname, '..', '..', 'src', 'assets', 'data', 'recent.json'), 'utf8'));
    const teams = Object.keys(recentRaw);
    const shapeOk = teams.length > 0 && teams.every((t) =>
      Array.isArray(recentRaw[t]) && recentRaw[t].every((r) =>
        Array.isArray(r) && r.length === 5 && typeof r[0] === 'string' && typeof r[3] === 'string'));
    check('recent.json: shape válido ({time: [[data,opp,home,placar,comp],…]})', shapeOk, `times=${teams.length}`);

    // cobertura: times de grupo do DB presentes no recent.json
    const { data: gm } = await admin.from('matches').select('team_home, team_away').eq('stage', 'group');
    const dbTeams = [...new Set(gm.flatMap((m) => [m.team_home, m.team_away]))];
    const missing = dbTeams.filter((t) => !(t in recentRaw));
    check('recent.json: cobre os times de grupo do DB', missing.length === 0,
      missing.length ? `faltam ${missing.length}: ${missing.slice(0, 5).join(', ')}` : `${dbTeams.length}/${dbTeams.length}`);

    // 3b) Forma recente no DOM. O hover no nome do time foi REMOVIDO; a forma
    // recente agora vive na aba "Forma" do Raio-X (ver palpites-grupos.js:80
    // "antes ficava num hover…; agora vai pro painel Raio-X"). Abrimos um jogo
    // (match 1, temporariamente aberto) e conferimos que o Raio-X a renderiza.
    const snapM1 = (await admin.from('matches').select('match_date, finished, actual_home, actual_away, pen_winner, finished_at, status').eq('id', 1).single()).data;
    try {
      await admin.from('matches').update({ match_date: new Date(Date.now() + 10 * 864e5).toISOString(), finished: false, actual_home: null, actual_away: null, pen_winner: null, finished_at: null, status: 'scheduled' }).eq('id', 1);
      await page.goto(`${BASE}/palpites-grupos.html`);
      await page.waitForSelector('.match[data-match-id="1"]', { timeout: 15000 });
      await page.click('.match[data-match-id="1"] .ctx-toggle');
      await page.waitForTimeout(400);
      const forma = await page.evaluate(() => {
        const panel = document.querySelector('#ctx-1, .match[data-match-id="1"] .match-context');
        if (!panel) return { ok: false, rows: 0 };
        const tab = [...panel.querySelectorAll('.rxx-tab')].find((t) => /forma/i.test(t.textContent));
        if (tab) tab.click();
        const rows = panel.querySelectorAll('.rx-recent-list li, .rx-recent-col').length;
        return { ok: rows > 0, rows };
      });
      check('forma recente renderiza no Raio-X (substituiu o hover no nome do time)', forma.ok, `linhas=${forma.rows}`);
    } finally {
      await admin.from('matches').update(snapM1).eq('id', 1);
      try { await admin.rpc('recompute_prediction_points', { p_match_id: 1 }); } catch {}
    }

  } finally {
    await browser.close().catch(() => {});
    console.log(`\n${C.b}[teardown] restaura deadline + remove user${C.x}`);
    try { await admin.from('settings').update({ value: origDeadline }).eq('key', 'deadline_champion_scorer'); } catch {}
    try { await setFinalFinished(origFinalFinished); } catch {} // re-finaliza a final → triggers recomputam pontos
    try { await admin.auth.admin.deleteUser(userId); } catch {}
    console.log(`   ${C.g}✓${C.x} restaurado (deadline + final + user)`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${C.b}${C.bold}Resumo: ${results.length - failed.length}/${results.length} OK${C.x}`);
  if (failed.length) {
    console.log(`${C.r}FALHAS: ${failed.map((f) => f.name).join('; ')}${C.x}`);
    process.exit(1);
  }
  console.log(`${C.g}${C.bold}🎉 UI (início/campeão/recent) correta.${C.x}`);
  process.exit(0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

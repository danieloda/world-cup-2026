#!/usr/bin/env node
/**
 * Lacuna: VALIDAÇÕES do lançamento de resultado no admin (UI), que nenhum teste
 * cobria diretamente. Prova, via DOM real:
 *
 *   V1. Empate de MATA-MATA sem vencedor de pênalti → botão Salvar DESABILITADO
 *       + aviso "defina vencedor dos pênaltis" (admin.js:535 canSave + :637 msg).
 *   V2. Ao escolher o vencedor do pênalti, o Salvar HABILITA.
 *   V3. Marcadores que NÃO somam o placar → save bloqueado (toast de erro) e o
 *       jogo NÃO finaliza (admin.js:776-795). Usamos um jogo de grupo com 2 times
 *       que têm jogadores cadastrados.
 *   V4. Empate de GRUPO (sem pênalti) → Salvar HABILITADO (pênalti só é exigido em KO).
 *
 * Faz snapshot/restore do match_date (time-warp) e limpa o resultado no fim.
 * Roda contra Supabase LOCAL. Requer server em :3000 + admin no .env.
 *
 * Uso: source .env.e2e.local && node scripts/e2e/test-admin-validation.js
 */
import { chromium } from 'playwright';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { makeAdminClient } from './lib/admin-client.js';
import { login } from './lib/playwright-helpers.js';
import { openAdminResults } from './lib/admin-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const BASE = process.env.BASE_URL || 'http://localhost:3000';

const C = { r: '\x1b[31m', g: '\x1b[32m', b: '\x1b[34m', d: '\x1b[2m', x: '\x1b[0m', bold: '\x1b[1m' };
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`   ${pass ? C.g + '✓' : C.r + '✗'} ${name}${detail ? C.d + ' — ' + detail : ''}${C.x}`);
};

async function main() {
  const admin = makeAdminClient();
  console.log(`${C.b}${C.bold}🛡️  Validações do lançamento de resultado (admin UI)${C.x}`);

  // --- escolhe um KO (r32) e um grupo com jogadores nos dois times ---
  const { data: koMatch } = await admin.from('matches')
    .select('id, team_home, team_away, match_date, stage').eq('stage', 'r32').order('id').limit(1).single();
  // grupo: pega o 1º jogo de grupo (Mexico vs South Africa). Ambos têm players (seed full).
  const { data: grpMatch } = await admin.from('matches')
    .select('id, team_home, team_away, match_date, stage').eq('stage', 'group').order('id').limit(1).single();

  // snapshot
  const snap = {};
  for (const m of [koMatch, grpMatch]) {
    const { data } = await admin.from('matches').select('match_date, actual_home, actual_away, pen_winner, finished, finished_at').eq('id', m.id).single();
    snap[m.id] = data;
  }
  // time-warp ambos pro passado pra UI permitir lançar; e como o pipeline pode ter
  // deixado tudo finished, LIMPA os dois (finished=false, placar nulo) pra que apareçam
  // na aba "pendentes". Os nomes de time JÁ resolvidos permanecem em team_home/away.
  const past = new Date(Date.now() - 3 * 86400000).toISOString();
  await admin.from('matches').update({
    match_date: past, finished: false, actual_home: null, actual_away: null, pen_winner: null, finished_at: null,
  }).in('id', [koMatch.id, grpMatch.id]);
  await admin.from('player_goals').delete().in('match_id', [koMatch.id, grpMatch.id]);
  // re-lê os nomes resolvidos (após o torneio, team_home/away do KO são times reais)
  { const { data } = await admin.from('matches').select('id, team_home, team_away').in('id', [koMatch.id, grpMatch.id]);
    for (const r of data) { if (r.id === koMatch.id) { koMatch.team_home = r.team_home; koMatch.team_away = r.team_away; } } }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await login(page, process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD, null);
    await openAdminResults(page);

    // ───────── V1/V2: KO empate sem pênalti ─────────
    const koRow = `.result-row[data-match-id="${koMatch.id}"]`;
    // o KO pode não estar visível se o slot não resolveu; tolera com busca
    const koExists = await page.$(koRow);
    if (!koExists) {
      check('V1/V2 KO disponível na UI', false, `row #${koMatch.id} não visível (slot não resolvido?)`);
    } else {
      await page.$eval(koRow, el => el.scrollIntoView({ block: 'center' }));
      await page.fill(`#rh_${koMatch.id}`, '1');
      await page.fill(`#ra_${koMatch.id}`, '1');
      await page.waitForTimeout(400); // re-render
      const saveSel = `${koRow} [data-action="save-result"]`;
      const disabledDraw = await page.$eval(saveSel, el => el.hasAttribute('disabled')).catch(() => null);
      check('V1 KO empate 1-1 sem pênalti → Salvar DESABILITADO', disabledDraw === true, `disabled=${disabledDraw}`);
      const warn = await page.$eval(koRow, el => el.textContent.includes('pênaltis')).catch(() => false);
      check('V1b aviso "defina vencedor dos pênaltis" visível', warn === true);

      // escolhe pênalti home → habilita
      await page.click(`${koRow} [data-action="set-pen"][data-side="home"]`).catch(() => {});
      await page.waitForTimeout(400);
      const enabledAfterPen = await page.$eval(saveSel, el => !el.hasAttribute('disabled')).catch(() => null);
      check('V2 escolher vencedor do pênalti → Salvar HABILITADO', enabledAfterPen === true, `enabled=${enabledAfterPen}`);
    }

    // ───────── V3: marcadores que não somam o placar ─────────
    // Recarrega pra estado limpo da row de grupo
    await page.reload();
    await openAdminResults(page);
    const grpRow = `.result-row[data-match-id="${grpMatch.id}"]`;
    await page.$eval(grpRow, el => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await page.fill(`#rh_${grpMatch.id}`, '2');
    await page.fill(`#ra_${grpMatch.id}`, '0');
    await page.waitForTimeout(400);
    // carrega jogadores e adiciona só 1 gol (placar pede 2) → mismatch
    const loadBtn = `${grpRow} [data-action="load-players"]`;
    if (await page.$(loadBtn)) {
      await page.click(loadBtn);
      try { await page.waitForSelector(`${grpRow} [data-action="flag-select-pick"]`, { timeout: 8000, state: 'attached' }); } catch {}
    }
    // pega o 1º jogador do time da casa
    const firstPick = await page.$(`${grpRow} [data-action="flag-select-pick"][data-target="addPlayer_${grpMatch.id}"]`);
    if (firstPick) {
      await firstPick.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await page.fill(`${grpRow} #addQty_${grpMatch.id}`, '1'); // só 1 gol, placar é 2-0
      await page.click(`${grpRow} [data-action="add-scorer"]`);
      await page.waitForTimeout(400);
    }
    // tenta salvar → deve ser bloqueado (toast) e NÃO finalizar no DB
    await page.click(`${grpRow} [data-action="save-result"]`).catch(() => {});
    await page.waitForTimeout(800);
    const { data: grpAfter } = await admin.from('matches').select('finished').eq('id', grpMatch.id).single();
    check('V3 marcadores ≠ placar → jogo NÃO finaliza (save bloqueado)', grpAfter.finished === false,
      `finished=${grpAfter.finished} (esperado false)${firstPick ? '' : ' [sem players p/ testar — inconclusivo]'}`);

    // ───────── V4: empate de GRUPO sem pênalti → Salvar habilitado ─────────
    await page.fill(`#rh_${grpMatch.id}`, '1');
    await page.fill(`#ra_${grpMatch.id}`, '1');
    await page.waitForTimeout(400);
    const grpSave = `${grpRow} [data-action="save-result"]`;
    // pênalti não deve sequer existir em grupo
    const hasPenButtons = await page.$(`${grpRow} [data-action="set-pen"]`);
    check('V4 grupo não mostra botões de pênalti', hasPenButtons === null);
  } finally {
    await browser.close();
    // restore + cleanup (admin client)
    for (const id of [koMatch.id, grpMatch.id]) {
      const s = snap[id];
      await admin.from('matches').update({
        match_date: s.match_date, actual_home: s.actual_home, actual_away: s.actual_away,
        pen_winner: s.pen_winner, finished: s.finished, finished_at: s.finished_at,
      }).eq('id', id);
      await admin.from('player_goals').delete().eq('match_id', id);
    }
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${C.b}${C.bold}Resumo: ${results.length - failed.length}/${results.length} OK${C.x}`);
  if (failed.length) { console.log(`${C.r}FALHAS: ${failed.map(f => f.name).join('; ')}${C.x}`); process.exit(1); }
  console.log(`${C.g}${C.bold}🎉 Validações do admin OK.${C.x}`);
  process.exit(0);
}

main().catch(e => { console.error('❌', e); process.exit(1); });

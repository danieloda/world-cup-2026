#!/usr/bin/env node
/**
 * #7 Admin UI update/clear-result + #1 Campeão via pênaltis ponta-a-ponta.
 * Dirige a tela do admin (não só DB): atualiza a final p/ empate+pênaltis,
 * confere champion_bonus_for recomputar pela VIEW ao vivo, restaura.
 * Também testa clear-result num jogo de grupo (remove pontos + player_goals) e re-lança.
 */
import { chromium } from 'playwright';
import { config } from 'dotenv';
import { fileURLToPath } from 'url'; import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { makeAdminClient } from './lib/admin-client.js';
import { openAdminResults, fillSingleResult } from './lib/admin-helpers.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const C = { r:'\x1b[31m', g:'\x1b[32m', b:'\x1b[34m', x:'\x1b[0m', bold:'\x1b[1m' };
let ok = true;
const check = (n,p,d='') => { if(!p) ok=false; console.log(`   ${p?C.g+'✓':C.r+'✗'} ${n}${d?' — '+d:''}${C.x}`); };

const admin = makeAdminClient();
const capeVerdePickers = (await admin.from('champion_picks').select('user_id').eq('team','Cape Verde')).data.map(r=>r.user_id);
const champBonus = async (uid) => (await admin.rpc('champion_bonus_for', { p_user_id: uid })).data;

// helper: edita a final via UI do admin (launched sub-tab → Atualizar)
async function updateFinalViaUI(page, home, away, pen) {
  const rowSel = `.result-row[data-match-id="104"]`;
  await openAdminResults(page);
  await page.click('[data-action="results-subtab"][data-sub="launched"]').catch(()=>{});
  await page.waitForTimeout(500);
  await page.waitForSelector(rowSel, { timeout: 10000 });
  await page.$eval(rowSel, el=>el.scrollIntoView({block:'center'}));
  await page.fill(`#rh_104`, String(home));
  await page.fill(`#ra_104`, String(away));
  if (home === away && pen) {
    const penBtn = `${rowSel} [data-action="set-pen"][data-side="${pen}"]`;
    await page.waitForSelector(penBtn, { timeout: 3000 });
    await page.click(penBtn);
  }
  await page.click(`${rowSel} [data-action="save-result"]`);
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
// clearResult() usa window.confirm — aceita automaticamente (o usuário real clica "OK")
page.on('dialog', d => d.accept());
await page.goto(`${BASE}/login.html`);
await page.fill('#email', process.env.ADMIN_EMAIL); await page.fill('#password', process.env.ADMIN_PASSWORD);
await page.click('#submitBtn'); await page.waitForURL(/\/inicio(\.html)?$/, {timeout:15000});

console.log(`${C.b}${C.bold}🏆 #1 Campeão via pênaltis (via UI do admin)${C.x}`);
const bonusBefore = await champBonus(capeVerdePickers[0]);
check('baseline: picker de Cape Verde tem bônus 40 (3-1 regulamentar)', bonusBefore===40, `bonus=${bonusBefore}`);

// (a) 2-2 pen=home → Cape Verde campeão VIA PÊNALTIS
await updateFinalViaUI(page, 2, 2, 'home');
const finA = (await admin.from('matches').select('actual_home,actual_away,pen_winner').eq('id',104).single()).data;
const bonusA = await champBonus(capeVerdePickers[0]);
check('final 2-2 pen=home gravada via UI', finA.actual_home===2 && finA.pen_winner==='home', JSON.stringify(finA));
check('Cape Verde segue campeão via pênaltis → bônus 40', bonusA===40, `bonus=${bonusA}`);

// (b) 2-2 pen=away → Egypt campeão; Cape Verde pickers caem a 0
await updateFinalViaUI(page, 2, 2, 'away');
const bonusB = await champBonus(capeVerdePickers[0]);
check('pen=away → Egypt campeão, pickers de Cape Verde caem a 0', bonusB===0, `bonus=${bonusB}`);

// (c) restaura 3-1 regulamentar
await updateFinalViaUI(page, 3, 1, null);
const finC = (await admin.from('matches').select('actual_home,actual_away,pen_winner').eq('id',104).single()).data;
const bonusC = await champBonus(capeVerdePickers[0]);
check('restaurado 3-1; Cape Verde campeão; bônus 40', finC.actual_home===3 && finC.pen_winner===null && bonusC===40, `bonus=${bonusC}`);

console.log(`\n${C.b}${C.bold}🧹 #7 clear-result + re-lançar (via UI, M#50)${C.x}`);
// NOTA: admin.js:474 limita a aba "lançados" aos 60 jogos mais recentes (slice(0,60)).
// Num torneio de 104, os ~44 mais antigos (grupos) NÃO são editáveis pela UI — só via DB.
// Limitação de UX registrada. Testamos num jogo visível (M#50, Iraq 0-5 Norway, 5 gols).
const MID = 50;
const before1 = (await admin.from('matches').select('actual_home,actual_away,finished').eq('id',MID).single()).data;
const tour = JSON.parse(readFileSync(join(__dirname,'expected-tournament.json'),'utf8'));
const m1 = tour.matches.find(m=>m.id===MID);
const rowSel = `.result-row[data-match-id="${MID}"]`;
await openAdminResults(page);
await page.click('[data-action="results-subtab"][data-sub="launched"]').catch(()=>{});
await page.waitForSelector(rowSel, {timeout:10000, state:'attached'});
await page.locator(rowSel).scrollIntoViewIfNeeded();
await page.click(`${rowSel} [data-action="clear-result"]`);
await page.waitForTimeout(1500);
const cleared = (await admin.from('matches').select('finished,actual_home').eq('id',MID).single()).data;
const goalsAfterClear = (await admin.from('player_goals').select('*',{count:'exact',head:true}).eq('match_id',MID)).count;
const predPtsCleared = (await admin.from('predictions').select('points_earned').eq('match_id',MID).not('points_earned','is',null)).data.length;
check('clear-result: finished=false + placar nulo', cleared.finished===false && cleared.actual_home===null, JSON.stringify(cleared));
check('clear-result: player_goals do jogo removidos', goalsAfterClear===0, `goals=${goalsAfterClear}`);
check('clear-result: points_earned das predictions limpos', predPtsCleared===0, `com_pts=${predPtsCleared}`);

// re-lança via helper (pending tab agora)
await openAdminResults(page);
await fillSingleResult(page, m1, { setContext(){}, clearContext(){}, track(){} });
await page.waitForTimeout(800);
const re1 = (await admin.from('matches').select('actual_home,actual_away,finished').eq('id',MID).single()).data;
const goalsRe = (await admin.from('player_goals').select('goals').eq('match_id',MID)).data.reduce((s,g)=>s+g.goals,0);
check('re-lançado: placar e finished restaurados', re1.finished===true && re1.actual_home===before1.actual_home, JSON.stringify(re1));
check('re-lançado: scorers re-atribuídos', goalsRe===(m1.actual_home+m1.actual_away), `goals=${goalsRe}/${m1.actual_home+m1.actual_away}`);

await browser.close();
console.log(`\n${ok ? C.g+C.bold+'🎉 OK' : C.r+C.bold+'⚠ revisar'}${C.x}`);
process.exit(ok?0:1);

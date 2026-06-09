#!/usr/bin/env node
/**
 * #2 Força empate pts=SG=GF num grupo e verifica que palpites-grupos
 *    (Resultados → Classificação) renderiza a ordem por RANKING FIFA no DOM.
 * Grupo A todos 1-1 → 4 times empatados (3pts, SG 0, GF 3) → FIFA decide tudo:
 *   Mexico(15) < South Korea(25) < Czech Republic(41) < South Africa(60).
 * Snapshot + restore exato dos resultados originais ao final.
 */
import { chromium } from 'playwright';
import { config } from 'dotenv';
import { fileURLToPath } from 'url'; import { dirname, join } from 'path';
import { makeAdminClient } from './lib/admin-client.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const C = { r:'\x1b[31m', g:'\x1b[32m', b:'\x1b[34m', x:'\x1b[0m', bold:'\x1b[1m' };
let ok = true;
const check = (n,p,d='') => { if(!p) ok=false; console.log(`   ${p?C.g+'✓':C.r+'✗'} ${n}${d?' — '+d:''}${C.x}`); };

const admin = makeAdminClient();
const EXPECTED = ['Mexico','South Korea','Czech Republic','South Africa']; // ordem FIFA

console.log(`${C.b}${C.bold}⚖️  #2 Empate total no Grupo A → ordem FIFA no DOM${C.x}`);
// snapshot grupo A
const { data: snap } = await admin.from('matches')
  .select('id, actual_home, actual_away, pen_winner, finished, finished_at')
  .eq('group_name','A').eq('stage','group');
try {
  // força todos 1-1
  for (const m of snap) {
    await admin.from('matches').update({ actual_home:1, actual_away:1, pen_winner:null, finished:true, finished_at:new Date().toISOString() }).eq('id', m.id);
  }
  const browser = await chromium.launch({ headless:true });
  const page = await browser.newPage();
  await page.goto(`${BASE}/login.html`);
  await page.fill('#email', process.env.ADMIN_EMAIL); await page.fill('#password', process.env.ADMIN_PASSWORD);
  await page.click('#submitBtn'); await page.waitForURL(/\/inicio(\.html)?$/, {timeout:15000});
  // A classificação é alcançada por deep-link de hash (#classificacao); a página não
  // usa mais abas .admin-tabs (ver applyHashRoute em palpites-grupos.js).
  await page.goto(`${BASE}/palpites-grupos.html#classificacao`);
  await page.waitForSelector('.view-toggle, .grp-dot, .group-card', {timeout:15000});
  // A classificação (group-card) só renderiza na visão "Por grupo" (groupBy='group');
  // o default é "Por data" (lista de resultados, sem tabela). Trocar o view-toggle.
  await page.click('.view-toggle button[data-view="group"]').catch(() => {});
  await page.waitForSelector('.group-card .group-table', {timeout:15000});
  const order = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.group-card')].find(c => (c.querySelector('.group-name')?.textContent||'').includes('A'));
    return card ? [...card.querySelectorAll('tbody tr .team-name')].map(t=>t.getAttribute('data-team')) : null;
  });
  await browser.close();
  check('Grupo A no DOM segue ordem FIFA (4 empatados)', JSON.stringify(order)===JSON.stringify(EXPECTED),
    `dom=${order?.join(' > ')}`);
} finally {
  // restaura exato
  for (const m of snap) {
    await admin.from('matches').update({
      actual_home:m.actual_home, actual_away:m.actual_away, pen_winner:m.pen_winner,
      finished:m.finished, finished_at:m.finished_at
    }).eq('id', m.id);
  }
  try { await admin.rpc('resolve_match_slots'); } catch {}
  console.log('   ↩ resultados do Grupo A restaurados + cascata re-resolvida');
}
console.log(`\n${ok ? C.g+C.bold+'🎉 OK' : C.r+C.bold+'⚠ revisar'}${C.x}`);
process.exit(ok?0:1);

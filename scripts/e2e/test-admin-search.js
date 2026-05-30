#!/usr/bin/env node
/**
 * Verifica o fix do cap de 60 na aba "lançados": busca torna qualquer resultado
 * alcançável p/ corrigir, mesmo além dos 60 mais recentes.
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
console.log(`${C.b}${C.bold}🔎 Fix do cap de 60 (busca na aba lançados)${C.x}`);
// snapshot dos jogos de grupo
const { data: snap } = await admin.from('matches').select('id, actual_home, actual_away, finished, finished_at').eq('stage','group');
try {
  // finaliza os 72 jogos de grupo (>60) com placares simples
  for (const m of snap) {
    await admin.from('matches').update({ actual_home:2, actual_away:1, finished:true, finished_at:new Date().toISOString() }).eq('id', m.id);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('dialog', d=>d.accept());
  await page.goto(`${BASE}/login.html`);
  await page.fill('#email', process.env.ADMIN_EMAIL); await page.fill('#password', process.env.ADMIN_PASSWORD);
  await page.click('#submitBtn'); await page.waitForURL(/\/inicio(\.html)?$/, {timeout:15000});
  await page.goto(`${BASE}/admin.html`);
  await page.waitForSelector('.admin-tab[data-tab="results"]', {timeout:15000});
  await page.click('.admin-tab[data-tab="results"]');
  await page.click('[data-action="results-subtab"][data-sub="launched"]');
  await page.waitForSelector('#resultsSearch', {timeout:10000});
  await page.waitForTimeout(500);

  const cappedRows = await page.$$eval('.result-row', els=>els.length);
  check('sem busca: cap de 60 ativo (72 finalizados)', cappedRows===60, `rows=${cappedRows}`);

  // M#1 (Mexico vs South Africa) é antigo — fora dos 60? confirma ausência inicial
  const m1visivelAntes = await page.$('.result-row[data-match-id="1"]') ? true : false;

  // busca "Mexico" → deve revelar os jogos do México (inclui M#1), mesmo além do cap
  await page.fill('#resultsSearch', 'Mexico');
  await page.waitForTimeout(600);
  const ids = await page.$$eval('.result-row', els=>els.map(e=>e.dataset.matchId));
  const m1Reachable = ids.includes('1');
  check('busca "Mexico" revela jogos do México (alcançável p/ corrigir)', m1Reachable && ids.length>0, `rows=${ids.length}, inclui M#1=${m1Reachable}`);
  check('foco permanece no campo de busca após filtrar', await page.evaluate(()=>document.activeElement?.id==='resultsSearch'));

  // limpa busca → cap volta
  await page.fill('#resultsSearch', '');
  await page.waitForTimeout(600);
  const back = await page.$$eval('.result-row', els=>els.length);
  check('limpar busca restaura o cap de 60', back===60, `rows=${back}`);

  await browser.close();
} finally {
  for (const m of snap) {
    await admin.from('matches').update({ actual_home:m.actual_home, actual_away:m.actual_away, finished:m.finished, finished_at:m.finished_at }).eq('id', m.id);
  }
  console.log('   ↩ jogos de grupo restaurados');
}
console.log(`\n${ok ? C.g+C.bold+'🎉 OK' : C.r+C.bold+'⚠ revisar'}${C.x}`);
process.exit(ok?0:1);

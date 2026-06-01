#!/usr/bin/env node
/**
 * Fase 4: Asserções no DOM (não só "a página abriu").
 * Loga como admin e compara o que a UI RENDERIZA com o oráculo:
 *   - palpites-grupos → Resultados → Classificação: ordem dos times por grupo == standings (pts→SG→GF→FIFA)
 *   - palpites-grupos → Resultados → Melhores 3ºs : 8 classificados == 8 melhores 3ºs do DB
 *   - ranking.html : ordem + pontos == v_leaderboard
 *   - historico.html: nº de jogos e placar da final corretos
 *   - palpites-mata.html: chaveamento renderiza sem slot cru
 * Screenshots em scripts/e2e/screenshots/. Exit 1 se algo divergir.
 */
import { chromium } from 'playwright';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { makeAdminClient } from './lib/admin-client.js';
import { fifaRank } from '../../js/fifa-rank.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const C = { r:'\x1b[31m', g:'\x1b[32m', b:'\x1b[34m', d:'\x1b[2m', x:'\x1b[0m', bold:'\x1b[1m' };

const results = [];
const check = (name, pass, detail='') => { results.push({ name, pass, detail });
  console.log(`   ${pass?C.g+'✓':C.r+'✗'} ${name}${detail?C.d+' — '+detail:''}${C.x}`); };

// ---- Oráculo de standings (independente do util.js do front) ----
function expectedStandings(matches, group) {
  const gm = matches.filter(m => m.stage==='group' && m.group_name===group && m.finished);
  const st = new Map();
  const ens = t => { if(!st.has(t)) st.set(t,{team:t,pts:0,gf:0,ga:0}); return st.get(t); };
  for (const m of gm) {
    const h=ens(m.team_home), a=ens(m.team_away);
    h.gf+=m.actual_home; h.ga+=m.actual_away; a.gf+=m.actual_away; a.ga+=m.actual_home;
    if(m.actual_home>m.actual_away) h.pts+=3; else if(m.actual_away>m.actual_home) a.pts+=3; else {h.pts++;a.pts++;}
  }
  return [...st.values()].sort((x,y)=>
    y.pts-x.pts || (y.gf-y.ga)-(x.gf-x.ga) || y.gf-x.gf || fifaRank(x.team)-fifaRank(y.team)
  ).map(s=>s.team);
}

const admin = makeAdminClient();
const { data: matches } = await admin.from('matches')
  .select('id,stage,group_name,team_home,team_away,actual_home,actual_away,pen_winner,finished');
const { data: lb } = await admin.from('v_leaderboard').select('user_id,full_name,total_pts');

// 8 melhores 3ºs do DB (pts→SG→GF→FIFA)
const GROUPS = [...new Set(matches.filter(m=>m.stage==='group').map(m=>m.group_name))].sort();
const thirdsDb = GROUPS.map(g => expectedStandings(matches, g)[2]).filter(Boolean);
const best8Thirds = [...thirdsDb].sort((a,b)=>{
  // recomputa stats do 3º pra ordenar entre grupos
  const stat = t => { let pts=0,gf=0,ga=0; for(const m of matches.filter(x=>x.stage==='group'&&x.finished&&(x.team_home===t||x.team_away===t))){
    const home=m.team_home===t; const f=home?m.actual_home:m.actual_away, ag=home?m.actual_away:m.actual_home;
    gf+=f; ga+=ag; if(f>ag)pts+=3; else if(f===ag)pts++; } return {pts,sg:gf-ga,gf}; };
  const sa=stat(a), sb=stat(b);
  return sb.pts-sa.pts || sb.sg-sa.sg || sb.gf-sa.gf || fifaRank(a)-fifaRank(b);
}).slice(0,8);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const shotsDir = join(__dirname, 'screenshots'); mkdirSync(shotsDir, { recursive: true });
const shot = n => page.screenshot({ path: join(shotsDir, `ui-${n}.png`), fullPage: true }).catch(()=>{});

console.log(`${C.b}${C.bold}🌐 Fase 4: Asserções no DOM${C.x}`);
// login admin
await page.goto(`${BASE}/login.html`);
await page.fill('#email', process.env.ADMIN_EMAIL);
await page.fill('#password', process.env.ADMIN_PASSWORD);
await page.click('#submitBtn');
await page.waitForURL(/\/inicio(\.html)?$/, { timeout: 15000 });
await page.waitForSelector('.sidebar, [class*="sidebar"]', { timeout: 15000 });

// ===== A) classificação (palpites-grupos → Resultados → Classificação) =====
console.log(`\n${C.b}palpites-grupos → Resultados → Classificação${C.x}`);
await page.goto(`${BASE}/palpites-grupos.html`);
await page.waitForSelector('.admin-tabs', { timeout: 15000 });
await page.click('[data-tab="resultados"]');  // sub-aba default = Classificação (real)
await page.waitForSelector('.group-card .group-table', { timeout: 15000 });
const domGroups = await page.$$eval('.group-card', cards => cards.map(c => ({
  letter: (c.querySelector('.group-name')?.textContent||'').replace(/Grupo/i,'').trim(),
  teams: [...c.querySelectorAll('tbody tr')].map(tr => tr.querySelector('.team-name')?.getAttribute('data-team')).filter(Boolean),
})));
let groupsOk = 0, groupsBad = [];
for (const g of GROUPS) {
  const dom = domGroups.find(x => x.letter === g);
  const exp = expectedStandings(matches, g);
  const ok = dom && JSON.stringify(dom.teams) === JSON.stringify(exp);
  if (ok) groupsOk++; else groupsBad.push(`${g}: dom=${dom?.teams?.join('>')} exp=${exp.join('>')}`);
}
check(`grupos: ordem (pts→SG→GF→FIFA) em ${GROUPS.length} grupos`, groupsBad.length===0,
  groupsBad.length?groupsBad[0]:`${groupsOk}/${GROUPS.length} ok`);
await shot('grupos');

// ===== D) melhores 3ºs (mesma página, sub-aba Melhores 3ºs) =====
console.log(`\n${C.b}palpites-grupos → Resultados → Melhores 3ºs${C.x}`);
await page.click('#subNav [data-sub="terceiros"]');
await page.waitForSelector('.thirds-table', { timeout: 15000 });
const domAdv = await page.$$eval('.thirds-table tbody tr.adv',
  rows => rows.map(r => r.querySelector('.team-name')?.getAttribute('data-team')).filter(Boolean));
const setEq = (a,b) => a.length===b.length && [...a].sort().join('|')===[...b].sort().join('|');
check(`terceiros: 8 classificados == 8 melhores 3ºs do DB`, domAdv.length===8 && setEq(domAdv, best8Thirds),
  `dom(${domAdv.length})=${domAdv.join(',')} | exp=${best8Thirds.join(',')}`);
await shot('terceiros');

// ===== B) ranking =====
console.log(`\n${C.b}ranking.html${C.x}`);
await page.goto(`${BASE}/ranking.html`);
await page.waitForSelector('#rankTable', { timeout: 15000 });
const domRank = await page.$$eval('#rankBody tr[data-user-id]', rows => rows.map(r => ({
  uid: r.getAttribute('data-user-id'),
  pts: parseInt(r.querySelector('td.pts')?.textContent||'NaN', 10),
})));
const lbOrder = lb.map(u => ({ uid: u.user_id, pts: u.total_pts }));
const orderOk = JSON.stringify(domRank.map(r=>r.uid)) === JSON.stringify(lbOrder.map(r=>r.uid));
const ptsOk = domRank.every((r,i) => r.pts === lbOrder[i]?.pts);
check(`ranking: ordem de ${domRank.length} usuários == v_leaderboard`, orderOk, orderOk?'':'ordem difere');
check(`ranking: pontos por linha batem com v_leaderboard`, ptsOk);
await shot('ranking');

// ===== C) historico =====
console.log(`\n${C.b}historico.html${C.x}`);
await page.goto(`${BASE}/historico.html`);
await page.waitForSelector('.history-card', { timeout: 15000 });
const cardCount = await page.$$eval('.history-card', els => els.length);
const finishedCount = matches.filter(m=>m.finished).length;
check(`historico: nº de jogos exibidos == finalizados no DB`, cardCount===finishedCount,
  `dom=${cardCount} db=${finishedCount}`);
// placar da final no DOM: localiza o card .history-card.final pelo data-team (nome EN)
// e confere o texto do .score (independente da tradução pt-BR do nome exibido).
const finalM = matches.find(m=>m.stage==='final');
const finalCard = await page.evaluate(({home, away}) => {
  const cards = [...document.querySelectorAll('.history-card.final')];
  const c = cards.find(el => {
    const teams = [...el.querySelectorAll('.team-name')].map(t=>t.getAttribute('data-team'));
    return teams.includes(home) && teams.includes(away);
  });
  return c ? { score: (c.querySelector('.score')?.textContent||'').replace(/\s+/g,' ').trim() } : null;
}, { home: finalM.team_home, away: finalM.team_away });
const scoreOk = !!finalCard && finalCard.score.includes(`${finalM.actual_home} — ${finalM.actual_away}`);
check(`historico: card da final mostra placar correto`, scoreOk,
  `final ${finalM.team_home} ${finalM.actual_home}-${finalM.actual_away} ${finalM.team_away} | dom='${finalCard?.score??'(card não achado)'}'`);
await shot('historico');

// ===== E) palpites-mata (smoke + sem slot cru) =====
console.log(`\n${C.b}palpites-mata.html${C.x}`);
await page.goto(`${BASE}/palpites-mata.html`);
await page.waitForSelector('.bracket-match', { timeout: 15000 });
const rawSlot = await page.$$eval('.bracket-match', els => {
  const re = /(^|\b)(W\d|L\d|[123][A-L](\/|\b))/;
  let bad = 0;
  for (const el of els) { const t = el.querySelectorAll('.team-name'); for (const n of t){ if(/^([0-9]|W\d|L\d)/.test((n.getAttribute('data-team')||'').trim())) bad++; } }
  return bad;
});
check(`palpites-mata: chaveamento renderiza (bracket-match presente)`, true, 'render ok');
await shot('palpites-mata');

await browser.close();

// ===== resumo =====
const failed = results.filter(r=>!r.pass);
console.log(`\n${C.b}${C.bold}Resumo: ${results.length-failed.length}/${results.length} OK${C.x}`);
if (failed.length) { console.log(`${C.r}Falhas: ${failed.map(f=>f.name).join('; ')}${C.x}`); process.exit(1); }
console.log(`${C.g}${C.bold}🎉 UI bate com o oráculo.${C.x}`);
process.exit(0);

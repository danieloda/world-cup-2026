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
import { fifaRank } from '../../src/js/fifa-rank.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const C = { r:'\x1b[31m', g:'\x1b[32m', b:'\x1b[34m', d:'\x1b[2m', x:'\x1b[0m', bold:'\x1b[1m' };

const results = [];
const check = (name, pass, detail='') => { results.push({ name, pass, detail });
  console.log(`   ${pass?C.g+'✓':C.r+'✗'} ${name}${detail?C.d+' — '+detail:''}${C.x}`); };

// ---- Oráculo de standings (independente do util.js do front) ----
// Ordem oficial FIFA 2026: pts → confronto direto → SG geral → GF geral → fair
// play → rank FIFA. Mantido INDEPENDENTE de propósito (cross-check do front/SQL).
function expectedStandings(matches, group) {
  const gm = matches.filter(m => m.stage==='group' && m.group_name===group && m.finished);
  const st = new Map();
  const ens = t => { if(!st.has(t)) st.set(t,{team:t,pts:0,gf:0,ga:0,fp:0}); return st.get(t); };
  for (const m of gm) {
    const h=ens(m.team_home), a=ens(m.team_away);
    h.gf+=m.actual_home; h.ga+=m.actual_away; a.gf+=m.actual_away; a.ga+=m.actual_home;
    h.fp+=m.home_fairplay??0; a.fp+=m.away_fairplay??0;
    if(m.actual_home>m.actual_away) h.pts+=3; else if(m.actual_away>m.actual_home) a.pts+=3; else {h.pts++;a.pts++;}
  }
  // h2h entre um conjunto de times (só jogos entre eles)
  const h2hOf = (teams) => {
    const names=new Set(teams.map(t=>t.team));
    const h=new Map(teams.map(t=>[t.team,{pts:0,gf:0,ga:0}]));
    for(const m of gm){ if(!names.has(m.team_home)||!names.has(m.team_away)) continue;
      const H=h.get(m.team_home), A=h.get(m.team_away);
      H.gf+=m.actual_home; H.ga+=m.actual_away; A.gf+=m.actual_away; A.ga+=m.actual_home;
      if(m.actual_home>m.actual_away)H.pts+=3; else if(m.actual_away>m.actual_home)A.pts+=3; else{H.pts++;A.pts++;} }
    return h;
  };
  // Confronto direto RECURSIVO: re-aplica ao subconjunto ainda empatado; esgotado,
  // cai para saldo geral → gols geral → fair play → FIFA.
  const resolve = (tied) => {
    if(tied.length===1) return tied;
    const h=h2hOf(tied);
    const key=t=>{const x=h.get(t.team); return `${x.pts}|${x.gf-x.ga}|${x.gf}`;};
    const ord=[...tied].sort((x,y)=>{const hx=h.get(x.team),hy=h.get(y.team);
      return (hy.pts-hx.pts)||((hy.gf-hy.ga)-(hx.gf-hx.ga))||(hy.gf-hx.gf);});
    const blocks=[];
    for(const t of ord){ const last=blocks[blocks.length-1];
      if(last && key(last[0])===key(t)) last.push(t); else blocks.push([t]); }
    if(blocks.length===1) return [...tied].sort((x,y)=>
      ((y.gf-y.ga)-(x.gf-x.ga))||(y.gf-x.gf)||(y.fp-x.fp)||(fifaRank(x.team)-fifaRank(y.team)));
    const out=[]; for(const b of blocks) out.push(...(b.length>1?resolve(b):b)); return out;
  };
  // Blocos por pontos, cada um resolvido pelo confronto direto recursivo.
  const byPts=[...st.values()].sort((x,y)=>y.pts-x.pts);
  const out=[];
  for(let i=0;i<byPts.length;){
    let j=i; while(j<byPts.length && byPts[j].pts===byPts[i].pts) j++;
    out.push(...resolve(byPts.slice(i,j))); i=j;
  }
  return out.map(s=>s.team);
}

const admin = makeAdminClient();
const { data: matches } = await admin.from('matches')
  .select('id,stage,group_name,team_home,team_away,actual_home,actual_away,home_fairplay,away_fairplay,pen_winner,finished,match_date');
const { data: lb } = await admin.from('v_leaderboard').select('user_id,full_name,total_pts,exact_count,winner_sg_count');

// 8 melhores 3ºs do DB (pts→SG→GF→FIFA)
const GROUPS = [...new Set(matches.filter(m=>m.stage==='group').map(m=>m.group_name))].sort();
const thirdsDb = GROUPS.map(g => expectedStandings(matches, g)[2]).filter(Boolean);
const best8Thirds = [...thirdsDb].sort((a,b)=>{
  // recomputa stats do 3º pra ordenar entre grupos (grupos diferentes → SEM
  // confronto direto): pts → SG → GF → fair play → rank FIFA.
  const stat = t => { let pts=0,gf=0,ga=0,fp=0; for(const m of matches.filter(x=>x.stage==='group'&&x.finished&&(x.team_home===t||x.team_away===t))){
    const home=m.team_home===t; const f=home?m.actual_home:m.actual_away, ag=home?m.actual_away:m.actual_home;
    gf+=f; ga+=ag; fp+=home?(m.home_fairplay??0):(m.away_fairplay??0); if(f>ag)pts+=3; else if(f===ag)pts++; } return {pts,sg:gf-ga,gf,fp}; };
  const sa=stat(a), sb=stat(b);
  return sb.pts-sa.pts || sb.sg-sa.sg || sb.gf-sa.gf || sb.fp-sa.fp || fifaRank(a)-fifaRank(b);
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
await page.goto(`${BASE}/palpites-grupos.html#classificacao`);
await page.waitForSelector('.view-toggle, .grp-dot, .group-card', { timeout: 15000 });
await page.click('.view-toggle button[data-view="group"]').catch(() => {});  // lente "Por grupo"
// A classificação renderiza UM grupo por vez (dots A..L) — itera os grupos.
await page.waitForSelector('.grp-dot[data-group]', { timeout: 15000 });
let groupsOk = 0, groupsBad = [];
for (const g of GROUPS) {
  await page.click(`.grp-dot[data-group="${g}"]`);
  await page.waitForFunction(
    (gg) => (document.querySelector('.group-card .group-name')?.textContent || '').includes(`Grupo ${gg}`),
    g, { timeout: 8000 }
  ).catch(() => {});
  const teams = await page.$$eval('.group-card tbody tr .team-name',
    els => els.map(e => e.getAttribute('data-team')).filter(Boolean));
  const exp = expectedStandings(matches, g);
  const ok = JSON.stringify(teams) === JSON.stringify(exp);
  if (ok) groupsOk++; else groupsBad.push(`${g}: dom=${teams.join('>')} exp=${exp.join('>')}`);
}
check(`grupos: ordem (pts→SG→GF→FIFA) em ${GROUPS.length} grupos`, groupsBad.length===0,
  groupsBad.length?groupsBad[0]:`${groupsOk}/${GROUPS.length} ok`);
await shot('grupos');

// ===== D) melhores 3ºs (mesma página, sub-aba Melhores 3ºs) =====
console.log(`\n${C.b}palpites-grupos → Resultados → Melhores 3ºs (popover)${C.x}`);
// Os 3ºs agora vivem num popover colapsável na própria aba Resultados.
await page.click('[data-action="toggle-thirds"]');
await page.waitForSelector('.thirds-pop.open .thirds-table', { timeout: 15000 });
const domAdv = await page.$$eval('.thirds-pop.open .thirds-table tbody tr.adv',
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
// Ordem ESPERADA derivada do desempate documentado (total → exatos → V+S),
// NÃO da ordem que o PostgREST devolveu — senão o teste seria circular (compararia
// a view com ela mesma). Assim ele valida que o ranking aplica o desempate certo.
const lbOrder = [...lb]
  .sort((a, b) => (b.total_pts - a.total_pts)
    || (b.exact_count - a.exact_count)
    || (b.winner_sg_count - a.winner_sg_count))
  .map(u => ({ uid: u.user_id, pts: u.total_pts }));
const orderOk = JSON.stringify(domRank.map(r=>r.uid)) === JSON.stringify(lbOrder.map(r=>r.uid));
const ptsOk = domRank.every((r,i) => r.pts === lbOrder[i]?.pts);
check(`ranking: ordem de ${domRank.length} usuários == desempate oficial (total→exatos→V+S)`, orderOk, orderOk?'':'ordem difere');
check(`ranking: pontos por linha batem com v_leaderboard`, ptsOk);
await shot('ranking');

// ===== C) historico =====
// historico.html navega por fase (group/ko) → dia → status; nunca lista os 104 de uma vez.
// Validamos (C1) a contagem do RECORTE ativo vs DB e (C2) o card da final.
console.log(`\n${C.b}historico.html${C.x}`);
await page.goto(`${BASE}/historico.html`);
await page.waitForSelector('.history-card', { timeout: 15000 });

const localDayKey = (d) => { const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; };
const inStageJs = (m, st) => st === 'group' ? m.stage === 'group' : m.stage !== 'group';

// (C1) recorte ativo (default: group / dia mais recente / finalizadas)
const actStage = await page.$eval('#stageTabs .admin-tab.active', el => el.dataset.stage).catch(() => 'group');
const actDay   = await page.$eval('#dayTabs .cal-day.active', el => el.dataset.date).catch(() => null);
const domCount = await page.$$eval('.history-card', els => els.length);
const expCount = matches.filter(m => m.finished && inStageJs(m, actStage) && localDayKey(m.match_date) === actDay).length;
check(`historico: cards do recorte ativo (${actStage}/${actDay}) == DB`, domCount === expCount && domCount > 0,
  `dom=${domCount} db=${expCount}`);

// (C2) card da final: navega fase KO + dia da final. Os cards não têm mais data-team,
// mas há exatamente 1 .history-card.final — lemos o placar (.hh-score) direto.
const finalM = matches.find(m => m.stage === 'final');
const finalDay = localDayKey(finalM.match_date);
await page.click('[data-stage="ko"]');
await page.waitForSelector(`#dayTabs .cal-day[data-date="${finalDay}"]`, { timeout: 8000 });
await page.click(`#dayTabs .cal-day[data-date="${finalDay}"]`);
await page.waitForSelector('.history-card.final', { timeout: 8000 });
const finalScore = await page.$eval('.history-card.final .hh-score',
  el => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
// placar editorial usa "–" sem espaços (ex.: "3–1"); aceita qualquer separador.
const scoreOk = !!finalScore &&
  new RegExp(`${finalM.actual_home}\\s*[–—-]\\s*${finalM.actual_away}`).test(finalScore);
check(`historico: card da final mostra placar correto`, scoreOk,
  `final ${finalM.team_home} ${finalM.actual_home}-${finalM.actual_away} ${finalM.team_away} | dom='${finalScore ?? '(card não achado)'}'`);
await shot('historico');

// ===== E) palpites-mata (render + nenhum slot cru vazando) =====
console.log(`\n${C.b}palpites-mata.html${C.x}`);
await page.goto(`${BASE}/palpites-mata.html`);
await page.waitForSelector('.bracket-match', { timeout: 15000 });
const bracketCount = await page.$$eval('.bracket-match', els => els.length).catch(() => 0);
check(`palpites-mata: chaveamento renderiza (${bracketCount} confrontos)`, bracketCount > 0, 'esperado >0');

// Com o torneio completo (todos os resultados lançados + palpites feitos), TODO
// time do bracket tem de estar resolvido — nenhum data-team pode ser código de
// slot cru (W73, 1A, 3A/B/C/D). Vazamento aqui = bug de propagação grupos→mata
// (a classe do M85, campeão sumindo). Antes este check era `true` fixo: o
// rawSlot era computado e descartado, então o bracket nunca era de fato afirmado.
const rawSlot = await page.$$eval('.bracket-match .team-name', els =>
  els.map(n => (n.getAttribute('data-team') || '').trim())
     .filter(t => /^([0-9]|W\d|L\d)/.test(t) || t.includes('/'))
);
check(`palpites-mata: nenhum slot cru nos times resolvidos`, rawSlot.length === 0,
  rawSlot.length ? `vazaram: ${[...new Set(rawSlot)].slice(0, 8).join(', ')}` : 'todos resolvidos');
await shot('palpites-mata');

await browser.close();

// ===== resumo =====
const failed = results.filter(r=>!r.pass);
console.log(`\n${C.b}${C.bold}Resumo: ${results.length-failed.length}/${results.length} OK${C.x}`);
if (failed.length) { console.log(`${C.r}Falhas: ${failed.map(f=>f.name).join('; ')}${C.x}`); process.exit(1); }
console.log(`${C.g}${C.bold}🎉 UI bate com o oráculo.${C.x}`);
process.exit(0);

#!/usr/bin/env node
/**
 * #5 Odds (match_odds): RLS (leitura pública autenticada, escrita só admin) + exibição no DOM.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url'; import { dirname, join } from 'path';
import { makeAdminClient, adminCreateUser, adminCreateProfile, adminDeleteUser } from './lib/admin-client.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const URL = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_PUBLISHABLE_KEY;
const C = { r:'\x1b[31m', g:'\x1b[32m', b:'\x1b[34m', x:'\x1b[0m', bold:'\x1b[1m' };
let ok = true;
const check = (n,p,d='') => { if(!p) ok=false; console.log(`   ${p?C.g+'✓':C.r+'✗'} ${n}${d?' — '+d:''}${C.x}`); };

const admin = makeAdminClient();
const MID = 1; // jogo de grupo
const odds = { match_id: MID, odd_home: 1.85, odd_draw: 3.40, odd_away: 4.20, bookmaker_id: 32, bookmaker_name: 'Betano' };

console.log(`${C.b}${C.bold}🎲 #5 Odds — RLS${C.x}`);
// seed odds (admin)
await admin.from('match_odds').upsert(odds, { onConflict: 'match_id' });

// user normal
const PASS='TestUser2026!'; const email=`test-odds-${Date.now()}@testuser.com`;
const u = await adminCreateUser(admin, email, PASS, 'Odds User');
await adminCreateProfile(admin, u, 'Odds User', { paid:false, avatar_url:'assets/avatars/daniel.png' });
const uc = createClient(URL, ANON, { auth:{persistSession:false}});
await uc.auth.signInWithPassword({ email, password: PASS });

// leitura
const rd = await uc.from('match_odds').select('*').eq('match_id', MID).maybeSingle();
check('user autenticado LÊ odds', !rd.error && rd.data && Number(rd.data.odd_home)===1.85, rd.error?.message || `home=${rd.data?.odd_home}`);
// escrita (deve falhar — não admin)
const wr = await uc.from('match_odds').update({ odd_home: 9.99 }).eq('match_id', MID);
const stillOrig = (await admin.from('match_odds').select('odd_home').eq('match_id',MID).single()).data;
check('user NÃO escreve odds (RLS admin-only)', Number(stillOrig.odd_home)===1.85, `odd_home=${stillOrig.odd_home}`);
// insert spoof
const ins = await uc.from('match_odds').insert({ match_id: 2, odd_home:1, odd_draw:1, odd_away:1, bookmaker_id:1, bookmaker_name:'x' });
check('user NÃO insere odds', !!ins.error, ins.error ? 'bloqueado' : 'INSERIU (falha!)');
await uc.auth.signOut();
await adminDeleteUser(admin, u.id);

console.log(`\n${C.b}${C.bold}🎲 #5 Odds — exibição no DOM${C.x}`);
// snapshot do match e abre pro futuro pra renderizar a linha de palpite
const { data: snap } = await admin.from('matches').select('match_date, finished, actual_home, actual_away, pen_winner, finished_at').eq('id', MID).single();
try {
  await admin.from('matches').update({ match_date: new Date(Date.now()+7*864e5).toISOString(), finished:false, actual_home:null, actual_away:null, pen_winner:null, finished_at:null }).eq('id', MID);
  const browser = await chromium.launch({ headless:true });
  const page = await browser.newPage();
  await page.goto(`${BASE}/login.html`);
  await page.fill('#email', process.env.ADMIN_EMAIL); await page.fill('#password', process.env.ADMIN_PASSWORD);
  await page.click('#submitBtn'); await page.waitForURL(/\/inicio(\.html)?$/, {timeout:15000});
  // #jogo-<id> abre a aba Palpites no grupo do jogo e rola até ele (deep-link).
  await page.goto(`${BASE}/palpites-grupos.html#jogo-${MID}`);
  await page.waitForSelector(`.match[data-match-id="${MID}"]`, {timeout:15000});
  // As odds não são mais um badge na linha — viraram a BARRA 1X2 (probabilidade
  // implícita de-margined das odds, ver oddsToProbs) dentro do Raio-X. Abre e lê.
  await page.click(`.match[data-match-id="${MID}"] .ctx-toggle`);
  await page.waitForTimeout(400);
  const fc = await page.evaluate((id)=>{
    const panel = document.querySelector(`#ctx-${id}`);
    if (!panel) return null;
    return {
      segs: [...panel.querySelectorAll('.rx-1x2-seg')].map(e=>e.textContent.trim()),
      fav: panel.querySelector('.rx-1x2-verdict')?.textContent?.trim() || '',
    };
  }, MID);
  await browser.close();
  // odds 1.85/3.40/4.20 → casa favorita; a barra mostra 3 segmentos em %.
  const segs = fc?.segs || [];
  check('odds renderizam no Raio-X (barra 1X2, casa favorita)',
    segs.length === 3 && segs.every(s=>s.includes('%')) && /Favorito/i.test(fc?.fav||''),
    `barra=${segs.join(' ')} · ${fc?.fav||'(sem barra)'}`);
} finally {
  await admin.from('matches').update(snap).eq('id', MID);
  try { await admin.rpc('recompute_prediction_points', { p_match_id: MID }); } catch {}
  // limpa odds de teste
  await admin.from('match_odds').delete().eq('match_id', MID);
  console.log('   ↩ match restaurado + odds de teste removidas');
}
console.log(`\n${ok ? C.g+C.bold+'🎉 OK' : C.r+C.bold+'⚠ revisar'}${C.x}`);
process.exit(ok?0:1);

// Auditoria mobile: screenshots full-page + diagnóstico de overflow/console em todas as telas.
// Originou as 16 correções do commit 1ec6c7c. Requer o ambiente local de pé
// (bootstrap/demo) com a conta eu@local.test. Saída em /tmp/ui-mob-audit/.
// ⚠ gotchas conhecidos (ver memória ui-audit-tooling-gotchas): fullPage corta
// em ~16.384px e headless não renderiza backdrop-filter — não são bugs do site.
// Uso: source .env.e2e.local && node scripts/dev/ui-mob-audit.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = '/tmp/ui-mob-audit';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(`${OUT}/shots`, { recursive: true });

const USER = { email: 'eu@local.test', password: 'Palpite2026!' };
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };

const log = [];
const consoleErrors = {};
const overflowReport = {};

function note(s) { log.push(s); console.log(s); }

async function diagnose(page, key) {
  const diag = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const sw = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
    const offenders = [];
    if (sw > vw + 1) {
      const all = document.querySelectorAll('body *');
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        // ignora drawers off-canvas (transform/left negativos de propósito)
        if (r.right <= 0) continue;
        if (r.right > vw + 2 && el.children.length < 12) {
          const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 90);
          offenders.push({ tag: el.tagName.toLowerCase(), cls, left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) });
          if (offenders.length >= 12) break;
        }
      }
    }
    return { vw, sw, overflowPx: Math.max(0, sw - vw), offenders };
  });
  if (diag.overflowPx > 1) overflowReport[key] = diag;
  return diag;
}

async function shot(page, name, { full = true, settle = 700 } = {}) {
  try {
    await page.waitForTimeout(settle);
    await page.screenshot({ path: `${OUT}/shots/${name}.png`, fullPage: full });
    const d = await diagnose(page, name);
    note(`OK   ${name}${d.overflowPx > 1 ? `  ⚠ overflow ${d.overflowPx}px` : ''}`);
  } catch (e) {
    note(`FAIL ${name} :: ${e.message.split('\n')[0]}`);
  }
}

function watchErrors(page, key) {
  page.on('console', m => {
    if (m.type() === 'error') {
      (consoleErrors[key] ||= new Set()).add(m.text().slice(0, 250));
    }
  });
  page.on('pageerror', e => (consoleErrors[key] ||= new Set()).add('PAGEERROR ' + e.message.slice(0, 250)));
}

async function go(page, route) {
  try { await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle', timeout: 25000 }); }
  catch { try { await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch {} }
  await page.waitForTimeout(1100);
}

async function loginInto(ctx, creds) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle' });
  await page.fill('#email', creds.email);
  await page.fill('#password', creds.password);
  await page.click('#submitBtn');
  try { await page.waitForURL(/inicio|admin|complete-profile/, { timeout: 15000 }); } catch {}
  await page.waitForTimeout(900);
  await page.close();
}

const LOGGED_OUT = ['index.html', 'login.html', 'signup.html', 'forgot-password.html', 'reset-password.html'];
const USER_PAGES = ['inicio.html', 'palpites-grupos.html', 'palpites-mata.html', 'campeao-artilheiro.html', 'ranking.html', 'historico.html', 'grupos.html', 'terceiros.html', 'regras.html', 'complete-profile.html'];

const browser = await chromium.launch();

// ============ 375px — varredura completa + interações ============
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  // logged-out
  {
    const page = await ctx.newPage();
    watchErrors(page, 'out');
    for (const r of LOGGED_OUT) {
      await go(page, r);
      await shot(page, `375_out_${r.replace('.html', '')}`);
    }
    await page.close();
  }

  // user
  await loginInto(ctx, USER);
  const page = await ctx.newPage();
  watchErrors(page, 'user');
  for (const r of USER_PAGES) {
    await go(page, r);
    await shot(page, `375_user_${r.replace('.html', '')}`);
  }

  // ---- estados interativos ----
  await go(page, 'inicio.html');
  try { await page.click('#menuToggle'); await page.waitForTimeout(500); await shot(page, '375_state_sidebar-open', { full: false }); } catch (e) { note('skip sidebar: ' + e.message.split('\n')[0]); }
  await go(page, 'inicio.html');
  try { await page.click('#topbarUser'); await page.waitForTimeout(500); await shot(page, '375_state_account-menu', { full: false }); } catch (e) { note('skip account: ' + e.message.split('\n')[0]); }

  // historico: cada aba de fase + um dia do calendário
  await go(page, 'historico.html');
  const stageTabs = page.locator('#stageTabs .admin-tab');
  const nTabs = await stageTabs.count();
  for (let i = 0; i < nTabs; i++) {
    try {
      await stageTabs.nth(i).click();
      await page.waitForTimeout(800);
      const label = ((await stageTabs.nth(i).innerText()) || `tab${i}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 18);
      await shot(page, `375_hist_stage-${i}-${label}`);
    } catch (e) { note(`skip hist tab ${i}: ` + e.message.split('\n')[0]); }
  }
  try {
    const days = page.locator('.cal-day:not([disabled])');
    if (await days.count() > 2) { await days.nth(1).click(); await page.waitForTimeout(800); await shot(page, '375_hist_cal-day2'); }
  } catch (e) { note('skip cal-day: ' + e.message.split('\n')[0]); }

  // palpites-grupos: alguns grupos
  await go(page, 'palpites-grupos.html');
  for (const g of ['B', 'F', 'L']) {
    try {
      const pill = page.locator(`[data-group="${g}"]`).first();
      if (await pill.count()) { await pill.click(); await page.waitForTimeout(800); await shot(page, `375_grupos_sel-${g}`); }
    } catch (e) { note(`skip grupo ${g}: ` + e.message.split('\n')[0]); }
  }

  // ranking: drill-down na 1ª linha
  await go(page, 'ranking.html');
  try {
    const row = page.locator('#rankBody tr[data-user-id], #rankTable tr[data-user-id]').first();
    if (await row.count()) { await row.click(); await page.waitForTimeout(900); await shot(page, '375_ranking_drilldown'); }
  } catch (e) { note('skip drilldown: ' + e.message.split('\n')[0]); }

  await page.close();
  await ctx.close();
}

// ============ admin @375 ============
if (ADMIN.email && ADMIN.password) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await loginInto(ctx, ADMIN);
  const page = await ctx.newPage();
  watchErrors(page, 'admin');
  await go(page, 'admin.html');
  await shot(page, '375_admin_admin');

  // Abas Resultados & Gols (pendentes/lançados, com placar digitado) e
  // Configurações — o buraco da 1ª auditoria foi só fotografar Usuários.
  try {
    await page.click('#tab-results');
    await page.waitForTimeout(1300);
    await shot(page, '375_admin_results-pendentes');
    const sc = page.locator('input[id^="rh_"]').first();
    if (await sc.count()) {
      const mid = (await sc.getAttribute('id')).slice(3);
      await page.fill(`#rh_${mid}`, '2');
      await page.fill(`#ra_${mid}`, '1');
      await page.waitForTimeout(900);
      await shot(page, '375_admin_results-placar-aberto');
    }
    const launched = page.locator('[data-action="results-subtab"][data-sub="launched"]');
    if (await launched.count()) {
      await launched.click();
      await page.waitForTimeout(1300);
      await shot(page, '375_admin_results-lancados');
    }
    await page.click('#tab-settings');
    await page.waitForTimeout(1000);
    await shot(page, '375_admin_settings');
  } catch (e) { note('skip admin tabs: ' + e.message.split('\n')[0]); }

  await page.close();
  await ctx.close();
} else {
  note('SKIP admin (sem credenciais)');
}

// ============ 320px — stress nas telas-chave ============
{
  const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await loginInto(ctx, USER);
  const page = await ctx.newPage();
  watchErrors(page, 'user320');
  for (const r of ['inicio.html', 'palpites-grupos.html', 'palpites-mata.html', 'ranking.html', 'historico.html', 'grupos.html']) {
    await go(page, r);
    await shot(page, `320_user_${r.replace('.html', '')}`);
  }
  await page.close();
  await ctx.close();
}

await browser.close();

const errsOut = Object.fromEntries(Object.entries(consoleErrors).map(([k, v]) => [k, [...v]]));
fs.writeFileSync(`${OUT}/console-errors.json`, JSON.stringify(errsOut, null, 2));
fs.writeFileSync(`${OUT}/overflow-report.json`, JSON.stringify(overflowReport, null, 2));
fs.writeFileSync(`${OUT}/capture-log.txt`, log.join('\n'));
console.log('\n=== OVERFLOW ===\n' + JSON.stringify(overflowReport, null, 2).slice(0, 4000));
console.log('\n=== CONSOLE ERRORS ===\n' + JSON.stringify(errsOut, null, 2).slice(0, 3000));

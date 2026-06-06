import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = '/tmp/ui-audit/shots';
fs.mkdirSync(OUT, { recursive: true });

const USER = { email: 'test-perfect-2026@testuser.com', password: 'TestUser2026!' };
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };

const VPS = {
  desk: { width: 1440, height: 900, dpr: 1 },
  mob:  { width: 375,  height: 812, dpr: 2 },
};

const log = [];
const errors = {};

async function shot(page, name, { full = true } = {}) {
  try {
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
    log.push(`OK   ${name}`);
  } catch (e) {
    log.push(`FAIL ${name} :: ${e.message.split('\n')[0]}`);
  }
}

async function gotoQuiet(page, route, key) {
  const errs = [];
  const onErr = m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); };
  page.on('console', onErr);
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0, 200)));
  try {
    await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle', timeout: 20000 });
  } catch (e) {
    try { await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
  }
  await page.waitForTimeout(900);
  page.off('console', onErr);
  if (errs.length) errors[key] = [...new Set(errs)];
}

async function newCtx(browser, vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    reducedMotion: 'no-preference',
  });
  return ctx;
}

async function loginInto(ctx, creds) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle' });
  await page.fill('#email', creds.email);
  await page.fill('#password', creds.password);
  await page.click('#submitBtn');
  try { await page.waitForURL(/\/inicio(\.html)?$/, { timeout: 12000 }); }
  catch { /* maybe complete-profile redirect or admin */ }
  await page.waitForTimeout(800);
  await page.close();
  return ctx; // session stored in context cookies/localStorage
}

const LOGGED_OUT = ['index.html', 'login.html', 'signup.html', 'forgot-password.html', 'reset-password.html', 'regras.html'];
const USER_PAGES = ['inicio.html', 'palpites-grupos.html', 'palpites-mata.html', 'campeao-artilheiro.html', 'ranking.html', 'historico.html', 'regras.html', 'grupos.html', 'terceiros.html', 'complete-profile.html'];
const ADMIN_PAGES = ['admin.html'];

const browser = await chromium.launch();

for (const [vpKey, vp] of Object.entries(VPS)) {
  // ---- logged-out ----
  {
    const ctx = await newCtx(browser, vp);
    const page = await ctx.newPage();
    for (const route of LOGGED_OUT) {
      const base = route.replace('.html', '');
      await gotoQuiet(page, route, `out:${base}:${vpKey}`);
      await shot(page, `out_${base}__${vpKey}`);
    }
    // interaction states on login (desktop only)
    if (vpKey === 'desk') {
      await gotoQuiet(page, 'login.html', `out:login-focus`);
      await page.keyboard.press('Tab'); // focus first input -> focus-visible
      await page.waitForTimeout(200);
      await shot(page, `state_login-focus__desk`, { full: false });
      // submit empty -> validation/error state
      await page.evaluate(() => document.activeElement.blur());
      try { await page.click('#submitBtn'); await page.waitForTimeout(600); } catch {}
      await shot(page, `state_login-submit-empty__desk`, { full: false });
    }
    await ctx.close();
  }

  // ---- logged-in user ----
  {
    let ctx = await newCtx(browser, vp);
    ctx = await loginInto(ctx, USER);
    const page = await ctx.newPage();
    for (const route of USER_PAGES) {
      const base = route.replace('.html', '');
      await gotoQuiet(page, route, `user:${base}:${vpKey}`);
      await shot(page, `user_${base}__${vpKey}`);
    }
    // interaction states
    if (vpKey === 'desk') {
      await gotoQuiet(page, 'inicio.html', `user:inicio-hover`);
      const navItem = page.locator('.sidebar a, .nav a, [class*="nav"] a').first();
      try { await navItem.hover(); await page.waitForTimeout(300); await shot(page, `state_sidebar-hover__desk`, { full: false }); } catch {}
    }
    if (vpKey === 'mob') {
      await gotoQuiet(page, 'inicio.html', `user:mobilenav`);
      // try open mobile nav (hamburger)
      const burgers = ['[class*="burger"]', '[class*="hamburger"]', '[aria-label*="menu" i]', '.nav-toggle', 'button[class*="menu"]'];
      for (const sel of burgers) {
        const el = page.locator(sel).first();
        if (await el.count()) { try { await el.click({ timeout: 1500 }); await page.waitForTimeout(400); break; } catch {} }
      }
      await shot(page, `state_mobile-nav-open__mob`, { full: false });
    }
    await ctx.close();
  }

  // ---- admin ----
  if (ADMIN.email && ADMIN.password) {
    let ctx = await newCtx(browser, vp);
    ctx = await loginInto(ctx, ADMIN);
    const page = await ctx.newPage();
    for (const route of ADMIN_PAGES) {
      const base = route.replace('.html', '');
      await gotoQuiet(page, route, `admin:${base}:${vpKey}`);
      await shot(page, `admin_${base}__${vpKey}`);
    }
    await ctx.close();
  }
}

await browser.close();
fs.writeFileSync('/tmp/ui-audit/capture-log.txt', log.join('\n'));
fs.writeFileSync('/tmp/ui-audit/console-errors.json', JSON.stringify(errors, null, 2));
console.log(log.join('\n'));
console.log('\n=== CONSOLE/PAGE ERRORS ===');
console.log(JSON.stringify(errors, null, 2));

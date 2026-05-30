#!/usr/bin/env node
/**
 * #13 Multi-browser + mobile: smoke de render e guarda de rota em
 * Chromium, Firefox e WebKit, mais um viewport mobile (login + redirect protegido).
 */
import { chromium, firefox, webkit, devices } from 'playwright';
import { config } from 'dotenv';
config();
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const C = { r:'\x1b[31m', g:'\x1b[32m', b:'\x1b[34m', x:'\x1b[0m', bold:'\x1b[1m' };
let ok = true;
const check = (n,p,d='') => { if(!p) ok=false; console.log(`   ${p?C.g+'✓':C.r+'✗'} ${n}${d?' — '+d:''}${C.x}`); };

async function smoke(name, browser, contextOpts={}) {
  const ctx = await browser.newContext(contextOpts);
  const page = await ctx.newPage();
  // login.html renderiza inputs
  await page.goto(`${BASE}/login.html`);
  const hasEmail = await page.locator('input[type="email"]').isVisible().catch(()=>false);
  const hasPass = await page.locator('input[type="password"]').isVisible().catch(()=>false);
  check(`[${name}] login.html renderiza email+senha`, hasEmail && hasPass);
  // rota protegida sem auth → redirect login
  await page.goto(`${BASE}/inicio.html`);
  await page.waitForTimeout(1500);
  check(`[${name}] rota protegida redireciona p/ login`, /\/login/.test(page.url()), page.url());
  await ctx.close();
}

console.log(`${C.b}${C.bold}🌐 #13 Multi-browser + mobile${C.x}`);
const cr = await chromium.launch(); await smoke('chromium', cr); await cr.close();
const ff = await firefox.launch();  await smoke('firefox', ff);  await ff.close();
const wk = await webkit.launch();   await smoke('webkit', wk);   await wk.close();
// mobile viewport (iPhone) no chromium
const crm = await chromium.launch();
await smoke('mobile/iPhone', crm, devices['iPhone 13']);
await crm.close();

console.log(`\n${ok ? C.g+C.bold+'🎉 OK' : C.r+C.bold+'⚠ revisar'}${C.x}`);
process.exit(ok?0:1);

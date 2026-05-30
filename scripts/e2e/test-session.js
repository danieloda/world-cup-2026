#!/usr/bin/env node
/**
 * #14 Sessão: (a) login persiste e rota protegida carrega; (b) sem token → redirect;
 * (c) token corrompido/expirado → rejeitado (redirect login).
 */
import { chromium } from 'playwright';
import { config } from 'dotenv';
import { fileURLToPath } from 'url'; import { dirname, join } from 'path';
import { makeAdminClient, adminCreateUser, adminCreateProfile, adminDeleteUser } from './lib/admin-client.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const C = { r:'\x1b[31m', g:'\x1b[32m', b:'\x1b[34m', x:'\x1b[0m', bold:'\x1b[1m' };
let ok = true;
const check = (n,p,d='') => { if(!p) ok=false; console.log(`   ${p?C.g+'✓':C.r+'✗'} ${n}${d?' — '+d:''}${C.x}`); };

const admin = makeAdminClient();
const PASS='TestUser2026!'; const email=`test-sess-${Date.now()}@testuser.com`;
const u = await adminCreateUser(admin, email, PASS, 'Sess User');
await adminCreateProfile(admin, u, 'Sess User', { paid:true, avatar_url:'assets/avatars/daniel.png' });

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

console.log(`${C.b}${C.bold}🔑 #14 Sessão${C.x}`);
// (a) login → inicio
await page.goto(`${BASE}/login.html`);
await page.fill('#email', email); await page.fill('#password', PASS);
await page.click('#submitBtn');
await page.waitForURL(/\/inicio(\.html)?$/, {timeout:15000});
check('(a) login persiste, rota protegida carrega', /\/inicio/.test(page.url()), page.url());

// inspeciona chave de sessão no localStorage
const keys = await page.evaluate(() => Object.keys(localStorage).filter(k=>k.startsWith('sb-')));
check('sessão armazenada em localStorage (sb-*)', keys.length>0, keys.join(','));

// (c) corrompe o token → reload → deve rejeitar e redirecionar
await page.evaluate(() => {
  for (const k of Object.keys(localStorage).filter(k=>k.startsWith('sb-'))) {
    localStorage.setItem(k, JSON.stringify({ access_token:'corrupted.invalid.jwt', refresh_token:'x', expires_at: 1 }));
  }
});
await page.goto(`${BASE}/inicio.html`);
await page.waitForTimeout(2000);
check('(c) token corrompido/expirado → redireciona p/ login', /\/login/.test(page.url()), page.url());

// (b) sem token → redirect
await page.evaluate(() => localStorage.clear());
await page.goto(`${BASE}/inicio.html`);
await page.waitForTimeout(1500);
check('(b) sem token (logout) → redireciona p/ login', /\/login/.test(page.url()), page.url());

await browser.close();
await adminDeleteUser(admin, u.id);
console.log(`\n${ok ? C.g+C.bold+'🎉 OK' : C.r+C.bold+'⚠ revisar'}${C.x}`);
process.exit(ok?0:1);

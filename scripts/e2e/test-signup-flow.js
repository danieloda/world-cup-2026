#!/usr/bin/env node
/**
 * Testa o fluxo COMPLETO de cadastro via UI:
 *   1. signup.html → preenche nome + email + senha → submit
 *   2. Verifica mensagem "confirme seu email"
 *   3. (Simula clique no link) admin confirma email via API
 *   4. login.html → entra
 *   5. Redireciona pra complete-profile.html (gate de avatar)
 *   6. Upload de avatar → Storage
 *   7. Redireciona pra inicio.html
 *   8. Valida no DB: profile com full_name + avatar_url (Storage URL)
 *
 * Uso: node scripts/e2e/test-signup-flow.js [--headed]
 *
 * Cleanup: apaga o test user no final.
 */

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const HEADED = process.argv.includes('--headed');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const EMAIL = `test-signup-${Date.now()}@testuser.com`;
const PASSWORD = 'TestSignup2026!';
const NAME = 'Teste Cadastro';

// 1x1 PNG vermelho (avatar de teste) — escrito num tmp file
const RED_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const AVATAR_PATH = join(__dirname, '_test-avatar.png');

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c] || ''}${m}${C.reset}`);

let createdUserId = null;

async function cleanup() {
  if (createdUserId) {
    try {
      await admin.from('profiles').delete().eq('id', createdUserId);
      await admin.storage.from('avatars').remove([`${createdUserId}/avatar.png`]);
      await admin.auth.admin.deleteUser(createdUserId);
      log('dim', `   🧹 Cleanup: user ${createdUserId.slice(0, 8)}... removido`);
    } catch (e) {
      log('yellow', `   ⚠ Cleanup parcial: ${e.message}`);
    }
  }
}

async function main() {
  log('blue', `${C.bold}🧪 Teste fluxo de cadastro completo${C.reset}`);
  log('blue', `   Email de teste: ${EMAIL}`);

  // Escreve avatar de teste
  writeFileSync(AVATAR_PATH, Buffer.from(RED_PNG_B64, 'base64'));

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(`console: ${m.text()}`); });

  try {
    // ===== 1. SIGNUP =====
    log('blue', '\n[1] Signup via UI...');
    await page.goto(`${BASE_URL}/signup.html`);
    await page.waitForSelector('#signupForm', { timeout: 10000 });
    await page.fill('#fullName', NAME);
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('#submitBtn');

    // ===== 2. Mensagem de confirmação =====
    log('blue', '[2] Aguardando mensagem de confirmação...');
    await page.waitForSelector('#successBox:not([hidden])', { timeout: 10000 });
    const successMsg = await page.$eval('#successBox', (el) => el.textContent);
    if (!successMsg.toLowerCase().includes('confirma')) {
      throw new Error(`Mensagem inesperada: ${successMsg}`);
    }
    log('green', `   ✓ "${successMsg.slice(0, 60)}..."`);

    // Pega o user criado
    const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
    const u = users.users.find((x) => x.email === EMAIL);
    if (!u) throw new Error('User não foi criado no auth');
    createdUserId = u.id;
    log('green', `   ✓ User criado: ${u.id.slice(0, 8)}... (confirmed: ${u.email_confirmed_at ? 'sim' : 'NÃO'})`);

    // Valida que full_name foi pro metadata
    if (u.user_metadata?.full_name !== NAME) {
      log('yellow', `   ⚠ full_name no metadata: "${u.user_metadata?.full_name}" (esperado "${NAME}")`);
    } else {
      log('green', `   ✓ full_name no metadata: "${NAME}"`);
    }

    // ===== 3. Simula clique no link de confirmação =====
    log('blue', '[3] Confirmando email (simula clique no link)...');
    const { error: confErr } = await admin.auth.admin.updateUserById(u.id, { email_confirm: true });
    if (confErr) throw new Error('Confirm email: ' + confErr.message);
    log('green', '   ✓ Email confirmado');

    // ===== 4. LOGIN =====
    log('blue', '[4] Login via UI...');
    await page.goto(`${BASE_URL}/login.html`);
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('#submitBtn');

    // ===== 5. Redirect pra complete-profile =====
    log('blue', '[5] Aguardando redirect pra complete-profile (gate de avatar)...');
    await page.waitForURL(/complete-profile/, { timeout: 12000 });
    await page.waitForSelector('#profileForm', { timeout: 10000 });
    log('green', '   ✓ Redirecionou pra complete-profile.html');

    // ===== 6. Upload avatar =====
    log('blue', '[6] Upload do avatar...');
    await page.setInputFiles('#avatarFile', AVATAR_PATH);
    // Espera o change nativo + o FileReader (lê o avatar como data URL) habilitarem
    // o submit. Em headless o change pode não disparar sozinho num input hidden —
    // só então forçamos via dispatch (mesmo padrão do test-avatar-upload, que passa).
    await page.waitForTimeout(800);
    if (await page.evaluate(() => document.getElementById('submitBtn')?.disabled)) {
      await page.dispatchEvent('#avatarFile', 'change');
    }
    await page.waitForSelector('#submitBtn:not([disabled])', { timeout: 8000 });
    await page.click('#submitBtn');

    // ===== 7. Redirect pra inicio =====
    log('blue', '[7] Aguardando redirect pra inicio...');
    await page.waitForURL(/inicio/, { timeout: 15000 });
    log('green', '   ✓ Entrou no app (inicio.html)');

    // ===== 8. Validação no DB =====
    log('blue', '[8] Validando profile no DB...');
    const { data: prof } = await admin.from('profiles').select('*').eq('id', u.id).single();
    const checks = [
      ['Profile existe', !!prof],
      ['full_name correto', prof?.full_name === NAME],
      ['avatar_url setado', !!prof?.avatar_url],
      ['avatar_url aponta pro Storage', prof?.avatar_url?.includes('/storage/v1/object/public/avatars/')],
      ['paid=false (default)', prof?.paid === false],
      ['is_admin=false (default)', prof?.is_admin === false],
    ];
    let allOk = true;
    for (const [name, ok] of checks) {
      log(ok ? 'green' : 'red', `   ${ok ? '✓' : '✗'} ${name}`);
      if (!ok) allOk = false;
    }
    log('dim', `   avatar_url: ${prof?.avatar_url}`);

    // Confirma que o arquivo está no Storage
    const { data: files } = await admin.storage.from('avatars').list(u.id);
    log(files?.length > 0 ? 'green' : 'red', `   ${files?.length > 0 ? '✓' : '✗'} Arquivo no Storage: ${files?.map(f => f.name).join(', ') || 'nenhum'}`);
    if (!files?.length) allOk = false;

    console.log('');
    if (allOk && errors.length === 0) {
      log('green', `${C.bold}🎉 CADASTRO FUNCIONANDO END-TO-END!${C.reset}`);
    } else {
      if (errors.length) {
        log('red', `\n⚠ ${errors.length} erro(s) de UI:`);
        errors.slice(0, 5).forEach((e) => log('red', `   ${e}`));
      }
      log('red', `${C.bold}⚠️ Falhou em algum check.${C.reset}`);
    }
  } catch (e) {
    log('red', `\n❌ ${e.message}`);
    mkdirSync(join(__dirname, 'screenshots'), { recursive: true });
    await page.screenshot({ path: join(__dirname, 'screenshots', 'signup-flow-error.png'), fullPage: true });
    log('yellow', '   Screenshot: scripts/e2e/screenshots/signup-flow-error.png');
    if (errors.length) errors.slice(0, 5).forEach((er) => log('red', `   ${er}`));
  } finally {
    await browser.close();
    await cleanup();
  }
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

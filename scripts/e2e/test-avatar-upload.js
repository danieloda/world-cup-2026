#!/usr/bin/env node
// Testa SÓ o complete-profile (upload de avatar), usando user criado via Admin API
// (bypassa rate limit do signup). Foca em descobrir por que o botão fica disabled.

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const HEADED = process.argv.includes('--headed');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const EMAIL = `test-avatar-${Date.now()}@testuser.com`;
const PASSWORD = 'TestAvatar2026!';
const AVATAR_PATH = join(__dirname, '_test-avatar.png');
const RED_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c] || ''}${m}${C.reset}`);

let userId = null;
async function cleanup() {
  if (userId) {
    try {
      await admin.from('profiles').delete().eq('id', userId);
      await admin.storage.from('avatars').remove([`${userId}/avatar.png`]);
      await admin.auth.admin.deleteUser(userId);
      log('dim', `   🧹 user ${userId.slice(0, 8)}... removido`);
    } catch {}
  }
}

async function main() {
  writeFileSync(AVATAR_PATH, Buffer.from(RED_PNG_B64, 'base64'));

  log('blue', `${C.bold}🧪 Teste complete-profile (avatar upload)${C.reset}`);

  // Cria user confirmado + profile sem avatar
  log('blue', '\n[setup] Criando user via Admin API...');
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { full_name: 'Teste Avatar' },
  });
  if (cErr) throw new Error('createUser: ' + cErr.message);
  userId = created.user.id;
  await admin.from('profiles').insert({ id: userId, email: EMAIL, full_name: 'Teste Avatar', is_admin: false, paid: false });
  log('green', `   ✓ user ${userId.slice(0, 8)}... criado (avatar_url=null)`);

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  try {
    // Login
    log('blue', '[1] Login...');
    await page.goto(`${BASE_URL}/login.html`);
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('#submitBtn');
    await page.waitForURL(/complete-profile/, { timeout: 12000 });
    log('green', '   ✓ redirect pra complete-profile');

    // Upload
    log('blue', '[2] Selecionando arquivo...');
    await page.setInputFiles('#avatarFile', AVATAR_PATH);
    await page.waitForTimeout(800);  // deixa o change + FileReader rodar

    const state = await page.evaluate(() => ({
      filesLen: document.getElementById('avatarFile').files.length,
      fileType: document.getElementById('avatarFile').files[0]?.type,
      btnDisabled: document.getElementById('submitBtn').disabled,
      errorHidden: document.getElementById('errorBox').hidden,
      errorText: document.getElementById('errorBox').textContent,
      previewVisible: !document.getElementById('previewImg').hidden,
    }));
    log('dim', `   estado: ${JSON.stringify(state)}`);

    if (state.btnDisabled) {
      log('yellow', '   ⚠ Botão ainda disabled após selecionar arquivo');
      // Tenta dispatch manual
      await page.dispatchEvent('#avatarFile', 'change');
      await page.waitForTimeout(500);
      const after = await page.$eval('#submitBtn', (el) => el.disabled);
      log('dim', `   após dispatch change manual: btnDisabled=${after}`);
    }

    await page.waitForSelector('#submitBtn:not([disabled])', { timeout: 5000 });
    log('green', '   ✓ Botão habilitado');

    log('blue', '[3] Salvando...');
    await page.click('#submitBtn');
    await page.waitForURL(/inicio/, { timeout: 15000 });
    log('green', '   ✓ Entrou no app');

    // Valida DB
    const { data: prof } = await admin.from('profiles').select('avatar_url').eq('id', userId).single();
    log(prof?.avatar_url?.includes('/storage/v1/object/public/avatars/') ? 'green' : 'red',
      `   avatar_url: ${prof?.avatar_url}`);

    console.log('');
    log('green', `${C.bold}✅ Avatar upload funcionando!${C.reset}`);
  } catch (e) {
    log('red', `\n❌ ${e.message}`);
    if (consoleErrors.length) consoleErrors.slice(0, 5).forEach((er) => log('red', `   ${er}`));
  } finally {
    await browser.close();
    await cleanup();
  }
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

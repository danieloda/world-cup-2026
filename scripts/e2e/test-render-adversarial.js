#!/usr/bin/env node
/**
 * RENDER ADVERSARIAL — ponto 4 do hardening pré-lançamento.
 *
 * As funções de render das páginas não têm teste unitário (são privadas, dependem
 * de DOM + supabase). O bug "básico" mais comum que o usuário acha é dado ausente
 * vazando como `undefined` / `NaN` / `[object Object]` / `Invalid Date` na tela,
 * ou um erro de console que quebra meia página. O e2e atual semeia dado "quase
 * feliz"; aqui exercitamos os ESTADOS RUINS:
 *
 *   FASE 1 (vazio):   usuário recém-criado, ZERO palpites/picks → toda página tem
 *                     que renderizar (ranking sem pontos, histórico sem nada,
 *                     palpites em branco, campeão/artilheiro sem escolha).
 *   FASE 2 (parcial): só 2 palpites de grupo → telas que agregam não podem cuspir
 *                     NaN/undefined nem dividir por zero.
 *
 * Para CADA página assertamos: (a) nenhum token proibido no texto visível;
 * (b) nenhum pageerror / console.error novo durante a navegação.
 *
 * Blast radius mínimo: só cria/recria a Alice (cascade limpa os palpites). NÃO
 * muta matches/settings. admin-client recusa rodar fora de local (guard-rail).
 *
 * Uso: source .env && node scripts/e2e/test-render-adversarial.js [--headed]
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';
import {
  makeAdminClient, adminCreateUser, adminCreateProfile, adminDeleteUser,
} from './lib/admin-client.js';
import { login } from './lib/playwright-helpers.js';
import { ErrorTracker } from './lib/error-tracker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const HEADED = process.argv.includes('--headed');
const PASSWORD = 'TestRender2026!';
const TS = Date.now();
const EMAIL = `test-render-${TS}@testuser.com`;

const BAD_TOKENS = ['undefined', 'NaN', '[object Object]', 'Invalid Date'];

// Páginas de usuário comum (admin fora — Alice não é admin).
const PAGES = [
  { path: 'inicio.html', wait: '.kpis, [class*="sidebar"]' },
  { path: 'palpites-grupos.html', wait: '.chip[data-group], [data-match], .match' },
  { path: 'palpites-mata.html', wait: '.bracket-match, [data-match], .bm-card' },
  { path: 'grupos.html', wait: '[class*="group"], table, .standings' },
  { path: 'terceiros.html', wait: 'table, [class*="third"], [class*="sidebar"]' },
  { path: 'ranking.html', wait: '[class*="rank"], table, [class*="sidebar"]' },
  { path: 'historico.html', wait: '[class*="hist"], [class*="sidebar"]' },
  { path: 'campeao-artilheiro.html', wait: '.cs-card, [class*="sidebar"]' },
  { path: 'regras.html', wait: '[class*="sidebar"], main' },
];

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c] || ''}${m}${C.reset}`);
const checks = [];
function check(name, pass, detail) {
  checks.push([name, pass]);
  log(pass ? 'green' : 'red', `   ${pass ? '✓' : '✗'} ${name}`);
  if (!pass && detail) log('dim', `      ${detail}`);
}

const admin = makeAdminClient();
let alice = null;

async function assertCleanRender(page, tracker, label) {
  const before = tracker.errors.length;
  try {
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(900);  // deixa renders assíncronos assentarem
  } catch {}

  // (a) tokens proibidos no texto VISÍVEL
  const text = await page.evaluate(() => document.body?.innerText || '');
  for (const tok of BAD_TOKENS) {
    const hit = text.includes(tok);
    if (hit) {
      const idx = text.indexOf(tok);
      check(`${label}: sem "${tok}"`, false, `…${text.slice(Math.max(0, idx - 40), idx + 40).replace(/\n/g, ' ')}…`);
    } else {
      check(`${label}: sem "${tok}"`, true);
    }
  }

  // (b) nenhum pageerror / console.error novo nesta navegação
  const fresh = tracker.errors.slice(before)
    .filter((e) => e.category === 'ui_pageerror' || e.category === 'ui_console');
  check(`${label}: sem erro de console/pageerror`, fresh.length === 0,
        fresh.map((e) => e.message).join(' | '));
}

async function visitAll(page, tracker, phase) {
  for (const p of PAGES) {
    log('blue', `\n[${phase}] ${p.path}`);
    try {
      await page.goto(`${BASE}/${p.path}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector(p.wait, { timeout: 12000 }).catch(() => {});
      await assertCleanRender(page, tracker, `${phase}/${p.path}`);
    } catch (e) {
      check(`${phase}/${p.path}: navegou sem exceção`, false, e.message);
    }
  }
}

async function main() {
  log('bold', '🧪 Render adversarial (estados vazio + parcial)');

  log('blue', '\n[setup] Criando usuário descartável (paid, sem dados)...');
  const user = await adminCreateUser(admin, EMAIL, PASSWORD, 'Render Tester');
  await adminCreateProfile(admin, user, 'Render Tester', { paid: true });
  alice = { id: user.id };
  log('green', `   ✓ ${EMAIL} (${alice.id.slice(0, 8)}…)`);

  const browser = await chromium.launch({ headless: !HEADED });
  const page = await browser.newPage();
  const tracker = new ErrorTracker(join(__dirname, 'render-adversarial-errors.json'));
  tracker.attachPlaywright(page);

  try {
    await login(page, EMAIL, PASSWORD, tracker);

    // FASE 1 — usuário totalmente vazio
    await visitAll(page, tracker, 'vazio');

    // FASE 2 — parcial: 2 palpites de grupo (admin bypassa RLS p/ semear rápido)
    log('blue', '\n[setup] Semeando 2 palpites de grupo (estado parcial)...');
    const { error } = await admin.from('predictions').insert([
      { user_id: alice.id, match_id: 1, pred_home: 2, pred_away: 1 },
      { user_id: alice.id, match_id: 2, pred_home: 0, pred_away: 0 },
    ]);
    if (error) log('red', `   ⚠ insert parcial: ${error.message}`);
    else log('green', '   ✓ 2 palpites inseridos');

    await visitAll(page, tracker, 'parcial');

    tracker.flush();
  } finally {
    await browser.close();
  }

  console.log('');
  const failed = checks.filter(([, p]) => !p);
  if (failed.length === 0) {
    log('green', `${C.bold}🎉 RENDER OK (${checks.length}/${checks.length}) — nenhuma página vaza undefined/NaN nem quebra${C.reset}`);
  } else {
    log('red', `${C.bold}⚠️ ${failed.length}/${checks.length} falharam — bug de render visível ao usuário${C.reset}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { log('red', `\n❌ ${e.message}`); process.exitCode = 1; })
  .finally(async () => {
    if (alice) {
      try { await adminDeleteUser(admin, alice.id); log('dim', '   (Alice removida)'); } catch {}
    }
  });

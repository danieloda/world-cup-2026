#!/usr/bin/env node
/**
 * XSS HOSTIL — stored XSS via `full_name` (o único campo de texto LIVRE que o
 * usuário controla e que é renderizado para TODOS os outros: ranking, histórico
 * "palpites da galera", legenda/tooltip dos gráficos, dropdown de rival).
 *
 * O código escapa em todo ponto (escapeHtml/escapeAttr) — este teste PROVA isso
 * em runtime e vira guard permanente: basta um template literal novo esquecer o
 * escape pra reabrir o buraco, e aí um usuário com nome malicioso executa script
 * no navegador de todo mundo.
 *
 * Como funciona:
 *   1. cria um usuário HOSTIL cujo full_name é um payload (quebra de tag +
 *      atributo + <img onerror> + <svg onload>), pago, e com um palpite num jogo
 *      já encerrado (pra aparecer na galera do histórico);
 *   2. cria um VIEWER comum e navega como ELE (a vítima) — é assim que stored
 *      XSS dispara: a vítima vê o dado do atacante;
 *   3. em cada página detecta: (a) o payload EXECUTOU? (onerror/onload/alert
 *      capturados via init script) — CRÍTICO; (b) virou ELEMENTO no DOM mesmo
 *      sem disparar? — também vuln; (c) o nome de fato renderizou (escapado)? —
 *      garante que o teste não passou à toa por o nome nunca aparecer.
 *
 * Blast radius mínimo: cria/recria 2 usuários descartáveis (cascade limpa).
 * admin-client recusa rodar fora de local (guard-rail). NÃO muta matches/settings.
 *
 * Uso: source .env.e2e.local && node scripts/e2e/test-xss-hostile.js [--headed]
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
const PASSWORD = 'XssProbe2026!';
const TS = Date.now();
const HOSTILE_EMAIL = `test-xss-hostile-${TS}@testuser.com`;
const VIEWER_EMAIL = `test-xss-viewer-${TS}@testuser.com`;

// Marcador distintivo p/ provar que o nome RENDERIZOU + payload multi-contexto:
// quebra de atributo ("> e '>) e duas tags com handlers que disparam sozinhos
// (img falha o src na hora; svg dispara onload ao entrar no DOM).
const MARK = 'XSSPROBE';
const PAYLOAD =
  `${MARK}">'>` +
  `<img src=x data-xssprobe="1" onerror="window.__xss&&window.__xss('img-onerror')">` +
  `<svg data-xssprobe="1" onload="window.__xss&&window.__xss('svg-onload')"></svg>`;

// Páginas onde o nome de OUTRO usuário aparece (ranking/galera/gráficos/rival).
const PAGES = [
  { path: 'ranking.html', wait: '[class*="rank"], table, [class*="sidebar"]', expectName: true },
  { path: 'historico.html', wait: '[class*="hist"], [class*="sidebar"]', expectName: false },
  { path: 'inicio.html', wait: '.kpis, [class*="sidebar"]', expectName: false },
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
let hostile = null, viewer = null;
let renderedSomewhere = false;

async function probePage(page, tracker, label, expectName) {
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1000);  // deixa gráficos/galera (render assíncrono) assentarem

  // (a) EXECUÇÃO — onerror/onload/alert capturados pelo init script
  const hits = await page.evaluate(() => window.__xssHits || []);
  check(`${label}: payload NÃO executou`, hits.length === 0, hits.length ? `disparou: ${hits.join(', ')}` : '');

  // (b) INJEÇÃO — o payload virou elemento no DOM (mesmo que não tenha disparado)?
  const injected = await page.evaluate(() => document.querySelectorAll('[data-xssprobe]').length);
  check(`${label}: payload NÃO virou HTML no DOM`, injected === 0, injected ? `${injected} elemento(s) injetado(s)` : '');

  // (c) o nome de fato apareceu (escapado)? — garante teste não-vacuoso
  const rendered = await page.evaluate((m) => (document.body?.innerText || '').includes(m), MARK);
  if (rendered) renderedSomewhere = true;
  if (expectName) check(`${label}: nome do hostil renderizou (escapado, visível)`, rendered, 'nome não apareceu — render path não exercido?');

  // erro de console/pageerror novo
  const fresh = tracker.errors.filter((e) => e.category === 'ui_pageerror' || e.category === 'ui_console');
  if (fresh.length) tracker.errors.length = 0;  // não acumular entre páginas
}

async function main() {
  log('bold', '🧪 XSS hostil (stored XSS via full_name)');

  log('blue', '\n[setup] Criando usuário HOSTIL (full_name = payload) + VIEWER...');
  const h = await adminCreateUser(admin, HOSTILE_EMAIL, PASSWORD, PAYLOAD);
  await adminCreateProfile(admin, h, PAYLOAD, { paid: true, avatar_url: 'https://example.com/a.png' });
  hostile = { id: h.id };
  const v = await adminCreateUser(admin, VIEWER_EMAIL, PASSWORD, 'Viewer Honesto');
  await adminCreateProfile(admin, v, 'Viewer Honesto', { paid: true, avatar_url: 'https://example.com/b.png' });
  viewer = { id: v.id };
  log('green', `   ✓ hostil ${hostile.id.slice(0, 8)}… · viewer ${viewer.id.slice(0, 8)}…`);

  // Palpite do hostil num jogo já encerrado → aparece na "galera" do histórico.
  const { data: fin } = await admin.from('matches').select('id').eq('finished', true).order('id').limit(1);
  const finId = fin?.[0]?.id;
  if (finId) {
    await admin.from('predictions').insert([
      { user_id: hostile.id, match_id: finId, pred_home: 1, pred_away: 0 },
      { user_id: viewer.id, match_id: finId, pred_home: 2, pred_away: 2 },
    ]);
    log('green', `   ✓ palpites no M${finId} (galera do histórico)`);
  } else {
    log('dim', '   (sem jogo encerrado — galera do histórico não exercida; ranking ainda cobre)');
  }

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newPage();
  // Detector instalado ANTES de qualquer navegação: window.__xss coleta execuções
  // e alert é capturado (caso algum payload use alert()).
  await context.context().addInitScript(() => {
    window.__xssHits = [];
    window.__xss = (src) => { window.__xssHits.push(src); };
    const origAlert = window.alert;
    window.alert = (...a) => { window.__xssHits.push('alert:' + a.join(',')); try { origAlert?.(...a); } catch {} };
  });

  const tracker = new ErrorTracker(join(__dirname, 'xss-hostile-errors.json'));
  tracker.attachPlaywright(context);

  try {
    await login(context, VIEWER_EMAIL, PASSWORD, tracker);
    for (const p of PAGES) {
      log('blue', `\n[viewer vê] ${p.path}`);
      try {
        await context.goto(`${BASE}/${p.path}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await context.waitForSelector(p.wait, { timeout: 12000 }).catch(() => {});
        await probePage(context, tracker, p.path, p.expectName);
      } catch (e) {
        check(`${p.path}: navegou sem exceção`, false, e.message);
      }
    }
    tracker.flush();
  } finally {
    await browser.close();
  }

  // Garante que o teste não passou à toa (o nome PRECISA ter renderizado em algum lugar).
  check('nome do hostil renderizou em ≥1 página (teste não-vacuoso)', renderedSomewhere);

  console.log('');
  const failed = checks.filter(([, p]) => !p);
  if (failed.length === 0) {
    log('green', `${C.bold}🎉 XSS OK (${checks.length}/${checks.length}) — full_name malicioso é sempre escapado${C.reset}`);
  } else {
    log('red', `${C.bold}⚠️ ${failed.length}/${checks.length} FALHARAM — stored XSS possível via full_name${C.reset}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { log('red', `\n❌ ${e.message}`); process.exitCode = 1; })
  .finally(async () => {
    for (const u of [hostile, viewer]) {
      if (u) { try { await adminDeleteUser(admin, u.id); } catch {} }
    }
    log('dim', '   (usuários hostil + viewer removidos)');
  });

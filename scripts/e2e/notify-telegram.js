#!/usr/bin/env node
/**
 * notify-telegram.js — posta um alerta no Telegram (best-effort).
 *
 * Usado pelo monitor de produção (.github/workflows/monitor-prod.yml) p/ avisar
 * SÓ quando um check falha. Lê TELEGRAM_TOKEN/TELEGRAM_CHAT_ID do ambiente; se
 * faltarem, não faz nada (não derruba o job — o job já falha por conta própria).
 *
 * Uso: node scripts/e2e/notify-telegram.js "<título>" [arquivo-de-log]
 *   - título: cabeçalho do alerta (ex.: "🚨 Monitor prod: SMOKE falhou")
 *   - arquivo-de-log (opcional): as linhas de FALHA (com "✗") entram no corpo.
 */
import { readFileSync } from 'fs';

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const [, , title = 'Alerta', logPath] = process.argv;

// Remove códigos ANSI de cor (os scripts imprimem colorido).
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function buildBody() {
  if (!logPath) return '';
  let raw = '';
  try { raw = readFileSync(logPath, 'utf8'); } catch { return ''; }
  const fails = stripAnsi(raw).split('\n').filter((l) => l.includes('✗')).slice(0, 15);
  // Link direto/explícito (mesma regra da 045: label = URL) — não depende do
  // auto-link do cliente Telegram.
  const runUrl = process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';
  const ctx = runUrl ? `\n\nRun: <a href="${runUrl}">${runUrl}</a>` : '';
  if (fails.length === 0) return ctx;
  const escaped = fails.map((l) => l.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])));
  return `\n<pre>${escaped.join('\n')}</pre>${ctx}`;
}

async function main() {
  const text = `${title}${buildBody()}`;
  if (!TOKEN || !CHAT_ID) {
    console.warn('[notify] TELEGRAM_TOKEN/CHAT_ID ausentes — alerta NÃO enviado. Mensagem:\n' + stripAnsi(text));
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) console.warn(`[notify] Telegram respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
    else console.log('[notify] alerta enviado ao Telegram.');
  } catch (e) {
    console.warn('[notify] falha ao postar (best-effort):', e.message);
  }
}

main();

#!/usr/bin/env node
// Testa a formatação + envio do Telegram localmente (sem precisar deployar Edge Function).
// Replica a lógica de supabase/functions/telegram-alert/index.ts.
//
// Uso: node scripts/test-telegram-format.js

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;

const SEVERITY_EMOJI = { critical: '🚨', warn: '⚠️', info: 'ℹ️' };
const SEVERITY_LABEL = { critical: 'CRITICO', warn: 'WARN', info: 'INFO' };

function escapeMd(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c);
}

function formatMessage(p) {
  const emoji = SEVERITY_EMOJI[p.severity] ?? '•';
  const label = SEVERITY_LABEL[p.severity] ?? p.severity.toUpperCase();
  const title = escapeMd(p.title);
  const body = escapeMd(p.body);
  const category = escapeMd(p.category);

  let msg = `${emoji} *${escapeMd(label)}* \\[${category}\\]\n*${title}*\n\n${body}`;

  if (p.context && Object.keys(p.context).length > 0) {
    msg += '\n\n*Contexto:*';
    for (const [k, v] of Object.entries(p.context)) {
      const vStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
      msg += `\n• ${escapeMd(k)}: \`${escapeMd(vStr)}\``;
    }
  }

  if (SUPABASE_URL) {
    const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)/)?.[1];
    if (projectRef) {
      msg += `\n\n[Abrir dashboard](https://supabase.com/dashboard/project/${projectRef})`;
    }
  }

  msg += `\n\n_${escapeMd(new Date().toISOString())}_`;
  return msg;
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
  });
  return await res.json();
}

const samples = [
  {
    severity: 'critical',
    category: 'trigger_bug',
    title: 'points_earned NULL apos finished=true',
    body: 'A funcao on_match_finished nao calculou os pontos do palpite.',
    context: { match_id: 89, prediction_id: 1042, user_id: 'abc-123', stage: 'r16' },
  },
  {
    severity: 'critical',
    category: 'unresolved_slot',
    title: 'Slot W74 ainda nao resolvido',
    body: 'Match 89 esta finalizado mas team_home ainda mostra W74.',
    context: { match_id: 89, team_home: 'W74', team_away: 'Morocco', finished_at: '2026-07-04T18:00:00Z' },
  },
  {
    severity: 'warn',
    category: 'pred_overwrite',
    title: 'Palpite modificado apos resultado lancado',
    body: 'UPDATE em predictions.pred_home/pred_away apos match.finished=true. Possivel sobrescrita.',
    context: { match_id: 89, user_id: 'abc-123', old: '2-1', new: '1-2' },
  },
  {
    severity: 'warn',
    category: 'auth_failure',
    title: 'Multiplas tentativas de login falharam',
    body: '5 tentativas em 60s do mesmo IP.',
    context: { ip: '192.0.2.1', email: 'test@example.com', attempts: 5 },
  },
];

async function main() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ TELEGRAM_TOKEN ou TELEGRAM_CHAT_ID nao encontrado em .env');
    process.exit(1);
  }

  console.log(`📤 Enviando ${samples.length} mensagens de teste pro chat ${TELEGRAM_CHAT_ID}...\n`);

  for (const sample of samples) {
    const text = formatMessage(sample);
    console.log(`--- [${sample.severity}] ${sample.title} ---`);
    console.log(text);
    console.log('---');

    const result = await sendTelegram(text);
    if (result.ok) {
      console.log(`✓ Enviado (message_id=${result.result.message_id})\n`);
    } else {
      console.log(`✗ FALHOU: ${result.description}\n`);
    }

    // Espacamento entre msgs pra nao tomar rate limit
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('✅ Confere no Telegram se as 4 mensagens chegaram com formatacao bonita.');
}

main().catch((e) => {
  console.error('❌ Erro:', e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Posta no Telegram as mensagens de palpites recém-lacrados GERADAS pelo
 * snapshot.js — roda como passo SEPARADO da Action (integrity-snapshot.yml),
 * depois do verify + commit/push: o grupo só recebe o alerta se o relatório
 * linkado nas mensagens estiver de fato publicado (decisão 2026-06-11).
 *
 * Sem arquivo (lacre sem jogo novo, ou snapshot dedupado) → no-op, exit 0.
 * Sem credenciais de Telegram → no-op, exit 0 (mesmo contrato do snapshot).
 * Falha de envio → exit 1 (fica vermelho na Action, visível — diferente do
 * best-effort do hash, aqui a mensagem É o produto do passo).
 *
 * KEEP IN SYNC: scripts/integrity/snapshot.js (produtor do arquivo) e
 * scripts/integrity/telegram-picks.js (formato das mensagens).
 */

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

// Mesmo path do produtor (snapshot.js PICKS_OUT_*) — dir gerado em runtime.
const TMP_DIR = join(__dirname, '.tmp');
const FILE = join(TMP_DIR, 'locked-picks-telegram.json');
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!existsSync(FILE)) {
  console.log('Sem palpites recém-lacrados para postar (nenhum jogo novo neste lacre).');
  process.exit(0);
}
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.log('TELEGRAM_TOKEN/CHAT_ID ausentes — envio pulado (mensagens ficam no .tmp).');
  process.exit(0);
}

const { seq, messages } = JSON.parse(readFileSync(FILE, 'utf8'));

for (const text of messages) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID, text,
      parse_mode: 'HTML', disable_web_page_preview: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    console.error(`ERRO ao postar palpites do lacre #${seq}: HTTP ${res.status} — ${body.description ?? '?'}`);
    process.exit(1);
  }
}

unlinkSync(FILE); // consome o artefato — run local repetido não re-posta
console.log(`✅ Palpites do lacre #${seq} postados no grupo (${messages.length} mensagem(ns)).`);

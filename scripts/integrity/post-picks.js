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
 * Após enviar com SUCESSO, grava o ANÚNCIO-ÚNICO no banco (settings
 * `integrity_picks_announced` = { seq, ranking }) — é o que faz o snapshot.js
 * mandar o alerta de cada lacre exatamente uma vez, e alimenta o "subiu/caiu"
 * do próximo lacre. Sem credenciais Supabase → pula o registro (no-op local).
 *
 * KEEP IN SYNC: scripts/integrity/snapshot.js (produtor do arquivo + leitor do
 * estado) e scripts/integrity/telegram-picks.js (formato das mensagens).
 */

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

// Mesmo path do produtor (snapshot.js PICKS_OUT_*) — dir gerado em runtime.
const TMP_DIR = join(__dirname, '.tmp');
const FILE = join(TMP_DIR, 'locked-picks-telegram.json');
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANNOUNCE_KEY = 'integrity_picks_announced';

if (!existsSync(FILE)) {
  console.log('Sem palpites recém-lacrados para postar (nenhum jogo novo neste lacre).');
  process.exit(0);
}
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.log('TELEGRAM_TOKEN/CHAT_ID ausentes — envio pulado (mensagens ficam no .tmp).');
  process.exit(0);
}

const { seq, ranking, messages } = JSON.parse(readFileSync(FILE, 'utf8'));

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

// Anúncio-único: registra que ESTE lacre já foi ao grupo (e guarda a ordem do
// ranking pra medir "subiu/caiu" no próximo). Só após o envio dar certo, pra
// não marcar como anunciado algo que não saiu. Sem credenciais → pula (local).
if (SUPABASE_URL && SERVICE_KEY) {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  // value é jsonb: passa o OBJETO (não string) pra gravar como objeto jsonb.
  const value = { seq, ranking: ranking ?? [] };
  const { error } = await admin.from('settings').upsert({ key: ANNOUNCE_KEY, value }, { onConflict: 'key' });
  if (error) {
    console.error(`ERRO ao gravar anúncio-único do lacre #${seq}: ${error.message}`);
    process.exit(1); // sem o estado, o alerta repetiria amanhã — falha visível
  }
  console.log(`   anúncio-único gravado (seq ${seq}, ${ranking?.length ?? 0} no ranking).`);
} else {
  console.log('   SUPABASE_URL/KEY ausentes — anúncio-único não gravado (run local).');
}

unlinkSync(FILE); // consome o artefato — run local repetido não re-posta
console.log(`✅ Palpites do lacre #${seq} postados no grupo (${messages.length} mensagem(ns)).`);

#!/usr/bin/env node
// Preview dos alertas DIRETO no Telegram, SEM depender de deploy.
//
// Lê TELEGRAM_TOKEN / TELEGRAM_CHAT_ID do .env e manda mensagens de exemplo
// usando EXATAMENTE o mesmo formatMessage() da edge function telegram-alert.
// Serve pra você ver o visual final antes de deployar a edge function/migration.
//
// Uso:
//   node scripts/preview-alerts-telegram.js                 → manda todos
//   node scripts/preview-alerts-telegram.js --only=payments → só um
//   node scripts/preview-alerts-telegram.js --dry-run       → só imprime, não manda
//   node scripts/preview-alerts-telegram.js --chat=<id>     → sobrescreve o destino
//
// ⚠️ Manda pro chat do .env (ou --chat). Se for o chat dos participantes,
//    eles vão ver. Pra preview seguro, use seu chat privado em --chat=<id>.

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
const DRY_RUN = args['dry-run'] === true;
const ONLY = args.only || null;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = args.chat || process.env.TELEGRAM_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SITE_URL = 'https://bolaobsbcopadomundo2026.netlify.app';

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };

// ─────────────────────────────────────────────────────────────────
// Espelho EXATO do formatMessage() da edge function (mantenha em sync).
// ─────────────────────────────────────────────────────────────────
const SEVERITY_EMOJI = { critical: '🚨', warn: '⚠️', info: 'ℹ️' };

function escapeMd(s) {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c);
}
function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\/[^\s)]+$/.test(s);
}
function formatMessage(p) {
  const title = escapeMd(p.title);
  const body = escapeMd(p.body);
  const ctx = p.context ?? {};

  if (p.severity === 'info') {
    let msg = `*${title}*\n\n${body}`;
    if (isHttpUrl(ctx.cta_url)) {
      const label = typeof ctx.cta_label === 'string' && ctx.cta_label ? ctx.cta_label : 'Abrir';
      const safeUrl = ctx.cta_url.replace(/[\\)]/g, (c) => '\\' + c);
      msg += `\n\n[${escapeMd(label)}](${safeUrl})`;
    }
    return msg;
  }

  const emoji = SEVERITY_EMOJI[p.severity] ?? '•';
  let msg = `${emoji} *${title}*\n\n${body}`;
  if (SUPABASE_URL) {
    const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)/)?.[1];
    if (projectRef) {
      msg += `\n\n[Abrir dashboard](https://supabase.com/dashboard/project/${projectRef})`;
    }
  }
  return msg;
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'MarkdownV2', disable_web_page_preview: true }),
  });
  const data = await res.json();
  if (!data.ok) {
    // fallback sem markdown (igual edge function)
    const fb = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text.replace(/\\/g, '') }),
    });
    const fbData = await fb.json();
    if (fbData.ok) return { ok: true, message_id: fbData.result.message_id, fallback: true };
    return { ok: false, error: data.description };
  }
  return { ok: true, message_id: data.result.message_id };
}

// ─────────────────────────────────────────────────────────────────
// Payloads de exemplo (espelham o que o SQL gera, com dados ficticios).
// ─────────────────────────────────────────────────────────────────
const SAMPLES = {
  signup: {
    severity: 'info',
    title: '✨ Novo participante: Maria Souza',
    body: 'Maria Souza acabou de entrar no bolão! Já somos 11 jogador(es) na disputa. 🎉',
    context: { cta_url: SITE_URL, cta_label: 'Ver o bolão' },
  },
  payments: {
    severity: 'info',
    title: '💰 Pagamentos do bolão — 01/06',
    body:
`💰 PAGAMENTOS: 8 de 11 em dia · caixa R$ 800

✅ JÁ PAGARAM (8):
• Ana Silva
• Bruno Costa
• Carla Dias
• Diego Reis
• Ewerton Lima
• Fábio Souza
• Gabi Nunes
• Hugo Alves

⏳ FALTAM PAGAR (3):
• João Mendes
• Maria Souza
• Pedro Lima

💸 Inscrição R$ 100 · PIX: 05960278189

👉 Ainda não está na lista? Cadastre-se no botão abaixo.`,
    context: { cta_url: SITE_URL, cta_label: 'Entrar no bolão' },
  },
  group: {
    severity: 'info',
    title: '📋 Palpites de grupo — 01/06',
    body:
`⏰ Cada jogo trava 23h59 da véspera.
1º jogo trava 10/06 às 23h59 (faltam 9 dias)

📋 PROGRESSO (72 jogos de grupo):
🔴 João Mendes — 0/72
🟡 Carla Dias — 45/72
🟡 Diego Reis — 60/72
✅ Ana Silva — 72/72
✅ Bruno Costa — 72/72
✅ Ewerton Lima — 72/72
✅ Fábio Souza — 72/72
✅ Gabi Nunes — 72/72

8/11 fecharam todos os palpites.`,
    context: { cta_url: SITE_URL, cta_label: 'Fazer meus palpites' },
  },
  cs: {
    severity: 'info',
    title: '🏆 Campeão & ⚽ Artilheiro — 01/06',
    body:
`⏰ Data limite: 10/06 às 23h59 (faltam 9 dias)

🏆 FALTA ESCOLHER CAMPEÃO (2):
• João Mendes
• Maria Souza

⚽ FALTA ESCOLHER ARTILHEIRO (3):
• João Mendes
• Maria Souza
• Pedro Lima

9/11 com campeão · 8/11 com artilheiro.`,
    context: { cta_url: SITE_URL, cta_label: 'Escolher campeão/artilheiro' },
  },
  countdown: {
    severity: 'info',
    title: '⏳ Faltam 3 dias pra travar Campeão & Artilheiro!',
    body:
`O prazo é 10/06 às 23h59.

Ainda sem palpite de campeão e/ou artilheiro:
• João Mendes
• Maria Souza

Não deixe pra última hora! 👇`,
    context: { cta_url: SITE_URL, cta_label: 'Garantir meu palpite' },
  },
  lock: {
    severity: 'info',
    title: '🌙 Palpites travam hoje — 2 jogo(s)',
    body:
`🌙 ATENÇÃO: os palpites destes jogos travam HOJE às 23h59!
• 11/06 às 13h00 — Brasil x Croácia
• 11/06 às 16h00 — México x EUA

Ainda dá tempo de palpitar até 23h59. 👇`,
    context: { cta_url: SITE_URL, cta_label: 'Palpitar agora' },
  },
  recap: {
    severity: 'info',
    title: '📊 Resumo do dia — 11/06',
    body:
`📊 RESULTADOS (últimas 24h):
• Brasil 2 x 1 Croácia
• México 0 x 0 EUA
• Argentina 1 x 1 Nigéria (pên: Argentina)

🏆 TOP DO BOLÃO:
🥇 Ana Silva — 38 pts
🥈 Bruno Costa — 35 pts
🥉 Carla Dias — 31 pts`,
    context: { cta_url: SITE_URL, cta_label: 'Ver classificação' },
  },
  bug_orphan: {
    severity: 'critical',
    title: 'Match #57: 3 palpite(s) sem pontos calculados',
    body: 'Match #57 (round_of_32) foi finalizado, mas 3 de 40 palpites ainda têm points_earned NULL. Trigger on_match_finished pode ter falhado.',
    context: {},
  },
  bug_overwrite: {
    severity: 'warn',
    title: 'Palpite modificado APÓS jogo finalizado (match #57)',
    body: 'Predictions row 1234 alterada após match.finished=true (terminou em 2026-06-11 18:30). Antes: 2-1. Depois: 2-2.',
    context: {},
  },
  heartbeat: {
    severity: 'warn',
    title: 'Cron(s) de alerta diário possivelmente parado(s)',
    body:
`Os seguintes crons não rodam há mais de 26h:
• daily_payments: 04/06 09:01

Verifique pg_cron (cron.job / cron.job_run_details) no dashboard.`,
    context: {},
  },
};

async function main() {
  console.log(`${C.bold}📲 Preview dos alertas no Telegram${C.reset}`);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error(`${C.red}❌ Faltando TELEGRAM_TOKEN ou TELEGRAM_CHAT_ID no .env (ou --chat).${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.dim}   destino chat_id: ${TELEGRAM_CHAT_ID}${args.chat ? ' (via --chat)' : ' (do .env)'}${C.reset}`);
  if (DRY_RUN) console.log(`${C.yellow}   MODO DRY-RUN (não envia)${C.reset}`);
  if (ONLY) console.log(`${C.blue}   Filtro: --only=${ONLY}${C.reset}`);

  const keys = ONLY ? [ONLY] : Object.keys(SAMPLES);
  let okCount = 0;
  for (const k of keys) {
    const p = SAMPLES[k];
    if (!p) { console.error(`${C.red}   ✗ alerta desconhecido: ${k}${C.reset}`); continue; }
    const text = formatMessage(p);
    if (DRY_RUN) {
      console.log(`\n${C.bold}─── ${k} (${p.severity}) ───${C.reset}\n${text}`);
      okCount++;
      continue;
    }
    const r = await sendTelegram(text);
    if (r.ok) { console.log(`${C.green}   ✓ ${k}${C.reset}${r.fallback ? C.yellow + ' (fallback sem markdown)' + C.reset : ''} → msg ${r.message_id}`); okCount++; }
    else console.log(`${C.red}   ✗ ${k}: ${r.error}${C.reset}`);
    await new Promise((res) => setTimeout(res, 700));
  }
  console.log(`\n${C.bold}${okCount}/${keys.length} ${DRY_RUN ? 'renderizados' : 'enviados'}.${C.reset}`);
  if (!DRY_RUN) console.log(`${C.dim}Confere no Telegram. Pra limpar: apague as mensagens de teste.${C.reset}`);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });

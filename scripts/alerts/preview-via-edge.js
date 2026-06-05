#!/usr/bin/env node
// Dispara os NOVOS alertas (migration 042) DIRETO na Edge Function telegram-alert,
// que já tem o TELEGRAM_TOKEN/CHAT_ID nos secrets do Supabase e manda pro chat.
//
// Por que pela edge e não pela API do Telegram? O .env local NÃO tem TELEGRAM_TOKEN
// (mora só nos secrets da edge). Mas tem SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY,
// que bastam pra invocar a edge — exatamente o caminho que o send_alert() usa.
//
// São DADOS FICTÍCIOS, só pra revisar o visual. Manda uma faixa de aviso antes.
//
// Uso:
//   node scripts/alerts/preview-via-edge.js            → manda todos
//   node scripts/alerts/preview-via-edge.js --only=pool_settled
//   node scripts/alerts/preview-via-edge.js --dry-run  → só imprime o payload
//   node scripts/alerts/preview-via-edge.js --no-banner → sem a faixa de aviso

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
const DRY_RUN = args['dry-run'] === true;
const ONLY = args.only || null;
const NO_BANNER = args['no-banner'] === true;

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const EDGE_URL = `${SUPABASE_URL}/functions/v1/telegram-alert`;
const SITE = 'https://superbolaocopa.netlify.app';

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };

// ─────────────────────────────────────────────────────────────────
// Exemplos dos NOVOS alertas (espelham o corpo gerado pelo SQL da 042).
// ─────────────────────────────────────────────────────────────────
// Links sempre diretos/explícitos (igual à migração 045: send_alert força
// cta_label = cta_url). O rótulo é ignorado de propósito.
const cta = () => ({ cta_url: SITE, cta_label: SITE });

const SAMPLES = {
  daily_payments: {
    severity: 'info',
    title: '💰 Pagamentos do bolão — 05/06',
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

🏆 PREMIAÇÃO ESTIMADA (com a caixa atual):
🥇 1º lugar — R$ 560
🥈 2º lugar — R$ 160
🥉 3º lugar — R$ 80
(quanto mais gente pagar, maior o prêmio 💸)

👉 Ainda não está no bolão? Entre pelo link abaixo:`,
    context: cta(SITE),
  },
  result_confirmed_group: {
    severity: 'info',
    title: '✅ Fim de jogo: Brasil x Sérvia',
    body:
`✅ Resultado oficial: Brasil 2 x 0 Sérvia

🎯 3 de 11 cravaram o placar exato!

Pontos recalculados e lacrados. 🔒`,
    context: cta('Ver classificação'),
  },
  result_confirmed_ko: {
    severity: 'info',
    title: '✅ Fim de jogo: Argentina x França',
    body:
`✅ Resultado oficial: Argentina 1 x 1 França (pên: Argentina)

🎯 1 de 11 cravaram o placar exato!
🛡️ 7 acertaram quem avançou.

Pontos recalculados e lacrados. 🔒`,
    context: cta('Ver classificação'),
  },
  result_corrected: {
    severity: 'info',
    title: '🔧 Resultado corrigido: México x EUA',
    body:
`O resultado de México x EUA foi ajustado pelo admin.

Antes: 1 x 0
Agora: 2 x 0

Todos os pontos foram recalculados automaticamente — transparência total. 🔒`,
    context: cta('Ver classificação'),
  },
  match_void: {
    severity: 'info',
    title: '🚫 Jogo anulado: Irã x Catar',
    body: 'O jogo Irã x Catar (12/06 às 13h00) foi ANULADO. Ele não vale pontos pra ninguém e saiu do cálculo da classificação — os palpites desse jogo ficam sem efeito para todos, por igual.',
    context: cta('Ver jogos'),
  },
  match_postponed: {
    severity: 'info',
    title: '⏳ Jogo adiado: Gana x Coreia do Sul',
    body: 'O jogo Gana x Coreia do Sul foi ADIADO. Quando a nova data sair, o prazo de palpite acompanha (trava 23h59 da véspera). Por enquanto nada muda na sua pontuação.',
    context: cta('Ver jogos'),
  },
  champion_revealed: {
    severity: 'info',
    title: '🏆 Argentina é campeã! E o bolão?',
    body:
`🏆 Argentina é CAMPEÃ da Copa do Mundo 2026! (nos pênaltis)

🎯 4 de 11 cravaram o campeão (+40 pts):
• Ana Silva
• Bruno Costa
• Carla Dias
• Diego Reis

O pódio final do bolão sai já já. 🏅`,
    context: cta('Ver classificação'),
  },
  ko_phase_opens: {
    severity: 'info',
    title: '🆕 Oitavas de final — palpites abertos',
    body:
`🆕 Oitavas de final definida! Os confrontos já têm times reais e os palpites estão ABERTOS.

• 28/06 às 13h00 — Brasil x Uruguai
• 28/06 às 16h00 — Argentina x Portugal
• 29/06 às 13h00 — França x Croácia
• 29/06 às 16h00 — Espanha x Marrocos

Cada jogo trava 23h59 da véspera. 👇`,
    context: cta('Palpitar agora'),
  },
  final_opens: {
    severity: 'info',
    title: '🆕 FINAL — palpites abertos',
    body:
`🆕 FINAL definida! Os confrontos já têm times reais e os palpites estão ABERTOS.
⭐ É o jogo de MAIOR peso do bolão — o placar exato da final vale até 76 pts!

• 19/07 às 16h00 — Argentina x França

Cada jogo trava 23h59 da véspera. 👇`,
    context: cta('Palpitar agora'),
  },
  leader_change: {
    severity: 'info',
    title: '🔄 Temos um novo líder no bolão!',
    body:
`Bruno Costa assumiu a liderança com 142 pts, passando Ana Silva! 🔥

Quem vai reagir?`,
    context: cta('Ver classificação'),
  },
  round_movers: {
    severity: 'info',
    title: '🔥 Os destaques da rodada',
    body:
`🔥 QUEM MAIS PONTUOU (últimas 24h):
🥇 Diego Reis — +28 pts
🥈 Ana Silva — +24 pts
🥉 Hugo Alves — +19 pts

Bora pros próximos jogos! 👇`,
    context: cta('Ver classificação'),
  },
  group_stage_done: {
    severity: 'info',
    title: '🏁 Fase de grupos encerrada!',
    body:
`A fase de grupos acabou! 🏁 Hora do mata-mata.

🏆 LÍDER PROVISÓRIO (prêmio parcial):
🥇 Ana Silva — 88 pts
🥈 Bruno Costa — 81 pts
🥉 Carla Dias — 74 pts

Mas calma: ~55% dos pontos ainda estão em jogo no mata-mata. Tudo pode virar! 🔥`,
    context: cta('Ver classificação'),
  },
  pool_settled: {
    severity: 'info',
    title: '🏆 Resultado FINAL do bolão — pódio + premiação',
    body:
`🏁 É OFICIAL — o bolão da Copa 2026 chegou ao fim! Pódio final:
🥇 Bruno Costa — 287 pts
🥈 Ana Silva — 263 pts
🥉 Diego Reis — 241 pts

💰 PREMIAÇÃO (caixa R$ 1.100):
🥇 Bruno Costa — R$ 770
🥈 Ana Silva — R$ 220
🥉 Diego Reis — R$ 110

Obrigado a todos que jogaram! 🏆 Até a próxima Copa.`,
    context: cta('Ver classificação final'),
  },
  inactive_paid: {
    severity: 'info',
    title: '⚽ 3 pago(s) ainda sem nenhum palpite',
    body:
`3 já pagaram mas ainda não fizeram NENHUM palpite — é ponto de graça ficando na mesa:
• João Mendes
• Maria Souza
• Pedro Lima

Bora abrir e palpitar! 👇`,
    context: cta('Fazer meus palpites'),
  },
  signup_late: {
    severity: 'info',
    title: '✨ Novo participante: Pedro Lima',
    body:
`Pedro Lima acabou de entrar no bolão! Já somos 12 jogador(es) na disputa. 🎉

👋 Aviso: a Copa já começou, então alguns palpites (e talvez campeão/artilheiro) já travaram. Mas ainda dá pra disputar os jogos que faltam — abre lá e não perca os próximos!`,
    context: cta('Ver o bolão'),
  },
};

const BANNER = {
  severity: 'info',
  title: '🧪 PRÉVIA — novos alertas (migração 042)',
  body: 'As próximas mensagens são EXEMPLOS com dados FICTÍCIOS, só pra revisão do admin. Pode ignorar — nada disso aconteceu de verdade. 👇',
  context: {},
};

async function fire(payload) {
  const res = await fetch(EDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
    },
    body: JSON.stringify(payload),
  });
  let data = {};
  try { data = await res.json(); } catch { /* edge sempre devolve json, mas… */ }
  return { httpOk: res.ok, ...data };
}

async function main() {
  console.log(`${C.bold}📲 Disparo dos novos alertas via Edge Function${C.reset}`);
  if (!SUPABASE_URL || !ANON) {
    console.error(`${C.red}❌ Faltando SUPABASE_URL ou SUPABASE_PUBLISHABLE_KEY no .env${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.dim}   edge: ${EDGE_URL}${C.reset}`);
  if (DRY_RUN) console.log(`${C.yellow}   MODO DRY-RUN (não envia)${C.reset}`);

  const keys = ONLY ? [ONLY] : Object.keys(SAMPLES);
  const queue = (!ONLY && !NO_BANNER) ? [['_banner', BANNER], ...keys.map((k) => [k, SAMPLES[k]])]
                                      : keys.map((k) => [k, SAMPLES[k]]);

  let ok = 0;
  for (const [k, p] of queue) {
    if (!p) { console.error(`${C.red}   ✗ desconhecido: ${k}${C.reset}`); continue; }
    if (DRY_RUN) {
      console.log(`\n${C.bold}─── ${k} (${p.severity}) ───${C.reset}\n${p.title}\n${p.body}`);
      ok++; continue;
    }
    try {
      // a edge function (validatePayload) exige `category` não-vazio
      const r = await fire({ ...p, category: k === '_banner' ? 'preview' : k });
      if (r.ok) { console.log(`${C.green}   ✓ ${k}${C.reset} → msg ${r.message_id}`); ok++; }
      else { console.log(`${C.red}   ✗ ${k}: ${r.error || JSON.stringify(r)}${C.reset}`); }
    } catch (e) {
      console.log(`${C.red}   ✗ ${k}: ${e.message}${C.reset}`);
    }
    await new Promise((res) => setTimeout(res, 800));  // respeita rate-limit do Telegram
  }
  console.log(`\n${C.bold}${ok}/${queue.length} ${DRY_RUN ? 'renderizados' : 'enviados'}.${C.reset}`);
  if (!DRY_RUN) console.log(`${C.dim}Confere no Telegram. Pra limpar os exemplos: apague as mensagens.${C.reset}`);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });

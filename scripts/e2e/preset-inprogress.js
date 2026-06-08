#!/usr/bin/env node
/**
 * preset-inprogress.js — alterna o ambiente LOCAL entre o calendário CANÔNICO
 * (datas reais da Copa 2026) e um estado "COPA EM ANDAMENTO" (datas deslocadas):
 *   - jogos JÁ ENCERRADOS  → passado  → histórico revela tudo, calendário "Encerrado"
 *   - jogos AINDA ABERTOS  → futuro   → palpites abertos, calendário verde/pendente
 *
 * Idempotente: sempre calcula a partir do snapshot canônico (canonical-dates.json),
 * então pode rodar quantas vezes quiser sem acumular deslocamento.
 *
 * NUNCA toca prod: makeAdminClient() aborta se SUPABASE_URL não for local.
 *
 * Uso (com env local carregado):
 *   node scripts/e2e/preset-inprogress.js --capture   # (1x) salva as datas atuais como canônicas
 *   node scripts/e2e/preset-inprogress.js --on        # aplica "Copa em andamento"
 *   node scripts/e2e/preset-inprogress.js --off        # volta ao calendário canônico
 *
 * Pré-requisito do --on: o estado de RESULTADOS já aplicado (ex.: playout-r32.sql),
 * pois ele decide passado/futuro pela flag `finished` do snapshot.
 */
import { makeAdminClient } from './lib/admin-client.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP = join(__dirname, 'canonical-dates.json');
const DAY = 86400000;

const mode = process.argv.includes('--capture') ? 'capture'
  : process.argv.includes('--off') ? 'off'
  : process.argv.includes('--on') ? 'on' : null;
if (!mode) { console.error('uso: --capture | --on | --off'); process.exit(2); }

const admin = makeAdminClient();   // aborta se não for local

// --- capture: snapshot das datas atuais (assumidas canônicas) + flag finished ---
if (mode === 'capture') {
  const { data, error } = await admin.from('matches').select('id, match_date, finished').order('id');
  if (error) throw error;
  writeFileSync(SNAP, JSON.stringify(data, null, 2));
  console.log(`✅ snapshot canônico salvo: ${data.length} jogos → ${SNAP}`);
  process.exit(0);
}

if (!existsSync(SNAP)) { console.error(`❌ ${SNAP} ausente — rode --capture primeiro (com as datas canônicas no banco).`); process.exit(1); }
const canon = JSON.parse(readFileSync(SNAP, 'utf8'));

// --- off: restaura as datas canônicas ---
if (mode === 'off') {
  for (const m of canon) {
    const { error } = await admin.from('matches').update({ match_date: m.match_date }).eq('id', m.id);
    if (error) throw new Error(`m${m.id}: ${error.message}`);
  }
  console.log(`✅ calendário canônico restaurado (${canon.length} jogos).`);
  process.exit(0);
}

// --- on: desloca encerrados p/ o passado e abertos p/ o futuro ---
const fin = canon.filter(m => m.finished);
const open = canon.filter(m => !m.finished);
if (!fin.length) { console.error('❌ nenhum jogo finalizado no snapshot — aplique o playout antes de capturar/ligar.'); process.exit(1); }

const now = Date.now();
const t = (s) => new Date(s).getTime();
// encerrados: o último cai 2 dias ATRÁS (preserva o espaçamento interno)
const maxFin = Math.max(...fin.map(m => t(m.match_date)));
const shiftFin = maxFin - (now - 2 * DAY);
// abertos: o primeiro cai 3 dias À FRENTE
const minOpen = open.length ? Math.min(...open.map(m => t(m.match_date))) : 0;
const shiftOpen = open.length ? (minOpen - (now + 3 * DAY)) : 0;

let n = 0;
for (const m of fin) {
  const nd = new Date(t(m.match_date) - shiftFin).toISOString();
  const { error } = await admin.from('matches').update({ match_date: nd }).eq('id', m.id);
  if (error) throw new Error(`m${m.id}: ${error.message}`); n++;
}
for (const m of open) {
  const nd = new Date(t(m.match_date) - shiftOpen).toISOString();
  const { error } = await admin.from('matches').update({ match_date: nd }).eq('id', m.id);
  if (error) throw new Error(`m${m.id}: ${error.message}`); n++;
}

console.log(`✅ "Copa em andamento" aplicada (${n} jogos):`);
console.log(`   ${fin.length} encerrados → passado (último ~2 dias atrás)`);
console.log(`   ${open.length} abertos → futuro (próximo ~3 dias à frente)`);
console.log(`   Reverter: node scripts/e2e/preset-inprogress.js --off`);

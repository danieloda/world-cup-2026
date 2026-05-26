#!/usr/bin/env node
// Mostra progresso em tempo real do Step 4 (admin lancando resultados).
// Uso: node scripts/e2e/progress.js
//      node scripts/e2e/progress.js --watch     # loop com refresh a cada 10s

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const WATCH = process.argv.includes('--watch');

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function bar(n, total, width = 40) {
  const filled = Math.round((n / total) * width);
  return '[' + '█'.repeat(filled) + '·'.repeat(width - filled) + ']';
}

let lastCount = 0;
let lastTime = Date.now();

async function tick() {
  const stages = ['group', 'r32', 'r16', 'qf', 'sf', 'third', 'final'];
  const totals = { group: 72, r32: 16, r16: 8, qf: 4, sf: 2, third: 1, final: 1 };

  let total = 0, totalAll = 104;
  const lines = [];
  for (const s of stages) {
    const { count } = await admin.from('matches').select('*', { count: 'exact', head: true }).eq('finished', true).eq('stage', s);
    total += count;
    lines.push(`   ${s.padEnd(6)} ${bar(count, totals[s], 30)} ${count}/${totals[s]}`);
  }

  // Pace
  const now = Date.now();
  const delta = total - lastCount;
  const elapsed = (now - lastTime) / 1000;
  const pace = delta > 0 ? (elapsed / delta).toFixed(1) : '—';
  const remaining = totalAll - total;
  const eta = (delta > 0 && remaining > 0) ? Math.round((remaining * (elapsed / delta)) / 60) : null;

  lastCount = total;
  lastTime = now;

  console.clear();
  console.log('═══ Step 4 Progress ═══\n');
  console.log(`Total: ${bar(total, totalAll, 50)} ${total}/${totalAll} (${(total/totalAll*100).toFixed(1)}%)`);
  console.log(`Pace:  ${pace}s/match  ${eta != null ? `· ETA: ~${eta}min` : ''}\n`);
  console.log(lines.join('\n'));

  // Predictions com pontos calculados
  const { count: ptsCalc } = await admin.from('predictions').select('*', { count: 'exact', head: true }).not('points_earned', 'is', null);
  const { count: ptsTotal } = await admin.from('predictions').select('*', { count: 'exact', head: true });
  console.log(`\nPredictions pts calculados: ${ptsCalc}/${ptsTotal}`);

  // Alertas recentes
  const { data: alerts } = await admin
    .from('alert_log')
    .select('severity, category, title, created_at')
    .order('created_at', { ascending: false })
    .limit(5);
  console.log(`\nÚltimos alertas:`);
  for (const a of alerts || []) {
    const time = new Date(a.created_at).toLocaleTimeString('pt-BR');
    console.log(`   ${time} [${a.severity}] ${a.category}: ${a.title}`);
  }
}

async function main() {
  await tick();
  if (WATCH) {
    setInterval(tick, 10000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

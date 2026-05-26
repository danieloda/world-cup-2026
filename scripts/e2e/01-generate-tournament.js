#!/usr/bin/env node
/**
 * Step 1 do E2E: Gera o torneio simulado (104 jogos + scorers + campeao).
 * Output: scripts/e2e/expected-tournament.json
 *
 * Este arquivo eh a fonte da verdade pra:
 *   - Strategy "exact_all" sabe qual placar palpitar
 *   - Audit compara DB final vs expected
 *   - Admin sabe quais placares lancar
 *
 * Uso: node scripts/e2e/01-generate-tournament.js
 *      node scripts/e2e/01-generate-tournament.js --seed=other
 */

import { makeAdminClient } from './lib/admin-client.js';
import { simulateTournament } from './lib/tournament-simulator.js';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const SEED = args.seed || 'wc2026-e2e-v1';
const OUTPUT = join(__dirname, 'expected-tournament.json');

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m' };
const log = (c, m) => console.log(`${C[c]}${m}${C.reset}`);

async function main() {
  log('blue', `${C.bold}🎲 Step 1/N: Gerar torneio simulado${C.reset}`);
  log('blue', `   Seed: ${SEED}`);

  const admin = makeAdminClient();

  log('blue', '\n📥 Carregando matches e players do DB...');
  const { data: matches, error: mErr } = await admin
    .from('matches')
    .select('id, stage, group_name, team_home, team_away, slot_home, slot_away, match_date')
    .order('id');
  if (mErr) throw mErr;

  // Supabase default limit eh 1000 — paginar pra pegar TODOS os ~1380 players
  let players = [];
  let page = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error: pErr } = await admin
      .from('players')
      .select('id, full_name, team, position')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (pErr) throw pErr;
    players = players.concat(data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }

  log('green', `   ✓ ${matches.length} matches, ${players.length} players`);

  // Verifica se matches estao em estado "reset" (KO ainda com slots)
  const koWithRealTeams = matches.filter((m) =>
    m.stage !== 'group' && m.slot_home && m.team_home !== m.slot_home
  );
  if (koWithRealTeams.length > 0) {
    log('yellow', `   ⚠ ${koWithRealTeams.length} matches KO ja tem team_home <> slot_home.`);
    log('yellow', `     Rode scripts/reset-for-e2e.js primeiro pra restaurar slots.`);
    process.exit(1);
  }

  log('blue', '\n🏆 Simulando torneio offline...');
  const result = simulateTournament(matches, players, SEED);

  log('green', `   ✓ ${result.matches.length} matches gerados`);
  log('green', `   🏆 Campeao: ${result.champion}`);
  log('green', `   ⚽ Top scorer: ${result.topScorer?.full_name} (${result.topScorer?.team}) — ${result.topScorer?.total_goals} gols`);

  // Verifica integridade
  log('blue', '\n🔍 Validacoes:');
  const allHaveTeams = result.matches.every((m) =>
    m.team_home && m.team_away &&
    !/^[0-9WL]/.test(m.team_home) && !/^[0-9WL]/.test(m.team_away) &&
    !m.team_home.includes('/') && !m.team_away.includes('/')
  );
  log(allHaveTeams ? 'green' : 'red', `   ${allHaveTeams ? '✓' : '✗'} Todos os 104 matches tem teams reais resolvidos`);

  const koResolved = result.matches.filter((m) => m.stage !== 'group').length === 32;
  log(koResolved ? 'green' : 'red', `   ${koResolved ? '✓' : '✗'} 32 matches KO resolvidos`);

  const championSet = !!result.champion && !/^[0-9WL]/.test(result.champion);
  log(championSet ? 'green' : 'red', `   ${championSet ? '✓' : '✗'} Campeao definido`);

  // Estatisticas
  const stagesCount = {};
  for (const m of result.matches) {
    stagesCount[m.stage] = (stagesCount[m.stage] || 0) + 1;
  }
  log('blue', '\n📊 Distribuicao por stage:');
  for (const [stage, count] of Object.entries(stagesCount)) {
    log('blue', `   ${stage.padEnd(6)} ${count} matches`);
  }

  // Total de gols
  const totalGoals = result.matches.reduce((s, m) => s + m.actual_home + m.actual_away, 0);
  const totalScorers = result.matches.reduce((s, m) => s + (m.scorers?.length ?? 0), 0);
  log('blue', `\n📊 Total gols: ${totalGoals} (em ${totalScorers} scorer entries)`);

  // Salva
  writeFileSync(OUTPUT, JSON.stringify(result, null, 2), 'utf8');
  log('green', `\n✅ Salvo em ${OUTPUT}`);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

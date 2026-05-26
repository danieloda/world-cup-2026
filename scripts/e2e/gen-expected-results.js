#!/usr/bin/env node
/**
 * Gera scripts/e2e/expected-results.json — os "resultados oficiais" que
 * o admin vai lancar durante o E2E. Deterministico (seed fixa).
 *
 * Estrutura do output:
 *   {
 *     "seed": "wc2026-e2e-v1",
 *     "matches": [
 *       { id: 1, stage: "group", actual_home: 2, actual_away: 1, pen_winner: null, scorers: [{ player_id, goals }, ...] },
 *       ...
 *     ],
 *     "topScorer": { player_id, full_name, team, total_goals }
 *   }
 *
 * Uso: node scripts/e2e/gen-expected-results.js
 *      node scripts/e2e/gen-expected-results.js --seed=custom
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
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

const SEED = args.seed || 'wc2026-e2e-v1';
const OUTPUT = join(__dirname, 'expected-results.json');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);

// ============================================================
// Seeded PRNG (mulberry32) — deterministico
// ============================================================
function hashSeed(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// Score generator — placares realistas
// ============================================================
const REALISTIC_SCORES = [
  [0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2],
  [2, 1], [1, 2], [2, 2], [3, 0], [0, 3], [3, 1], [1, 3],
  [3, 2], [2, 3], [4, 0], [0, 4], [4, 1], [1, 4], [4, 2],
  [3, 3], [5, 0], [0, 5]
];

function pickScore(rng, stage) {
  // KO tende pra placares mais baixos
  const pool = stage === 'group' ? REALISTIC_SCORES : REALISTIC_SCORES.slice(0, 15);
  return pool[Math.floor(rng() * pool.length)];
}

// ============================================================
// Login admin
// ============================================================
async function login() {
  const { error } = await supabase.auth.signInWithPassword({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  if (error) throw new Error('Login falhou: ' + error.message);
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log(`🎲 Gerando expected results (seed=${SEED})...`);
  await login();

  const { data: matches, error: mErr } = await supabase
    .from('matches')
    .select('id, stage, team_home, team_away, slot_home, slot_away, match_date')
    .order('id');
  if (mErr) throw mErr;

  const { data: players, error: pErr } = await supabase
    .from('players')
    .select('id, full_name, team, position');
  if (pErr) throw pErr;

  // Indexa players por team
  const playersByTeam = {};
  for (const p of players) {
    if (!playersByTeam[p.team]) playersByTeam[p.team] = [];
    playersByTeam[p.team].push(p);
  }
  // Ordena: ATA primeiro
  const POS_ORDER = { ATA: 0, MEI: 1, DEF: 2, GOL: 3 };
  for (const team in playersByTeam) {
    playersByTeam[team].sort((a, b) =>
      (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9)
    );
  }

  const rng = mulberry32(hashSeed(SEED));
  const goalCounts = {};  // player_id -> total goals across all matches

  const results = [];

  for (const m of matches) {
    // Pula matches com slot ainda não resolvido (W##, etc.)
    // Esses serão resolvidos automaticamente pelo trigger quando o jogo anterior terminar.
    // Pra gerar resultado, eu PRECISO de team_home/away reais — vou simular a resolucao
    // usando o tournament tree. Pra simplicidade, vou usar slot_home/away pra detectar
    // se ainda eh slot, e nesse caso vou GERAR um "vencedor virtual" e depois resolver.

    // Mas pra E2E, o admin vai lancar resultados na ORDEM dos jogos. Quando chegar no jogo 89,
    // os jogos 73-80 ja vao ter terminado e os slots ja vao estar resolvidos no DB.
    // Aqui no script de geracao, eu nao tenho como saber qual o team_home/away final dos KO.
    // Solucao: gerar resultado APENAS pros matches de grupo agora. KO sera gerado ON-THE-FLY
    // durante o E2E (depois que os times forem resolvidos).

    // Por enquanto, gera pro grupo + um placeholder pros KO
    if (m.stage === 'group') {
      const [h, a] = pickScore(rng, m.stage);
      const scorers = generateScorers(rng, m.team_home, m.team_away, h, a, playersByTeam, goalCounts);
      results.push({
        id: m.id,
        stage: m.stage,
        team_home: m.team_home,
        team_away: m.team_away,
        actual_home: h,
        actual_away: a,
        pen_winner: null,
        scorers,
      });
    } else {
      // KO — placeholder. Vai ser substituido on-the-fly durante o E2E.
      const [h, a] = pickScore(rng, m.stage);
      const penWinner = (h === a) ? (rng() < 0.5 ? 'home' : 'away') : null;
      results.push({
        id: m.id,
        stage: m.stage,
        // team_home/away vao ser resolvidos no momento do E2E
        team_home_slot: m.slot_home,
        team_away_slot: m.slot_away,
        actual_home: h,
        actual_away: a,
        pen_winner: penWinner,
        // scorers serao geradores on-the-fly tambem
        _placeholder: true,
      });
    }
  }

  // Determina top scorer
  const topScorer = Object.entries(goalCounts)
    .sort(([, a], [, b]) => b - a)[0];
  const topScorerPlayer = topScorer ? players.find((p) => p.id === parseInt(topScorer[0], 10)) : null;

  const output = {
    _meta: {
      seed: SEED,
      generated_at: new Date().toISOString(),
      total_matches: matches.length,
      group_matches: results.filter((r) => r.stage === 'group').length,
      ko_matches_placeholder: results.filter((r) => r.stage !== 'group').length,
      note: 'KO matches ficam como placeholder. A resolucao final acontece on-the-fly durante o E2E quando os slots resolvem.',
    },
    matches: results,
    topScorer: topScorerPlayer ? {
      player_id: topScorerPlayer.id,
      full_name: topScorerPlayer.full_name,
      team: topScorerPlayer.team,
      total_goals_group_stage: topScorer[1],
    } : null,
  };

  writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');
  console.log(`✅ Salvo em ${OUTPUT}`);
  console.log(`   ${output._meta.group_matches} grupos gerados, ${output._meta.ko_matches_placeholder} KO como placeholder`);
  if (topScorerPlayer) {
    console.log(`   Top scorer (grupos): ${topScorerPlayer.full_name} (${topScorerPlayer.team}) — ${topScorer[1]} gols`);
  }
}

function generateScorers(rng, homeTeam, awayTeam, homeGoals, awayGoals, playersByTeam, goalCounts) {
  const scorers = [];
  const distributeGoals = (team, goals) => {
    const teamPlayers = playersByTeam[team] ?? [];
    if (teamPlayers.length === 0) return;  // sem players — ignora
    let remaining = goals;
    const used = new Set();
    while (remaining > 0) {
      // Pega um player aleatorio (com viés pra ATA)
      const player = teamPlayers[Math.floor(rng() * Math.min(10, teamPlayers.length))];
      // Quantos gols pra esse player neste jogo? 1-2 com vies pra 1
      const g = Math.min(remaining, rng() < 0.7 ? 1 : 2);
      if (used.has(player.id)) {
        // Adiciona ao mesmo player
        const existing = scorers.find((s) => s.player_id === player.id);
        existing.goals += g;
      } else {
        scorers.push({ player_id: player.id, full_name: player.full_name, team: player.team, goals: g });
        used.add(player.id);
      }
      goalCounts[player.id] = (goalCounts[player.id] ?? 0) + g;
      remaining -= g;
    }
  };
  distributeGoals(homeTeam, homeGoals);
  distributeGoals(awayTeam, awayGoals);
  return scorers;
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});

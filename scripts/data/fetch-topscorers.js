#!/usr/bin/env node
/**
 * Fetch a artilharia oficial da Copa 2026 (API-Football) e grava em
 * src/assets/data/topscorers.json — arquivo estático servido pelo Netlify,
 * consumido pela seção "Corrida da Chuteira de Ouro" (js/scorer-race.js).
 *
 * Endpoint: GET /players/topscorers?league=1&season=2026
 * Não usa Supabase. O `api_id` gravado bate com players.api_player_id, o que
 * permite ao front destacar o artilheiro escolhido por cada palpiteiro.
 *
 * Uso:
 *   node scripts/data/fetch-topscorers.js              # grava o JSON
 *   node scripts/data/fetch-topscorers.js --dry-run    # só imprime, não grava
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const API_KEY = process.env.API_FOOTBALL_KEY || process.env['API-FOOTBALL-KEY'];
const BASE_URL = 'https://v3.football.api-sports.io';
const OUTPUT_PATH = join(__dirname, '..', '..', 'src', 'assets', 'data', 'topscorers.json');
const DRY_RUN = process.argv.includes('--dry-run');

// A API-Football usa grafias próprias pra alguns países que não batem com os
// nomes canônicos do nosso seed/DB (usados em data-team e nos mapas FLAGS/TEAM_PT
// de util.js). Sem normalizar, a bandeira/nome PT não casa. Mapeia API → canônico.
const CANON = {
  'Cape Verde Islands': 'Cape Verde',
  'Congo DR': 'DR Congo',
  'Czechia': 'Czech Republic',
};
const canon = (name) => CANON[name] || name;

async function fetchTopScorers() {
  const res = await fetch(`${BASE_URL}/players/topscorers?league=1&season=2026`, {
    headers: { 'x-apisports-key': API_KEY },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error('API error: ' + JSON.stringify(data.errors));
  }
  return (data.response ?? []).map((p) => {
    const s = p.statistics?.[0] ?? {};
    return {
      api_id: p.player.id,
      name: p.player.name,
      team: canon(s.team?.name ?? ''),
      goals: s.goals?.total ?? 0,
      assists: s.goals?.assists ?? 0,
      minutes: s.games?.minutes ?? null,
    };
  })
  // só quem efetivamente marcou (gating: sem gol, fora da corrida)
  .filter((p) => p.goals > 0)
  // gols desc, depois assist. desc, depois menos minutos (mais eficiente)
  .sort((a, b) => b.goals - a.goals || b.assists - a.assists || (a.minutes ?? 1e9) - (b.minutes ?? 1e9));
}

async function main() {
  if (!API_KEY) {
    console.error('❌ API_FOOTBALL_KEY não encontrada em .env');
    process.exit(1);
  }

  console.log('📡 Buscando artilharia da Copa 2026…');
  const scorers = await fetchTopScorers();

  const payload = {
    updated_at: new Date().toISOString(),
    season: 2026,
    scorers,
  };

  if (DRY_RUN) {
    console.log('(DRY-RUN — não grava)\n');
    for (const s of scorers.slice(0, 15)) {
      console.log(`  ${s.goals}g ${s.assists}a — ${s.name} (${s.team}) api_id=${s.api_id}`);
    }
    console.log(`\n${scorers.length} artilheiro(s).`);
    return;
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`✅ ${scorers.length} artilheiro(s) salvos em ${OUTPUT_PATH}`);
  if (scorers[0]) console.log(`   Líder: ${scorers[0].name} (${scorers[0].goals} gols)`);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});

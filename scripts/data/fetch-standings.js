#!/usr/bin/env node
/**
 * Fetch a classificação AO VIVO dos grupos da Copa 2026 (API-Football) e grava
 * em src/assets/data/standings.json — arquivo estático servido pelo Netlify,
 * consumido pelo Raio-X (bloco "Grupo ao vivo" na aba Eliminatórias).
 *
 * Endpoint: GET /standings?league=1&season=2026
 * Não usa Supabase (estático, igual recent.json / topscorers.json). Antes da 1ª
 * rodada os grupos vêm zerados (played=0) — o front esconde por gating; a partir
 * da rodada 2 a tabela aparece.
 *
 * Uso:
 *   node scripts/data/fetch-standings.js              # grava o JSON
 *   node scripts/data/fetch-standings.js --dry-run    # só imprime, não grava
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const API_KEY = process.env.API_FOOTBALL_KEY || process.env['API-FOOTBALL-KEY'];
const BASE_URL = 'https://v3.football.api-sports.io';
const OUTPUT_PATH = join(__dirname, '..', '..', 'src', 'assets', 'data', 'standings.json');
const DRY_RUN = process.argv.includes('--dry-run');

// API → nome canônico (mesmos casos dos outros scripts; senão FLAGS/TEAM_PT não casam).
const CANON = {
  'Cape Verde Islands': 'Cape Verde',
  'Congo DR': 'DR Congo',
  'Czechia': 'Czech Republic',
};
const canon = (name) => CANON[name] || name;

// "Group A" → "A". Devolve null pra tabelas que não são de grupo (ex.: ranking
// geral de 3ºs colocados, que a API às vezes inclui).
function groupKey(name) {
  const m = /^Group ([A-L])$/.exec(String(name || ''));
  return m ? m[1] : null;
}

async function fetchStandings() {
  const res = await fetch(`${BASE_URL}/standings?league=1&season=2026`, {
    headers: { 'x-apisports-key': API_KEY },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error('API error: ' + JSON.stringify(data.errors));
  }
  const tables = data.response?.[0]?.league?.standings ?? [];
  const groups = {};
  for (const table of tables) {
    const key = groupKey(table[0]?.group);
    if (!key) continue;
    groups[key] = table.map((r) => ({
      rank: r.rank,
      team: canon(r.team?.name ?? ''),
      played: r.all?.played ?? 0,
      win: r.all?.win ?? 0,
      draw: r.all?.draw ?? 0,
      lose: r.all?.lose ?? 0,
      gf: r.all?.goals?.for ?? 0,
      ga: r.all?.goals?.against ?? 0,
      gd: r.goalsDiff ?? 0,
      points: r.points ?? 0,
      form: r.form ?? null,   // "WDL..." (mais recente à direita na API)
    }));
  }
  return groups;
}

async function main() {
  if (!API_KEY) {
    console.error('❌ API_FOOTBALL_KEY não encontrada em .env');
    process.exit(1);
  }

  console.log('📡 Buscando classificação dos grupos da Copa 2026…');
  const groups = await fetchStandings();
  const keys = Object.keys(groups).sort();
  const played = keys.reduce((s, k) => s + groups[k].reduce((t, r) => t + r.played, 0), 0);

  const payload = {
    updated_at: new Date().toISOString(),
    season: 2026,
    groups,
  };

  if (DRY_RUN) {
    console.log('(DRY-RUN — não grava)\n');
    for (const k of keys) {
      console.log(`Grupo ${k}:`);
      for (const r of groups[k]) {
        console.log(`  ${r.rank}. ${r.team} ${r.points}pts ${r.played}J SG${r.gd} form=${r.form}`);
      }
    }
    console.log(`\n${keys.length} grupo(s), ${played} jogo(s) computado(s).`);
    return;
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`✅ ${keys.length} grupo(s) salvos em ${OUTPUT_PATH} (${played} jogo(s) já computado(s))`);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});

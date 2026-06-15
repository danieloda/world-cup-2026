// Probe READ-ONLY da API-Football: o que já existe AGORA (torneio em andamento)?
// Checa standings, artilheiros e se /predictions destravou. NÃO escreve nada.
// Uso: node scripts/probes/probe-live-data.mjs
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const API_KEY = process.env.API_FOOTBALL_KEY || process.env['API-FOOTBALL-KEY'];
const BASE = 'https://v3.football.api-sports.io';
if (!API_KEY) throw new Error('API_FOOTBALL_KEY ausente no .env');

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-apisports-key': API_KEY } });
  const json = await res.json();
  return { status: res.status, json };
};

// 1) Standings reais da Copa
{
  const { status, json } = await get('/standings?league=1&season=2026');
  console.log(`\n=== /standings?league=1&season=2026 (HTTP ${status}) ===`);
  console.log('results:', json.results, 'errors:', JSON.stringify(json.errors));
  const groups = json.response?.[0]?.league?.standings ?? [];
  console.log('grupos retornados:', groups.length);
  if (groups[0]) {
    console.log('exemplo (grupo 1):');
    for (const row of groups[0]) {
      console.log(`  ${row.rank}. ${row.team.name} — ${row.points}pts ${row.all.played}J ` +
        `${row.all.win}V ${row.all.draw}E ${row.all.lose}D SG ${row.goalsDiff} | form ${row.form ?? '—'}`);
    }
  }
}

// 2) Artilheiros
{
  const { status, json } = await get('/players/topscorers?league=1&season=2026');
  console.log(`\n=== /players/topscorers?league=1&season=2026 (HTTP ${status}) ===`);
  console.log('results:', json.results, 'errors:', JSON.stringify(json.errors));
  for (const p of (json.response ?? []).slice(0, 10)) {
    const s = p.statistics?.[0] ?? {};
    console.log(`  ${s.goals?.total ?? 0}g ${s.goals?.assists ?? 0}a — ${p.player.name} ` +
      `(${s.team?.name}) api_id=${p.player.id}`);
  }
}

// 3) Predictions destravou? Pega um fixture JÁ JOGADO do fixtures.json
{
  const fx = JSON.parse(readFileSync(join(__dirname, '..', '..', 'src', 'assets', 'data', 'fixtures.json'), 'utf-8'));
  const played = (fx.fixtures || fx).filter(f => f.status === 'FT' || f.status === 'AET' || f.status === 'PEN');
  const upcoming = (fx.fixtures || fx).filter(f => f.status === 'NS');
  console.log(`\n=== fixtures.json: ${played.length} jogados (FT), ${upcoming.length} agendados (NS) ===`);
  const target = upcoming[0] || (fx.fixtures || fx)[0];
  if (target) {
    const { status, json } = await get(`/predictions?fixture=${target.id}`);
    const r = json.response?.[0];
    console.log(`/predictions?fixture=${target.id} (${target.homeTeam.name} x ${target.awayTeam.name}) HTTP ${status}`);
    console.log('  advice:', r?.predictions?.advice);
    console.log('  percent:', JSON.stringify(r?.predictions?.percent));
    console.log('  home.last_5:', JSON.stringify(r?.teams?.home?.last_5));
    console.log('  away.last_5:', JSON.stringify(r?.teams?.away?.last_5));
  }
}

console.log('\n(probe read-only — nada gravado)');

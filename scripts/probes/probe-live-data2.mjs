// Probe READ-ONLY #2: explora endpoints de DETALHE p/ achar features.
// Pega IDs reais via /fixtures (o fixtures.json local está defasado), depois
// testa events/lineups/statistics/players, assists, lesões e odds. NÃO escreve.
// Uso: node scripts/probes/probe-live-data2.mjs
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const API_KEY = process.env.API_FOOTBALL_KEY || process.env['API-FOOTBALL-KEY'];
const BASE = 'https://v3.football.api-sports.io';
if (!API_KEY) throw new Error('API_FOOTBALL_KEY ausente no .env');

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-apisports-key': API_KEY } });
  return { status: res.status, json: await res.json() };
};
const hr = (t) => console.log(`\n=== ${t} ===`);

// 0) Lista de jogos da Copa (ao vivo) — acha 1 finalizado e 1 futuro
let finished = null, upcoming = null;
{
  const { status, json } = await get('/fixtures?league=1&season=2026');
  hr(`/fixtures?league=1&season=2026 (HTTP ${status}) — ${json.results} jogos`);
  const byStatus = {};
  for (const f of json.response) {
    const s = f.fixture.status.short;
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  console.log('por status:', JSON.stringify(byStatus));
  finished = json.response.find(f => ['FT', 'AET', 'PEN'].includes(f.fixture.status.short));
  upcoming = json.response.find(f => f.fixture.status.short === 'NS');
  if (finished) {
    const g = finished.goals;
    console.log(`finalizado: #${finished.fixture.id} ${finished.teams.home.name} ${g.home}-${g.away} ${finished.teams.away.name}`);
  }
  if (upcoming) {
    console.log(`futuro:     #${upcoming.fixture.id} ${upcoming.teams.home.name} x ${upcoming.teams.away.name} (${upcoming.fixture.date})`);
  }
}

// 1) Eventos do jogo finalizado (gols, cartões, subs)
if (finished) {
  const { status, json } = await get(`/fixtures/events?fixture=${finished.fixture.id}`);
  hr(`/fixtures/events?fixture=${finished.fixture.id} (HTTP ${status}) — ${json.results} eventos`);
  for (const e of (json.response ?? []).slice(0, 8)) {
    console.log(`  ${e.time.elapsed}' ${e.type}/${e.detail} — ${e.player?.name} (${e.team?.name})`);
  }
}

// 2) Escalações
if (finished) {
  const { status, json } = await get(`/fixtures/lineups?fixture=${finished.fixture.id}`);
  hr(`/fixtures/lineups?fixture=${finished.fixture.id} (HTTP ${status}) — ${json.results} times`);
  const t = json.response?.[0];
  if (t) console.log(`  ${t.team.name}: formação ${t.formation}, ${t.startXI?.length} titulares, coach ${t.coach?.name}`);
}

// 3) Estatísticas do jogo (posse, finalizações…)
if (finished) {
  const { status, json } = await get(`/fixtures/statistics?fixture=${finished.fixture.id}`);
  hr(`/fixtures/statistics?fixture=${finished.fixture.id} (HTTP ${status}) — ${json.results} times`);
  const t = json.response?.[0];
  if (t) {
    console.log(`  ${t.team.name}:`);
    for (const s of (t.statistics ?? []).slice(0, 8)) console.log(`    ${s.type}: ${s.value}`);
  }
}

// 4) Player ratings do jogo
if (finished) {
  const { status, json } = await get(`/fixtures/players?fixture=${finished.fixture.id}`);
  hr(`/fixtures/players?fixture=${finished.fixture.id} (HTTP ${status}) — ${json.results} times`);
  const t = json.response?.[0];
  const top = (t?.players ?? []).map(p => ({ name: p.player.name, rating: p.statistics?.[0]?.games?.rating }))
    .filter(p => p.rating).sort((a, b) => b.rating - a.rating).slice(0, 3);
  for (const p of top) console.log(`  nota ${p.rating} — ${p.name}`);
}

// 5) Top assistências
{
  const { status, json } = await get('/players/topassists?league=1&season=2026');
  hr(`/players/topassists?league=1&season=2026 (HTTP ${status}) — ${json.results}`);
  for (const p of (json.response ?? []).slice(0, 5)) {
    const s = p.statistics?.[0] ?? {};
    console.log(`  ${s.goals?.assists ?? 0}a ${s.goals?.total ?? 0}g — ${p.player.name} (${s.team?.name})`);
  }
}

// 6) Lesões/suspensões da Copa
{
  const { status, json } = await get('/injuries?league=1&season=2026');
  hr(`/injuries?league=1&season=2026 (HTTP ${status}) — ${json.results}`);
  for (const i of (json.response ?? []).slice(0, 6)) {
    console.log(`  ${i.player?.name} (${i.team?.name}) — ${i.player?.type}: ${i.player?.reason}`);
  }
}

// 7) Odds p/ um jogo futuro (memória dizia que não vinham p/ a Copa)
if (upcoming) {
  const { status, json } = await get(`/odds?fixture=${upcoming.fixture.id}&bet=1`);
  hr(`/odds?fixture=${upcoming.fixture.id}&bet=1 (HTTP ${status}) — results ${json.results}`);
  const bm = json.response?.[0]?.bookmakers ?? [];
  console.log(`  bookmakers: ${bm.length}${bm.length ? ' — ex.: ' + bm.slice(0,3).map(b => b.name).join(', ') : ''}`);
}

// 8) Predictions p/ um jogo FUTURO (não jogado) — destravou?
if (upcoming) {
  const { status, json } = await get(`/predictions?fixture=${upcoming.fixture.id}`);
  const r = json.response?.[0];
  hr(`/predictions?fixture=${upcoming.fixture.id} FUTURO (HTTP ${status})`);
  console.log(`  ${upcoming.teams.home.name} x ${upcoming.teams.away.name}`);
  console.log('  advice:', r?.predictions?.advice, '| percent:', JSON.stringify(r?.predictions?.percent));
  console.log('  home.last_5:', JSON.stringify(r?.teams?.home?.last_5?.form), 'att', r?.teams?.home?.last_5?.att);
}

console.log('\n(probe read-only — nada gravado)');

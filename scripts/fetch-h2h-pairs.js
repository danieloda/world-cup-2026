#!/usr/bin/env node
/**
 * Popula public.team_h2h com o confronto direto (últimos 5 jogos) entre cada
 * PAR de seleções do Mundial 2026. Usado pelo Raio-X do mata-mata, onde os
 * times são resolvidos dinamicamente (não dá pra keyar por match_id).
 *
 * Fonte: GET /fixtures/headtohead?h2h={idA-idB}&last=5 (API-Football)
 *
 * Par canônico: team_a < team_b (ordem alfabética por nome no DB). O summary é
 * agregado na ótica de team_a; o front reorienta para o mandante do confronto.
 *
 * Custo: 48C2 = 1128 pares. É um seed factual (muda devagar) — idempotente,
 * com cache (--max-age dias). Rode em partes se quiser (Ctrl-C e retome).
 *
 * Usage:
 *   node scripts/fetch-h2h-pairs.js                 # respeita cache (30 dias)
 *   node scripts/fetch-h2h-pairs.js --force         # refaz tudo
 *   node scripts/fetch-h2h-pairs.js --max-age 7     # cache de 7 dias
 *   node scripts/fetch-h2h-pairs.js --limit 100     # só os 100 primeiros pares novos
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const API_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE = 'https://v3.football.api-sports.io';
const LEAGUE = 1, SEASON = 2026;

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const MAX_AGE_DAYS = Number(argIdx('--max-age') ?? 30);
const LIMIT = argIdx('--limit') ? Number(argIdx('--limit')) : Infinity;

function argIdx(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
function assert(c, m) { if (!c) { console.error('ERRO:', m); process.exit(1); } }
assert(API_KEY, 'API_FOOTBALL_KEY ausente em .env');
assert(SUPABASE_URL, 'SUPABASE_URL ausente em .env');
assert(SERVICE_KEY, 'SUPABASE_SERVICE_ROLE_KEY ausente em .env');

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const DB_NAME_FROM_API = {
  'Cape Verde Islands': 'Cape Verde',
  'Congo DR':           'DR Congo',
};
const dbName = (apiName) => DB_NAME_FROM_API[apiName] ?? apiName;

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`API HTTP ${res.status} para ${path}`);
  return res.json();
}

async function fetchTeams() {
  const d = await apiGet(`/teams?league=${LEAGUE}&season=${SEASON}`);
  return d.response.map(t => ({ apiId: t.team.id, name: dbName(t.team.name) }));
}

function compact(fixtures) {
  return fixtures
    .map(f => ({
      date: f.fixture.date?.slice(0, 10) ?? null,
      home: f.teams.home.name,
      away: f.teams.away.name,
      home_goals: f.goals.home,
      away_goals: f.goals.away,
      competition: f.league?.name ?? null,
    }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// Summary na ótica de team_a (apiIdA): home_wins = vitórias de team_a.
function summarize(fixtures, apiIdA) {
  let aWins = 0, draws = 0, bWins = 0;
  for (const f of fixtures) {
    const gh = f.goals.home, ga = f.goals.away;
    if (gh == null || ga == null) continue;
    const aIsHome = f.teams.home.id === apiIdA;
    const aGoals = aIsHome ? gh : ga;
    const bGoals = aIsHome ? ga : gh;
    if (aGoals > bGoals) aWins++;
    else if (aGoals < bGoals) bWins++;
    else draws++;
  }
  return { home_wins: aWins, draws, away_wins: bWins, total: fixtures.length };
}

async function main() {
  console.log(`team_h2h — cache ${MAX_AGE_DAYS}d, force=${FORCE}\n`);
  const teams = await fetchTeams();
  teams.sort((x, y) => x.name.localeCompare(y.name));
  console.log(`${teams.length} seleções → ${teams.length * (teams.length - 1) / 2} pares\n`);

  // Cache atual
  const { data: existing } = await admin.from('team_h2h').select('team_a, team_b, fetched_at');
  const cache = new Map((existing || []).map(r => [`${r.team_a}|${r.team_b}`, r.fetched_at]));
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400 * 1000;

  let fetched = 0, skipped = 0, failed = 0, done = 0;

  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      if (fetched >= LIMIT) { console.log(`\nLimite de ${LIMIT} atingido.`); return report(); }
      // canônico: a < b
      const [A, B] = teams[i].name < teams[j].name ? [teams[i], teams[j]] : [teams[j], teams[i]];
      const key = `${A.name}|${B.name}`;
      const cached = cache.get(key);
      if (!FORCE && cached && new Date(cached).getTime() > cutoff) { skipped++; continue; }

      done++;
      process.stdout.write(`[${String(done).padStart(4)}] ${A.name.padEnd(20)} x ${B.name.padEnd(20)} `);
      try {
        const d = await apiGet(`/fixtures/headtohead?h2h=${A.apiId}-${B.apiId}&last=5`);
        const raw = d.response ?? [];
        const fixtures = compact(raw);
        const summary = summarize(raw, A.apiId);
        const { error } = await admin.from('team_h2h').upsert({
          team_a: A.name, team_b: B.name,
          fixtures, summary,
          api_team_a: A.apiId, api_team_b: B.apiId,
          fetched_at: new Date().toISOString(),
        });
        if (error) throw error;
        console.log(`✓ ${fixtures.length}  (${summary.home_wins}-${summary.draws}-${summary.away_wins})`);
        fetched++;
      } catch (e) {
        console.log(`✗ ${e.message}`);
        failed++;
      }
      await new Promise(r => setTimeout(r, 700));
    }
  }

  function report() {
    console.log(`\nDone. fetched=${fetched}, skipped(cache)=${skipped}, failed=${failed}`);
  }
  report();
}

main().catch(e => { console.error(e); process.exit(1); });

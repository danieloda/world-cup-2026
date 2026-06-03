#!/usr/bin/env node
/**
 * Popula public.match_h2h com os últimos 5 confrontos diretos entre as
 * seleções de cada partida do bolão.
 *
 * Fonte: GET /fixtures/headtohead?h2h={A-B}&last=5 (API-Football)
 *
 * Pré-requisitos:
 *   - matches.api_fixture_id populado (scripts/fetch-odds.js já faz isso)
 *   - assets/data/fixtures.json atualizado (tem os ids dos times)
 *   - migration 027 aplicada
 *
 * Custo: ~72 calls (fase de grupos). Idempotente — só re-busca quando
 * o cache em match_h2h tem mais de N dias (--max-age, default 7).
 *
 * Usage:
 *   node scripts/fetch-h2h.js                  # respeita cache (7 dias)
 *   node scripts/fetch-h2h.js --force          # refaz tudo
 *   node scripts/fetch-h2h.js --max-age 1      # cache de 1 dia
 *   node scripts/fetch-h2h.js --stage group    # filtra (default: todos)
 */

import { readFileSync } from 'fs';
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
const FIXTURES_PATH = join(__dirname, '..', 'assets', 'data', 'fixtures.json');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const STAGE = argIdx('--stage');
const MAX_AGE_DAYS = Number(argIdx('--max-age') ?? 7);

function argIdx(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
function assert(cond, msg) { if (!cond) { console.error('ERRO:', msg); process.exit(1); } }
assert(API_KEY, 'API_FOOTBALL_KEY ausente em .env');
assert(SUPABASE_URL, 'SUPABASE_URL ausente em .env');
assert(SERVICE_KEY, 'SUPABASE_SERVICE_ROLE_KEY ausente em .env');

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function fetchH2H(apiHomeId, apiAwayId) {
  const url = `${API_BASE}/fixtures/headtohead?h2h=${apiHomeId}-${apiAwayId}&last=5`;
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const data = await res.json();
  return data.response ?? [];
}

function summarize(fixtures, apiHomeId) {
  let homeWins = 0, draws = 0, awayWins = 0;
  for (const f of fixtures) {
    const gh = f.goals.home, ga = f.goals.away;
    if (gh == null || ga == null) continue;
    const homeIsThisHome = f.teams.home.id === apiHomeId;
    const thisHomeGoals = homeIsThisHome ? gh : ga;
    const thisAwayGoals = homeIsThisHome ? ga : gh;
    if (thisHomeGoals > thisAwayGoals) homeWins++;
    else if (thisHomeGoals < thisAwayGoals) awayWins++;
    else draws++;
  }
  return { home_wins: homeWins, draws, away_wins: awayWins, total: fixtures.length };
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

async function main() {
  const fixturesJson = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));
  const apiFixtures = fixturesJson.fixtures;
  const apiById = new Map(apiFixtures.map(f => [f.id, f]));

  let q = admin.from('matches')
    .select('id, team_home, team_away, api_fixture_id, stage')
    .not('api_fixture_id', 'is', null)
    .order('match_date');
  if (STAGE) q = q.eq('stage', STAGE);
  const { data: matches, error } = await q;
  if (error) throw error;

  // Cache lookup
  const { data: existing } = await admin
    .from('match_h2h').select('match_id, fetched_at');
  const cacheMap = new Map((existing || []).map(r => [r.match_id, r.fetched_at]));
  const cutoffMs = Date.now() - MAX_AGE_DAYS * 86400 * 1000;

  console.log(`H2H para ${matches.length} jogo(s) — cache: ${MAX_AGE_DAYS}d, force=${FORCE}\n`);
  let fetched = 0, skipped = 0, failed = 0;

  for (const m of matches) {
    const apiF = apiById.get(m.api_fixture_id);
    if (!apiF) { console.log(`  [skip] #${m.id} sem fixture na JSON local`); failed++; continue; }
    const apiHomeId = apiF.homeTeam.id, apiAwayId = apiF.awayTeam.id;

    const cached = cacheMap.get(m.id);
    if (!FORCE && cached && new Date(cached).getTime() > cutoffMs) {
      skipped++;
      continue;
    }

    process.stdout.write(`[${String(fetched + skipped + failed + 1).padStart(2)}/${matches.length}] ${m.team_home.padEnd(18)} x ${m.team_away.padEnd(18)} `);
    try {
      const raw = await fetchH2H(apiHomeId, apiAwayId);
      const fixtures = compact(raw);
      const summary = summarize(raw, apiHomeId);

      const { error: upErr } = await admin.from('match_h2h').upsert({
        match_id: m.id,
        fixtures,
        summary,
        api_team_home: apiHomeId,
        api_team_away: apiAwayId,
        fetched_at: new Date().toISOString(),
      });
      if (upErr) throw upErr;
      console.log(`✓ ${fixtures.length} confronto(s)  (${summary.home_wins}V-${summary.draws}E-${summary.away_wins}D)`);
      fetched++;
    } catch (e) {
      console.log(`✗ ${e.message}`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 700));
  }

  console.log(`\nDone. fetched=${fetched}, skipped(cache)=${skipped}, failed=${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });

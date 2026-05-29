#!/usr/bin/env node
/**
 * Fetch pre-match "Match Winner" (1X2) odds from API-Football (Betano)
 * para todas as partidas de fase de grupos do Bolão Copa 2026.
 *
 * Etapas:
 *   1) Garante que public.matches.api_fixture_id está populado (linkage com
 *      o id da API-Football) — busca por (team_home, team_away) em fixtures.json.
 *   2) Para cada jogo ainda não terminado e com api_fixture_id, chama
 *      GET /odds?fixture={id}&bet=1&bookmaker=32 e faz upsert em match_odds.
 *
 * Idempotente — pode rodar quantas vezes quiser. Custo: ~72 requests (fase de
 * grupos) → bem abaixo do limite de 7500/dia do plano Pro.
 *
 * Usage: node scripts/fetch-odds.js
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
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

const BOOKMAKER_ID = 32;       // Betano
const BOOKMAKER_NAME = 'Betano';
const BET_ID = 1;              // Match Winner (1X2)

function assert(cond, msg) {
  if (!cond) { console.error('ERRO:', msg); process.exit(1); }
}

assert(API_KEY, 'API_FOOTBALL_KEY ausente em .env');
assert(SUPABASE_URL, 'SUPABASE_URL ausente em .env');
assert(SERVICE_KEY, 'SUPABASE_SERVICE_ROLE_KEY ausente em .env');

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// ------------------------------------------------------------
// 1) Populate api_fixture_id
// ------------------------------------------------------------
// Map DB team name -> nome usado pela API-Football quando diferem.
const TEAM_ALIAS = {
  'Cape Verde': 'Cape Verde Islands',
  'DR Congo':   'Congo DR',
};
const apiName = (n) => TEAM_ALIAS[n] ?? n;

async function linkFixtureIds() {
  const fixturesJson = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));
  const apiFixtures = fixturesJson.fixtures;

  const { data: matches, error } = await admin
    .from('matches')
    .select('id, team_home, team_away, match_date, api_fixture_id, stage')
    .eq('stage', 'group')
    .order('match_date');

  if (error) throw error;

  let linked = 0, alreadyLinked = 0, notFound = 0;

  for (const m of matches) {
    if (m.api_fixture_id) { alreadyLinked++; continue; }

    const home = apiName(m.team_home);
    const away = apiName(m.team_away);
    const f = apiFixtures.find(
      x => x.homeTeam.name === home && x.awayTeam.name === away
    );
    if (!f) {
      console.warn(`  [skip] match #${m.id} ${m.team_home} x ${m.team_away} — sem fixture na API`);
      notFound++;
      continue;
    }
    const { error: updErr } = await admin
      .from('matches')
      .update({ api_fixture_id: f.id })
      .eq('id', m.id);
    if (updErr) throw updErr;
    linked++;
  }

  console.log(`Linkage: ${linked} novo(s), ${alreadyLinked} já linkado(s), ${notFound} não encontrado(s)`);
}

// ------------------------------------------------------------
// 2) Fetch odds e upsert em match_odds
// ------------------------------------------------------------
async function fetchFixtureOdds(apiFixtureId) {
  const url = `${API_BASE}/odds?fixture=${apiFixtureId}&bet=${BET_ID}&bookmaker=${BOOKMAKER_ID}`;
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`API HTTP ${res.status} para fixture ${apiFixtureId}`);
  const data = await res.json();

  if (data.results === 0) return null;

  // Resposta: response[0].bookmakers[0].bets[0].values[]
  const entry = data.response[0];
  const bm = entry?.bookmakers?.find(b => b.id === BOOKMAKER_ID) ?? entry?.bookmakers?.[0];
  const bet = bm?.bets?.find(b => b.id === BET_ID);
  const values = bet?.values ?? [];

  const pick = (label) => {
    const v = values.find(x => x.value === label);
    return v ? Number(v.odd) : null;
  };

  const odd_home = pick('Home');
  const odd_draw = pick('Draw');
  const odd_away = pick('Away');

  if (odd_home == null || odd_draw == null || odd_away == null) return null;

  return {
    odd_home, odd_draw, odd_away,
    bookmaker_id: bm.id,
    bookmaker_name: bm.name,
    api_updated_at: entry.update ?? null,
  };
}

async function fetchAllOdds() {
  const { data: matches, error } = await admin
    .from('matches')
    .select('id, team_home, team_away, api_fixture_id, finished')
    .eq('stage', 'group')
    .not('api_fixture_id', 'is', null)
    .eq('finished', false)
    .order('match_date');

  if (error) throw error;

  console.log(`\nBuscando odds (Betano · 1X2) para ${matches.length} partida(s)…`);

  let ok = 0, missing = 0;
  for (const m of matches) {
    try {
      const odds = await fetchFixtureOdds(m.api_fixture_id);
      if (!odds) {
        console.log(`  [no-odds] #${m.id} ${m.team_home} x ${m.team_away} (fixture ${m.api_fixture_id})`);
        missing++;
        continue;
      }
      const { error: upErr } = await admin
        .from('match_odds')
        .upsert({
          match_id: m.id,
          odd_home: odds.odd_home,
          odd_draw: odds.odd_draw,
          odd_away: odds.odd_away,
          bookmaker_id: odds.bookmaker_id,
          bookmaker_name: odds.bookmaker_name,
          api_updated_at: odds.api_updated_at,
          fetched_at: new Date().toISOString(),
        }, { onConflict: 'match_id' });
      if (upErr) throw upErr;

      console.log(`  [ok] #${m.id} ${m.team_home} ${odds.odd_home} · ${odds.odd_draw} · ${odds.odd_away} ${m.team_away}`);
      ok++;
    } catch (e) {
      console.error(`  [erro] #${m.id}:`, e.message);
    }
  }

  console.log(`\nResumo: ${ok} com odds · ${missing} sem odds disponíveis ainda`);
}

async function main() {
  console.log('=== Bolão Copa 2026 · fetch-odds ===');
  await linkFixtureIds();
  await fetchAllOdds();
}

main().catch(err => { console.error(err); process.exit(1); });

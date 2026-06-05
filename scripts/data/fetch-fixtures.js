#!/usr/bin/env node
/**
 * Fetch all World Cup 2026 fixtures from API-Football
 * Usage: node scripts/fetch-fixtures.js
 * Output: src/assets/data/fixtures.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const API_KEY = process.env.API_FOOTBALL_KEY || process.env['API-FOOTBALL-KEY'];
const BASE_URL = 'https://v3.football.api-sports.io';
const OUTPUT_PATH = join(__dirname, '..', '..', 'src', 'assets', 'data', 'fixtures.json');

async function fetchFixtures() {
  const res = await fetch(`${BASE_URL}/fixtures?league=1&season=2026`, {
    headers: { 'x-apisports-key': API_KEY }
  });
  const data = await res.json();

  return data.response.map(f => ({
    id: f.fixture.id,
    date: f.fixture.date,
    venue: f.fixture.venue?.name || null,
    city: f.fixture.venue?.city || null,
    round: f.league.round,
    status: f.fixture.status.short,
    homeTeam: {
      id: f.teams.home.id,
      name: f.teams.home.name,
      logo: f.teams.home.logo,
    },
    awayTeam: {
      id: f.teams.away.id,
      name: f.teams.away.name,
      logo: f.teams.away.logo,
    },
    score: {
      home: f.goals.home,
      away: f.goals.away,
      halftime: f.score.halftime,
      fulltime: f.score.fulltime,
      extratime: f.score.extratime,
      penalty: f.score.penalty,
    },
  }));
}

async function main() {
  if (!API_KEY) {
    console.error('Error: API_FOOTBALL_KEY not found in .env');
    process.exit(1);
  }

  console.log('Fetching World Cup 2026 fixtures...');
  const fixtures = await fetchFixtures();

  // Group by round
  const byRound = fixtures.reduce((acc, f) => {
    const round = f.round;
    if (!acc[round]) acc[round] = [];
    acc[round].push(f);
    return acc;
  }, {});

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify({ fixtures, byRound }, null, 2), 'utf-8');

  console.log(`✓ Done! ${fixtures.length} fixtures`);
  console.log(`Rounds: ${Object.keys(byRound).join(', ')}`);
  console.log(`Output: ${OUTPUT_PATH}`);
}

main().catch(console.error);

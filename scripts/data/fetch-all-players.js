#!/usr/bin/env node
/**
 * Fetch all 48 World Cup 2026 team squads from API-Football
 * Usage: node scripts/fetch-all-players.js
 * Output: assets/data/squads.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const API_KEY = process.env.API_FOOTBALL_KEY || process.env['API-FOOTBALL-KEY'];
const BASE_URL = 'https://v3.football.api-sports.io';
const OUTPUT_PATH = join(__dirname, '..', 'assets', 'data', 'squads.json');

const POSITION_MAP = {
  'Goalkeeper': 'GOL',
  'Defender': 'DEF',
  'Midfielder': 'MEI',
  'Attacker': 'ATA',
};

async function fetchTeams() {
  const res = await fetch(`${BASE_URL}/teams?league=1&season=2026`, {
    headers: { 'x-apisports-key': API_KEY }
  });
  const data = await res.json();
  return data.response.map(t => ({ id: t.team.id, name: t.team.name, logo: t.team.logo }));
}

async function fetchSquad(teamId) {
  const res = await fetch(`${BASE_URL}/players/squads?team=${teamId}`, {
    headers: { 'x-apisports-key': API_KEY }
  });
  const data = await res.json();
  if (!data.response || data.response.length === 0) return [];

  return data.response[0].players.map(p => ({
    id: p.id,
    name: p.name,
    age: p.age,
    number: p.number,
    position: POSITION_MAP[p.position] || p.position,
    photo: p.photo,
  }));
}

async function main() {
  if (!API_KEY) {
    console.error('Error: API_FOOTBALL_KEY not found in .env');
    process.exit(1);
  }

  console.log('Fetching World Cup 2026 teams...');
  const teams = await fetchTeams();
  console.log(`Found ${teams.length} teams\n`);

  const squads = {};

  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    process.stdout.write(`[${String(i + 1).padStart(2)}/${teams.length}] ${team.name.padEnd(25)}`);

    const players = await fetchSquad(team.id);
    squads[team.name] = {
      id: team.id,
      logo: team.logo,
      players: players
    };

    console.log(`✓ ${players.length} players`);

    // Rate limiting (100 requests/minute on Pro)
    if (i < teams.length - 1) {
      await new Promise(r => setTimeout(r, 700));
    }
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(squads, null, 2), 'utf-8');

  const totalPlayers = Object.values(squads).reduce((sum, t) => sum + t.players.length, 0);
  console.log(`\n✓ Done! ${teams.length} teams, ${totalPlayers} total players`);
  console.log(`Output: ${OUTPUT_PATH}`);
}

main().catch(console.error);

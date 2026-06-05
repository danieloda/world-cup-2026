#!/usr/bin/env node
/**
 * Generate SQL INSERT statements for players
 * Usage: node scripts/generate-players-sql.js
 * Output: supabase/seed/players_full.sql
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const squadsPath = join(__dirname, '..', '..', 'src', 'assets', 'data', 'squads.json');
const outputPath = join(__dirname, '..', '..', 'supabase', 'seed', 'players_full.sql');

// Map API-Football team names to our database team names
const TEAM_NAME_MAP = {
  'Türkiye': 'Turkey',
  'USA': 'United States',
  'Cape Verde Islands': 'Cape Verde',
  'Congo DR': 'DR Congo',
};

function escapeSql(str) {
  if (!str) return 'NULL';
  return `'${str.replace(/'/g, "''")}'`;
}

async function main() {
  console.log('Reading squads.json...');
  const squads = JSON.parse(readFileSync(squadsPath, 'utf-8'));

  let sql = `-- ============================================================
-- SBC 2026 — Full player list from API-Football
-- ============================================================
-- Generated: ${new Date().toISOString()}
-- Run this in Supabase SQL Editor

-- Clear existing players
TRUNCATE public.players RESTART IDENTITY CASCADE;

-- Insert all players
INSERT INTO public.players (full_name, team, position, shirt_number) VALUES
`;

  const values = [];
  const seen = new Set();
  let duplicates = 0;

  for (const [teamName, teamData] of Object.entries(squads)) {
    const dbTeamName = TEAM_NAME_MAP[teamName] || teamName;
    for (const player of teamData.players) {
      const key = `${player.name}|${dbTeamName}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);

      const name = escapeSql(player.name);
      const team = escapeSql(dbTeamName);
      const position = player.position ? escapeSql(player.position) : 'NULL';
      const number = player.number || 'NULL';
      values.push(`  (${name}, ${team}, ${position}, ${number})`);
    }
  }

  console.log(`Skipped ${duplicates} duplicates`);

  sql += values.join(',\n') + ';\n\n';
  sql += `-- Verify count\nSELECT COUNT(*) as total_players FROM public.players;\n`;
  sql += `SELECT team, COUNT(*) as players FROM public.players GROUP BY team ORDER BY team;\n`;

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, sql, 'utf-8');

  console.log(`\n✓ Generated ${values.length} player inserts`);
  console.log(`Output: ${outputPath}`);
  console.log('\nRun this SQL in Supabase Dashboard → SQL Editor');
}

main().catch(console.error);

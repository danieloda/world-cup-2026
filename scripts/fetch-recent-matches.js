#!/usr/bin/env node
/**
 * Fetch last 10 matches of each team from API-Football.
 * Output: assets/data/recent.json
 *
 * Formato (compatível com a UI atual):
 *   { "TeamName": [ [date, opponent, isHome, score, competition], ... ] }
 *
 * Uso:
 *   node scripts/fetch-recent-matches.js                 # todos os 48
 *   node scripts/fetch-recent-matches.js --team=Brazil   # só um time
 *   node scripts/fetch-recent-matches.js --dry-run       # sem chamar API
 *   node scripts/fetch-recent-matches.js --merge         # mantém existentes, só atualiza vazios
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const API_KEY = process.env.API_FOOTBALL_KEY || process.env['API-FOOTBALL-KEY'];
const BASE_URL = 'https://v3.football.api-sports.io';
const OUTPUT_PATH = join(__dirname, '..', 'assets', 'data', 'recent.json');
const FIXTURES_PATH = join(__dirname, '..', 'assets', 'data', 'fixtures.json');

const ONLY_TEAM = args.team || null;
const DRY_RUN = args['dry-run'] === true;
const MERGE = args.merge === true;
const LIMIT = parseInt(args.last || '10', 10);

// Rate limit: API-Football free plan = 10 req/min, paid = 30/min ou mais.
// Vou pausar 6s entre requests pra ficar safe no free plan.
const REQ_DELAY_MS = 6000;

// ============================================================
// Helpers
// ============================================================
function buildTeamMap() {
  const fx = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'));
  const fixtures = fx.fixtures || fx;
  const map = {};
  for (const f of fixtures) {
    if (f.homeTeam?.id && f.homeTeam?.name) map[f.homeTeam.name] = f.homeTeam.id;
    if (f.awayTeam?.id && f.awayTeam?.name) map[f.awayTeam.name] = f.awayTeam.id;
  }
  return map;
}

function loadExisting() {
  try {
    return JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function fetchTeamMatches(teamId, teamName) {
  const url = `${BASE_URL}/fixtures?team=${teamId}&last=${LIMIT}`;
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error('API error: ' + JSON.stringify(data.errors));
  }
  return data.response ?? [];
}

/**
 * Converte fixture da API pra tupla [date, opponent, isHome, score, competition].
 * teamName é o nome canonico nosso (Brazil, France, etc).
 */
function toTuple(fixture, teamName, teamId) {
  const date = (fixture.fixture.date || '').slice(0, 10); // YYYY-MM-DD
  const isHome = fixture.teams.home.id === teamId;
  const opponent = isHome ? fixture.teams.away.name : fixture.teams.home.name;
  const homeGoals = fixture.goals.home;
  const awayGoals = fixture.goals.away;

  // Score sempre na perspectiva TEAM-X-OPPONENT
  const myGoals = isHome ? homeGoals : awayGoals;
  const theirGoals = isHome ? awayGoals : homeGoals;
  const score = (myGoals !== null && theirGoals !== null) ? `${myGoals}-${theirGoals}` : null;

  // Competition: traduz alguns comuns pra PT-BR
  const leagueName = fixture.league.name || '';
  const compMap = {
    'Friendlies': 'Amistoso',
    'World Cup - Qualification Africa': 'Eliminatórias',
    'World Cup - Qualification Asia': 'Eliminatórias',
    'World Cup - Qualification CONCACAF': 'Eliminatórias',
    'World Cup - Qualification CONMEBOL': 'Eliminatórias',
    'World Cup - Qualification Europe': 'Eliminatórias',
    'World Cup - Qualification Intercontinental Play-offs': 'Repescagem',
    'UEFA Nations League': 'Nations League',
    'UEFA Euro Championship': 'Eurocopa',
    'UEFA Euro Championship - Qualification': 'Eliminatórias Eurocopa',
    'Copa America': 'Copa América',
    'Africa Cup of Nations': 'Copa Africana',
    'CONCACAF Gold Cup': 'Copa Ouro',
    'AFC Asian Cup': 'Copa Asiática',
  };
  const competition = compMap[leagueName] || leagueName;

  return [date, opponent, isHome, score, competition];
}

// ============================================================
// Main
// ============================================================
async function main() {
  if (!API_KEY) {
    console.error('❌ API_FOOTBALL_KEY não encontrada em .env');
    process.exit(1);
  }

  const teamMap = buildTeamMap();
  const existing = loadExisting();

  // Lista de teams a processar
  let teamsToProcess = Object.keys(teamMap);
  if (ONLY_TEAM) {
    if (!teamMap[ONLY_TEAM]) {
      console.error(`❌ Time "${ONLY_TEAM}" não encontrado. Disponíveis: ${Object.keys(teamMap).slice(0, 5).join(', ')}...`);
      process.exit(1);
    }
    teamsToProcess = [ONLY_TEAM];
  }

  if (MERGE) {
    const before = teamsToProcess.length;
    teamsToProcess = teamsToProcess.filter((t) => !existing[t] || existing[t].length === 0);
    console.log(`Modo MERGE: pulando ${before - teamsToProcess.length} times com dados já existentes.`);
  }

  console.log(`📡 Buscando últimas ${LIMIT} partidas de ${teamsToProcess.length} time(s)...`);
  if (DRY_RUN) console.log('   (DRY-RUN — não vai chamar API)');
  console.log(`   Delay entre requests: ${REQ_DELAY_MS}ms (rate limit safe)`);

  const result = { ...existing };
  let okCount = 0, failCount = 0, skipCount = 0;

  for (let i = 0; i < teamsToProcess.length; i++) {
    const team = teamsToProcess[i];
    const teamId = teamMap[team];
    const tag = `[${i + 1}/${teamsToProcess.length}]`;

    if (DRY_RUN) {
      console.log(`${tag} ${team} (id=${teamId}) — seria buscado`);
      skipCount++;
      continue;
    }

    try {
      process.stdout.write(`${tag} ${team.padEnd(25)} (id=${teamId})... `);
      const fixtures = await fetchTeamMatches(teamId, team);
      const tuples = fixtures
        .map((f) => toTuple(f, team, teamId))
        .filter((t) => t[3] !== null);  // pula matches sem resultado
      result[team] = tuples;
      console.log(`✓ ${tuples.length} matches`);
      okCount++;
    } catch (e) {
      console.log(`✗ ${e.message}`);
      failCount++;
    }

    // Rate limit: espera antes da próxima request (exceto a última)
    if (i < teamsToProcess.length - 1) {
      await new Promise((r) => setTimeout(r, REQ_DELAY_MS));
    }
  }

  if (DRY_RUN) {
    console.log(`\n✅ DRY-RUN concluído. ${skipCount} time(s) seriam processados.`);
    return;
  }

  // Salva
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2), 'utf8');

  console.log(`\n✅ Salvo em ${OUTPUT_PATH}`);
  console.log(`   ✓ ${okCount} ok  ✗ ${failCount} falhou  → ${teamsToProcess.length} processados`);

  // Resumo de cobertura
  const teamsWithData = Object.entries(result).filter(([, m]) => m.length > 0).length;
  const totalTeams = Object.keys(teamMap).length;
  const totalMatches = Object.values(result).reduce((s, m) => s + m.length, 0);
  console.log(`   📊 Cobertura: ${teamsWithData}/${totalTeams} times com dados (${totalMatches} matches total)`);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});

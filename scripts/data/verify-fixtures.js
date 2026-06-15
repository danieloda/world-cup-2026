#!/usr/bin/env node
/**
 * Verifica se matches.match_date / team_home / team_away no DB estão alinhados
 * com a API-Football (fixtures.json mais recente).
 *
 * Saída:
 *   - Total de matches OK
 *   - Lista de discrepâncias (date, time, team mismatch)
 *
 * Uso: node scripts/verify-fixtures.js
 *      node scripts/verify-fixtures.js --refresh   # re-baixa fixtures antes
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// A verificação só faz SELECT em matches. service_role bypassa RLS → lê sem
// login. Cai pro anon + login admin se a service key não estiver disponível
// (ex.: dev local sem ela no .env).
const USE_SERVICE = !!SERVICE_KEY;
const supabase = USE_SERVICE
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : createClient(SUPABASE_URL, ANON_KEY);
const FIXTURES_PATH = join(__dirname, '..', '..', 'src', 'assets', 'data', 'fixtures.json');

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c] || ''}${m}${C.reset}`);

async function login() {
  if (USE_SERVICE) {
    log('green', '🔑 service_role (sem login)');
    return;
  }
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('Defina SUPABASE_SERVICE_ROLE_KEY, ou ADMIN_EMAIL + ADMIN_PASSWORD');
  }
  log('blue', '🔐 Logando...');
  const { error } = await supabase.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (error) throw new Error('Login falhou: ' + error.message);
  log('green', `   ✓ ${ADMIN_EMAIL}`);
}

function loadFixtures() {
  const fx = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'));
  return fx.fixtures || fx;
}

/**
 * Normaliza nome de time pra comparar.
 * "Türkiye" === "Turkey", "Côte d'Ivoire" === "Ivory Coast", etc.
 */
const TEAM_ALIASES = {
  'Türkiye': 'Turkey',
  'Côte d\'Ivoire': 'Ivory Coast',
  'Cote d\'Ivoire': 'Ivory Coast',
  'Curaçao': 'Curacao',
  'Congo DR': 'DR Congo',
  'Cape Verde Islands': 'Cape Verde',
  'Korea Republic': 'South Korea',
  'Republic of Korea': 'South Korea',
  'United States': 'USA',
};

function normalizeTeam(name) {
  if (!name) return '';
  const aliased = TEAM_ALIASES[name] ?? name;
  return aliased.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

async function loadDbMatches() {
  const { data, error } = await supabase
    .from('matches')
    .select('id, stage, match_date, team_home, team_away, slot_home, slot_away')
    .order('id');
  if (error) throw error;
  return data;
}

function matchKey(home, away, dateIso) {
  // Chave bidirecional: ordena os times pra evitar problema de home/away invertido
  const [a, b] = [normalizeTeam(home), normalizeTeam(away)].sort();
  return `${a}__${b}__${dateIso.slice(0, 10)}`;
}

function summarizeApi(fixtures) {
  // Filtra: só matches que pertencem ao WC 2026 (já que API filtra por league=1)
  const map = new Map();
  for (const f of fixtures) {
    const home = f.homeTeam?.name;
    const away = f.awayTeam?.name;
    const date = f.date;
    if (!home || !away || !date) continue;
    const key = matchKey(home, away, date);
    if (map.has(key)) {
      log('yellow', `   ⚠ API duplicate key: ${key}`);
      continue;
    }
    map.set(key, {
      apiHome: home,
      apiAway: away,
      apiDate: date,
      apiVenue: f.venue,
      apiCity: f.city,
      apiRound: f.round,
      apiStatus: f.status,
    });
  }
  return map;
}

async function main() {
  if (REFRESH) {
    log('blue', '🔄 Refresh: rodando fetch-fixtures.js...');
    const res = spawnSync('node', [join(__dirname, 'fetch-fixtures.js')], { stdio: 'inherit' });
    if (res.status !== 0) {
      log('red', '   ✗ fetch-fixtures.js falhou');
      process.exit(1);
    }
  }

  await login();

  log('blue', '\n📥 Carregando matches do DB...');
  const dbMatches = await loadDbMatches();
  log('green', `   ✓ ${dbMatches.length} matches`);

  log('blue', '\n📥 Carregando fixtures.json (API snapshot)...');
  const apiFixtures = loadFixtures();
  log('green', `   ✓ ${apiFixtures.length} fixtures`);

  log('blue', '\n🔍 Indexando API por chave (teams + data)...');
  const apiByKey = summarizeApi(apiFixtures);
  log('green', `   ✓ ${apiByKey.size} chaves únicas`);

  // ============================================================
  // Comparação
  // ============================================================
  log('blue', '\n🔎 Comparando DB ↔ API...');

  const stats = {
    total: dbMatches.length,
    matched: 0,
    notInApi: 0,
    dateMismatch: 0,
    timeMismatch: 0,
    teamMismatch: 0,
    slotMatch: 0,  // matches com slot ainda não resolvido (não dá pra validar contra API)
  };

  const issues = [];

  for (const m of dbMatches) {
    // Se ainda tem slot (W##, 1A, etc), não podemos validar — slot deveria já ter sido resolvido
    if (m.slot_home && m.team_home === m.slot_home && /^[0-9WL]/.test(m.team_home)) {
      stats.slotMatch++;
      continue;
    }
    if (m.slot_away && m.team_away === m.slot_away && /^[0-9WL]/.test(m.team_away)) {
      stats.slotMatch++;
      continue;
    }

    const key = matchKey(m.team_home, m.team_away, m.match_date);
    const api = apiByKey.get(key);

    if (!api) {
      // Tenta achar por data apenas (caso teams trocados de home/away)
      const dateOnly = m.match_date.slice(0, 10);
      const candidates = [...apiByKey.values()].filter((a) => a.apiDate.slice(0, 10) === dateOnly);
      const fuzzyMatch = candidates.find((a) => {
        const teams = [normalizeTeam(a.apiHome), normalizeTeam(a.apiAway)];
        return teams.includes(normalizeTeam(m.team_home)) && teams.includes(normalizeTeam(m.team_away));
      });

      if (fuzzyMatch) {
        // Encontrou mas data/hora diferente
        stats.matched++;
        // Confere hora
        const dbHour = m.match_date.slice(11, 16);
        const apiHour = fuzzyMatch.apiDate.slice(11, 16);
        if (dbHour !== apiHour) {
          stats.timeMismatch++;
          issues.push({
            type: 'time',
            id: m.id,
            stage: m.stage,
            db: `${m.team_home} vs ${m.team_away} @ ${m.match_date}`,
            api: `${fuzzyMatch.apiHome} vs ${fuzzyMatch.apiAway} @ ${fuzzyMatch.apiDate}`,
          });
        }
      } else {
        stats.notInApi++;
        issues.push({
          type: 'notFound',
          id: m.id,
          stage: m.stage,
          db: `${m.team_home} vs ${m.team_away} @ ${m.match_date}`,
          api: '(não encontrado)',
        });
      }
    } else {
      stats.matched++;
      // Hora exata?
      if (m.match_date.slice(11, 16) !== api.apiDate.slice(11, 16)) {
        stats.timeMismatch++;
        issues.push({
          type: 'time',
          id: m.id,
          stage: m.stage,
          db: `${m.team_home} vs ${m.team_away} @ ${m.match_date}`,
          api: `${api.apiHome} vs ${api.apiAway} @ ${api.apiDate}`,
        });
      }
    }
  }

  // ============================================================
  // Resumo
  // ============================================================
  console.log('');
  log('blue', `${C.bold}═══ Resumo ═══${C.reset}`);
  log('blue', `   Total matches no DB:       ${stats.total}`);
  log('green', `   ✓ Conferiram com API:      ${stats.matched}`);
  log(stats.timeMismatch > 0 ? 'yellow' : 'green', `   ⚠ Hora diferente:          ${stats.timeMismatch}`);
  log(stats.notInApi > 0 ? 'red' : 'green', `   ✗ Não encontrado na API:   ${stats.notInApi}`);
  log('dim', `   - Slots não resolvidos:    ${stats.slotMatch}`);

  if (issues.length > 0) {
    console.log('');
    log('yellow', `${C.bold}═══ Discrepâncias (${issues.length}) ═══${C.reset}`);
    for (const i of issues.slice(0, 20)) {
      log('yellow', `   [${i.type}] M#${i.id} (${i.stage})`);
      log('dim', `       DB:  ${i.db}`);
      log('dim', `       API: ${i.api}`);
    }
    if (issues.length > 20) log('dim', `   ... e mais ${issues.length - 20}`);
  } else {
    console.log('');
    log('green', `${C.bold}✅ Todos os matches conferem com a API.${C.reset}`);
  }

  process.exit(issues.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});

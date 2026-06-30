#!/usr/bin/env node
/**
 * Fetch pre-match odds da Betano (API-Football) para as partidas de fase de
 * grupos do SBC 2026 — o 1X2 (barra de quem vence) MAIS os mercados extras que
 * alimentam o Raio-X enriquecido (placar provável, over/under, ambas marcam,
 * gols por seleção).
 *
 * Etapas:
 *   1) Garante que public.matches.api_fixture_id está populado (linkage com
 *      o id da API-Football) — busca por (team_home, team_away) em fixtures.json.
 *   2) Para cada jogo ainda não terminado e com api_fixture_id, chama
 *      GET /odds?fixture={id}&bookmaker=32 (Betano, TODOS os mercados numa só
 *      chamada), extrai o 1X2 + normaliza os mercados extras
 *      (scripts/lib/normalize-odds-markets.js) e faz upsert em match_odds.
 *
 * Idempotente — pode rodar quantas vezes quiser. Custo: ~72 requests (fase de
 * grupos) → mesmo de antes (1 request por jogo), bem abaixo do limite do plano.
 *
 * Usage:
 *   node scripts/data/fetch-odds.js              # fase de grupos (grava em PROD)
 *   node scripts/data/fetch-odds.js --ko         # mata-mata (confrontos já reais)
 *   node scripts/data/fetch-odds.js --dry-run    # não grava nada (só mostra)
 *
 * ⚠️ Sem --dry-run, escreve direto no Supabase de PRODUÇÃO (usa o
 *    SUPABASE_SERVICE_ROLE_KEY do .env). O caminho normal é a GitHub Action.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { normalizeOddsMarkets, flipMarkets } from '../lib/normalize-odds-markets.js';
import { resolveKnockoutFixtures } from '../lib/link-knockout.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const API_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const API_BASE = 'https://v3.football.api-sports.io';
const FIXTURES_PATH = join(__dirname, '..', '..', 'src', 'assets', 'data', 'fixtures.json');

const BOOKMAKER_ID = 32;       // Betano
const BOOKMAKER_NAME = 'Betano';
const BET_ID = 1;              // Match Winner (1X2)

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const KO = argv.includes('--ko');

function assert(cond, msg) {
  if (!cond) { console.error('ERRO:', msg); process.exit(1); }
}

assert(API_KEY, 'API_FOOTBALL_KEY ausente em .env');
assert(SUPABASE_URL, 'SUPABASE_URL ausente em .env');
assert(SERVICE_KEY, 'SUPABASE_SERVICE_ROLE_KEY ausente em .env');

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET genérico na API-Football com retry pra 429 (usado pelo linkage do mata-mata).
async function apiGet(path) {
  for (let a = 0; a < 4; a++) {
    const r = await fetch(API_BASE + path, { headers: { 'x-apisports-key': API_KEY } });
    if (r.status === 429) { await sleep(3000); continue; }
    if (!r.ok) throw new Error(`API HTTP ${r.status} (${path})`);
    return r.json();
  }
  throw new Error('rate limited ' + path);
}

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
    if (!DRY_RUN) {
      const { error: updErr } = await admin
        .from('matches')
        .update({ api_fixture_id: f.id })
        .eq('id', m.id);
      if (updErr) throw updErr;
    }
    linked++;
  }

  console.log(`Linkage: ${linked} novo(s), ${alreadyLinked} já linkado(s), ${notFound} não encontrado(s)`);
}

// ------------------------------------------------------------
// 2) Fetch odds e upsert em match_odds
// ------------------------------------------------------------
async function fetchFixtureOdds(apiFixtureId) {
  // SEM &bet= : a mesma chamada traz TODOS os mercados da Betano (1X2 + placar
  // exato + over/under + ambas marcam + gols por time). 1 request por jogo, igual
  // ao custo de antes. Mantemos &bookmaker=32 pra resposta enxuta (só Betano).
  const url = `${API_BASE}/odds?fixture=${apiFixtureId}&bookmaker=${BOOKMAKER_ID}`;
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`API HTTP ${res.status} para fixture ${apiFixtureId}`);
  const data = await res.json();

  if (data.results === 0) return null;

  // Resposta: response[0].bookmakers[0].bets[].values[]
  const entry = data.response[0];
  const bm = entry?.bookmakers?.find(b => b.id === BOOKMAKER_ID) ?? entry?.bookmakers?.[0];
  const bet = bm?.bets?.find(b => b.id === BET_ID);   // 1X2 (Match Winner)
  const values = bet?.values ?? [];

  const pick = (label) => {
    const v = values.find(x => x.value === label);
    return v ? Number(v.odd) : null;
  };

  const odd_home = pick('Home');
  const odd_draw = pick('Draw');
  const odd_away = pick('Away');

  if (odd_home == null || odd_draw == null || odd_away == null) return null;

  // Mercados extras normalizados (placar provável + perfil de gols). Pode ser
  // null se a Betano não cobrir nenhum deles ainda — aí o front mostra só a barra.
  const markets = normalizeOddsMarkets(bm?.bets);

  return {
    odd_home, odd_draw, odd_away,
    markets,
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
      if (!DRY_RUN) {
        const { error: upErr } = await admin
          .from('match_odds')
          .upsert({
            match_id: m.id,
            odd_home: odds.odd_home,
            odd_draw: odds.odd_draw,
            odd_away: odds.odd_away,
            markets: odds.markets,
            bookmaker_id: odds.bookmaker_id,
            bookmaker_name: odds.bookmaker_name,
            api_updated_at: odds.api_updated_at,
            fetched_at: new Date().toISOString(),
          }, { onConflict: 'match_id' });
        if (upErr) throw upErr;
      }

      const mk = odds.markets ? ` +mkt(${Object.keys(odds.markets).join(',')})` : '';
      console.log(`  [ok]${DRY_RUN ? '[dry]' : ''} #${m.id} ${m.team_home} ${odds.odd_home} · ${odds.odd_draw} · ${odds.odd_away} ${m.team_away}${mk}`);
      ok++;
    } catch (e) {
      console.error(`  [erro] #${m.id}:`, e.message);
    }
  }

  console.log(`\nResumo: ${ok} com odds · ${missing} sem odds disponíveis ainda`);
}

// ------------------------------------------------------------
// 3) Mata-mata: odds dos confrontos já reais (ligação ao vivo)
// ------------------------------------------------------------
// Diferente da fase de grupos, a fixture do mata-mata só existe na API quando os
// dois lados estão definidos, e o MANDO da API pode ser oposto ao nosso
// team_home — então reorientamos 1X2 e mercados (flipMarkets) pela ótica do nosso
// mandante, pra casar com o que o Raio-X exibe.
async function fetchKnockoutOdds() {
  const koMap = await resolveKnockoutFixtures({
    admin, apiGet, fixturesPath: FIXTURES_PATH, dryRun: DRY_RUN, log: console.log,
  });
  if (!koMap.size) { console.log('\nNenhum confronto de mata-mata com times reais ainda.'); return; }

  console.log(`\nBuscando odds (Betano) para ${koMap.size} confronto(s) de mata-mata…`);
  let ok = 0, missing = 0;
  for (const [matchId, info] of koMap) {
    try {
      const odds = await fetchFixtureOdds(info.apiFixtureId);
      if (!odds) {
        console.log(`  [no-odds] #${matchId} (fixture ${info.apiFixtureId})`);
        missing++;
        continue;
      }
      // Reorienta pela ótica do NOSSO mandante quando a API tem o mando oposto.
      const odd_home = info.reversed ? odds.odd_away : odds.odd_home;
      const odd_away = info.reversed ? odds.odd_home : odds.odd_away;
      const markets = info.reversed ? flipMarkets(odds.markets) : odds.markets;

      if (!DRY_RUN) {
        const { error: upErr } = await admin
          .from('match_odds')
          .upsert({
            match_id: matchId,
            odd_home, odd_draw: odds.odd_draw, odd_away,
            markets,
            bookmaker_id: odds.bookmaker_id,
            bookmaker_name: odds.bookmaker_name,
            api_updated_at: odds.api_updated_at,
            fetched_at: new Date().toISOString(),
          }, { onConflict: 'match_id' });
        if (upErr) throw upErr;
      }
      const mk = markets ? ` +mkt(${Object.keys(markets).join(',')})` : '';
      console.log(`  [ok]${DRY_RUN ? '[dry]' : ''} #${matchId} ${odd_home} · ${odds.odd_draw} · ${odd_away}${info.reversed ? ' (mando invertido)' : ''}${mk}`);
      ok++;
    } catch (e) {
      console.error(`  [erro] #${matchId}:`, e.message);
    }
  }
  console.log(`\nResumo mata-mata: ${ok} com odds · ${missing} sem odds ainda${DRY_RUN ? '  (DRY-RUN — nada gravado)' : ''}`);
}

async function main() {
  console.log(`=== SBC 2026 · fetch-odds${KO ? ' (mata-mata)' : ''}${DRY_RUN ? ' [DRY-RUN]' : ''} ===`);
  if (KO) {
    await fetchKnockoutOdds();
  } else {
    await linkFixtureIds();
    await fetchAllOdds();
  }
}

main().catch(err => { console.error(err); process.exit(1); });

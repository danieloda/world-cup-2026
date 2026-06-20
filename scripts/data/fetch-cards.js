#!/usr/bin/env node
/**
 * Fetch de cartões (fair play) da API-Football para as partidas já encerradas —
 * alimenta o critério #5 do desempate de grupos da Copa 2026 (conduta).
 *
 * Para cada jogo FINISHED com api_fixture_id e ainda sem cartões ingeridos
 * (cards_fetched_at IS NULL), chama GET /fixtures/events?fixture={id}, agrega os
 * cartões por time, computa os pontos de fair play pela FÓRMULA OFICIAL da FIFA
 * (scripts/lib/fairplay.js) e faz upsert em public.matches:
 *   home_yellow/red, away_yellow/red, home_fairplay/away_fairplay, cards_fetched_at.
 *
 * O UPDATE dispara o trigger trg_resolve_slots → resolve_match_slots reavalia as
 * classificações com o fair play. Idempotente; só rebusca jogos novos (use
 * --force para refazer todos).
 *
 * Pré-requisito: api_fixture_id já populado (fetch-odds.js faz o linkage).
 *
 * Usage: node scripts/data/fetch-cards.js [--force]
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { summarizeCards } from '../lib/fairplay.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const API_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE = 'https://v3.football.api-sports.io';
const FORCE = process.argv.includes('--force');

function assert(cond, msg) { if (!cond) { console.error('ERRO:', msg); process.exit(1); } }
assert(API_KEY, 'API_FOOTBALL_KEY ausente em .env');
assert(SUPABASE_URL, 'SUPABASE_URL ausente em .env');
assert(SERVICE_KEY, 'SUPABASE_SERVICE_ROLE_KEY ausente em .env');

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Nome do time no padrão da API-Football quando difere do nome no DB (p/ casar
// event.team.name). Mesmos aliases do fetch-odds.js.
const TEAM_ALIAS = {
  'Cape Verde': 'Cape Verde Islands',
  'DR Congo': 'Congo DR',
};
const apiName = (n) => TEAM_ALIAS[n] ?? n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFixtureEvents(apiFixtureId) {
  const url = `${API_BASE}/fixtures/events?fixture=${apiFixtureId}`;
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`API HTTP ${res.status} para fixture ${apiFixtureId}`);
  const data = await res.json();
  // results === 0 → eventos ainda não disponíveis (jogo recém-encerrado). Pula.
  if (data.results === 0 || !Array.isArray(data.response)) return null;
  return data.response;
}

async function main() {
  console.log(`=== Copa 2026 · fetch-cards${FORCE ? ' (--force)' : ''} ===`);

  let q = admin
    .from('matches')
    .select('id, team_home, team_away, api_fixture_id, finished, cards_fetched_at')
    .eq('finished', true)
    .not('api_fixture_id', 'is', null)
    .order('match_date');
  if (!FORCE) q = q.is('cards_fetched_at', null);

  const { data: matches, error } = await q;
  if (error) throw error;

  console.log(`\nBuscando cartões para ${matches.length} partida(s) encerrada(s)…`);

  let ok = 0, pending = 0;
  for (const m of matches) {
    try {
      const events = await fetchFixtureEvents(m.api_fixture_id);
      if (!events) {
        console.log(`  [pendente] #${m.id} ${m.team_home} x ${m.team_away} — eventos ainda não disponíveis`);
        pending++;
        await sleep(300);
        continue;
      }

      const s = summarizeCards(events, apiName(m.team_home), apiName(m.team_away));

      const { error: upErr } = await admin
        .from('matches')
        .update({
          home_yellow: s.home.yellow, home_red: s.home.red, home_fairplay: s.home.fairplay,
          away_yellow: s.away.yellow, away_red: s.away.red, away_fairplay: s.away.fairplay,
          cards_fetched_at: new Date().toISOString(),
        })
        .eq('id', m.id);
      if (upErr) throw upErr;

      console.log(
        `  [ok] #${m.id} ${m.team_home} (🟨${s.home.yellow} 🟥${s.home.red} fp${s.home.fairplay}) x ` +
        `(🟨${s.away.yellow} 🟥${s.away.red} fp${s.away.fairplay}) ${m.team_away}`
      );
      ok++;
      await sleep(300);  // respeita rate limit (mesmo padrão dos outros fetch-*)
    } catch (e) {
      console.error(`  [erro] #${m.id}:`, e.message);
    }
  }

  console.log(`\nResumo: ${ok} com cartões ingeridos · ${pending} aguardando eventos da API`);
}

main().catch((err) => { console.error(err); process.exit(1); });

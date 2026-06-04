#!/usr/bin/env node
/**
 * Fetch pré-jogo "predictions" da API-Football para as partidas do bolão e
 * grava em public.match_predictions JÁ NORMALIZADO no formato que o front
 * consome (ver js/raiox.js / renderPredictionsBlock).
 *
 * Etapas (espelha scripts/fetch-odds.js):
 *   1) Garante matches.api_fixture_id (linkage com a API via fixtures.json).
 *   2) Para cada jogo não terminado e linkado: GET /predictions?fixture={id},
 *      normaliza e faz upsert em match_predictions. Se a API NÃO tem previsão
 *      útil (advice "No predictions available" ou percent 33/33/33), NÃO grava
 *      — e apaga linha velha, se houver. Mesmo princípio das odds: sem dado real,
 *      nada aparece.
 *
 * Idempotente. Custo: ~72 requests (fase de grupos).
 *
 * Usage:
 *   node scripts/fetch-predictions.js              # grava em PROD (cuidado!)
 *   node scripts/fetch-predictions.js --dry-run    # só mostra, não grava nada
 *   node scripts/fetch-predictions.js --stage=knockout
 *
 * ⚠️ Sem --dry-run, escreve direto no Supabase de PRODUÇÃO (usa o
 *    SUPABASE_SERVICE_ROLE_KEY do .env). O caminho normal é a GitHub Action.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { normalizePrediction } from './lib/normalize-prediction.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const API_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const API_BASE = 'https://v3.football.api-sports.io';
const FIXTURES_PATH = join(__dirname, '..', 'assets', 'data', 'fixtures.json');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const STAGE = argv.find(a => a.startsWith('--stage='))?.split('=')[1] || 'group';

function assert(cond, msg) { if (!cond) { console.error('ERRO:', msg); process.exit(1); } }
assert(API_KEY, 'API_FOOTBALL_KEY ausente em .env');
assert(SUPABASE_URL, 'SUPABASE_URL ausente em .env');
assert(SERVICE_KEY, 'SUPABASE_SERVICE_ROLE_KEY ausente em .env');

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// ------------------------------------------------------------
// 1) Linkage api_fixture_id (igual fetch-odds.js)
// ------------------------------------------------------------
const TEAM_ALIAS = { 'Cape Verde': 'Cape Verde Islands', 'DR Congo': 'Congo DR' };
const apiName = (n) => TEAM_ALIAS[n] ?? n;

async function linkFixtureIds() {
  const fixturesJson = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));
  const apiFixtures = fixturesJson.fixtures;

  const { data: matches, error } = await admin
    .from('matches')
    .select('id, team_home, team_away, api_fixture_id, stage')
    .eq('stage', STAGE)
    .order('match_date');
  if (error) throw error;

  let linked = 0, alreadyLinked = 0, notFound = 0;
  for (const m of matches) {
    if (m.api_fixture_id) { alreadyLinked++; continue; }
    const f = apiFixtures.find(x => x.homeTeam.name === apiName(m.team_home) && x.awayTeam.name === apiName(m.team_away));
    if (!f) { notFound++; continue; }
    if (DRY_RUN) { linked++; continue; }
    const { error: updErr } = await admin.from('matches').update({ api_fixture_id: f.id }).eq('id', m.id);
    if (updErr) throw updErr;
    linked++;
  }
  console.log(`Linkage: ${linked} ${DRY_RUN ? 'a linkar' : 'novo(s)'}, ${alreadyLinked} já linkado(s), ${notFound} não encontrado(s)`);
}

// ------------------------------------------------------------
// 2) Fetch predictions e upsert/delete em match_predictions
// ------------------------------------------------------------
async function fetchFixturePrediction(apiFixtureId) {
  const res = await fetch(`${API_BASE}/predictions?fixture=${apiFixtureId}`, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`API HTTP ${res.status} para fixture ${apiFixtureId}`);
  const data = await res.json();
  if (data.results === 0) return null;
  return data.response?.[0] ?? null;
}

async function fetchAllPredictions() {
  const { data: matches, error } = await admin
    .from('matches')
    .select('id, team_home, team_away, api_fixture_id, finished')
    .eq('stage', STAGE)
    .not('api_fixture_id', 'is', null)
    .eq('finished', false)
    .order('match_date');
  if (error) throw error;

  console.log(`\nBuscando previsões para ${matches.length} partida(s)…`);
  let ok = 0, missing = 0;

  for (const m of matches) {
    try {
      const entry = await fetchFixturePrediction(m.api_fixture_id);
      const norm = entry
        ? normalizePrediction(entry, entry.teams?.home?.id ?? null, entry.teams?.away?.id ?? null)
        : null;

      if (!norm) {
        console.log(`  [no-pred] #${m.id} ${m.team_home} x ${m.team_away}`);
        missing++;
        // Sem previsão útil → remove linha velha (igual gating do front: sem dado, nada).
        if (!DRY_RUN) {
          const { error: delErr } = await admin.from('match_predictions').delete().eq('match_id', m.id);
          if (delErr) throw delErr;
        }
        continue;
      }

      if (!DRY_RUN) {
        const { error: upErr } = await admin.from('match_predictions').upsert({
          match_id: m.id,
          payload: norm,
          advice: entry.predictions.advice ?? null,
          fetched_at: new Date().toISOString(),
        }, { onConflict: 'match_id' });
        if (upErr) throw upErr;
      }
      console.log(`  [ok] #${m.id} ${m.team_home} ${norm.pHome}/${norm.pDraw}/${norm.pAway} ${m.team_away} → ${norm.favored}${norm.radar ? ' +radar' : ''}`);
      ok++;
    } catch (e) {
      console.error(`  [erro] #${m.id}:`, e.message);
    }
  }
  console.log(`\nResumo: ${ok} com previsão · ${missing} sem previsão${DRY_RUN ? '  (DRY-RUN — nada gravado)' : ''}`);
}

async function main() {
  console.log('=== SBC 2026 · fetch-predictions ===');
  if (DRY_RUN) console.log('(DRY-RUN — não grava nada no Supabase)\n');
  await linkFixtureIds();
  await fetchAllPredictions();
}

main().catch(err => { console.error(err); process.exit(1); });

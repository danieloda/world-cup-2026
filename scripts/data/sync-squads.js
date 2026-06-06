#!/usr/bin/env node
/**
 * Sincroniza convocados oficiais (API-Football) com public.players.
 *
 * Fonte: GET /players/squads?team={api_team_id} para cada uma das 48
 * seleções do Mundial 2026 (league=1, season=2026).
 *
 * Estratégia segura — NUNCA faz TRUNCATE (preservaria FKs de
 * top_scorer_picks e player_goals quebrariam):
 *
 *   1. Resolve api_team_id → nome do DB usando TEAM_ALIAS (fetch-odds).
 *   2. Para cada jogador da API:
 *      - tenta casar por api_player_id (se já populado)
 *      - senão, casa por (full_name, team) — unique constraint do schema
 *      - upsert: insere ou atualiza position/shirt_number/api_player_id
 *   3. NÃO remove jogadores antigos. Cortes de elenco são reportados
 *      mas decisão de deletar fica com o admin (CLI flag --prune).
 *
 * Custo: 48 + 1 calls (1 pra listar teams, 48 pra squads).
 * Idempotente — pode rodar várias vezes.
 *
 * Usage:
 *   node scripts/sync-squads.js              # sync padrão
 *   node scripts/sync-squads.js --prune      # remove jogadores ausentes da API
 *   node scripts/sync-squads.js --dry-run    # mostra o que faria
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const API_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE = 'https://v3.football.api-sports.io';
const LEAGUE = 1, SEASON = 2026;
const DRY_RUN = process.argv.includes('--dry-run');
const PRUNE = process.argv.includes('--prune');

function assert(cond, msg) { if (!cond) { console.error('ERRO:', msg); process.exit(1); } }
assert(API_KEY, 'API_FOOTBALL_KEY ausente em .env');
assert(SUPABASE_URL, 'SUPABASE_URL ausente em .env');
assert(SERVICE_KEY, 'SUPABASE_SERVICE_ROLE_KEY ausente em .env');

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// API → DB (inverso do TEAM_ALIAS em fetch-odds.js)
const DB_NAME_FROM_API = {
  'Cape Verde Islands': 'Cape Verde',
  'Congo DR':           'DR Congo',
};
const dbName = (apiTeamName) => DB_NAME_FROM_API[apiTeamName] ?? apiTeamName;

const POSITION_MAP = {
  'Goalkeeper': 'GOL', 'Defender': 'DEF',
  'Midfielder': 'MEI', 'Attacker': 'ATA',
};

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'x-apisports-key': API_KEY }
  });
  if (!res.ok) throw new Error(`API HTTP ${res.status} para ${path}`);
  return res.json();
}

async function fetchTeams() {
  const d = await apiGet(`/teams?league=${LEAGUE}&season=${SEASON}`);
  return d.response.map(t => ({ id: t.team.id, apiName: t.team.name }));
}

async function fetchSquad(apiTeamId) {
  const d = await apiGet(`/players/squads?team=${apiTeamId}`);
  if (!d.response?.length) return [];
  return d.response[0].players.map(p => ({
    api_player_id: p.id,
    full_name: p.name,
    position: POSITION_MAP[p.position] || p.position || null,
    shirt_number: p.number ?? null,
  }));
}

async function syncTeam({ apiTeamId, apiName }) {
  const team = dbName(apiName);
  const apiPlayers = await fetchSquad(apiTeamId);

  // Carrega elenco atual do DB
  const { data: dbPlayers, error } = await admin
    .from('players')
    .select('id, full_name, position, shirt_number, api_player_id')
    .eq('team', team);
  if (error) throw error;

  const byApiId   = new Map(dbPlayers.filter(p => p.api_player_id).map(p => [p.api_player_id, p]));
  const byName    = new Map(dbPlayers.map(p => [p.full_name, p]));
  const apiNames  = new Set(apiPlayers.map(p => p.full_name));

  let inserted = 0, updated = 0, unchanged = 0;
  const toPrune = [];

  for (const p of apiPlayers) {
    const existing = byApiId.get(p.api_player_id) || byName.get(p.full_name);
    if (!existing) {
      if (!DRY_RUN) {
        const { data: ins, error: insErr } = await admin
          .from('players')
          .insert({ team, ...p })
          .select('id, full_name, position, shirt_number, api_player_id')
          .single();
        if (insErr) {
          // Pode ser nome duplicado por jogador inserido neste mesmo loop
          // (API às vezes lista 2 atletas com p.name idêntico). Re-tenta como update.
          if (insErr.code === '23505') {
            const { error: updErr } = await admin
              .from('players')
              .update({ position: p.position, shirt_number: p.shirt_number, api_player_id: p.api_player_id })
              .eq('team', team).eq('full_name', p.full_name);
            if (updErr) throw updErr;
            updated++;
            continue;
          }
          throw insErr;
        }
        if (ins) { byName.set(ins.full_name, ins); byApiId.set(ins.api_player_id, ins); }
      }
      inserted++;
      continue;
    }
    // API é a fonte da verdade (migration 052): nome/posição/número/api_id vêm da API.
    // Identidade estável é o api_player_id, então atualizar o full_name não recria
    // duplicatas (não existem mais linhas "nome completo" sem api_id após a 052).
    const needsUpdate =
      existing.position !== p.position ||
      existing.shirt_number !== p.shirt_number ||
      existing.api_player_id !== p.api_player_id ||
      existing.full_name !== p.full_name;
    if (needsUpdate) {
      if (!DRY_RUN) {
        const { error: updErr } = await admin
          .from('players')
          .update({
            full_name: p.full_name,
            position: p.position,
            shirt_number: p.shirt_number,
            api_player_id: p.api_player_id,
          })
          .eq('id', existing.id);
        if (updErr) throw updErr;
      }
      updated++;
    } else {
      unchanged++;
    }
  }

  // Cortes de elenco (jogadores no DB mas não na API)
  for (const dp of dbPlayers) {
    const stillThere = apiNames.has(dp.full_name) ||
      (dp.api_player_id && apiPlayers.some(p => p.api_player_id === dp.api_player_id));
    if (!stillThere) toPrune.push(dp);
  }

  if (PRUNE && !DRY_RUN && toPrune.length) {
    // Só deleta se não houver top_scorer_picks apontando — senão pula
    const ids = toPrune.map(p => p.id);
    const { data: picks } = await admin
      .from('top_scorer_picks').select('player_id').in('player_id', ids);
    const pinned = new Set((picks || []).map(p => p.player_id));
    const safe = ids.filter(id => !pinned.has(id));
    if (safe.length) {
      const { error: delErr } = await admin
        .from('players').delete().in('id', safe);
      if (delErr) throw delErr;
    }
    return { team, inserted, updated, unchanged, prunable: toPrune.length, pruned: safe.length };
  }

  return { team, inserted, updated, unchanged, prunable: toPrune.length, pruned: 0 };
}

async function main() {
  console.log(`Modo: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTAR'}${PRUNE ? ' + PRUNE' : ''}\n`);
  console.log('Buscando seleções do Mundial 2026...');
  const teams = await fetchTeams();
  console.log(`${teams.length} seleções encontradas\n`);

  const totals = { inserted: 0, updated: 0, unchanged: 0, prunable: 0, pruned: 0 };

  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    process.stdout.write(`[${String(i + 1).padStart(2)}/${teams.length}] ${dbName(t.apiName).padEnd(22)}`);
    try {
      const r = await syncTeam({ apiTeamId: t.id, apiName: t.apiName });
      console.log(`+${r.inserted}  ~${r.updated}  =${r.unchanged}  prune?${r.prunable}${PRUNE ? ` (${r.pruned} removidos)` : ''}`);
      for (const k of Object.keys(totals)) totals[k] += r[k];
    } catch (e) {
      console.log(`ERRO: ${e.message}`);
    }
    if (i < teams.length - 1) await new Promise(r => setTimeout(r, 700));
  }

  console.log(`\nTotal: +${totals.inserted} inseridos, ~${totals.updated} atualizados, =${totals.unchanged} sem mudança, prune?${totals.prunable}${PRUNE ? ` (${totals.pruned} removidos)` : ''}`);
  if (!PRUNE && totals.prunable > 0) {
    console.log('Dica: rode com --prune para remover jogadores não convocados (preserva quem tem aposta de artilheiro).');
  }
}

main().catch(e => { console.error(e); process.exit(1); });

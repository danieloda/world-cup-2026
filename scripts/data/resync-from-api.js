#!/usr/bin/env node
/**
 * resync-from-api.js — torna a API-Football a fonte da verdade dos elencos.
 * Espelha a migration 052 (repoint -> prune -> upsert) via service-role.
 *
 * Lê os elencos da API de /tmp/api_squads.json (gerado na sessão) OU rebusca
 * com --fetch. Preserva 100% dos palpites de artilheiro.
 *
 * Uso:
 *   node scripts/data/resync-from-api.js            # DRY-RUN (não escreve)
 *   node scripts/data/resync-from-api.js --apply    # aplica
 *   node scripts/data/resync-from-api.js --fetch     # rebusca a API antes
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const APPLY = process.argv.includes('--apply');
const FETCH = process.argv.includes('--fetch');
const KEY = process.env.API_FOOTBALL_KEY;
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const API2DB = { 'Cape Verde Islands': 'Cape Verde', 'Congo DR': 'DR Congo' };
const POS = { Goalkeeper: 'GOL', Defender: 'DEF', Midfielder: 'MEI', Attacker: 'ATA' };
const team = (t) => API2DB[t] ?? t;
const CACHE = '/tmp/api_squads.json';
const ORPHANS = [ // palpites na versão "iniciais" -> linha canônica da API (api_id)
  { team: 'Portugal', name: 'C. Ronaldo', api: 874 },
  { team: 'Brazil', name: 'M. Cunha', api: 1165 },
  { team: 'Brazil', name: 'I. Thiago', api: 196156 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function apiGet(path) {
  for (let a = 0; a < 4; a++) {
    const r = await fetch('https://v3.football.api-sports.io' + path, { headers: { 'x-apisports-key': KEY } });
    if (r.status === 429) { await sleep(3000); continue; }
    if (!r.ok) throw new Error('API HTTP ' + r.status);
    return r.json();
  }
  throw new Error('rate limited ' + path);
}
async function fetchAll() {
  const t = await apiGet('/teams?league=1&season=2026');
  const teams = t.response.map((x) => ({ id: x.team.id, name: x.team.name }));
  const out = [];
  for (const tm of teams) {
    const s = await apiGet('/players/squads?team=' + tm.id);
    out.push({ team: tm.name, id: tm.id, players: (s.response?.[0]?.players || []).map((p) => ({ id: p.id, name: p.name, number: p.number, position: p.position })) });
    await sleep(1200);
  }
  writeFileSync(CACHE, JSON.stringify(out));
  return out;
}
async function loadAll(table, select) {
  let all = [], p = 0;
  for (;;) { const { data, error } = await db.from(table).select(select).range(p * 1000, p * 1000 + 999); if (error) throw error; if (!data?.length) break; all = all.concat(data); if (data.length < 1000) break; p++; }
  return all;
}
async function pool(items, n, fn) { let i = 0; const w = Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } }); await Promise.all(w); }

async function main() {
  console.log(APPLY ? '\x1b[31m★ APPLY (vai escrever na produção)\x1b[0m' : '★ DRY-RUN (não escreve)');

  // ---- API truth (dedupe por (team,name), menor api_id) ----
  const apiRaw = FETCH ? await fetchAll() : JSON.parse(readFileSync(CACHE, 'utf8'));
  const byKey = new Map(); let dropped = 0;
  for (const t of apiRaw) for (const p of t.players) {
    const tm = team(t.team); const k = tm + '|' + p.name;
    const cur = byKey.get(k);
    if (!cur) byKey.set(k, { api_id: p.id, team: tm, full_name: p.name, shirt_number: p.number ?? null, position: POS[p.position] || p.position });
    else { dropped++; if (p.id < cur.api_id) byKey.set(k, { api_id: p.id, team: tm, full_name: p.name, shirt_number: p.number ?? null, position: POS[p.position] || p.position }); }
  }
  const apiList = [...byKey.values()];
  const apiIds = new Set(apiList.map((p) => p.api_id));
  console.log(`API: ${apiList.length} jogadores (${apiRaw.length} times)${dropped ? `, ${dropped} nome(s) duplicado(s) descartado(s)` : ''}`);

  // ---- estado atual ----
  let players = await loadAll('players', 'id,full_name,team,position,shirt_number,api_player_id');
  let picks = await loadAll('top_scorer_picks', 'user_id,player_id');
  const pickCountBefore = picks.length;
  console.log(`DB: ${players.length} jogadores, ${new Set(players.map(p => p.team)).size} times, ${pickCountBefore} palpites`);

  // ---- 1) repoint dos 3 órfãos ----
  const byApi = new Map(players.filter(p => p.api_player_id != null).map(p => [p.api_player_id, p]));
  const repointPlan = [];
  for (const o of ORPHANS) {
    const orphan = players.find(p => p.team === o.team && p.full_name === o.name && p.api_player_id == null);
    const canon = byApi.get(o.api);
    if (!orphan) { console.log(`  repoint ${o.name}: órfão não existe (ok, já tratado)`); continue; }
    if (!canon) throw new Error(`ABORT: canônico api#${o.api} (${o.name}) não existe no DB — não dá pra preservar o palpite`);
    const n = picks.filter(p => p.player_id === orphan.id).length;
    repointPlan.push({ from: orphan.id, to: canon.id, n, label: `${o.name} -> ${canon.full_name} (api#${o.api})` });
  }
  repointPlan.forEach(r => console.log(`  repoint ${r.n} palpite(s): ${r.label}`));
  if (APPLY) for (const r of repointPlan) { const { error } = await db.from('top_scorer_picks').update({ player_id: r.to }).eq('player_id', r.from); if (error) throw error; }

  // re-read picks (pós-repoint) p/ saber ids protegidos
  if (APPLY) picks = await loadAll('top_scorer_picks', 'user_id,player_id');
  else picks = picks.map(p => { const r = repointPlan.find(x => x.from === p.player_id); return r ? { ...p, player_id: r.to } : p; });
  const pickedIds = new Set(picks.map(p => p.player_id));

  // ---- 2) prune: não está na API e não tem palpite ----
  const prunable = players.filter(p => !(p.api_player_id != null && apiIds.has(p.api_player_id)) && !pickedIds.has(p.id));
  console.log(`  prune: ${prunable.length} jogador(es) (fora da API, sem palpite) — inclui fantasma "United States"`);
  if (APPLY) { const ids = prunable.map(p => p.id); for (let i = 0; i < ids.length; i += 200) { const { error } = await db.from('players').delete().in('id', ids.slice(i, i + 200)); if (error) throw error; } }

  // ---- 3) upsert: update existentes por api_id, insert novos ----
  if (APPLY) players = await loadAll('players', 'id,full_name,team,position,shirt_number,api_player_id');
  const liveByApi = new Map(players.filter(p => p.api_player_id != null).map(p => [p.api_player_id, p]));
  const toUpdate = [], toInsert = [];
  for (const a of apiList) {
    const cur = liveByApi.get(a.api_id);
    if (cur) { if (cur.full_name !== a.full_name || cur.team !== a.team || cur.shirt_number !== a.shirt_number || cur.position !== a.position) toUpdate.push({ id: cur.id, a }); }
    else toInsert.push(a);
  }
  console.log(`  upsert: ${toUpdate.length} update(s), ${toInsert.length} insert(s)`);
  if (APPLY) {
    await pool(toUpdate, 8, async ({ id, a }) => { const { error } = await db.from('players').update({ full_name: a.full_name, team: a.team, shirt_number: a.shirt_number, position: a.position }).eq('id', id); if (error) throw new Error(`update ${a.full_name}: ${error.message}`); });
    for (let i = 0; i < toInsert.length; i += 200) { const batch = toInsert.slice(i, i + 200).map(a => ({ full_name: a.full_name, team: a.team, position: a.position, shirt_number: a.shirt_number, api_player_id: a.api_id })); const { error } = await db.from('players').insert(batch); if (error) throw new Error(`insert lote ${i}: ${error.message}`); }
  }

  if (!APPLY) { console.log('\n[DRY-RUN] nada escrito. Rode com --apply.'); return; }

  // ---- 4) verificação ----
  console.log('\n=== VERIFICAÇÃO ===');
  const fin = await loadAll('players', 'id,full_name,team,api_player_id');
  const finPicks = await loadAll('top_scorer_picks', 'user_id,player_id');
  const finById = new Map(fin.map(p => [p.id, p]));
  const fails = [];
  if (finPicks.length !== pickCountBefore) fails.push(`palpites ${pickCountBefore} -> ${finPicks.length}`);
  const badPicks = finPicks.filter(p => { const pl = finById.get(p.player_id); return !pl || pl.api_player_id == null; });
  if (badPicks.length) fails.push(`${badPicks.length} palpite(s) sem jogador/api`);
  const us = fin.filter(p => p.team === 'United States').length; if (us) fails.push(`${us} linha(s) United States`);
  const dupKey = {}; fin.forEach(p => { const k = p.team + '|' + p.full_name; dupKey[k] = (dupKey[k] || 0) + 1; });
  const dups = Object.entries(dupKey).filter(([k, v]) => v > 1); if (dups.length) fails.push(`${dups.length} duplicata(s) (full_name,team)`);
  const cnt = {}; fin.forEach(p => cnt[p.team] = (cnt[p.team] || 0) + 1);
  const badTeams = Object.entries(cnt).filter(([t, c]) => c < 23 || c > 28); if (badTeams.length) fails.push(`times fora 23-28: ${badTeams.map(([t, c]) => t + '=' + c).join(', ')}`);
  console.log(`jogadores: ${fin.length} | times: ${Object.keys(cnt).length} | palpites: ${finPicks.length} (antes ${pickCountBefore})`);
  console.log(`United States: ${us} | duplicatas: ${dups.length} | times fora 23-28: ${badTeams.length}`);
  if (fails.length) { console.error('\x1b[31m✗ FALHAS: ' + fails.join(' | ') + '\x1b[0m'); process.exit(1); }
  console.log('\x1b[32m✓ OK — squads = API, 0 duplicata, 0 fantasma, todos os palpites preservados.\x1b[0m');
}
main().catch((e) => { console.error('\x1b[31mERRO:', e.message, '\x1b[0m'); process.exit(1); });

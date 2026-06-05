#!/usr/bin/env node
/**
 * Sincroniza public.players com o src/assets/data/squads.json (snapshot da API):
 *
 *   1. ADDS:    players na API mas não no DB → INSERT
 *   2. UPDATES: players nos dois → UPDATE shirt_number/position se mudou
 *   3. DELETES: players no DB mas não na API → DELETE
 *
 * Identidade: (full_name, team) (unique constraint da tabela).
 *
 * SEGURANÇA: se houver FK refs (top_scorer_picks, player_goals) apontando pra
 * algum player que ia ser deletado, o DELETE FALHA e o script aborta. Use
 * --force-soft-delete pra apagar refs também (NUNCA em produção com bolão rolando).
 *
 * Uso:
 *   node scripts/sync-players.js --dry-run   (mostra o diff, não escreve)
 *   node scripts/sync-players.js             (aplica adds/updates/deletes)
 *   node scripts/sync-players.js --no-delete (só adds e updates)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const DRY = args['dry-run'] === true;
const NO_DELETE = args['no-delete'] === true;
const FORCE = args.force === true;

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SQUADS_PATH = join(__dirname, '..', '..', 'src', 'assets', 'data', 'squads.json');

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', dim: '\x1b[2m', bold: '\x1b[1m' };
const log = (c, m) => console.log(`${C[c] || ''}${m}${C.reset}`);

// Alias: API → DB (algumas seleções têm nomes diferentes)
const TEAM_ALIAS_API_TO_DB = {
  'USA': 'United States',
  'Cape Verde Islands': 'Cape Verde',
  'Congo DR': 'DR Congo',
};
function teamFromApi(apiName) {
  return TEAM_ALIAS_API_TO_DB[apiName] ?? apiName;
}

async function prompt(q) {
  if (FORCE) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a.trim().toLowerCase() === 'yes'); }));
}

async function loadAll(table, select) {
  let all = [], page = 0;
  while (true) {
    const { data } = await admin.from(table).select(select).range(page * 1000, page * 1000 + 999);
    if (!data?.length) break;
    all = all.concat(data); if (data.length < 1000) break; page++;
  }
  return all;
}

async function main() {
  log('blue', `${C.bold}🔄 Sync players (DB ↔ squads.json)${C.reset}`);
  if (DRY) log('yellow', '   ★ DRY-RUN ★');
  if (NO_DELETE) log('yellow', '   ★ --no-delete (só adds/updates)');

  // ===== Load both sides =====
  const squadsRaw = JSON.parse(readFileSync(SQUADS_PATH, 'utf8'));
  const apiPlayers = [];  // { full_name, team, position, shirt_number }
  for (const [apiTeam, squad] of Object.entries(squadsRaw)) {
    const dbTeam = teamFromApi(apiTeam);
    for (const p of squad.players || []) {
      apiPlayers.push({
        full_name: p.name,
        team: dbTeam,
        position: p.position,  // já mapeado pra GOL/DEF/MEI/ATA pelo fetch
        shirt_number: p.number ?? null,
      });
    }
  }
  log('green', `   ✓ ${apiPlayers.length} players na API (${Object.keys(squadsRaw).length} times)`);

  const dbPlayers = await loadAll('players', 'id, full_name, team, position, shirt_number');
  log('green', `   ✓ ${dbPlayers.length} players no DB`);

  // ===== Diff =====
  const keyOf = (p) => `${p.team}::${p.full_name}`;
  const apiByKey = new Map(apiPlayers.map((p) => [keyOf(p), p]));
  const dbByKey = new Map(dbPlayers.map((p) => [keyOf(p), p]));

  const adds = [];
  const updates = [];   // { id, ...newFields }
  const deletes = [];

  for (const [key, apiP] of apiByKey) {
    const dbP = dbByKey.get(key);
    if (!dbP) {
      adds.push(apiP);
    } else {
      const numMatch = (dbP.shirt_number ?? null) === (apiP.shirt_number ?? null);
      const posMatch = dbP.position === apiP.position;
      if (!numMatch || !posMatch) {
        updates.push({ id: dbP.id, full_name: dbP.full_name, team: dbP.team,
          shirt_number: apiP.shirt_number, position: apiP.position,
          _from: `#${dbP.shirt_number ?? '?'} ${dbP.position} → #${apiP.shirt_number ?? '?'} ${apiP.position}` });
      }
    }
  }
  for (const [key, dbP] of dbByKey) {
    if (!apiByKey.has(key)) deletes.push(dbP);
  }

  // ===== Resumo =====
  log('blue', '\n📊 Diff:');
  log('green', `   + ${adds.length} ADDS (novos players)`);
  log('yellow', `   ~ ${updates.length} UPDATES (mudou número/posição)`);
  log('red', `   - ${deletes.length} DELETES (cortados/não convocados)`);

  if (adds.length) {
    log('dim', '\n   Sample ADDS:');
    for (const p of adds.slice(0, 8)) log('dim', `     + ${p.team.padEnd(20)} ${p.full_name} (#${p.shirt_number ?? '?'}, ${p.position})`);
    if (adds.length > 8) log('dim', `     ... +${adds.length - 8} mais`);
  }
  if (updates.length) {
    log('dim', '\n   Sample UPDATES:');
    for (const u of updates.slice(0, 8)) log('dim', `     ~ ${u.team.padEnd(20)} ${u.full_name}: ${u._from}`);
    if (updates.length > 8) log('dim', `     ... +${updates.length - 8} mais`);
  }
  if (deletes.length) {
    log('dim', '\n   Sample DELETES:');
    for (const d of deletes.slice(0, 8)) log('dim', `     - ${d.team.padEnd(20)} ${d.full_name} (#${d.shirt_number ?? '?'})`);
    if (deletes.length > 8) log('dim', `     ... +${deletes.length - 8} mais`);
  }

  // ===== FK safety check (antes de aceitar deletes) =====
  if (!NO_DELETE && deletes.length > 0) {
    const ids = deletes.map((d) => d.id);
    const { count: refsPicks } = await admin.from('top_scorer_picks').select('*', { count: 'exact', head: true }).in('player_id', ids);
    const { count: refsGoals } = await admin.from('player_goals').select('*', { count: 'exact', head: true }).in('player_id', ids);
    if ((refsPicks ?? 0) > 0 || (refsGoals ?? 0) > 0) {
      log('red', `\n   ⚠ FK refs encontradas em players a deletar: ${refsPicks} picks, ${refsGoals} goals`);
      log('red', '     DELETE vai falhar. Aborte ou use --no-delete pra preservar.');
      process.exit(1);
    }
    log('green', '   ✓ Nenhuma FK ref aponta pros players a deletar (safe)');
  }

  if (DRY) { log('yellow', '\n[DRY-RUN] Nada foi escrito.'); return; }

  if (adds.length === 0 && updates.length === 0 && (NO_DELETE || deletes.length === 0)) {
    log('green', '\n✅ Nada a fazer — DB já sincronizado.');
    return;
  }

  await admin.auth.signInWithPassword({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });

  log('yellow', '\n⚠ Vou aplicar essas mudanças no DB.');
  const ok = await prompt('   Confirma? (digite "yes"): ');
  if (!ok) { log('red', '   cancelado.'); process.exit(1); }

  // ===== Apply =====
  let okAdd = 0, errAdd = 0;
  log('blue', '\n[ADDS] inserindo novos players em lotes...');
  for (let i = 0; i < adds.length; i += 100) {
    const batch = adds.slice(i, i + 100);
    const { error } = await admin.from('players').insert(batch);
    if (error) { errAdd += batch.length; log('red', `   ✗ batch ${i}: ${error.message}`); }
    else okAdd += batch.length;
  }
  log('green', `   ✓ ${okAdd} adicionados${errAdd ? ' / ✗ ' + errAdd + ' falharam' : ''}`);

  let okUpd = 0, errUpd = 0;
  log('blue', '\n[UPDATES] atualizando número/posição...');
  for (const u of updates) {
    const { error } = await admin.from('players')
      .update({ shirt_number: u.shirt_number, position: u.position })
      .eq('id', u.id);
    if (error) { errUpd++; log('red', `   ✗ ${u.full_name}: ${error.message}`); }
    else okUpd++;
  }
  log('green', `   ✓ ${okUpd} atualizados${errUpd ? ' / ✗ ' + errUpd + ' falharam' : ''}`);

  if (!NO_DELETE && deletes.length) {
    log('blue', '\n[DELETES] removendo cortados...');
    const ids = deletes.map((d) => d.id);
    let okDel = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const { error } = await admin.from('players').delete().in('id', batch);
      if (error) log('red', `   ✗ batch ${i}: ${error.message}`);
      else okDel += batch.length;
    }
    log('green', `   ✓ ${okDel} removidos`);
  }

  // ===== Final =====
  const finalCount = await loadAll('players', 'id');
  log('blue', '\n📊 Estado final:');
  log('green', `   Total players no DB: ${finalCount.length}`);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });

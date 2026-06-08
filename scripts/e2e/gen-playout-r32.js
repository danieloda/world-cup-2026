#!/usr/bin/env node
/**
 * gen-playout-r32.js — gera um playout PARCIAL: finaliza só GRUPOS (1-72) + 32-avos
 * (73-88), deixando oitavas em diante ABERTAS. Resultado: os 32-avos ficam com placar
 * oficial e os slots das oitavas resolvem pra times reais (estado ideal pra ver a tela
 * de mata-mata unificada — uns jogos com resultado, outros ainda a palpitar).
 *
 * Lê o oráculo (expected-tournament.json) e a data dos jogos do DB LOCAL (ordem
 * cronológica → cascata de slots). Emite scripts/e2e/playout-r32.sql.
 *
 * Uso (com env local carregado): node scripts/e2e/gen-playout-r32.js
 */
import { makeAdminClient } from './lib/admin-client.js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// --max=N limita os jogos finalizados (default 88 = grupos+r32). --out=arquivo.sql.
const argMax = process.argv.find(a => a.startsWith('--max='));
const argOut = process.argv.find(a => a.startsWith('--out='));
const MAX_ID = argMax ? parseInt(argMax.split('=')[1], 10) : 88;
const OUT_NAME = argOut ? argOut.split('=')[1] : 'playout-r32.sql';

const admin = makeAdminClient();
const oracle = JSON.parse(readFileSync(join(__dirname, 'expected-tournament.json'), 'utf8'));

const { data: rows, error } = await admin
  .from('matches').select('id, match_date').lte('id', MAX_ID);
if (error) throw error;
const dateById = new Map(rows.map((r) => [r.id, r.match_date]));

const sel = oracle.matches.filter((m) => m.id <= MAX_ID);
sel.sort((a, b) => new Date(dateById.get(a.id)) - new Date(dateById.get(b.id)));

const upd = sel.map((m) => {
  const pen = m.pen_winner ? `'${m.pen_winner}'` : 'null';
  return `update public.matches set actual_home=${m.actual_home}, actual_away=${m.actual_away}, pen_winner=${pen}, finished=true, status='finished', finished_at=now() where id=${m.id};`;
});

const goalsRows = [];
for (const m of sel) for (const s of (m.scorers || [])) goalsRows.push(`(${s.player_id}, ${m.id}, ${s.goals})`);

// Liga/desliga dinamicamente QUALQUER trigger de alerta (trg_z_alert_*), robusto
// ao conjunto de migrations aplicado no DB local. Os de NEGÓCIO ficam ligados.
const toggleAlerts = (action) => `do $$
declare t record;
begin
  for t in select tgname from pg_trigger where tgrelid='public.matches'::regclass and tgname like 'trg_z_alert%' and not tgisinternal loop
    execute format('alter table public.matches ${action} trigger %I', t.tgname);
  end loop;
end $$;`;

const sql = [
  '-- playout-r32.sql — playout PARCIAL: finaliza só grupos + 32-avos (ids 1-88).',
  '-- Oitavas+ ficam abertas. Gerado por gen-playout-r32.js.',
  '-- Aplicar: docker exec -i supabase_db_world-cup-2026 psql -U postgres -d postgres < scripts/e2e/playout-r32.sql',
  'begin;',
  toggleAlerts('disable'),
  '-- ordem cronológica → slots dos r32/oitavas resolvem na cascata:',
  ...upd,
  toggleAlerts('enable'),
  goalsRows.length ? `insert into public.player_goals (player_id, match_id, goals) values\n  ${goalsRows.join(',\n  ')}\n  on conflict (player_id, match_id) do update set goals=excluded.goals;` : '',
  'commit;',
].join('\n');

writeFileSync(join(__dirname, OUT_NAME), sql);
console.log(`✅ ${OUT_NAME} gerado — ${upd.length} jogos finalizados (1-${MAX_ID}), ${goalsRows.length} linhas de gols`);

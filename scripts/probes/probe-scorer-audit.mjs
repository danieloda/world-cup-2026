// Probe READ-ONLY (prod): trilha de auditoria de palpite de artilheiro.
// Template pra disputas "escolhi X, virou Y" — caso Kane→Madueke (jun/2026)
// era o 2º tap da própria sessão do usuário, provado por prediction_audit.
// Uso: node scripts/probes/probe-scorer-audit.mjs
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createClient } from '@supabase/supabase-js';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes no .env');

const db = createClient(url, key, { auth: { persistSession: false } });

const fail = (label, error) => { throw new Error(`${label}: ${error.message}`); };

// 1) Linhas de players da Inglaterra (Kane / Madueke) — id serial, api_player_id, nome atual
{
  const { data, error } = await db
    .from('players')
    .select('id, full_name, team, position, shirt_number, api_player_id')
    .eq('team', 'England')
    .or('full_name.ilike.%kane%,full_name.ilike.%madueke%');
  if (error) fail('players', error);
  console.log('=== players (England: Kane/Madueke) ===');
  console.table(data);
}

// 2) Todos os palpites de artilheiro atuais + jogador + dono
{
  const { data, error } = await db
    .from('top_scorer_picks')
    .select('user_id, player_id, created_at, updated_at, players(id, full_name, team, api_player_id), profiles(full_name)')
    .order('created_at', { ascending: true });
  if (error) fail('top_scorer_picks', error);
  console.log('\n=== top_scorer_picks (todos) ===');
  for (const r of data) {
    console.log([
      r.profiles?.full_name ?? r.user_id,
      `player_id=${r.player_id}`,
      `${r.players?.full_name} (${r.players?.team}, api=${r.players?.api_player_id})`,
      `created=${r.created_at}`,
      `updated=${r.updated_at}`,
    ].join(' | '));
  }
}

// 3) Trilha de auditoria completa dos scorer picks (ordem cronológica)
{
  const { data, error } = await db
    .from('prediction_audit')
    .select('id, op, row_user_id, old_data, new_data, changed_by, actor_is_admin, at')
    .eq('table_name', 'top_scorer_picks')
    .order('at', { ascending: true });
  if (error) fail('prediction_audit', error);
  console.log(`\n=== prediction_audit (top_scorer_picks) — ${data.length} eventos ===`);
  for (const r of data) {
    const oldPid = r.old_data?.player_id ?? '—';
    const newPid = r.new_data?.player_id ?? '—';
    console.log([
      r.at,
      r.op.padEnd(6),
      `user=${r.row_user_id}`,
      `player_id ${oldPid} -> ${newPid}`,
      `changed_by=${r.changed_by ?? 'NULL(migration/admin-sql)'}`,
      `admin=${r.actor_is_admin}`,
    ].join(' | '));
  }
}

// 4) Nomes dos donos dos palpites (mapa user_id -> nome) p/ leitura do audit
{
  const { data, error } = await db
    .from('top_scorer_picks')
    .select('user_id, profiles(full_name)');
  if (error) fail('profiles-map', error);
  console.log('\n=== mapa user -> nome ===');
  for (const r of data) console.log(`${r.user_id} = ${r.profiles?.full_name}`);
}

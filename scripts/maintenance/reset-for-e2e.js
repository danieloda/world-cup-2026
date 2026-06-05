#!/usr/bin/env node
/**
 * Reseta o DB pro estado inicial pré-teste E2E.
 *
 * O QUE FAZ:
 *   - Apaga todas predictions, champion_picks, top_scorer_picks, player_goals
 *   - Apaga profiles NÃO-admin (admin é preservado)
 *   - Restaura matches.team_home/team_away pros slots originais (W73, 1A, etc)
 *   - Zera matches.actual_home/away, pen_winner, finished, finished_at
 *   - Opcionalmente limpa alert_log (--clear-logs)
 *
 * O QUE NÃO TOCA:
 *   - matches.team_home/away quando não há slot (jogos de grupo)
 *   - players
 *   - settings (deadline, fee, prize_split, edge_anon_key)
 *   - auth.users (uso emails timestamped pra evitar conflito)
 *
 * Uso:
 *   node scripts/reset-for-e2e.js --dry-run        # mostra o que faria
 *   node scripts/reset-for-e2e.js                  # roda de verdade (pede confirmação)
 *   node scripts/reset-for-e2e.js --force          # sem confirmação
 *   node scripts/reset-for-e2e.js --clear-logs     # também limpa alert_log
 *
 * IMPORTANTE: Usa SUPABASE_PUBLISHABLE_KEY. Login como admin é necessário
 * pra que as RLS policies permitam DELETE nas tabelas (admin tem bypass).
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const DRY_RUN = args['dry-run'] === true;
const FORCE = args.force === true;
const CLEAR_LOGS = args['clear-logs'] === true;

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const supabase = createClient(SUPABASE_URL, ANON_KEY);

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (color, msg) => console.log(`${C[color] || ''}${msg}${C.reset}`);

async function prompt(question) {
  if (FORCE) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'yes');
    });
  });
}

async function login() {
  log('blue', '🔐 Logando como admin...');
  const { error } = await supabase.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (error) throw new Error('Login falhou: ' + error.message);
  const { data: { user } } = await supabase.auth.getUser();
  log('green', `   ✓ Logado: ${ADMIN_EMAIL} (id=${user.id})`);
  return user;
}

async function snapshot() {
  const tables = ['predictions', 'champion_picks', 'top_scorer_picks', 'player_goals', 'profiles', 'matches', 'players', 'settings', 'alert_log'];
  const counts = {};
  for (const t of tables) {
    const { count } = await supabase.from(t).select('*', { count: 'exact', head: true });
    counts[t] = count ?? 0;
  }

  // Quantos matches estão "sujos" (com slot mas team_home/away já resolvido)
  const { data: dirty } = await supabase
    .from('matches')
    .select('id', { count: 'exact', head: false })
    .or('finished.eq.true,actual_home.not.is.null');
  counts.matches_finished = dirty?.length ?? 0;

  return counts;
}

function printSnapshot(label, snap) {
  log('blue', `\n📊 ${label}:`);
  for (const [k, v] of Object.entries(snap)) {
    const isExpectedNonZero = ['matches', 'players', 'settings'].includes(k);
    const willKeep = isExpectedNonZero;
    const color = v === 0 ? 'dim' : (willKeep ? 'green' : 'yellow');
    log(color, `   ${k.padEnd(25)} ${String(v).padStart(6)}`);
  }
}

async function findAdminId(user) {
  const { data } = await supabase.from('profiles').select('id, email').eq('email', ADMIN_EMAIL).single();
  if (!data) throw new Error(`Admin profile não encontrado pra email ${ADMIN_EMAIL}`);
  if (data.id !== user.id) {
    log('yellow', `   ⚠ admin auth.id (${user.id}) != profiles.id (${data.id})`);
  }
  return data.id;
}

async function resetTables(adminId) {
  log('blue', '\n🗑️  Apagando dados de teste...');

  if (DRY_RUN) {
    log('yellow', '   DRY-RUN, pulando deletes');
    return;
  }

  // 1. Limpa predictions/picks/goals via RPC admin (contorna RLS sem DELETE policy)
  const { data: cleanResult, error: rpcErr } = await supabase.rpc('admin_reset_picks');
  if (rpcErr) throw new Error('admin_reset_picks: ' + rpcErr.message);
  const r = cleanResult?.[0] ?? {};
  log('green', `   ✓ predictions: ${r.predictions_deleted ?? 0} apagados`);
  log('green', `   ✓ champion_picks: ${r.champion_picks_deleted ?? 0} apagados`);
  log('green', `   ✓ top_scorer_picks: ${r.scorer_picks_deleted ?? 0} apagados`);
  log('green', `   ✓ player_goals: ${r.player_goals_deleted ?? 0} apagados`);

  // 2. profiles (exceto admin) — apaga via API (RLS permite admin)
  const { error: profErr } = await supabase.from('profiles').delete().neq('id', adminId);
  if (profErr) throw new Error('profiles delete: ' + profErr.message);
  log('green', `   ✓ profiles non-admin: deletados (admin ${adminId.slice(0, 8)}... preservado)`);

  // 3. alert_log (opcional)
  if (CLEAR_LOGS) {
    const { error: alertErr } = await supabase.from('alert_log').delete().gte('id', 0);
    if (alertErr) {
      log('yellow', `   ⚠ alert_log delete falhou (RLS?): ${alertErr.message}`);
    } else {
      log('green', `   ✓ alert_log: deletado`);
    }
  }
}

async function resetMatches() {
  log('blue', '\n🔄 Restaurando matches pro estado inicial...');

  if (DRY_RUN) {
    log('yellow', '   DRY-RUN, pulando restore');
    return;
  }

  // Conta quantos têm slot_home/slot_away (= matches de mata-mata)
  const { data: koMatches } = await supabase
    .from('matches')
    .select('id, slot_home, slot_away, team_home, team_away')
    .or('slot_home.not.is.null,slot_away.not.is.null');

  log('blue', `   ${koMatches?.length ?? 0} matches de mata-mata (com slot)`);

  // Restaura team_home = slot_home WHERE slot_home IS NOT NULL
  // Via RPC ou direto? RLS pode bloquear UPDATE em matches pra non-admin.
  // Admin tem bypass — espero que funcione.

  // Faço em 2 statements pra evitar atualizar coluna que não mudou
  const { error: e1 } = await supabase.rpc('admin_reset_matches');
  if (e1) {
    // Se a função não existir, faço UPDATE direto
    if (e1.message.includes('does not exist') || e1.code === 'PGRST202') {
      log('yellow', '   admin_reset_matches() não existe, fazendo UPDATE direto');

      // Restore slots
      const { error: e2 } = await supabase
        .from('matches')
        .update({ team_home: undefined })  // placeholder — Supabase não suporta SET col = other_col
        .eq('id', -1);  // no-op
      // Não dá pra fazer assim. Vou precisar de RPC.

      throw new Error('Precisa criar a função public.admin_reset_matches() — veja README ou cria via SQL');
    }
    throw new Error('admin_reset_matches: ' + e1.message);
  }

  log('green', '   ✓ Matches resetados (slots restaurados, actual/finished zerados)');
}

async function main() {
  log('blue', `${C.bold}🔄 Reset DB pra teste E2E${C.reset}`);
  if (DRY_RUN) log('yellow', '   ★ MODO DRY-RUN ★');
  if (FORCE) log('yellow', '   ★ MODO FORCE (sem confirmação) ★');
  if (CLEAR_LOGS) log('yellow', '   ★ Vai apagar alert_log também ★');

  const user = await login();
  const adminId = await findAdminId(user);

  const before = await snapshot();
  printSnapshot('Estado ANTES', before);

  if (!DRY_RUN) {
    log('yellow', `\n⚠ Esta operação vai apagar dados. Admin (${ADMIN_EMAIL}) e dados de jogos/jogadores são preservados.`);
    const ok = await prompt('   Confirma? (digite "yes"): ');
    if (!ok) {
      log('red', '   ✗ Cancelado pelo usuário.');
      process.exit(1);
    }
  }

  await resetTables(adminId);
  await resetMatches();

  const after = await snapshot();
  printSnapshot('Estado DEPOIS', after);

  // Validação
  log('blue', '\n🔍 Validação:');
  const checks = [
    ['Profiles tem só admin', after.profiles === 1],
    ['Predictions zerou', after.predictions === 0],
    ['Champion picks zerou', after.champion_picks === 0],
    ['Top scorer picks zerou', after.top_scorer_picks === 0],
    ['Player goals zerou', after.player_goals === 0],
    ['Matches preservados (104)', after.matches === 104],
    ['Players preservados', after.players > 0],
    ['Settings preservadas', after.settings > 0],
    ['Matches finished=true zerou', after.matches_finished === 0],
  ];
  let allOk = true;
  for (const [name, ok] of checks) {
    log(ok ? 'green' : 'red', `   ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) allOk = false;
  }

  console.log('');
  if (allOk) {
    log('green', `${C.bold}✅ RESET COMPLETO. Pronto pra rodar E2E.${C.reset}`);
  } else {
    log('red', `${C.bold}⚠️  Algumas validações falharam. Veja acima.${C.reset}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});

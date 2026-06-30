#!/usr/bin/env node
/**
 * prod-parity-audit.mjs — Auditoria READ-ONLY: migrations 001–058 × PROD real.
 * ============================================================================
 * Prod aplica migrations à mão (SQL Editor) → drift é possível (aconteceu em
 * 2026-06-09: re-colagem da 039 revogou grants e derrubou o ranking). Este
 * script reconstrói o ESTADO FINAL esperado do repo e confere o que dá pra
 * observar via REST, sem executar NADA mutante:
 *   1. OpenAPI do PostgREST (service_role) → tabelas, colunas e RPCs expostos
 *   2. Sondas negativas → objetos DROPADOS não podem existir (029, 026, 053)
 *   3. Dados-sentinela → 104 jogos (por fase), 1249 players, 48 ranks FIFA
 *   4. settings → chaves semeadas + cron_lastrun_* (vivacidade do pg_cron, que
 *      não é legível via REST — os markers são a evidência)
 *   5. Comportamento → score_prediction prova 022+056; grants_health prova 040/057
 *   6. Storage → bucket avatars (016)
 *   7. Superfície anon (publishable key sem login) → deny-by-default vivo
 *
 * Triggers/event triggers/policies não são observáveis via REST → fora do
 * escopo (cobertos por test:rls e E2E no stack local).
 *
 * USO: node scripts/dev/prod-parity-audit.mjs    (credenciais do .env)
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { stageMultiplier } from '../../src/js/scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const URL = process.env.SUPABASE_URL;
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY;
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[34m', x: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m' };
let fails = 0, warns = 0;
const ok = (m) => console.log(`${C.g}  ✓ ${m}${C.x}`);
const bad = (m) => { fails++; console.log(`${C.r}  ✗ ${m}${C.x}`); };
const warn = (m) => { warns++; console.log(`${C.y}  ⚠ ${m}${C.x}`); };
const head = (m) => console.log(`\n${C.b}${C.bold}▶ ${m}${C.x}`);

if (!URL || !SR || !PUB) { console.error('credenciais ausentes no .env'); process.exit(2); }
if (/127\.0\.0\.1|localhost/.test(URL)) { console.error('URL é local — auditoria é p/ PROD.'); process.exit(2); }

const sr = createClient(URL, SR, { auth: { persistSession: false, autoRefreshToken: false } });
console.log(`${C.bold}🧾 Parity audit migrations 001–058 × PROD — ${URL}${C.x}`);

// ============================================================
// 1) OpenAPI do PostgREST: inventário do schema exposto
// ============================================================
head('[1] OpenAPI (service_role): tabelas, views e RPCs expostos');
const spec = await (await fetch(`${URL}/rest/v1/`, {
  headers: { apikey: SR, authorization: `Bearer ${SR}` },
})).json();
const defs = spec.definitions ?? {};
const paths = Object.keys(spec.paths ?? {});
const rpcs = new Set(paths.filter(p => p.startsWith('/rpc/')).map(p => p.slice(5)));
const rels = new Set(paths.filter(p => p !== '/' && !p.startsWith('/rpc/')).map(p => p.slice(1)));
console.log(`${C.dim}   ${rels.size} tabelas/views · ${rpcs.size} RPCs expostas${C.x}`);

// Tabelas/views do estado final (001..057)
const EXPECTED_RELS = {
  profiles: '001', matches: '001', predictions: '001', players: '001',
  champion_picks: '001', top_scorer_picks: '001', player_goals: '001', settings: '001',
  alert_log: '007', team_fifa_rank: '015', match_odds: '020', user_qualifier_points: '021',
  match_h2h: '027', team_h2h: '030', match_predictions: '032', prediction_audit: '035',
  client_errors: '047', v_leaderboard: '039', v_scorer_ranking: '039', v_pool_stats: '037',
};
for (const [rel, mig] of Object.entries(EXPECTED_RELS)) {
  rels.has(rel) ? ok(`${rel} (${mig})`) : bad(`${rel} AUSENTE (migration ${mig} não aplicada?)`);
}
// dropados — não podem existir
rels.has('team_history_stats')
  ? bad('team_history_stats ainda EXISTE (029 não aplicada)')
  : ok('team_history_stats fora (029)');

// Colunas-chave (ALTERs e shape de views, via definitions do OpenAPI)
const COLS = {
  matches: ['slot_home', 'slot_away', 'api_fixture_id', 'status', 'actual_home', 'pen_winner', 'finished'],
  profiles: ['avatar_url', 'paid', 'full_name'],
  players: ['api_player_id'],
  predictions: ['points_earned', 'pred_pen_winner'],
  client_errors: ['kind', 'message', 'stack', 'url', 'user_agent'],
  v_leaderboard: ['match_pts', 'champion_pts', 'scorer_pts', 'qualifier_pts', 'total_pts',
                  'exact_count', 'winner_sg_count', 'winner_count', 'side_count', 'miss_count'],
  v_scorer_ranking: ['player_name', 'player_team', 'goals', 'bonus_pts'],
  v_pool_stats: ['paid_users', 'total_users', 'total_pot', 'finished_matches', 'pct_played'],
};
for (const [rel, cols] of Object.entries(COLS)) {
  const have = Object.keys(defs[rel]?.properties ?? {});
  const missing = cols.filter(c => !have.includes(c));
  missing.length === 0
    ? ok(`${rel}: ${cols.length} colunas-chave presentes`)
    : bad(`${rel}: faltam colunas ${missing.join(', ')}`);
}
// PII fora do leaderboard (037)
(defs.v_leaderboard?.properties?.email)
  ? bad('v_leaderboard expõe EMAIL (regressão da 037)')
  : ok('v_leaderboard sem email (037)');

// RPCs do estado final
const EXPECTED_RPCS = {
  is_admin: '002', cs_deadline: '024', stage_multiplier: '058', score_prediction: '074',
  recompute_prediction_points: '039', champion_bonus_for: '039', scorer_bonus_for: '039',
  fifa_rank: '015', resolve_match_slots: '015', try_assign_thirds: '005', _backtrack_thirds: '015',
  qualifier_bonus_pts: '022', _backtrack_thirds_pred: '021', compute_predicted_slots: '021',
  qualifier_bonus_for: '021', recompute_qualifier_points: '021', prediction_deadline: '023',
  admin_pred_progress: '025', admin_reset_matches: '008', admin_reset_picks: '009',
  admin_confirm_test_emails: '010', admin_clear_result: '036', admin_list_profiles: '038',
  admin_set_match_status: '039', send_alert: '045', check_auth_failures: '007', test_alert: '007',
  report_signup_failure: '019', mark_cron_run: '026', _site_url: '033', _fmt_int: '026',
  _pix_key: '026', _days_to_cs_deadline: '026', cron_alert_daily_payments: '044',
  cron_alert_group_completeness: '055', cron_alert_cs_completeness: '043',
  cron_alert_deadline_countdown: '043', cron_alert_daily_recap: '053', cron_heartbeat: '026',
  _is_slot: '042', _stage_label: '042', _milestone_seen: '042', _mark_milestone: '042',
  cron_alert_leader_change: '053', cron_alert_group_stage_done: '053', cron_alert_pool_settled: '053',
  cron_alert_client_errors_digest: '049', _historico_url: '053', _stage_max_pts: '053',
  _match_pts_remaining_pct: '053', cron_check_job_failures: '053', grants_health: '057',
};
{
  const missing = Object.entries(EXPECTED_RPCS).filter(([fn]) => !rpcs.has(fn));
  missing.length === 0
    ? ok(`${Object.keys(EXPECTED_RPCS).length} funções RPC esperadas — todas expostas`)
    : missing.forEach(([fn, mig]) => bad(`rpc ${fn} AUSENTE (migration ${mig})`));
}
// dropadas (026/053) — não podem existir
const DROPPED_RPCS = ['alert_champion_change', 'alert_scorer_change', 'alert_picks_complete',
  'cron_alert_pick_activity', 'cron_alert_daily_digest', 'alert_result_corrected',
  'alert_champion_revealed', 'alert_ko_phase_opens', 'cron_alert_lock_tonight',
  'cron_alert_round_movers', 'cron_alert_inactive_paid'];
{
  const ghosts = DROPPED_RPCS.filter(fn => rpcs.has(fn));
  ghosts.length === 0
    ? ok('nenhuma função dropada (026/053) sobrevive')
    : ghosts.forEach(fn => bad(`rpc ${fn} ainda EXISTE (drop da 026/053 não aplicado)`));
}

// ============================================================
// 2) Dados-sentinela
// ============================================================
head('[2] Dados-sentinela (estrutura do torneio + cargas)');
const count = async (t, filter) => {
  let q = sr.from(t).select('*', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  return error ? { err: error.message } : { n };
};
const expectCount = async (label, t, expected, filter) => {
  const r = await count(t, filter);
  if (r.err) return bad(`${label}: ${r.err.slice(0, 60)}`);
  r.n === expected ? ok(`${label} = ${expected}`) : bad(`${label}: esperado ${expected}, prod tem ${r.n}`);
};
await expectCount('matches', 'matches', 104);
for (const [stage, n] of [['group', 72], ['r32', 16], ['r16', 8], ['qf', 4], ['sf', 2], ['third', 1], ['final', 1]]) {
  await expectCount(`matches stage=${stage}`, 'matches', n, q => q.eq('stage', stage));
}
await expectCount('players (052+overrides 06-09)', 'players', 1249);
await expectCount('team_fifa_rank (015/018)', 'team_fifa_rank', 48);
{
  const r = await count('matches', q => q.eq('finished', true));
  r.n === 0 ? ok('nenhum jogo finished (pré-Copa — correto)') : warn(`${r.n} jogo(s) finished=true ANTES da estreia — verificar`);
  const v = await count('matches', q => q.neq('status', 'scheduled'));
  v.n === 0 ? ok("todos os jogos status='scheduled' (039)") : warn(`${v.n} jogo(s) com status≠scheduled pré-Copa`);
}

// ============================================================
// 3) settings: chaves semeadas + vivacidade do pg_cron
// ============================================================
head('[3] settings (seeds das migrations + markers de cron)');
const { data: settings, error: se } = await sr.from('settings').select('key, value, updated_at');
if (se) bad(`settings: ${se.message}`);
const sMap = new Map((settings ?? []).map(r => [r.key, r]));
for (const [key, mig] of [['fee_amount', '001/admin'], ['pix_key', '026'], ['site_url', '033'],
  ['prize_split', '042'], ['deadline_champion_scorer', 'admin']]) {
  sMap.has(key) ? ok(`setting ${key} (${mig})`) : bad(`setting ${key} AUSENTE (${mig})`);
}
{
  const su = JSON.stringify(sMap.get('site_url')?.value ?? '');
  su.includes('superbolaocopa.netlify.app')
    ? ok('site_url aponta pro domínio atual (033)')
    : bad(`site_url divergente da 033: ${su}`);
}
// pg_cron não é legível via REST → cron_lastrun_* é a prova de vida.
// Diários ativos (026/042/053) marcam SEMPRE (mesmo no early-return) → ≤26h.
// cron_heartbeat NÃO se marca (dead-man-switch dos outros) — sem marker, por design.
// group_stage_done/pool_settled só marcam DEPOIS do milestone → ausência pré-Copa = ok.
const now = Date.now();
const markerAgeH = (row) => (now - new Date(String(row.value).replace(/"/g, '')).getTime()) / 3.6e6;
// Ativos pós-059: group_completeness, daily_recap, leader_change marcam SEMPRE → ≤26h.
// (daily_payments/cs_completeness DESLIGADOS na 059; deadline_countdown se auto-silencia
//  pós-prazo de campeão/artilheiro — tratados no bloco de desagendados abaixo.)
for (const name of ['group_completeness', 'daily_recap', 'leader_change']) {
  const row = sMap.get(`cron_lastrun_${name}`);
  if (!row) { bad(`cron alerts_${name}: nunca rodou (sem marker) — job não agendado?`); continue; }
  const ageH = markerAgeH(row);
  Number.isFinite(ageH) && ageH <= 26
    ? ok(`cron alerts_${name}: rodou há ${ageH.toFixed(1)}h`)
    : bad(`cron alerts_${name}: último run há ${Number.isFinite(ageH) ? ageH.toFixed(1) + 'h' : '?'} (esperado ≤26h) — pg_cron caiu?`);
}
for (const name of ['group_stage_done', 'pool_settled']) {
  const row = sMap.get(`cron_lastrun_${name}`);
  row ? ok(`cron alerts_${name}: marker presente (pós-milestone)`)
      : ok(`cron alerts_${name}: sem marker pré-milestone (só marca após o evento — ok)`);
}
// Desagendados na 053: não podem ter rodado no ÚLTIMO slot diário (~12:15 UTC).
// Marker mais velho que o último slot = parado (a data absoluta depende de
// quando a 053 foi aplicada, então comparamos com o slot, não com idade fixa).
const lastSlot = new Date(now); lastSlot.setUTCHours(12, 15, 0, 0);
if (lastSlot.getTime() > now) lastSlot.setUTCDate(lastSlot.getUTCDate() - 1);
const hSinceSlot = (now - lastSlot.getTime()) / 3.6e6;
for (const name of ['lock_tonight', 'round_movers', 'inactive_paid']) {
  const row = sMap.get(`cron_lastrun_${name}`);
  if (!row) { ok(`cron alerts_${name}: sem marker (desagendado na 053)`); continue; }
  const ageH = markerAgeH(row);
  ageH > hSinceSlot
    ? ok(`cron alerts_${name}: não roda desde ${(ageH / 24).toFixed(1)}d (desagendado, 053 ok)`)
    : bad(`cron alerts_${name} RODOU há ${ageH.toFixed(1)}h (depois do último slot) — deveria estar desagendado (053)`);
}
// Desligados na 059 (pedido do organizador, 2026-06-11): daily_payments e
// cs_completeness foram unscheduled; deadline_countdown se cala sozinho pós-prazo
// de campeão/artilheiro. Marker parado (mais velho que o último slot) = correto.
for (const name of ['daily_payments', 'cs_completeness', 'deadline_countdown']) {
  const row = sMap.get(`cron_lastrun_${name}`);
  if (!row) { ok(`cron alerts_${name}: sem marker (desligado na 059)`); continue; }
  const ageH = markerAgeH(row);
  ageH > hSinceSlot
    ? ok(`cron alerts_${name}: parado há ${(ageH / 24).toFixed(1)}d (desligado/silenciado na 059 — ok)`)
    : bad(`cron alerts_${name} RODOU há ${ageH.toFixed(1)}h (depois do último slot) — deveria estar desligado (059)`);
}
// pipeline de alertas vivo
{
  const { data: lastAlert } = await sr.from('alert_log').select('created_at, category').order('created_at', { ascending: false }).limit(1);
  lastAlert?.length
    ? ok(`alert_log vivo — último: ${lastAlert[0].category} em ${lastAlert[0].created_at}`)
    : warn('alert_log vazio');
}

// ============================================================
// 4) Comportamento: engine de pontuação (022+056) e grants (040/057)
// ============================================================
head('[4] Comportamento observável (RPCs imutáveis/stable)');
{
  // 056: cravou o placar do tempo normal = exato CHEIO mesmo errando o pênalti.
  // r16: ag=3 (×2 lados) + ave=12 + dg=1 = 19. Engine antiga (022) daria 7.
  const { data, error } = await sr.rpc('score_prediction', { ph: 2, pa: 2, p_pen: 'home', ah: 2, aw: 2, a_pen: 'away', stage: 'r16' });
  if (error) bad(`score_prediction: ${error.message}`);
  else if (data === 19) ok('score_prediction R16 2x2 pên. errado = 19 → 056/074 APLICADA');
  else if (data === 7) bad('score_prediction R16 2x2 pên. errado = 7 → engine ANTIGA (056 NÃO aplicada)');
  else bad(`score_prediction R16 2x2 = ${data} (esperado 19) — engine divergente`);
  // 074: acertou o EMPATE sem cravar, pênalti errado (2-2 vs 1-1) → ave+dg = 13.
  // Engine 056 (sem 074) daria só dg = 1 (o bug Países Baixos×Marrocos).
  const { data: d74 } = await sr.rpc('score_prediction', { ph: 2, pa: 2, p_pen: 'home', ah: 1, aw: 1, a_pen: 'away', stage: 'r16' });
  d74 === 13 ? ok('score_prediction R16 2x2 vs 1x1 pên. errado = 13 → 074 APLICADA (empate vale resultado)')
    : d74 === 1 ? bad('score_prediction R16 2x2 vs 1x1 pên. errado = 1 → engine PRÉ-074 (empate ainda perde o resultado)')
    : bad(`score_prediction R16 2x2 vs 1x1 = ${d74} (esperado 13) — engine divergente`);
  // 022 sanidade: grupos 2x1 cravado = 1+1+4+1 = 7
  const { data: g } = await sr.rpc('score_prediction', { ph: 2, pa: 1, p_pen: null, ah: 2, aw: 1, a_pen: null, stage: 'group' });
  g === 7 ? ok('score_prediction grupos exato = 7 (modelo aditivo 022)') : bad(`score_prediction grupos exato = ${g} (esperado 7)`);
  // Todos os 7 multiplicadores do artilheiro × scoring.js (canônico).
  // Drift real achado aqui em 2026-06-09: prod tinha a 003 ORIGINAL (qf 2.5,
  // sf 3, final 4) — a 003 foi editada no repo sem re-aplicar. Fix: 058.
  const mDrift = [];
  for (const s of ['group', 'r32', 'r16', 'qf', 'sf', 'third', 'final']) {
    const { data: m, error: me2 } = await sr.rpc('stage_multiplier', { stage: s });
    if (me2) { mDrift.push(`${s}: ${me2.message}`); continue; }
    if (Number(m) !== stageMultiplier(s)) mDrift.push(`${s}: prod=${m} canônico=${stageMultiplier(s)}`);
  }
  mDrift.length === 0
    ? ok('stage_multiplier: 7/7 fases batem com scoring.js (058)')
    : bad(`stage_multiplier DIVERGE (aplicar 058): ${mDrift.join(' · ')}`);
}
{
  const MUST_FALSE = /^(score_prediction|recompute_prediction_points|compute_predicted_slots)__/;
  const { data, error } = await sr.rpc('grants_health');
  if (error) bad(`grants_health: ${error.message} (057 aplicada?)`);
  else {
    const wrong = Object.entries(data).filter(([k, v]) => (MUST_FALSE.test(k) ? v !== false : v !== true));
    wrong.length === 0
      ? ok('grants_health 9/9 — trio do leaderboard concedido, sensíveis trancadas (034/040/057)')
      : wrong.forEach(([k, v]) => bad(`grants_health: ${k} = ${v}`));
  }
}

// ============================================================
// 5) Storage (016)
// ============================================================
head('[5] Storage');
{
  const buckets = await (await fetch(`${URL}/storage/v1/bucket`, {
    headers: { apikey: SR, authorization: `Bearer ${SR}` },
  })).json();
  const av = Array.isArray(buckets) ? buckets.find(b => b.id === 'avatars') : null;
  av ? ok(`bucket avatars existe (public=${av.public}) (016)`) : bad('bucket avatars AUSENTE (016)');
}

// ============================================================
// 6) Superfície anon (publishable key, SEM login) — deny-by-default
// ============================================================
head('[6] Superfície anon (o que um visitante deslogado alcança)');
const anon = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } });
for (const t of ['profiles', 'predictions', 'champion_picks', 'top_scorer_picks', 'client_errors', 'settings']) {
  const { data, error } = await anon.from(t).select('*').limit(1);
  if (error) ok(`anon ${t}: bloqueado (${error.code ?? error.message.slice(0, 30)})`);
  else if ((data ?? []).length === 0) ok(`anon ${t}: RLS devolve vazio`);
  else bad(`anon ${t}: VAZA ${data.length} linha(s)!`);
}
{
  const { error } = await anon.from('v_leaderboard').select('*').limit(1);
  error ? ok(`anon v_leaderboard: bloqueado (grant só authenticated)`) : bad('anon v_leaderboard: ACESSÍVEL sem login');
  const { error: e2 } = await anon.rpc('score_prediction', { ph: 1, pa: 0, p_pen: null, ah: 1, aw: 0, a_pen: null, stage: 'group' });
  e2 ? ok('anon score_prediction: bloqueada (034)') : bad('anon score_prediction: EXECUTÁVEL (revoke da 034 perdido)');
}

// ============================================================
console.log(`\n${C.bold}${fails === 0
  ? C.g + `✅ PARIDADE OK — prod reflete as migrations 001–058${warns ? ` (${warns} aviso(s))` : ''}`
  : C.r + `❌ ${fails} divergência(s) entre prod e as migrations — ver acima`}${C.x}`);
console.log(`${C.dim}   Não verificável via REST (cobrir no stack local): triggers, policies RLS em si,
   event trigger ensure_rls (046), corpo das funções de alerta, schedules exatos do pg_cron.
   (nenhuma escrita foi feita em produção)${C.x}`);
process.exit(fails === 0 ? 0 : 1);

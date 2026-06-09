#!/usr/bin/env node
/**
 * verify-data.mjs — Auditoria de CORREÇÃO dos dados que a UI mostra.
 * ============================================================================
 * Recomputa INDEPENDENTE (via src/js/scoring.js, o módulo-fonte) a pontuação de
 * TODOS os usuários a partir dos palpites + resultados do banco e compara com o
 * que o banco/v_leaderboard guardou (= o que a UI exibe). Também confere os
 * resultados contra o oráculo. NÃO escreve nada — só lê e reporta.
 *
 * Uso: set -a; source .env.e2e.local; set +a; node scripts/dev/verify-data.mjs
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { makeAdminClient } from '../e2e/lib/admin-client.js';
import { scorePrediction, scorerBonus, stageMultiplier } from '../../src/js/scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const admin = makeAdminClient();
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[34m', x: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m' };
const ok = (m) => console.log(`${C.g}  ✓ ${m}${C.x}`);
const bad = (m) => console.log(`${C.r}  ✗ ${m}${C.x}`);
const head = (m) => console.log(`\n${C.b}${C.bold}▶ ${m}${C.x}`);

async function pageAll(table, cols, orderCol = 'id') {
  let rows = [], from = 0;
  for (;;) {
    const { data, error } = await admin.from(table).select(cols).order(orderCol, { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows = rows.concat(data); if (data.length < 1000) break; from += 1000;
  }
  return rows;
}

console.log(`${C.bold}🔎 Auditoria de dados (UI ↔ recompute independente)${C.x}`);
console.log(`${C.dim}   url=${process.env.SUPABASE_URL}${C.x}`);

// ---- carrega tudo ----
const { data: matches } = await admin.from('matches').select('id, stage, team_home, team_away, actual_home, actual_away, pen_winner, finished').order('id');
const matchById = new Map(matches.map((m) => [m.id, m]));
const preds = await pageAll('predictions', 'user_id, match_id, pred_home, pred_away, pred_pen_winner, points_earned', 'id');
const goals = await pageAll('player_goals', 'player_id, match_id, goals', 'id');
const scorerPicks = await pageAll('top_scorer_picks', 'user_id, player_id', 'user_id');
const champPicks = await pageAll('champion_picks', 'user_id, team', 'user_id');
const uqp = await pageAll('user_qualifier_points', 'user_id, points', 'user_id');
const { data: profiles } = await admin.from('profiles').select('id, full_name, paid');
const { data: lb } = await admin.from('v_leaderboard').select('*');
const oracle = JSON.parse(readFileSync(join(__dirname, '..', 'e2e', 'expected-tournament.json'), 'utf8'));
const oracleById = new Map(oracle.matches.map((m) => [m.id, m]));

console.log(`${C.dim}   ${matches.length} jogos · ${preds.length} palpites · ${profiles.length} perfis · ${lb.length} no ranking${C.x}`);

let fail = 0;

// ============================================================
// 1) RESULTADOS do banco == oráculo (nos jogos finalizados)
// ============================================================
head('1. Resultados oficiais (banco × oráculo)');
let resMiss = 0;
for (const m of matches.filter((x) => x.finished)) {
  const o = oracleById.get(m.id);
  if (!o) { resMiss++; if (resMiss <= 5) bad(`M${m.id}: sem entrada no oráculo`); continue; }
  if (m.actual_home !== o.actual_home || m.actual_away !== o.actual_away || (m.pen_winner ?? null) !== (o.pen_winner ?? null)) {
    resMiss++; if (resMiss <= 5) bad(`M${m.id}: banco ${m.actual_home}-${m.actual_away}/${m.pen_winner} ≠ oráculo ${o.actual_home}-${o.actual_away}/${o.pen_winner}`);
  }
}
resMiss === 0 ? ok(`${matches.filter((x) => x.finished).length} jogos finalizados batem com o oráculo`) : bad(`${resMiss} divergências de resultado`);
fail += resMiss;

// ============================================================
// 2) points_earned por palpite == scorePrediction() independente
//    (valida o trigger SQL de scoring p/ TODOS os usuários)
// ============================================================
head('2. Pontos por palpite (banco × recompute independente) — todos os usuários');
let chk = 0, predMiss = 0, leakMiss = 0;
const sample = [];
for (const p of preds) {
  const m = matchById.get(p.match_id);
  if (!m) continue;
  if (!m.finished) {
    // jogo não finalizado → não pode ter pontos
    if (p.points_earned != null) { leakMiss++; if (leakMiss <= 5) bad(`u=${p.user_id.slice(0, 8)} M${p.match_id}: points_earned=${p.points_earned} num jogo NÃO finalizado`); }
    continue;
  }
  chk++;
  const expected = scorePrediction(p.pred_home, p.pred_away, p.pred_pen_winner, m.actual_home, m.actual_away, m.pen_winner, m.stage);
  const got = p.points_earned ?? 0;
  if (expected !== got) {
    predMiss++;
    if (predMiss <= 10) bad(`u=${p.user_id.slice(0, 8)} M${p.match_id} (${m.stage}): palpite ${p.pred_home}-${p.pred_away}/${p.pred_pen_winner} vs ${m.actual_home}-${m.actual_away}/${m.pen_winner} → esperado ${expected}, banco ${got}`);
  } else if (sample.length < 3 && expected > 0) {
    sample.push(`M${p.match_id} ${m.stage}: ${p.pred_home}-${p.pred_away} vs ${m.actual_home}-${m.actual_away} = ${expected}pts`);
  }
}
predMiss === 0 ? ok(`${chk} palpites pontuados conferem (recompute == banco)`) : bad(`${predMiss}/${chk} palpites com pontuação ERRADA`);
leakMiss === 0 ? ok('nenhum ponto vazado em jogo não finalizado') : bad(`${leakMiss} pontos em jogos abertos`);
if (sample.length) console.log(`${C.dim}     amostra ok: ${sample.join(' · ')}${C.x}`);
fail += predMiss + leakMiss;

// ============================================================
// 3) v_leaderboard por usuário == recompute independente
//    match_pts, scorer_pts, champion_pts, qualifier_pts, total_pts
// ============================================================
head('3. Ranking por usuário (v_leaderboard × recompute) — todos os pagantes');
// índices
const predsByUser = new Map();
for (const p of preds) { (predsByUser.get(p.user_id) ?? predsByUser.set(p.user_id, []).get(p.user_id)).push(p); }
const goalsByMatch = new Map();
for (const g of goals) { (goalsByMatch.get(g.match_id) ?? goalsByMatch.set(g.match_id, []).get(g.match_id)).push(g); }
const scorerByUser = new Map(scorerPicks.map((s) => [s.user_id, s.player_id]));
const qualByUser = new Map(uqp.map((q) => [q.user_id, q.points]));
const realChampion = oracle.champion;
const finalFinished = matches.find((m) => m.stage === 'final')?.finished;

let lbMiss = 0, checkedUsers = 0;
const cols = { match: 0, scorer: 0, champ: 0, qual: 0, total: 0 };
for (const row of lb) {
  checkedUsers++;
  const uid = row.user_id;
  const myPreds = predsByUser.get(uid) ?? [];
  // match_pts: soma dos pontos recomputados nos jogos finalizados
  let matchPts = 0;
  for (const p of myPreds) {
    const m = matchById.get(p.match_id);
    if (m?.finished) matchPts += scorePrediction(p.pred_home, p.pred_away, p.pred_pen_winner, m.actual_home, m.actual_away, m.pen_winner, m.stage);
  }
  // scorer_pts: gols do jogador escolhido × 2 × mult de fase, nos jogos finalizados
  let scorerPts = 0;
  const pickPid = scorerByUser.get(uid);
  if (pickPid) {
    for (const m of matches) {
      if (!m.finished) continue;
      const g = (goalsByMatch.get(m.id) ?? []).find((x) => x.player_id === pickPid);
      if (g?.goals) scorerPts += scorerBonus(g.goals, m.stage);
    }
  }
  // champion_pts: 40 se acertou o campeão E a final acabou; senão 0
  const champTeam = champPicks.find((c) => c.user_id === uid)?.team;
  const champPts = (finalFinished && champTeam === realChampion) ? 40 : 0;
  // qualifier: cache (validado à parte); confiro consistência view↔cache
  const qualCache = qualByUser.get(uid) ?? 0;
  const expectedTotal = matchPts + scorerPts + champPts + qualCache;

  const diffs = [];
  if (row.match_pts !== matchPts) { diffs.push(`match ${row.match_pts}≠${matchPts}`); cols.match++; }
  if (row.scorer_pts !== scorerPts) { diffs.push(`scorer ${row.scorer_pts}≠${scorerPts}`); cols.scorer++; }
  if (row.champion_pts !== champPts) { diffs.push(`champ ${row.champion_pts}≠${champPts}`); cols.champ++; }
  if (row.qualifier_pts !== qualCache) { diffs.push(`qual(view≠cache) ${row.qualifier_pts}≠${qualCache}`); cols.qual++; }
  if (row.total_pts !== expectedTotal) { diffs.push(`TOTAL ${row.total_pts}≠${expectedTotal}`); cols.total++; }
  if (diffs.length) { lbMiss++; if (lbMiss <= 10) bad(`${(row.full_name || uid).padEnd(22)} ${diffs.join(' · ')}`); }
}
lbMiss === 0
  ? ok(`${checkedUsers} usuários do ranking conferem (match/scorer/champ/qual/total)`)
  : bad(`${lbMiss}/${checkedUsers} usuários com divergência — por coluna: ${JSON.stringify(cols)}`);
fail += lbMiss;

// ============================================================
// 4) Sanidades extras
// ============================================================
head('4. Sanidades');
// 4a. ranking só tem pagantes
const paidIds = new Set(profiles.filter((p) => p.paid).map((p) => p.id));
const nonPaidInLb = lb.filter((r) => !paidIds.has(r.user_id)).length;
nonPaidInLb === 0 ? ok('v_leaderboard só tem pagantes') : bad(`${nonPaidInLb} não-pagantes no ranking`);
// 4b. ordenação do ranking (desc por total)
let sorted = true;
for (let i = 1; i < lb.length; i++) if (lb[i - 1].total_pts < lb[i].total_pts) { sorted = false; break; }
sorted ? ok('ranking ordenado por total_pts desc') : bad('ranking FORA de ordem');
// 4c. champion zerado p/ todos (final não jogada)
const champNonzero = lb.filter((r) => r.champion_pts !== 0).length;
(!finalFinished ? champNonzero === 0 : true) ? ok(`champion_pts=0 p/ todos (final ${finalFinished ? 'jogada' : 'não jogada'})`) : bad(`${champNonzero} com champion_pts≠0 sem final`);
// 4d. máximo teórico de placar nos jogos JÁ jogados (oráculo perfeito) como teto
let teto = 0;
for (const m of matches.filter((x) => x.finished)) { teto += scorePrediction(m.actual_home, m.actual_away, m.pen_winner, m.actual_home, m.actual_away, m.pen_winner, m.stage); }
const maxMatch = Math.max(...lb.map((r) => r.match_pts));
maxMatch <= teto ? ok(`líder de placar ${maxMatch} ≤ teto ${teto} (placar perfeito dos jogos jogados)`) : bad(`líder ${maxMatch} > teto ${teto} (impossível!)`);

// ============================================================
console.log(`\n${C.bold}${fail === 0 ? C.g + '✅ TUDO CONFERE — a UI mostra dados corretos p/ todos os usuários.' : C.r + `❌ ${fail} divergência(s) — ver acima.`}${C.x}`);
process.exit(fail === 0 ? 0 : 1);

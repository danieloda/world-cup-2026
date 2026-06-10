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
import { scorePrediction } from '../../src/js/scoring.js';
import { auditPredictionPoints, auditLeaderboard, auditSanity } from '../e2e/lib/recompute.js';

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
const predAudit = auditPredictionPoints(preds, matchById);
predAudit.wrong.slice(0, 10).forEach((w) =>
  bad(`u=${w.user_id.slice(0, 8)} M${w.match_id} (${w.stage}): palpite ${w.pred} vs ${w.actual} → esperado ${w.expected}, banco ${w.got}`));
predAudit.leaked.slice(0, 5).forEach((l) =>
  bad(`u=${l.user_id.slice(0, 8)} M${l.match_id}: points_earned=${l.points_earned} num jogo NÃO finalizado`));
predAudit.wrong.length === 0 ? ok(`${predAudit.checked} palpites pontuados conferem (recompute == banco)`) : bad(`${predAudit.wrong.length}/${predAudit.checked} palpites com pontuação ERRADA`);
predAudit.leaked.length === 0 ? ok('nenhum ponto vazado em jogo não finalizado') : bad(`${predAudit.leaked.length} pontos em jogos abertos`);
if (predAudit.sample.length) console.log(`${C.dim}     amostra ok: ${predAudit.sample.join(' · ')}${C.x}`);
fail += predAudit.wrong.length + predAudit.leaked.length;

// ============================================================
// 3) v_leaderboard por usuário == recompute independente
//    match_pts, scorer_pts, champion_pts, qualifier_pts, total_pts
// ============================================================
head('3. Ranking por usuário (v_leaderboard × recompute) — todos os pagantes');
const predsByUser = new Map();
for (const p of preds) { (predsByUser.get(p.user_id) ?? predsByUser.set(p.user_id, []).get(p.user_id)).push(p); }
const goalsByMatch = new Map();
for (const g of goals) { (goalsByMatch.get(g.match_id) ?? goalsByMatch.set(g.match_id, []).get(g.match_id)).push(g); }
const scorerByUser = new Map(scorerPicks.map((s) => [s.user_id, s.player_id]));
const champByUser = new Map(champPicks.map((c) => [c.user_id, c.team]));
const qualByUser = new Map(uqp.map((q) => [q.user_id, q.points]));
const realChampion = oracle.champion;  // LOCAL: oráculo sintético é a verdade
const finalFinished = matches.find((m) => m.stage === 'final')?.finished;

const lbAudit = auditLeaderboard({
  leaderboard: lb, matches, matchById, predsByUser, goalsByMatch,
  scorerByUser, champByUser, qualByUser, realChampion, finalFinished,
});
lbAudit.diffs.slice(0, 10).forEach((d) => bad(`${String(d.name).padEnd(22)} ${d.parts.join(' · ')}`));
lbAudit.diffs.length === 0
  ? ok(`${lbAudit.checked} usuários do ranking conferem (match/scorer/champ/qual/total)`)
  : bad(`${lbAudit.diffs.length}/${lbAudit.checked} usuários com divergência — por coluna: ${JSON.stringify(lbAudit.cols)}`);
fail += lbAudit.diffs.length;

// ============================================================
// 4) Sanidades extras
// ============================================================
head('4. Sanidades');
for (const s of auditSanity({ leaderboard: lb, profiles, matches, finalFinished })) {
  s.pass ? ok(s.name) : bad(`${s.name}${s.detail ? ' — ' + s.detail : ''}`);
  if (!s.pass) fail++;
}

// ============================================================
console.log(`\n${C.bold}${fail === 0 ? C.g + '✅ TUDO CONFERE — a UI mostra dados corretos p/ todos os usuários.' : C.r + `❌ ${fail} divergência(s) — ver acima.`}${C.x}`);
process.exit(fail === 0 ? 0 : 1);

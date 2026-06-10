#!/usr/bin/env node
/**
 * prod-verify.js — Auditoria de CORREÇÃO read-only contra PRODUÇÃO.
 * ============================================================================
 * O irmão pesado do prod-smoke: recomputa INDEPENDENTE (via src/js/scoring.js,
 * o módulo-fonte da UI) a pontuação de TODOS os palpites e o ranking de TODOS os
 * pagantes, e compara com o que o banco gravou. Se um trigger de scoring falhar
 * num jogo durante a Copa, ISTO pega — sem esperar um usuário reclamar.
 *
 * Diferença para o verify-data LOCAL: prod NÃO tem oráculo sintético. A "verdade"
 * dos resultados é a própria realidade (não há fonte independente p/ checar o
 * placar real), então NÃO comparamos resultados contra oráculo. O que checamos é
 * a CONSISTÊNCIA INTERNA: dados os resultados que o banco tem, a pontuação
 * derivada deles está certa? Campeão é derivado do jogo da final.
 *
 * SÓ LÊ (select/count). Guard-rail inverso: aborta se a URL parecer LOCAL.
 *
 * USO: node scripts/e2e/prod-verify.js        (credenciais de PROD do .env)
 * Saída: exit 0 = tudo confere · 1 = divergência (o monitor alerta no Telegram).
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  championFromFinal, auditPredictionPoints, auditLeaderboard, auditSanity,
} from './lib/recompute.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const URL = process.env.SUPABASE_URL;
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[34m', x: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m' };
const ok = (m) => console.log(`${C.g}  ✓ ${m}${C.x}`);
const bad = (m) => console.log(`${C.r}  ✗ ${m}${C.x}`);
const head = (m) => console.log(`\n${C.b}${C.bold}▶ ${m}${C.x}`);

if (!URL || !SR) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes no .env.'); process.exit(2); }
if (/127\.0\.0\.1|localhost/.test(URL)) {
  console.error('SUPABASE_URL é local — prod-verify é p/ PRODUÇÃO (lê .env). Para auditar local use scripts/dev/verify-data.mjs.');
  process.exit(2);
}

// READ-ONLY: cliente sem persistência; só fazemos select.
const db = createClient(URL, SR, { auth: { persistSession: false, autoRefreshToken: false } });

async function pageAll(table, cols, orderCol = 'id') {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).order(orderCol, { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

console.log(`${C.bold}🔭 Prod verify (READ-ONLY recompute) — ${URL}${C.x}`);

const { data: matches, error: me } = await db.from('matches')
  .select('id, stage, team_home, team_away, actual_home, actual_away, pen_winner, finished').order('id');
if (me) { console.error('matches:', me.message); process.exit(1); }
const matchById = new Map(matches.map((m) => [m.id, m]));

const preds = await pageAll('predictions', 'user_id, match_id, pred_home, pred_away, pred_pen_winner, points_earned', 'id');
const goals = await pageAll('player_goals', 'player_id, match_id, goals', 'id');
const scorerPicks = await pageAll('top_scorer_picks', 'user_id, player_id', 'user_id');
const champPicks = await pageAll('champion_picks', 'user_id, team', 'user_id');
const uqp = await pageAll('user_qualifier_points', 'user_id, points', 'user_id');
const { data: profiles } = await db.from('profiles').select('id, full_name, paid');
const { data: lb } = await db.from('v_leaderboard').select('*');

console.log(`${C.dim}   ${matches.length} jogos (${matches.filter((m) => m.finished).length} finalizados) · ${preds.length} palpites · ${lb.length} no ranking${C.x}`);

let fail = 0;
const realChampion = championFromFinal(matches);
const finalFinished = !!matches.find((m) => m.stage === 'final')?.finished;

// 2) points_earned por palpite == recompute
head('Pontos por palpite (banco × recompute independente)');
const predAudit = auditPredictionPoints(preds, matchById);
predAudit.wrong.slice(0, 10).forEach((w) =>
  bad(`u=${w.user_id.slice(0, 8)} M${w.match_id} (${w.stage}): palpite ${w.pred} vs ${w.actual} → esperado ${w.expected}, banco ${w.got}`));
predAudit.leaked.slice(0, 5).forEach((l) =>
  bad(`u=${l.user_id.slice(0, 8)} M${l.match_id}: points_earned=${l.points_earned} em jogo NÃO finalizado`));
predAudit.wrong.length === 0 ? ok(`${predAudit.checked} palpites pontuados conferem`) : bad(`${predAudit.wrong.length}/${predAudit.checked} com pontuação ERRADA`);
predAudit.leaked.length === 0 ? ok('nenhum ponto vazado em jogo aberto') : bad(`${predAudit.leaked.length} pontos vazados`);
fail += predAudit.wrong.length + predAudit.leaked.length;

// 3) v_leaderboard por usuário == recompute
head('Ranking por usuário (v_leaderboard × recompute)');
const predsByUser = new Map();
for (const p of preds) { (predsByUser.get(p.user_id) ?? predsByUser.set(p.user_id, []).get(p.user_id)).push(p); }
const goalsByMatch = new Map();
for (const g of goals) { (goalsByMatch.get(g.match_id) ?? goalsByMatch.set(g.match_id, []).get(g.match_id)).push(g); }
const scorerByUser = new Map(scorerPicks.map((s) => [s.user_id, s.player_id]));
const champByUser = new Map(champPicks.map((c) => [c.user_id, c.team]));
const qualByUser = new Map(uqp.map((q) => [q.user_id, q.points]));

const lbAudit = auditLeaderboard({
  leaderboard: lb, matches, matchById, predsByUser, goalsByMatch,
  scorerByUser, champByUser, qualByUser, realChampion, finalFinished,
});
lbAudit.diffs.slice(0, 10).forEach((d) => bad(`${String(d.name).padEnd(22)} ${d.parts.join(' · ')}`));
lbAudit.diffs.length === 0
  ? ok(`${lbAudit.checked} usuários conferem (match/scorer/champ/qual/total)`)
  : bad(`${lbAudit.diffs.length}/${lbAudit.checked} com divergência — ${JSON.stringify(lbAudit.cols)}`);
fail += lbAudit.diffs.length;

// 4) Sanidades
head('Sanidades');
for (const s of auditSanity({ leaderboard: lb, profiles, matches, finalFinished })) {
  s.pass ? ok(s.name) : bad(`${s.name}${s.detail ? ' — ' + s.detail : ''}`);
  if (!s.pass) fail++;
}
if (realChampion) console.log(`${C.dim}   campeão real (final): ${realChampion}${C.x}`);

console.log(`\n${C.bold}${fail === 0 ? C.g + '✅ PROD CONFERE — pontuação e ranking corretos p/ todos.' : C.r + `❌ ${fail} divergência(s) em PROD — ver acima.`}${C.x}`);
console.log(`${C.dim}   (nenhuma escrita foi feita em produção)${C.x}`);
process.exit(fail === 0 ? 0 : 1);

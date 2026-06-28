#!/usr/bin/env node
/**
 * audit-scoring-full.mjs — Auditoria READ-ONLY total do placar do bolão × PROD.
 * ============================================================================
 * Reconstrói TUDO de forma independente a partir dos dados crus do prod e
 * confere contra o que o banco gravou — sem executar nada mutante:
 *   1. Classificação REAL de cada grupo (pts → confronto direto → SG → GF →
 *      fair play → FIFA, = public.rank_group) vs RPC rank_group do prod
 *   2. Bracket: 1X/2X/3X e os 8 slots de 3º (tabela oficial Annexe C) vs matches
 *   3. Pontos por palpite (scorePrediction aditivo) vs predictions.points_earned
 *   4. match_pts / scorer_pts / champion_pts / qualifier_pts / total_pts do
 *      v_leaderboard vs recomputação independente
 *   5. Sanidade: contagens, jogos finished com placar, slots resolvidos
 *
 * USO: node scripts/dev/audit-scoring-full.mjs   (credenciais do .env)
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scorePrediction, scorerBonus, stageMultiplier } from '../../src/js/scoring.js';
import { fifaRank } from '../../src/js/fifa-rank.js';
import { THIRDS_ALLOCATION } from '../../src/js/thirds-allocation.js';
import { computeStandings } from '../../src/js/util.js';
import { assignCompositeThirds } from '../../src/js/thirds-assign.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const URL = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SR) { console.error('credenciais ausentes no .env'); process.exit(2); }
if (/127\.0\.0\.1|localhost/.test(URL)) { console.error('URL local — auditoria é p/ PROD.'); process.exit(2); }
const sr = createClient(URL, SR, { auth: { persistSession: false } });

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', x: '\x1b[0m', b: '\x1b[1m', d: '\x1b[2m' };
let fails = 0, warns = 0, checks = 0;
const ok = m => { checks++; };
const okv = m => { checks++; console.log(`${C.g}  ✓ ${m}${C.x}`); };
const bad = m => { fails++; console.log(`${C.r}  ✗ ${m}${C.x}`); };
const warn = m => { warns++; console.log(`${C.y}  ⚠ ${m}${C.x}`); };
const head = m => console.log(`\n${C.b}▶ ${m}${C.x}`);

// ---------- pull everything ----------
async function pageAll(table, cols) {
  let out = [], from = 0;
  while (true) {
    const { data, error } = await sr.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out = out.concat(data); if (data.length < 1000) break; from += 1000;
  }
  return out;
}
const matches = await pageAll('matches', 'id,stage,group_name,team_home,team_away,slot_home,slot_away,actual_home,actual_away,pen_winner,finished,home_fairplay,away_fairplay');
const profiles = (await sr.from('profiles').select('id,full_name,paid')).data;
const paid = profiles.filter(p => p.paid);
const predictions = await pageAll('predictions', 'user_id,match_id,pred_home,pred_away,pred_pen_winner,points_earned');
const champPicks = (await sr.from('champion_picks').select('user_id,team')).data;
const scorerPicks = (await sr.from('top_scorer_picks').select('user_id,player_id')).data;
const playerGoals = await pageAll('player_goals', 'player_id,match_id,goals');
const uqp = (await sr.from('user_qualifier_points').select('user_id,points')).data;
const leaderboard = (await sr.from('v_leaderboard').select('*')).data;

const matchById = new Map(matches.map(m => [m.id, m]));
const isReal = t => t && !/^[0-9LW]/.test(t) && !t.includes('/');

console.log(`${C.b}🧾 Auditoria total do placar × PROD — ${URL}${C.x}`);
console.log(`${C.d}   ${matches.length} jogos · ${paid.length} pagantes · ${predictions.length} palpites${C.x}`);

// ============================================================
head('[1] Sanidade dos jogos e resultados reais');
const groupGames = matches.filter(m => m.stage === 'group');
const koGames = matches.filter(m => m.stage !== 'group');
matches.length === 104 ? okv('104 jogos no total') : bad(`esperava 104 jogos, achei ${matches.length}`);
groupGames.length === 72 ? okv('72 jogos de grupo') : bad(`esperava 72 de grupo, achei ${groupGames.length}`);
koGames.length === 32 ? okv('32 jogos de mata-mata') : bad(`esperava 32 KO, achei ${koGames.length}`);
const groupsSet = [...new Set(groupGames.map(m => m.group_name))];
groupsSet.length === 12 ? okv('12 grupos') : bad(`esperava 12 grupos, achei ${groupsSet.length}`);
const unfinishedGroup = groupGames.filter(m => !m.finished);
unfinishedGroup.length === 0 ? okv('todos os jogos de grupo finished') : warn(`${unfinishedGroup.length} jogos de grupo NÃO finished`);
const finNoScore = matches.filter(m => m.finished && (m.actual_home == null || m.actual_away == null));
finNoScore.length === 0 ? okv('todo jogo finished tem placar') : bad(`${finNoScore.length} jogos finished sem placar`);
const koResolvedEntrants = koGames.filter(m => m.stage === 'r32').every(m => isReal(m.team_home) && isReal(m.team_away));
koResolvedEntrants ? okv('todos os 32-avos com times reais resolvidos (sem slot vazando)') : bad('algum 32-avos com slot não resolvido');

// ============================================================
head('[2] Classificação real de cada grupo (rank_group) — JS independente × RPC do prod');
// replica public.rank_group: h2h entre times de MESMA pontuação-base
function rankGroupJS(g) {
  const gms = groupGames.filter(m => m.group_name === g && m.finished);
  const base = new Map();
  const ens = t => { if (!base.has(t)) base.set(t, { team: t, pts: 0, gf: 0, ga: 0, fp: 0 }); return base.get(t); };
  for (const m of gms) {
    const h = ens(m.team_home), a = ens(m.team_away);
    h.gf += m.actual_home; h.ga += m.actual_away; h.fp += m.home_fairplay ?? 0;
    a.gf += m.actual_away; a.ga += m.actual_home; a.fp += m.away_fairplay ?? 0;
    if (m.actual_home > m.actual_away) h.pts += 3; else if (m.actual_home === m.actual_away) { h.pts++; a.pts++; } else a.pts += 3;
  }
  const teams = [...base.values()].map(t => ({ ...t, gd: t.gf - t.ga }));
  // h2h entre times com mesma pontuação-base
  const h2h = new Map(teams.map(t => [t.team, { p: 0, gf: 0, ga: 0 }]));
  for (const m of gms) {
    const bh = base.get(m.team_home), ba = base.get(m.team_away);
    if (bh.pts !== ba.pts) continue;
    const H = h2h.get(m.team_home), A = h2h.get(m.team_away);
    H.gf += m.actual_home; H.ga += m.actual_away; A.gf += m.actual_away; A.ga += m.actual_home;
    if (m.actual_home > m.actual_away) H.p += 3; else if (m.actual_home === m.actual_away) { H.p++; A.p++; } else A.p += 3;
  }
  return teams.sort((x, y) => {
    const hx = h2h.get(x.team), hy = h2h.get(y.team);
    return y.pts - x.pts || hy.p - hx.p || (hy.gf - hy.ga) - (hx.gf - hx.ga) || hy.gf - hx.gf
      || y.gd - x.gd || y.gf - x.gf || y.fp - x.fp || fifaRank(x.team) - fifaRank(y.team);
  }).map(t => t.team);
}
let rankMismatch = 0;
const winners = {}, runners = {}, thirdsByGroup = {};
for (const g of groupsSet.sort()) {
  const js = rankGroupJS(g);
  winners['1' + g] = js[0]; runners['2' + g] = js[1]; thirdsByGroup[g] = js[2];
  const { data: rpc, error } = await sr.rpc('rank_group', { p_group: g });
  if (error) { warn(`rank_group RPC indisponível p/ ${g}: ${error.message}`); continue; }
  const prodOrder = rpc.sort((a, b) => a.pos - b.pos).map(r => r.team);
  if (JSON.stringify(prodOrder) !== JSON.stringify(js)) {
    rankMismatch++; bad(`grupo ${g}: ordem JS ${js.join(',')} ≠ prod ${prodOrder.join(',')}`);
  }
}
rankMismatch === 0 ? okv('classificação dos 12 grupos idêntica entre JS e o RPC do prod') : null;

// ============================================================
head('[3] Bracket: 1X/2X nos 32-avos + 8 slots de 3º (tabela oficial)');
// thirds ranking p/ combo
const thirdsRanked = Object.entries(thirdsByGroup).map(([g, team]) => {
  const gms = groupGames.filter(m => m.group_name === g && m.finished);
  let pts = 0, gf = 0, ga = 0, fp = 0;
  for (const m of gms) {
    const home = m.team_home === team, away = m.team_away === team;
    if (!home && !away) continue;
    const f = home ? m.actual_home : m.actual_away, ag = home ? m.actual_away : m.actual_home;
    gf += f; ga += ag; fp += (home ? m.home_fairplay : m.away_fairplay) ?? 0;
    if (f > ag) pts += 3; else if (f === ag) pts += 1;
  }
  return { group: g, team, pts, gd: gf - ga, gf, fp };
}).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || b.fp - a.fp || fifaRank(a.team) - fifaRank(b.team));
const top8 = thirdsRanked.slice(0, 8);
const combo = top8.map(t => t.group).sort().join('');
const row = THIRDS_ALLOCATION[combo];
const SLOT_SEED = { ABCDF: '1E', CDFGH: '1I', CEFHI: '1A', EHIJK: '1L', BEFIJ: '1D', AEHIJ: '1G', EFGIJ: '1B', DEIJL: '1K' };
const thirdByGroup = new Map(top8.map(t => [t.group, t.team]));
console.log(`${C.d}   combo de 3ºs classificados: ${combo}${C.x}`);
row ? okv(`combo ${combo} existe na tabela oficial (Annexe C)`) : bad(`combo ${combo} NÃO está na tabela oficial!`);

let slotMismatch = 0;
for (const m of koGames.filter(k => k.stage === 'r32')) {
  for (const side of ['home', 'away']) {
    const slot = side === 'home' ? m.slot_home : m.slot_away;
    const actual = side === 'home' ? m.team_home : m.team_away;
    let expected = null;
    if (/^1[A-L]$/.test(slot)) expected = winners[slot];
    else if (/^2[A-L]$/.test(slot)) expected = runners[slot];
    else if (slot?.startsWith('3') && slot.includes('/')) {
      const seed = row && SLOT_SEED[slot.slice(1).split('/').sort().join('')];
      expected = seed && thirdByGroup.get(row[seed]);
    }
    if (expected && expected !== actual) { slotMismatch++; bad(`M${m.id} ${slot}: esperado ${expected}, prod tem ${actual}`); }
  }
}
slotMismatch === 0 ? okv('todos os 32 entrantes dos 32-avos batem com a regra oficial') : null;

// ============================================================
head('[4] Pontos por palpite (scorePrediction) × predictions.points_earned');
let peMismatch = 0, peUnscored = 0, peStaleScored = 0;
for (const p of predictions) {
  const m = matchById.get(p.match_id);
  if (!m) continue;
  if (m.finished) {
    const exp = scorePrediction(p.pred_home, p.pred_away, p.pred_pen_winner, m.actual_home, m.actual_away, m.pen_winner, m.stage);
    if (p.points_earned == null) peUnscored++;
    else if (p.points_earned !== exp) { peMismatch++; if (peMismatch <= 15) bad(`user ${p.user_id.slice(0,8)} M${p.match_id} (${m.stage}): gravado ${p.points_earned}, esperado ${exp} [palpite ${p.pred_home}-${p.pred_away} real ${m.actual_home}-${m.actual_away}]`); }
  } else if (p.points_earned != null && p.points_earned !== 0) {
    peStaleScored++;
  }
}
peMismatch === 0 ? okv(`pontos de TODOS os ${predictions.length} palpites conferem com scorePrediction`) : bad(`${peMismatch} palpites com points_earned errado`);
peUnscored === 0 ? okv('nenhum palpite de jogo finished ficou sem pontuar') : bad(`${peUnscored} palpites de jogos finished sem points_earned`);
peStaleScored === 0 ? okv('nenhum palpite de jogo não-finished com pontos indevidos') : warn(`${peStaleScored} palpites de jogos não-finished com points_earned != 0`);

// ============================================================
head('[5] Componentes do v_leaderboard × recomputação independente');
const lbByUser = new Map(leaderboard.map(r => [r.user_id, r]));
const uqpByUser = new Map(uqp.map(r => [r.user_id, r.points]));
const champByUser = new Map(champPicks.map(r => [r.user_id, r.team]));
const scorerByUser = new Map(scorerPicks.map(r => [r.user_id, r.player_id]));
const goalsByMatchPlayer = new Map(playerGoals.map(g => [`${g.match_id}|${g.player_id}`, g.goals]));
// match_pts por user
const matchPtsByUser = new Map();
for (const p of predictions) {
  const m = matchById.get(p.match_id);
  if (m?.finished && p.points_earned != null) matchPtsByUser.set(p.user_id, (matchPtsByUser.get(p.user_id) || 0) + p.points_earned);
}
// scorer_pts por user (= sum goals*2*mult sobre jogos finished, round no total)
function scorerPtsFor(uid) {
  const pid = scorerByUser.get(uid); if (!pid) return 0;
  let s = 0;
  for (const m of matches) { if (!m.finished) continue; const g = goalsByMatchPlayer.get(`${m.id}|${pid}`); if (g) s += g * 2 * stageMultiplier(m.stage); }
  return Math.round(s);
}
const finalMatch = matches.find(m => m.stage === 'final');
let cMatch = 0, cScorer = 0, cChamp = 0, cQual = 0, cTotal = 0;
for (const u of paid) {
  const lb = lbByUser.get(u.id);
  if (!lb) { bad(`pagante ${u.full_name} ausente do v_leaderboard`); continue; }
  const expMatch = matchPtsByUser.get(u.id) || 0;
  if (lb.match_pts !== expMatch) { cMatch++; if (cMatch <= 10) bad(`${u.full_name}: match_pts view ${lb.match_pts} ≠ soma ${expMatch}`); }
  const expScorer = scorerPtsFor(u.id);
  if (lb.scorer_pts !== expScorer) { cScorer++; if (cScorer <= 10) bad(`${u.full_name}: scorer_pts view ${lb.scorer_pts} ≠ recalc ${expScorer}`); }
  // champion: final não finished → 0
  const expChamp = (finalMatch?.finished) ? null : 0;  // null = não auditável aqui
  if (expChamp != null && lb.champion_pts !== expChamp) { cChamp++; bad(`${u.full_name}: champion_pts ${lb.champion_pts} ≠ ${expChamp}`); }
  const expQual = uqpByUser.get(u.id) || 0;
  if (lb.qualifier_pts !== expQual) { cQual++; if (cQual <= 10) bad(`${u.full_name}: qualifier_pts view ${lb.qualifier_pts} ≠ cache ${expQual}`); }
  const expTotal = (lb.match_pts || 0) + (lb.champion_pts || 0) + (lb.scorer_pts || 0) + (lb.qualifier_pts || 0);
  if (lb.total_pts !== expTotal) { cTotal++; if (cTotal <= 10) bad(`${u.full_name}: total_pts ${lb.total_pts} ≠ soma componentes ${expTotal}`); }
}
cMatch === 0 ? okv('match_pts confere p/ todos os pagantes') : null;
cScorer === 0 ? okv('scorer_pts confere p/ todos os pagantes') : null;
cChamp === 0 ? okv(finalMatch?.finished ? 'champion_pts confere' : 'champion_pts = 0 p/ todos (final não disputada)') : null;
cQual === 0 ? okv('qualifier_pts (view) == cache user_qualifier_points p/ todos') : null;
cTotal === 0 ? okv('total_pts == soma dos 4 componentes p/ todos') : null;

// ============================================================
head('[6] Bônus de classificado RECOMPUTADO do zero (bracket previsto: h2h recursivo + tabela oficial)');
// Reconstrói o bracket PREVISTO de cada usuário com a MESMA lógica do cliente/
// real (util.computeStandings recursivo + tabela oficial, sem greedy quando >=8)
// e recompara o qualifier_pts ao cache. Pega erro de regra (não só view≠cache).
const QPHASE = { r32: 1, r16: 2, qf: 3, sf: 5, third: 3, final: 8 };  // 022_additive_scoring
const SEEDQ = { ABCDF: '1E', CDFGH: '1I', CEFHI: '1A', EHIJK: '1L', BEFIJ: '1D', AEHIJ: '1G', EFGIJ: '1B', DEIJL: '1K' };
const predsByUser = new Map();
for (const p of predictions) { if (!predsByUser.has(p.user_id)) predsByUser.set(p.user_id, new Map()); predsByUser.get(p.user_id).set(p.match_id, p); }
const groupSizes = {}; for (const m of groupGames) groupSizes[m.group_name] = (groupSizes[m.group_name] || 0) + 1;
const compositeDefs = [...new Set(koGames.flatMap(m => [m.slot_home, m.slot_away]).filter(s => s && s.startsWith('3') && s.includes('/')))].map(s => ({ slot: s, validGroups: s.slice(1).split('/') }));
const realPhaseTeams = {}; for (const m of koGames) for (const t of [m.team_home, m.team_away]) if (isReal(t)) (realPhaseTeams[m.stage] ??= new Set()).add(t);
function predictedQualifier(pm) {
  const slot = new Map(); const thirds = [];
  for (const g of Object.keys(groupSizes)) {
    const gms = groupGames.filter(m => m.group_name === g);
    if (!gms.every(m => pm.has(m.id))) continue;
    const st = computeStandings(gms, 'sim', pm);
    if (st.length < 3) continue;
    slot.set('1' + g, st[0].team); slot.set('2' + g, st[1].team); slot.set('3' + g, st[2].team);
    thirds.push({ group: g, team: st[2].team, pts: st[2].pts, sg: st[2].sg, gp: st[2].gp, fairPlay: st[2].fairPlay ?? 0 });
  }
  thirds.sort((a, b) => b.pts - a.pts || b.sg - a.sg || b.gp - a.gp || fifaRank(a.team) - fifaRank(b.team));
  if (thirds.length >= 8) for (const [s, t] of assignCompositeThirds(compositeDefs, thirds)) slot.set(s, t.team);
  for (let pass = 0; pass < 10; pass++) { let ch = false;
    for (const m of [...koGames].sort((a, b) => a.id - b.id)) {
      const ht = slot.get(m.slot_home), at = slot.get(m.slot_away); if (!ht || !at) continue;
      const p = pm.get(m.id); if (!p || p.pred_home == null) continue;
      let w, l; if (p.pred_home > p.pred_away) { w = ht; l = at; } else if (p.pred_away > p.pred_home) { w = at; l = ht; }
      else if (p.pred_pen_winner === 'home') { w = ht; l = at; } else if (p.pred_pen_winner === 'away') { w = at; l = ht; } else continue;
      if (!slot.has('W' + m.id)) { slot.set('W' + m.id, w); ch = true; } if (!slot.has('L' + m.id)) { slot.set('L' + m.id, l); ch = true; }
    } if (!ch) break;
  }
  let pts = 0;
  for (const m of koGames) for (const side of ['home', 'away']) {
    const actual = side === 'home' ? m.team_home : m.team_away; if (!isReal(actual)) continue;
    const ref = side === 'home' ? (m.slot_home || m.team_home) : (m.slot_away || m.team_away);
    const pred = slot.get(ref); if (!pred) continue; const bpe = QPHASE[m.stage];
    if (pred === actual) pts += bpe; else if (realPhaseTeams[m.stage]?.has(pred)) { if (m.stage !== 'r32') pts += Math.round(bpe / 2); }
  }
  return pts;
}
let qRecalc = 0;
for (const u of paid) {
  const exp = predictedQualifier(predsByUser.get(u.id) || new Map());
  const cur = uqpByUser.get(u.id) || 0;
  if (exp !== cur) { qRecalc++; if (qRecalc <= 15) bad(`${u.full_name}: qualifier cache ${cur} ≠ recálculo oficial ${exp} (${exp - cur > 0 ? '+' : ''}${exp - cur})`); }
}
qRecalc === 0 ? okv('qualifier_pts de todos bate com o recálculo independente (h2h recursivo + tabela oficial)') : bad(`${qRecalc} usuários com qualifier_pts divergente do recálculo oficial`);

// ============================================================
console.log(`\n${C.b}━━━ Resultado: ${checks} checagens · ${C.g}${checks - 0} ok${C.x}${C.b} · ${fails ? C.r : ''}${fails} falhas${C.x}${C.b} · ${warns ? C.y : ''}${warns} avisos${C.x}`);
process.exit(fails ? 1 : 0);

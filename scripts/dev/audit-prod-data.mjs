#!/usr/bin/env node
/**
 * audit-prod-data.mjs — Auditoria READ-ONLY de CORRETUDE dos dados de PROD vs a
 * REALIDADE EXTERNA (API: standings/recent/topscorers) e invariantes do torneio.
 * ============================================================================
 * O prod-verify.js prova a consistência INTERNA (points_earned == recompute dos
 * resultados que o banco TEM). Mas se o admin digitou um placar ERRADO, o scoring
 * fica internamente coerente e mesmo assim a UI mostra besteira. Este script pega
 * o que aquele não pega:
 *   1. RESULTADOS do banco × standings.json (agregados por time) e recent.json
 *      (placar exato) — a "verdade" externa da API.
 *   2. GOLS do artilheiro (player_goals) × total de gols dos jogos e × topscorers.json.
 *   3. Cache de CLASSIFICADO (user_qualifier_points) coerente com a fase atual
 *      (nenhum mata-mata resolvido → tudo zero).
 *   4. Validade dos PALPITES (faixas, pênalti só em mata-mata, pontuado sse jogo
 *      finalizado, sem duplicata, cobertura por pagante).
 *   5. PRAZO respeitado de verdade (via prediction_audit, a hora REAL de edição).
 *   6. Picks de campeão/artilheiro válidos; cobertura FIFA-rank dos times.
 *
 * SÓ LÊ (select/count). Aborta se a URL parecer LOCAL.
 * USO: node scripts/dev/audit-prod-data.mjs        (credenciais de PROD do .env)
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { predictionDeadline, computeStandings, decodeHtmlEntities } from '../../src/js/util.js';
import { fifaRank } from '../../src/js/fifa-rank.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
config({ path: join(ROOT, '.env') });

const URL = process.env.SUPABASE_URL;
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[34m', x: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m' };
let fails = 0, warns = 0;
const ok = (m) => console.log(`${C.g}  ✓ ${m}${C.x}`);
const bad = (m) => { fails++; console.log(`${C.r}  ✗ ${m}${C.x}`); };
const warn = (m) => { warns++; console.log(`${C.y}  ⚠ ${m}${C.x}`); };
const head = (m) => console.log(`\n${C.b}${C.bold}▶ ${m}${C.x}`);

if (!URL || !SR) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes no .env.'); process.exit(2); }
if (/127\.0\.0\.1|localhost/.test(URL)) { console.error('URL é local — este audit é p/ PROD.'); process.exit(2); }

const db = createClient(URL, SR, { auth: { persistSession: false, autoRefreshToken: false } });
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, 'src', 'assets', 'data', p), 'utf8'));

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

console.log(`${C.bold}🧮 Audit de corretude de dados (PROD × realidade externa) — ${URL}${C.x}`);

// ---- carrega DB ----
const { data: matches } = await db.from('matches')
  .select('id, stage, group_name, match_date, team_home, team_away, actual_home, actual_away, pen_winner, finished, finished_at');
const matchById = new Map(matches.map((m) => [m.id, m]));
const finished = matches.filter((m) => m.finished);
const preds = await pageAll('predictions', 'id, user_id, match_id, pred_home, pred_away, pred_pen_winner, points_earned');
const goals = await pageAll('player_goals', 'id, player_id, match_id, goals');
const players = await pageAll('players', 'id, full_name, team, api_player_id');
const playerById = new Map(players.map((p) => [p.id, p]));
const champPicks = await pageAll('champion_picks', 'user_id, team', 'user_id');
const scorerPicks = await pageAll('top_scorer_picks', 'user_id, player_id', 'user_id');
const uqp = await pageAll('user_qualifier_points', 'user_id, points', 'user_id');
const { data: profiles } = await db.from('profiles').select('id, full_name, paid');
const { data: ranks } = await db.from('team_fifa_rank').select('team, rank');
const rankTeams = new Set((ranks ?? []).map((r) => r.team));

// ---- carrega JSON externo (o que a UI mostra) ----
const standings = readJson('standings.json');
const recent = readJson('recent.json');
const topscorers = readJson('topscorers.json');

console.log(`${C.dim}   ${matches.length} jogos (${finished.length} finalizados) · ${preds.length} palpites · ${players.length} jogadores · ${profiles.length} perfis${C.x}`);

// helper: chave de dia BRT de um instante UTC (YYYY-MM-DD), p/ casar com recent.json
const brDay = (iso) => {
  const d = new Date(new Date(iso).getTime() - 3 * 3600000);
  return d.toISOString().slice(0, 10);
};

// ============================================================
// 1) RESULTADOS do banco × standings.json (agregados por time)
// ============================================================
head('[1] Resultados do banco × standings.json (a verdade da API)');
{
  // monta standings a partir dos jogos finalizados do banco, por grupo
  const groups = {};
  for (const m of matches.filter((x) => x.stage === 'group')) {
    (groups[m.group_name] ??= []).push(m);
  }
  // index standings.json por (grupo, time)
  const apiRow = new Map(); // `${g}|${team}` -> row
  for (const [g, rows] of Object.entries(standings.groups ?? {})) {
    for (const r of rows) apiRow.set(`${g}|${decodeHtmlEntities(r.team)}`, r);
  }
  let diffs = 0, teamsChecked = 0;
  for (const [g, ms] of Object.entries(groups)) {
    const table = computeStandings(ms, 'real'); // usa actual_*; ignora não finalizados
    for (const s of table) {
      const r = apiRow.get(`${g}|${decodeHtmlEntities(s.team)}`);
      if (!r) { warn(`grupo ${g}: time "${s.team}" do banco não está no standings.json`); continue; }
      teamsChecked++;
      // só compara o que já jogou no banco (s.j); se a API tem mais jogos que o
      // banco (banco atrasado) ou vice-versa, reporta played divergente.
      const mism = [];
      if (s.j !== r.played) mism.push(`J ${s.j}≠${r.played}`);
      if (s.v !== r.win) mism.push(`V ${s.v}≠${r.win}`);
      if (s.e !== r.draw) mism.push(`E ${s.e}≠${r.draw}`);
      if (s.d !== r.lose) mism.push(`D ${s.d}≠${r.lose}`);
      if (s.gp !== r.gf) mism.push(`GP ${s.gp}≠${r.gf}`);
      if (s.gc !== r.ga) mism.push(`GC ${s.gc}≠${r.ga}`);
      if (s.pts !== r.points) mism.push(`PTS ${s.pts}≠${r.points}`);
      if (mism.length) { bad(`grupo ${g} ${s.team}: ${mism.join(' · ')} (banco × API)`); diffs++; }
    }
  }
  diffs === 0 && ok(`${teamsChecked} times: agregados do banco batem com standings.json`);
}

// ============================================================
// 2) Placar EXATO do banco × recent.json (WC entries)
// ============================================================
head('[2] Placar exato do banco × recent.json');
{
  // recent.json: { team: [ [date, opponent, isHome, "h-a", competition], ... ] }
  const recByTeam = new Map();
  for (const [team, rows] of Object.entries(recent)) recByTeam.set(decodeHtmlEntities(team), rows);
  const isWC = (comp) => /world cup|copa do mundo/i.test(String(comp));
  let matched = 0, diffs = 0, notFound = 0;
  for (const m of finished) {
    if (m.stage !== 'group') continue; // KO usa slots; recent casa por nome
    const day = brDay(m.match_date);
    const rows = recByTeam.get(decodeHtmlEntities(m.team_home)) ?? [];
    const entry = rows.find((r) => isWC(r[4]) && decodeHtmlEntities(r[1]) === decodeHtmlEntities(m.team_away) && r[0] === day)
              ?? rows.find((r) => isWC(r[4]) && decodeHtmlEntities(r[1]) === decodeHtmlEntities(m.team_away));
    if (!entry) { notFound++; continue; }
    // entry score é da perspectiva do team_home (r[2]===true => home). Normaliza.
    const [s1, s2] = String(entry[3]).split('-').map((n) => parseInt(n, 10));
    const recHome = entry[2] ? s1 : s2;
    const recAway = entry[2] ? s2 : s1;
    matched++;
    if (recHome !== m.actual_home || recAway !== m.actual_away) {
      bad(`M${m.id} ${m.team_home}-${m.team_away}: banco ${m.actual_home}-${m.actual_away} ≠ recent.json ${recHome}-${recAway}`);
      diffs++;
    }
  }
  diffs === 0 && ok(`${matched} placares conferem com recent.json`);
  notFound && warn(`${notFound} jogo(s) finalizados sem entrada WC casável no recent.json (pode ser atraso da action)`);
}

// ============================================================
// 3) GOLS do artilheiro (player_goals) — somatório e × topscorers.json
// ============================================================
head('[3] Gols (player_goals) × jogos e × topscorers.json');
{
  // 3a) invariante: soma dos player_goals (jogos finalizados) ≈ soma dos gols dos jogos
  const finishedIds = new Set(finished.map((m) => m.id));
  let pgSum = 0;
  for (const g of goals) if (finishedIds.has(g.match_id)) pgSum += g.goals;
  let matchSum = 0;
  for (const m of finished) matchSum += (m.actual_home ?? 0) + (m.actual_away ?? 0);
  const delta = pgSum - matchSum;
  if (delta === 0) ok(`gols registrados (${pgSum}) == gols dos jogos (${matchSum})`);
  else warn(`gols registrados (${pgSum}) ≠ gols dos jogos (${matchSum}) — Δ=${delta} (gols-contra/pênaltis-decisão podem explicar parte; revisar se grande)`);

  // 3b) player_goals só em jogos finalizados
  const leaked = goals.filter((g) => !finishedIds.has(g.match_id));
  leaked.length === 0 ? ok('nenhum gol em jogo não finalizado') : bad(`${leaked.length} gol(s) em jogo NÃO finalizado`);

  // 3c) gols por jogador (DB) × topscorers.json (por api_id)
  const dbByApi = new Map();
  for (const g of goals) {
    if (!finishedIds.has(g.match_id)) continue;
    const p = playerById.get(g.player_id);
    if (!p?.api_player_id) continue;
    dbByApi.set(p.api_player_id, (dbByApi.get(p.api_player_id) ?? 0) + g.goals);
  }
  let tsDiffs = 0, tsChecked = 0;
  for (const s of (topscorers.scorers ?? [])) {
    if (s.goals == null) continue;
    tsChecked++;
    const dbg = dbByApi.get(s.api_id) ?? 0;
    if (dbg !== s.goals) {
      // só reporta como ✗ se o jogador é PICKABLE (existe no players com api_id);
      // topscorers pode listar quem ninguém pode escolher (não afeta o bônus).
      const known = players.some((p) => p.api_player_id === s.api_id);
      if (known) { bad(`${s.name} (${s.team}): topscorers.json ${s.goals}g × player_goals ${dbg}g`); tsDiffs++; }
      else tsDiffs += 0; // jogador não-pickable: ignora silenciosamente
    }
  }
  tsDiffs === 0 && ok(`top scorers pickáveis batem com player_goals (${tsChecked} no topscorers.json)`);
}

// ============================================================
// 4) Cache de CLASSIFICADO coerente com a fase
// ============================================================
head('[4] Classificado (user_qualifier_points) coerente com a fase atual');
{
  const koFinished = finished.filter((m) => m.stage !== 'group').length;
  const nonZero = uqp.filter((q) => (q.points ?? 0) !== 0);
  if (koFinished === 0) {
    nonZero.length === 0
      ? ok(`nenhum mata-mata resolvido → todos os ${uqp.length} caches de classificado = 0`)
      : bad(`${nonZero.length} usuário(s) com qualifier_pts≠0 sem NENHUM mata-mata resolvido (cache espúrio)`);
  } else {
    const neg = uqp.filter((q) => (q.points ?? 0) < 0);
    neg.length === 0 ? ok(`${koFinished} mata-mata resolvido(s); nenhum cache negativo`) : bad(`${neg.length} cache(s) de classificado negativo`);
  }
}

// ============================================================
// 5) Validade dos PALPITES
// ============================================================
head('[5] Validade dos palpites');
{
  const koStages = new Set(['r32', 'r16', 'qf', 'sf', 'third', 'final']);
  let badRange = 0, penOnGroup = 0, scoredOpen = 0, unscoredFinished = 0, dupes = 0;
  const seen = new Set();
  for (const p of preds) {
    const m = matchById.get(p.match_id);
    if (p.pred_home == null || p.pred_away == null || p.pred_home < 0 || p.pred_away < 0 || p.pred_home > 20 || p.pred_away > 20) badRange++;
    if (p.pred_pen_winner && m && !koStages.has(m.stage)) penOnGroup++;
    if (m && !m.finished && p.points_earned != null) scoredOpen++;
    if (m && m.finished && p.points_earned == null) unscoredFinished++;
    const key = `${p.user_id}|${p.match_id}`;
    if (seen.has(key)) dupes++; else seen.add(key);
  }
  badRange === 0 ? ok('todos os palpites com placar em faixa válida [0..20]') : bad(`${badRange} palpite(s) fora de faixa`);
  penOnGroup === 0 ? ok('nenhum pred_pen_winner em jogo de grupo') : warn(`${penOnGroup} palpite(s) com pênalti em jogo de grupo (inócuo, mas estranho)`);
  scoredOpen === 0 ? ok('nenhum palpite pontuado em jogo aberto') : bad(`${scoredOpen} palpite(s) pontuados em jogo aberto`);
  unscoredFinished === 0 ? ok('todo palpite de jogo finalizado tem points_earned') : bad(`${unscoredFinished} palpite(s) de jogo finalizado SEM points_earned`);
  dupes === 0 ? ok('nenhum palpite duplicado (user,match)') : bad(`${dupes} palpite(s) duplicados`);

  // cobertura: pagantes têm palpites?
  const paid = profiles.filter((p) => p.paid);
  const predUsers = new Set(preds.map((p) => p.user_id));
  const paidNoPred = paid.filter((p) => !predUsers.has(p.id));
  paidNoPred.length === 0
    ? ok(`todos os ${paid.length} pagantes têm ao menos 1 palpite`)
    : warn(`${paidNoPred.length} pagante(s) sem nenhum palpite: ${paidNoPred.map((p) => p.full_name).slice(0, 5).join(', ')}`);
}

// ============================================================
// 6) PRAZO respeitado de verdade (via prediction_audit)
// ============================================================
// CUIDADO (falso-positivo conhecido, ver memória integrity-late-false-positive):
// o scoring (on_match_finished) faz UPDATE em predictions p/ gravar points_earned
// — isso vira uma linha de audit com `at` DEPOIS do prazo, mas o placar NÃO muda.
// E p/ palpites criados ANTES da 035, o INSERT não está na trilha, então a 1ª
// linha registrada já é esse UPDATE de scoring. Pegar "o timestamp da última
// entrada" acusaria edição falsa. O check ROBUSTO: uma entrada só é EDIÇÃO REAL
// se for INSERT, ou UPDATE em que new_data.pred difere de old_data.pred.
head('[6] Prazo respeitado (edição REAL de conteúdo via prediction_audit)');
{
  const audit = await pageAll('prediction_audit', 'id, table_name, op, row_user_id, match_id, old_data, new_data, actor_is_admin, at');
  const lastEdit = new Map(); // key -> { at, admin } da última edição REAL de placar
  for (const a of audit) {
    if (a.table_name !== 'predictions') continue;
    let isEdit = false;
    if (a.op === 'INSERT') isEdit = !!a.new_data;
    else if (a.op === 'UPDATE' && a.old_data && a.new_data) {
      isEdit = a.old_data.pred_home !== a.new_data.pred_home
            || a.old_data.pred_away !== a.new_data.pred_away
            || (a.old_data.pred_pen_winner ?? null) !== (a.new_data.pred_pen_winner ?? null);
    }
    if (!isEdit) continue; // scoring / no-op: ignora
    lastEdit.set(`${a.row_user_id}|${a.match_id}`, { at: new Date(a.at), admin: a.actor_is_admin });
  }
  let late = 0;
  const examples = [];
  for (const [key, v] of lastEdit) {
    const mid = Number(key.split('|')[1]);
    const m = matchById.get(mid);
    if (!m) continue;
    const dl = predictionDeadline(m.match_date);
    if (v.at.getTime() > dl.getTime() + 1000) {
      late++;
      if (examples.length < 8) examples.push(`u=${key.slice(0, 8)} M${mid}${v.admin ? ' [admin]' : ''}: editou ${v.at.toISOString()} > prazo ${dl.toISOString()}`);
    }
  }
  late === 0
    ? ok(`${lastEdit.size} palpites com trilha: nenhuma edição REAL de placar após o prazo`)
    : (bad(`${late} palpite(s) com edição REAL de placar após o prazo`), examples.forEach((e) => console.log(`${C.dim}     ${e}${C.x}`)));
}

// ============================================================
// 7) Picks válidos + cobertura FIFA-rank
// ============================================================
head('[7] Picks de campeão/artilheiro + cobertura FIFA-rank');
{
  const champBad = champPicks.filter((c) => !rankTeams.has(c.team));
  champBad.length === 0
    ? ok(`${champPicks.length} picks de campeão: todos times válidos (no team_fifa_rank)`)
    : bad(`${champBad.length} pick(s) de campeão com time inexistente: ${champBad.map((c) => c.team).slice(0, 5).join(', ')}`);

  const scorerBad = scorerPicks.filter((s) => !playerById.has(s.player_id));
  scorerBad.length === 0
    ? ok(`${scorerPicks.length} picks de artilheiro: todos jogadores existem`)
    : bad(`${scorerBad.length} pick(s) de artilheiro com player_id inexistente`);

  // todo time dos jogos de grupo precisa existir no team_fifa_rank (senão desempate quebra → 999)
  const groupTeams = new Set();
  for (const m of matches.filter((x) => x.stage === 'group')) { groupTeams.add(m.team_home); groupTeams.add(m.team_away); }
  const missingRank = [...groupTeams].filter((t) => !rankTeams.has(t));
  missingRank.length === 0
    ? ok(`${groupTeams.size} times de grupo: todos no team_fifa_rank (desempate íntegro)`)
    : bad(`times sem FIFA-rank (desempate vira 999): ${missingRank.join(', ')}`);
  // sanidade extra: fifaRank() do front concorda que todos têm rank < 999
  const frontMissing = [...groupTeams].filter((t) => fifaRank(t) >= 999);
  frontMissing.length === 0
    ? ok('fifa-rank.js (front) cobre todos os times de grupo')
    : warn(`fifa-rank.js (front) devolve 999 p/: ${frontMissing.join(', ')}`);
}

// ============================================================
console.log(`\n${C.bold}${fails === 0
  ? C.g + `✅ DADOS DE PROD CONFEREM com a realidade externa${warns ? ` (${warns} aviso(s) — revisar)` : ''}`
  : C.r + `❌ ${fails} divergência(s) de dados em PROD — ver acima${warns ? ` (+${warns} aviso(s))` : ''}`}${C.x}`);
console.log(`${C.dim}   (nenhuma escrita foi feita em produção)${C.x}`);
process.exit(fails === 0 ? 0 : 1);

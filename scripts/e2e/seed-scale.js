#!/usr/bin/env node
/**
 * seed-scale.js — Semeia o bolão em ESCALA DE PRODUÇÃO no DB LOCAL (service role).
 * ============================================================================
 * Objetivo: dataset realista (~70 usuários) p/ exercitar ranking, RLS em escala,
 * concorrência de deadline e o Raio-X (odds/h2h/previsões) — SEM tocar produção
 * e SEM PII. Tudo determinístico (seed PRNG) → reprodutível e auditável.
 *
 * O QUE FAZ
 *   1. Gera o oráculo do torneio (simulateTournament) e salva expected-tournament.json
 *   2. Monta um roster de N perfis: 10 perfis-borda determinísticos (test-users.json)
 *      + (N-10) perfis realistas (mix de estratégias / paid / bônus).
 *   3. Cria os usuários (Admin API, email confirmado) + profiles.
 *   4. Gera e grava palpites + campeão + artilheiro de cada um (bulk upsert).
 *   5. (default) Semeia enriquecimento: match_odds, match_h2h, match_predictions,
 *      team_h2h — nos shapes que o front (raiox.js) consome.
 *   6. Emite playout.sql (aplicável via psql p/ "jogar" o torneio e pontuar todos).
 *   7. Escreve sim-roster.json (perfis + user_ids + esperado) p/ a auditoria.
 *
 * ESTADO RESULTANTE = PRÉ-TORNEIO (palpites abertos, nenhum resultado lançado) —
 * o estado REAL hoje (Copa começa 11/jun). Pra estado pós-resultados, aplique o
 * playout.sql gerado (ou rode o harness 04-admin-results.js).
 *
 * USO
 *   source .env.e2e.local
 *   node scripts/e2e/seed-scale.js                 # 70 users + enriquecimento
 *   node scripts/e2e/seed-scale.js --users=100     # outra escala
 *   node scripts/e2e/seed-scale.js --no-enrichment # só users+palpites
 *   node scripts/e2e/seed-scale.js --keep          # não limpa sim-users anteriores
 *
 * GUARD-RAIL: aborta se SUPABASE_URL não for local (lib/admin-client.js).
 */
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { makeAdminClient, adminCreateUser, adminCreateProfile } from './lib/admin-client.js';
import { simulateTournament } from './lib/tournament-simulator.js';
import { genPrediction, genChampionPick, genScorerPick } from './lib/predictions.js';
import { makeRng } from './lib/prng.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const N = parseInt(args.users || '70', 10);
const SEED = args.seed || 'wc2026-scale-v1';
const ENRICH = args.enrichment !== false && args['no-enrichment'] !== true;
const CLEAN = args.keep !== true;
const PASSWORD = 'SimUser2026!';

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c]}${m}${C.reset}`);

const FIRST = ['Lucas', 'Mateus', 'Pedro', 'Gabriel', 'Rafael', 'Bruno', 'Felipe', 'Thiago', 'Gustavo', 'Daniel', 'Ana', 'Júlia', 'Mariana', 'Camila', 'Larissa', 'Beatriz', 'Carolina', 'Fernanda', 'Patrícia', 'Aline', 'Rodrigo', 'Marcelo', 'Vinícius', 'Eduardo', 'Caio', 'André', 'Diego', 'Leandro', 'Renato', 'Fábio'];
const LAST = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Pereira', 'Costa', 'Almeida', 'Ferreira', 'Rodrigues', 'Gomes', 'Martins', 'Araújo', 'Barbosa', 'Ribeiro', 'Carvalho', 'Teixeira', 'Moraes', 'Cardoso', 'Nunes'];
const AVATARS = ['assets/avatars/daniel.png', 'assets/avatars/caio.webp'];

// Sorteio ponderado determinístico.
function weighted(rng, pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[pairs.length - 1][0];
}

// ----- roster -----
function buildRoster(rng) {
  // 10 perfis-borda determinísticos (cobrem cada regra de scoring/bônus).
  const EDGE = [
    { key: 'perfect', strategy: 'exact_all', champion: 'match_winner', topScorer: 'actual_top', paid: true },
    { key: 'perfect_no_champ', strategy: 'exact_all', champion: 'non_winner', topScorer: 'actual_top', paid: true },
    { key: 'perfect_no_scorer', strategy: 'exact_all', champion: 'match_winner', topScorer: 'no_goals', paid: true },
    { key: 'half_predictor', strategy: 'mixed_50', champion: 'non_winner', topScorer: 'no_goals', paid: true },
    { key: 'no_champion', strategy: 'winner_only', champion: null, topScorer: 'actual_top', paid: true },
    { key: 'no_scorer', strategy: 'winner_sg', champion: 'match_winner', topScorer: null, paid: true },
    { key: 'not_paid', strategy: 'exact_all', champion: 'match_winner', topScorer: 'actual_top', paid: false },
    { key: 'last_minute', strategy: 'random', champion: 'non_winner', topScorer: 'no_goals', paid: true },
    { key: 'groups_only', strategy: 'exact_groups_only', champion: 'match_winner', topScorer: 'actual_top', paid: true },
    { key: 'wrong_winner', strategy: 'one_side_only', champion: 'non_winner', topScorer: 'no_goals', paid: true },
  ];
  const roster = EDGE.map((p, i) => ({ ...p, idx: i, edge: true, name: `[edge] ${p.key}` }));

  for (let i = EDGE.length; i < N; i++) {
    const strategy = weighted(rng, [
      ['winner_sg', 28], ['winner_only', 24], ['mixed_50', 16], ['one_side_only', 12],
      ['exact_all', 8], ['exact_groups_only', 6], ['random', 6],
    ]);
    const champion = weighted(rng, [['match_winner', 18], ['non_winner', 72], [null, 10]]);
    const topScorer = weighted(rng, [['actual_top', 22], ['no_goals', 62], [null, 16]]);
    const paid = rng() < 0.87;
    const name = `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`;
    roster.push({ key: `u${String(i + 1).padStart(3, '0')}`, idx: i, edge: false, name, strategy, champion, topScorer, paid });
  }
  return roster;
}

// ----- enriquecimento -----
function deriveOdds(rankH, rankA, rng) {
  // Força ~ 1/rank^0.55. Probabilidade de vitória + empate, com margem de book ~7%.
  const sH = 1 / Math.pow(rankH || 48, 0.55), sA = 1 / Math.pow(rankA || 48, 0.55);
  const draw = 0.22 + rng() * 0.08;
  let pH = (sH / (sH + sA)) * (1 - draw), pA = (sA / (sH + sA)) * (1 - draw), pD = draw;
  const margin = 1.07;
  const odd = (p) => Math.max(1.05, Math.round((1 / (p * margin)) * 100) / 100);
  return { odd_home: odd(pH), odd_draw: odd(pD), odd_away: odd(pA) };
}

function buildH2HFixtures(home, away, rng) {
  const n = Math.floor(rng() * 6); // 0..5 confrontos passados
  const comps = ['Friendlies', 'World Cup - Qualification', 'FIFA World Cup', 'UEFA Nations League'];
  const fixtures = [];
  let hw = 0, dr = 0, aw = 0;
  for (let i = 0; i < n; i++) {
    const hg = Math.floor(rng() * 4), ag = Math.floor(rng() * 4);
    const year = 2016 + Math.floor(rng() * 9);
    const mo = String(1 + Math.floor(rng() * 12)).padStart(2, '0');
    const da = String(1 + Math.floor(rng() * 28)).padStart(2, '0');
    if (hg > ag) hw++; else if (hg < ag) aw++; else dr++;
    fixtures.push({ date: `${year}-${mo}-${da}`, home, away, home_goals: hg, away_goals: ag, competition: comps[Math.floor(rng() * comps.length)] });
  }
  fixtures.sort((a, b) => b.date.localeCompare(a.date));
  return { fixtures, summary: { home_wins: hw, draws: dr, away_wins: aw, total: n } };
}

function buildPredictionPayload(home, away, rankH, rankA, odds, rng) {
  const probs = (() => {
    const ih = 1 / odds.odd_home, idr = 1 / odds.odd_draw, ia = 1 / odds.odd_away, s = ih + idr + ia;
    return { pHome: Math.round((ih / s) * 100), pDraw: Math.round((idr / s) * 100), pAway: Math.round((ia / s) * 100) };
  })();
  const favored = probs.pHome >= probs.pDraw && probs.pHome >= probs.pAway ? 'home'
    : probs.pAway >= probs.pDraw && probs.pAway >= probs.pHome ? 'away' : 'draw';
  // Radar 0-100: time melhor ranqueado tende a valores maiores (com ruído).
  const strength = (r) => Math.max(20, Math.min(95, Math.round(100 - (r || 48) * 1.4 + (rng() * 20 - 10))));
  const side = (r) => [strength(r), strength(r), strength(r), strength(r), strength(r)];
  const cmp = [['Forma'], ['Ataque'], ['Defesa'], ['Confronto'], ['Geral']].map(([label]) => {
    const h = 30 + Math.floor(rng() * 41); return { label, home: h, away: 100 - h };
  });
  return {
    source: 'API-Football', pHome: probs.pHome, pDraw: probs.pDraw, pAway: probs.pAway, favored,
    comparison: cmp, radar: { axes: ['Forma', 'Ataque', 'Defesa', 'Gols pró', 'Solidez'], home: side(rankH), away: side(rankA) },
  };
}

async function main() {
  log('blue', `${C.bold}🌱 seed-scale: ${N} usuários sintéticos + palpites${ENRICH ? ' + enriquecimento' : ''}${C.reset}`);
  log('dim', `   seed=${SEED}  url=${process.env.SUPABASE_URL}`);
  const admin = makeAdminClient();
  const now = new Date().toISOString();

  // 1. matches + players
  const { data: matches, error: mErr } = await admin.from('matches')
    .select('id, stage, group_name, team_home, team_away, slot_home, slot_away, match_date').order('id');
  if (mErr) throw mErr;
  let players = [], page = 0;
  while (true) {
    const { data, error } = await admin.from('players').select('id, full_name, team, position').range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    players = players.concat(data); if (data.length < 1000) break; page++;
  }
  const { data: ranks } = await admin.from('team_fifa_rank').select('team, rank');
  const rankByTeam = new Map((ranks || []).map((r) => [r.team, r.rank]));
  log('green', `   ✓ ${matches.length} matches, ${players.length} players, ${rankByTeam.size} ranks`);

  // 2. oráculo
  log('blue', '\n🏆 Simulando torneio (oráculo)...');
  const oracle = simulateTournament(matches, players, SEED);
  const oracleById = new Map(oracle.matches.map((m) => [m.id, m]));
  writeFileSync(join(__dirname, 'expected-tournament.json'), JSON.stringify(oracle, null, 2));
  log('green', `   ✓ campeão=${oracle.champion}  artilheiro=${oracle.topScorer?.full_name} (${oracle.topScorer?.total_goals}g)`);

  // 3. roster + limpeza
  const rng = makeRng(SEED);
  const roster = buildRoster(rng);
  if (CLEAN) {
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const stale = (list?.users || []).filter((u) => u.email && u.email.startsWith('sim-'));
    for (const u of stale) await admin.auth.admin.deleteUser(u.id);
    log('yellow', `   🗑️  ${stale.length} sim-users anteriores removidos`);
  }

  // 4. cria users + profiles
  log('blue', `\n👥 Criando ${roster.length} usuários...`);
  const allTeams = [...new Set(matches.filter((m) => m.stage === 'group').flatMap((m) => [m.team_home, m.team_away]))];
  for (const p of roster) {
    const email = `sim-${String(p.idx + 1).padStart(3, '0')}@bolao.test`;
    const user = await adminCreateUser(admin, email, PASSWORD, p.name);
    await adminCreateProfile(admin, user, p.name, { paid: p.paid, avatar_url: AVATARS[p.idx % AVATARS.length] });
    p.user_id = user.id; p.email = email;
  }
  log('green', `   ✓ ${roster.length} usuários criados (${roster.filter((p) => p.paid).length} pagantes)`);

  // 5. palpites + bônus
  log('blue', '\n📝 Gerando palpites...');
  const preds = [], champs = [], scorers = [];
  for (const p of roster) {
    const urng = makeRng(`pred-${p.key}-${SEED}`);
    for (const m of oracle.matches) {
      const pred = genPrediction({ id: m.id, stage: m.stage }, m, p.strategy, urng);
      if (pred) preds.push({ user_id: p.user_id, match_id: m.id, pred_home: pred.pred_home, pred_away: pred.pred_away, pred_pen_winner: pred.pred_pen_winner });
    }
    const champ = genChampionPick(p.champion, oracle.champion, allTeams, urng);
    if (champ) champs.push({ user_id: p.user_id, team: champ });
    const scorerId = genScorerPick(p.topScorer, oracle.topScorer, players, urng);
    if (scorerId) scorers.push({ user_id: p.user_id, player_id: scorerId });
  }
  // bulk upsert em chunks
  const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  for (const c of chunk(preds, 500)) {
    const { error } = await admin.from('predictions').upsert(c, { onConflict: 'user_id,match_id' });
    if (error) throw new Error('predictions: ' + error.message);
  }
  for (const c of chunk(champs, 500)) { const { error } = await admin.from('champion_picks').upsert(c, { onConflict: 'user_id' }); if (error) throw new Error('champion: ' + error.message); }
  for (const c of chunk(scorers, 500)) { const { error } = await admin.from('top_scorer_picks').upsert(c, { onConflict: 'user_id' }); if (error) throw new Error('scorer: ' + error.message); }
  log('green', `   ✓ ${preds.length} palpites, ${champs.length} campeão, ${scorers.length} artilheiro`);

  // 6. enriquecimento
  if (ENRICH) {
    log('blue', '\n🔍 Semeando enriquecimento (odds/h2h/previsões)...');
    const groupMatches = matches.filter((m) => m.stage === 'group');
    const erng = makeRng(`enrich-${SEED}`);
    const odds = [], h2h = [], mpred = [];
    for (const m of groupMatches) {
      const rH = rankByTeam.get(m.team_home), rA = rankByTeam.get(m.team_away);
      const o = deriveOdds(rH, rA, erng);
      odds.push({ match_id: m.id, ...o, bookmaker_id: 8, bookmaker_name: 'Bet365 (sim)', api_updated_at: now, fetched_at: now });
      const hh = buildH2HFixtures(m.team_home, m.team_away, erng);
      h2h.push({ match_id: m.id, fixtures: hh.fixtures, summary: hh.summary, api_team_home: m.id * 2, api_team_away: m.id * 2 + 1, fetched_at: now });
      mpred.push({ match_id: m.id, payload: buildPredictionPayload(m.team_home, m.team_away, rH, rA, o, erng), advice: `Aposta: ${m.team_home}`, fetched_at: now });
    }
    for (const c of chunk(odds, 500)) { const { error } = await admin.from('match_odds').upsert(c, { onConflict: 'match_id' }); if (error) throw new Error('odds: ' + error.message); }
    for (const c of chunk(h2h, 200)) { const { error } = await admin.from('match_h2h').upsert(c, { onConflict: 'match_id' }); if (error) throw new Error('h2h: ' + error.message); }
    for (const c of chunk(mpred, 200)) { const { error } = await admin.from('match_predictions').upsert(c, { onConflict: 'match_id' }); if (error) throw new Error('match_predictions: ' + error.message); }

    // team_h2h p/ alguns pares de peso (modal do mata-mata busca on-demand por par)
    const marquee = [['Brazil', 'Argentina'], ['France', 'Spain'], ['England', 'Germany'], ['Portugal', 'Netherlands'], ['Brazil', 'France']];
    const th = marquee.map(([a, b]) => { const hh = buildH2HFixtures(a, b, erng); return { team_a: a, team_b: b, fixtures: hh.fixtures, summary: hh.summary, api_team_a: null, api_team_b: null, fetched_at: now }; });
    const { error: thErr } = await admin.from('team_h2h').upsert(th, { onConflict: 'team_a,team_b' });
    if (thErr) log('yellow', `   ⚠ team_h2h: ${thErr.message}`); else log('green', `   ✓ team_h2h: ${th.length} pares`);
    log('green', `   ✓ odds=${odds.length}, match_h2h=${h2h.length}, match_predictions=${mpred.length}`);
  }

  // 7. playout.sql (aplicável via psql p/ pontuar todos)
  // Resultados em ordem de match_date p/ a cascata de slots (trigger_resolve_slots)
  // preencher team_home/away dos jogos seguintes antes de eles serem lançados.
  const dateById = new Map(matches.map((m) => [m.id, m.match_date]));
  const ordered = oracle.matches.slice().sort((a, b) => new Date(dateById.get(a.id)) - new Date(dateById.get(b.id)));
  const upd = ordered.map((m) => {
    const pen = m.pen_winner ? `'${m.pen_winner}'` : 'null';
    return `update public.matches set actual_home=${m.actual_home}, actual_away=${m.actual_away}, pen_winner=${pen}, finished=true, status='finished', finished_at=now() where id=${m.id};`;
  });
  const goalsRows = [];
  for (const m of oracle.matches) for (const s of (m.scorers || [])) goalsRows.push(`(${s.player_id}, ${m.id}, ${s.goals})`);
  // Desliga só os triggers de ALERTA (postam ao edge/Telegram). Os de NEGÓCIO
  // (on_match_finished=scoring, trigger_resolve_slots, trg_s_qualifier_bonus)
  // ficam ligados e disparam em cascata na ordem cronológica.
  // result_corrected, champion_revealed e ko_phase_opens foram removidos na migration 053.
  // scoring_anomaly adicionado na 054.
  const ALERT_TRG = ['trg_z_alert_match_status', 'trg_z_alert_orphan_predictions', 'trg_z_alert_result_confirmed', 'trg_z_alert_scoring_anomaly', 'trg_z_alert_unresolved_slots'];
  const playout = [
    '-- playout.sql — joga o torneio (oráculo) e pontua todos. Gerado por seed-scale.js.',
    '-- Aplicar: docker exec -i supabase_db_world-cup-2026 psql -U postgres -d postgres < scripts/e2e/playout.sql',
    '-- Triggers de NEGÓCIO ficam ligados (scoring/slots/qualifier disparam em cascata).',
    '-- Triggers de ALERTA desligados (não postar ao edge durante o bulk).',
    'begin;',
    ...ALERT_TRG.map((t) => `alter table public.matches disable trigger ${t};`),
    '-- resultados em ordem cronológica → slots resolvem antes do próximo round:',
    ...upd,
    ...ALERT_TRG.map((t) => `alter table public.matches enable trigger ${t};`),
    goalsRows.length ? `insert into public.player_goals (player_id, match_id, goals) values\n  ${goalsRows.join(',\n  ')}\n  on conflict (player_id, match_id) do update set goals=excluded.goals;` : '',
    'commit;',
  ].join('\n');
  writeFileSync(join(__dirname, 'playout.sql'), playout);

  // 8. roster artifact
  writeFileSync(join(__dirname, 'sim-roster.json'), JSON.stringify({
    meta: { seed: SEED, users: roster.length, paid: roster.filter((p) => p.paid).length, generated_at: now, champion: oracle.champion, topScorer: oracle.topScorer },
    users: roster.map((p) => ({ key: p.key, email: p.email, user_id: p.user_id, name: p.name, strategy: p.strategy, champion: p.champion, topScorer: p.topScorer, paid: p.paid, edge: p.edge })),
  }, null, 2));

  log('green', `\n${C.bold}✅ Seed concluído.${C.reset}`);
  log('blue', `   roster:   scripts/e2e/sim-roster.json`);
  log('blue', `   oráculo:  scripts/e2e/expected-tournament.json`);
  log('blue', `   playout:  scripts/e2e/playout.sql  (aplique p/ estado pós-resultados)`);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });

#!/usr/bin/env node
/**
 * Snapshot de integridade dos palpites (defensibilidade do bolão — achado H3).
 *
 * Exporta um JSON CANÔNICO (chaves ordenadas → bytes determinísticos) com TODOS
 * os palpites de jogos JÁ TRAVADOS (deadline da véspera 23h59 BRT já passou),
 * mais os picks de campeão/artilheiro (se o deadline deles passou) e os
 * resultados conhecidos. Calcula o SHA-256 do conteúdo e ENCADEIA com o snapshot
 * anterior (chain_hash = SHA256(prev_chain_hash || content_hash)).
 *
 * Os arquivos vão pra integrity/snapshots/ e o encadeamento pro integrity/
 * manifest.json — commitados pela GitHub Action (prova de timestamp via histórico
 * do GitHub) e, opcionalmente, postados no Telegram (timestamp de terceiro).
 *
 * Qualquer participante consegue rodar `npm run integrity:verify` e provar que a
 * cadeia não foi adulterada — sem confiar no operador do banco.
 *
 * Idempotente: se nada mudou desde o último snapshot (mesmo content_hash), não
 * cria arquivo novo.
 *
 * Usage: node scripts/integrity/snapshot.js
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (+ TELEGRAM_TOKEN/TELEGRAM_CHAT_ID opcionais)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { buildReport, brtDateStamp } from './report.js';
import { buildPicksMessages } from './telegram-picks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const INTEGRITY_DIR = join(__dirname, '..', '..', 'integrity');
const SNAP_DIR = join(INTEGRITY_DIR, 'snapshots');
const REPORT_DIR = join(INTEGRITY_DIR, 'reports');
const MANIFEST = join(INTEGRITY_DIR, 'manifest.json');
const GENESIS = '0'.repeat(64);

// Mensagens de palpites recém-lacrados: geradas aqui, postadas por
// post-picks.js DEPOIS do commit/push do relatório (gitignored — nunca entra
// no lacre). KEEP IN SYNC: post-picks.js e integrity-snapshot.yml.
const PICKS_OUT_DIR = join(__dirname, '.tmp');
const PICKS_OUT_FILE = join(PICKS_OUT_DIR, 'locked-picks-telegram.json');

// Links públicos do relatório/Telegram. Na Action os env vem do GitHub; o
// fallback é o repositório canônico (público) para runs manuais.
const REPO_URL = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY || 'danieloda/world-cup-2026'}`;
const BRANCH = process.env.GITHUB_REF_NAME || 'main';

function assert(cond, msg) { if (!cond) { console.error('ERRO:', msg); process.exit(1); } }
assert(SUPABASE_URL, 'SUPABASE_URL ausente em .env/secrets');
assert(SERVICE_KEY, 'SUPABASE_SERVICE_ROLE_KEY ausente em .env/secrets');

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Deadline de palpite: véspera 23h59 BRT (UTC-3 fixo). Jogo à meia-noite (00h BRT)
// trava com o lote do dia anterior (véspera da véspera). IGUAL a src/js/util.js e
// public.prediction_deadline (migrations 023 + 063).
const BRT_OFFSET_MS = 3 * 3600000;
function predictionDeadline(matchDate) {
  const brt = new Date(new Date(matchDate).getTime() - BRT_OFFSET_MS);
  const daysBack = brt.getUTCHours() === 0 ? 2 : 1;
  const wall = Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate() - daysBack, 23, 59, 0);
  return new Date(wall + BRT_OFFSET_MS);
}

// Canonicaliza recursivamente (chaves ordenadas) → mesmos bytes em qualquer máquina.
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
const canonStringify = (obj) => JSON.stringify(canon(obj), null, 2) + '\n';
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// Pagina além do teto de 1000 linhas do PostgREST.
async function fetchAllPages(makeQuery, pageSize = 1000) {
  const all = [];
  for (let page = 0; ; page++) {
    const from = page * pageSize;
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    assert(!error, error?.message);
    if (data?.length) all.push(...data);
    if (!data || data.length < pageSize) break;
  }
  return all;
}

function parseCsDeadline(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/^"|"$/g, '');
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

async function postTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e) {
    console.warn('Telegram (best-effort) falhou:', e.message);
  }
}

// ============================================================
// Alerta de palpites recém-lacrados (engajamento) — DESACOPLADO do lock
// ============================================================
// O alerta sai DE MANHÃ, não na trava (00:10 BRT): aí todos os jogos do dia
// anterior — inclusive os de madrugada (kickoff até ~01h BRT) — já terminaram e
// foram apurados pelo admin, então o ranking lido do v_leaderboard é REAL e bate
// com o site (jogos + artilheiro + campeão + classificados). Roda em TODA
// invocação do snapshot (mesmo quando dedupa), com três guardas:
//   1. Janela matinal (4h–12h BRT): as fixtures não têm jogo entre 02h e 12h BRT,
//      então a manhã é sempre "depois de tudo e antes do 1º jogo (13h BRT)".
//   2. Jogos finalizados: nenhum jogo já iniciado pode estar sem placar.
//   3. Anúncio-único: âncora no último lacre ANUNCIADO (settings), não no
//      snapshot anterior — manda exatamente uma vez por lacre, mesmo com os
//      re-snapshots de resultado. post-picks.js grava o estado após enviar.
// KEEP IN SYNC: post-picks.js (consome o .tmp + grava o estado) e a migração do
// dispatch matinal (cron que acorda a Action de manhã).
const PICKS_BRT_FROM = 4;   // depois dos jogos de madrugada (terminam ~03h BRT)
const PICKS_BRT_TO = 13;    // antes do 1º jogo do dia (13h BRT)
const ANNOUNCE_KEY = 'integrity_picks_announced';
const NOT_PLAYED = ['void', 'postponed', 'canceled', 'cancelled'];

const brtHour = (d) => (d.getUTCHours() + 24 - 3) % 24;

async function readAnnounceState() {
  const { data } = await admin.from('settings').select('value').eq('key', ANNOUNCE_KEY).maybeSingle();
  if (!data) return null;
  try { return typeof data.value === 'string' ? JSON.parse(data.value) : data.value; } catch { return null; }
}

async function maybeEmitPicks({ now, content, matches, manifest, entry }) {
  // 1) Janela matinal — o run da trava (00:10 BRT) cai fora e adia.
  const h = brtHour(now);
  if (h < PICKS_BRT_FROM || h >= PICKS_BRT_TO) {
    console.log(`   alerta de palpites: fora da janela matinal (${h}h BRT) — adiado.`);
    return;
  }
  // 2) Gate: nenhum jogo já iniciado pode estar sem placar (em campo / não
  //    apurado) — senão o ranking sairia incompleto.
  const pending = matches.filter((m) =>
    new Date(m.match_date) <= now && !m.finished && !NOT_PLAYED.includes(m.status));
  if (pending.length) {
    console.log(`   alerta de palpites: ${pending.length} jogo(s) sem placar ainda — adiado até apurar.`);
    return;
  }
  // 3) Âncora = último lacre ANUNCIADO (não o snapshot imediatamente anterior).
  const state = await readAnnounceState();
  let prevLocked;
  if (state?.seq != null) {
    const annEntry = manifest.entries.find((e) => e.seq === state.seq);
    let annSnap = null;
    if (annEntry) {
      try { annSnap = JSON.parse(readFileSync(join(INTEGRITY_DIR, annEntry.file), 'utf8')); } catch { /* ilegível */ }
    }
    prevLocked = new Set(annSnap?.locked_match_ids ?? []);
  } else {
    // Sem estado (1ª vez): trata como já anunciado tudo que travou há +24h, pra
    // só os jogos do último dia entrarem (não o torneio inteiro).
    const dayAgo = new Date(now.getTime() - 24 * 3600000);
    prevLocked = new Set(matches.filter((m) => predictionDeadline(m.match_date) <= dayAgo).map((m) => m.id));
  }
  const newLocked = content.locked_match_ids.filter((id) => !prevLocked.has(id));
  if (newLocked.length === 0) {
    console.log('   alerta de palpites: nada novo desde o último anunciado — silêncio.');
    return;
  }
  // 4) Ranking OFICIAL (v_leaderboard) — total_pts idêntico ao site (jogos +
  //    artilheiro + campeão + classificados). Seleciona SÓ as colunas de pontos
  //    (a view tem coluna de contato que o lacre nunca pode vazar — fica fora).
  const { data: leaderboard, error: lbErr } = await admin
    .from('v_leaderboard')
    .select('user_id, total_pts, exact_count, winner_sg_count, scorer_pts');
  if (lbErr) console.warn('   v_leaderboard indisponível — ranking cai no derivado do snapshot:', lbErr.message);

  // Ordem atual (guardada pra medir "subiu/caiu" no próximo lacre) — mesmo
  // desempate da página de ranking (total → exatos → vencedor+saldo).
  const nameById = new Map((content.users ?? []).map((u) => [u.user_id, u.name]));
  const nameOf = (id) => nameById.get(id) || '';
  const currentRanking = (leaderboard ?? []).slice()
    .sort((a, b) =>
      (b.total_pts ?? 0) - (a.total_pts ?? 0)
      || (b.exact_count ?? 0) - (a.exact_count ?? 0)
      || (b.winner_sg_count ?? 0) - (a.winner_sg_count ?? 0)
      || nameOf(a.user_id).localeCompare(nameOf(b.user_id), 'pt-BR'))
    .map((r) => r.user_id);

  const reportFname = `${String(entry.seq).padStart(4, '0')}_${brtDateStamp(new Date(entry.taken_at))}.md`;
  const picksMessages = buildPicksMessages({
    entry,
    content,
    prevContent: { locked_match_ids: [...prevLocked] },
    matches,
    reportUrl: `${REPO_URL}/blob/${BRANCH}/integrity/reports/${reportFname}`,
    leaderboard: leaderboard ?? null,
    prevRanking: state?.ranking ?? null,
  });
  if (!picksMessages.length) {
    console.log('   alerta de palpites: nenhum bloco gerado — silêncio.');
    return;
  }
  if (!existsSync(PICKS_OUT_DIR)) mkdirSync(PICKS_OUT_DIR, { recursive: true });
  writeFileSync(PICKS_OUT_FILE, JSON.stringify({ seq: entry.seq, ranking: currentRanking, messages: picksMessages }, null, 2) + '\n');
  console.log(`   alerta de palpites: ${picksMessages.length} mensagem(ns) do lacre #${entry.seq} aguardando publish (post-picks.js).`);
}

async function main() {
  const now = new Date();

  const { data: matches, error: me } = await admin
    .from('matches')
    .select('id, stage, match_date, team_home, team_away, actual_home, actual_away, pen_winner, finished, status')
    .order('id');
  assert(!me, me?.message);

  const lockedIds = matches
    .filter((m) => predictionDeadline(m.match_date) <= now)
    .map((m) => m.id)
    .sort((a, b) => a - b);

  const preds = lockedIds.length
    ? await fetchAllPages(() =>
        admin.from('predictions')
          .select('user_id, match_id, pred_home, pred_away, pred_pen_winner, updated_at')
          .in('match_id', lockedIds).order('id'))
    : [];

  const { data: csRow } = await admin.from('settings').select('value').eq('key', 'deadline_champion_scorer').maybeSingle();
  const csDeadline = parseCsDeadline(csRow?.value);
  const csPassed = csDeadline && now >= csDeadline;

  const champions = csPassed
    ? await fetchAllPages(() => admin.from('champion_picks').select('user_id, team, updated_at').order('user_id'))
    : [];
  const scorers = csPassed
    ? await fetchAllPages(() => admin.from('top_scorer_picks').select('user_id, player_id, updated_at').order('user_id'))
    : [];

  // Nome de usuário do app (full_name) — NUNCA o e-mail — lacrado junto, para
  // que a associação nome ↔ palpite do relatório também seja protegida pela
  // corrente. Só entram usuários referenciados por algum registro lacrado.
  const refUserIds = new Set([
    ...preds.map((p) => p.user_id),
    ...champions.map((c) => c.user_id),
    ...scorers.map((s) => s.user_id),
  ]);
  const users = refUserIds.size
    ? (await fetchAllPages(() => admin.from('profiles').select('id, full_name').order('id')))
        .filter((p) => refUserIds.has(p.id))
        .map((p) => ({ user_id: p.id, name: p.full_name }))
    : [];

  // Idem para os jogadores citados em picks de artilheiro (player_id → nome).
  const refPlayerIds = new Set(scorers.map((s) => s.player_id));
  const players = refPlayerIds.size
    ? (await fetchAllPages(() => admin.from('players').select('id, full_name, team').order('id')))
        .filter((p) => refPlayerIds.has(p.id))
        .map((p) => ({ id: p.id, name: p.full_name, team: p.team }))
    : [];

  const byUserMatch = (a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : a.match_id - b.match_id);
  const byUser = (a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0);

  // ⚠️ NADA de timestamp aqui dentro: o conteúdo é só DADO, para que dois runs
  // sem mudança no banco produzam o MESMO content_hash (é isso que torna o
  // "Sem mudança" abaixo real — antes o taken_at entrava no hash e o dedupe
  // nunca disparava: snapshots #1–#4 eram idênticos exceto pelo relógio).
  // O instante do carimbo vive no manifest (taken_at), no nome do arquivo e
  // nos timestamps de terceiro (git/Telegram).
  const content = {
    version: 3,
    users: users.sort(byUser),
    players: players.sort((a, b) => a.id - b.id),
    locked_match_ids: lockedIds,
    results: matches
      .filter((m) => m.finished)
      .map((m) => ({
        match_id: m.id, stage: m.stage, status: m.status,
        actual_home: m.actual_home, actual_away: m.actual_away, pen_winner: m.pen_winner,
      }))
      .sort((a, b) => a.match_id - b.match_id),
    predictions: preds
      .map((p) => ({
        user_id: p.user_id, match_id: p.match_id,
        pred_home: p.pred_home, pred_away: p.pred_away,
        pred_pen_winner: p.pred_pen_winner, updated_at: p.updated_at,
      }))
      .sort(byUserMatch),
    champion_picks: champions.map((c) => ({ user_id: c.user_id, team: c.team, updated_at: c.updated_at })).sort(byUser),
    scorer_picks: scorers.map((s) => ({ user_id: s.user_id, player_id: s.player_id, updated_at: s.updated_at })).sort(byUser),
  };

  const body = canonStringify(content);
  const contentHash = sha256(body);

  const manifest = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
    : { version: 1, description: 'Cadeia de integridade dos palpites do bolão. Verifique com: npm run integrity:verify', entries: [] };

  const last = manifest.entries[manifest.entries.length - 1];
  const unchanged = last && last.content_hash === contentHash;

  // O lacre (snapshot + relatório + cadeia) é criado no run da TRAVA (00:10 BRT)
  // e dedupa quando nada mudou. O ALERTA de palpites não sai mais junto: ele é
  // desacoplado (maybeEmitPicks) pra sair DE MANHÃ, com o ranking já real.
  let entry;
  if (unchanged) {
    console.log(`Sem mudança desde o snapshot #${last.seq} (content_hash igual) — não recria o lacre.`);
    entry = last;
  } else {
    const prevChain = last ? last.chain_hash : GENESIS;
    const chainHash = sha256(prevChain + contentHash);
    const seq = (last ? last.seq : 0) + 1;
    const fname = `${String(seq).padStart(4, '0')}_${now.toISOString().replace(/[:.]/g, '-')}.json`;

    if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });
    writeFileSync(join(SNAP_DIR, fname), body);

    entry = {
      seq,
      file: `snapshots/${fname}`,
      taken_at: now.toISOString(),
      content_hash: contentHash,
      prev_chain_hash: prevChain,
      chain_hash: chainHash,
      counts: {
        locked_matches: lockedIds.length,
        predictions: preds.length,
        champion_picks: champions.length,
        scorer_picks: scorers.length,
      },
    };
    manifest.entries.push(entry);
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

    // Relatório legível do lacre (para não técnicos) — derivado do snapshot,
    // commitado junto pela Action. "Novo neste lacre" = diff com o anterior.
    let prevContent = null;
    if (last) {
      try {
        prevContent = JSON.parse(readFileSync(join(INTEGRITY_DIR, last.file), 'utf8'));
      } catch { /* snapshot anterior ilegível — relatório trata tudo como novo */ }
    }
    const reportFname = `${String(seq).padStart(4, '0')}_${brtDateStamp(now)}.md`;
    if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(join(REPORT_DIR, reportFname), buildReport({
      entry, content, matches, prevContent, csDeadline,
      predictionDeadline, repoUrl: REPO_URL, branch: BRANCH,
    }));

    console.log(`✅ Snapshot #${seq}: ${preds.length} palpites de ${lockedIds.length} jogos travados.`);
    console.log(`   content_hash: ${contentHash}`);
    console.log(`   chain_hash:   ${chainHash}`);
    console.log(`   relatório:    integrity/reports/${reportFname}`);

    // Link sempre puro e visível (feedback 2026-06-12).
    await postTelegram(
      `🔒 <b>Snapshot de integridade #${seq}</b>\n` +
      `${lockedIds.length} jogos travados · ${preds.length} palpites\n` +
      `<code>chain ${chainHash}</code>\n` +
      `📄 Relatório do lacre (o que travou e como conferir):\n` +
      `${REPO_URL}/blob/${BRANCH}/integrity/reports/${reportFname}`
    );
  }

  // Alerta de palpites recém-lacrados — DESACOPLADO do lock (ver maybeEmitPicks).
  // Roda em toda invocação (mesmo no dedup) e só dispara de manhã, com ranking real.
  await maybeEmitPicks({ now, content, matches, manifest, entry });
}

main().catch((e) => { console.error(e); process.exit(1); });

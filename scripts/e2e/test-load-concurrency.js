#!/usr/bin/env node
/**
 * test-load-concurrency.js — Estouro de deadline em ESCALA (o risco real da Copa).
 * ============================================================================
 * Simula ~N usuários reais (cliente ANON, caminho RLS de verdade) batendo no
 * mesmo jogo ao MESMO tempo, como acontece minutos antes do prazo. Valida:
 *
 *   FASE 1 — Estouro de INSERT: N upserts concorrentes no mesmo jogo ABERTO.
 *            → cada usuário grava o SEU palpite; sem corrupção; sem linha órfã.
 *   FASE 2 — Estouro de UPDATE: N updates concorrentes.
 *            → consistência total (cada um lê de volta o próprio valor).
 *   FASE 3 — Trava sob concorrência: jogo vira "passado", N tentam editar.
 *            → TODOS rejeitados pela RLS; nenhum valor muda (anti-burla).
 *
 * Mede taxa de sucesso + latência (p50/p95). Self-contained: faz snapshot/restore
 * do jogo-alvo e não deixa resíduo. Guard-rail: aborta se a URL não for local.
 *
 * USO: source .env.e2e.local && node scripts/e2e/test-load-concurrency.js [--users=50] [--match=20]
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { makeAdminClient, assertLocalTarget } from './lib/admin-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
assertLocalTarget(process.env.SUPABASE_URL);

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]; }));
const URL = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_PUBLISHABLE_KEY;
const PASSWORD = 'SimUser2026!';
const TARGET_MATCH = parseInt(args.match || '20', 10);   // um jogo de grupo qualquer
const C = { r: '\x1b[31m', g: '\x1b[32m', b: '\x1b[34m', y: '\x1b[33m', x: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c]}${m}${C.x}`);
let ok = true;
const check = (n, p, d = '') => { if (!p) ok = false; log(p ? 'g' : 'r', `   ${p ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };
const pctile = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };

const admin = makeAdminClient();

// Carrega os sim-users (emails) do roster gerado pelo seed-scale
let roster;
try { roster = JSON.parse(readFileSync(join(__dirname, 'sim-roster.json'), 'utf8')).users; }
catch { log('r', '✗ sim-roster.json ausente — rode scripts/e2e/seed-scale.js primeiro'); process.exit(1); }
const N = parseInt(args.users || String(Math.min(50, roster.length)), 10);
const users = roster.slice(0, N);

log('b', `${C.bold}🌩️  Estouro de deadline — ${N} usuários concorrentes no jogo #${TARGET_MATCH}${C.x}`);

// snapshot do jogo-alvo
const { data: snap } = await admin.from('matches').select('match_date, finished, actual_home, actual_away, pen_winner, finished_at, status').eq('id', TARGET_MATCH).single();
if (!snap) { log('r', `✗ jogo #${TARGET_MATCH} não existe`); process.exit(1); }

// login paralelo (também exercita o auth sob carga)
log('b', `\n🔐 Login de ${N} usuários (paralelo)...`);
const t0 = Date.now();
const clients = await Promise.all(users.map(async (u) => {
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: u.email, password: PASSWORD });
  return error ? null : { c, u };
}));
const live = clients.filter(Boolean);
check(`login concorrente: ${live.length}/${N} autenticados`, live.length === N, `${((Date.now() - t0) / 1000).toFixed(1)}s`);

try {
  // abre o jogo bem no futuro (prazo aberto) e zera resultado
  await admin.from('matches').update({ match_date: new Date(Date.now() + 30 * 864e5).toISOString(), finished: false, actual_home: null, actual_away: null, pen_winner: null, finished_at: null, status: 'scheduled' }).eq('id', TARGET_MATCH);
  // clean-slate: remove palpites pré-existentes do jogo-alvo (service role).
  // Sem isso, num estado JÁ pontuado, a RLS bloqueia (WITH CHECK exige
  // points_earned IS NULL — anti-burla: palpite pontuado é imutável). Garante
  // que a FASE 1 teste INSERT de verdade, independente do estado do ambiente.
  await admin.from('predictions').delete().eq('match_id', TARGET_MATCH).in('user_id', users.map((u) => u.user_id));

  // ===== FASE 1 — estouro de INSERT/upsert concorrente =====
  log('b', '\n[1] Estouro de INSERT concorrente (mesmo jogo, prazo aberto)');
  const lat1 = [];
  const r1 = await Promise.all(live.map(async ({ c }, i) => {
    const s = Date.now();
    const { error } = await c.from('predictions').upsert({ match_id: TARGET_MATCH, pred_home: i % 5, pred_away: (i + 1) % 4, user_id: users[i].user_id }, { onConflict: 'user_id,match_id' });
    lat1.push(Date.now() - s);
    return !error;
  }));
  const okIns = r1.filter(Boolean).length;
  check(`${okIns}/${N} upserts aceitos sob concorrência`, okIns === N);
  log('dim', `       latência: p50=${pctile(lat1, .5)}ms p95=${pctile(lat1, .95)}ms`);
  // integridade: exatamente N linhas, uma por usuário, valor correto
  const { data: rows1 } = await admin.from('predictions').select('user_id, pred_home, pred_away').eq('match_id', TARGET_MATCH).in('user_id', users.map((u) => u.user_id));
  check('1 linha por usuário (UNIQUE intacto, sem duplicata/órfã)', rows1.length === N, `linhas=${rows1.length}`);
  const wrong1 = rows1.filter((row) => { const i = users.findIndex((u) => u.user_id === row.user_id); return row.pred_home !== i % 5 || row.pred_away !== (i + 1) % 4; });
  check('cada palpite gravado é o do próprio usuário (sem cross-write)', wrong1.length === 0, `divergências=${wrong1.length}`);

  // ===== FASE 2 — estouro de UPDATE concorrente =====
  log('b', '\n[2] Estouro de UPDATE concorrente');
  const lat2 = [];
  const r2 = await Promise.all(live.map(async ({ c }, i) => {
    const s = Date.now();
    const { error } = await c.from('predictions').update({ pred_home: 3, pred_away: i % 3 }).eq('user_id', users[i].user_id).eq('match_id', TARGET_MATCH);
    lat2.push(Date.now() - s);
    return !error;
  }));
  check(`${r2.filter(Boolean).length}/${N} updates aceitos`, r2.filter(Boolean).length === N);
  log('dim', `       latência: p50=${pctile(lat2, .5)}ms p95=${pctile(lat2, .95)}ms`);
  const { data: rows2 } = await admin.from('predictions').select('user_id, pred_home, pred_away').eq('match_id', TARGET_MATCH).in('user_id', users.map((u) => u.user_id));
  const wrong2 = rows2.filter((row) => { const i = users.findIndex((u) => u.user_id === row.user_id); return row.pred_home !== 3 || row.pred_away !== i % 3; });
  check('todos os updates consistentes (read-after-write)', wrong2.length === 0, `divergências=${wrong2.length}`);

  // ===== FASE 3 — trava por deadline sob concorrência =====
  log('b', '\n[3] Trava de deadline sob concorrência (jogo vira passado)');
  await admin.from('matches').update({ match_date: new Date(Date.now() - 864e5).toISOString() }).eq('id', TARGET_MATCH); // ontem → travado
  const before = new Map(rows2.map((r) => [r.user_id, `${r.pred_home}-${r.pred_away}`]));
  const r3 = await Promise.all(live.map(async ({ c }, i) =>
    c.from('predictions').update({ pred_home: 9, pred_away: 9 }).eq('user_id', users[i].user_id).eq('match_id', TARGET_MATCH).select()));
  const mutated = r3.filter((res) => (res.data?.length ?? 0) > 0).length;
  check('NENHUM update passa após o prazo (RLS trava sob carga)', mutated === 0, `passaram=${mutated}`);
  const { data: rows3 } = await admin.from('predictions').select('user_id, pred_home, pred_away').eq('match_id', TARGET_MATCH).in('user_id', users.map((u) => u.user_id));
  const tampered = rows3.filter((r) => before.get(r.user_id) !== `${r.pred_home}-${r.pred_away}`).length;
  check('valores preservados (ninguém burlou o 9-9 pós-prazo)', tampered === 0, `alterados=${tampered}`);
} finally {
  // restore: limpa os palpites de teste do jogo e devolve o snapshot
  await admin.from('predictions').delete().eq('match_id', TARGET_MATCH).in('user_id', users.map((u) => u.user_id));
  await admin.from('matches').update(snap).eq('id', TARGET_MATCH);
  try { await admin.rpc('recompute_prediction_points', { p_match_id: TARGET_MATCH }); } catch {}
  await Promise.all(live.map(({ c }) => c.auth.signOut().catch(() => {})));
  log('dim', '   ↩ jogo restaurado + palpites de teste removidos + logout');
}

log(ok ? 'g' : 'r', `\n${C.bold}${ok ? '🎉 CONCORRÊNCIA OK — escala de deadline aguenta' : '⚠ revisar concorrência'}${C.x}`);
process.exit(ok ? 0 : 1);

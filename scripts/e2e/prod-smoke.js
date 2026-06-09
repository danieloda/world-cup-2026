#!/usr/bin/env node
/**
 * prod-smoke.js — Gate read-only contra PRODUÇÃO (NÃO escreve NADA).
 * ============================================================================
 * Confirma, sem mutar produção, que: o site está no ar, o schema reflete o repo
 * (artefatos das migrations recentes presentes), e os números batem com o
 * esperado. SÓ faz SELECT/count (GET) + HEAD. Nenhum insert/update/delete/rpc-mutante.
 *
 * USO: node scripts/e2e/prod-smoke.js        (lê credenciais de PROD do .env)
 *
 * SEGURANÇA: usa a SERVICE_ROLE de prod só p/ LER (count/select). Guard-rail
 * inverso: aborta se a URL parecer LOCAL (este script é p/ prod, de propósito).
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const URL = process.env.SUPABASE_URL;
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE = 'https://superbolaocopa.netlify.app';
const C = { r: '\x1b[31m', g: '\x1b[32m', b: '\x1b[34m', y: '\x1b[33m', x: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m' };
const log = (c, m) => console.log(`${C[c]}${m}${C.x}`);
let ok = true;
const check = (n, p, d = '') => { if (!p) ok = false; log(p ? 'g' : 'r', `   ${p ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

if (/127\.0\.0\.1|localhost/.test(URL || '')) { log('r', '✗ SUPABASE_URL é local — este smoke é p/ PRODUÇÃO (lê .env).'); process.exit(2); }
log('b', `${C.bold}🔭 Prod smoke (READ-ONLY) — ${URL}${C.x}`);

// READ-ONLY: cliente sem persistência; só usamos .select(count/head).
const db = createClient(URL, SR, { auth: { persistSession: false, autoRefreshToken: false } });
const count = async (t) => { const { count, error } = await db.from(t).select('*', { count: 'exact', head: true }); return error ? { err: error.message } : { n: count }; };

// 1. Site no ar
log('b', '\n[1] Site (Netlify)');
try {
  const res = await fetch(`${SITE}/login.html`, { method: 'GET' });
  check('login.html responde 200', res.status === 200, `HTTP ${res.status}`);
  const html = await res.text();
  check('HTML do app servido (sem erro de host)', /SBC|Bol[aã]o|login/i.test(html), `${html.length} bytes`);
} catch (e) { check('site alcançável', false, e.message); }

// 2. Paridade de schema (artefatos das migrations mais recentes, via REST)
log('b', '\n[2] Paridade de schema prod↔repo (artefatos das migrations)');
const probes = [
  ['client_errors (migration 047)', 'client_errors'],
  ['match_predictions (032)', 'match_predictions'],
  ['match_h2h (027)', 'match_h2h'],
  ['team_h2h (030)', 'team_h2h'],
  ['match_odds (020)', 'match_odds'],
  ['user_qualifier_points (021)', 'user_qualifier_points'],
  ['prediction_audit (035)', 'prediction_audit'],
];
for (const [label, table] of probes) {
  const r = await count(table);
  check(label + ' existe', !r.err, r.err ? r.err.slice(0, 50) : `${r.n} linhas`);
}
// status column (039) + views
const st = await db.from('matches').select('status', { head: true });
check('matches.status existe (migration 039)', !st.error, st.error?.message?.slice(0, 50));
const lb = await db.from('v_leaderboard').select('*', { count: 'exact', head: true });
check('v_leaderboard consultável', !lb.error, lb.error ? lb.error.message.slice(0, 40) : `${lb.count} pagantes`);

// 3. Números esperados
log('b', '\n[3] Dados de produção (sanidade)');
const m = await count('matches'); check('matches = 104', m.n === 104, `n=${m.n}`);
// 1249 = 052 (1247) + overrides manuais de 2026-06-09 (Portugal com 27, 4º GOL
// Ricardo Velho). Sentinela de drift: mudou o elenco de propósito? Atualize aqui.
const p = await count('players'); check('players = 1249 (052 + overrides 2026-06-09)', p.n === 1249, `n=${p.n}`);
{ // Sem jogador duplicado em NENHUMA listagem: api_player_id é único e nenhum
  // país passa de 27 (26 da FIFA + 1 adição manual documentada).
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('players').select('id, team, api_player_id').order('id').range(from, from + 999);
    if (error) { check('players legíveis p/ checagem de duplicata', false, error.message); break; }
    all.push(...data);
    if (data.length < 1000) break;
  }
  const apiIds = all.map(x => x.api_player_id).filter(x => x != null);
  check('players sem api_player_id duplicado', new Set(apiIds).size === apiIds.length,
    `${apiIds.length - new Set(apiIds).size} duplicado(s)`);
  const byTeam = new Map();
  for (const x of all) byTeam.set(x.team, (byTeam.get(x.team) ?? 0) + 1);
  const weird = [...byTeam.entries()].filter(([, n]) => n < 26 || n > 27);
  check('todo elenco com 26–27 jogadores', weird.length === 0, weird.map(([t, n]) => `${t}=${n}`).join(' ') || 'ok');
}
const pr = await count('profiles'); check('profiles (usuários reais)', (pr.n ?? 0) > 0, `n=${pr.n}`);
const fr = await db.from('team_fifa_rank').select('*', { count: 'exact', head: true }); check('team_fifa_rank = 48', fr.count === 48, `n=${fr.count}`);

// 4. Settings críticas (deadline + pagamento)
log('b', '\n[4] Settings críticas');
const { data: s } = await db.from('settings').select('key, value').in('key', ['deadline_champion_scorer', 'fee_amount', 'pix_key', 'pool_name']);
const byKey = Object.fromEntries((s || []).map((r) => [r.key, r.value]));
check('deadline_champion_scorer setado', !!byKey.deadline_champion_scorer, JSON.stringify(byKey.deadline_champion_scorer));
check('fee_amount setado', byKey.fee_amount != null, JSON.stringify(byKey.fee_amount));
check('pix_key setado (migration 044)', byKey.pix_key !== undefined, byKey.pix_key ? 'presente' : 'ausente');

log(ok ? 'g' : 'r', `\n${C.bold}${ok ? '🎉 PROD OK — site no ar e schema em paridade com o repo' : '⚠ revisar prod'}${C.x}`);
log('dim', '   (nenhuma escrita foi feita em produção)');
process.exit(ok ? 0 : 1);

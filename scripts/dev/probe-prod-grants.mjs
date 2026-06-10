#!/usr/bin/env node
/**
 * probe-prod-grants.mjs — Diagnóstico READ-ONLY de grants/permissões em PROD.
 * ============================================================================
 * Sonda o incidente "permission denied for function X" visto na página de
 * ranking: testa as views e funções de scoring tanto como service_role (visão
 * do monitor) quanto como usuário AUTHENTICATED (visão do navegador), para
 * descobrir exatamente QUAIS grants faltam — e desde quando (client_errors).
 *
 * SÓ LÊ. Nenhuma escrita; login do admin só cria sessão em memória.
 * USO: node scripts/dev/probe-prod-grants.mjs   (credenciais do .env)
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const URL = process.env.SUPABASE_URL;
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY;
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[34m', x: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m' };
const ok = (m) => console.log(`${C.g}  ✓ ${m}${C.x}`);
const bad = (m) => console.log(`${C.r}  ✗ ${m}${C.x}`);
const head = (m) => console.log(`\n${C.b}${C.bold}▶ ${m}${C.x}`);

if (!URL || !SR || !PUB) { console.error('SUPABASE_URL / chaves ausentes no .env.'); process.exit(2); }
if (/127\.0\.0\.1|localhost/.test(URL)) { console.error('URL é local — esta sonda é p/ PROD.'); process.exit(2); }

console.log(`${C.bold}🩺 Probe de grants em PROD — ${URL}${C.x}`);

const sr = createClient(URL, SR, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------------------
// 1) Linha do tempo: client_errors com "permission denied"
// ---------------------------------------------------------------------------
head('client_errors: desde quando o erro aparece em prod?');
{
  const { data, error } = await sr.from('client_errors')
    .select('*')
    .ilike('message', '%permission denied%')
    .order('created_at', { ascending: true });
  if (error) { bad(`client_errors: ${error.message}`); }
  else if (!data.length) { console.log(`${C.dim}   nenhum erro de permission denied registrado${C.x}`); }
  else {
    const byMsg = new Map();
    for (const e of data) {
      const k = e.message.slice(0, 90);
      const v = byMsg.get(k) ?? { n: 0, first: e.created_at, last: e.created_at, pages: new Set() };
      v.n++; v.last = e.created_at; if (e.page) v.pages.add(e.page);
      byMsg.set(k, v);
    }
    for (const [msg, v] of byMsg) {
      bad(`${v.n}× "${msg}"`);
      console.log(`${C.dim}      primeiro: ${v.first} · último: ${v.last} · páginas: ${[...v.pages].join(', ') || '?'}${C.x}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2) Sondas por role
// ---------------------------------------------------------------------------
async function probe(label, client, uid) {
  head(`Sondas como ${label}`);
  const views = ['v_leaderboard', 'v_scorer_ranking', 'v_pool_stats'];
  for (const v of views) {
    const { error } = await client.from(v).select('*').limit(1);
    error ? bad(`select ${v} → ${error.message}`) : ok(`select ${v}`);
  }
  const rpcs = [
    ['stage_multiplier', { stage: 'group' }],
    ['champion_bonus_for', { p_user_id: uid }],
    ['scorer_bonus_for', { p_user_id: uid }],
  ];
  for (const [fn, args] of rpcs) {
    const { data, error } = await client.rpc(fn, args);
    error ? bad(`rpc ${fn} → ${error.message}`) : ok(`rpc ${fn} → ${JSON.stringify(data)}`);
  }
  // leituras que as outras páginas fazem (palpites/início)
  for (const t of ['matches', 'settings', 'profiles', 'champion_picks', 'top_scorer_picks', 'players']) {
    const { error } = await client.from(t).select('*').limit(1);
    error ? bad(`select ${t} → ${error.message}`) : ok(`select ${t}`);
  }
}

// service_role — visão do monitor (prod-verify)
await probe('SERVICE_ROLE (monitor)', sr, '00000000-0000-0000-0000-000000000000');

// authenticated — visão do navegador (mesmo papel do screenshot)
const auth = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } });
const creds = [
  [process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD],
  [process.env.TEST_USER_EMAIL, process.env.TEST_USER_PASSWORD],
];
let session = null;
for (const [email, password] of creds) {
  if (!email || !password) continue;
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  if (!error) { session = data; console.log(`${C.dim}   login ok: ${email}${C.x}`); break; }
  console.log(`${C.dim}   login falhou (${email}): ${error.message}${C.x}`);
}
if (session) {
  await probe('AUTHENTICATED (navegador)', auth, session.user.id);
  await auth.auth.signOut({ scope: 'local' });
} else {
  console.log(`${C.y}   sem sessão authenticated — sondas de navegador puladas${C.x}`);
}

console.log(`\n${C.dim}(nenhuma escrita foi feita em produção)${C.x}`);

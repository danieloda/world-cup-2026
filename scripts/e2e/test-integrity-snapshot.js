#!/usr/bin/env node
/**
 * test-integrity-snapshot.js — Prova VIVA do invariante "ao travar, carimba":
 * roda os scripts REAIS (snapshot.js + verify.js) num sandbox temporário contra
 * o Supabase LOCAL e verifica, sem reimplementar a lógica:
 *
 *   1. COMPLETUDE   — locked_match_ids == jogos com deadline vencido segundo a
 *                     OUTRA cópia da fórmula (src/js/util.js — paridade entre
 *                     implementações), e os palpites desses jogos estão TODOS lá.
 *   2. FORMATO      — snapshot é JSON canônico (chaves ordenadas, bytes estáveis).
 *   3. IDEMPOTÊNCIA — rodar de novo sem mudança no banco não duplica nem corrompe.
 *   4. ADULTERAÇÃO  — verify.js DETECTA: byte trocado no snapshot, hash mexido
 *                     no manifest, elo removido da cadeia (sandbox com a cadeia
 *                     REAL do repo). E a cadeia real, intocada, passa.
 *
 * SÓ LÊ o banco (o snapshot é read-only) e SÓ escreve em diretórios tmp —
 * nunca em integrity/ do repo.
 *
 * Uso: set -a; source .env.e2e.local; set +a; node scripts/e2e/test-integrity-snapshot.js
 */
import { execFileSync } from 'child_process';
import {
  mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync,
  symlinkSync, rmSync, readdirSync, cpSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeAdminClient } from './lib/admin-client.js';
import { predictionDeadline } from '../../src/js/util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[34m', x: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m' };
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`${C.g}  ✓ ${m}${C.x}`); };
const bad = (m) => { fail++; console.log(`${C.r}  ✗ ${m}${C.x}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const head = (m) => console.log(`\n${C.b}${C.bold}▶ ${m}${C.x}`);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes. Rode: set -a; source .env.e2e.local; set +a');
  process.exit(1);
}
const admin = makeAdminClient();  // já aborta se a URL não for local

// Ambiente dos subprocessos: credenciais LOCAIS explícitas, sem Telegram
// (best-effort do snapshot nunca deve postar a partir de um teste).
const childEnv = {
  ...process.env,
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  TELEGRAM_TOKEN: '', TELEGRAM_CHAT_ID: '',
};

// Sandbox com a MESMA topologia do repo (os scripts resolvem ../../ a partir
// de si): tmp/scripts/integrity/*.js → tmp/integrity + tmp/.env + node_modules.
function makeSandbox(withRepoChain = false) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-integrity-'));
  mkdirSync(join(dir, 'scripts', 'integrity'), { recursive: true });
  for (const f of ['snapshot.js', 'report.js', 'verify.js']) {
    copyFileSync(join(ROOT, 'scripts', 'integrity', f), join(dir, 'scripts', 'integrity', f));
  }
  // report.js traduz seleções com o teamPt do app — espelha src/js/ no sandbox.
  mkdirSync(join(dir, 'src', 'js'), { recursive: true });
  for (const f of ['util.js', 'fifa-rank.js']) {
    copyFileSync(join(ROOT, 'src', 'js', f), join(dir, 'src', 'js', f));
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, '.env'), `SUPABASE_URL=${SUPABASE_URL}\nSUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}\n`);
  if (withRepoChain) cpSync(join(ROOT, 'integrity'), join(dir, 'integrity'), { recursive: true });
  return dir;
}

function run(script, dir) {
  try {
    const out = execFileSync('node', [join(dir, 'scripts', 'integrity', script)], {
      env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// Canonicalização ESPERADA do formato (espelho da spec, p/ checar bytes).
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}

const sandbox = makeSandbox();
const chainBox = makeSandbox(true);
process.on('exit', () => { rmSync(sandbox, { recursive: true, force: true }); rmSync(chainBox, { recursive: true, force: true }); });

// ============================================================
head('1. Snapshot inicial no sandbox (scripts reais, banco local)');
// ============================================================
const r1 = run('snapshot.js', sandbox);
check(r1.code === 0, `snapshot.js sai com 0 (got ${r1.code})${r1.code ? ` — ${r1.out.slice(0, 200)}` : ''}`);

const manifestPath = join(sandbox, 'integrity', 'manifest.json');
const manifest1 = JSON.parse(readFileSync(manifestPath, 'utf8'));
check(manifest1.entries.length === 1, `manifest com 1 entrada (got ${manifest1.entries.length})`);

const entry = manifest1.entries[0];
const snapBody = readFileSync(join(sandbox, 'integrity', entry.file), 'utf8');
const snap = JSON.parse(snapBody);

// Relatório legível: 1 por lacre, citando o lacre que ele documenta.
const reportDir = join(sandbox, 'integrity', 'reports');
const reports1 = readdirSync(reportDir);
check(reports1.length === 1 && /^0001_\d{4}-\d{2}-\d{2}\.md$/.test(reports1[0]),
  `relatório legível do lacre gerado (${reports1[0] ?? 'nenhum'})`);
const reportBody = readFileSync(join(reportDir, reports1[0]), 'utf8');
check(
  reportBody.includes(entry.chain_hash) && reportBody.includes(entry.content_hash) && reportBody.includes(entry.file),
  'relatório cita chain_hash, content_hash e o arquivo lacrado',
);

// ============================================================
head('2. Completude — comparação com o banco via a OUTRA fórmula de prazo');
// ============================================================
const now = new Date();
const { data: matches, error: me } = await admin.from('matches').select('id, match_date, finished').order('id');
if (me) { bad(`query matches: ${me.message}`); process.exit(1); }

const expectedLocked = matches.filter((m) => predictionDeadline(m.match_date) <= now).map((m) => m.id).sort((a, b) => a - b);
const gotLocked = [...snap.locked_match_ids].sort((a, b) => a - b);
check(
  JSON.stringify(gotLocked) === JSON.stringify(expectedLocked),
  `locked_match_ids == jogos travados segundo src/js/util.js (${expectedLocked.length} jogos)`,
);

let expectedPreds = 0;
if (expectedLocked.length) {
  const { count, error } = await admin.from('predictions')
    .select('id', { count: 'exact', head: true }).in('match_id', expectedLocked);
  if (error) { bad(`count predictions: ${error.message}`); process.exit(1); }
  expectedPreds = count ?? 0;
}
check(snap.predictions.length === expectedPreds,
  `TODOS os palpites dos jogos travados estão no snapshot (${snap.predictions.length}/${expectedPreds})`);

const predFields = ['user_id', 'match_id', 'pred_home', 'pred_away', 'pred_pen_winner', 'updated_at'];
check(
  snap.predictions.every((p) => predFields.every((f) => f in p)),
  'cada palpite carimbado tem os 6 campos (placar + pênalti + updated_at)',
);

// Nomes lacrados junto (relatório nomeia participantes) — e e-mail NUNCA vaza.
const refUserIds = new Set(
  [...snap.predictions, ...snap.champion_picks, ...snap.scorer_picks].map((r) => r.user_id),
);
check(
  [...refUserIds].every((id) => (snap.users ?? []).some((u) => u.user_id === id && u.name)),
  `todo user_id lacrado tem nome de usuário lacrado junto (${refUserIds.size} usuários)`,
);
check(!/[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/.test(snapBody), 'nenhum e-mail vaza no snapshot');

const { count: finCount } = await admin.from('matches').select('id', { count: 'exact', head: true }).eq('finished', true);
check(snap.results.length === (finCount ?? 0), `resultados conhecidos completos (${snap.results.length}/${finCount ?? 0})`);

const { data: csRow } = await admin.from('settings').select('value').eq('key', 'deadline_champion_scorer').maybeSingle();
const csDeadline = csRow?.value ? new Date(String(csRow.value).replace(/^"|"$/g, '')) : null;
const csPassed = csDeadline && !isNaN(csDeadline) && now >= csDeadline;
if (csPassed) {
  const { count: cc } = await admin.from('champion_picks').select('user_id', { count: 'exact', head: true });
  check(snap.champion_picks.length === (cc ?? 0), `picks de campeão carimbados (deadline passou): ${snap.champion_picks.length}`);
} else {
  check(snap.champion_picks.length === 0 && snap.scorer_picks.length === 0,
    'campeão/artilheiro NÃO carimbados antes do deadline deles');
}

// ============================================================
head('3. Formato canônico — bytes determinísticos');
// ============================================================
check(snapBody === JSON.stringify(canon(snap), null, 2) + '\n',
  'arquivo == própria forma canônica (chaves ordenadas, \\n final)');
check(entry.counts.predictions === snap.predictions.length
  && entry.counts.locked_matches === snap.locked_match_ids.length,
  'counts do manifest batem com o conteúdo');

// ============================================================
head('4. Idempotência — rodar de novo sem mudança no banco');
// ============================================================
const r2 = run('snapshot.js', sandbox);
check(r2.code === 0 && /Sem mudança/.test(r2.out), 'segunda execução: "Sem mudança", exit 0');
const manifest2 = JSON.parse(readFileSync(manifestPath, 'utf8'));
check(manifest2.entries.length === 1, 'não criou snapshot duplicado');
check(readFileSync(join(sandbox, 'integrity', entry.file), 'utf8') === snapBody, 'snapshot original intacto byte a byte');
check(readdirSync(reportDir).length === 1, 'não criou relatório duplicado (relatório só em lacre novo)');

const v1 = run('verify.js', sandbox);
check(v1.code === 0, 'verify.js aprova a cadeia do sandbox');

// ============================================================
head('5. Adulteração detectada (cadeia REAL do repo, em cópia)');
// ============================================================
const vReal = run('verify.js', chainBox);
const nEntries = JSON.parse(readFileSync(join(chainBox, 'integrity', 'manifest.json'), 'utf8')).entries.length;
check(vReal.code === 0, `cadeia real do repo íntegra (${nEntries} snapshots)`);

if (nEntries >= 2) {
  const chainManifestPath = join(chainBox, 'integrity', 'manifest.json');
  const pristineManifest = readFileSync(chainManifestPath, 'utf8');
  const cm = JSON.parse(pristineManifest);
  const target = cm.entries[1];                       // elo do meio
  const targetPath = join(chainBox, 'integrity', target.file);
  const pristineSnap = readFileSync(targetPath, 'utf8');

  // a) byte trocado dentro de um snapshot já carimbado
  writeFileSync(targetPath, pristineSnap.replace('"taken_at"', '"taken_aT"'));
  const vTamper = run('verify.js', chainBox);
  check(vTamper.code === 1 && /content_hash NÃO bate/.test(vTamper.out),
    `editar um snapshot quebra a verificação apontando o elo (#${target.seq})`);
  writeFileSync(targetPath, pristineSnap);

  // b) reescrever o hash no manifest (cobrir o rastro) também não cola
  const cm2 = JSON.parse(pristineManifest);
  cm2.entries[1].content_hash = '0'.repeat(64);
  writeFileSync(chainManifestPath, JSON.stringify(cm2, null, 2) + '\n');
  const vHash = run('verify.js', chainBox);
  check(vHash.code === 1, 'reescrever content_hash no manifest é detectado');

  // c) remover um elo do meio rompe a corrente
  const cm3 = JSON.parse(pristineManifest);
  cm3.entries.splice(1, 1);
  writeFileSync(chainManifestPath, JSON.stringify(cm3, null, 2) + '\n');
  const vGap = run('verify.js', chainBox);
  check(vGap.code === 1, 'remover um snapshot do meio rompe a cadeia');
  writeFileSync(chainManifestPath, pristineManifest);
} else {
  console.log(`${C.dim}  (cadeia do repo com ${nEntries} elo(s) — testes de elo do meio pulados)${C.x}`);
}

// ============================================================
console.log(`\n${C.bold}${fail === 0 ? C.g + '🎉' : C.r + '💥'} ${pass} pass · ${fail} fail${C.x}`);
process.exit(fail === 0 ? 0 : 1);

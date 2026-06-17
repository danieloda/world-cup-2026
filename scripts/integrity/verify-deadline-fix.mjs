#!/usr/bin/env node
/**
 * Prova (READ-ONLY) do fix da migration 066 — falso positivo "gravado após o prazo".
 *
 * Para cada palpite JÁ PONTUADO (points_earned not null), recupera o instante
 * REAL da última edição do palpite a partir da trilha prediction_audit (último
 * evento em que pred_home/pred_away/pred_pen_winner mudou de fato; fallback
 * created_at) e compara com o prazo do jogo. Mostra:
 *   - quantos a auditoria do lacre marca como "late" HOJE (updated_at > prazo);
 *   - quantos sobrariam DEPOIS do backfill (esperado: 0);
 *   - cobertura da trilha (quantos têm histórico de conteúdo);
 *   - amostra (jogo, updated_at atual vs. instante real recuperado).
 *
 * Não escreve NADA. Usage: node scripts/integrity/verify-deadline-fix.mjs
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (.env aponta pra prod).
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// IGUAL a scripts/integrity/snapshot.js / src/js/util.js / migrations 023+063.
const BRT_OFFSET_MS = 3 * 3600000;
function predictionDeadline(matchDate) {
  const brt = new Date(new Date(matchDate).getTime() - BRT_OFFSET_MS);
  const daysBack = brt.getUTCHours() === 0 ? 2 : 1;
  const wall = Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate() - daysBack, 23, 59, 0);
  return new Date(wall + BRT_OFFSET_MS);
}

async function fetchAll(makeQuery, pageSize = 1000) {
  const all = [];
  for (let page = 0; ; page++) {
    const from = page * pageSize;
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (data?.length) all.push(...data);
    if (!data || data.length < pageSize) break;
  }
  return all;
}

const fmt = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
const predChanged = (a) =>
  a.op === 'INSERT' ||
  (a.new_data?.pred_home ?? null) !== (a.old_data?.pred_home ?? null) ||
  (a.new_data?.pred_away ?? null) !== (a.old_data?.pred_away ?? null) ||
  (a.new_data?.pred_pen_winner ?? null) !== (a.old_data?.pred_pen_winner ?? null);

async function main() {
  const matches = await fetchAll(() =>
    admin.from('matches').select('id, match_date, finished').order('id'));
  const deadlineById = new Map(matches.map((m) => [m.id, predictionDeadline(m.match_date)]));

  const preds = await fetchAll(() =>
    admin.from('predictions')
      .select('id, user_id, match_id, updated_at, created_at, points_earned').order('id'));
  const scored = preds.filter((p) => p.points_earned != null);

  const audit = await fetchAll(() =>
    admin.from('prediction_audit')
      .select('row_user_id, match_id, op, at, old_data, new_data')
      .eq('table_name', 'predictions').order('at'));

  // último instante de EDIÇÃO DE CONTEÚDO por (user, match)
  const lastEdit = new Map();
  for (const a of audit) {
    if (!predChanged(a)) continue;
    const k = `${a.row_user_id}|${a.match_id}`;
    const t = new Date(a.at).getTime();
    if (!lastEdit.has(k) || t > lastEdit.get(k)) lastEdit.set(k, t);
  }

  let lateNow = 0, lateAfter = 0, fromAudit = 0, fromCreated = 0;
  const sample = [];
  for (const p of scored) {
    const dl = deadlineById.get(p.match_id);
    if (new Date(p.updated_at) > dl) lateNow++;
    const k = `${p.user_id}|${p.match_id}`;
    let healed;
    if (lastEdit.has(k)) { healed = new Date(lastEdit.get(k)); fromAudit++; }
    else { healed = new Date(p.created_at); fromCreated++; }
    if (healed > dl) {
      lateAfter++;
      if (sample.length < 10) sample.push({ id: p.id, match: p.match_id, healed: fmt(healed), dl: fmt(dl), bad: true });
    } else if (sample.length < 10 && new Date(p.updated_at) > dl) {
      sample.push({ id: p.id, match: p.match_id, was: fmt(p.updated_at), healed: fmt(healed), dl: fmt(dl) });
    }
  }

  console.log('── Prova do fix 066 (read-only) ───────────────────────────────');
  console.log(`Palpites totais:            ${preds.length}`);
  console.log(`Palpites pontuados:         ${scored.length}`);
  console.log(`Linhas de trilha (preds):   ${audit.length}`);
  console.log('');
  console.log(`HOJE marcados "após o prazo" (updated_at > prazo):  ${lateNow}`);
  console.log(`DEPOIS do backfill (instante real > prazo):         ${lateAfter}  ${lateAfter === 0 ? '✅' : '❌ INVESTIGAR'}`);
  console.log('');
  console.log(`Instante recuperado da trilha (edição real):  ${fromAudit}`);
  console.log(`Sem trilha → fallback created_at:             ${fromCreated}`);
  console.log('');
  console.log('Amostra (jogo · updated_at atual → instante real recuperado · prazo):');
  for (const s of sample) {
    console.log(`  #${s.id} jogo ${s.match}: ${s.was ?? '(ok)'} → ${s.healed}  | prazo ${s.dl}${s.bad ? '  ❌' : ''}`);
  }
  if (lateAfter > 0) process.exit(2);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });

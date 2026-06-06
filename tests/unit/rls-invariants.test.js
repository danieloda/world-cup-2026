import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GUARD ESTÁTICO de RLS (ponto 3 do hardening) — anti-regressão da fonte-da-verdade.
 *
 * O design de RLS está sólido e já passou por hardening de pentest (034/035/038).
 * Este teste NÃO substitui o teste hostil ao vivo (scripts/e2e/test-rls-hostile.js,
 * 14 cenários user-vs-user contra o Supabase real) — esse é o ÚNICO que prova o
 * estado do banco. Aqui garantimos que ninguém DERRUBE uma proteção crítica numa
 * migration futura sem o npm test gritar. Semântica append-only: vale a ÚLTIMA
 * definição de cada policy/grant entre todas as migrations.
 *
 * ⚠️ Migrations são aplicadas à mão (sem CLI). Este guard cobre o CÓDIGO, não o
 *    banco vivo. Rode `npm run test:rls` contra prod-equivalente antes do launch.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG_DIR = join(REPO, 'supabase', 'migrations');

const migrations = readdirSync(MIG_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .map((f) => ({ num: parseInt(f, 10), text: readFileSync(join(MIG_DIR, f), 'utf8') }))
  .sort((a, b) => a.num - b.num);

/** Corpo da ÚLTIMA `create policy "<name>"` (até o `;`) entre todas as migrations. */
function latestPolicy(name) {
  let found = null;
  for (const m of migrations) {
    const i = m.text.lastIndexOf(`create policy "${name}"`);
    if (i === -1) continue;
    found = m.text.slice(i, m.text.indexOf(';', i));
  }
  if (!found) throw new Error(`policy "${name}" não encontrada`);
  return found;
}

/** Último statement (entre todas as migrations) que casa o regex global+dotall. */
function lastStatement(re) {
  let found = null;
  for (const m of migrations) {
    const ms = m.text.match(re);
    if (ms) found = ms[ms.length - 1];
  }
  return found;
}

describe('invariantes de RLS (anti-regressão das migrations)', () => {
  it('predictions INSERT: dono + antes do prazo + não grava points_earned (C1)', () => {
    const p = latestPolicy('predictions_insert_own_before_deadline');
    expect(p).toMatch(/user_id = auth\.uid\(\)/);
    expect(p).toMatch(/points_earned is null/);
    expect(p).toMatch(/prediction_deadline/);
  });

  it('predictions UPDATE: dono + antes do prazo + não grava points_earned (C1)', () => {
    const p = latestPolicy('predictions_update_own_before_deadline');
    expect(p).toMatch(/user_id = auth\.uid\(\)/);
    expect(p).toMatch(/points_earned is null/);
    expect(p).toMatch(/prediction_deadline/);
  });

  it('predictions SELECT: não vaza palpite alheio antes do apito', () => {
    const p = latestPolicy('predictions_select_own_or_locked');
    expect(p).toMatch(/user_id = auth\.uid\(\)/);
    expect(p).toMatch(/match_date <= now\(\)/);
  });

  it('profiles UPDATE: não dá pra auto-promover a admin/paid', () => {
    const p = latestPolicy('profiles_update_self_safe');
    expect(p).toMatch(/is_admin = \(select is_admin/);
    expect(p).toMatch(/paid = \(select paid/);
  });

  it('profiles INSERT: só o próprio, com is_admin=false e paid=false', () => {
    const p = latestPolicy('profiles_insert_self_safe');
    expect(p).toMatch(/id = auth\.uid\(\)/);
    expect(p).toMatch(/is_admin = false/);
    expect(p).toMatch(/paid = false/);
  });

  it('champion/scorer SELECT: gated por cs_deadline (sem using(true))', () => {
    for (const name of ['champion_select', 'scorer_select']) {
      const p = latestPolicy(name);
      expect(p, name).toMatch(/cs_deadline/);
      expect(p, name).toMatch(/user_id = auth\.uid\(\)/);
    }
  });

  it('champion/scorer INSERT/UPDATE: dono + antes do cs_deadline', () => {
    for (const name of ['champion_upsert_self', 'champion_update_self', 'scorer_upsert_self', 'scorer_update_self']) {
      const p = latestPolicy(name);
      expect(p, name).toMatch(/user_id = auth\.uid\(\)/);
      expect(p, name).toMatch(/now\(\) < public\.cs_deadline\(\)/);
    }
  });

  it('profiles: email trancado por privilégio de coluna (não vaza PII)', () => {
    const revoke = lastStatement(/revoke select on public\.profiles from[^;]*;/gis);
    expect(revoke, 'falta revoke select on profiles').toBeTruthy();
    expect(revoke).toMatch(/authenticated/);
    const grant = lastStatement(/grant select\s*\([^;]*on public\.profiles[^;]*;/gis);
    expect(grant, 'falta grant de coluna em profiles').toBeTruthy();
    expect(grant, 'email NÃO pode estar no grant de coluna').not.toMatch(/\bemail\b/);
  });

  it('client_errors: INSERT só do próprio, SELECT só admin (047)', () => {
    const ins = latestPolicy('client_errors_insert_self');
    expect(ins).toMatch(/user_id = auth\.uid\(\)/);
    const sel = latestPolicy('client_errors_select_admin');
    expect(sel).toMatch(/is_admin\(\)/);
  });

  it('funções SECURITY DEFINER continuam revogadas de authenticated (H1/H2)', () => {
    const fns = [
      'recompute_prediction_points', 'recompute_qualifier_points',
      'compute_predicted_slots', 'qualifier_bonus_for',
    ];
    for (const fn of fns) {
      const last = lastStatement(new RegExp(`(grant|revoke) execute on function public\\.${fn}\\b[^;]*;`, 'gis'));
      expect(last, `sem privilégio definido p/ ${fn}`).toBeTruthy();
      expect(last, `${fn}: última ação deveria ser revoke (está re-grantada!)`).toMatch(/^revoke/i);
      expect(last, fn).toMatch(/authenticated/);
    }
  });
});

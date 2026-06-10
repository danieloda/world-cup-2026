import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchPoints, stageMultiplier, championBonus, qualifierBonus } from '../../src/js/scoring.js';

/**
 * PARIDADE cliente↔servidor da PONTUAÇÃO — o maior risco de "multa".
 *
 * scoring.js (usado nos cards/breakdown que o usuário vê) e as funções SQL
 * (que alimentam v_leaderboard / points_earned, o ranking oficial) são DUAS
 * implementações da mesma regra, mantidas "in sync" só por comentário. Se um
 * peso mudar de um lado e não do outro, o usuário vê X no card e Y no ranking
 * → "me roubaram pontos". É a mesma classe de drift do bracket/datas.
 *
 * Este teste parseia a ÚLTIMA definição SQL de cada função (migrations são
 * append-only: champion/scorer pularam p/ 039, stage_multiplier p/ 058 — a 003
 * tinha sido editada IN-PLACE sem re-aplicar em prod, drift achado 2026-06-09)
 * e exige que os VALORES batam com scoring.js. Qualquer edição unilateral
 * quebra aqui, no `npm test`, antes do usuário.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG_DIR = join(REPO, 'supabase', 'migrations');
const STAGES = ['group', 'r32', 'r16', 'qf', 'sf', 'third', 'final'];

// Migrations ordenadas pelo prefixo numérico (precedência = maior número).
const migrations = readdirSync(MIG_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .map((f) => ({ num: parseInt(f, 10), path: join(MIG_DIR, f) }))
  .sort((a, b) => a.num - b.num);

/** Corpo da ÚLTIMA `create or replace function public.<name>(...)` entre todas as migrations. */
function latestFnBody(name) {
  const needle = `create or replace function public.${name}(`;
  let found = null;
  for (const m of migrations) {
    const text = readFileSync(m.path, 'utf8');
    const idx = text.lastIndexOf(needle);
    if (idx === -1) continue;
    const asIdx = text.indexOf('as $$', idx);
    const bodyStart = asIdx + 'as $$'.length;
    const bodyEnd = text.indexOf('$$', bodyStart);
    found = { body: text.slice(bodyStart, bodyEnd), file: m.path, num: m.num };
  }
  if (!found) throw new Error(`SQL: definição de ${name} não encontrada`);
  return found;
}

const NUM = "(-?\\d+(?:\\.\\d+)?)";

/** Mapa { stage|phase -> número } + else, de um trecho contendo um CASE. */
function parseCase(slice) {
  const map = {};
  const re = new RegExp(`when\\s+'(\\w+)'\\s+then\\s+${NUM}`, 'g');
  let m;
  while ((m = re.exec(slice)) !== null) map[m[1]] = parseFloat(m[2]);
  const em = slice.match(new RegExp(`else\\s+${NUM}`));
  return { map, elseVal: em ? parseFloat(em[1]) : null };
}

const valueFor = ({ map, elseVal }, key) => (key in map ? map[key] : elseVal);

/** Isola `var := case ... end` dentro de um corpo plpgsql. */
function sliceAssign(body, varName) {
  const i = body.indexOf(`${varName} := case`);
  if (i === -1) throw new Error(`atribuição ${varName} := case não encontrada`);
  const j = body.indexOf('end', i);
  return body.slice(i, j);
}

describe('paridade de pontuação: scoring.js ↔ funções SQL', () => {
  it('score_prediction: ag/ave/dg por fase batem (latest = migration)', () => {
    const { body } = latestFnBody('score_prediction');
    const ag = parseCase(sliceAssign(body, 'ag'));
    const ave = parseCase(sliceAssign(body, 'ave'));
    const dg = parseCase(sliceAssign(body, 'dg'));
    const drift = [];
    for (const s of STAGES) {
      const js = matchPoints(s);
      const sql = { ag: valueFor(ag, s), ave: valueFor(ave, s), dg: valueFor(dg, s) };
      for (const k of ['ag', 'ave', 'dg']) {
        if (js[k] !== sql[k]) drift.push(`${s}.${k}: JS=${js[k]} SQL=${sql[k]}`);
      }
    }
    expect(drift, `pesos de jogo divergem cliente↔servidor:\n${drift.join('\n')}`).toEqual([]);
  });

  it('stage_multiplier: multiplicadores do artilheiro batem', () => {
    const { body } = latestFnBody('stage_multiplier');
    const sql = parseCase(body);
    const drift = STAGES
      .filter((s) => stageMultiplier(s) !== valueFor(sql, s))
      .map((s) => `${s}: JS=${stageMultiplier(s)} SQL=${valueFor(sql, s)}`);
    expect(drift, `stage_multiplier diverge:\n${drift.join('\n')}`).toEqual([]);
  });

  it('champion_bonus_for: bônus de campeão bate (latest = 039)', () => {
    const { body } = latestFnBody('champion_bonus_for');
    const thens = [...body.matchAll(new RegExp(`then\\s+${NUM}`, 'g'))].map((m) => parseFloat(m[1]));
    const sqlChampion = Math.max(...thens);
    expect(sqlChampion).toBe(championBonus(true));
    expect(championBonus(false)).toBe(0);
  });

  it('qualifier_bonus_pts: BPE/BP por fase batem', () => {
    const { body } = latestFnBody('qualifier_bonus_pts');
    const bpe = parseCase(body);  // o único CASE do corpo é o de p_phase → bpe
    const drift = [];
    for (const s of STAGES) {
      const base = valueFor(bpe, s);
      const sqlExact = base;
      const sqlBp = s === 'r32' ? 0 : Math.round(base / 2);  // espelha o SQL
      if (qualifierBonus(s, true) !== sqlExact) drift.push(`${s} BPE: JS=${qualifierBonus(s, true)} SQL=${sqlExact}`);
      if (qualifierBonus(s, false) !== sqlBp) drift.push(`${s} BP: JS=${qualifierBonus(s, false)} SQL=${sqlBp}`);
    }
    expect(drift, `bônus de classificado diverge:\n${drift.join('\n')}`).toEqual([]);
  });

  it('scorer_bonus_for: estrutura gols × 2 × stage_multiplier (latest = 039)', () => {
    const { body } = latestFnBody('scorer_bonus_for');
    // JS: scorerBonus = round(goals * 2 * stageMultiplier(stage)). Confere a fórmula no SQL.
    expect(body).toMatch(/goals\s*\*\s*2\s*\*\s*public\.stage_multiplier/);
  });

  it('sentinela: cada função foi achada na migration esperada', () => {
    expect(latestFnBody('score_prediction').num).toBe(56);
    expect(latestFnBody('qualifier_bonus_pts').num).toBe(22);
    expect(latestFnBody('champion_bonus_for').num).toBe(39);
    expect(latestFnBody('scorer_bonus_for').num).toBe(39);
    expect(latestFnBody('stage_multiplier').num).toBe(58);
  });
});

// ============================================================
// Guards do snapshot de integridade + unicidade do modelo de dados.
//
// 1) O snapshot dispara NO MOMENTO CERTO: cron diário às 06:10 UTC (03:10 BRT),
//    depois de TODA trava do dia (23h59 BRT) — e o critério de "jogo travado"
//    dentro do script é a MESMA fórmula de prazo de util.js/migration 023.
// 2) Duplicatas são impossíveis POR CONSTRUÇÃO: as UNIQUE constraints de
//    players / predictions / player_goals existem e nenhuma migration as
//    derrubou (migrations são append-only — guard no estilo rls-invariants).
//
// O comportamento vivo do snapshot (conteúdo, idempotência, adulteração) é
// testado contra o banco local por scripts/e2e/test-integrity-snapshot.js.
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'integrity-snapshot.yml'), 'utf8');
const snapshotSrc = readFileSync(join(ROOT, 'scripts', 'integrity', 'snapshot.js'), 'utf8');
const utilSrc = readFileSync(join(ROOT, 'src', 'js', 'util.js'), 'utf8');
const MIG_DIR = join(ROOT, 'supabase', 'migrations');
const migrations = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()
  .map(f => ({ f, sql: readFileSync(join(MIG_DIR, f), 'utf8') }));

describe('agendamento — snapshot roda DEPOIS da trava do dia', () => {
  it('cron diário às 06:10 UTC', () => {
    const m = workflow.match(/cron:\s*'(\d+) (\d+) (\S+) (\S+) (\S+)'/);
    expect(m).not.toBeNull();
    const [, min, hourUtc, dom, mon, dow] = m;
    expect([dom, mon, dow]).toEqual(['*', '*', '*']);     // todo dia, sem exceção
    // 06:10 UTC − 3h = 03:10 BRT: depois da meia-noite, com folga sobre as
    // travas de 23h59 BRT — nenhum palpite do dia escapa do carimbo seguinte.
    const hourBrt = (Number(hourUtc) - 3 + 24) % 24;
    expect(Number(min)).toBe(10);
    expect(hourBrt).toBeGreaterThanOrEqual(1);
    expect(hourBrt).toBeLessThan(12);
  });

  it('verifica a cadeia no próprio job (snapshot → verify → commit)', () => {
    const iSnap = workflow.indexOf('scripts/integrity/snapshot.js');
    const iVerify = workflow.indexOf('scripts/integrity/verify.js');
    const iCommit = workflow.indexOf('git push');
    expect(iSnap).toBeGreaterThan(-1);
    expect(iVerify).toBeGreaterThan(iSnap);
    expect(iCommit).toBeGreaterThan(iVerify);
  });
});

describe('critério de "travado" do snapshot == fórmula canônica do prazo', () => {
  // O snapshot tem cópia própria de predictionDeadline (não importa de src/ de
  // propósito — script standalone). Trava os marcadores da fórmula nas DUAS
  // cópias: véspera 23h59 + offset BRT fixo. A paridade JS↔SQL da fórmula em
  // si já é coberta por deadline-parity.test.js.
  const FORMULA = /getUTCDate\(\) - 1, 23, 59/;
  const OFFSET = /3 \* 3600000/;
  it('snapshot.js usa véspera 23h59 BRT e filtra por deadline <= agora', () => {
    expect(snapshotSrc).toMatch(FORMULA);
    expect(snapshotSrc).toMatch(OFFSET);
    expect(snapshotSrc).toMatch(/predictionDeadline\(m\.match_date\) <= now/);
  });
  it('util.js (a fonte espelhada) mantém a mesma fórmula', () => {
    expect(utilSrc).toMatch(FORMULA);
    expect(utilSrc).toMatch(OFFSET);
  });
  it('idempotência declarada no código: mesmo conteúdo → nenhum snapshot novo', () => {
    expect(snapshotSrc).toMatch(/last\.content_hash === contentHash/);
  });
});

describe('INV duplicatas — UNIQUE constraints existem e ninguém as derrubou', () => {
  const schema = migrations.find(m => m.f.startsWith('001')).sql;

  it('players: unique(full_name, team) — sem jogador duplicado em listagem nenhuma', () => {
    const block = schema.match(/create table public\.players[\s\S]*?\);/)[0];
    expect(block).toMatch(/unique\s*\(\s*full_name\s*,\s*team\s*\)/);
  });
  it('predictions: unique(user_id, match_id) — 1 palpite por usuário por jogo', () => {
    const block = schema.match(/create table public\.predictions[\s\S]*?\);/)[0];
    expect(block).toMatch(/unique\s*\(\s*user_id\s*,\s*match_id\s*\)/);
  });
  it('player_goals: unique(player_id, match_id) — gols não duplicam no bônus', () => {
    const block = schema.match(/create table public\.player_goals[\s\S]*?\);/)[0];
    expect(block).toMatch(/unique\s*\(\s*player_id\s*,\s*match_id\s*\)/);
  });
  it('nenhuma migration posterior dropa essas constraints', () => {
    for (const { f, sql } of migrations) {
      const drops = sql.match(/drop constraint[^;]*/gi) ?? [];
      for (const d of drops) {
        expect(d, `${f}: ${d}`).not.toMatch(/full_name_team|user_id_match_id|player_id_match_id/);
      }
    }
  });
});

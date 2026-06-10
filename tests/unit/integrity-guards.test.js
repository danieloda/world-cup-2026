// ============================================================
// Guards do snapshot de integridade + unicidade do modelo de dados.
//
// 1) O snapshot dispara NO MOMENTO CERTO: cron diário de madrugada (hoje
//    03:09 UTC = 00:09 BRT), logo depois de TODA trava do dia (23h59 BRT) — e
//    o critério de "jogo travado" no script é a MESMA fórmula de prazo de
//    util.js/migration 023.
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
const reportSrc = readFileSync(join(ROOT, 'scripts', 'integrity', 'report.js'), 'utf8');
const utilSrc = readFileSync(join(ROOT, 'src', 'js', 'util.js'), 'utf8');
const MIG_DIR = join(ROOT, 'supabase', 'migrations');
const migrations = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()
  .map(f => ({ f, sql: readFileSync(join(MIG_DIR, f), 'utf8') }));

describe('agendamento — snapshot roda DEPOIS da trava do dia', () => {
  it('cron diário, logo após a trava de 23h59 BRT e ainda de madrugada', () => {
    const m = workflow.match(/cron:\s*'(\d+) (\d+) (\S+) (\S+) (\S+)'/);
    expect(m).not.toBeNull();
    const [, min, hourUtc, dom, mon, dow] = m;
    expect([dom, mon, dow]).toEqual(['*', '*', '*']);     // todo dia, sem exceção
    // BRT = UTC−3. A trava do dia é 23h59 BRT; o carimbo deve cair no dia
    // seguinte BRT com >=5min de folga (relógio/atraso de cron) e antes do
    // meio-dia — nenhum palpite do dia escapa do carimbo seguinte, e a janela
    // trava→carimbo fica mínima (hoje: 00:09 BRT, 10 min após a trava).
    const minutesBrt = ((Number(hourUtc) - 3 + 24) % 24) * 60 + Number(min);
    expect(minutesBrt).toBeGreaterThanOrEqual(5);
    expect(minutesBrt).toBeLessThan(12 * 60);
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

describe('relatório legível por lacre (integrity/reports/)', () => {
  // O conteúdo do relatório é testado em integrity-report.test.js; aqui ficam
  // as invariantes de FLUXO: só nasce em lacre novo, é commitado pela Action,
  // e continua um derivado puro (sem 3ª cópia da fórmula de prazo).
  it('snapshot.js só gera relatório DEPOIS do dedupe (lacre novo de verdade)', () => {
    const iDedupe = snapshotSrc.indexOf('Sem mudança');
    const iReport = snapshotSrc.indexOf('buildReport(');
    expect(iDedupe).toBeGreaterThan(-1);
    expect(iReport).toBeGreaterThan(iDedupe);
    expect(snapshotSrc).toMatch(/integrity\/reports|REPORT_DIR/);
  });

  it('a Action commita integrity/ inteiro (snapshot + manifest + relatório juntos)', () => {
    expect(workflow).toMatch(/git add integrity\//);
  });

  it('report.js é derivado puro: sem banco/fs/rede e sem 3ª cópia da fórmula de prazo', () => {
    expect(reportSrc).not.toMatch(/supabase|node:fs|from ['"]fs['"]|fetch\(/);
    expect(reportSrc).toMatch(/predictionDeadline/);            // usa a fórmula injetada…
    expect(reportSrc).not.toMatch(/getUTCDate\(\) - 1, 23, 59/); // …sem duplicá-la
  });

  it('o lacre exporta o NOME DE USUÁRIO (full_name) e NUNCA o e-mail', () => {
    expect(snapshotSrc).toMatch(/from\('profiles'\)\.select\('id, full_name'\)/);
    expect(snapshotSrc).not.toMatch(/email/i);  // nem na query, nem em literal nenhum
    expect(reportSrc).not.toMatch(/email/i);
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

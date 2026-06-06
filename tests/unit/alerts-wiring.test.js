import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard do fio "erro de cliente → Telegram" (migration 048 reusando send_alert
 * da 007). Garante que ninguém remova o trigger nem afrouxe o anti-spam sem o
 * npm test gritar. Estático (sem DB).
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG_DIR = join(REPO, 'supabase', 'migrations');
const allSql = readdirSync(MIG_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort()
  .map((f) => readFileSync(join(MIG_DIR, f), 'utf8'))
  .join('\n');

describe('wiring: client_errors → alerta no Telegram', () => {
  it('existe trigger AFTER INSERT em client_errors', () => {
    expect(allSql).toMatch(/create trigger\s+trg_alert_client_error\s+after insert on public\.client_errors/i);
  });

  it('dispara send_alert com category client_error e severity warn', () => {
    const i = allSql.indexOf('create or replace function public.alert_client_error');
    const body = allSql.slice(i, allSql.indexOf('$$;', i));
    expect(body).toMatch(/send_alert/);
    expect(body).toMatch(/'client_error'/);
    expect(body).toMatch(/'warn'/);
  });

  it('tem dedupe anti-spam (janela > 0, só a assinatura no context)', () => {
    const i = allSql.indexOf('create or replace function public.alert_client_error');
    const body = allSql.slice(i, allSql.indexOf('$$;', i));
    // janela de dedupe explícita e generosa (não 0 = sem dedupe)
    expect(body).toMatch(/\b(2[0-9]{4,}|[1-9][0-9]{3,})\b/);  // >= 1000s
    // context do dedupe é só a assinatura (sem campos voláteis que furam o dedupe)
    expect(body).toMatch(/jsonb_build_object\('sig'/);
  });
});

describe('wiring: digest diário de erros do cliente', () => {
  it('existe a função de digest chamando send_alert', () => {
    const i = allSql.indexOf('create or replace function public.cron_alert_client_errors_digest');
    expect(i).toBeGreaterThan(-1);
    const body = allSql.slice(i, allSql.indexOf('$$;', i));
    expect(body).toMatch(/send_alert/);
    expect(body).toMatch(/'client_errors_digest'/);
    expect(body).toMatch(/24 hours/);
  });

  it('está agendado no pg_cron', () => {
    expect(allSql).toMatch(/cron\.schedule\(\s*'alerts_client_errors_digest'/);
  });
});

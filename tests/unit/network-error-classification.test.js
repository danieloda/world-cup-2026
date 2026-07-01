import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard do fio "erro de REDE não pinga o admin" (migration 075 + error-reporter.js).
 * "Failed to fetch" é blip transitório do cliente, não bug: não deve virar alerta
 * em tempo real nem entrar na contagem de bugs do digest. Estático (sem DB), no
 * mesmo estilo de alerts-wiring.test.js. Ver memory failed-to-fetch-transient-noise.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const reporter = readFileSync(join(REPO, 'src', 'js', 'error-reporter.js'), 'utf8');
const MIG_DIR = join(REPO, 'supabase', 'migrations');
const allSql = readdirSync(MIG_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort()
  .map((f) => readFileSync(join(MIG_DIR, f), 'utf8'))
  .join('\n');

describe('front: error-reporter classifica rede', () => {
  it('exporta isNetworkError e cobre as 3 assinaturas de browser', () => {
    expect(reporter).toMatch(/export function isNetworkError/);
    expect(reporter).toMatch(/failed to fetch/i);   // Chrome/Edge
    expect(reporter).toMatch(/load failed/i);        // Safari
    expect(reporter).toMatch(/networkerror/i);       // Firefox
  });

  it('reportFatal grava erro de rede como kind=network (não fatal)', () => {
    expect(reporter).toMatch(/isNetworkError\(err\)\s*\?\s*'network'\s*:\s*'fatal'/);
  });
});

describe('back: migration 075 silencia rede em tempo real, mantém no digest', () => {
  it('define is_client_error_network', () => {
    expect(allSql).toMatch(/create or replace function public\.is_client_error_network/i);
    expect(allSql).toMatch(/failed to fetch/i);
  });

  it('trigger faz early-return p/ rede ANTES do send_alert', () => {
    const i = allSql.lastIndexOf('create or replace function public.alert_client_error');
    const body = allSql.slice(i, allSql.indexOf('$$;', i));
    expect(body).toMatch(/kind = 'network'\s+or\s+public\.is_client_error_network/i);
    const guard = body.search(/is_client_error_network/);
    const ping = body.search(/send_alert/);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(ping);   // o guard vem antes de pingar
  });

  it('digest tira rede da contagem de bugs e mostra em linha separada', () => {
    const i = allSql.lastIndexOf('create or replace function public.cron_alert_client_errors_digest');
    const body = allSql.slice(i, allSql.indexOf('$$;', i));
    expect(body).toMatch(/not \(kind = 'network' or public\.is_client_error_network/i);
    expect(body).toMatch(/erro\(s\) de conexão/i);
  });
});

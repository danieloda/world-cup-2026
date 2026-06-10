import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * FUZZER DE FUSO — caça a classe de bug "DB certo, frontend exibe data/hora
 * errada" (relatado em jun/2026: usuário fora do BRT via datas deslocadas).
 *
 * Por que os testes existentes NÃO pegam isto: vitest.config.js trava
 * TZ=America/Sao_Paulo para todo o suite (e env-guard garante). Ou seja, o teste
 * fixa exatamente a variável que quebra para o usuário fora do Brasil — codifica
 * a mesma suposição falsa do código ("navegador == BRT"). Ver memória
 * tests-mask-prod-reality.
 *
 * Este teste faz o OPOSTO: roda as funções de exibição (formatTime/formatBrDate/
 * formatBrShort/localDateKey) em VÁRIOS fusos, cada um num processo node próprio
 * (TZ aplicada antes de qualquer Date/Intl), e exige:
 *   1) INVARIÂNCIA — a saída é idêntica em todos os fusos (a hora/data do jogo
 *      num bolão brasileiro não pode depender do dispositivo do usuário);
 *   2) ÂNCORA BRT — os valores são de fato o relógio de Brasília, não UTC nem
 *      consistentes-porém-errados.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(HERE, '..', 'fixtures', 'tz-probe.mjs');

// Fusos representativos: o canônico, UTC, oeste (-), e extremos leste (+14/-9).
const TZ_MATRIX = [
  'America/Sao_Paulo',   // canônico (BRT, UTC-3)
  'UTC',
  'America/Los_Angeles', // UTC-7/-8
  'America/Anchorage',   // UTC-9
  'Asia/Tokyo',          // UTC+9
  'Pacific/Kiritimati',  // UTC+14 (extremo)
];

function runProbe(tz) {
  const out = execFileSync(process.execPath, [PROBE], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

const byTz = new Map(TZ_MATRIX.map((tz) => [tz, runProbe(tz)]));
const baseline = byTz.get('America/Sao_Paulo').rows;

describe('exibição de data/hora — invariância ao fuso do viewer (fuzzer)', () => {
  it('o probe cobre um conjunto amplo de instantes', () => {
    expect(baseline.length).toBeGreaterThanOrEqual(60);
  });

  for (const tz of TZ_MATRIX) {
    it(`TZ=${tz}: mesma data/hora exibida que em America/Sao_Paulo`, () => {
      const rows = byTz.get(tz).rows;
      // Compara linha a linha p/ apontar o instante exato que diverge.
      const diffs = [];
      for (let i = 0; i < baseline.length; i++) {
        const b = baseline[i];
        const r = rows[i];
        for (const field of ['time', 'brDate', 'brShort', 'key', 'kickoff', 'dayWin']) {
          if (r[field] !== b[field]) {
            diffs.push(`ms=${b.ms} ${field}: SaoPaulo=${b[field]} vs ${tz}=${r[field]}`);
          }
        }
      }
      expect(diffs, `divergências de fuso:\n${diffs.join('\n')}`).toEqual([]);
    });
  }
});

describe('exibição de data/hora — âncora no relógio de Brasília', () => {
  // EDGE[0..4] do probe (ordem estável): valores BRT esperados.
  const expectAnchor = (i, { time, brShort, key }) => {
    const row = baseline[i];
    expect(row.time).toBe(time);
    expect(row.brShort).toBe(brShort);
    expect(row.key).toBe(key);
  };

  it('20:00 BRT (15/jun) — não 23:00 UTC nem dia seguinte', () => {
    expectAnchor(0, { time: '20:00', brShort: '15/jun', key: '2026-06-15' });
  });
  it('23:30 BRT (20/jun) — fica em 20/jun, não vaza p/ 21', () => {
    expectAnchor(1, { time: '23:30', brShort: '20/jun', key: '2026-06-20' });
  });
  it('00:30 BRT (21/jun) — fica em 21/jun, não recua p/ 20', () => {
    expectAnchor(2, { time: '00:30', brShort: '21/jun', key: '2026-06-21' });
  });
  it('13:00 BRT (25/jun) — tarde', () => {
    expectAnchor(3, { time: '13:00', brShort: '25/jun', key: '2026-06-25' });
  });
  it('22:00 BRT (18/jul) — noite, fim do torneio', () => {
    expectAnchor(4, { time: '22:00', brShort: '18/jul', key: '2026-07-18' });
  });
});

describe('countdown da estreia + janela "hoje" — âncora no calendário de Brasília', () => {
  it('véspera de manhã (10/jun 10:00 BRT) é "amanhã", não "Faltam 2 dias"', () => {
    expect(baseline[5].kickoff).toBe('A Copa começa amanhã!');
  });
  it('véspera 23:59 BRT ainda é "amanhã" (em Tóquio já é 11/jun local)', () => {
    expect(baseline[6].kickoff).toBe('A Copa começa amanhã!');
  });
  it('01/jun 09:00 BRT → faltam 10 dias de calendário', () => {
    expect(baseline[7].kickoff).toBe('Faltam 10 dias');
  });
  it('durante o torneio o rótulo vira o título neutro', () => {
    expect(baseline[0].kickoff).toBe('Copa do Mundo 2026');
  });
  it('janela "hoje" de 15/jun 20:00 BRT = [03:00Z de 15/jun, 02:59Z de 16/jun]', () => {
    expect(baseline[0].dayWin).toBe('2026-06-15T03:00:00.000Z/2026-06-16T02:59:59.999Z');
  });
  it('23:30 BRT de 20/jun segue na janela de 20/jun (não vaza p/ 21)', () => {
    expect(baseline[1].dayWin).toBe('2026-06-20T03:00:00.000Z/2026-06-21T02:59:59.999Z');
  });
});

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GUARD ANTI-DRIFT de fuso: impede que a classe de bug "DB certo, frontend
 * exibe data/hora errada" volte por uma nova cópia.
 *
 * Regra: a EXIBIÇÃO de data/hora vem do SSOT em util.js (brParts/localDateKey/
 * formatTime/formatBrShort/formatBrDate — todos fixam o relógio de Brasília via
 * Intl+timeZone). Nenhum outro módulo pode ler campos via getFullYear/getMonth/
 * getDate/getDay/getHours/getMinutes/getSeconds — esses devolvem o fuso do
 * NAVEGADOR e foi assim que jogos pulavam de dia/hora p/ usuário fora do BRT.
 *
 * util.js é a única fonte legítima (matemática de data civil do calendário).
 * Caso civil genuíno em outro arquivo (ex.: parse de uma chave yyyy-mm-dd já
 * sem instante): use `// tz-ok: <motivo>` na linha para liberar conscientemente.
 *
 * Pareia com o fuzzer date-tz-invariance.test.js (que prova o comportamento);
 * este guard é o gate estático barato que roda a cada `npm test`.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(REPO, 'src', 'js');
const SKIP_DIRS = new Set(['node_modules', '.git']);
const EXEMPT = new Set([join(SRC, 'util.js')]);

const TZ_GETTERS = /\.(getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds)\s*\(\s*\)/;

function collectJs(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) collectJs(full, acc);
    else if (ent.isFile() && ent.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const files = collectJs(SRC);

describe('guard de fuso: exibição de data passa pelo SSOT (util.js)', () => {
  it('encontra um conjunto plausível de módulos (sentinela)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('nenhum módulo (exceto util.js) lê data/hora via getters locais', () => {
    const offenders = [];
    for (const file of files) {
      if (EXEMPT.has(file)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (TZ_GETTERS.test(line) && !/\/\/\s*tz-ok/.test(line)) {
          offenders.push(`${relative(REPO, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `use brParts()/localDateKey()/formatTime() de util.js (relógio de Brasília), ` +
      `não getters locais (fuso do navegador):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

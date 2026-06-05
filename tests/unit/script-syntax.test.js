import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/**
 * `node --check` em todo .js de scripts/ e src/js/.
 *
 * POR QUE EXISTE: nenhum script roda no CI (só os 4 módulos puros tinham
 * teste), então um erro de sintaxe — parêntese solto, await fora de async,
 * merge mal resolvido — passava direto e só explodia quando a action agendada
 * rodava em produção. Isto é o gate estático mais barato: valida a sintaxe de
 * tudo a cada `npm test` (local e CI). Não resolve imports nem executa nada.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = [join(REPO, 'scripts'), join(REPO, 'src', 'js')];
const SKIP_DIRS = new Set(['node_modules', '.git', 'screenshots', '.tmp']);

function collectJs(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; } // diretório ausente (ex.: src/js/config.js só no build) → ignora
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) collectJs(full, acc);
    else if (ent.isFile() && ent.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const files = ROOTS.flatMap((r) => collectJs(r));

describe('sintaxe dos scripts e módulos (node --check)', () => {
  it('encontra um conjunto plausível de arquivos (sentinela)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('todo .js tem sintaxe válida', { timeout: 60_000 }, () => {
    const failures = [];
    for (const file of files) {
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      } catch (e) {
        const msg = (e.stderr?.toString() || e.message || '').split('\n').slice(0, 2).join(' ');
        failures.push(`${relative(REPO, file)}: ${msg.trim()}`);
      }
    }
    expect(failures, `arquivos com sintaxe inválida:\n${failures.join('\n')}`).toEqual([]);
  });
});

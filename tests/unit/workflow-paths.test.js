import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/**
 * Teste estático dos paths de arquivo citados nos GitHub Actions.
 *
 * POR QUE EXISTE: a "segunda metade" do bug do refactor src/ ficou no
 * refresh-recent-matches.yml — os passos `git add assets/data/recent.json` e
 * `git diff -- assets/data/recent.json` continuaram apontando pro path antigo.
 * Mesmo com o script corrigido, o commit nunca veria a mudança (arquivo real
 * em src/assets/data/recent.json) → recent.json de produção congelaria em
 * silêncio. Nenhum teste olhava pros .yml.
 *
 * REGRA: arquivo commitado → tem que existir em disco. Arquivo gerado
 * (gitignored, ex.: src/js/config.js do build:config) → basta o diretório
 * existir, pois ele só nasce durante o run.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_DIR = join(REPO, '.github', 'workflows');

// Tokens tipo caminho-de-arquivo, ancorados nos diretórios de topo do repo.
// O lookbehind evita casar no meio de um token maior (ex.: foo/scripts/x.js).
const PATH_RE = /(?<![\w./-])(?:scripts|src|supabase|tests|integrity|assets|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g;

function workflowFiles() {
  if (!existsSync(WF_DIR)) return [];
  return readdirSync(WF_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => join(WF_DIR, f));
}

/** Set de paths (relativos ao REPO) que o git ignora — i.e., artefatos gerados. */
function gitIgnored(relPaths) {
  if (relPaths.length === 0) return new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: REPO, input: relPaths.join('\n'), encoding: 'utf8',
    });
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch (e) {
    // exit 1 = nenhum ignorado (stdout vazio); qualquer match vem no stdout.
    return new Set((e.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean));
  }
}

// Coleta { file, rel } únicos de todos os workflows.
const refs = [];
for (const wf of workflowFiles()) {
  const content = readFileSync(wf, 'utf8');
  for (const match of content.match(PATH_RE) || []) {
    refs.push({ wf: relative(REPO, wf), rel: match });
  }
}
const uniqueRel = [...new Set(refs.map((r) => r.rel))];
const ignored = gitIgnored(uniqueRel);

describe('paths citados nos workflows (.github/workflows/*.yml)', () => {
  it('acha workflows e referências de path (sentinela anti-regex-quebrado)', () => {
    expect(workflowFiles().length).toBeGreaterThan(0);
    expect(refs.length).toBeGreaterThan(0);
  });

  it('todo arquivo commitado citado existe; gerado → diretório existe', () => {
    const problems = [];
    for (const { wf, rel } of refs) {
      const abs = join(REPO, rel);
      if (ignored.has(rel)) {
        // Artefato gerado durante o run — exige só o diretório.
        const dir = dirname(abs);
        if (!(existsSync(dir) && statSync(dir).isDirectory())) {
          problems.push(`${wf} → ${rel} (gerado, mas falta ${relative(REPO, dir)}/)`);
        }
      } else if (!existsSync(abs)) {
        problems.push(`${wf} → ${rel} (não existe e não é gerado)`);
      }
    }
    expect(problems, `paths inválidos nos workflows:\n${problems.join('\n')}`).toEqual([]);
  });
});

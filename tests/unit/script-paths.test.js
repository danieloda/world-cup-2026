import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Teste estático dos paths construídos com join(__dirname, ...) nos scripts.
 *
 * POR QUE EXISTE: o refactor que moveu o web root pra src/ (a35fafe) quebrou
 * 11 scripts de uma vez — o path join(__dirname,'..','assets',...) virou
 * scripts/assets (inexistente) porque os scripts desceram um nível mas o '..'
 * não foi ajustado. O CI ficou verde porque nenhum script roda no CI. Este
 * teste resolve cada path literalmente e exige que o diretório-pai exista —
 * exatamente a invariante que o bug violou.
 *
 * Limite: só pega joins com argumentos 100% string-literal (estáticos). Joins
 * com variáveis (ex.: join(SNAP_DIR, fname)) são ignorados — não dá pra
 * resolver sem rodar o código.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS_DIR = join(REPO, 'scripts');
const SKIP_DIRS = new Set(['node_modules', '.git', 'screenshots', '.tmp']);

/** Coleta recursivamente todos os .js sob um diretório. */
function collectJs(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) collectJs(full, acc);
    else if (ent.isFile() && ent.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

/** Extrai os argumentos de cada join(__dirname, ...) de um arquivo, só os 100% literais. */
function extractDirnameJoins(content) {
  const out = [];
  // join(__dirname, <args até o ) da mesma linha>)
  const re = /join\(\s*__dirname\s*,([^)]*)\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1].trim();
    // Cada segmento precisa ser uma string literal ('x' ou "x"). Se houver
    // variável/expressão, não dá pra resolver estaticamente → pula.
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const literals = [];
    let dynamic = false;
    for (const p of parts) {
      const lit = p.match(/^['"](.*)['"]$/);
      if (lit) literals.push(lit[1]);
      else { dynamic = true; break; }
    }
    if (!dynamic) out.push(literals);
  }
  return out;
}

const scriptFiles = collectJs(SCRIPTS_DIR);

describe('paths dos scripts (join(__dirname, ...))', () => {
  it('acha scripts e paths estáticos (sentinela anti-regex-quebrado)', () => {
    expect(scriptFiles.length).toBeGreaterThan(20);
    const total = scriptFiles.reduce(
      (n, f) => n + extractDirnameJoins(readFileSync(f, 'utf8')).length, 0);
    expect(total).toBeGreaterThan(20);
  });

  it('todo join(__dirname,...) resolve p/ um diretório que existe', () => {
    const broken = [];
    for (const file of scriptFiles) {
      const fileDir = dirname(file);
      for (const parts of extractDirnameJoins(readFileSync(file, 'utf8'))) {
        const resolved = resolve(fileDir, ...parts);
        // O diretório que contém o alvo precisa existir. Não exigimos que o
        // arquivo exista (pode ser saída gerada: .sql, screenshots, .tmp...).
        const containingDir = parts.length && /\.[a-z0-9]+$/i.test(parts.at(-1))
          ? dirname(resolved)   // último segmento é arquivo → pai
          : resolved;           // sem extensão → trata como diretório-alvo
        const dirToCheck = existsSync(containingDir) && statSync(containingDir).isDirectory()
          ? containingDir
          : dirname(resolved);
        if (!existsSync(dirToCheck)) {
          broken.push(`${relative(REPO, file)} → ${relative(REPO, resolved)} (falta ${relative(REPO, dirToCheck)}/)`);
        }
      }
    }
    expect(broken, `paths quebrados:\n${broken.join('\n')}`).toEqual([]);
  });

  it('arquivos de dado de produção (src/assets/data/*.json) existem de fato', () => {
    const missing = [];
    for (const file of scriptFiles) {
      const fileDir = dirname(file);
      for (const parts of extractDirnameJoins(readFileSync(file, 'utf8'))) {
        const resolved = resolve(fileDir, ...parts);
        const rel = relative(REPO, resolved);
        if (/^src\/assets\/data\/.+\.json$/.test(rel) && !existsSync(resolved)) {
          missing.push(`${relative(REPO, file)} → ${rel}`);
        }
      }
    }
    expect(missing, `dados de produção ausentes:\n${missing.join('\n')}`).toEqual([]);
  });

  it('paths de script em spawn/exec/fork (string literal) apontam p/ arquivo real', () => {
    // Caminho cwd-relativo dentro de spawnSync('node', ['scripts/x.js']) escapa
    // do extractDirnameJoins. Foi assim que verify-fixtures.js ficou chamando o
    // path antigo scripts/fetch-fixtures.js (em vez de scripts/data/...) após o
    // refactor — falha só em runtime. Aqui validamos contra a raiz do repo.
    const SPAWN_RE = /(?:spawnSync|spawn|execSync|execFileSync|execFile|exec|fork)\s*\([^;]*?['"]((?:scripts|src|supabase)\/[^'"]+\.(?:m?js|cjs|json|sql))['"]/g;
    const broken = [];
    for (const file of scriptFiles) {
      const content = readFileSync(file, 'utf8');
      let m;
      while ((m = SPAWN_RE.exec(content)) !== null) {
        if (!existsSync(join(REPO, m[1]))) {
          broken.push(`${relative(REPO, file)} → ${m[1]} (não existe)`);
        }
      }
    }
    expect(broken, `spawn/exec apontando p/ script inexistente:\n${broken.join('\n')}`).toEqual([]);
  });
});

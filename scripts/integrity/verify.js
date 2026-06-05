#!/usr/bin/env node
/**
 * Verifica a cadeia de integridade dos palpites (defensibilidade — achado H3).
 *
 * NÃO precisa de banco nem de credenciais: lê só os arquivos commitados em
 * integrity/ e prova, recomputando os hashes, que:
 *   1. cada snapshot bate com o content_hash registrado no manifest;
 *   2. o encadeamento (chain_hash = SHA256(prev_chain_hash || content_hash))
 *      é contínuo e sem buracos.
 *
 * Qualquer participante roda `npm run integrity:verify` e confirma que nenhum
 * palpite/registro foi adulterado depois de carimbado. Se algo foi mexido, o
 * hash quebra e o script aponta exatamente em qual snapshot.
 *
 * Usage: node scripts/integrity/verify.js
 * Exit code 0 = cadeia íntegra; 1 = adulteração detectada.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTEGRITY_DIR = join(__dirname, '..', '..', 'integrity');
const MANIFEST = join(INTEGRITY_DIR, 'manifest.json');
const GENESIS = '0'.repeat(64);

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m' };
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function fail(msg) { console.log(`${C.red}✗ ${msg}${C.reset}`); process.exit(1); }

if (!existsSync(MANIFEST)) {
  console.log(`${C.dim}Nenhum manifest ainda (integrity/manifest.json). Nada a verificar.${C.reset}`);
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const entries = manifest.entries ?? [];

console.log(`${C.bold}🔎 Verificando ${entries.length} snapshot(s) de integridade…${C.reset}\n`);

let prevChain = GENESIS;
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  const label = `#${e.seq} (${e.taken_at})`;

  // 1) sequência contígua começando em 1
  if (e.seq !== i + 1) fail(`${label}: seq fora de ordem (esperado ${i + 1}).`);

  // 2) arquivo existe e bate com content_hash
  const fpath = join(INTEGRITY_DIR, e.file);
  if (!existsSync(fpath)) fail(`${label}: arquivo ausente: ${e.file}`);
  const body = readFileSync(fpath, 'utf8');
  const contentHash = sha256(body);
  if (contentHash !== e.content_hash) {
    fail(`${label}: content_hash NÃO bate — arquivo adulterado.\n   registrado: ${e.content_hash}\n   calculado:  ${contentHash}`);
  }

  // 3) encadeamento contínuo
  if (e.prev_chain_hash !== prevChain) {
    fail(`${label}: prev_chain_hash quebrado (cadeia rompida ou snapshot removido).`);
  }
  const chainHash = sha256(prevChain + contentHash);
  if (chainHash !== e.chain_hash) {
    fail(`${label}: chain_hash NÃO bate.\n   registrado: ${e.chain_hash}\n   calculado:  ${chainHash}`);
  }

  console.log(`${C.green}✓${C.reset} ${label}  ${C.dim}${e.counts?.predictions ?? '?'} palpites · chain ${chainHash.slice(0, 16)}…${C.reset}`);
  prevChain = e.chain_hash;
}

console.log(`\n${C.green}${C.bold}🎉 Cadeia íntegra (${entries.length} snapshot(s)).${C.reset}`);
if (entries.length) console.log(`${C.dim}Hash final da cadeia: ${prevChain}${C.reset}`);

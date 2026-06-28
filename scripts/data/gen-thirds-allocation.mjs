// ============================================================
// Gera src/assets/data/thirds-allocation.json — a tabela OFICIAL da FIFA
// (Annexe C do Regulamento da Copa 2026) que mapeia QUAIS 8 grupos têm um 3º
// classificado → para qual jogo das 32-avos cada 3º vai.
// ============================================================
// POR QUE ISSO EXISTE: na Copa 2026 (48 seleções, 12 grupos, 8 melhores 3ºs),
// a atribuição dos 3ºs aos slots NÃO é "qualquer emparelhamento válido". A FIFA
// publica uma tabela fixa de 495 combinações (C(12,8)=495). Para cada conjunto
// de 8 grupos qualificados há UMA atribuição oficial. Resolver por backtracking
// (qualquer matching válido) diverge da oficial — foi o bug que trocou
// Suécia/Paraguai entre os jogos de Alemanha e França nas oitavas de 2026.
//
// FONTE: Wikipedia "Template:2026 FIFA World Cup third-place table", que
// transcreve a Annexe C. Cabeçalho das 8 colunas de jogo: 1A,1B,1D,1E,1G,1I,1K,1L.
//
// USO: node scripts/data/gen-thirds-allocation.mjs
//   (baixa o wikitext, parseia, VALIDA e grava o JSON; sem rede usa --file <path>)

import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC_URL = 'https://en.wikipedia.org/wiki/Template:2026_FIFA_World_Cup_third-place_table?action=raw';
const OUT_JSON = resolve(process.cwd(), 'src/assets/data/thirds-allocation.json');
const OUT_JS = resolve(process.cwd(), 'src/js/thirds-allocation.js');

// Ordem das 8 colunas de jogo no cabeçalho da tabela (1-seed de cada oitava
// que recebe um 3º). KEEP IN SYNC com worldcup.json (slots compostos).
const MATCH_COLS = ['1A', '1B', '1D', '1E', '1G', '1I', '1K', '1L'];

// Grupos válidos por jogo (= rótulo "3X/Y/Z" do slot composto de cada oitava).
// Usado só para VALIDAR que a tabela oficial respeita os slots do bracket.
const VALID_GROUPS = {
  '1E': ['A', 'B', 'C', 'D', 'F'],
  '1I': ['C', 'D', 'F', 'G', 'H'],
  '1A': ['C', 'E', 'F', 'H', 'I'],
  '1L': ['E', 'H', 'I', 'J', 'K'],
  '1D': ['B', 'E', 'F', 'I', 'J'],
  '1G': ['A', 'E', 'H', 'I', 'J'],
  '1B': ['E', 'F', 'G', 'I', 'J'],
  '1K': ['D', 'E', 'I', 'J', 'L'],
};

async function getWikitext() {
  const fileArg = process.argv.indexOf('--file');
  if (fileArg !== -1) return readFileSync(process.argv[fileArg + 1], 'utf8');
  const res = await fetch(SRC_URL);
  if (!res.ok) throw new Error(`fetch ${SRC_URL} → ${res.status}`);
  return res.text();
}

function parse(wikitext) {
  const lines = wikitext.split(/\r?\n/);
  const table = {};
  for (let i = 0; i < lines.length; i++) {
    if (!/^!\s*scope="row"\s*\|\s*\d+/.test(lines[i])) continue;
    // Junta as linhas de dados até o próximo "! scope=row" (o conteúdo da linha
    // pode estar tudo numa linha só ou quebrado em 3 — a do separador rowspan).
    let buf = '';
    for (let j = i + 1; j < lines.length && !/^!\s*scope="row"/.test(lines[j]); j++) {
      buf += ' ' + lines[j];
      if (/^\|-/.test(lines[j + 1] || '')) break;
    }
    // Extração por regex (robusta a separadores de célula | vs ||, à célula
    // rowspan e ao lixo de fim de tabela): grupos vêm em NEGRITO ('''X'''),
    // atribuições são tokens "3X" simples. Corta no fim da tabela (|}).
    buf = buf.split('|}')[0];
    const groups = [...buf.matchAll(/'''([A-L])'''/g)].map(m => m[1]).sort();
    const assigns = [...buf.matchAll(/\b3([A-L])\b/g)].map(m => m[1]);
    if (groups.length !== 8 || assigns.length !== 8) continue;
    const combo = groups.join('');
    const row = {};
    MATCH_COLS.forEach((col, k) => { row[col] = assigns[k]; });
    table[combo] = row;
  }
  return table;
}

function validate(table) {
  const combos = Object.keys(table);
  const errors = [];
  if (combos.length !== 495) errors.push(`esperava 495 combinações, achei ${combos.length}`);
  for (const [combo, row] of Object.entries(table)) {
    const comboSet = new Set(combo.split(''));
    const assigned = MATCH_COLS.map(c => row[c]);
    // bijeção: as 8 atribuições usam exatamente os 8 grupos da combinação
    if (new Set(assigned).size !== 8) errors.push(`${combo}: 3ºs repetidos ${assigned.join('')}`);
    for (const g of assigned) if (!comboSet.has(g)) errors.push(`${combo}: atribui 3${g} fora da combinação`);
    // cada atribuição respeita os grupos válidos do slot
    for (const col of MATCH_COLS) {
      if (!VALID_GROUPS[col].includes(row[col])) {
        errors.push(`${combo}: ${col} recebe 3${row[col]} fora de ${VALID_GROUPS[col].join('/')}`);
      }
    }
  }
  return errors;
}

const wikitext = await getWikitext();
const table = parse(wikitext);
const errors = validate(table);
if (errors.length) {
  console.error('VALIDAÇÃO FALHOU:');
  for (const e of errors.slice(0, 30)) console.error('  - ' + e);
  process.exit(1);
}
const SRC = 'FIFA World Cup 2026 Regulations, Annexe C (via Wikipedia Template:2026_FIFA_World_Cup_third-place_table)';
const payload = {
  source: SRC,
  generated_at: new Date().toISOString(),
  match_cols: MATCH_COLS,
  combinations: table,
};
writeFileSync(OUT_JSON, JSON.stringify(payload, null, 0) + '\n');

// Módulo ESM (consumido por src/js/thirds-assign.js, testes e simulador — import
// síncrono que funciona igual em Vite, vitest e Node puro, sem JSON assertions).
const js = `// ============================================================
// GERADO por scripts/data/gen-thirds-allocation.mjs — NÃO EDITAR À MÃO.
// Tabela OFICIAL da FIFA (Annexe C, Regulamento da Copa 2026): atribuição dos
// 8 melhores 3ºs aos jogos das 32-avos, keyed por QUAIS 8 grupos qualificaram.
// Fonte: ${SRC}
// ============================================================

/** Ordem das 8 colunas de jogo (1-seed de cada oitava que recebe um 3º). */
export const MATCH_COLS = ${JSON.stringify(MATCH_COLS)};

/**
 * combo (8 letras de grupo ordenadas, ex.: "ABCDEFJL") -> { "1A":"C", ... }
 * onde o valor é a LETRA do grupo cujo 3º enfrenta aquele 1-seed.
 */
export const THIRDS_ALLOCATION = ${JSON.stringify(Object.fromEntries(Object.keys(table).sort().map(k => [k, table[k]])))};
`;
writeFileSync(OUT_JS, js);
console.log(`OK — ${Object.keys(table).length} combinações → ${OUT_JSON} + ${OUT_JS}`);

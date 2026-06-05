#!/usr/bin/env node
/**
 * Fetch World Cup 2026 QUALIFYING standings/brackets from API-Football.
 * Usage: node scripts/fetch-qualifiers.js
 * Output: src/assets/data/qualifiers.json
 *
 * Alimenta a seção "Eliminatórias" do Raio-X: a campanha classificatória de
 * cada seleção, para comparar como mandante e visitante chegaram à Copa.
 *
 * Por que cada confederação é tratada diferente:
 *   - CONMEBOL / UEFA / CAF / CONCACAF: /standings devolve a tabela completa
 *     (pontos corridos ou grupos). Cada confederação usa um `season` diferente
 *     (ver QUALIFIERS) — pegadinha da API.
 *   - AFC (Ásia): /standings só devolve a ÚLTIMA fase (Round 4). As tabelas da
 *     3ª fase — onde Coreia, Japão, Irã, Austrália, Uzbequistão e Jordânia se
 *     classificaram — não existem como standings, então são RECONSTRUÍDAS a
 *     partir dos fixtures (union-find agrupa quem jogou contra quem; depois
 *     somamos os pontos dos jogos encerrados).
 *   - OFC (Oceania) e Repescagem Intercontinental: formato mata-mata → viram
 *     CHAVE (rounds de Semi/Final), não tabela.
 *   - Anfitriões (EUA, Canadá, México): não disputaram → marcados como `host`.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const API_KEY = process.env.API_FOOTBALL_KEY || process.env['API-FOOTBALL-KEY'];
const BASE_URL = 'https://v3.football.api-sports.io';
const OUTPUT_PATH = join(__dirname, '..', '..', 'src', 'assets', 'data', 'qualifiers.json');

// Confederações com tabela limpa via /standings. `season` varia por liga.
const TABLE_QUALIFIERS = [
  { conf: 'CONMEBOL', namePt: 'Eliminatórias da América do Sul', id: 34, season: 2026 },
  { conf: 'UEFA',     namePt: 'Eliminatórias da Europa',         id: 32, season: 2024 },
  { conf: 'CAF',      namePt: 'Eliminatórias da África',         id: 29, season: 2023 },
  { conf: 'CONCACAF', namePt: 'Eliminatórias da Concacaf',       id: 31, season: 2026 },
];
// AFC é reconstruída de fixtures (3ª fase) + /standings (4ª fase).
const AFC = { conf: 'AFC', namePt: 'Eliminatórias da Ásia', id: 30, season: 2026 };
// Mata-mata → chave.
// UEFA_PO: a repescagem europeia NÃO é uma liga própria na API — é o round
// Semi-finals/Final dentro da própria liga 32 (a mesma da tabela, season 2024).
// buildBracket filtra só os rounds de KO_ROUNDS, então a fase de grupos da 32
// é ignorada e sobram só os 16 times dos play-offs. Os vices de grupo (Tchéquia,
// Turquia, Bósnia...) jogam tabela E aparecem aqui → ganham `playoff: 'UEFA_PO'`
// pelo mesmo mapeamento da Intercontinental, e o Raio-X mostra a chave deles.
const BRACKET_QUALIFIERS = [
  { key: 'OFC',       namePt: 'Eliminatórias da Oceania',      id: 33, season: 2026 },
  { key: 'INTERCONT', namePt: 'Repescagem Intercontinental',   id: 37, season: 2026 },
  { key: 'UEFA_PO',   namePt: 'Repescagem Europeia',           id: 32, season: 2024 },
];

// A API-Football usa grafias diferentes do bolão para algumas seleções.
// Canonicalizamos para o nome usado em worldcup.json / recent.json (= o
// m.team_home do banco), senão o lookup por nome no Raio-X falha e o time
// não recebe a seção de eliminatórias nem o destaque na tabela.
const NAME_ALIASES = {
  'Türkiye': 'Turkey',
  'Cape Verde Islands': 'Cape Verde',
  'Congo DR': 'DR Congo',
};
const canon = (name) => NAME_ALIASES[name] || name;

async function api(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    throw new Error(`API error on ${path}: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

// Linha de tabela no formato compacto do front.
function row(rank, teamName, played, win, draw, lose, gf, ga, points, description) {
  return {
    rank, team: canon(teamName), played, win, draw, lose,
    gf, ga, gd: gf - ga, points,
    description: description || null,
  };
}

// Converte uma linha do /standings da API para o formato compacto.
function rowFromStanding(t) {
  const a = t.all || {};
  const g = a.goals || {};
  return row(t.rank, t.team.name, a.played || 0, a.win || 0, a.draw || 0, a.lose || 0,
    g.for || 0, g.against || 0, t.points || 0, t.description);
}

// ---- AFC: reconstrução de grupos a partir de fixtures ----------------------

// Union-find simples para agrupar times que jogaram entre si.
function clusterByOpponents(fixtures) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  for (const f of fixtures) union(f.teams.home.name, f.teams.away.name);
  const groups = new Map();
  for (const team of parent.keys()) {
    const r = find(team);
    if (!groups.has(r)) groups.set(r, new Set());
    groups.get(r).add(team);
  }
  return [...groups.values()].map(s => [...s]);
}

// Calcula a classificação de um grupo a partir dos jogos encerrados.
// `describe(rank)` sintetiza o status (a API não dá description em fase
// reconstruída) — na 3ª fase da AFC o top 2 vai direto e o 3º/4º à 4ª fase.
function computeGroupTable(teams, fixtures, describe = () => null) {
  const stat = new Map(teams.map(t => [t, { team: t, played: 0, win: 0, draw: 0, lose: 0, gf: 0, ga: 0, points: 0 }]));
  for (const f of fixtures) {
    if (f.fixture.status.short !== 'FT') continue;
    const h = f.teams.home.name, a = f.teams.away.name;
    const hg = f.goals.home, ag = f.goals.away;
    if (!stat.has(h) || !stat.has(a) || hg == null || ag == null) continue;
    const sh = stat.get(h), sa = stat.get(a);
    sh.played++; sa.played++;
    sh.gf += hg; sh.ga += ag; sa.gf += ag; sa.ga += hg;
    if (hg > ag) { sh.win++; sh.points += 3; sa.lose++; }
    else if (hg < ag) { sa.win++; sa.points += 3; sh.lose++; }
    else { sh.draw++; sa.draw++; sh.points++; sa.points++; }
  }
  const sorted = [...stat.values()].sort((x, y) =>
    y.points - x.points || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.team.localeCompare(y.team));
  return sorted.map((s, i) => row(i + 1, s.team, s.played, s.win, s.draw, s.lose, s.gf, s.ga, s.points, describe(i + 1)));
}

async function buildAfc() {
  const { response: fixtures } = await api(`/fixtures?league=${AFC.id}&season=${AFC.season}`);
  // 3ª fase: reconstrói os grupos pelos jogos.
  const third = fixtures.filter(f => /^3rd Round/.test(f.league.round));
  const clusters = clusterByOpponents(third);
  // Rótulo estável: ordena clusters pelo "menor" nome para A/B/C deterministico.
  clusters.sort((c1, c2) => [...c1].sort()[0].localeCompare([...c2].sort()[0]));
  // Top 2 do grupo de 6 vão direto à Copa; 3º e 4º avançam à 4ª fase.
  const afcDescribe = (rank) => rank <= 2 ? 'Promotion - World Cup'
    : rank <= 4 ? 'Play-offs - 4ª fase' : null;
  const groups = clusters.map((teams, i) => ({
    name: `3ª fase · Grupo ${String.fromCharCode(65 + i)}`,
    rows: computeGroupTable(teams, third, afcDescribe),
  }));
  // 4ª fase: tabela oficial via /standings (2 grupos de 3).
  try {
    const std = await api(`/standings?league=${AFC.id}&season=${AFC.season}`);
    const tables = std.response[0]?.league.standings || [];
    for (const tbl of tables) {
      groups.push({
        name: `4ª fase · ${tbl[0].group}`,
        rows: tbl.map(rowFromStanding),
      });
    }
  } catch (e) {
    console.warn('  ! AFC Round 4 standings indisponível:', e.message);
  }
  const teamsInConf = new Set(groups.flatMap(g => g.rows.map(r => r.team)));
  return { conf: AFC.conf, namePt: AFC.namePt, groups, teams: teamsInConf };
}

// ---- Mata-mata: monta a chave a partir de fixtures -------------------------

const KO_ROUNDS = ['Semi-finals', 'Final', 'Play-offs', '3rd Place', 'Quarter-finals'];

async function buildBracket(cfg) {
  const { response: fixtures } = await api(`/fixtures?league=${cfg.id}&season=${cfg.season}`);
  const ko = fixtures.filter(f => KO_ROUNDS.some(r => f.league.round.includes(r)));
  // Agrupa por round preservando ordem de ocorrência.
  const order = [];
  const byRound = new Map();
  for (const f of ko) {
    const r = f.league.round;
    if (!byRound.has(r)) { byRound.set(r, []); order.push(r); }
    byRound.get(r).push({
      date: f.fixture.date ? f.fixture.date.slice(0, 10) : null,
      home: canon(f.teams.home.name),
      away: canon(f.teams.away.name),
      homeGoals: f.goals.home,
      awayGoals: f.goals.away,
      homeWinner: f.teams.home.winner,
      awayWinner: f.teams.away.winner,
      status: f.fixture.status.short,
    });
  }
  const rounds = order.map(name => ({ name, ties: byRound.get(name) }));
  const teams = new Set(ko.flatMap(f => [canon(f.teams.home.name), canon(f.teams.away.name)]));
  return { key: cfg.key, namePt: cfg.namePt, rounds, teams };
}

// ---- main ------------------------------------------------------------------

async function main() {
  if (!API_KEY) { console.error('Error: API_FOOTBALL_KEY not found in .env'); process.exit(1); }

  console.log('Fetching WC2026 qualifiers...');

  // 1) Os 48 da Copa (pra saber quem é anfitrião / mapear cada time).
  const wc = await api('/standings?league=1&season=2026');
  const wcTeams = (wc.response[0]?.league.standings || [])
    .flat().filter(t => /^Group [A-L]$/.test(t.group)).map(t => canon(t.team.name));
  console.log(`  Seleções na Copa: ${wcTeams.length}`);

  const confederations = {};
  const teamIndex = {};      // teamName -> { confederation|bracket|host, ... }
  const confTeams = {};      // conf -> Set(teamName)

  // 2) Confederações com tabela direta.
  for (const q of TABLE_QUALIFIERS) {
    const std = await api(`/standings?league=${q.id}&season=${q.season}`);
    const tables = std.response[0]?.league.standings || [];
    const groups = tables.map(tbl => ({ name: tbl[0].group, rows: tbl.map(rowFromStanding) }));
    confederations[q.conf] = { namePt: q.namePt, format: 'table', groups };
    confTeams[q.conf] = new Set(groups.flatMap(g => g.rows.map(r => r.team)));
    console.log(`  ${q.conf}: ${groups.length} grupo(s)`);
  }

  // 3) AFC reconstruída.
  const afc = await buildAfc();
  confederations[afc.conf] = { namePt: afc.namePt, format: 'table', groups: afc.groups };
  confTeams[afc.conf] = afc.teams;
  console.log(`  AFC: ${afc.groups.length} grupo(s) reconstruído(s)`);

  // 4) Mata-matas.
  const brackets = {};
  const bracketTeams = {};
  for (const b of BRACKET_QUALIFIERS) {
    const br = await buildBracket(b);
    brackets[br.key] = { namePt: br.namePt, format: 'bracket', rounds: br.rounds };
    bracketTeams[br.key] = br.teams;
    console.log(`  ${br.key}: ${br.rounds.length} round(s) de mata-mata`);
  }

  // 5) Mapeia cada seleção da Copa para sua campanha.
  const HOSTS = new Set(['USA', 'United States', 'Canada', 'Mexico']);
  const unmapped = [];
  for (const team of wcTeams) {
    if (HOSTS.has(team)) { teamIndex[team] = { format: 'host' }; continue; }
    const conf = Object.keys(confTeams).find(c => confTeams[c].has(team));
    const br = Object.keys(bracketTeams).find(k => bracketTeams[k].has(team));
    if (conf) {
      // Jogou a fase de tabela da confederação. Se TAMBÉM aparece num bracket de
      // repescagem (ex.: Intercontinental), guarda como `playoff` — senão o
      // mata-mata da repescagem ficava órfão (formato era único, table-first).
      teamIndex[team] = { format: 'table', confederation: conf };
      if (br) teamIndex[team].playoff = br;
      continue;
    }
    if (br) { teamIndex[team] = { format: 'bracket', bracket: br }; continue; }
    unmapped.push(team);
    teamIndex[team] = { format: 'unknown' };
  }
  if (unmapped.length) console.warn(`  ! Sem campanha mapeada: ${unmapped.join(', ')}`);

  const out = {
    generatedAt: new Date().toISOString(),
    confederations,
    brackets,
    teams: teamIndex,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`✓ Done! Output: ${OUTPUT_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });

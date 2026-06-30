// Liga as partidas de MATA-MATA com a fixture da API-Football por PAR de
// seleções (endpoint headtohead), porque a fixtures.json estática (gerada antes
// da Copa) traz os mata-matas como TBD — a ligação tem que ser ao vivo, só
// quando os dois lados já são times reais (slots resolvidos).
//
// Compartilhado por fetch-odds.js e fetch-predictions.js. Devolve um Map por
// match_id com a fixture e a orientação (mando) da API vs o nosso team_home, pra
// que os consumidores reorientem odds/previsão quando a API tem o mando oposto.
//
// Server-side, sem DOM. As partes puras (apiName, buildApiNameToId,
// pickFixtureForDate) são exportadas pra teste.

import { readFileSync } from 'fs';

// Nome do time no padrão da API-Football quando difere do nome no nosso DB.
// Mesmos aliases de fetch-odds.js / fetch-cards.js.
const TEAM_ALIAS = {
  'Cape Verde': 'Cape Verde Islands',
  'DR Congo': 'Congo DR',
};
export const apiName = (n) => TEAM_ALIAS[n] ?? n;

// Map<nome-da-API, id-da-API> a partir da fixtures.json (todos os 48 times
// aparecem na fase de grupos, então o mapa cobre todas as seleções da Copa).
export function buildApiNameToId(fixturesPath) {
  const fx = JSON.parse(readFileSync(fixturesPath, 'utf-8')).fixtures;
  const map = new Map();
  for (const f of fx) {
    for (const t of [f.homeTeam, f.awayTeam]) {
      if (t?.name && t.id != null) map.set(t.name, t.id);
    }
  }
  return map;
}

// Escolhe, entre os confrontos devolvidos pelo headtohead, o mais próximo da
// data da nossa partida (instantes absolutos; tz não importa). null se vazio.
export function pickFixtureForDate(response, matchDate) {
  const list = (response || []).filter(f => f?.fixture?.id != null);
  if (!list.length) return null;
  const target = new Date(matchDate).getTime();
  return list.slice().sort((a, b) =>
    Math.abs(new Date(a.fixture.date).getTime() - target) -
    Math.abs(new Date(b.fixture.date).getTime() - target)
  )[0];
}

/**
 * Resolve as fixtures da API para as partidas de mata-mata com times reais.
 * Persiste matches.api_fixture_id (aditivo) e devolve o mapa de orientação.
 *
 * @returns {Promise<Map<number, {
 *   apiFixtureId:number, apiHomeId:number, apiAwayId:number,
 *   ourHomeApiId:number, ourAwayApiId:number, reversed:boolean }>>}
 */
export async function resolveKnockoutFixtures({ admin, apiGet, fixturesPath, dryRun = false, log = () => {} }) {
  const nameToId = buildApiNameToId(fixturesPath);

  const { data: matches, error } = await admin
    .from('matches')
    .select('id, team_home, team_away, match_date, api_fixture_id, stage')
    .neq('stage', 'group')
    .order('match_date');
  if (error) throw error;

  const out = new Map();
  let linked = 0, pending = 0, unresolved = 0;

  for (const m of matches) {
    const ourHomeApiId = nameToId.get(apiName(m.team_home));
    const ourAwayApiId = nameToId.get(apiName(m.team_away));
    // Sem id pros DOIS lados = slot ainda não virou time real (ex.: "W49", "1A").
    if (!ourHomeApiId || !ourAwayApiId) { unresolved++; continue; }

    const data = await apiGet(`/fixtures/headtohead?h2h=${ourHomeApiId}-${ourAwayApiId}&season=2026&league=1`);
    const fx = pickFixtureForDate(data.response, m.match_date);
    if (!fx) { log(`  [no-fixture] #${m.id} ${m.team_home} x ${m.team_away}`); pending++; continue; }

    const apiHomeId = fx.teams.home.id, apiAwayId = fx.teams.away.id;
    out.set(m.id, {
      apiFixtureId: fx.fixture.id,
      apiHomeId, apiAwayId,
      ourHomeApiId, ourAwayApiId,
      reversed: ourHomeApiId !== apiHomeId,   // API tem o mando oposto ao nosso?
    });

    if (!dryRun && m.api_fixture_id !== fx.fixture.id) {
      const { error: e } = await admin.from('matches').update({ api_fixture_id: fx.fixture.id }).eq('id', m.id);
      if (e) throw e;
    }
    linked++;
  }

  log(`Linkage mata-mata: ${linked} com fixture · ${pending} sem fixture ainda · ${unresolved} com slot não resolvido`);
  return out;
}

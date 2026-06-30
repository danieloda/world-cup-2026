// Normaliza a resposta de GET /predictions da API-Football para o shape que o
// front (js/raiox.js / renderPredictionsBlock) consome. Server-side, usado por
// scripts/fetch-predictions.js. Mantido separado pra ser testável sem disparar
// o fetch real.
//
// Shape de saída (ou null quando a API não tem previsão útil OU não há radar —
// ver decisão do produto no final da função):
//   { source, pHome, pDraw, pAway, favored:'home'|'draw'|'away',
//     comparison:[{ label, home, away }], radar:{ axes, home[], away[] } }

export const pct = (v) => { const n = parseFloat(String(v ?? '').replace('%', '')); return Number.isFinite(n) ? Math.round(n) : 0; };
const numv = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const clamp01 = (n) => Math.max(0, Math.min(100, Math.round(n)));

// Eixos do comparison da API → rótulo PT (na ordem de exibição).
const CMP_LABELS = [
  ['form', 'Forma'], ['att', 'Ataque'], ['def', 'Defesa'],
  ['poisson_distribution', 'Poisson'], ['h2h', 'Confronto'],
  ['goals', 'Gols'], ['total', 'Geral'],
];
const GOALS_SCALE = 3.5;   // gols/jogo que mapeia 100% no radar

// Radar de força a partir de teams.X.last_5 (form/att/def em %, gols → %).
// null quando nenhum dos lados tem histórico (cai no fallback de barras no front).
export function buildRadar(h, a) {
  if (!h || !a) return null;
  if ((h.played || 0) + (a.played || 0) === 0) return null;
  const gf = (l) => clamp01(numv(l?.goals?.for?.average) / GOALS_SCALE * 100);
  const solidez = (l) => clamp01(100 - numv(l?.goals?.against?.average) / GOALS_SCALE * 100);
  const side = (l) => [pct(l.form), pct(l.att), pct(l.def), gf(l), solidez(l)];
  return { axes: ['Forma', 'Ataque', 'Defesa', 'Gols pró', 'Solidez'], home: side(h), away: side(a) };
}

// entry = response[0] de /predictions. Retorna o shape normalizado, ou null
// quando não há previsão ÚTIL (advice "No predictions available" ou 33/33/33).
export function normalizePrediction(entry, apiHomeId, apiAwayId) {
  const p = entry?.predictions;
  if (!p || p.advice === 'No predictions available') return null;

  const pHome = pct(p.percent?.home), pDraw = pct(p.percent?.draw), pAway = pct(p.percent?.away);
  if (pHome === pDraw && pDraw === pAway) return null;  // 33/33/33 = default "sem convicção"

  const wid = p.winner?.id ?? null;
  const favored = wid === apiHomeId ? 'home' : wid === apiAwayId ? 'away' : 'draw';

  const comparison = CMP_LABELS
    .filter(([k]) => entry.comparison?.[k])
    .map(([k, label]) => ({ label, home: pct(entry.comparison[k].home), away: pct(entry.comparison[k].away) }));

  // Decisão do produto: a previsão só vale com RADAR (forma/ataque/defesa por
  // time). Sem last_5 (ex.: seleções antes de jogar na temporada) não há radar,
  // então não devolvemos nada — o jogo fica sem previsão (igual às odds).
  const radar = buildRadar(entry.teams?.home?.last_5, entry.teams?.away?.last_5);
  if (!radar) return null;

  return { source: 'API-Football', pHome, pDraw, pAway, favored, comparison, radar };
}

// Inverte a ótica casa↔fora de uma previsão JÁ normalizada. Usado no mata-mata
// quando a fixture da API tem o mando OPOSTO ao nosso team_home: a previsão
// (favorito, %, comparison, radar) sai na ótica da fixture, mas o Raio-X exibe
// na ótica do NOSSO mandante. Espelha favored, pHome↔pAway, e o lado home↔away
// de cada eixo do comparison e do radar.
export function flipPrediction(p) {
  if (!p) return p;
  return {
    ...p,
    pHome: p.pAway,
    pAway: p.pHome,
    favored: p.favored === 'home' ? 'away' : p.favored === 'away' ? 'home' : 'draw',
    comparison: Array.isArray(p.comparison)
      ? p.comparison.map(c => ({ label: c.label, home: c.away, away: c.home }))
      : p.comparison,
    radar: p.radar
      ? { axes: p.radar.axes, home: p.radar.away, away: p.radar.home }
      : p.radar,
  };
}

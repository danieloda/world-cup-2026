// Normaliza os mercados EXTRA de odds (além do 1X2) da resposta da API-Football
// para o shape enxuto que o Raio-X consome (ver js/raiox.js — Placar provável e
// Perfil de gols). Server-side, usado por scripts/data/fetch-odds.js. Mantido
// separado pra ser testável sem disparar o fetch real.
//
// Entrada: o array `bets` de UM bookmaker (Betano), no formato da API:
//   [{ id, name, values: [{ value, odd }] }, ...]
//
// Saída (ou null quando não há nenhum mercado útil):
//   {
//     scorelines: [{ score:'1-0', prob }],            // top 6, de-margined
//     overUnder:  { line:2.5, over, under },           // % "muitos/poucos gols"
//     btts:       { yes, no },                          // % ambas marcam
//     totalGoals: [{ goals:0..'5+', prob }],            // distribuição do total
//     teamGoals:  { home:{ exp, dist:[{goals,prob}] },  // gols por seleção
//                   away:{ exp, dist:[{goals,prob}] } }
//   }
// Todas as % são probabilidade implícita NORMALIZADA (1/odd dividido pela soma —
// remove a margem da casa, mesma ideia do oddsToProbs do 1X2).

// IDs dos mercados na API-Football (estáveis; casamos por id, não por nome).
const BET = {
  EXACT_SCORE: 10,
  OVER_UNDER: 5,
  BTTS: 8,
  EXACT_GOALS: 38,
  HOME_EXACT_GOALS: 40,
  AWAY_EXACT_GOALS: 41,
};

const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

// Inverte odds → prob. implícita normalizada (%). Recebe [{ key, odd }] e devolve
// [{ key, prob }] com prob arredondado, somando ~100. Ignora odds inválidas (≤1).
function demargin(entries) {
  const inv = entries
    .map(e => ({ key: e.key, w: e.odd > 1 ? 1 / e.odd : 0 }))
    .filter(e => e.w > 0);
  const sum = inv.reduce((s, e) => s + e.w, 0);
  if (sum <= 0) return [];
  return inv.map(e => ({ key: e.key, prob: Math.round((e.w / sum) * 100) }));
}

// bet.values → [{ value, odd:Number }] (odds parseadas, inválidas viram null).
function valuesOf(bets, id) {
  const bet = bets?.find(b => Number(b.id) === id);
  if (!bet?.values?.length) return null;
  return bet.values.map(v => ({ value: String(v.value), odd: num(v.odd) }));
}

// "1:0" | "1-0" → "1-0" (placar na ótica casa-fora). null se malformado.
function scoreLabel(v) {
  const m = /^(\d+)\s*[:\-x]\s*(\d+)$/.exec(v.trim());
  return m ? `${m[1]}-${m[2]}` : null;
}

// Bucketiza um rótulo de gols num inteiro 0..N; "more 4"/"4+"/"5 or more" → o teto.
function goalsBucket(v) {
  const s = v.toLowerCase();
  const m = /(\d+)/.exec(s);
  return m ? parseInt(m[1], 10) : null;
}

// --- mercados individuais ---

function buildScorelines(bets) {
  const vals = valuesOf(bets, BET.EXACT_SCORE);
  if (!vals) return null;
  const entries = [];
  for (const v of vals) {
    const score = scoreLabel(v.value);
    if (score && v.odd > 1) entries.push({ key: score, odd: v.odd });
  }
  if (entries.length < 3) return null; // pouco dado = não confiável
  return demargin(entries)
    .map(e => ({ score: e.key, prob: e.prob }))
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 6);
}

// Over/Under na linha 2.5 (padrão "muitos gols" = 3+). Cai pra linha mais próxima
// de 2.5 se 2.5 faltar.
function buildOverUnder(bets) {
  const vals = valuesOf(bets, BET.OVER_UNDER);
  if (!vals) return null;
  const lines = new Map(); // line -> { over, under }
  for (const v of vals) {
    const m = /^(Over|Under)\s+([\d.]+)$/i.exec(v.value);
    if (!m || !(v.odd > 1)) continue;
    const line = parseFloat(m[2]);
    if (!lines.has(line)) lines.set(line, {});
    lines.get(line)[m[1].toLowerCase()] = v.odd;
  }
  let best = null, bestDist = Infinity;
  for (const [line, o] of lines) {
    if (o.over == null || o.under == null) continue;
    const d = Math.abs(line - 2.5);
    if (d < bestDist) { bestDist = d; best = { line, over: o.over, under: o.under }; }
  }
  if (!best) return null;
  const [over, under] = demargin([{ key: 'over', odd: best.over }, { key: 'under', odd: best.under }]);
  return { line: best.line, over: over.prob, under: under.prob };
}

function buildBtts(bets) {
  const vals = valuesOf(bets, BET.BTTS);
  if (!vals) return null;
  const yes = vals.find(v => /^yes$/i.test(v.value))?.odd;
  const no = vals.find(v => /^no$/i.test(v.value))?.odd;
  if (!(yes > 1) || !(no > 1)) return null;
  const d = demargin([{ key: 'yes', odd: yes }, { key: 'no', odd: no }]);
  return { yes: d[0].prob, no: d[1].prob };
}

// Distribuição do TOTAL de gols (mercado Exact Goals Number). Buckets 0..4 + "5+".
function buildTotalGoals(bets) {
  const vals = valuesOf(bets, BET.EXACT_GOALS);
  if (!vals) return null;
  const entries = [];
  for (const v of vals) {
    const g = goalsBucket(v.value);
    if (g != null && v.odd > 1) entries.push({ key: g, odd: v.odd });
  }
  if (entries.length < 3) return null;
  const probByG = new Map();
  for (const e of demargin(entries)) {
    const bucket = e.key >= 5 ? '5+' : e.key;
    probByG.set(bucket, (probByG.get(bucket) || 0) + e.prob);
  }
  const out = [];
  for (const g of [0, 1, 2, 3, 4, '5+']) if (probByG.has(g)) out.push({ goals: g, prob: probByG.get(g) });
  return out.length ? out : null;
}

// Gols esperados de UMA seleção (mercado Home/Away Exact Goals Number).
// Buckets 0..3 + "4+"; exp = média ponderada (4+ pesa ~4.3).
function buildTeamGoals(bets, id) {
  const vals = valuesOf(bets, id);
  if (!vals) return null;
  const entries = [];
  for (const v of vals) {
    const g = goalsBucket(v.value);
    if (g != null && v.odd > 1) entries.push({ key: g, odd: v.odd });
  }
  if (entries.length < 3) return null;
  const probByG = new Map();
  for (const e of demargin(entries)) {
    const bucket = e.key >= 4 ? '4+' : e.key;
    probByG.set(bucket, (probByG.get(bucket) || 0) + e.prob);
  }
  const dist = [];
  let exp = 0;
  for (const g of [0, 1, 2, 3, '4+']) {
    if (!probByG.has(g)) continue;
    const prob = probByG.get(g);
    dist.push({ goals: g, prob });
    exp += (g === '4+' ? 4.3 : g) * (prob / 100);
  }
  if (!dist.length) return null;
  return { exp: Math.round(exp * 10) / 10, dist };
}

// Inverte a ótica casa↔fora de um objeto de mercados JÁ normalizado. Usado no
// mata-mata quando a fixture da API tem o mando OPOSTO ao nosso team_home (ver
// scripts/data/fetch-odds.js): a Betano dá os mercados na ótica da fixture, mas
// o Raio-X exibe na ótica do NOSSO mandante. overUnder/btts/totalGoals são
// simétricos (não têm lado) → ficam iguais. scorelines invertem os dígitos
// (1-0 → 0-1, mesma prob) e teamGoals troca home↔away.
export function flipMarkets(mk) {
  if (!mk) return mk;
  const out = { ...mk };
  if (Array.isArray(mk.scorelines)) {
    out.scorelines = mk.scorelines.map(s => {
      const [a, b] = String(s.score).split('-');
      return { score: `${b}-${a}`, prob: s.prob };
    });
  }
  if (mk.teamGoals) {
    out.teamGoals = { home: mk.teamGoals.away ?? null, away: mk.teamGoals.home ?? null };
  }
  return out;
}

export function normalizeOddsMarkets(bets) {
  if (!Array.isArray(bets) || !bets.length) return null;

  const scorelines = buildScorelines(bets);
  const overUnder = buildOverUnder(bets);
  const btts = buildBtts(bets);
  const totalGoals = buildTotalGoals(bets);
  const home = buildTeamGoals(bets, BET.HOME_EXACT_GOALS);
  const away = buildTeamGoals(bets, BET.AWAY_EXACT_GOALS);
  const teamGoals = (home || away) ? { home, away } : null;

  const out = {};
  if (scorelines?.length) out.scorelines = scorelines;
  if (overUnder) out.overUnder = overUnder;
  if (btts) out.btts = btts;
  if (totalGoals?.length) out.totalGoals = totalGoals;
  if (teamGoals) out.teamGoals = teamGoals;

  return Object.keys(out).length ? out : null;
}

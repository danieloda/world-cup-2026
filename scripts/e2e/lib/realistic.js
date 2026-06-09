// Modelo de palpite "humano" (realista) — para SEEDS DE DEMO, não para os testes
// de scoring (que usam strategies determinísticas em lib/predictions.js).
//
// Diferença-chave: aqui o palpite nasce da FORÇA dos times (FIFA rank), INDEPENDENTE
// do resultado real, e um `skill` por usuário (0..1) aproxima o palpite da realidade
// SEM nunca cravar tudo. Resultado: um ranking com spread crível (casuais embaixo,
// feras em cima, ninguém perfeito) — "como se fossem pessoas normais".

// Poisson clampada → gols esperados pequenos e plausíveis (0..5).
function samplePoisson(lambda, rng) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L && k < 9);
  return Math.min(5, k - 1);
}

// Força 0..1 a partir do FIFA rank (1 = mais forte). Sem rank → meia-tabela.
export function teamStrength(rank) {
  const r = rank && rank > 0 ? rank : 30;
  return Math.max(0.12, Math.min(1, 1 - (r - 1) / 55));
}

// Sinal do resultado: 1 casa avança/vence, -1 fora, 0 empate puro (só grupo).
function outcomeSign(h, a, pen) {
  if (h > a) return 1;
  if (a > h) return -1;
  return pen === 'home' ? 1 : pen === 'away' ? -1 : 0;
}

// Placar plausível com um dado sinal (1 casa, -1 fora, 0 empate), via reamostragem.
function scoreForSign(sign, lamH, lamA, rng) {
  for (let t = 0; t < 10; t++) {
    const h = samplePoisson(lamH, rng);
    const a = samplePoisson(lamA, rng);
    if (Math.sign(h - a) === sign) return [h, a];
  }
  if (sign > 0) { const g = Math.max(1, Math.round(lamH)); return [g, Math.max(0, g - 1)]; }
  if (sign < 0) { const g = Math.max(1, Math.round(lamA)); return [Math.max(0, g - 1), g]; }
  const d = Math.min(3, Math.max(0, Math.round((lamH + lamA) / 2)));
  return [d, d];
}

/**
 * Gera 1 palpite humano para um jogo.
 * @param {string} stage  'group' | 'r32' | 'r16' | ...
 * @param {object} actual { actual_home, actual_away, pen_winner }
 * @param {number} rankH  FIFA rank do mandante (do oráculo já resolvido)
 * @param {number} rankA  FIFA rank do visitante
 * @param {number} skill  0..1 — quão perto da realidade o palpiteiro chega
 * @param {function} rng  PRNG determinístico
 */
export function genRealisticPrediction(stage, actual, rankH, rankA, skill, rng) {
  const isKO = stage !== 'group';
  const sH = teamStrength(rankH), sA = teamStrength(rankA);
  const tot = sH + sA || 1;
  // gols esperados: leve viés de mando + escala pela força relativa.
  const lamH = 0.75 + 2.0 * (sH / tot);
  const lamA = 0.70 + 2.0 * (sA / tot);

  // 1) palpite "de força" (independe do resultado real).
  let ph = samplePoisson(lamH, rng);
  let pa = samplePoisson(lamA, rng);

  // 2) nudge de skill: com prob=skill, alinha o RESULTADO (vencedor/empate) ao real.
  const realSign = outcomeSign(actual.actual_home, actual.actual_away, actual.pen_winner);
  const want = isKO ? (realSign === 0 ? 0 : realSign) : realSign; // KO: pen vira casa/fora
  if (rng() < skill && Math.sign(ph - pa) !== want) {
    [ph, pa] = scoreForSign(want, lamH, lamA, rng);
  }

  // 3) crava o placar EXATO de vez em quando — mais provável (mas nunca certo) p/ feras.
  if (rng() < 0.20 * skill * skill) { ph = actual.actual_home; pa = actual.actual_away; }

  // 4) pênaltis no KO empatado: com skill, acerta o lado; senão, chuta.
  let pen = null;
  if (isKO && ph === pa) {
    pen = (rng() < skill && actual.pen_winner) ? actual.pen_winner : (rng() < 0.5 ? 'home' : 'away');
  }
  return { pred_home: ph, pred_away: pa, pred_pen_winner: isKO ? pen : null };
}

/**
 * Palpite de campeão: favorito ponderado por força; com prob ~skill (e se favorito),
 * acerta o campeão real. Nunca todo mundo no mesmo time.
 * @param {Array} contenders [{ team, rank }] — top times do torneio
 */
export function genRealisticChampion(contenders, actualChampion, skill, rng) {
  if (!contenders.length) return null;
  if (rng() < (0.25 + 0.45 * skill) && contenders.some((c) => c.team === actualChampion)) {
    return actualChampion;
  }
  const pool = contenders.map((c) => [c.team, teamStrength(c.rank)]);
  const total = pool.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [team, w] of pool) { if ((r -= w) <= 0) return team; }
  return pool[0][0];
}

/**
 * Palpite de artilheiro: atacante de time forte (ponderado); com prob ~skill acerta
 * o artilheiro real.
 * @param {Array} strikers [{ id, team, rank }] — atacantes dos times fortes
 */
export function genRealisticScorer(strikers, actualTop, skill, rng) {
  if (actualTop && rng() < (0.18 + 0.40 * skill)) return actualTop.player_id;
  if (!strikers.length) return null;
  const pool = strikers.map((s) => [s.id, teamStrength(s.rank)]);
  const total = pool.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [id, w] of pool) { if ((r -= w) <= 0) return id; }
  return pool[0][0];
}

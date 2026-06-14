// ============================================================
// Helpers compartilhados dos gráficos de evolução do ranking
// (rank-chart no Ranking, journey-chart no Início)
// ============================================================
import { escapeHtml, getInitials, stageLabel, localDateKey, formatBrDate, formatTime, flag, teamPt } from './util.js';

export const ME_COLOR = '#f4c430';
export const PALETTE = [
  '#1DB954', '#4aa3ff', '#f15e6c', '#b07cff', '#ff9f43', '#2dd4bf',
  '#ff6fb5', '#9ccc65', '#7e9cff', '#ffa94d', '#5ad1c9', '#c98cff',
  '#67b7ff', '#ff7a7a', '#74c0fc', '#ffd54a', '#63e6be', '#e599f7',
];

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Cor estável por jogador (ordem = ranking final). "Você" sempre amarelo. */
export function buildColorMap(series, meId) {
  const map = new Map();
  series.forEach((s, i) => {
    map.set(s.userId, s.userId === meId ? ME_COLOR : PALETTE[i % PALETTE.length]);
  });
  return map;
}

/**
 * Posição (1-based) de cada série após cada jogo, por replay dos pontos.
 * Empate: quem termina melhor no ranking final (menor índice) fica acima —
 * estável, igual ao desempate visual da tabela.
 */
export function computePositions(series) {
  const steps = (series[0]?.values.length ?? 1) - 1;
  const pos = series.map(() => new Array(steps));
  for (let s = 0; s < steps; s++) {
    const col = series.map((sr, i) => ({ i, pts: sr.values[s + 1] ?? 0 }));
    col.sort((a, b) => b.pts - a.pts || a.i - b.i);
    col.forEach((e, rank) => { pos[e.i][s] = rank + 1; });
  }
  return pos;
}

/**
 * Janela de "ruído dos primeiros jogos": enquanto o usuário ainda está num bolo
 * de empate grande (≥ metade do bolão com a mesma pontuação), a posição dele é
 * só o desempate (ordem do ranking final), não algo conquistado. Devolve o
 * índice do PRIMEIRO jogo em que ele já se separou do pelotão — daí pra frente
 * as estatísticas (melhor/pior/arrancada/tombo) e as anotações do gráfico valem.
 *
 * Adaptativo, mas nunca pula MAIS que o teto antigo (6 jogos): só RELAXA o corte
 * quando a separação acontece cedo. O corte fixo de 6 descartava picos já
 * decididos por PONTOS (ex.: 5º no 4º jogo, com 20 pt — longe de qualquer empate).
 *
 * @param {Array<{values:number[]}>} series  séries do replay (values[g+1] = pts após o jogo g)
 * @param {number} meIdx  índice da série do usuário
 * @returns {number} índice (0-based) do 1º jogo "real"
 */
export function firstMeaningfulGame(series, meIdx) {
  const N = series.length;
  const me = series[meIdx];
  const GAMES = (me?.values.length ?? 1) - 1;
  const cap = Math.min(6, Math.max(0, GAMES - 2));   // teto antigo, vira só salvaguarda
  if (N === 0 || !me) return cap;
  const bigTie = Math.max(2, Math.floor(N / 2));     // "bolo de empate" = metade do bolão
  for (let g = 0; g < GAMES; g++) {
    const my = me.values[g + 1] ?? 0;
    let tied = 0;
    for (const s of series) if ((s.values[g + 1] ?? 0) === my) tied++;
    if (tied < bigTie) return Math.min(g, cap);      // já saiu do pelotão → daqui conta
  }
  return cap;                                         // empate persistente → teto antigo
}

/**
 * Modelo de tempo a partir dos jogos reais (datas no fuso de Brasília):
 *  - dayOfGame[g]  → índice do dia
 *  - dayEnds[d]    → índice do ÚLTIMO jogo do dia d
 *  - weekEnds[w]   → índice do último jogo da semana w (semanas de 7 dias a
 *                    partir do 1º dia de jogo; a última é a corrente, parcial)
 *  - weekRange(w)  → "11–17/jun" (rótulo humano do intervalo)
 */
export function buildTimeline(matches) {
  const dayKeys = [];
  const dayOfGame = new Array(matches.length);
  matches.forEach((m, g) => {
    const k = localDateKey(m.match_date);
    if (dayKeys.length === 0 || dayKeys[dayKeys.length - 1] !== k) dayKeys.push(k);
    dayOfGame[g] = dayKeys.length - 1;
  });
  const dayEnds = [];
  dayOfGame.forEach((d, g) => { dayEnds[d] = g; });

  // dias corridos desde o 1º dia de jogo (chaves yyyy-mm-dd → UTC, TZ-indep)
  const utcOf = (k) => { const [y, mo, d] = k.split('-').map(Number); return Date.UTC(y, mo - 1, d); };
  const day0 = utcOf(dayKeys[0]);
  const weekOfDay = dayKeys.map(k => Math.floor((utcOf(k) - day0) / 86400000 / 7));
  const weekEnds = [];
  dayEnds.forEach((g, d) => { weekEnds[weekOfDay[d]] = g; });

  const shortDate = (k) => { const [, mo, d] = k.split('-').map(Number); return `${d}/${mo}`; };
  const weekRange = (w) => {
    const ds = dayKeys.filter((_, d) => weekOfDay[d] === w);
    return ds.length ? `${shortDate(ds[0])}–${shortDate(ds[ds.length - 1])}` : '';
  };
  return { dayOfGame, dayEnds, weekEnds, weekRange, dayLabel: (d) => shortDate(dayKeys[d]) };
}

/**
 * Faixas de fase no fundo do plot: runs contíguos de mesma fase entre os
 * jogos amostrados. Devolve [{x, w, label}] — borda no meio do caminho entre
 * etapas vizinhas.
 */
export function stageBands(matches, steps, xAt, x0, x1) {
  if (steps.length === 0) return [];
  const labelOf = (g) => stageLabel(matches[g]?.stage ?? 'group');
  const bands = [];
  let runStart = 0;
  for (let k = 1; k <= steps.length; k++) {
    if (k < steps.length && labelOf(steps[k]) === labelOf(steps[runStart])) continue;
    const left = runStart === 0 ? x0 : (xAt(runStart - 1) + xAt(runStart)) / 2;
    const right = k === steps.length ? x1 : (xAt(k - 1) + xAt(k)) / 2;
    bands.push({ x: left, w: right - left, label: labelOf(steps[runStart]) });
    runStart = k;
  }
  return bands;
}

const escAttr = (s) => String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Avatar em SVG na ponta da linha: foto recortada em círculo (se houver) ou
 * iniciais — sempre com anel na cor do jogador. `uid` precisa ser único na
 * página (id do clipPath).
 */
export function avatarSvgAt(s, color, x, y, r, uid) {
  const ring = `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-width="2"/>`;
  if (s.avatar_url) {
    return `<g>
      <clipPath id="avc-${uid}"><circle cx="${x}" cy="${y}" r="${r - 1}"/></clipPath>
      <circle cx="${x}" cy="${y}" r="${r}" fill="var(--card-elev)"/>
      <image href="${escAttr(s.avatar_url)}" x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}"
             preserveAspectRatio="xMidYMid slice" clip-path="url(#avc-${uid})"/>
      ${ring}
    </g>`;
  }
  return `<g>
    <circle cx="${x}" cy="${y}" r="${r}" fill="var(--card-elev)"/>
    <text x="${x}" y="${y + 3}" text-anchor="middle" fill="${color}"
          style="font: 800 ${Math.round(r * 0.85)}px var(--font)">${escapeHtml(getInitials(s.name))}</text>
    ${ring}
  </g>`;
}

/** Cabeçalho de tooltip com a partida: data · hora · fase + confronto e placar. */
export function matchHeader(m) {
  const phase = m.stage === 'group'
    ? `Grupo ${escapeHtml(m.group_name ?? '')}`
    : escapeHtml(stageLabel(m.stage));
  const hasScore = m.actual_home != null && m.actual_away != null;
  const score = hasScore ? `${m.actual_home}<span class="x">–</span>${m.actual_away}` : '×';
  return `
    <div class="rc-tip-when">${escapeHtml(formatBrDate(new Date(m.match_date)))} · ${escapeHtml(formatTime(m.match_date))} · ${phase}</div>
    <div class="rc-tip-match">
      ${flag(m.team_home)}
      <span class="rc-tip-tm">${escapeHtml(teamPt(m.team_home))}</span>
      <span class="rc-tip-sc">${score}</span>
      <span class="rc-tip-tm">${escapeHtml(teamPt(m.team_away))}</span>
      ${flag(m.team_away)}
    </div>
  `;
}

/** Posiciona o tooltip dentro do host, fugindo da borda direita. */
export function placeTip(host, tip, clientX) {
  const pb = host.getBoundingClientRect();
  const relX = clientX - pb.left;
  const tw = tip.offsetWidth || 180;
  let left = relX + 14;
  if (left + tw > pb.width) left = relX - tw - 14;
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = '8px';
}

/** clientX/Y unificado mouse + touch. */
export function pointXY(e) {
  return e.touches?.length
    ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
    : { x: e.clientX, y: e.clientY };
}

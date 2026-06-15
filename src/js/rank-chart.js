// ============================================================
// Evolução do ranking (tela Ranking) — v2
// ============================================================
// SVG puro, sem dependências. Recebe séries de PONTOS acumulados por jogo
// (ver loadProgression em progression.js), ranqueia em cada etapa por replay
// pra obter a POSIÇÃO, e desenha a trajetória do foco.
//
// Decisões (2026-06-15, aprovadas em protótipo):
//  • Altura DINÂMICA: o gráfico só cresce com quantos jogadores estão no foco
//    (poucos → baixinho). A altura sai do nº de selecionados, não do span.
//  • Rótulos = hover: no DESKTOP os nomes saem de cima das linhas pra um PAINEL
//    à direita que É o hover — em repouso mostra a classificação atual; ao passar
//    o mouse vira o jogo sob o cursor (reordena, pontos, destaca a linha). Sem
//    tooltip flutuante, sem rótulo cobrindo linha.
//  • MOBILE: linha-espaguete não cabe; vira uma lista de SPARKLINES (uma mini
//    trajetória por jogador + posição + seta de subiu/caiu).
// Tempo em dois zooms: "Por semana" (Copa inteira) e "Jogos da semana" (só a
// semana corrente, jogo a jogo). Foco livre via legenda; chips = reset.

import { escapeHtml, avatarHtml } from './util.js';
import {
  computePositions, buildTimeline, stageBands, buildColorMap,
  matchHeader, pointXY, clamp,
} from './chart-utils.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NARROW = 560;          // abaixo disso → layout mobile (sparklines)
const PAN_ROW = 34;          // altura de uma linha do painel (desktop)

const IC = {
  trophy: '<svg class="rc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a3 3 0 0 0 3 3M17 6h3a3 3 0 0 1-3 3"/></svg>',
  list: '<svg class="rc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
};

/**
 * @param {HTMLElement} mount
 * @param {{series:Array, matches:Array, meId:string}} opts
 */
export function renderRankChart(mount, { series, matches, meId }) {
  const N = series.length;
  const GAMES = matches.length;
  if (N === 0 || GAMES === 0) { mount.innerHTML = ''; return; }

  const pos = computePositions(series);
  const tl = buildTimeline(matches);
  const colorMap = buildColorMap(series, meId);
  const colorOf = (i) => colorMap.get(series[i].userId);
  const finalPos = (i) => pos[i][GAMES - 1];
  const finalPts = (i) => series[i].values[GAMES] ?? 0;
  const meIdx = series.findIndex(s => s.userId === meId);
  const byId = new Map(series.map((s, i) => [s.userId, i]));

  const canWeek = tl.weekEnds.length >= 2;
  const lastWeek = tl.weekEnds.length - 1;
  const curWeekStart = lastWeek === 0 ? 0 : tl.weekEnds[lastWeek - 1] + 1;
  const curWeekSteps = [];
  for (let g = curWeekStart; g < GAMES; g++) curWeekSteps.push(g);

  const presetSet = (p) => {
    const f = new Set(series.slice(0, p === 'podio' ? 3 : 10).map(s => s.userId));
    if (meIdx >= 0) f.add(meId);
    return f;
  };
  const setsEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

  let granKey = canWeek ? 'semana' : 'jogo';
  let selected = presetSet('podio');
  let showAllLeg = false;

  function avatarChip(s, extra = '') {
    return `<span class="rc-av ${extra}" style="border-color:${colorMap.get(s.userId)}">${avatarHtml({ full_name: s.name, avatar_url: s.avatar_url })}</span>`;
  }

  // altura dinâmica do gráfico (desktop): ∝ nº de selecionados
  const dynH = (n) => clamp(Math.round(70 + 26 * n), 170, 560);

  mount.innerHTML = `
    <div class="rc-head">
      <div class="rc-presets" role="group" aria-label="Seleção rápida de jogadores">
        <button class="rc-chip" data-p="podio">${IC.trophy}Pódio + Você</button>
        <button class="rc-chip" data-p="top10">${IC.list}Top 10</button>
      </div>
      <div class="rc-seg" role="group" aria-label="Granularidade do tempo">
        <button data-g="semana" ${canWeek ? '' : 'disabled title="Disponível a partir da 2ª semana da Copa"'}>Por semana</button>
        <button data-g="jogo">Jogos da semana</button>
      </div>
    </div>
    <div class="rc-body"></div>
    <div class="rc-legend"></div>
    <p class="rc-note"></p>
  `;

  draw();
  attachStatic();
  let raf = 0;
  window.addEventListener('resize', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); });

  // ---------------------------------------------------------
  function draw() {
    const body = mount.querySelector('.rc-body');
    const width = Math.max(280, body.clientWidth || mount.clientWidth || 900);
    if (width < NARROW) drawMobile(body);
    else drawDesktop(body, width);
    renderLegend();
    renderNote();
  }

  // ===== DESKTOP: gráfico enxuto + painel vivo (= rótulos = hover) =====
  function drawDesktop(body, width) {
    const ids = [...selected].map(uid => byId.get(uid)).filter(i => i != null).sort((a, b) => finalPos(a) - finalPos(b));
    const steps = granKey === 'jogo' ? curWeekSteps : tl.weekEnds;
    const K = steps.length;
    const n = ids.length;

    const panW = width < 720 ? 210 : 248;
    const chartW = Math.max(220, width - panW - 16);
    const H = dynH(n);
    const PADl = 32, PADr = 12, PADt = 16, PADb = 22;
    const plotH = H - PADt - PADb;

    // faixa de posições do foco (zoom no foco)
    let rLo = 1, rHi = N;
    if (n) {
      rLo = Infinity; rHi = -Infinity;
      ids.forEach(i => { for (const gi of steps) { const p = pos[i][gi]; if (p < rLo) rLo = p; if (p > rHi) rHi = p; } });
      rLo = Math.max(1, rLo - 1); rHi = Math.min(N, rHi + 1);
      if (rHi - rLo < 2) rHi = Math.min(N, rLo + 2);
    }
    const span = Math.max(1, rHi - rLo);
    const x0 = PADl + 4, x1 = chartW - PADr;
    const xAt = (k) => K <= 1 ? x1 : x0 + (x1 - x0) * (k / (K - 1));
    const yAt = (p) => PADt + (p - rLo) / span * plotH;

    let g = '';
    stageBands(matches, steps, xAt, x0, x1).forEach((b, bi) => {
      if (bi % 2 === 1) g += `<rect class="rc-band" x="${b.x.toFixed(1)}" y="${PADt - 14}" width="${b.w.toFixed(1)}" height="${plotH + 14}"/>`;
      if (b.w > 64) g += `<text class="rc-band-lbl" x="${(b.x + b.w / 2).toFixed(1)}" y="${PADt - 5}" text-anchor="middle">${escapeHtml(b.label)}</text>`;
    });
    const yStep = Math.max(1, Math.ceil(span / 6));
    for (let p = rLo; p <= rHi; p += yStep) {
      g += `<line class="rc-grid" x1="${x0}" y1="${yAt(p).toFixed(1)}" x2="${x1}" y2="${yAt(p).toFixed(1)}"/>`;
      g += `<text class="rc-ylbl" x="${PADl - 4}" y="${(yAt(p) + 4).toFixed(1)}" text-anchor="end">${p}º</text>`;
    }
    const tight = chartW < 380;
    const nx = granKey === 'semana' ? K : Math.min(tight ? 4 : 6, K);
    for (let k0 = 0; k0 < nx; k0++) {
      const k = nx <= 1 ? K - 1 : Math.round(k0 * (K - 1) / (nx - 1));
      const anchor = k0 === 0 ? 'start' : k0 === nx - 1 ? 'end' : 'middle';
      const lbl = granKey === 'jogo'
        ? (tight ? `J${steps[k] + 1}` : `Jogo ${steps[k] + 1}`)
        : (tight ? `S${k + 1}` : `Semana ${k + 1}`);
      g += `<text class="rc-xlbl" x="${xAt(k).toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="${anchor}">${lbl}</text>`;
    }

    let foc = '';
    const lineOf = (i) => steps.map((gi, k) => `${xAt(k).toFixed(1)},${yAt(pos[i][gi]).toFixed(1)}`).join(' ');
    ids.forEach(i => {
      foc += `<polyline class="rc-foc${series[i].userId === meId ? ' me' : ''}" data-i="${i}" stroke="${colorOf(i)}" style="--glow:${colorOf(i)}" points="${lineOf(i)}"/>`;
    });

    body.className = 'rc-body rc-main';
    body.style.gridTemplateColumns = `1fr ${panW}px`;
    body.innerHTML = `
      <div class="rc-chartwrap">
        <svg class="rc-svg" width="${chartW}" height="${H}" viewBox="0 0 ${chartW} ${H}" role="img"
             aria-label="Evolução da posição no ranking ao longo da Copa">
          ${g}
          <g>${foc}</g>
          <line class="rc-cross" x1="0" y1="${PADt}" x2="0" y2="${(PADt + plotH).toFixed(1)}" hidden/>
          <g class="rc-hover"></g>
          <rect class="rc-hit" x="${x0}" y="${PADt}" width="${Math.max(0, x1 - x0)}" height="${plotH}" fill="transparent"/>
        </svg>
      </div>
      <div class="rc-panel">
        <div class="rc-pan-h"></div>
        <div class="rc-pan-list" style="height:${n * PAN_ROW}px"></div>
      </div>
    `;

    const panRows = buildPanel(body, ids);
    updatePanel(panRows, ids, GAMES - 1, -1, false);
    attachHover(body, { steps, K, xAt, yAt, x0, x1, H, plotH, PADt, rowH: plotH / span, ids, panRows });
  }

  // painel persistente — cria as linhas uma vez por draw, depois só reposiciona
  function buildPanel(body, ids) {
    const list = body.querySelector('.rc-pan-list');
    const rows = new Map();
    ids.forEach(i => {
      const el = document.createElement('div');
      el.className = 'rc-pan-row';
      el.dataset.i = i;
      list.appendChild(el);
      rows.set(i, el);
    });
    return rows;
  }

  function updatePanel(rows, ids, gi, hotI, hovering) {
    const order = [...ids].sort((a, b) => pos[a][gi] - pos[b][gi]);
    order.forEach((i, r) => {
      const el = rows.get(i);
      if (!el) return;
      el.style.top = `${r * PAN_ROW}px`;
      el.style.borderColor = colorOf(i);
      el.classList.toggle('hot', hovering && i === hotI);
      const nm = series[i].userId === meId ? 'Você' : series[i].name;
      el.innerHTML = `
        <span class="rc-pan-pos">${pos[i][gi]}º</span>
        ${avatarChip(series[i], 'sm')}
        <span class="rc-pan-nm" style="color:${i === hotI && hovering ? colorOf(i) : 'var(--text)'}">${escapeHtml(nm)}</span>
        <span class="rc-pan-pt" style="color:${colorOf(i)}">${series[i].values[gi + 1] ?? 0}</span>`;
    });
    const h = mount.querySelector('.rc-pan-h');
    if (h) {
      const k = granKey === 'jogo' ? curWeekSteps.indexOf(gi) : tl.weekEnds.indexOf(gi);
      h.innerHTML = hovering
        ? (granKey === 'jogo'
            ? `<span class="rc-pan-k">Jogo ${gi + 1}</span>${matchHeader(matches[gi])}`
            : `<span class="rc-pan-k">Semana ${k + 1} · ${tl.weekRange(k)}</span>`)
        : `<span class="rc-pan-k">Classificação atual</span><span class="rc-pan-hint">passe o mouse no gráfico →</span>`;
    }
  }

  function attachHover(body, geo) {
    const svg = body.querySelector('.rc-svg');
    const hit = body.querySelector('.rc-hit');
    const cross = body.querySelector('.rc-cross');
    const hover = body.querySelector('.rc-hover');
    if (!svg || !hit) return;
    const focLines = svg.querySelectorAll('.rc-foc');
    const setHot = (i) => focLines.forEach(pl => {
      const on = +pl.dataset.i === i && i >= 0;
      pl.classList.toggle('hot', on);
      pl.classList.toggle('dim', i >= 0 && !on);
    });

    function move(e) {
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const { x: cx, y: cy } = pointXY(e);
      const vw = svg.viewBox.baseVal.width || box.width;
      const vh = svg.viewBox.baseVal.height || box.height;
      const xv = (cx - box.left) / box.width * vw;
      const yv = (cy - box.top) / box.height * vh;
      const k = clamp(Math.round((xv - geo.x0) / Math.max(1, geo.x1 - geo.x0) * (geo.K - 1)), 0, Math.max(0, geo.K - 1));
      const gi = geo.steps[k];
      const xpx = geo.xAt(k);

      cross.removeAttribute('hidden');
      cross.setAttribute('x1', xpx.toFixed(1));
      cross.setAttribute('x2', xpx.toFixed(1));

      let hotI = -1, hotD = Infinity;
      geo.ids.forEach(i => { const d = Math.abs(geo.yAt(pos[i][gi]) - yv); if (d < hotD) { hotD = d; hotI = i; } });
      if (hotD > geo.rowH * 1.1 + 6) hotI = -1;
      setHot(hotI);

      while (hover.firstChild) hover.removeChild(hover.firstChild);
      geo.ids.forEach(i => {
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', xpx.toFixed(1));
        c.setAttribute('cy', geo.yAt(pos[i][gi]).toFixed(1));
        c.setAttribute('r', i === hotI ? 5 : (series[i].userId === meId ? 4 : 3.2));
        c.setAttribute('fill', colorOf(i));
        c.setAttribute('class', i === hotI ? 'rc-hdot hot' : 'rc-hdot');
        if (i === hotI) c.style.setProperty('--glow', colorOf(i));
        hover.appendChild(c);
      });

      updatePanel(geo.panRows, geo.ids, gi, hotI, true);
    }

    function leave() {
      cross.setAttribute('hidden', '');
      while (hover.firstChild) hover.removeChild(hover.firstChild);
      setHot(-1);
      updatePanel(geo.panRows, geo.ids, GAMES - 1, -1, false);
    }

    hit.addEventListener('mousemove', move);
    hit.addEventListener('mouseleave', leave);
    hit.addEventListener('touchstart', move, { passive: true });
    hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('touchend', leave);
  }

  // ===== MOBILE: lista de sparklines (uma trajetória por jogador) =====
  function drawMobile(body) {
    const ids = [...selected].map(uid => byId.get(uid)).filter(i => i != null).sort((a, b) => finalPos(a) - finalPos(b));
    const steps = granKey === 'jogo' ? curWeekSteps : tl.weekEnds;
    const K = steps.length;

    body.className = 'rc-body rc-sparks';
    body.style.gridTemplateColumns = '';
    if (ids.length === 0) { body.innerHTML = ''; return; }

    body.innerHTML = ids.map(i => {
      const c = colorOf(i);
      const nm = series[i].userId === meId ? 'Você' : series[i].name;
      const ps = steps.map(gi => pos[i][gi]);
      const lo = Math.min(...ps), hi = Math.max(...ps);
      const W = 92, Hs = 30, pad = 3;
      const xA = (k) => K <= 1 ? W / 2 : pad + (W - 2 * pad) * k / (K - 1);
      const yA = (p) => hi === lo ? Hs / 2 : pad + (Hs - 2 * pad) * (p - lo) / (hi - lo);  // 1º no topo
      const pts = ps.map((p, k) => `${xA(k).toFixed(1)},${yA(p).toFixed(1)}`).join(' ');
      const now = ps[K - 1], then = ps[0];
      const d = then - now;                       // subiu = positivo
      const sparkC = series[i].userId === meId ? c : d > 0 ? 'var(--positive)' : d < 0 ? 'var(--red)' : '#8a8a8e';
      const dCls = d > 0 ? 'up' : d < 0 ? 'dn' : 'eq';
      const dTxt = d > 0 ? `▲ ${d}` : d < 0 ? `▼ ${-d}` : '–';
      return `
        <div class="rc-spark-row${series[i].userId === meId ? ' me' : ''}">
          <span class="rc-spark-pos" style="color:${c}">${pos[i][GAMES - 1]}º</span>
          ${avatarChip(series[i], 'sm')}
          <div class="rc-spark-nm">${escapeHtml(nm)}<small>${finalPts(i)} pts</small></div>
          <svg class="rc-spark-svg" width="${W}" height="${Hs}" viewBox="0 0 ${W} ${Hs}" aria-hidden="true">
            <polyline fill="none" stroke="${sparkC}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>
            <circle cx="${xA(K - 1).toFixed(1)}" cy="${yA(now).toFixed(1)}" r="2.6" fill="${sparkC}"/>
          </svg>
          <span class="rc-spark-d ${dCls}">${dTxt}</span>
        </div>`;
    }).join('');
  }

  // ---------------------------------------------------------
  function renderLegend() {
    const topIds = series.slice(0, 14).map(s => s.userId);
    if (meIdx >= 0) topIds.push(meId);
    const ids = showAllLeg
      ? series.map(s => s.userId)
      : [...new Set([...topIds, ...selected])];
    mount.querySelector('.rc-legend').innerHTML = ids
      .map(uid => byId.get(uid)).filter(i => i != null).sort((a, b) => a - b)
      .map(i => {
        const s = series[i];
        const on = selected.has(s.userId);
        const nm = s.userId === meId ? 'Você' : s.name;
        return `
          <button class="rc-leg ${on ? 'active' : ''}" data-user="${s.userId}" aria-pressed="${on}"
                  title="${escapeHtml(s.name)}" style="${on ? `border-color:${colorOf(i)}` : ''}">
            ${avatarChip(s, 'sm')}
            <span class="rc-nm" style="${on ? `color:${colorOf(i)}` : ''}">${finalPos(i)}º ${escapeHtml(nm)}</span>
            <span class="rc-pt">${finalPts(i)} pts</span>
          </button>`;
      }).join('') +
      `<button class="rc-leg rc-leg-all" data-action="toggle-all" aria-expanded="${showAllLeg}">
        ${showAllLeg ? '− mostrar menos' : `+ todos (${N})`}
      </button>`;

    mount.querySelectorAll('.rc-presets .rc-chip').forEach(b =>
      b.classList.toggle('active', setsEq(selected, presetSet(b.dataset.p))));
    mount.querySelectorAll('.rc-seg button').forEach(b => {
      const on = b.dataset.g === granKey;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    });

    mount.querySelectorAll('.rc-leg[data-user]').forEach(btn => btn.addEventListener('click', () => {
      const uid = btn.dataset.user;
      if (selected.has(uid)) selected.delete(uid); else selected.add(uid);
      draw();
    }));
    mount.querySelector('[data-action="toggle-all"]').addEventListener('click', () => {
      showAllLeg = !showAllLeg;
      draw();
    });
  }

  function renderNote() {
    const narrow = (mount.querySelector('.rc-body')?.clientWidth || 999) < NARROW;
    mount.querySelector('.rc-note').textContent =
      selected.size === 0
        ? 'Ninguém selecionado — clique num nome abaixo ou use Pódio + Você / Top 10 pra recomeçar.'
        : narrow
        ? (granKey === 'semana'
            ? 'Uma mini-trajetória por jogador, semana a semana. ▲/▼ = posições que subiu/caiu. Toque num nome abaixo pra ligar/desligar.'
            : `Mini-trajetória de cada um na semana atual (${tl.weekRange(lastWeek)}). ▲/▼ = subiu/caiu. Toque num nome pra ligar/desligar.`)
        : granKey === 'semana'
        ? 'Uma etapa por semana. Passe o mouse: o painel à direita vira o jogo apontado. Clique num nome pra ligar/desligar.'
        : `Jogo a jogo da semana atual (${tl.weekRange(lastWeek)}) — passe o mouse pra ver cada partida no painel.`;
  }

  function attachStatic() {
    mount.querySelectorAll('.rc-presets .rc-chip').forEach(b => b.addEventListener('click', () => {
      selected = presetSet(b.dataset.p);
      draw();
    }));
    mount.querySelectorAll('.rc-seg button').forEach(b => b.addEventListener('click', () => {
      if (b.disabled || b.dataset.g === granKey) return;
      granKey = b.dataset.g;
      draw();
    }));
  }
}

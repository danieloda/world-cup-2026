// ============================================================
// Bump focado — evolução do ranking (tela Ranking)
// ============================================================
// SVG puro, sem dependências. Recebe as séries de PONTOS acumulados por jogo
// (ver loadProgression em progression.js) e ranqueia em cada etapa pra obter
// a POSIÇÃO — tudo reconstruído por replay, sem snapshots.
//
// Anti-espaguete (decisão 2026-06-09): o pelotão inteiro vira contexto cinza
// e só um recorte ganha cor. A seleção é LIVRE (legenda liga/desliga qualquer
// um, inclusive Você); os chips "Pódio + Você" / "Top 10" são só reset.
// Tempo em dois zooms: "Por semana" (Copa inteira, 1 etapa por semana) e
// "Jogos da semana" (jogo a jogo, SÓ a semana corrente). Com menos de 2
// semanas de jogos, abre direto em "Jogos da semana" (semana 1 = tudo).

import { escapeHtml, avatarHtml } from './util.js';
import {
  computePositions, buildTimeline, stageBands, buildColorMap, avatarSvgAt,
  matchHeader, placeTip, pointXY, clamp,
} from './chart-utils.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

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

  // semanas: a última é a corrente (parcial); com <2 semanas não há o que
  // desenhar "por semana" → trava em "Jogos da semana"
  const canWeek = tl.weekEnds.length >= 2;
  const lastWeek = tl.weekEnds.length - 1;
  const curWeekStart = lastWeek === 0 ? 0 : tl.weekEnds[lastWeek - 1] + 1;
  const curWeekSteps = [];
  for (let g = curWeekStart; g < GAMES; g++) curWeekSteps.push(g);

  // Foco 100% livre: um único Set; presets funcionam como RESET.
  const presetSet = (p) => {
    const f = new Set(series.slice(0, p === 'podio' ? 3 : 10).map(s => s.userId));
    if (meIdx >= 0) f.add(meId);
    return f;
  };
  const setsEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

  let granKey = canWeek ? 'semana' : 'jogo';
  let selected = presetSet('podio');
  let showAllLeg = false;

  // Avatar (foto ou iniciais) com borda na cor do jogador — legenda/tooltip.
  function avatarChip(s, extra = '') {
    return `<span class="rc-av ${extra}" style="border-color:${colorMap.get(s.userId)}">${avatarHtml({ full_name: s.name, avatar_url: s.avatar_url })}</span>`;
  }

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
    <div class="rc-plot"></div>
    <div class="rc-legend"></div>
    <p class="rc-note"></p>
  `;

  draw();
  attachStatic();
  window.addEventListener('resize', onResize);
  let raf = 0;
  function onResize() { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }

  // ---------------------------------------------------------
  function draw() {
    const steps = granKey === 'jogo' ? curWeekSteps : tl.weekEnds;
    const K = steps.length;
    const host = mount.querySelector('.rc-plot');
    const width = Math.max(280, host.clientWidth || mount.clientWidth || 900);
    const narrow = width < 520;
    const PADl = 40, PADr = narrow ? 108 : 172, PADt = 30, PADb = 30;

    // Eixo Y "zoom no foco": em vez de espremer todo mundo numa escala 1º..Nº
    // (com N≈77 são 6px por posição e o pódio vira um nó), enquadramos só a
    // faixa de posições que os SELECIONADOS percorrem na janela visível — as
    // linhas se abrem pra ocupar a altura toda. Sem seleção, cai na escala cheia.
    let rLo = 1, rHi = N;
    const focusY = selected.size > 0;
    if (focusY) {
      rLo = Infinity; rHi = -Infinity;
      series.forEach((s, i) => {
        if (!selected.has(s.userId)) return;
        for (const gi of steps) { const p = pos[i][gi]; if (p < rLo) rLo = p; if (p > rHi) rHi = p; }
      });
      rLo = Math.max(1, rLo - 1);
      rHi = Math.min(N, rHi + 1);
      if (rHi - rLo < 3) rHi = Math.min(N, rLo + 3);   // piso de altura
    }
    const span = Math.max(1, rHi - rLo);
    const rowH = focusY
      ? clamp(Math.floor(440 / span), 10, 38)
      : (N <= 1 ? 34 : clamp(Math.floor(420 / (N - 1)), 6, 34));
    const plotH = focusY ? span * rowH : (N <= 1 ? 1 : N - 1) * rowH;
    const height = PADt + plotH + PADb;
    const x0 = PADl + 6, x1 = width - PADr;
    const xAt = (k) => K <= 1 ? x1 : x0 + (x1 - x0) * (k / (K - 1));
    const yAt = (p) => PADt + (p - rLo) * rowH;

    let g = '';
    // faixas de fase (alternadas) + rótulos
    stageBands(matches, steps, xAt, x0, x1).forEach((b, bi) => {
      if (bi % 2 === 1) g += `<rect class="rc-band" x="${b.x.toFixed(1)}" y="${PADt - 18}" width="${b.w.toFixed(1)}" height="${plotH + 18}"/>`;
      if (b.w > (narrow ? 34 : 64)) g += `<text class="rc-band-lbl" x="${(b.x + b.w / 2).toFixed(1)}" y="${PADt - 7}" text-anchor="middle">${escapeHtml(b.label)}</text>`;
    });
    // eixo Y + grade horizontal (linha-guia em cada rótulo)
    const yLo = focusY ? rLo : 1, yHi = focusY ? rHi : N;
    const yStep = focusY ? Math.max(1, Math.ceil(span / 12)) : Math.max(1, Math.ceil((N - 1) / 14));
    for (let p = yLo; p <= yHi; p += yStep) {
      g += `<line class="rc-grid" x1="${x0}" y1="${yAt(p).toFixed(1)}" x2="${x1}" y2="${yAt(p).toFixed(1)}"/>`;
      g += `<text class="rc-ylbl" x="${PADl - 2}" y="${(yAt(p) + 4).toFixed(1)}" text-anchor="end">${p}º</text>`;
    }
    // eixo X: semanas mostram todas; jogos, esparso e ancorado nas pontas
    const nx = granKey === 'semana' ? K : Math.min(narrow ? 3 : 6, K);
    for (let k0 = 0; k0 < nx; k0++) {
      const k = nx === 1 ? K - 1 : Math.round(k0 * (K - 1) / (nx - 1));
      const anchor = k0 === 0 ? 'start' : k0 === nx - 1 ? 'end' : 'middle';
      const lbl = granKey === 'jogo'
        ? (narrow ? `J${steps[k] + 1}` : `Jogo ${steps[k] + 1}`)
        : (narrow ? `S${k + 1}` : `Semana ${k + 1}`);
      g += `<text class="rc-xlbl" x="${xAt(k).toFixed(1)}" y="${(height - 9).toFixed(1)}" text-anchor="${anchor}">${lbl}</text>`;
    }

    // linhas: contexto cinza primeiro, foco colorido por cima
    let ctx = '', foc = '', lbls = '';
    const endLabels = [];
    const lineOf = (i) => steps.map((gi, k) => `${xAt(k).toFixed(1)},${yAt(pos[i][gi]).toFixed(1)}`).join(' ');
    series.forEach((s, i) => {
      if (!selected.has(s.userId)) {
        // Com foco ativo o pelotão cinza some — o eixo já enquadra quem importa.
        // Sem ninguém selecionado, mostramos o contexto pra não ficar vazio.
        if (!focusY) ctx += `<polyline class="rc-ctx" points="${lineOf(i)}"/>`;
        return;
      }
      const c = colorOf(i);
      foc += `<polyline class="rc-foc${s.userId === meId ? ' me' : ''}" data-i="${i}" stroke="${c}" style="--glow:${c}" points="${lineOf(i)}"/>`;
      endLabels.push({ i, y: yAt(finalPos(i)), color: c });
    });
    // rótulos de ponta FORA do clip (senão o 1º corta o avatar) + anti-colisão
    endLabels.sort((a, b) => a.y - b.y);
    let prevY = PADt - 14;
    for (const l of endLabels) {
      l.y = Math.max(l.y, prevY + 24);
      prevY = l.y;
      const s = series[l.i];
      const nm = s.userId === meId ? 'Você' : s.name;
      lbls += avatarSvgAt(s, l.color, x1 + 14, l.y, 9, `rk${l.i}`);
      lbls += `<text class="rc-end" x="${x1 + 28}" y="${(l.y + 4).toFixed(1)}" fill="${l.color}">${finalPos(l.i)}º ${escapeHtml(clip(nm, narrow ? 8 : 15))}</text>`;
    }
    const svgH = Math.max(height, (endLabels[endLabels.length - 1]?.y ?? 0) + 18);

    host.innerHTML = `
      <svg class="rc-svg" width="${width}" height="${svgH}" viewBox="0 0 ${width} ${svgH}" role="img"
           aria-label="Evolução da posição no ranking ao longo da Copa">
        <defs><clipPath id="rcclip"><rect x="0" y="${PADt - 3}" width="${width}" height="${plotH + 6}"/></clipPath></defs>
        ${g}
        <g clip-path="url(#rcclip)">${ctx}${foc}</g>
        ${lbls}
        <line class="rc-cross" x1="0" y1="${PADt}" x2="0" y2="${(PADt + plotH).toFixed(1)}" hidden/>
        <g class="rc-hover"></g>
        <rect class="rc-hit" x="${x0}" y="${PADt}" width="${Math.max(0, x1 - x0)}" height="${plotH}" fill="transparent"/>
      </svg>
      <div class="rc-tip" hidden></div>
    `;

    renderLegend();
    renderNote();
    attachHover(host, { steps, K, xAt, yAt, x0, x1, rowH });
  }

  // ---------------------------------------------------------
  function renderLegend() {
    const topIds = series.slice(0, 14).map(s => s.userId);
    if (meIdx >= 0) topIds.push(meId);
    const ids = showAllLeg
      ? series.map(s => s.userId)
      : [...new Set([...topIds, ...selected])];
    const byId = new Map(series.map((s, i) => [s.userId, i]));
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
    mount.querySelector('.rc-note').textContent =
      selected.size === 0
        ? 'Ninguém selecionado — clique num nome abaixo ou use Pódio + Você / Top 10 pra recomeçar.'
        : granKey === 'semana'
        ? 'Uma etapa por semana da Copa. Clique num nome pra ligar/desligar a linha; os botões de cima resetam a seleção.'
        : `Jogo a jogo da semana atual (${tl.weekRange(lastWeek)}) — passe o dedo/mouse pra ver cada partida.`;
  }

  function attachStatic() {
    mount.querySelectorAll('.rc-presets .rc-chip').forEach(b => b.addEventListener('click', () => {
      selected = presetSet(b.dataset.p);   // preset = reset da seleção
      draw();
    }));
    mount.querySelectorAll('.rc-seg button').forEach(b => b.addEventListener('click', () => {
      if (b.disabled || b.dataset.g === granKey) return;
      granKey = b.dataset.g;
      draw();
    }));
  }

  // ---------------------------------------------------------
  function attachHover(host, geo) {
    const svg = host.querySelector('.rc-svg');
    const hit = host.querySelector('.rc-hit');
    const cross = host.querySelector('.rc-cross');
    const hover = host.querySelector('.rc-hover');
    const tip = host.querySelector('.rc-tip');
    if (!svg || !hit) return;

    // Neon no hover: a linha sob o cursor acende (glow na própria cor) e as
    // outras do foco apagam um pouco, pra ela saltar. setHot(-1) reseta.
    const focLines = svg.querySelectorAll('.rc-foc');
    function setHot(i) {
      focLines.forEach(pl => {
        const on = +pl.dataset.i === i && i >= 0;
        pl.classList.toggle('hot', on);
        pl.classList.toggle('dim', i >= 0 && !on);
      });
    }

    function stepAt(clientX) {
      const r = svg.getBoundingClientRect();
      const xv = (clientX - r.left) / r.width * (svg.viewBox.baseVal.width || r.width);
      const t = (geo.x1 - geo.x0) === 0 ? 0 : (xv - geo.x0) / (geo.x1 - geo.x0);
      return clamp(Math.round(t * (geo.K - 1)), 0, Math.max(0, geo.K - 1));
    }

    function move(e) {
      // Mesmo guard do journey-chart: touch órfão após redraw (SVG desanexado,
      // rect zerado) produziria k=NaN/∞ e tooltip de jogo inexistente.
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const { x: cx, y: cy } = pointXY(e);
      const k = stepAt(cx);
      const gi = geo.steps[k];
      const xpx = geo.xAt(k);

      cross.removeAttribute('hidden');
      cross.setAttribute('x1', xpx.toFixed(1));
      cross.setAttribute('x2', xpx.toFixed(1));

      // linha sob o cursor = a mais próxima em Y nesta etapa (dentro de ~1 linha)
      const vh = svg.viewBox.baseVal.height || box.height;
      const yv = (cy - box.top) / box.height * vh;
      let hotI = -1, hotD = Infinity;
      series.forEach((s, i) => {
        if (!selected.has(s.userId)) return;
        const d = Math.abs(geo.yAt(pos[i][gi]) - yv);
        if (d < hotD) { hotD = d; hotI = i; }
      });
      if (hotD > geo.rowH * 1.1 + 6) hotI = -1;   // longe de tudo → ninguém aceso
      setHot(hotI);

      while (hover.firstChild) hover.removeChild(hover.firstChild);
      const rows = [];
      series.forEach((s, i) => {
        if (!selected.has(s.userId)) return;
        rows.push({ s, i, pos: pos[i][gi], pts: s.values[gi + 1] ?? 0 });
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', xpx.toFixed(1));
        c.setAttribute('cy', geo.yAt(pos[i][gi]).toFixed(1));
        c.setAttribute('r', i === hotI ? 6 : (s.userId === meId ? 5 : 4));
        c.setAttribute('fill', colorOf(i));
        c.setAttribute('class', i === hotI ? 'rc-hdot hot' : 'rc-hdot');
        if (i === hotI) c.style.setProperty('--glow', colorOf(i));
        hover.appendChild(c);
      });
      rows.sort((a, b) => a.pos - b.pos);

      const header = granKey === 'jogo'
        ? matchHeader(matches[gi])
        : `<div class="rc-tip-h">Semana ${k + 1} · ${tl.weekRange(k)}</div>`;
      tip.innerHTML = header + rows.map(r => `
        <div class="rc-tip-r${r.i === hotI ? ' hot' : ''}">
          <span class="rc-tip-pos" style="color:${colorOf(r.i)}">${r.pos}º</span>
          ${avatarChip(r.s, 'sm')}
          <span class="rc-tip-nm" style="color:${colorOf(r.i)}">${escapeHtml(r.s.userId === meId ? 'Você' : r.s.name)}</span>
          <span class="rc-tip-pt">${r.pts}</span>
        </div>`).join('');
      tip.hidden = false;
      placeTip(host, tip, cx);
    }

    function leave() {
      cross.setAttribute('hidden', '');
      while (hover.firstChild) hover.removeChild(hover.firstChild);
      setHot(-1);
      tip.hidden = true;
    }

    hit.addEventListener('mousemove', move);
    hit.addEventListener('mouseleave', leave);
    hit.addEventListener('touchstart', move, { passive: true });
    hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('touchend', leave);
  }
}

function clip(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; }

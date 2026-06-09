// ============================================================
// Bump chart da evolução do ranking (posição ao longo do tempo)
// ============================================================
// SVG puro, sem dependências. Recebe a progressão de PONTOS acumulados
// (ver buildProgression em pages/ranking.js) e, em cada etapa (jogo ou dia),
// ranqueia os jogadores por pontos pra obter a POSIÇÃO — não guardamos
// snapshots: tudo é reconstruído por replay.
//
// Cada jogador é uma linha; o eixo Y são as posições (1º no topo). Quando
// uma linha cruza a outra, alguém ultrapassou. Alterna "Por jogo" / "Por dia".

import {
  escapeHtml, avatarHtml, flag, teamPt, stageLabel, formatBrDate, formatTime,
} from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const ME_COLOR = '#f4c430';
const PALETTE = [
  '#1DB954', '#4aa3ff', '#f15e6c', '#b07cff', '#ff9f43', '#2dd4bf',
  '#ff6fb5', '#9ccc65', '#7e9cff', '#ffa94d', '#5ad1c9', '#c98cff',
  '#67b7ff', '#ff7a7a', '#74c0fc', '#ffd54a', '#63e6be', '#e599f7',
];

/**
 * @param {HTMLElement} mount
 * @param {{progression:object, meId:string}} opts
 */
export function renderRankChart(mount, { progression, meId }) {
  let mode = 'game';        // 'game' | 'day'
  let focusUser = null;     // userId em solo, ou null

  // Cor estável por jogador (ordem final do ranking). "Você" sempre amarelo.
  const colorMap = new Map();
  progression.game.series.forEach((s, i) => {
    colorMap.set(s.userId, s.userId === meId ? ME_COLOR : PALETTE[i % PALETTE.length]);
  });

  const frame = () => progression[mode];

  // Avatar (foto ou iniciais) com borda na cor do jogador.
  function avatarChip(s, extra = '') {
    return `<span class="rc-av ${extra}" style="border-color:${colorMap.get(s.userId)}">${avatarHtml({ full_name: s.name, avatar_url: s.avatar_url })}</span>`;
  }

  draw();
  window.addEventListener('resize', onResize);

  let raf = 0;
  function onResize() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  }

  // ---------------------------------------------------------
  function draw() {
    mount.innerHTML = `
      <div class="rc-head">
        <div class="rc-modes" role="tablist">
          <button class="rc-mode ${mode === 'game' ? 'active' : ''}" data-mode="game">Por jogo</button>
          <button class="rc-mode ${mode === 'day' ? 'active' : ''}" data-mode="day">Por dia</button>
        </div>
        ${focusUser ? `<button class="rc-clear" data-action="clear-focus">Ver todos ✕</button>` : ''}
      </div>
      <div class="rc-plot"></div>
      ${renderLegend()}
    `;
    renderPlot(mount.querySelector('.rc-plot'));
    attach();
  }

  // ---------------------------------------------------------
  // Calcula posições por etapa a partir dos pontos acumulados.
  // values[0] é o ponto inicial (0 pts); a etapa s usa values[s+1].
  function computeGeometry() {
    const f = frame();
    const series = f.series;                  // ordem = ranking final
    const N = series.length;
    const steps = f.labels.length;

    const pos = series.map(() => new Array(steps));
    for (let s = 0; s < steps; s++) {
      const col = series.map((sr, i) => ({ i, pts: sr.values[s + 1] ?? 0 }));
      // empate: quem termina melhor (menor índice) fica acima → estável
      col.sort((a, b) => b.pts - a.pts || a.i - b.i);
      col.forEach((e, rank) => { pos[e.i][s] = rank + 1; });
    }
    return { f, series, N, steps, pos };
  }

  function renderPlot(host) {
    const { f, series, N, steps, pos } = computeGeometry();
    const width = Math.max(280, host.clientWidth || mount.clientWidth || 900);

    const PADt = 16, PADb = 30, PADl = 40;
    const isNarrow = width < 520;
    const PADr = isNarrow ? 108 : 172;

    // Mobile: 60+ linhas viram parede de cor num plot de ~200px. Sem foco
    // explícito, destaca só Você + top 3 (ordem de `series` = ranking final);
    // o resto fica esmaecido e sem rótulo na ponta. A legenda foca qualquer um.
    const defaultStrong = new Set([meId, ...series.slice(0, 3).map(s => s.userId)]);
    const rowH = N <= 1 ? 34 : clamp(Math.floor(680 / N), 20, 40);
    const plotTop = PADt;
    const plotH = (N <= 1 ? 1 : (N - 1)) * rowH;
    const height = plotTop + plotH + PADb;
    const x0 = PADl + 6, x1 = width - PADr;

    const xAt = (s) => steps <= 1 ? x0 : x0 + (x1 - x0) * (s / (steps - 1));
    const yAt = (p) => plotTop + (p - 1) * rowH;

    // ----- rótulos de posição (eixo Y) -----
    const labelEvery = rowH < 19 ? 2 : 1;
    let yLabels = '';
    for (let p = 1; p <= N; p++) {
      if ((p - 1) % labelEvery !== 0 && p !== N) continue;
      yLabels += `<text class="rc-ylbl" x="${PADl - 6}" y="${(yAt(p) + 4).toFixed(1)}" text-anchor="end">${p}º</text>`;
    }

    // ----- rótulos de etapa (eixo X), esparsos -----
    // Mobile: 3 rótulos com pontas ancoradas (start/end) — 4 centrados num
    // plot de ~200px colidiam ("Jogo 30Jogo 59") e vazavam das bordas.
    const xIdx = sparseIdx(steps, isNarrow ? 3 : 7);
    const xLabels = xIdx.map((s, k) => {
      const anchor = !isNarrow ? 'middle'
        : k === 0 ? 'start' : k === xIdx.length - 1 ? 'end' : 'middle';
      return `<text class="rc-xlbl" x="${xAt(s).toFixed(1)}" y="${(height - 9).toFixed(1)}" text-anchor="${anchor}">${escapeHtml(f.labels[s] ?? '')}</text>`;
    }).join('');

    // ----- linhas + ponta -----
    const drawOrder = series.map((_, i) => i).sort((a, b) => zOf(a) - zOf(b));
    let lines = '';
    for (const i of drawOrder) {
      const s = series[i];
      const dimmed = focusUser
        ? s.userId !== focusUser
        : (isNarrow && !defaultStrong.has(s.userId));
      const isMe = s.userId === meId;
      const isFocus = s.userId === focusUser;
      const pts = pos[i].map((p, k) => `${xAt(k).toFixed(1)},${yAt(p).toFixed(1)}`).join(' ');
      const color = colorMap.get(s.userId);
      const cls = `rc-line${isMe ? ' me' : ''}${isFocus ? ' focus' : ''}${dimmed ? ' dim' : ''}`;
      lines += `<polyline class="${cls}" points="${pts}" fill="none" stroke="${color}"/>`;

      const lp = pos[i][steps - 1];
      const lx = xAt(steps - 1), ly = yAt(lp);
      lines += `<circle class="rc-dot${dimmed ? ' dim' : ''}" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="${isMe || isFocus ? 5 : 4}" fill="${color}"/>`;

      // nome na ponta direita (cada linha numa posição distinta → não colide).
      // Mobile: só linhas em destaque ganham rótulo — 62 nomes de 9 chars
      // truncados viravam ruído com duplicatas ("Vinícius…" ×2).
      if (isNarrow && dimmed) continue;
      const nm = isMe ? 'Você' : s.name;
      lines += `<text class="rc-end${dimmed ? ' dim' : ''}${isMe || isFocus ? ' strong' : ''}" x="${(x1 + 8).toFixed(1)}" y="${(ly + 4).toFixed(1)}" fill="${color}">${escapeHtml(clip(nm, isNarrow ? 12 : 16))}</text>`;
    }

    host.innerHTML = `
      <svg class="rc-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"
           aria-label="Evolução da posição por jogador">
        ${yLabels}
        ${xLabels}
        ${lines}
        <line class="rc-cross" x1="0" y1="${plotTop}" x2="0" y2="${(plotTop + plotH).toFixed(1)}" hidden/>
        <g class="rc-hover"></g>
        <rect class="rc-hit" x="${x0}" y="${plotTop}" width="${Math.max(0, x1 - x0)}" height="${plotH}" fill="transparent"/>
      </svg>
      <div class="rc-tip" hidden></div>
    `;

    attachHover(host, { f, series, N, steps, pos, xAt, yAt, x0, x1, plotTop });

    function zOf(i) {
      if (series[i].userId === focusUser) return 4;
      if (series[i].userId === meId) return 3;
      if (isNarrow && defaultStrong.has(series[i].userId)) return 2;
      return 1;
    }
  }

  // ---------------------------------------------------------
  function renderLegend() {
    const f = frame();
    const lastPts = (s) => s.values[s.values.length - 1] ?? 0;
    const sorted = [...f.series].sort((a, b) => lastPts(b) - lastPts(a));
    return `
      <div class="rc-legend">
        ${sorted.map(s => {
          const isMe = s.userId === meId;
          const active = focusUser === s.userId;
          const dim = focusUser && !active;
          return `
            <button class="rc-leg ${active ? 'active' : ''} ${dim ? 'dim' : ''}" data-user="${s.userId}" title="${escapeHtml(s.name)}">
              ${avatarChip(s, 'sm')}
              <span class="rc-nm">${isMe ? 'Você' : escapeHtml(s.name)}</span>
              <span class="rc-pt">${lastPts(s)} pts</span>
            </button>`;
        }).join('')}
      </div>
    `;
  }

  // ---------------------------------------------------------
  function attach() {
    mount.querySelectorAll('.rc-mode').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.mode === mode) return;
        mode = btn.dataset.mode;
        draw();
      });
    });
    const clear = mount.querySelector('[data-action="clear-focus"]');
    if (clear) clear.addEventListener('click', () => { focusUser = null; draw(); });

    mount.querySelectorAll('.rc-leg').forEach(btn => {
      btn.addEventListener('click', () => {
        const uid = btn.dataset.user;
        focusUser = (focusUser === uid) ? null : uid;
        draw();
      });
    });
  }

  function attachHover(host, g) {
    const svg = host.querySelector('.rc-svg');
    const hit = host.querySelector('.rc-hit');
    const cross = host.querySelector('.rc-cross');
    const hover = host.querySelector('.rc-hover');
    const tip = host.querySelector('.rc-tip');
    if (!svg || !hit) return;

    function stepAt(clientX) {
      const r = svg.getBoundingClientRect();
      const xv = (clientX - r.left) / r.width * (svg.viewBox.baseVal.width || r.width);
      const t = (g.x1 - g.x0) === 0 ? 0 : (xv - g.x0) / (g.x1 - g.x0);
      return clamp(Math.round(t * (g.steps - 1)), 0, g.steps - 1);
    }

    function move(e) {
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const s = stepAt(clientX);
      const xpx = g.xAt(s);

      cross.removeAttribute('hidden');
      cross.setAttribute('x1', xpx.toFixed(1));
      cross.setAttribute('x2', xpx.toFixed(1));

      // bolinhas na coluna ativa
      while (hover.firstChild) hover.removeChild(hover.firstChild);
      g.series.forEach((sr, i) => {
        if (focusUser && sr.userId !== focusUser) return;
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', xpx.toFixed(1));
        c.setAttribute('cy', g.yAt(g.pos[i][s]).toFixed(1));
        c.setAttribute('r', sr.userId === meId ? '5' : '4');
        c.setAttribute('fill', colorMap.get(sr.userId));
        c.setAttribute('class', 'rc-hdot');
        hover.appendChild(c);
      });

      // standings na coluna (ordenado por posição)
      const rows = g.series.map((sr, i) => ({
        sr, userId: sr.userId, name: sr.userId === meId ? 'Você' : sr.name,
        pos: g.pos[i][s], pts: sr.values[s + 1] ?? 0,
        isMe: sr.userId === meId,
      })).sort((a, b) => a.pos - b.pos);

      let show = focusUser ? rows.filter(r => r.userId === focusUser) : rows.slice(0, 12);
      if (!focusUser && !show.some(r => r.isMe)) {
        const me = rows.find(r => r.isMe);
        if (me) { show = show.slice(0, 11); show.push(me); }
      }

      // header: no modo "por jogo" mostra o confronto, data, fase e grupo
      const m = g.f.matches?.[s];
      const header = m ? matchHeader(m) : `<div class="rc-tip-h">${escapeHtml(g.f.labels[s] ?? '')}</div>`;

      tip.innerHTML = `
        ${header}
        ${show.map(r => `
          <div class="rc-tip-r ${r.isMe ? 'me' : ''}">
            <span class="rc-tip-pos">${r.pos}º</span>
            ${avatarChip(r.sr, 'sm')}
            <span class="rc-tip-nm">${escapeHtml(r.name)}</span>
            <span class="rc-tip-pt">${r.pts}</span>
          </div>`).join('')}
      `;
      tip.hidden = false;

      const pb = host.getBoundingClientRect();
      const relX = clientX - pb.left;
      const tw = tip.offsetWidth || 180;
      let left = relX + 14;
      if (left + tw > pb.width) left = relX - tw - 14;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `8px`;
    }

    function leave() {
      cross.setAttribute('hidden', '');
      while (hover.firstChild) hover.removeChild(hover.firstChild);
      tip.hidden = true;
    }

    hit.addEventListener('mousemove', move);
    hit.addEventListener('mouseleave', leave);
    hit.addEventListener('touchstart', move, { passive: true });
    hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('touchend', leave);
  }
}

// ============================================================
// Helpers
// ============================================================
// Cabeçalho do tooltip no modo "por jogo": data · fase/grupo + confronto e placar.
function matchHeader(m) {
  const d = new Date(m.match_date);
  const phase = m.stage === 'group'
    ? `Grupo ${escapeHtml(m.group_name ?? '')}`
    : escapeHtml(stageLabel(m.stage));
  const hasScore = m.actual_home != null && m.actual_away != null;
  const score = hasScore ? `${m.actual_home}<span class="x">–</span>${m.actual_away}` : '×';
  return `
    <div class="rc-tip-when">${escapeHtml(formatBrDate(d))} · ${escapeHtml(formatTime(m.match_date))} · ${phase}</div>
    <div class="rc-tip-match">
      ${flag(m.team_home)}
      <span class="rc-tip-tm">${escapeHtml(teamPt(m.team_home))}</span>
      <span class="rc-tip-sc">${score}</span>
      <span class="rc-tip-tm">${escapeHtml(teamPt(m.team_away))}</span>
      ${flag(m.team_away)}
    </div>
  `;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clip(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ~count índices bem espaçados em [0, total-1]
function sparseIdx(total, count) {
  if (total <= 0) return [];
  const want = Math.min(count, total);
  const out = [], seen = new Set();
  for (let k = 0; k < want; k++) {
    const idx = want === 1 ? total - 1 : Math.round(k * (total - 1) / (want - 1));
    if (!seen.has(idx)) { seen.add(idx); out.push(idx); }
  }
  return out;
}

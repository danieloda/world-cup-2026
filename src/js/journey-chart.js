// ============================================================
// Minha jornada — card pessoal de evolução (tela Início)
// ============================================================
// Uma linha só, contada como história: a posição do usuário ao longo da Copa
// sobre as faixas de fase, com melhor/pior momento e a maior arrancada/tombo
// anotados. KPIs mostram a PARTIDA real (bandeiras, placar, data) em que cada
// marco aconteceu. Tempo "Por dia" (padrão) ou "Por jogo"; comparação com um
// rival via dropdown custom (avatar + cor + pontos).
//
// Dados: mesmas séries do replay (progression.js) — posição exige o bolão
// inteiro, então recebe todas as séries e foca na do usuário.

import { escapeHtml, avatarHtml, flag, teamPt, stageLabel, formatBrShort } from './util.js';
import {
  computePositions, buildTimeline, stageBands, buildColorMap, avatarSvgAt,
  matchHeader, placeTip, pointXY, clamp, ME_COLOR,
} from './chart-utils.js';

/**
 * @param {HTMLElement} mount
 * @param {{series:Array, matches:Array, meId:string}} opts
 * @returns {boolean} false se o usuário não está no ranking (nada renderizado)
 */
export function renderJourneyChart(mount, { series, matches, meId }) {
  const N = series.length;
  const GAMES = matches.length;
  const meIdx = series.findIndex(s => s.userId === meId);
  if (N === 0 || GAMES === 0 || meIdx < 0) return false;

  const pos = computePositions(series);
  const tl = buildTimeline(matches);
  const colorMap = buildColorMap(series, meId);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // primeiros jogos = ruído de empate (todo mundo com ~0 pt) — estatísticas
  // e anotações começam depois deles
  const FROM_G = Math.min(6, Math.max(0, GAMES - 2));

  let granKey = 'dia';     // 'dia' | 'jogo'
  let rival = null;        // userId ou null
  let animated = false;

  draw();
  window.addEventListener('resize', onResize);
  let raf = 0;
  function onResize() { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }

  // fecha o dropdown ao clicar fora (listener único, sobrevive aos redraws)
  document.addEventListener('click', (e) => {
    const list = mount.querySelector('.jc-dd-list');
    if (list && !list.hidden && !e.target.closest('.jc-dd')) list.hidden = true;
  });

  // ---------------------------------------------------------
  // estatísticas por JOGO (verdade), independentes da granularidade exibida
  function statsOf(i) {
    const stable = pos[i].slice(FROM_G);
    const best = Math.min(...stable), worst = Math.max(...stable);
    let jump = 0, jumpAt = 0, fall = 0, fallAt = 0;
    for (let s = FROM_G + 1; s < GAMES; s++) {
      const dd = pos[i][s - 1] - pos[i][s];
      if (dd > jump) { jump = dd; jumpAt = s; }
      if (-dd > fall) { fall = -dd; fallAt = s; }
    }
    return { best, worst, jump, jumpAt, fall, fallAt,
      bestAt: FROM_G + stable.indexOf(best), worstAt: FROM_G + stable.indexOf(worst) };
  }

  // partida real empilhada (KPIs): um time por linha, gols à direita,
  // data + fase em linha própria — espelha os cards de jogo do app
  function matchStack(g) {
    const m = matches[g];
    const phase = m.stage === 'group' ? `Grupo ${escapeHtml(m.group_name ?? '')}` : escapeHtml(stageLabel(m.stage));
    return `<div class="jc-mtx">
      <div class="ln">${flag(m.team_home)} <span class="tn">${escapeHtml(teamPt(m.team_home))}</span> <b class="g">${m.actual_home ?? '–'}</b></div>
      <div class="ln">${flag(m.team_away)} <span class="tn">${escapeHtml(teamPt(m.team_away))}</span> <b class="g">${m.actual_away ?? '–'}</b></div>
      <div class="dt">${escapeHtml(formatBrShort(m.match_date))} · ${phase}</div>
    </div>`;
  }

  function avatarChip(s, extra = '') {
    return `<span class="rc-av ${extra}" style="border-color:${colorMap.get(s.userId)}">${avatarHtml({ full_name: s.name, avatar_url: s.avatar_url })}</span>`;
  }

  // ---------------------------------------------------------
  function draw() {
    const st = statsOf(meIdx);
    const myFinal = pos[meIdx][GAMES - 1];
    const myPts = series[meIdx].values[GAMES] ?? 0;

    // Δ desde o dia anterior
    const dPrev = tl.dayEnds.length > 1 ? pos[meIdx][tl.dayEnds[tl.dayEnds.length - 2]] - myFinal : 0;
    const dTxt = dPrev > 0 ? `<b class="up">▲${dPrev}</b> desde ontem`
               : dPrev < 0 ? `<b class="dn">▼${-dPrev}</b> desde ontem` : 'estável desde ontem';

    const rivalIdx = rival ? series.findIndex(s => s.userId === rival) : -1;
    const byFinal = series.map((s, i) => ({ s, i })).filter(({ s }) => s.userId !== meId);
    const ddItems = [`
      <button class="jc-dd-item ${rivalIdx < 0 ? 'sel' : ''}" data-user="" role="option" aria-selected="${rivalIdx < 0}">
        <span class="rc-av sm" style="border-color:var(--line-strong)">—</span>
        <span class="dn" style="color:var(--text-dim)">ninguém</span>
      </button>`,
      ...byFinal.map(({ s, i }) => `
      <button class="jc-dd-item ${s.userId === rival ? 'sel' : ''}" data-user="${s.userId}" role="option" aria-selected="${s.userId === rival}">
        ${avatarChip(s, 'sm')}
        <span class="dp" style="color:${colorMap.get(s.userId)}">${pos[i][GAMES - 1]}º</span>
        <span class="dn">${escapeHtml(s.name)}</span>
        <span class="dv">${s.values[GAMES] ?? 0} pts</span>
      </button>`)].join('');
    const ddFace = rivalIdx < 0
      ? '<span style="color:var(--text-dim)">— ninguém —</span>'
      : `${avatarChip(series[rivalIdx], 'sm')} <b style="color:${colorMap.get(rival)}">${pos[rivalIdx][GAMES - 1]}º</b> ${escapeHtml(series[rivalIdx].name)}`;

    const me = series[meIdx];
    mount.innerHTML = `
      <div class="jc-head">
        <div class="jc-who">
          <span class="rc-av lg" style="border-color:${ME_COLOR}">${avatarHtml({ full_name: me.name, avatar_url: me.avatar_url })}</span>
          <div>
            <div class="jc-title">Sua jornada na Copa</div>
            <div class="jc-sub"><b>${myFinal}º</b> · ${myPts} pts · ${dTxt}</div>
          </div>
        </div>
        <div class="rc-seg" role="group" aria-label="Granularidade do tempo">
          <button data-g="dia" class="${granKey === 'dia' ? 'on' : ''}" aria-pressed="${granKey === 'dia'}">Por dia</button>
          <button data-g="jogo" class="${granKey === 'jogo' ? 'on' : ''}" aria-pressed="${granKey === 'jogo'}">Por jogo</button>
        </div>
      </div>
      <div class="jc-kpis">
        <div class="jc-kpi"><div class="l">Agora</div><div class="v">${myFinal}º</div><div class="jc-mtx"><div class="dt">depois de ${GAMES} jogo${GAMES === 1 ? '' : 's'}</div></div></div>
        <div class="jc-kpi"><div class="l">Melhor</div><div class="v">${st.best}º</div>${matchStack(st.bestAt)}</div>
        <div class="jc-kpi"><div class="l">Pior</div><div class="v">${st.worst}º</div>${matchStack(st.worstAt)}</div>
        <div class="jc-kpi"><div class="l">Maior arrancada</div>${st.jump > 0
          ? `<div class="v up">+${st.jump}</div>${matchStack(st.jumpAt)}`
          : '<div class="v mute">—</div><div class="jc-mtx"><div class="dt">ainda não houve</div></div>'}</div>
        <div class="jc-kpi"><div class="l">Maior tombo</div>${st.fall > 0
          ? `<div class="v dn">−${st.fall}</div>${matchStack(st.fallAt)}`
          : '<div class="v mute">—</div><div class="jc-mtx"><div class="dt">ainda não houve</div></div>'}</div>
      </div>
      <div class="jc-plot"></div>
      <div class="jc-foot">
        <span class="jc-cmp-lbl">Comparar com</span>
        <div class="jc-dd">
          <button class="jc-dd-btn" aria-haspopup="listbox" aria-expanded="false">${ddFace}<span class="car">▼</span></button>
          <div class="jc-dd-list" role="listbox" aria-label="Comparar com" hidden>${ddItems}</div>
        </div>
      </div>
    `;

    renderPlot(st, rivalIdx);

    mount.querySelectorAll('.rc-seg button').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.g === granKey) return;
      granKey = b.dataset.g;
      draw();
    }));
    const dd = mount.querySelector('.jc-dd');
    const ddBtn = dd.querySelector('.jc-dd-btn');
    const ddList = dd.querySelector('.jc-dd-list');
    ddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      ddList.hidden = !ddList.hidden;
      ddBtn.setAttribute('aria-expanded', !ddList.hidden);
      if (!ddList.hidden) ddList.querySelector('.jc-dd-item.sel')?.scrollIntoView({ block: 'center' });
    });
    ddList.querySelectorAll('.jc-dd-item').forEach(it => it.addEventListener('click', () => {
      rival = it.dataset.user || null;
      draw();
    }));
  }

  // ---------------------------------------------------------
  function renderPlot(st, rivalIdx) {
    const host = mount.querySelector('.jc-plot');
    const steps = granKey === 'dia' ? tl.dayEnds : [...Array(GAMES).keys()];
    const K = steps.length;
    const width = Math.max(280, host.clientWidth || mount.clientWidth || 900);
    const narrow = width < 520;
    const height = narrow ? 250 : 300, PADl = 40, PADr = 26, PADt = 30, PADb = 28;

    const ids = rivalIdx >= 0 ? [meIdx, rivalIdx] : [meIdx];
    let lo = N, hi = 1;
    for (const i of ids) {
      const stable = pos[i].slice(FROM_G);
      lo = Math.min(lo, ...stable); hi = Math.max(hi, ...stable);
    }
    lo = Math.max(1, lo - 2); hi = Math.min(N, hi + 2);
    const xAt = (k) => K <= 1 ? width - PADr : PADl + (width - PADl - PADr) * (k / (K - 1));
    const yAt = (p) => PADt + (height - PADt - PADb) * ((clamp(p, lo, hi) - lo) / Math.max(1, hi - lo));
    const sample = (i) => steps.map(g => pos[i][g]);

    let g = '';
    stageBands(matches, steps, xAt, PADl, width - PADr).forEach((b, bi) => {
      if (bi % 2 === 1) g += `<rect class="jc-band" x="${b.x.toFixed(1)}" y="${PADt - 18}" width="${b.w.toFixed(1)}" height="${height - PADt - PADb + 18}"/>`;
      if (b.w > (narrow ? 34 : 64)) g += `<text class="jc-band-lbl" x="${(b.x + b.w / 2).toFixed(1)}" y="${PADt - 7}" text-anchor="middle">${escapeHtml(b.label)}</text>`;
    });
    const yStep = Math.max(1, Math.ceil((hi - lo) / 8));
    for (let p = lo; p <= hi; p += yStep) {
      g += `<line x1="${PADl}" x2="${width - PADr}" y1="${yAt(p)}" y2="${yAt(p)}" stroke="rgba(255,255,255,.05)"/>`;
      g += `<text class="rc-ylbl" x="${PADl - 8}" y="${(yAt(p) + 4).toFixed(1)}" text-anchor="end">${p}º</text>`;
    }
    const nx = Math.min(narrow ? 3 : 6, K);
    for (let k0 = 0; k0 < nx; k0++) {
      const k = nx === 1 ? K - 1 : Math.round(k0 * (K - 1) / (nx - 1));
      const anchor = k0 === 0 ? 'start' : k0 === nx - 1 ? 'end' : 'middle';
      const lbl = granKey === 'dia' ? tl.dayLabel(k) : (narrow ? `J${steps[k] + 1}` : `Jogo ${steps[k] + 1}`);
      g += `<text class="rc-xlbl" x="${xAt(k).toFixed(1)}" y="${(height - 8).toFixed(1)}" text-anchor="${anchor}">${lbl}</text>`;
    }

    // rival (tracejado) + avatar na ponta
    if (rivalIdx >= 0) {
      const c2 = colorMap.get(rival);
      const pts2 = sample(rivalIdx).map((p, k) => `${xAt(k).toFixed(1)},${yAt(p).toFixed(1)}`).join(' ');
      g += `<polyline fill="none" stroke="${c2}" stroke-width="2" stroke-dasharray="5 4" opacity=".85" points="${pts2}"/>`;
      g += avatarSvgAt(series[rivalIdx], c2, width - PADr, yAt(pos[rivalIdx][GAMES - 1]), 9, 'jcr');
    }

    // linha principal: área + glow + draw-in
    const mySeries = sample(meIdx);
    const myPtsStr = mySeries.map((p, k) => `${xAt(k).toFixed(1)},${yAt(p).toFixed(1)}`).join(' ');
    g += `<polygon fill="${ME_COLOR}" opacity=".07" points="${xAt(0).toFixed(1)},${height - PADb} ${myPtsStr} ${xAt(K - 1).toFixed(1)},${height - PADb}"/>`;
    g += `<polyline class="jc-journey" fill="none" stroke="${ME_COLOR}" points="${myPtsStr}"/>`;

    // anotações calculadas na SÉRIE AMOSTRADA — a bolinha precisa estar sobre
    // a linha desenhada (por dia, o jogo exato passa entre dois pontos).
    // Os KPIs em cima mantêm a verdade por jogo.
    const kFirst = Math.max(0, steps.findIndex(s => s >= FROM_G));
    let sBest = Infinity, sBestK = 0, sWorst = -Infinity, sWorstK = 0;
    let sJump = 0, sJumpK = 0, sFall = 0, sFallK = 0;
    for (let k = kFirst; k < K; k++) {
      if (mySeries[k] < sBest) { sBest = mySeries[k]; sBestK = k; }
      if (mySeries[k] > sWorst) { sWorst = mySeries[k]; sWorstK = k; }
      if (k > kFirst) {
        const dd = mySeries[k - 1] - mySeries[k];
        if (dd > sJump) { sJump = dd; sJumpK = k; }
        if (-dd > sFall) { sFall = -dd; sFallK = k; }
      }
    }
    const delay = animated || reduced ? 0 : 1.05;
    const ann = (k, p, txt, color, dy, d) => `
      <g class="jc-ann" style="animation-delay:${(delay + d).toFixed(2)}s">
        <circle cx="${xAt(k).toFixed(1)}" cy="${yAt(p).toFixed(1)}" r="4.5" fill="${color}"/>
        <text x="${clamp(xAt(k), PADl + 44, width - PADr - 48).toFixed(1)}" y="${(yAt(p) + dy).toFixed(1)}" text-anchor="middle" fill="${color}">${txt}</text>
      </g>`;
    // no teto do plot o rótulo colidiria com o nome da faixa de fase → flipa pra baixo
    const dyBest = yAt(sBest) < PADt + 18 ? 18 : -10;
    g += ann(sBestK, sBest, `★ melhor: ${sBest}º`, 'var(--accent-bright)', dyBest, 0);
    const dyWorst = yAt(sWorst) > height - PADb - 16 ? -10 : 18;
    g += ann(sWorstK, sWorst, `pior: ${sWorst}º`, '#8a8a8e', dyWorst, .12);
    if (sJump >= 3 && sJumpK !== sBestK) {
      const dyJump = yAt(mySeries[sJumpK]) < PADt + 18 ? 18 : -10;
      g += ann(sJumpK, mySeries[sJumpK], `▲ +${sJump}`, 'var(--positive)', dyJump, .24);
    }
    if (sFall >= 3 && sFallK !== sWorstK) g += ann(sFallK, mySeries[sFallK], `▼ −${sFall}`, 'var(--red)', 18, .36);
    g += `<g class="jc-ann" style="animation-delay:${delay.toFixed(2)}s">${avatarSvgAt(series[meIdx], ME_COLOR, xAt(K - 1), yAt(pos[meIdx][GAMES - 1]), 10, 'jcm')}</g>`;

    host.innerHTML = `
      <svg class="jc-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"
           aria-label="Sua posição no ranking ao longo da Copa">
        ${g}
        <line class="rc-cross" x1="0" x2="0" y1="${PADt}" y2="${height - PADb}" hidden/>
        <rect class="rc-hit" x="${PADl}" y="${PADt}" width="${Math.max(0, width - PADl - PADr)}" height="${height - PADt - PADb}" fill="transparent"/>
      </svg>
      <div class="rc-tip" hidden></div>
    `;

    // draw-in da linha (uma vez, respeitando prefers-reduced-motion)
    const line = host.querySelector('.jc-journey');
    if (!animated && !reduced && line.getTotalLength) {
      const L = line.getTotalLength();
      line.style.strokeDasharray = L;
      line.style.strokeDashoffset = L;
      requestAnimationFrame(() => {
        line.style.transition = 'stroke-dashoffset 1.05s cubic-bezier(.45,.05,.35,1)';
        line.style.strokeDashoffset = '0';
      });
      animated = true;
    }

    attachHover(host, { steps, K, xAt, ids, width, PADl, PADr });
  }

  // ---------------------------------------------------------
  function attachHover(host, geo) {
    const svg = host.querySelector('.jc-svg');
    const hit = host.querySelector('.rc-hit');
    const cross = host.querySelector('.rc-cross');
    const tip = host.querySelector('.rc-tip');

    function move(e) {
      const { x: cx } = pointXY(e);
      const r = svg.getBoundingClientRect();
      // Redraw no meio do gesto (resize da barra do Safari ao rolar) desanexa
      // o SVG, mas o touch segue entregue ao nó velho (implicit capture):
      // rect zerado → xv = ∞ → com 1 só dia (K=1) k vira NaN → dayKeys[NaN]
      // → k.split quebra. Gesto órfão não tem tooltip a mostrar.
      if (!r.width) return;
      const xv = (cx - r.left) / r.width * geo.width;
      const k = clamp(Math.round((xv - geo.PADl) / Math.max(1, geo.width - geo.PADl - geo.PADr) * (geo.K - 1)), 0, Math.max(0, geo.K - 1));
      const gi = geo.steps[k];
      cross.removeAttribute('hidden');
      cross.setAttribute('x1', geo.xAt(k).toFixed(1));
      cross.setAttribute('x2', geo.xAt(k).toFixed(1));

      const header = granKey === 'jogo'
        ? matchHeader(matches[gi])
        : `<div class="rc-tip-h">${tl.dayLabel(k)} · ${escapeHtml(stageLabel(matches[gi].stage))}</div>`;
      tip.innerHTML = header + geo.ids.map(i => {
        const s = series[i];
        const c = colorMap.get(s.userId);
        return `
          <div class="rc-tip-r">
            <span class="rc-tip-pos" style="color:${c}">${pos[i][gi]}º</span>
            ${avatarChip(s, 'sm')}
            <span class="rc-tip-nm" style="color:${c}">${escapeHtml(s.userId === meId ? 'Você' : s.name)}</span>
            <span class="rc-tip-pt">${s.values[gi + 1] ?? 0}</span>
          </div>`;
      }).join('');
      tip.hidden = false;
      placeTip(host, tip, cx);
    }
    function leave() { cross.setAttribute('hidden', ''); tip.hidden = true; }

    hit.addEventListener('mousemove', move);
    hit.addEventListener('mouseleave', leave);
    hit.addEventListener('touchstart', move, { passive: true });
    hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('touchend', leave);
  }

  return true;
}

// ============================================================
// Evolução do ranking (tela Ranking) — v2
// ============================================================
// SVG puro, sem dependências. Recebe séries de PONTOS acumulados por jogo
// (ver loadProgression em progression.js), ranqueia em cada etapa por replay
// pra obter a POSIÇÃO, e desenha a trajetória do foco.
//
// Decisões (2026-06-15, aprovadas em protótipo):
//  • Rótulos = hover: no DESKTOP os nomes saem de cima das linhas pra um PAINEL
//    à direita que É o hover — em repouso mostra a classificação atual; ao passar
//    o mouse vira o jogo sob o cursor (reordena, pontos, destaca a linha). Sem
//    tooltip flutuante, sem rótulo cobrindo linha.
//  • MOBILE: linha-espaguete não cabe; vira uma lista de SPARKLINES (uma mini
//    trajetória por jogador + posição + seta de subiu/caiu).
//
// Clareza do desktop (2026-06-17):
//  • Linhas em STEP (degrau) com rampa curta: a posição fica em PATAMAR durante o
//    jogo e salta entre jogos — como um diagrama de tempo (o "clock" é a partida).
//    1ª partida na borda esquerda, ÚLTIMA na DIREITA: o fim do gráfico É o último
//    jogo (pontas, hover e divisória do último jogo caem no mesmo x).
//  • Eixo Y de domínio ENXUTO: o núcleo cobre só onde o foco anda na 2ª metade +
//    a posição atual; o ruído fundo do começo cai numa faixa COMPRIMIDA no rodapé
//    (ou é absorvido linear, se for cauda curta). Altura ∝ posições do núcleo
//    (px garantidos por posição → linhas respiram), com TETO relativo à viewport.
//  • Grade dinâmica: uma linha por posição quando cabe + divisórias verticais por
//    partida. Pontas explícitas (bolinha no fim de cada linha = posição atual).
// Tempo em dois zooms: "Por semana" (Copa inteira) e "Jogos da semana" (só a
// semana corrente, jogo a jogo). Foco livre via legenda; chips = reset.

import { escapeHtml, avatarHtml } from './util.js';
import {
  computePositions, buildTimeline, stageBands, buildColorMap,
  matchHeader, pointXY, clamp, firstMeaningfulGame,
} from './chart-utils.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NARROW = 560;          // abaixo disso → layout mobile (sparklines)
const PAN_ROW = 34;          // altura de uma linha do painel (desktop)

const IC = {
  trophy: '<svg class="rc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a3 3 0 0 0 3 3M17 6h3a3 3 0 0 1-3 3"/></svg>',
  list: '<svg class="rc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  star: '<svg class="rc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>',
};

/**
 * @param {HTMLElement} mount
 * @param {{series:Array, matches:Array, meId:string}} opts
 */
export function renderRankChart(mount, { series, matches, meId }) {
  const N = series.length;
  const GAMES = matches.length;
  mount.classList.remove('empty');   // o auto-refresh re-renderiza no MESMO mount
  if (N === 0 || GAMES === 0) {
    mount.classList.add('empty');
    mount.innerHTML = '<p>Ainda sem jogos pontuados — a evolução aparece com o primeiro resultado.</p>';
    return;
  }

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
  // Semanas COM jogo (weekEnds pode ter buraco se houver 7+ dias sem jogos);
  // a navegação ‹ › do zoom por jogo só anda pelas válidas.
  const validWeeks = tl.weekEnds.map((g, w) => g == null ? null : w).filter(w => w != null);
  const stepsOfWeek = (w) => {
    const iv = validWeeks.indexOf(w);
    const prev = iv > 0 ? tl.weekEnds[validWeeks[iv - 1]] : -1;
    const steps = [];
    for (let g = prev + 1; g <= tl.weekEnds[w]; g++) steps.push(g);
    return steps;
  };

  const presetSet = (p) => {
    const f = new Set(series.slice(0, p === 'podio' ? 3 : 10).map(s => s.userId));
    if (meIdx >= 0) f.add(meId);
    return f;
  };
  const setsEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

  // ===== Favoritos: o grupo de amigos, salvo POR USUÁRIO =====
  // O usuário monta o próprio recorte (a competição paralela dentro do bolão) e
  // ele sobrevive entre visitas. Chave por meId: multi-conta no mesmo navegador
  // não se mistura e o preview demo (meId='demo-me') cai em chave própria.
  // try/catch em tudo: localStorage pode estar indisponível (Safari privado,
  // storage cheio) — aí o preset funciona só na sessão, sem quebrar o resto.
  const FAV_KEY = `rc:favs:${meId}`;
  const MODE_KEY = `rc:mode:${meId}`;
  const loadFavs = () => {
    try {
      const arr = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
      // ids que saíram do bolão (ou de outra época do ranking) são descartados
      return new Set((Array.isArray(arr) ? arr : []).filter(uid => byId.has(uid)));
    } catch { return new Set(); }
  };
  const saveFavs = () => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])); } catch {} };
  const saveMode = (m) => { try { m === 'fav' ? localStorage.setItem(MODE_KEY, 'fav') : localStorage.removeItem(MODE_KEY); } catch {} };
  const loadMode = () => { try { return localStorage.getItem(MODE_KEY); } catch { return null; } };

  let favs = loadFavs();
  // Se a última visita ficou nos Favoritos, reabre neles — é o "meu grupo" que
  // a pessoa quer acompanhar todo dia; senão, o padrão de sempre (Pódio + Você).
  let favMode = loadMode() === 'fav' && favs.size > 0;
  // Zoom de tempo sobrevive ao auto-refresh (que dá reload a cada resultado
  // lançado): sessionStorage — morre com a aba, não gruda entre visitas.
  const GRAN_KEY = 'rc:gran';
  const loadGran = () => { try { return sessionStorage.getItem(GRAN_KEY); } catch { return null; } };
  const saveGran = (g) => { try { sessionStorage.setItem(GRAN_KEY, g); } catch {} };
  let granKey = canWeek ? (loadGran() === 'jogo' ? 'jogo' : 'semana') : 'jogo';
  let weekView = lastWeek;   // semana aberta no zoom "Jogos da semana" (‹ › navega)
  let selected = favMode ? new Set(favs) : presetSet('podio');
  let showAllLeg = false;
  const activeSteps = () => granKey === 'jogo' ? stepsOfWeek(weekView) : tl.weekEnds.filter(g => g != null);

  function avatarChip(s, extra = '') {
    return `<span class="rc-av ${extra}" style="border-color:${colorMap.get(s.userId)}">${avatarHtml({ full_name: s.name, avatar_url: s.avatar_url })}</span>`;
  }

  mount.innerHTML = `
    <div class="rc-head">
      <div class="rc-presets" role="group" aria-label="Seleção rápida de jogadores">
        <button class="rc-chip" data-p="podio">${IC.trophy}Pódio + Você</button>
        <button class="rc-chip" data-p="top10">${IC.list}Top 10</button>
        <button class="rc-chip" data-p="fav" title="Seu grupo de amigos — a seleção fica salva">${IC.star}Favoritos<span class="rc-chip-ct" hidden></span></button>
      </div>
      <div class="rc-tempo">
        <div class="rc-seg" role="group" aria-label="Visão do tempo">
          <button data-g="semana">Por semana</button>
          <button data-g="jogo">Jogos da semana</button>
        </div>
        <div class="rc-weeknav" role="group" aria-label="Trocar a semana exibida" style="display:none">
          <button class="rc-wk" data-wk="-1" aria-label="Semana anterior">‹</button>
          <span class="rc-wk-lbl"></span>
          <button class="rc-wk" data-wk="1" aria-label="Semana seguinte">›</button>
        </div>
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
    const narrow = width < NARROW;
    updateControls(narrow);
    if (narrow) drawMobile(body);
    else drawDesktop(body, width);
    renderLegend();
    renderNote();
  }

  // O toggle de tempo muda de SIGNIFICADO conforme o layout:
  //  • desktop: "Por semana" / "Jogos da semana" = zoom do eixo X do gráfico.
  //  • mobile : "Por semana" / "Último jogo"     = base da EVOLUÇÃO (▲/▼) — a
  //    sparkline mostra a jornada inteira; o que muda é de onde se mede o delta.
  // Sem 2ª semana ainda, "Por semana" não faz sentido → some o toggle inteiro
  // (só existe uma visão), o que também tira o botão "morto" do mobile.
  function updateControls(narrow) {
    const seg = mount.querySelector('.rc-seg');
    if (!seg) return;
    seg.style.display = canWeek ? '' : 'none';
    // no mobile o toggle é a BASE do ▲/▼, não zoom — o aria-label acompanha
    seg.setAttribute('aria-label', narrow ? 'Base da variação de posições' : 'Visão do tempo');
    const bJogo = seg.querySelector('[data-g="jogo"]');
    if (bJogo) bJogo.textContent = narrow ? 'Último jogo' : 'Jogos da semana';
    // ‹ Semana N › — só no desktop, no zoom por jogo, com 2+ semanas
    const nav = mount.querySelector('.rc-weeknav');
    if (nav) {
      const on = !narrow && canWeek && granKey === 'jogo';
      nav.style.display = on ? '' : 'none';
      if (on) {
        nav.querySelector('.rc-wk-lbl').textContent = `Semana ${weekView + 1} · ${tl.weekRange(weekView)}`;
        const iv = validWeeks.indexOf(weekView);
        nav.querySelector('[data-wk="-1"]').disabled = iv <= 0;
        nav.querySelector('[data-wk="1"]').disabled = iv >= validWeeks.length - 1;
      }
    }
  }

  // ===== DESKTOP: gráfico enxuto + painel vivo (= rótulos = hover) =====
  function drawDesktop(body, width) {
    const ids = [...selected].map(uid => byId.get(uid)).filter(i => i != null).sort((a, b) => finalPos(a) - finalPos(b));
    const steps = activeSteps();
    const K = steps.length;
    const n = ids.length;
    const lastStep = steps[steps.length - 1];

    // <720px (tablet / landscape estreito): painel EMBAIXO, full-width — lado a
    // lado sobravam ~294px pro plot. As rows do painel são absolute com altura
    // fixa, então esticar não muda nada no CSS.
    const stack = width < 720;
    const panW = 296;
    const chartW = Math.max(200, stack ? width - 8 : width - panW - 16);
    const PADl = 32, PADr = 12, PADt = 32, PADb = 22;  // PADt folgado: o rótulo de fase ("GRUPOS") respira acima das linhas

    // ===== Eixo Y: domínio ENXUTO + altura por posição =====
    // O começo da Copa é ruído: com todo mundo empatado a "posição" é só desempate,
    // o que esticava o eixo até a lanterna e amassava as linhas lá em cima — onde o
    // foco de fato vive. Agora o NÚCLEO do eixo cobre só onde as linhas andam na 2ª
    // METADE (Copa já assentada) + a posição ATUAL. Excursões mais fundas que isso
    // (o vai-e-vem do começo) não somem nem achatam: caem numa faixa COMPRIMIDA no
    // rodapé, que mantém a ordem mas de-enfatiza o ruído.
    let rLo = 1, rHi = Math.min(N, 6), deepHi = rHi;
    if (n) {
      const half = Math.floor(steps.length / 2);
      let best = Infinity, recentHi = 1, worst = 1;
      ids.forEach(i => {
        for (let k = 0; k < steps.length; k++) {
          const p = pos[i][steps[k]];
          if (p < best) best = p;
          if (p > worst) worst = p;
          if (k >= half && p > recentHi) recentHi = p;
        }
      });
      rLo = Math.max(1, best - 1);
      rHi = Math.min(N, recentHi + 1);
      if (rHi - rLo < 2) rHi = Math.min(N, rLo + 2);
      deepHi = Math.max(rHi, worst);
      // Se a cauda funda é pequena perto do núcleo, NÃO vale uma faixa comprimida
      // (vira um vão vazio no rodapé): estende o eixo linear até lá. A faixa só fica
      // quando a excursão é bem mais funda que o núcleo (ex.: top-10 + ruído inicial).
      if (deepHi - rHi <= (rHi - rLo) * 0.6) rHi = deepHi;
    }
    const coreSpan = Math.max(1, rHi - rLo);
    const hasDeep = deepHi > rHi;

    // Altura ∝ posições do NÚCLEO (px garantidos por posição → as linhas respiram),
    // não mais ∝ nº de selecionados. A faixa funda custa só uns px fixos.
    const PXR = chartW < 420 ? 16 : 22;   // px por posição no núcleo (alvo)
    const deepPx = hasDeep ? 52 : 0;
    // teto relativo à VIEWPORT: o gráfico nunca passa da tela (folga p/ header,
    // legenda e nota). Se o núcleo é grande (ex.: foco com alguém lá no fim),
    // a altura bate no teto e as posições comprimem o necessário pra caber.
    const vpCap = clamp((window.innerHeight || 800) - 300, 320, 600);
    const H = clamp(Math.round(PADt + PADb + coreSpan * PXR + deepPx), 190, vpCap);
    const plotH = H - PADt - PADb;
    const yCore = PADt + (plotH - deepPx);   // base do trecho linear (núcleo)

    const x0 = PADl + 4, x1 = chartW - PADr;
    // Cada partida tem uma POSIÇÃO no eixo (xAt) com um PATAMAR de largura ao redor:
    // a posição fica reta durante o jogo e dá um DEGRAU entre jogos — como um sinal
    // num diagrama de tempo (o "clock" é o jogo). A 1ª partida fica na borda esquerda
    // e a ÚLTIMA na borda DIREITA — o fim do gráfico É a última partida (as pontas e
    // o hover do último jogo caem no mesmo x).
    const gap = K > 1 ? (x1 - x0) / (K - 1) : 0;
    const xAt = (k) => K > 1 ? x0 + k * gap : x1;
    const ramp = Math.min(13, gap * 0.26);   // transição curta entre jogos (suaviza o degrau)
    // escala Y em 2 trechos: núcleo linear [rLo..rHi]→[PADt..yCore]; rodapé
    // comprimido [rHi..deepHi]→[yCore..base] (mantém ordem, sem achatar idêntico).
    const yAt = (p) => p <= rHi
      ? PADt + (p - rLo) / coreSpan * (yCore - PADt)
      : yCore + (p - rHi) / Math.max(1, deepHi - rHi) * (PADt + plotH - yCore);
    const rowH = (yCore - PADt) / coreSpan;   // altura de uma posição no núcleo

    let g = '';
    stageBands(matches, steps, xAt, x0, x1).forEach((b, bi) => {
      if (bi % 2 === 1) g += `<rect class="rc-band" x="${b.x.toFixed(1)}" y="4" width="${b.w.toFixed(1)}" height="${(plotH + PADt - 4).toFixed(1)}"/>`;
      if (b.w > 64) g += `<text class="rc-band-lbl" x="${(b.x + b.w / 2).toFixed(1)}" y="15" text-anchor="middle">${escapeHtml(b.label)}</text>`;
    });
    if (hasDeep) {
      g += `<rect class="rc-deepband" x="${x0}" y="${yCore.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(PADt + plotH - yCore).toFixed(1)}"/>`;
      // sinaliza a QUEBRA DE ESCALA (o rodapé não é linear como o núcleo)
      if (x1 - x0 > 230) g += `<text class="rc-band-lbl rc-deep-lbl" x="${(x0 + 8).toFixed(1)}" y="${(yCore + 13).toFixed(1)}">INÍCIO DA COPA · ESCALA COMPRIMIDA</text>`;
    }
    // divisórias verticais ALINHADAS ÀS PARTIDAS: uma tracejada por jogo, passando
    // pelo MEIO do patamar daquele jogo (onde o rótulo "Jogo N" e o hover caem). As
    // transições (degraus) ficam ENTRE as tracejadas; dá pra ler a classificação de
    // cada partida no cruzamento das linhas com a tracejada.
    if (gap > 16) for (let k = 0; k < K; k++) {
      const xb = xAt(k).toFixed(1);
      g += `<line class="rc-vgrid" x1="${xb}" y1="${PADt}" x2="${xb}" y2="${(PADt + plotH).toFixed(1)}"/>`;
    }
    // grade dinâmica guiada por PIXELS: como a altura escala com o núcleo, cada
    // posição costuma ter ~rowH px → rotula UMA linha por posição (1º, 2º, 3º…);
    // só rareia (de 2 em 2…) se a altura bateu no teto e as linhas apertaram.
    const yStep = Math.max(1, Math.round(16 / Math.max(1, rowH)));
    for (let p = rLo; p <= rHi; p += yStep) {
      g += `<line class="rc-grid" x1="${x0}" y1="${yAt(p).toFixed(1)}" x2="${x1}" y2="${yAt(p).toFixed(1)}"/>`;
      g += `<text class="rc-ylbl" x="${PADl - 4}" y="${(yAt(p) + 4).toFixed(1)}" text-anchor="end">${p}º</text>`;
    }
    if (hasDeep) {
      // separador do núcleo + algumas marcas DENTRO da faixa comprimida (pra não
      // virar um vão vazio) — passo maior porque ali as posições estão espremidas.
      g += `<line class="rc-grid rc-grid-deep" x1="${x0}" y1="${yCore.toFixed(1)}" x2="${x1}" y2="${yCore.toFixed(1)}"/>`;
      const deepStep = Math.max(1, Math.round((deepHi - rHi) / 3));
      for (let p = rHi + deepStep; p < deepHi; p += deepStep) {
        g += `<line class="rc-grid rc-grid-deep" x1="${x0}" y1="${yAt(p).toFixed(1)}" x2="${x1}" y2="${yAt(p).toFixed(1)}"/>`;
        g += `<text class="rc-ylbl rc-ylbl-deep" x="${PADl - 4}" y="${(yAt(p) + 4).toFixed(1)}" text-anchor="end">${p}º</text>`;
      }
      g += `<line class="rc-grid rc-grid-deep" x1="${x0}" y1="${yAt(deepHi).toFixed(1)}" x2="${x1}" y2="${yAt(deepHi).toFixed(1)}"/>`;
      g += `<text class="rc-ylbl rc-ylbl-deep" x="${PADl - 4}" y="${(yAt(deepHi) + 4).toFixed(1)}" text-anchor="end">${deepHi}º</text>`;
    }
    const tight = chartW < 380;
    const nx = granKey === 'semana' ? K : Math.min(tight ? 4 : 6, K);
    for (let k0 = 0; k0 < nx; k0++) {
      const k = nx <= 1 ? K - 1 : Math.round(k0 * (K - 1) / (nx - 1));
      // nx===1 (semana com 1 jogo): o único rótulo cai na borda DIREITA — testa
      // o caso 'end' primeiro, senão sairia com anchor 'start' e seria clipado.
      const anchor = k0 === nx - 1 ? 'end' : k0 === 0 ? 'start' : 'middle';
      const lbl = granKey === 'jogo'
        ? (tight ? `J${steps[k] + 1}` : `Jogo ${steps[k] + 1}`)
        : (tight ? `S${k + 1}` : `Semana ${k + 1}`);
      g += `<text class="rc-xlbl" x="${xAt(k).toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="${anchor}">${lbl}</text>`;
    }

    let foc = '';
    // STEP com rampa: patamar reto na célula (jogo) + transição curta na borda.
    const lineOf = (i) => {
      let pts = '';
      for (let k = 0; k < K; k++) {
        const y = yAt(pos[i][steps[k]]).toFixed(1);
        const L = (k === 0 ? x0 : xAt(k) - gap / 2 + ramp).toFixed(1);
        const R = (k === K - 1 ? x1 : xAt(k) + gap / 2 - ramp).toFixed(1);
        pts += `${L},${y} ${R},${y} `;
      }
      return pts.trim();
    };
    ids.forEach(i => {
      foc += `<polyline class="rc-foc${series[i].userId === meId ? ' me' : ''}" data-i="${i}" stroke="${colorOf(i)}" style="--glow:${colorOf(i)}" points="${lineOf(i)}"/>`;
    });
    // Pontas explícitas: bolinha no FIM de cada linha (= posição atual). Some no
    // hover (dão lugar às bolinhas que seguem o cursor) e volta ao sair do gráfico.
    let endDots = '';
    ids.forEach(i => {
      endDots += `<circle class="rc-enddot${series[i].userId === meId ? ' me' : ''}" cx="${x1.toFixed(1)}" cy="${yAt(pos[i][lastStep]).toFixed(1)}" r="${series[i].userId === meId ? 4.6 : 3.8}" fill="${colorOf(i)}" style="--glow:${colorOf(i)}"/>`;
    });

    body.className = 'rc-body rc-main';
    body.style.gridTemplateColumns = stack ? '1fr' : `1fr ${panW}px`;
    body.innerHTML = `
      <div class="rc-chartwrap">
        <svg class="rc-svg" width="${chartW}" height="${H}" viewBox="0 0 ${chartW} ${H}" role="img" tabindex="0"
             aria-label="Evolução da posição no ranking ao longo da Copa — use as setas esquerda e direita pra percorrer os jogos">
          ${g}
          <g>${foc}</g>
          <g class="rc-enddots">${endDots}</g>
          <line class="rc-cross" x1="0" y1="${PADt}" x2="0" y2="${(PADt + plotH).toFixed(1)}" hidden/>
          <g class="rc-hover"></g>
          <rect class="rc-hit" x="${x0}" y="${PADt}" width="${Math.max(0, x1 - x0)}" height="${plotH}" fill="transparent"/>
        </svg>
      </div>
      <div class="rc-panel">
        <div class="rc-pan-h" aria-live="polite"></div>
        <div class="rc-pan-list" style="height:${n * PAN_ROW}px"></div>
      </div>
    `;

    const panRows = buildPanel(body, ids);
    updatePanel(panRows, ids, GAMES - 1, -1, false);
    attachHover(body, { steps, K, xAt, yAt, x0, x1, gap, H, plotH, PADt, rowH, ids, panRows });
  }

  // painel persistente — cria as linhas uma vez por draw, depois só reposiciona
  function buildPanel(body, ids) {
    const list = body.querySelector('.rc-pan-list');
    const rows = new Map();
    ids.forEach(i => {
      const el = document.createElement('div');
      el.className = 'rc-pan-row';
      if (series[i].userId === meId) el.classList.add('me');   // mesma âncora visual do mobile
      el.dataset.i = i;
      list.appendChild(el);
      rows.set(i, el);
    });
    return rows;
  }

  function updatePanel(rows, ids, gi, hotI, hovering) {
    const steps = activeSteps();
    const k = steps.indexOf(gi);
    // ponto ANTERIOR no gráfico → base do "ganhou X pts / subiu N posições".
    // No 1º ponto da semana (jogo) caímos no jogo anterior (gi-1) p/ ainda mostrar.
    // Em repouso (gi = último jogo) o k pode nem estar nos steps (semana passada
    // aberta no ‹ ›) — aí a base também é o jogo anterior.
    const prevGi = k > 0 ? steps[k - 1] : (gi > 0 && (granKey === 'jogo' || k === -1) ? gi - 1 : -1);
    const order = [...ids].sort((a, b) => pos[a][gi] - pos[b][gi]);
    order.forEach((idx, r) => {
      const i = idx;
      const el = rows.get(i);
      if (!el) return;
      el.style.top = `${r * PAN_ROW}px`;
      el.style.borderColor = colorOf(i);
      el.classList.toggle('hot', hovering && i === hotI);
      const nm = series[i].userId === meId ? 'Você' : series[i].name;
      // movimento desde o último ponto: Δ posição (▲/▼) + Δ pontos. Também em
      // REPOUSO (era só no hover): a pergunta nº 1 — "o que mudou?" — ganha
      // resposta de cara, sem exigir descobrir o hover.
      let mv = '';
      if (prevGi >= 0) {
        const dPts = (series[i].values[gi + 1] ?? 0) - (series[i].values[prevGi + 1] ?? 0);
        const dPos = pos[i][prevGi] - pos[i][gi];   // + = subiu
        const mc = dPos > 0 ? 'var(--positive)' : dPos < 0 ? 'var(--red)' : 'var(--text-mute)';
        const pt = dPos > 0 ? `▲${dPos}` : dPos < 0 ? `▼${-dPos}` : '–';
        const aria = dPos > 0 ? `subiu ${dPos} posiç${dPos === 1 ? 'ão' : 'ões'}, ganhou ${dPts} pontos`
          : dPos < 0 ? `caiu ${-dPos} posiç${dPos === -1 ? 'ão' : 'ões'}, ganhou ${dPts} pontos`
          : `manteve a posição, ganhou ${dPts} pontos`;
        mv = `<span role="img" aria-label="${aria}" style="display:inline-flex;flex-direction:column;align-items:flex-end;line-height:1.04">
          <span style="font-size:11px;font-weight:800;color:${mc};font-variant-numeric:tabular-nums">${pt}</span>
          <span style="font-size:10px;font-weight:700;color:var(--text-mute);font-variant-numeric:tabular-nums">+${dPts}</span>
        </span>`;
      }
      el.innerHTML = `
        <span class="rc-pan-pos">${pos[i][gi]}º</span>
        ${avatarChip(series[i], 'sm')}
        <span class="rc-pan-nm" style="color:${i === hotI && hovering ? colorOf(i) : 'var(--text)'}">${escapeHtml(nm)}</span>
        <span style="display:inline-flex;align-items:center;gap:8px;justify-content:flex-end;min-width:52px">
          ${mv}<span class="rc-pan-pt" style="color:${colorOf(i)}">${series[i].values[gi + 1] ?? 0}</span>
        </span>`;
    });
    const h = mount.querySelector('.rc-pan-h');
    if (h) {
      h.innerHTML = hovering
        ? (granKey === 'jogo'
            ? `<span class="rc-pan-k">Jogo ${gi + 1}</span>${matchHeader(matches[gi])}`
            : `<span class="rc-pan-k">Semana ${k + 1} · ${tl.weekRange(k)}</span>`)
        : `<span class="rc-pan-k">Classificação atual</span><span class="rc-pan-hint">← passe o mouse ou use as setas</span>`;
    }
  }

  function attachHover(body, geo) {
    const svg = body.querySelector('.rc-svg');
    const hit = body.querySelector('.rc-hit');
    const cross = body.querySelector('.rc-cross');
    const hover = body.querySelector('.rc-hover');
    const endg = body.querySelector('.rc-enddots');
    if (!svg || !hit) return;
    const focLines = svg.querySelectorAll('.rc-foc');
    const setHot = (i) => focLines.forEach(pl => {
      const on = +pl.dataset.i === i && i >= 0;
      pl.classList.toggle('hot', on);
      pl.classList.toggle('dim', i >= 0 && !on);
    });

    // Memo do último (jogo, linha): mousemove chega a dezenas de eventos/s e o
    // rebuild do painel (innerHTML + <img> de avatar por linha) a cada pixel
    // engasgava máquinas fracas — só refaz DOM quando o alvo de fato muda.
    let lastK = -1, lastHot = -2;

    function showStep(k, hotI) {
      if (k === lastK && hotI === lastHot) return;
      lastK = k; lastHot = hotI;
      const gi = geo.steps[k];
      const xpx = geo.xAt(k);

      if (endg) endg.style.display = 'none';
      cross.removeAttribute('hidden');
      cross.setAttribute('x1', xpx.toFixed(1));
      cross.setAttribute('x2', xpx.toFixed(1));
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

    function move(e) {
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const { x: cx, y: cy } = pointXY(e);
      const vw = svg.viewBox.baseVal.width || box.width;
      const vh = svg.viewBox.baseVal.height || box.height;
      const xv = (cx - box.left) / box.width * vw;
      const yv = (cy - box.top) / box.height * vh;
      const k = geo.gap ? clamp(Math.round((xv - geo.x0) / geo.gap), 0, geo.K - 1) : 0;
      const gi = geo.steps[k];
      let hotI = -1, hotD = Infinity;
      geo.ids.forEach(i => { const d = Math.abs(geo.yAt(pos[i][gi]) - yv); if (d < hotD) { hotD = d; hotI = i; } });
      if (hotD > geo.rowH * 1.1 + 6) hotI = -1;
      showStep(k, hotI);
    }

    function leave() {
      lastK = -1; lastHot = -2;
      if (endg) endg.style.display = '';
      cross.setAttribute('hidden', '');
      while (hover.firstChild) hover.removeChild(hover.firstChild);
      setHot(-1);
      updatePanel(geo.panRows, geo.ids, GAMES - 1, -1, false);
    }

    hit.addEventListener('mousemove', move);
    hit.addEventListener('mouseleave', leave);
    // Touch: arrastar explora; SOLTAR mantém o jogo "pinado" no painel (só as
    // bolinhas de ponta e o realce voltam) — antes o leave() no touchend fazia
    // a info sumir junto com o dedo. touchcancel (gesto do SO, notificação)
    // restaura tudo — sem ele o gráfico ficava preso no estado de hover.
    hit.addEventListener('touchstart', move, { passive: true });
    hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('touchend', () => {
      if (endg) endg.style.display = '';
      setHot(-1);
      lastHot = -2;
    }, { passive: true });
    hit.addEventListener('touchcancel', leave, { passive: true });

    // Teclado: ← → percorrem os jogos, Home/End vão às pontas, Esc solta.
    svg.addEventListener('keydown', (e) => {
      const cur = lastK >= 0 ? lastK : geo.K;   // 1º ← já cai no último jogo
      let k = null;
      if (e.key === 'ArrowLeft') k = Math.max(0, cur - 1);
      else if (e.key === 'ArrowRight') k = Math.min(geo.K - 1, lastK >= 0 ? cur + 1 : geo.K - 1);
      else if (e.key === 'Home') k = 0;
      else if (e.key === 'End') k = geo.K - 1;
      else if (e.key === 'Escape') { leave(); return; }
      if (k == null) return;
      e.preventDefault();
      showStep(k, -1);
    });
    svg.addEventListener('blur', leave);

    // Ponte painel → gráfico (antes só existia na direção oposta): pousar numa
    // linha do painel acende a polyline correspondente.
    geo.panRows.forEach((el, i) => {
      el.addEventListener('mouseenter', () => { setHot(i); el.classList.add('hot'); });
      el.addEventListener('mouseleave', () => { setHot(-1); el.classList.remove('hot'); });
    });
  }

  // ===== MOBILE: lista de sparklines (uma trajetória por jogador) =====
  function drawMobile(body) {
    const ids = [...selected].map(uid => byId.get(uid)).filter(i => i != null).sort((a, b) => finalPos(a) - finalPos(b));
    // A sparkline mostra a JORNADA INTEIRA (todos os jogos). O toggle só muda a
    // base da EVOLUÇÃO (▲/▼): "Por semana" = vs o fim da semana passada;
    // "Último jogo" = vs o jogo anterior. (Decisão 2026-06-15.)
    const weekBase = granKey === 'semana' && validWeeks.length >= 2;
    const dFrom = weekBase
      ? tl.weekEnds[validWeeks[validWeeks.length - 2]]   // fim da semana passada COM jogo
      : Math.max(0, GAMES - 2);
    const baseTxt = weekBase ? 'vs semana passada' : 'vs jogo anterior';

    body.className = 'rc-body rc-sparks';
    body.style.gridTemplateColumns = '';
    if (ids.length === 0) { body.innerHTML = ''; return; }

    // A base do ▲/▼ fica COLADA na coluna dos deltas (a explicação no rodapé,
    // depois da legenda, ficava longe demais de quem ela explica).
    body.innerHTML = `<div class="rc-spark-cap" aria-hidden="true">▲▼ ${baseTxt}</div>` + ids.map(i => {
      const c = colorOf(i);
      const nm = series[i].userId === meId ? 'Você' : series[i].name;
      // Corta o "ruído de empate" do começo da Copa (mesma razão do eixo enxuto
      // do desktop): a sparkline começa onde o jogador já saiu do pelotão —
      // senão o domínio Y era dominado por posições que eram só desempate.
      const from = firstMeaningfulGame(series, i);
      const ps = [];
      for (let g = from; g < GAMES; g++) ps.push(pos[i][g]);
      const Kp = ps.length;
      const lo = Math.min(...ps), hi = Math.max(...ps);
      const W = 92, Hs = 30, pad = 3;
      const xA = (k) => Kp <= 1 ? W / 2 : pad + (W - 2 * pad) * k / (Kp - 1);
      const yA = (p) => hi === lo ? Hs / 2 : pad + (Hs - 2 * pad) * (p - lo) / (hi - lo);  // 1º no topo
      const pts = ps.map((p, k) => `${xA(k).toFixed(1)},${yA(p).toFixed(1)}`).join(' ');
      const now = pos[i][GAMES - 1], then = pos[i][dFrom];
      const d = then - now;                       // subiu = positivo
      // A linha fica na COR DO JOGADOR (igual desktop/legenda) — pintar a
      // jornada inteira de verde/vermelho pelo delta do último jogo mentia
      // sobre o trajeto. O sinal de subiu/caiu mora só no chip ▲/▼.
      const sparkC = c;
      const dCls = d > 0 ? 'up' : d < 0 ? 'dn' : 'eq';
      const dTxt = d > 0 ? `▲ ${d}` : d < 0 ? `▼ ${-d}` : '–';
      const dAria = d > 0 ? `subiu ${d} posiç${d === 1 ? 'ão' : 'ões'} ${baseTxt}`
        : d < 0 ? `caiu ${-d} posiç${d === -1 ? 'ão' : 'ões'} ${baseTxt}`
        : 'manteve a posição';
      return `
        <div class="rc-spark-row${series[i].userId === meId ? ' me' : ''}">
          <span class="rc-spark-pos" style="color:${c}">${pos[i][GAMES - 1]}º</span>
          ${avatarChip(series[i], 'sm')}
          <div class="rc-spark-nm">${escapeHtml(nm)}<small>${finalPts(i)} pts</small></div>
          <svg class="rc-spark-svg" width="${W}" height="${Hs}" viewBox="0 0 ${W} ${Hs}" aria-hidden="true">
            <polyline fill="none" stroke="${sparkC}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>
            <circle cx="${xA(Kp - 1).toFixed(1)}" cy="${yA(now).toFixed(1)}" r="2.6" fill="${sparkC}"/>
          </svg>
          <span class="rc-spark-d ${dCls}" role="img" aria-label="${dAria}">${dTxt}</span>
        </div>`;
    }).join('');
  }

  // ---------------------------------------------------------
  function renderLegend() {
    // Colapsada por padrão: só os SELECIONADOS (o que está no gráfico) + o botão
    // pra expandir o elenco inteiro. Quem quiser trocar, expande e escolhe.
    const ids = showAllLeg
      ? series.map(s => s.userId)
      : [...selected];
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

    // Chip ativo: Favoritos é por MODO (a seleção pode até coincidir com um
    // preset); Pódio/Top 10 seguem por igualdade de conjunto — mas nunca junto
    // com o modo Favoritos ativo.
    mount.querySelectorAll('.rc-presets .rc-chip').forEach(b => {
      const on = b.dataset.p === 'fav' ? favMode : !favMode && setsEq(selected, presetSet(b.dataset.p));
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
    const favCt = mount.querySelector('.rc-chip[data-p="fav"] .rc-chip-ct');
    if (favCt) { favCt.hidden = favs.size === 0; favCt.textContent = favs.size; }
    mount.querySelectorAll('.rc-seg button').forEach(b => {
      const on = b.dataset.g === granKey;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    });

    mount.querySelectorAll('.rc-leg[data-user]').forEach(btn => btn.addEventListener('click', () => {
      const uid = btn.dataset.user;
      if (favMode) {
        // Com Favoritos ativo, a legenda EDITA o grupo (e já persiste) — sem
        // tela de edição à parte: ligar/desligar um nome é adicionar/remover.
        if (favs.has(uid)) favs.delete(uid); else favs.add(uid);
        saveFavs();
        selected = new Set(favs);
      } else {
        if (selected.has(uid)) selected.delete(uid); else selected.add(uid);
      }
      draw();
    }));
    mount.querySelector('[data-action="toggle-all"]').addEventListener('click', () => {
      showAllLeg = !showAllLeg;
      draw();
    });
  }

  function renderNote() {
    const narrow = (mount.querySelector('.rc-body')?.clientWidth || 999) < NARROW;
    const tap = narrow ? 'Toque' : 'Clique';
    mount.querySelector('.rc-note').textContent =
      favMode
        ? (favs.size <= 1
            ? `Monte seu grupo: ${tap.toLowerCase()} nos nomes abaixo pra adicionar aos Favoritos — a seleção fica salva pra próxima visita (neste navegador).`
            : `Seus Favoritos (${favs.size}) — ${tap.toLowerCase()} nos nomes pra adicionar ou remover; fica salvo pra próxima visita.`)
        : selected.size === 0
        ? 'Ninguém selecionado — clique num nome abaixo ou use Pódio + Você / Top 10 pra recomeçar.'
        : narrow
        ? (granKey === 'semana'
            ? 'Trajetória de cada um na Copa. ▲/▼ = posições ganhas/perdidas desde a semana passada. Toque num nome pra ligar/desligar.'
            : 'Trajetória de cada um na Copa. ▲/▼ = o que mexeu no último jogo. Toque num nome pra ligar/desligar.')
        : granKey === 'semana'
        ? 'Uma etapa por semana. Passe o mouse (ou use as setas ← →): o painel vira o jogo apontado. Clique num nome pra ligar/desligar.'
        : `Jogo a jogo da semana ${weekView + 1} (${tl.weekRange(weekView)}) — ‹ › troca a semana; passe o mouse ou use ← → pra ver cada partida.`;
  }

  function attachStatic() {
    mount.querySelectorAll('.rc-presets .rc-chip').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.p === 'fav') {
        favMode = true;
        if (favs.size === 0) {
          // Primeira vez: semente = você, e abre o elenco inteiro pra montar o
          // grupo na hora (senão a legenda colapsada só mostraria 1 nome).
          if (meIdx >= 0) favs.add(meId);
          saveFavs();
          showAllLeg = true;
        }
        selected = new Set(favs);
      } else {
        favMode = false;
        selected = presetSet(b.dataset.p);
      }
      saveMode(favMode ? 'fav' : null);
      draw();
    }));
    mount.querySelectorAll('.rc-seg button').forEach(b => b.addEventListener('click', () => {
      if (b.disabled || b.dataset.g === granKey) return;
      granKey = b.dataset.g;
      if (granKey === 'jogo') weekView = lastWeek;   // reabre na semana corrente
      saveGran(granKey);
      draw();
    }));
    mount.querySelectorAll('.rc-weeknav .rc-wk').forEach(b => b.addEventListener('click', () => {
      const iv = validWeeks.indexOf(weekView) + Number(b.dataset.wk);
      if (iv < 0 || iv >= validWeeks.length) return;
      weekView = validWeeks[iv];
      draw();
    }));
  }
}

// ============================================================
// Dashboard da jornada — widgets ao redor do gráfico (tela Início)
// ============================================================
// Fase 1 da proposta (docs: memória jornada-dashboard-proposal): 5 widgets que
// são só aritmética sobre dados que a home JÁ carrega — v_leaderboard,
// v_pool_stats e as séries do replay (progression.js). Nenhum fetch novo.
//
//  • Escada do ranking   — vizinhos de cima/baixo com gap e cenário concreto
//  • Ultrapassagens      — quem cruzou com você desde o dia anterior
//  • Funil de acertos    — cravada → venc.+saldo → vencedor → parcial → zero
//  • Você vs a média     — pts/jogo, cravadas e total contra o bolão
//  • O que te separa do líder — gap decomposto por pilar de pontuação
//
// Módulo em duas camadas: funções de CÁLCULO puras (exportadas, testáveis) e
// render por template string, no padrão das outras páginas. O caller decide
// onde montar; falha aqui não pode derrubar o gráfico (try/catch no caller).

import { escapeHtml, avatarHtml } from './util.js';
import { sortLeaderboard, assignRanksAndPrizes, tiedPair } from './prize.js';
import { matchPoints } from './scoring.js';
import { buildTimeline } from './chart-utils.js';

// Tiers do funil, na ordem do modelo aditivo (melhor → pior). As colunas são
// os contadores mutuamente exclusivos do v_leaderboard.
const FUNNEL_TIERS = [
  { key: 'exact_count', label: 'Cravadas', cls: 't-exact' },
  { key: 'winner_sg_count', label: 'Venc.+saldo', cls: 't-vs' },
  { key: 'winner_count', label: 'Vencedor', cls: 't-v' },
  { key: 'side_count', label: 'Parcial', cls: 't-side' },
  { key: 'miss_count', label: 'Zero', cls: 't-miss' },
];

// Pilares do total_pts, na ordem exibida (espelha as colunas do v_leaderboard).
const PILLARS = [
  { key: 'match_pts', label: 'palpites' },
  { key: 'qualifier_pts', label: 'vagas' },
  { key: 'scorer_pts', label: 'artilheiro' },
  { key: 'champion_pts', label: 'campeão' },
];

// Gordura mínima (pts) pra quem vem atrás não ser ameaça.
const THREAT_GAP = 2;

const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1).replace('.', ',');

// ============================================================
// Cálculo (puro)
// ============================================================

/**
 * Cenário concreto que fecha um gap de pontos na fase dada: o feito único mais
 * barato que ULTRAPASSA (não só empata) o vizinho de cima.
 *  - resultado certo (ave) só passa se sobrar ponto (gap < ave): empate em pts
 *    não vira posição — o desempate nº 2 é cravada, que o ave não bumpa;
 *  - cravada (2*ag+ave+dg) com gap < exact passa com sobra; no empate exato
 *    de pontos (gap == exact) só passa se a MINHA cravada a mais vencer o
 *    desempate de exact_count contra o contador do rival — senão é só empate.
 * @returns {string|null} rótulo pronto, ou null sem fase (copa encerrada)
 */
export function ladderScenario(gap, stage, myExacts = 0, rivalExacts = 0, myWsg = 0, rivalWsg = 0) {
  if (!stage) return null;
  const p = matchPoints(stage);
  // gap == ave: empata em pontos SEM bumpar cravada — mas se EU já tenho mais
  // cravadas, o desempate nº 2 é meu e o resultado certo basta
  if (gap < p.ave || (gap === p.ave && myExacts > rivalExacts)) {
    return `1 resultado certo (${p.ave} pts) e você passa`;
  }
  if (gap < p.exact) return `1 cravada (${p.exact} pts) e você passa`;
  if (gap === p.exact) {
    // empate em pontos: cravada bumpa SÓ exact_count (tiers exclusivos);
    // se empatar também nas cravadas, decide a 3ª chave (venc.+saldo)
    const passes = myExacts + 1 > rivalExacts
      || (myExacts + 1 === rivalExacts && myWsg > rivalWsg);
    return passes
      ? `1 cravada (${p.exact} pts) e você passa`
      : `1 cravada (${p.exact} pts) só empata — desempate: cravadas`;
  }
  return `faltam ${gap} pts pra alcançar`;
}

/**
 * Escada do ranking: até 2 vizinhos acima e 1 abaixo, com gap de pontos e o
 * cenário pra passar cada um. Ordena com o desempate canônico do bolão
 * (prize.sortLeaderboard) e numera por competição (1224) — mesma posição da
 * página Ranking, que pode diferir da posição "só por pontos" dos KPIs.
 * @param {Array} rows linhas do v_leaderboard
 * @param {string} meId
 * @param {string|null} stage fase do próximo jogo (cenários); null = sem cenário
 * @returns {{rungs:Array}|null} null se o usuário não está no ranking
 */
export function buildLadder(rows, meId, stage) {
  // clona antes: assignRanksAndPrizes muta e as linhas são compartilhadas
  const sorted = assignRanksAndPrizes(sortLeaderboard(rows).map(r => ({ ...r })), []);
  const meIdx = sorted.findIndex(r => r.user_id === meId);
  if (meIdx < 0) return null;
  const my = sorted[meIdx];

  const rungs = [];
  for (const j of [meIdx - 2, meIdx - 1]) {
    if (j < 0) continue;
    const r = sorted[j];
    const gap = (r.total_pts ?? 0) - (my.total_pts ?? 0);
    rungs.push({
      user_id: r.user_id, name: r.full_name, pos: r.pos, pts: r.total_pts ?? 0,
      gap: -gap, me: false, threat: false,
      scenario: ladderScenario(gap, stage, my.exact_count ?? 0, r.exact_count ?? 0,
        my.winner_sg_count ?? 0, r.winner_sg_count ?? 0),
    });
  }
  rungs.push({
    user_id: my.user_id, name: my.full_name, pos: my.pos, pts: my.total_pts ?? 0,
    gap: 0, me: true, threat: false, scenario: null,
  });
  if (meIdx + 1 < sorted.length) {
    const r = sorted[meIdx + 1];
    const gap = (my.total_pts ?? 0) - (r.total_pts ?? 0);
    rungs.push({
      user_id: r.user_id, name: r.full_name, pos: r.pos, pts: r.total_pts ?? 0,
      gap, me: false, threat: gap <= THREAT_GAP, scenario: null,
    });
  }
  return { rungs, isLeader: meIdx === 0 };
}

/**
 * Ultrapassagens entre o penúltimo dia de jogos e agora: quem estava atrás e
 * passou (passedMe) e quem você deixou pra trás (iPassed). Mesma janela do
 * "Δ desde ontem" do gráfico (últimos dois dayEnds do buildTimeline).
 *
 * Cruzamento exige inversão ESTRITA da relação de PONTOS nas duas pontas.
 * Empate em qualquer ponta não gera afirmação: no passado os contadores de
 * desempate daquele momento não existem mais (computePositions chutaria a
 * ordem do ranking ATUAL), e no presente empate verdadeiro = mesma posição —
 * dizer "Fulano te passou" contradiria a Escada/Ranking ao lado.
 * @param {Array} series séries do replay (values[g+1] = pts após o jogo g)
 * @param {Array} matches jogos finalizados, asc por data
 * @param {string} meId
 * @returns {{hasWindow:boolean, passedMe:Array, iPassed:Array}|null}
 */
export function computeOvertakes(series, matches, meId) {
  const meIdx = series.findIndex(s => s.userId === meId);
  const GAMES = matches.length;
  if (meIdx < 0 || GAMES === 0) return null;

  const tl = buildTimeline(matches);
  if (tl.dayEnds.length < 2) {
    return { hasWindow: false, passedMe: [], iPassed: [], myDayPts: 0, windowLabel: null };
  }

  const prevG = tl.dayEnds[tl.dayEnds.length - 2];
  const curG = GAMES - 1;
  const rel = (s, g) => Math.sign((s.values[g + 1] ?? 0) - (series[meIdx].values[g + 1] ?? 0));

  const passedMe = [], iPassed = [];
  series.forEach((s, i) => {
    if (i === meIdx) return;
    const before = rel(s, prevG), after = rel(s, curG);
    if (before === 0 || after === 0 || before === after) return;
    const dayPts = (s.values[curG + 1] ?? 0) - (s.values[prevG + 1] ?? 0);
    const entry = { userId: s.userId, name: s.name, avatar_url: s.avatar_url, dayPts };
    (after > 0 ? passedMe : iPassed).push(entry);
  });
  // quem fez mais pontos no dia aparece primeiro (é a "explicação" do cruzamento)
  passedMe.sort((a, b) => b.dayPts - a.dayPts);
  iPassed.sort((a, b) => b.dayPts - a.dayPts);
  const myDayPts = (series[meIdx].values[curG + 1] ?? 0) - (series[meIdx].values[prevG + 1] ?? 0);
  // rótulo do ÚLTIMO dia com jogo finalizado — a janela cobre exatamente os
  // jogos desse dia; "ontem" mentiria em dia de folga ou com rodada em curso
  return { hasWindow: true, passedMe, iPassed, myDayPts, windowLabel: tl.dayLabel(tl.dayEnds.length - 1) };
}

/**
 * Funil de acertos do usuário a partir dos contadores do v_leaderboard.
 * @returns {{segments:Array<{label,count,cls}>, total:number}}
 */
export function buildFunnel(standing) {
  const segments = FUNNEL_TIERS.map(t => ({
    label: t.label, cls: t.cls, count: standing?.[t.key] ?? 0,
  }));
  return { segments, total: segments.reduce((a, s) => a + s.count, 0) };
}

/**
 * Você vs a média do bolão (média inclui você — é a média do bolão, não "dos
 * outros"). pts/jogo divide pelos jogos FINALIZADOS do torneio: quem não
 * palpitou um jogo dilui a própria média, e é isso mesmo — ponto perdido.
 * `behind` = jogadores ESTRITAMENTE atrás no desempate canônico (empatados
 * de verdade não contam — dizer que você está "à frente" deles seria mentira).
 */
export function buildVsAverage(rows, meId, finishedMatches) {
  const me = rows.find(r => r.user_id === meId);
  if (!me || rows.length === 0) return null;
  const n = rows.length;
  const avg = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0) / n;
  const g = Math.max(1, finishedMatches ?? 0);

  const sorted = sortLeaderboard(rows);
  let endOfTie = sorted.findIndex(r => r.user_id === meId);
  while (endOfTie + 1 < n && tiedPair(sorted[endOfTie + 1], me)) endOfTie++;
  return {
    metrics: [
      { label: 'pts/jogo', mine: (me.total_pts ?? 0) / g, avg: avg('total_pts') / g, decimals: 1 },
      { label: 'cravadas', mine: me.exact_count ?? 0, avg: avg('exact_count'), decimals: 1 },
      { label: 'total', mine: me.total_pts ?? 0, avg: avg('total_pts'), decimals: 0 },
    ],
    behind: n - 1 - endOfTie,
  };
}

/**
 * Gap pro rival de referência decomposto por pilar: o líder — ou o vice,
 * quando o líder é VOCÊ. Convenção única nos dois modos:
 * delta = rival − eu (positivo = ele na frente naquele pilar → vermelho;
 * negativo = você na frente → verde). gapTotal segue a mesma regra.
 */
export function buildLeaderGap(rows, meId) {
  const sorted = sortLeaderboard(rows);
  const me = sorted.find(r => r.user_id === meId);
  if (!me || sorted.length === 0) return null;
  const isLeader = sorted[0].user_id === meId;
  const other = isLeader ? sorted[1] ?? null : sorted[0];
  if (!other) return { isLeader: true, other: null, pillars: [], gapTotal: 0 };

  const pillars = PILLARS.map(p => ({
    label: p.label,
    delta: (other[p.key] ?? 0) - (me[p.key] ?? 0),
  }));
  return {
    isLeader,
    other: { name: other.full_name, pts: other.total_pts ?? 0 },
    pillars,
    gapTotal: (other.total_pts ?? 0) - (me.total_pts ?? 0),
  };
}

// ============================================================
// Render
// ============================================================

function avatarChip(entry) {
  return `<span class="jd-av">${avatarHtml({ full_name: entry.name, avatar_url: entry.avatar_url })}</span>`;
}

function renderLadder(ladder, avatarOf) {
  if (!ladder) return '';
  const rows = ladder.rungs.map(r => {
    const who = { name: r.name, avatar_url: avatarOf(r.user_id) };
    // gap 0 = empatado em pontos (rival acima/abaixo só pelo desempate):
    // "+0" verde leria como gordura sobre quem pode estar NA SUA FRENTE
    const gap = r.me ? `<b>${r.pts}</b>`
      : r.gap < 0 ? `${r.pts} · <span class="dn">${r.gap}</span>`
      : r.gap > 0 ? `${r.pts} · <span class="up">+${r.gap}</span>`
      : `${r.pts} · <span class="jd-tied">empate</span>`;
    return `
      <div class="jd-rung ${r.me ? 'me' : ''}">
        <span class="jd-rank">${r.pos}º</span>
        ${avatarChip(who)}
        <span class="jd-who">${escapeHtml(r.me ? 'Você' : r.name)}</span>
        <span class="jd-gap">${gap}</span>
        ${r.threat ? '<span class="jd-threat">na sua cola</span>' : ''}
      </div>
      ${r.scenario ? `<div class="jd-scenario">${escapeHtml(r.scenario)}</div>` : ''}`;
  }).join('');
  const crown = ladder.isLeader ? '<div class="jd-hint">👑 Você é o líder do bolão</div>' : '';
  return `
    <div class="jd-card">
      <h4 class="jd-h">Escada do ranking</h4>
      ${crown}
      <div class="jd-ladder">${rows}</div>
    </div>`;
}

function renderOvertakes(ot) {
  if (!ot) return '';
  const line = (cls, arrow, label, list, extra) => {
    const faces = list.slice(0, 4).map(avatarChip).join('');
    const names = list.slice(0, 2).map(e => escapeHtml(e.name)).join(', ')
      + (list.length > 2 ? ` +${list.length - 2}` : '');
    const hint = list.length
      ? `${names}${extra}`
      : cls === 'dn' ? 'ninguém — ufa' : 'ninguém — marasmo';
    return `
      <div class="jd-swap">
        <span class="jd-swap-dir ${cls}">${arrow} ${label}</span>
        <span class="jd-swap-avs">${faces}</span>
        <span class="jd-swap-names">${hint}</span>
      </div>`;
  };
  // na linha "Te passaram" a explicação é o dia do RIVAL; na "Você passou",
  // os SEUS pontos — destacar o dia do ultrapassado leria como contradição
  const rivalHint = ot.passedMe[0]?.dayPts > 0
    ? ` · ${escapeHtml(ot.passedMe[0].name)} fez +${ot.passedMe[0].dayPts} no dia` : '';
  const myHint = ot.myDayPts > 0 ? ` · você fez +${ot.myDayPts} no dia` : '';
  const body = ot.hasWindow
    ? line('dn', '▼', 'Te passaram', ot.passedMe, rivalHint)
      + line('up', '▲', 'Você passou', ot.iPassed, myHint)
    : '<div class="jd-hint">as ultrapassagens aparecem a partir do 2º dia de jogos</div>';
  const title = ot.hasWindow && ot.windowLabel
    ? `Ultrapassagens · ${escapeHtml(ot.windowLabel)}` : 'Ultrapassagens';
  return `
    <div class="jd-card">
      <h4 class="jd-h">${title}</h4>
      ${body}
    </div>`;
}

function renderFunnel(f) {
  if (!f || f.total === 0) return '';
  const seg = f.segments.filter(s => s.count > 0).map(s =>
    `<div class="jd-fseg ${s.cls}" style="flex:${s.count}" title="${escapeHtml(s.label)}: ${s.count}">${s.count}</div>`
  ).join('');
  const leg = f.segments.map(s =>
    `<span class="jd-fleg"><i class="${s.cls}"></i>${escapeHtml(s.label)}</span>`
  ).join('');
  const pctExact = Math.round((f.segments[0].count / f.total) * 100);
  return `
    <div class="jd-card">
      <h4 class="jd-h">Funil de acertos</h4>
      <div class="jd-funnel">${seg}</div>
      <div class="jd-flegs">${leg}</div>
      <div class="jd-hint">${pctExact}% de cravadas em ${f.total} palpite${f.total === 1 ? '' : 's'} avaliado${f.total === 1 ? '' : 's'}</div>
    </div>`;
}

function renderVsAverage(vs) {
  if (!vs) return '';
  const rows = vs.metrics.map(m => {
    const top = Math.max(m.mine, m.avg, 1e-9);
    const w = Math.max(3, Math.round((m.mine / top) * 100));
    const tick = Math.max(1, Math.min(99, Math.round((m.avg / top) * 100)));
    const val = m.decimals ? fmt1(m.mine) : String(Math.round(m.mine));
    const avgVal = m.decimals ? fmt1(m.avg) : String(Math.round(m.avg));
    return `
      <div class="jd-pair" title="média do bolão: ${avgVal}">
        <span class="jd-pair-l">${escapeHtml(m.label)}</span>
        <span class="jd-bar"><i class="fill" style="width:${w}%"></i><i class="tick" style="left:${tick}%"></i></span>
        <span class="jd-pair-v ${m.mine >= m.avg ? 'up' : 'dn'}">${val}</span>
      </div>`;
  }).join('');
  const ahead = vs.behind > 0
    ? ` · você está à frente de ${vs.behind} jogador${vs.behind === 1 ? '' : 'es'}` : '';
  return `
    <div class="jd-card">
      <h4 class="jd-h">Você vs a média</h4>
      ${rows}
      <div class="jd-hint">traço = média do bolão${ahead}</div>
    </div>`;
}

function renderLeaderGap(lg) {
  if (!lg || !lg.other) return '';
  const maxAbs = Math.max(...lg.pillars.map(p => Math.abs(p.delta)), 1);
  const rows = lg.pillars.map(p => {
    const w = Math.round((Math.abs(p.delta) / maxAbs) * 100);
    const side = p.delta > 0 ? 'r' : p.delta < 0 ? 'l' : '';
    return `
      <div class="jd-divg">
        <span class="jd-pair-l">${escapeHtml(p.label)}</span>
        <span class="jd-track">
          <span class="half l">${side === 'l' ? `<i style="width:${w}%"></i>` : ''}</span>
          <span class="half r">${side === 'r' ? `<i style="width:${w}%"></i>` : ''}</span>
        </span>
        <span class="jd-pair-v ${p.delta > 0 ? 'dn' : p.delta < 0 ? 'up' : ''}">${p.delta > 0 ? `−${p.delta}` : p.delta < 0 ? `+${-p.delta}` : '0'}</span>
      </div>`;
  }).join('');
  const head = lg.isLeader
    ? `Sua frente pro vice (${escapeHtml(lg.other.name)}, ${lg.other.pts} pts): <b class="up">+${-lg.gapTotal}</b>`
    : `Gap total: <b class="dn">−${lg.gapTotal}</b> pra ${escapeHtml(lg.other.name)} (líder, ${lg.other.pts} pts)`;
  return `
    <div class="jd-card">
      <h4 class="jd-h">${lg.isLeader ? 'Sua vantagem de líder' : 'O que te separa do líder'}</h4>
      ${rows}
      <div class="jd-hint">${head}</div>
    </div>`;
}

/**
 * Monta o dashboard nos dois containers da seção jornada. Não lança pro caller:
 * qualquer falha deixa os mounts escondidos e loga — o gráfico nunca morre por
 * causa dos widgets (mesmo contrato do mountJourney).
 * @returns {boolean} true se renderizou algo
 */
export function renderJourneyDashboard({
  railMount, dnaMount, series, matches, leaderboard, meId,
  nextStage = null, finishedMatches = 0,
}) {
  try {
    const avatarBySeries = new Map(series.map(s => [s.userId, s.avatar_url]));
    const avatarOf = (id) => avatarBySeries.get(id) ?? null;
    const standing = leaderboard.find(r => r.user_id === meId);

    const rail = renderLadder(buildLadder(leaderboard, meId, nextStage), avatarOf)
      + renderOvertakes(computeOvertakes(series, matches, meId));
    const dna = renderFunnel(buildFunnel(standing))
      + renderVsAverage(buildVsAverage(leaderboard, meId, finishedMatches))
      + renderLeaderGap(buildLeaderGap(leaderboard, meId));

    if (railMount && rail.trim()) {
      railMount.innerHTML = rail;
      railMount.hidden = false;
      // só com trilho populado o layout vira 2 colunas — sem isso o grid
      // reservaria os 300px da coluna com o trilho vazio/escondido
      railMount.closest('.jd-layout')?.classList.add('jd-on');
    }
    if (dnaMount && dna.trim()) { dnaMount.innerHTML = dna; dnaMount.hidden = false; }
    return Boolean(rail.trim() || dna.trim());
  } catch (err) {
    console.error('[journey-dashboard]', err);
    return false;
  }
}

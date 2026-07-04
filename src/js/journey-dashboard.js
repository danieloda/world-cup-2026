// ============================================================
// Dashboard da jornada — widgets ao redor do gráfico (tela Início)
// ============================================================
// Fases 1 e 2 da proposta (docs: memória jornada-dashboard-proposal).
//
// F1 — aritmética sobre dados que a home JÁ carrega (zero fetch novo):
//  • Escada do ranking   — vizinhos de cima/baixo com gap e cenário concreto
//  • Ultrapassagens      — quem cruzou com você desde o dia anterior
//  • Funil de acertos    — cravada → venc.+saldo → vencedor → parcial → zero
//  • Você vs a média     — pts/jogo, cravadas e total contra o bolão
//  • O que te separa do líder — gap decomposto por pilar de pontuação
//
// F2 — "apostas vivas", com fetches leves já usados em outras páginas:
//  • Seu campeão         — vivo/eliminado + os 40 pts pendurados
//  • Seu artilheiro      — gols vs o líder da Chuteira + multiplicador da fase
//  • Zona de prêmio      — R$ se acabasse hoje / distância da última vaga paga
//
// F3 — "o que vem por aí", com a engine do bracket.js portada pra home:
//  • Em jogo pra você    — pontos em disputa no próximo jogo
//  • Teto matemático     — quanto ainda dá pra somar (ninguém está fora)
//  • Sobreviventes       — quantos do seu bracket previsto seguem vivos
//
// Módulo em duas camadas: funções de CÁLCULO puras (exportadas, testáveis) e
// render por template string, no padrão das outras páginas. O caller decide
// onde montar; falha aqui não pode derrubar o gráfico (try/catch no caller).

import { escapeHtml, avatarHtml, flag, teamPt, formatBrShort, formatTime } from './util.js';
import { sortLeaderboard, assignRanksAndPrizes, tiedPair } from './prize.js';
import { matchPoints, championBonus, stageMultiplier, qualifierBonus } from './scoring.js';
import { buildTimeline } from './chart-utils.js';
import { isRealTeam } from './bracket.js';

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

// ============================================================
// F2 — Apostas vivas: cálculo (puro)
// ============================================================

/**
 * Estado do mata-mata a partir dos jogos de KO (todas as fases, incl. 3º):
 *  - eliminated: perdeu QUALQUER jogo de KO finalizado — perder a semi já
 *    tira o título (a disputa de 3º não ressuscita ninguém pro caneco);
 *  - r32Teams/r32Seeded: os 32 classificados — elimina quem caiu nos grupos,
 *    mas SÓ quando o R32 está todo semeado com times reais (antes disso não
 *    dá pra afirmar que um time ficou fora);
 *  - upcoming: primeiro jogo NÃO finalizado de cada time real — o artilheiro
 *    de um time na disputa de 3º ainda joga (e gol lá pontua).
 * Derivação de perdedor espelha championOf (card-results.js): gols, senão
 * pen_winner; empate sem pênalti registrado não afirma eliminação.
 */
export function computeKoStatus(koMatches) {
  const sorted = [...koMatches].sort((a, b) => new Date(a.match_date) - new Date(b.match_date));
  const eliminated = new Set();
  const upcoming = new Map();
  const r32Sides = [];
  let champion = null;
  for (const m of sorted) {
    if (m.stage === 'r32') r32Sides.push(m.team_home, m.team_away);
    if (m.finished) {
      const { actual_home: h, actual_away: a, pen_winner: pen } = m;
      let loser = null, winner = null;
      if (h != null && a != null) {
        if (h > a) { winner = m.team_home; loser = m.team_away; }
        else if (a > h) { winner = m.team_away; loser = m.team_home; }
        else if (pen === 'home') { winner = m.team_home; loser = m.team_away; }
        else if (pen === 'away') { winner = m.team_away; loser = m.team_home; }
      }
      if (loser && isRealTeam(loser)) eliminated.add(loser);
      if (m.stage === 'final' && winner && isRealTeam(winner)) champion = winner;
    } else {
      for (const t of [m.team_home, m.team_away]) {
        if (isRealTeam(t) && !upcoming.has(t)) upcoming.set(t, m);
      }
    }
  }
  const r32Seeded = r32Sides.length > 0 && r32Sides.every(isRealTeam);
  const r32Teams = new Set(r32Sides.filter(isRealTeam));
  return {
    eliminated, upcoming, r32Seeded, r32Teams, champion,
    aliveForTitle: (team) => !eliminated.has(team) && (!r32Seeded || r32Teams.has(team)),
  };
}

/**
 * Card do campeão: status do MEU pick + quantos rivais PAGOS torcem junto.
 * @returns null sem pick (deadline já passou — não há o que exibir)
 */
export function buildChampionCard({ myPick, allPicks, koStatus, meId, paidIds }) {
  // sem koStatus (fetch de KO falhou) não dá pra afirmar vivo/morto — sem card
  if (!myPick?.team || !koStatus) return null;
  const team = myPick.team;
  const alive = koStatus.aliveForTitle(team);
  const others = (allPicks ?? []).filter(p =>
    p.team === team && p.user_id !== meId && (!paidIds || paidIds.has(p.user_id))
  ).length;
  return {
    team, alive, others,
    won: koStatus.champion === team,
    next: alive ? koStatus.upcoming.get(team) ?? null : null,
    bonus: championBonus(true),
  };
}

/**
 * Card do artilheiro: meu pick vs o topo da Chuteira de Ouro.
 *  - pick fora do feed (ainda sem gol) → 0 gols, sem rank;
 *  - stillPlays cobre a disputa de 3º via upcoming (título morto, gol vale);
 *  - perGoal usa a fase do PRÓXIMO jogo do time dele; sem jogo semeado ainda,
 *    cai na fase corrente do torneio (fallbackStage).
 */
export function buildScorerCard({ pick, scorers, koStatus, fallbackStage = null }) {
  // sem koStatus ou sem feed não dá pra afirmar nada da corrida — sem card
  if (!pick?.name || !koStatus) return null;
  const feed = scorers ?? [];
  if (feed.length === 0) return null;
  const inFeed = pick.apiId != null ? feed.find(s => s.api_id === pick.apiId) ?? null : null;
  const goals = inFeed?.goals ?? 0;
  // rank de COMPETIÇÃO (empatados dividem posição), não posição no JSON —
  // indexOf diria "2º" pra quem está empatado na ponta
  const rank = inFeed ? feed.filter(s => (s.goals ?? 0) > goals).length + 1 : null;
  const leader = feed[0] ?? null;
  const tiedWith = inFeed && rank === 1
    ? feed.find(s => s !== inFeed && (s.goals ?? 0) === goals)?.name ?? null
    : null;
  const isLeader = rank === 1 && !tiedWith;
  const gap = inFeed ? (rank === 1 ? 0 : (leader.goals ?? 0) - goals) : null;
  const nextStage = koStatus.upcoming.get(pick.team)?.stage ?? fallbackStage;
  return {
    name: pick.name, team: pick.team, goals, rank, leader, isLeader, tiedWith, gap,
    // fora do feed ≠ 0 gols: o JSON é um top-N — não dá pra afirmar contagem
    outsideFeed: !inFeed,
    feedSize: feed.length,
    stillPlays: koStatus.aliveForTitle(pick.team) || koStatus.upcoming.has(pick.team),
    perGoal: nextStage ? 2 * stageMultiplier(nextStage) : null,
    finalPerGoal: 2 * stageMultiplier('final'),
  };
}

/**
 * Card do prêmio: minha fatia HOJE (rateio de empate incluso, prize.js) ou a
 * distância até a última vaga paga e quem a segura. Pote = pagantes × taxa
 * (mesma conta do computeTotalPot de ranking.js); split em % por posição.
 */
export function buildPrizeCard({ rows, meId, split, feeAmount, paidUsers }) {
  const inRanking = (rows ?? []).some(r => r.user_id === meId);
  if (!inRanking) return null;
  // || (não ??): v_pool_stats indisponível chega como 0 e viraria "pote R$ 0";
  // o leaderboard só tem pagantes, então length é o mesmo denominador
  const totalPot = (paidUsers || rows.length) * (feeAmount ?? 100);
  const s = split ?? { first: 70, second: 20, third: 10 };
  const prizeByPos = [
    Math.round(totalPot * (s.first ?? 0) / 100),
    Math.round(totalPot * (s.second ?? 0) / 100),
    Math.round(totalPot * (s.third ?? 0) / 100),
  ];
  const ranked = assignRanksAndPrizes(sortLeaderboard(rows).map(r => ({ ...r })), prizeByPos);
  const me = ranked.find(r => r.user_id === meId);
  const winners = ranked.filter(r => (r.prizeShare ?? 0) > 0);
  const holder = winners[winners.length - 1] ?? null;
  return {
    totalPot,
    myShare: me.prizeShare ?? 0,
    myPos: me.pos,
    inZone: (me.prizeShare ?? 0) > 0,
    holder: holder && holder.user_id !== meId
      ? {
          name: holder.full_name, pos: holder.pos, pts: holder.total_pts ?? 0,
          gap: (holder.total_pts ?? 0) - (me.total_pts ?? 0),
        }
      : null,
  };
}

// ============================================================
// F2 — Apostas vivas: render
// ============================================================

const fmtBRL = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;

function renderChampionCard(c) {
  if (!c) return '';
  const badge = c.won
    ? '<span class="jd-badge live">Campeão</span>'
    : c.alive
      ? '<span class="jd-badge live">Vivo</span>'
      : '<span class="jd-badge dead">Eliminado</span>';
  const bonus = c.won
    ? `<div class="jd-big gold">+${c.bonus} <small>garantidos</small></div>`
    : c.alive
      ? `<div class="jd-big gold">+${c.bonus} <small>em jogo</small></div>`
      : `<div class="jd-big mute">+0 <small>· sem bônus de campeão</small></div>`;
  let when = '';
  if (c.won) {
    when = 'você cravou o campeão do mundo — bônus creditado';
  } else if (c.alive && c.next) {
    const opp = c.next.team_home === c.team ? c.next.team_away : c.next.team_home;
    const oppLabel = isRealTeam(opp) ? teamPt(opp) : 'adversário a definir';
    when = `joga ${escapeHtml(formatBrShort(c.next.match_date))} · ${escapeHtml(formatTime(c.next.match_date))} vs ${escapeHtml(oppLabel)}`;
  } else if (c.alive) {
    when = 'aguarda o adversário da próxima fase';
  } else {
    when = 'seu palpite caiu na Copa';
  }
  const tribe = c.others > 0
    ? `+${c.others} ${c.others === 1 ? 'rival' : 'rivais'} na mesma torcida`
    : 'só você apostou nele';
  return `
    <div class="jd-card">
      <h4 class="jd-h">Seu campeão</h4>
      <div class="jd-bet-who"><span class="flag">${flag(c.team)}</span><b>${escapeHtml(teamPt(c.team))}</b>${badge}</div>
      ${bonus}
      <div class="jd-hint">${when} · ${tribe}</div>
    </div>`;
}

function renderScorerCard(sc) {
  if (!sc) return '';
  const badge = sc.stillPlays ? '' : '<span class="jd-badge dead">fora da Copa</span>';
  // fora do feed (top-N) não é "0 gols" — só não dá pra afirmar a contagem
  const big = sc.outsideFeed
    ? `<div class="jd-big mute">fora do top ${sc.feedSize} <small>da corrida</small></div>`
    : `<div class="jd-big">${sc.goals} <small>gol${sc.goals === 1 ? '' : 's'}${sc.rank ? ` · ${sc.rank}º na corrida` : ''}</small></div>`;
  const race = sc.outsideFeed
    ? sc.leader ? `líder: ${escapeHtml(sc.leader.name)}, com ${sc.leader.goals}` : ''
    : sc.isLeader
      ? '<b class="gold">líder da Chuteira de Ouro</b>'
      : sc.tiedWith
        ? `empatado na ponta com ${escapeHtml(sc.tiedWith)}`
        : sc.leader
          ? `<b class="dn">−${sc.gap}</b> pro líder (${escapeHtml(sc.leader.name)}, ${sc.leader.goals})`
          : '';
  const mult = sc.stillPlays && sc.perGoal
    ? `<div class="jd-hint">cada gol dele agora vale <b class="gold">${sc.perGoal} pts</b> · na final vale ${sc.finalPerGoal}</div>`
    : '<div class="jd-hint">os gols dele param por aqui</div>';
  return `
    <div class="jd-card">
      <h4 class="jd-h">Seu artilheiro</h4>
      <div class="jd-bet-who"><span class="flag">${flag(sc.team)}</span><b>${escapeHtml(sc.name)}</b>${badge}</div>
      ${big}
      ${race ? `<div class="jd-hint">${race}</div>` : ''}
      ${mult}
    </div>`;
}

function renderPrizeCard(pz) {
  if (!pz) return '';
  const big = pz.inZone
    ? `<div class="jd-big gold">${fmtBRL(Math.round(pz.myShare))} <small>se acabasse hoje</small></div>`
    : `<div class="jd-big mute">R$ 0 <small>hoje</small></div>`;
  const line = pz.inZone
    ? `${pz.myPos}º lugar — na zona de prêmio`
    : pz.holder
      ? pz.holder.gap === 0
        // empate em pontos perdido no desempate: "a 0 pts" leria como alcançado
        ? `empatado em pontos com ${escapeHtml(pz.holder.name)} (${pz.holder.pos}º) — a vaga é dele no desempate`
        : `a <b>${pz.holder.gap} pts</b> da última vaga paga — ${escapeHtml(pz.holder.name)} (${pz.holder.pos}º) segura`
      : 'zona de prêmio em disputa';
  return `
    <div class="jd-card">
      <h4 class="jd-h">Zona de prêmio</h4>
      ${big}
      <div class="jd-hint">${line}</div>
      <div class="jd-hint">pote atual: <b class="gold">${fmtBRL(pz.totalPot)}</b></div>
    </div>`;
}

/**
 * Monta a fileira "apostas vivas". Mesmo contrato do renderJourneyDashboard:
 * captura as próprias falhas; no pior caso o container segue escondido.
 * @returns {boolean} true se renderizou algo
 */
export function renderJourneyBets({
  mount, myChampionPick, allChampionPicks, scorerPick, scorers, koMatches,
  leaderboard, meId, settings = {}, paidUsers, nextStage = null,
}) {
  try {
    // koMatches null = fetch de KO falhou → cards de campeão/artilheiro não
    // renderizam (afirmar "vivo" sem os jogos seria chute); [] = ok, sem KO
    const koStatus = koMatches ? computeKoStatus(koMatches) : null;
    const paidIds = new Set((leaderboard ?? []).map(r => r.user_id));
    const html = renderChampionCard(buildChampionCard({
      myPick: myChampionPick, allPicks: allChampionPicks, koStatus, meId, paidIds,
    })) + renderScorerCard(buildScorerCard({
      pick: scorerPick, scorers, koStatus, fallbackStage: nextStage,
    })) + renderPrizeCard(buildPrizeCard({
      rows: leaderboard ?? [], meId,
      split: settings.prize_split, feeAmount: settings.fee_amount, paidUsers,
    }));
    if (mount && html.trim()) { mount.innerHTML = html; mount.hidden = false; }
    return Boolean(html.trim());
  } catch (err) {
    console.error('[journey-bets]', err);
    return false;
  }
}

// ============================================================
// F3 — O que vem por aí: cálculo (puro)
// ============================================================

/**
 * Pontos em disputa PRA VOCÊ no próximo jogo: o teto do placar (cravar rende
 * matchPoints(stage).exact) e se o seu artilheiro entra em campo. O bônus de
 * vaga não entra aqui — ele não é atribuível a um jogo isolado de forma limpa.
 * @returns null sem jogo (copa encerrada)
 */
export function buildStakeCard({ nextMatch, myPred, scorerTeam }) {
  if (!nextMatch) return null;
  const placarMax = matchPoints(nextMatch.stage).exact;
  const hasScorer = scorerTeam != null;
  const scorerPlays = hasScorer
    && (nextMatch.team_home === scorerTeam || nextMatch.team_away === scorerTeam);
  return {
    match: nextMatch,
    placarMax,
    hasPred: Boolean(myPred && myPred.pred_home != null && myPred.pred_away != null),
    hasScorer,
    scorerPlays,
    perGoal: scorerPlays ? 2 * stageMultiplier(nextMatch.stage) : 0,
  };
}

/**
 * Teto das categorias COM teto fixo — quanto ainda dá pra somar em:
 *   placar  = Σ matchPoints(stage).exact dos jogos não finalizados
 *   vagas   = qualifierBonus(stage, BPE) por LADO de KO ainda não preenchido
 *             (lado já com time real teve seu BPE creditado no guaranteed →
 *              não conta, senão dobraria; lado ainda em slot ainda é ganhável)
 *   campeão = 40 se o pick segue vivo E a final ainda não saiu (senão o +40 já
 *             está no guaranteed)
 * O ARTILHEIRO fica de fora de propósito: cada gol soma sem teto (2×gols×mult),
 * então não é um limite superior — é mostrado como "por cima" no card.
 */
export function buildCeiling({ guaranteed, allMatches, championAlive }) {
  let placarMax = 0, qualMax = 0;
  for (const m of allMatches ?? []) {
    if (m.finished) continue;
    placarMax += matchPoints(m.stage).exact;
    if (m.stage === 'group') continue;   // grupo não dá vaga de KO
    // team_home/away = valor RESOLVIDO (o DB semeia o time real quando a vaga
    // enche); se ainda é slot ('W73','2A'), o BPE dessa vaga é ganhável
    for (const side of [m.team_home, m.team_away]) {
      if (!isRealTeam(side)) qualMax += qualifierBonus(m.stage, true);
    }
  }
  const champMax = championAlive ? championBonus(true) : 0;
  const remaining = placarMax + qualMax + champMax;
  return {
    guaranteed, placarMax, qualMax, champMax, remaining,
    ceiling: guaranteed + remaining,
  };
}

/**
 * Sobreviventes do seu bracket previsto: dos times que você apostou pra vencer
 * cada 32-avo, quantos seguem vivos de verdade. Os participantes dos 32-avos
 * vêm da REALIDADE (r32 já semeado), então NÃO depende de você ter palpitado os
 * grupos — só do seu palpite de quem vence cada 32-avo. Vivo = aliveForTitle
 * (cobre quem caiu no KO E quem nem chegou ao r32 semeado).
 */
export function buildSurvivors({ allMatches, predsByMatch, koStatus }) {
  if (!koStatus || !koStatus.r32Seeded) return null;   // só faz sentido com r32 semeado
  const r32 = (allMatches ?? []).filter(m => m.stage === 'r32');
  const seen = new Set();
  const teams = [];
  for (const m of [...r32].sort((a, b) => a.id - b.id)) {
    const home = m.team_home, away = m.team_away;
    if (!isRealTeam(home) || !isRealTeam(away)) continue;
    const p = predsByMatch?.get(m.id);
    let w = null;
    if (p && p.pred_home != null && p.pred_away != null) {
      if (p.pred_home > p.pred_away) w = home;
      else if (p.pred_away > p.pred_home) w = away;
      else if (p.pred_pen_winner === 'home') w = home;
      else if (p.pred_pen_winner === 'away') w = away;
    }
    if (!w || seen.has(w)) continue;
    seen.add(w);
    teams.push({ team: w, alive: koStatus.aliveForTitle(w) });
  }
  if (teams.length === 0) return null;
  const alive = teams.filter(t => t.alive).length;
  return { teams, alive, total: teams.length };
}

// ============================================================
// F3 — O que vem por aí: render
// ============================================================

function renderStakeCard(sk) {
  if (!sk) return '';
  const m = sk.match;
  const where = m.group_name ? `Grupo ${escapeHtml(m.group_name)}` : escapeHtml(stageLabelOf(m.stage));
  const homeReal = isRealTeam(m.team_home), awayReal = isRealTeam(m.team_away);
  const matchup = homeReal && awayReal
    ? `${escapeHtml(teamPt(m.team_home))} × ${escapeHtml(teamPt(m.team_away))}`
    : where;
  const chips = [
    `<span>placar exato · ${sk.placarMax}</span>`,
    // sem pick de artilheiro não afirma nada; com pick, joga ou não joga
    !sk.hasScorer ? ''
      : sk.scorerPlays
        ? `<span class="on">seu artilheiro joga · +${sk.perGoal}/gol</span>`
        : '<span>artilheiro não joga</span>',
  ].join('');
  const when = `${escapeHtml(formatBrShort(m.match_date))} · ${escapeHtml(formatTime(m.match_date))}`;
  return `
    <div class="jd-card">
      <h4 class="jd-h">Em jogo pra você</h4>
      <div class="jd-bet-who"><b>${matchup}</b></div>
      <div class="jd-big gold">até ${sk.placarMax} <small>pts no placar</small></div>
      <div class="jd-chips">${chips}</div>
      <div class="jd-hint">${when} · ${where}${sk.hasPred ? '' : ' · você ainda não palpitou'}</div>
    </div>`;
}

function renderCeilingCard(ce) {
  if (!ce) return '';
  const total = Math.max(1, ce.ceiling);
  const gPct = Math.round((ce.guaranteed / total) * 100);
  return `
    <div class="jd-card">
      <h4 class="jd-h">Teto matemático</h4>
      <div class="jd-big gold">${ce.ceiling} <small>pts + o artilheiro</small></div>
      <div class="jd-ceil"><span class="got" style="width:${gPct}%"></span></div>
      <div class="jd-hint"><b>${ce.guaranteed} garantidos</b> + até ${ce.remaining} em disputa
        <span class="jd-mute">(placar ${ce.placarMax} · vagas ${ce.qualMax}${ce.champMax ? ` · campeão ${ce.champMax}` : ''})</span></div>
      <div class="jd-hint">e os gols do seu artilheiro somam por cima, sem teto fixo</div>
    </div>`;
}

function renderSurvivorsCard(sv) {
  if (!sv) return '';
  const flags = sv.teams.map(t =>
    `<span class="jd-mini ${t.alive ? '' : 'dead'}">${flag(t.team)}</span>`
  ).join('');
  return `
    <div class="jd-card">
      <h4 class="jd-h">Sobreviventes do seu bracket</h4>
      <div class="jd-big">${sv.alive}<small>/${sv.total} seguem vivos</small></div>
      <div class="jd-flags">${flags}</div>
      <div class="jd-hint">os times que você mandou pras oitavas e ainda estão de pé — riscados já caíram</div>
    </div>`;
}

// rótulo curto de fase sem depender de import extra (stageLabel do util é longo)
function stageLabelOf(stage) {
  return { r32: '32-avos', r16: 'Oitavas', qf: 'Quartas', sf: 'Semis', third: '3º lugar', final: 'Final' }[stage] ?? stage;
}

/**
 * Monta a fileira "o que vem por aí" (F3). Auto-contida: deriva o koStatus dos
 * jogos de mata dentro de allMatches. Mesmo contrato dos outros — captura as
 * próprias falhas; no pior caso o container segue escondido.
 * allMatches null (fetch falhou) suprime teto/sobreviventes — sem chute.
 * @returns {boolean} true se renderizou algo
 */
export function renderJourneyProjection({
  mount, nextMatch, myPred, scorerTeam, allMatches, predsByMatch,
  guaranteed = 0, myChampionTeam = null,
}) {
  try {
    const koStatus = allMatches
      ? computeKoStatus(allMatches.filter(m => m.stage !== 'group'))
      : null;
    // +40 só é "em disputa" enquanto a final não sai; depois o bônus (se acertou)
    // já entrou no guaranteed — contá-lo de novo dobraria o teto
    const championAlive = Boolean(myChampionTeam)
      && Boolean(koStatus?.aliveForTitle(myChampionTeam))
      && !koStatus?.champion;
    const html = renderStakeCard(buildStakeCard({ nextMatch, myPred, scorerTeam }))
      + (koStatus ? renderCeilingCard(buildCeiling({ guaranteed, allMatches, championAlive })) : '')
      + (koStatus ? renderSurvivorsCard(buildSurvivors({ allMatches, predsByMatch, koStatus })) : '');
    if (mount && html.trim()) { mount.innerHTML = html; mount.hidden = false; }
    return Boolean(html.trim());
  } catch (err) {
    console.error('[journey-projection]', err);
    return false;
  }
}

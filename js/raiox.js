// ============================================================
// Raio-X — painel de contexto do confronto
// ============================================================
// Conteúdo compartilhado entre a fase de grupos (painel inline expansível)
// e o mata-mata (modal flutuante, já que o card do bracket é compacto e
// re-renderiza a cada palpite). Três seções:
//   1. Previsão        — 1X2 + comparação por eixo (API-Football predictions)
//   2. Forma recente   — últimos jogos de cada seleção (recentByTeam)
//   3. Confronto direto — histórico H2H entre as duas seleções
//
// `data` é { recentByTeam, h2h, predictions? }.
//   recentByTeam: Map<team, [{ date, opponent, home, score, competition }]>
//   h2h:          objeto { fixtures, summary } já resolvido, ou null.
//                 - grupos: vem de match_h2h (por match_id, sempre presente)
//                 - mata:   buscado on-demand por par de times (pode faltar)
//   predictions:  objeto NORMALIZADO da previsão (ou ausente). Forma:
//                 { source, pHome, pDraw, pAway, favored:'home'|'draw'|'away',
//                   comparison:[{ label, home, away }] }  — home/away em %.
//                 Espelha GET /predictions?fixture={id} da API-Football
//                 (predictions.percent + o objeto comparison), na ótica do
//                 lado "casa" do confronto do bolão.

import { flag, escapeHtml, teamPt } from './util.js';
import { renderStandingTable } from './standings-view.js';

const COMP_PT = {
  'Friendlies': 'Amistoso', 'Friendly': 'Amistoso',
  'World Cup': 'Copa do Mundo', 'FIFA World Cup': 'Copa do Mundo',
  'World Cup - Qualification': 'Eliminatórias',
  'CONMEBOL': 'Eliminatórias', 'Copa America': 'Copa América',
  'UEFA Nations League': 'Liga das Nações', 'Confederations Cup': 'Copa das Confederações',
};

// ----- helpers -----
function recentResult(score) {
  const [a, b] = String(score).split('-').map(n => parseInt(n, 10));
  if (Number.isNaN(a) || Number.isNaN(b)) return { l: 'E', c: 'e' };
  if (a > b) return { l: 'V', c: 'v' };
  if (a < b) return { l: 'D', c: 'd' };
  return { l: 'E', c: 'e' };
}
function fmtRecentDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}
function compPt(name) {
  if (!name) return '';
  if (COMP_PT[name]) return COMP_PT[name];
  for (const [k, v] of Object.entries(COMP_PT)) if (name.includes(k)) return v;
  return name;
}
function fmtH2HDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}
// "45%" | "40.0%" | 45 -> 45 (número). NaN vira 0.
function pct(v) {
  const n = parseFloat(String(v).replace('%', ''));
  return Number.isFinite(n) ? n : 0;
}

// ----- blocos -----

// Radar (pentágono) de força por time, em SVG puro. `radar` = { axes, home, away }
// com valores já normalizados 0-100 (att/def/form vêm em % da API; gols viram %
// via escala). Dois polígonos sobrepostos: verde = casa, vermelho = visitante.
function renderPredictionsRadar(pred, homeTeam, awayTeam) {
  const radar = pred.radar;
  if (!radar || !radar.axes?.length) return '';
  const { axes, home, away } = radar;
  const n = axes.length;
  const cx = 120, cy = 106, R = 70;

  // ponto no eixo i (0 = topo), a uma fração `frac` do raio `rad`.
  const at = (frac, i, rad = R) => {
    const ang = -Math.PI / 2 + i * (2 * Math.PI / n);
    return [cx + rad * frac * Math.cos(ang), cy + rad * frac * Math.sin(ang)];
  };
  const xy = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
  const clamp = v => Math.max(0, Math.min(100, pct(v)));

  const rings = [0.25, 0.5, 0.75, 1]
    .map(f => `<polygon class="rx-radar-ring" points="${axes.map((_, i) => xy(at(f, i))).join(' ')}"/>`).join('');
  const spokes = axes.map((_, i) => `<line class="rx-radar-spoke" x1="${cx}" y1="${cy}" x2="${at(1, i)[0].toFixed(1)}" y2="${at(1, i)[1].toFixed(1)}"/>`).join('');
  const area = (vals, cls) => {
    const poly = vals.map((v, i) => xy(at(clamp(v) / 100, i))).join(' ');
    const dots = vals.map((v, i) => `<circle class="rx-radar-dot ${cls}" cx="${at(clamp(v) / 100, i)[0].toFixed(1)}" cy="${at(clamp(v) / 100, i)[1].toFixed(1)}" r="2.4"/>`).join('');
    return `<polygon class="rx-radar-area ${cls}" points="${poly}"/>${dots}`;
  };
  const labels = axes.map((ax, i) => {
    const [x, y] = at(1, i, R + 17);
    const anchor = Math.abs(x - cx) < 8 ? 'middle' : (x < cx ? 'end' : 'start');
    return `<text class="rx-radar-axis" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}">${escapeHtml(ax)}</text>`;
  }).join('');

  return `
    <div class="rx-cmp-label-head">Comparação de força</div>
    <div class="rx-radar">
      <svg viewBox="0 0 240 212" class="rx-radar-svg" role="img"
           aria-label="Radar de força: ${escapeHtml(teamPt(homeTeam))} contra ${escapeHtml(teamPt(awayTeam))}">
        <g class="rx-radar-grid">${rings}${spokes}</g>
        ${labels}
        <g class="rx-radar-plot">${area(away, 'away')}${area(home, 'home')}</g>
      </svg>
      <div class="rx-radar-legend">
        <span class="lg home"><span class="flag">${flag(homeTeam)}</span>${escapeHtml(teamPt(homeTeam))}</span>
        <span class="lg away"><span class="flag">${flag(awayTeam)}</span>${escapeHtml(teamPt(awayTeam))}</span>
      </div>
    </div>`;
}

// Previsão — só renderiza quando há RADAR (decisão do produto 2026-06-03: a
// feature é o radar de força; sem ele a previsão não aparece — nem a barra 1X2).
// O servidor (scripts/lib/normalize-prediction.js) já nem grava previsão sem
// radar, então este early-return é a guarda defensiva no front.
// Layout: barra 1X2 (vitória/empate/vitória) no topo + radar de força embaixo.
// Verde = casa, vermelho = visitante, amarelo = empate (mesmo vocabulário visual
// da balança de confronto direto, .ctx-balance).
function renderPredictionsBlock(homeTeam, awayTeam, pred) {
  if (!pred?.radar?.axes?.length) return '';

  const pH = pct(pred.pHome), pD = pct(pred.pDraw), pA = pct(pred.pAway);
  const homePt = teamPt(homeTeam);
  const awayPt = teamPt(awayTeam);
  const favored = pred.favored;  // 'home' | 'draw' | 'away'
  const verdictName = favored === 'home' ? homePt : favored === 'away' ? awayPt : 'Empate';
  const verdictCls  = favored === 'draw' ? 'draw' : favored === 'away' ? 'away' : 'home';

  const seg = (p, cls) => p > 0
    ? `<span class="rx-1x2-seg ${cls}" style="flex:${p}">${Math.round(p)}%</span>` : '';

  return `
    <div class="ctx-section-label">Previsão <span class="ctx-section-sub">${escapeHtml(pred.source || 'API-Football')}</span></div>
    <div class="rx-pred">
      <div class="rx-1x2-head">
        <span class="rx-1x2-team home"><span class="flag">${flag(homeTeam)}</span>${escapeHtml(homePt)}</span>
        <span class="rx-1x2-draw">empate</span>
        <span class="rx-1x2-team away">${escapeHtml(awayPt)}<span class="flag">${flag(awayTeam)}</span></span>
      </div>
      <div class="rx-1x2-bar" role="img" aria-label="${Math.round(pH)}% vitória ${escapeHtml(homePt)}, ${Math.round(pD)}% empate, ${Math.round(pA)}% vitória ${escapeHtml(awayPt)}">
        ${seg(pH, 'home')}${seg(pD, 'draw')}${seg(pA, 'away')}
      </div>
      <div class="rx-1x2-verdict ${verdictCls}">Favorito da API: <b>${escapeHtml(verdictName)}</b></div>
      ${renderPredictionsRadar(pred, homeTeam, awayTeam)}
    </div>
  `;
}
function renderRecentBlock(team, recentByTeam) {
  const rec = recentByTeam.get(team);
  if (!rec || !rec.length) {
    return `
      <div class="rx-recent-col is-empty">
        <div class="rx-recent-head">
          <span class="flag">${flag(team)}</span>
          <span class="rx-recent-name">${escapeHtml(teamPt(team))}</span>
        </div>
        <div class="rx-recent-empty">Sem jogos recentes</div>
      </div>`;
  }
  const list = rec.slice(0, 10);
  let v = 0, e = 0, d = 0;
  for (const r of list) { const c = recentResult(r.score).c; if (c === 'v') v++; else if (c === 'e') e++; else d++; }

  // Agrupa as partidas por ano, com um divisor sutil quando o ano muda.
  let lastYear = null;
  const rows = list.map(r => {
    const res = recentResult(r.score);
    const year = (r.date || '').slice(0, 4);
    let divider = '';
    if (year && year !== lastYear) {
      divider = `<li class="rx-year"><span>${year}</span></li>`;
      lastYear = year;
    }
    return `${divider}
      <li>
        <span class="rx-r ${res.c}">${res.l}</span>
        <span class="rx-when">${escapeHtml(fmtRecentDate(r.date))}</span>
        <span class="rx-opp">
          <span class="rx-loc ${r.home ? 'home' : 'away'}" title="${r.home ? 'Em casa' : 'Fora'}">${r.home ? 'C' : 'F'}</span>
          <span class="flag">${flag(r.opponent)}</span>
          <span class="rx-opp-name">${escapeHtml(teamPt(r.opponent))}</span>
        </span>
        <span class="rx-score">${escapeHtml(r.score)}</span>
      </li>`;
  }).join('');

  return `
    <div class="rx-recent-col">
      <div class="rx-recent-head">
        <span class="flag">${flag(team)}</span>
        <span class="rx-recent-name">${escapeHtml(teamPt(team))}</span>
        <span class="rx-recent-tally" title="${v} vitórias, ${e} empates, ${d} derrotas">
          <span class="t v">${v}<i>V</i></span>
          <span class="t e">${e}<i>E</i></span>
          <span class="t d">${d}<i>D</i></span>
        </span>
      </div>
      <ol class="rx-recent-list">${rows}</ol>
    </div>
  `;
}

// homeTeam é o lado "casa" do confronto do bolão; o summary do h2h é sempre
// na ótica desse lado (home_wins == vitórias do homeTeam).
function renderH2HBlock(homeTeam, awayTeam, h2h) {
  const homePt = teamPt(homeTeam);
  const awayPt = teamPt(awayTeam);

  // Sem confrontos registrados → não mostra NADA (igual às odds: sem dado, sem
  // seção). O gating em renderRaioXContent já evita chegar aqui vazio; isto é
  // a guarda defensiva pra qualquer outro caller.
  if (!h2h || !h2h.fixtures?.length) return '';

  const s = h2h.summary || { home_wins: 0, draws: 0, away_wins: 0, total: 0 };
  const seg = (n, cls) => n > 0
    ? `<span class="bal-seg ${cls}" style="flex:${n}" title="${n}">${n}</span>` : '';

  const rows = h2h.fixtures.slice(0, 5).map(f => {
    const hg = f.home_goals, ag = f.away_goals;
    const homeWon = hg != null && ag != null && hg > ag;
    const awayWon = hg != null && ag != null && hg < ag;
    return `
      <li>
        <span class="h2h-date">${escapeHtml(fmtH2HDate(f.date))}</span>
        <span class="h2h-fix">
          <span class="h2h-t home ${homeWon ? 'win' : ''}">${escapeHtml(teamPt(f.home))}</span>
          <span class="h2h-sc"><b class="${homeWon ? 'win' : ''}">${hg ?? '–'}</b><i>×</i><b class="${awayWon ? 'win' : ''}">${ag ?? '–'}</b></span>
          <span class="h2h-t away ${awayWon ? 'win' : ''}">${escapeHtml(teamPt(f.away))}</span>
        </span>
        <span class="h2h-comp">${escapeHtml(compPt(f.competition))}</span>
      </li>`;
  }).join('');

  return `
    <div class="ctx-h2h">
      <div class="ctx-h2h-top">
        <span class="ctx-h2h-tot">${s.total} ${s.total === 1 ? 'confronto' : 'confrontos'} registrado${s.total === 1 ? '' : 's'}</span>
      </div>
      <div class="ctx-balance" role="img" aria-label="${s.home_wins} vitórias ${homePt}, ${s.draws} empates, ${s.away_wins} vitórias ${awayPt}">
        ${seg(s.home_wins, 'v')}${seg(s.draws, 'e')}${seg(s.away_wins, 'a')}
      </div>
      <div class="ctx-balance-legend">
        <span class="lg v"><b>${s.home_wins}</b> ${escapeHtml(homePt)}</span>
        <span class="lg e"><b>${s.draws}</b> ${s.draws === 1 ? 'empate' : 'empates'}</span>
        <span class="lg a"><b>${s.away_wins}</b> ${escapeHtml(awayPt)}</span>
      </div>
      <ol class="ctx-h2h-list">${rows}</ol>
    </div>
  `;
}

// ============================================================
// Eliminatórias — campanha classificatória de cada seleção
// ============================================================
// `qualifiers` é o assets/data/qualifiers.json carregado: { confederations,
// brackets, teams }. Cada seleção da Copa aponta (via teams[name].format) para
// uma tabela de confederação, uma chave de mata-mata, ou o selo de anfitrião.
// Objetivo: comparar como mandante e visitante chegaram à Copa.

const ROUND_PT = {
  'Semi-finals': 'Semifinais', 'Final': 'Final', 'Quarter-finals': 'Quartas',
  '3rd Place': 'Disputa de 3º', 'Play-offs': 'Repescagem',
};
function roundPt(r) {
  for (const [k, v] of Object.entries(ROUND_PT)) if (r.includes(k)) return v;
  return r;
}

// Status da linha: 'q' classificado direto, 'p' repescagem, '' eliminado.
// A API marca repescagem com variante entre parênteses ("(Promotion)"); a 4ª
// fase reconstruída da AFC usa o texto "Play-offs".
function qualStatus(desc) {
  if (!desc) return '';
  const d = String(desc).toLowerCase();
  if (d.includes('(') || d.includes('play')) return 'p';
  return 'q';
}

function qualHas(qualifiers, team) {
  const rec = qualifiers?.teams?.[team];
  return !!rec && rec.format !== 'unknown';
}

function findTeamRow(conf, team) {
  for (const g of conf.groups) {
    const row = g.rows.find(r => r.team === team);
    if (row) return { group: g, row };
  }
  return null;
}

const qualTag = st => st === 'q' ? '<span class="rx-qtag q">Classificado</span>'
  : st === 'p' ? '<span class="rx-qtag p">Repescagem</span>' : '';

// Nome do grupo em PT (a API devolve "Group A", "WC Qualification ...").
function groupNamePt(name) {
  const m = /^Group ([A-L])$/.exec(name);
  if (m) return `Grupo ${m[1]}`;
  if (/South America/i.test(name)) return 'Pontos corridos';
  return name; // já em PT (AFC reconstruída) ou rótulo específico
}

// Converte uma linha de eliminatória no formato normalizado de standings-view
// (mesmo markup das tabelas de grupos). `focus` = Map<team, 'home'|'away'|'focus'>.
function qualRows(group, focus) {
  return group.rows.map(r => {
    const st = qualStatus(r.description);
    return {
      pos: r.rank, team: r.team,
      j: r.played, v: r.win, e: r.draw, d: r.lose, sg: r.gd, pts: r.points,
      cls: st === 'q' ? 'qualified' : st === 'p' ? 'third' : 'out',
      hl: focus.get(r.team) || '',
    };
  });
}

// Card de um grupo (mesmo .group-card dos grupos), com a tabela canônica.
function renderQualGroupCard(group, focus) {
  const focusRow = group.rows.find(r => focus.has(r.team));
  const headTag = focusRow ? qualTag(qualStatus(focusRow.description)) : '';
  return `
    <div class="group-card">
      <div class="group-head">
        <div class="group-name sm">${escapeHtml(groupNamePt(group.name))}</div>
        ${headTag}
      </div>
      ${renderStandingTable(qualRows(group, focus))}
    </div>`;
}

// Confederação inteira: os grupos com algum time em foco aparecem primeiro
// (visíveis); o restante fica num <details> ("ver toda a confederação") para
// não estourar a tela em confederações grandes (UEFA tem 12 grupos).
function renderConfederation(conf, focus) {
  const focusTeams = new Set(focus.keys());
  const hasFocus = g => g.rows.some(r => focusTeams.has(r.team));
  const focusGroups = conf.groups.filter(hasFocus);
  const restGroups = conf.groups.filter(g => !hasFocus(g));
  const head = (focusGroups.length ? focusGroups : conf.groups)
    .map(g => renderQualGroupCard(g, focus)).join('');
  const rest = (focusGroups.length && restGroups.length)
    ? `<details class="rx-qmore">
         <summary>Ver toda a confederação (${restGroups.length} ${restGroups.length === 1 ? 'grupo' : 'grupos'})</summary>
         <div class="groups-grid">${restGroups.map(g => renderQualGroupCard(g, focus)).join('')}</div>
       </details>`
    : '';
  return `<div class="groups-grid">${head}</div>${rest}`;
}

function campaignSummaryLine(conf, team) {
  const hit = findTeamRow(conf, team);
  if (!hit) return '';
  const { group, row } = hit;
  return `<div class="rx-qsum"><b>${row.rank}º</b> · ${escapeHtml(groupNamePt(group.name))} · ${row.points} pts · ${row.played}J <span class="rx-qwld">${row.win}V ${row.draw}E ${row.lose}D</span> · SG ${row.gd > 0 ? '+' : ''}${row.gd} ${qualTag(qualStatus(row.description))}</div>`;
}

// Mata-mata → chave (rounds empilhados, com o time em foco destacado).
function renderQualBracket(br, focusTeam) {
  const rounds = br.rounds.map(rd => {
    const ties = rd.ties.map(t => {
      const hw = t.homeWinner === true || (t.homeGoals != null && t.awayGoals != null && t.homeGoals > t.awayGoals);
      const aw = t.awayWinner === true || (t.homeGoals != null && t.awayGoals != null && t.homeGoals < t.awayGoals);
      const focH = t.home === focusTeam, focA = t.away === focusTeam;
      return `
        <div class="rx-tie${focH || focA ? ' is-focus' : ''}">
          <span class="rx-tie-t home ${hw ? 'win' : ''}${focH ? ' foc' : ''}"><span class="flag">${flag(t.home)}</span>${escapeHtml(teamPt(t.home))}</span>
          <span class="rx-tie-sc"><b class="${hw ? 'win' : ''}">${t.homeGoals ?? '–'}</b><i>×</i><b class="${aw ? 'win' : ''}">${t.awayGoals ?? '–'}</b></span>
          <span class="rx-tie-t away ${aw ? 'win' : ''}${focA ? ' foc' : ''}">${escapeHtml(teamPt(t.away))}<span class="flag">${flag(t.away)}</span></span>
        </div>`;
    }).join('');
    return `<div class="rx-round"><div class="rx-round-name">${escapeHtml(roundPt(rd.name))}</div>${ties}</div>`;
  }).join('');
  return `<div class="rx-bracket">${rounds}</div>`;
}

// Bloco de uma seleção (cabeçalho + corpo conforme o formato).
function renderCampaignBlock(team, qualifiers, role) {
  const rec = qualifiers.teams[team];
  if (!rec || rec.format === 'unknown') return '';
  let sub = '', sumLine = '', body = '';
  if (rec.format === 'host') {
    sub = 'País-sede';
    body = `<div class="rx-qhost"><span class="rx-qhost-ic">🏟️</span> Classificado automaticamente como país-sede</div>`;
  } else if (rec.format === 'table') {
    const conf = qualifiers.confederations[rec.confederation];
    sub = conf.namePt;
    sumLine = campaignSummaryLine(conf, team);
    body = renderConfederation(conf, new Map([[team, 'focus']]));
  } else if (rec.format === 'bracket') {
    const br = qualifiers.brackets[rec.bracket];
    sub = br.namePt;
    body = renderQualBracket(br, team);
  }
  return `
    <div class="rx-qcamp ${role}">
      <div class="rx-qhead">
        <span class="flag">${flag(team)}</span>
        <span class="rx-qhead-team">${escapeHtml(teamPt(team))}</span>
        <span class="rx-qhead-sub">${escapeHtml(sub)}</span>
      </div>
      ${sumLine}
      ${body}
    </div>`;
}

// Legenda compacta dos dois lados (verde = mandante, vermelho = visitante).
function qualLegend(homeTeam, awayTeam) {
  return `<div class="rx-qlegend">
    <span class="rx-qleg home"><span class="flag">${flag(homeTeam)}</span>${escapeHtml(teamPt(homeTeam))}</span>
    <span class="rx-qleg away"><span class="flag">${flag(awayTeam)}</span>${escapeHtml(teamPt(awayTeam))}</span>
  </div>`;
}

function renderQualifiersBlock(homeTeam, awayTeam, qualifiers) {
  const okH = qualHas(qualifiers, homeTeam);
  const okA = qualHas(qualifiers, awayTeam);
  if (!okH && !okA) return '';
  const recH = qualifiers.teams[homeTeam], recA = qualifiers.teams[awayTeam];

  // Mesma confederação (tabela) → mostra UMA vez, destacando os dois lados
  // (verde = mandante, vermelho = visitante).
  if (okH && okA && recH.format === 'table' && recA.format === 'table'
      && recH.confederation === recA.confederation) {
    const conf = qualifiers.confederations[recH.confederation];
    const focus = new Map([[homeTeam, 'home'], [awayTeam, 'away']]);
    return `
      <div class="ctx-section-label">Eliminatórias <span class="ctx-section-sub">${escapeHtml(conf.namePt)}</span></div>
      <div class="rx-qual">
        ${qualLegend(homeTeam, awayTeam)}
        ${renderConfederation(conf, focus)}
      </div>`;
  }

  return `
    <div class="ctx-section-label">Eliminatórias <span class="ctx-section-sub">campanha classificatória</span></div>
    <div class="rx-qual rx-qual-split">
      ${okH ? renderCampaignBlock(homeTeam, qualifiers, 'home') : ''}
      ${okA ? renderCampaignBlock(awayTeam, qualifiers, 'away') : ''}
    </div>`;
}

// ============================================================
// API pública
// ============================================================
export function hasRaioX(homeTeam, awayTeam, data) {
  if (!homeTeam || !awayTeam) return false;
  const { recentByTeam, h2h, predictions, qualifiers } = data;
  // Cada seção só conta se TEM dado real (igual às odds): previsão presente,
  // H2H com confrontos de verdade, forma recente, ou campanha de eliminatórias.
  const hasH2H = !!h2h?.fixtures?.length;
  const hasQual = qualHas(qualifiers, homeTeam) || qualHas(qualifiers, awayTeam);
  return !!predictions || hasH2H || hasQual
    || recentByTeam.has(homeTeam) || recentByTeam.has(awayTeam);
}

// Conteúdo interno (seções). Reutilizado pelo painel inline e pelo modal.
// Cada seção é independente: só entra se tiver dado real (sem placeholders /
// "nenhum confronto"). Forma recente é o piso comum; previsão e H2H entram só
// quando a API trouxe algo pra aquela partida.
export function renderRaioXContent(homeTeam, awayTeam, data) {
  const { recentByTeam, h2h, predictions, qualifiers } = data;
  const hasRecent = recentByTeam.has(homeTeam) || recentByTeam.has(awayTeam);
  const hasH2H = !!h2h?.fixtures?.length;
  const hasQual = qualHas(qualifiers, homeTeam) || qualHas(qualifiers, awayTeam);

  return `
    <div class="ctx-inner">
      ${predictions ? renderPredictionsBlock(homeTeam, awayTeam, predictions) : ''}
      ${hasRecent ? `
      <div class="ctx-section-label">Forma recente <span class="ctx-section-sub">últimos jogos</span></div>
      <div class="rx-recent">
        ${renderRecentBlock(homeTeam, recentByTeam)}
        ${renderRecentBlock(awayTeam, recentByTeam)}
      </div>` : ''}

      ${hasH2H ? `
      <div class="ctx-section-label">Confronto direto</div>
      ${renderH2HBlock(homeTeam, awayTeam, h2h)}` : ''}

      ${hasQual ? renderQualifiersBlock(homeTeam, awayTeam, qualifiers) : ''}
    </div>
  `;
}

// ----- Variante INLINE (fase de grupos): botão + painel expansível -----
export function renderRaioXToggle(matchId, homeTeam, awayTeam, data) {
  if (!hasRaioX(homeTeam, awayTeam, data)) return '';
  return `<div class="match-raiox">
    <button type="button" class="ctx-toggle" data-raiox-inline="${matchId}" aria-expanded="false" aria-controls="ctx-${matchId}">
      <span class="ctx-toggle-ic" aria-hidden="true">🔍</span> Raio-X
    </button>
  </div>`;
}
export function renderRaioXPanel(matchId, homeTeam, awayTeam, data) {
  if (!hasRaioX(homeTeam, awayTeam, data)) return '';
  return `<div class="match-context" id="ctx-${matchId}" hidden>${renderRaioXContent(homeTeam, awayTeam, data)}</div>`;
}

// Liga o expand/collapse dos painéis inline (1 listener global, idempotente).
// Exclusividade: ao abrir um, fecha qualquer outro Raio-X aberto na página.
let inlineAttached = false;
export function attachRaioXInline() {
  if (inlineAttached) return;
  inlineAttached = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.ctx-toggle[data-raiox-inline]');
    if (!btn) return;
    const id = btn.dataset.raioxInline;
    const panel = document.getElementById(`ctx-${id}`);
    if (!panel) return;
    const willOpen = panel.hasAttribute('hidden');
    if (willOpen) {
      document.querySelectorAll('.match-context:not([hidden])').forEach(p => {
        if (p !== panel) p.setAttribute('hidden', '');
      });
      document.querySelectorAll('.ctx-toggle[aria-expanded="true"]').forEach(b => {
        if (b !== btn) b.setAttribute('aria-expanded', 'false');
      });
    }
    panel.toggleAttribute('hidden', !willOpen);
    btn.setAttribute('aria-expanded', String(willOpen));
  });
}

// ----- Variante MODAL (mata-mata): botão compacto + overlay -----
export function renderRaioXModalButton(matchId, homeTeam, awayTeam, data) {
  if (!hasRaioX(homeTeam, awayTeam, data)) return '';
  return `<button type="button" class="rx-modal-btn" data-raiox-modal="${matchId}" title="Raio-X do confronto">
    <span aria-hidden="true">🔍</span> Raio-X
  </button>`;
}

function ensureModal() {
  let modal = document.getElementById('raioxModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'raioxModal';
  modal.className = 'raiox-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="raiox-modal-backdrop" data-raiox-close></div>
    <div class="raiox-modal-box" role="dialog" aria-modal="true" aria-label="Raio-X do confronto">
      <div class="raiox-modal-head">
        <div class="raiox-modal-title"></div>
        <button type="button" class="raiox-modal-x" data-raiox-close aria-label="Fechar">✕</button>
      </div>
      <div class="raiox-modal-body"></div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-raiox-close]')) closeRaioXModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeRaioXModal();
  });
  return modal;
}

export function openRaioXModal({ homeTeam, awayTeam, titleHtml, data }) {
  const modal = ensureModal();
  modal.querySelector('.raiox-modal-title').innerHTML = titleHtml
    || `${escapeHtml(teamPt(homeTeam))} <span class="rx-vs">×</span> ${escapeHtml(teamPt(awayTeam))}`;
  modal.querySelector('.raiox-modal-body').innerHTML = renderRaioXContent(homeTeam, awayTeam, data);
  modal.hidden = false;
  document.body.classList.add('raiox-modal-open');
}

export function closeRaioXModal() {
  const modal = document.getElementById('raioxModal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('raiox-modal-open');
}

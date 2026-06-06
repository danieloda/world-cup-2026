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
  if (!m || !d) return '';  // data malformada (não-ISO) → vazio, não "undefined/undefined"
  return `${d}/${m}`;
}
function compPt(name) {
  if (!name) return '';
  if (COMP_PT[name]) return COMP_PT[name];
  for (const [k, v] of Object.entries(COMP_PT)) if (name.includes(k)) return v;
  return name;
}

// Rótulo CURTO e discreto da competição pra forma recente. Os dados já vêm quase
// todos em PT (Amistoso, Eliminatórias…); aqui só encurto os longos e traduzo o
// que sobrou em inglês. Fallback: compPt + corte defensivo.
const COMP_RECENT = {
  'Eliminatórias': 'Elim. da Copa',
  'World Cup - Qualification': 'Elim. da Copa',
  'Copa Africana': 'Copa Africana',
  'Nations League': 'Liga das Nações',
  'UEFA Nations League': 'Liga das Nações',
  'Arab Cup': 'Copa Árabe',
  'FIFA Series': 'FIFA Series',
  'EAFF E-1 Football Championship': 'EAFF E-1',
  'Copa Ouro': 'Copa Ouro',
};
function compRecent(name) {
  if (!name) return '';
  const s = COMP_RECENT[name] || compPt(name);
  return s.length > 16 ? s.slice(0, 15) + '…' : s;
}
function fmtH2HDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '';  // data malformada → vazio, não "undefined/undefined/"
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

  const axisDesc = axes.map((ax, i) =>
    `${ax}: ${teamPt(homeTeam)} ${Math.round(clamp(home[i]))}, ${teamPt(awayTeam)} ${Math.round(clamp(away[i]))}`).join('; ');
  return `
    <div class="rx-cmp-label-head">Comparação de força</div>
    <div class="rx-radar">
      <svg viewBox="0 0 240 212" class="rx-radar-svg" role="img"
           aria-label="Comparação de força — ${escapeHtml(axisDesc)}">
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

// Previsão — duas metades independentes:
//   • barra 1X2  → probabilidade implícita das ODDS (de-margined; ver oddsToProbs
//                  em util.js e buildForecast em palpites-grupos.js). Aparece em
//                  todo jogo com odds — o favorito é o do MERCADO.
//   • radar      → comparação de força (form/ataque/defesa) do /predictions da
//                  API-Football. Aparece só quando a API trouxe last_5.
// Renderiza se houver QUALQUER uma das duas. Verde = casa, vermelho = visitante,
// amarelo = empate (mesmo vocabulário visual da balança, .ctx-balance).
export function renderPredictionsBlock(homeTeam, awayTeam, pred, { label = true } = {}) {
  const pH = pct(pred?.pHome), pD = pct(pred?.pDraw), pA = pct(pred?.pAway);
  const hasBar = (pH + pD + pA) > 0;
  const hasRadar = !!pred?.radar?.axes?.length;
  if (!hasBar && !hasRadar) return '';

  const homePt = teamPt(homeTeam);
  const awayPt = teamPt(awayTeam);
  const favored = pred.favored;  // 'home' | 'draw' | 'away'
  const verdictName = favored === 'home' ? homePt : favored === 'away' ? awayPt : 'Empate';
  const verdictCls  = favored === 'draw' ? 'draw' : favored === 'away' ? 'away' : 'home';

  const seg = (p, cls) => p > 0
    ? `<span class="rx-1x2-seg ${cls}" style="flex:${p}">${Math.round(p)}%</span>` : '';

  const bar = hasBar ? `
      <div class="rx-1x2-head">
        <span class="rx-1x2-team home"><span class="flag">${flag(homeTeam)}</span>${escapeHtml(homePt)}</span>
        <span class="rx-1x2-draw">empate</span>
        <span class="rx-1x2-team away">${escapeHtml(awayPt)}<span class="flag">${flag(awayTeam)}</span></span>
      </div>
      <div class="rx-1x2-bar" role="img" aria-label="${Math.round(pH)}% vitória ${escapeHtml(homePt)}, ${Math.round(pD)}% empate, ${Math.round(pA)}% vitória ${escapeHtml(awayPt)}">
        ${seg(pH, 'home')}${seg(pD, 'draw')}${seg(pA, 'away')}
      </div>
      <div class="rx-1x2-verdict ${verdictCls}">Favorito: <b>${escapeHtml(verdictName)}</b></div>` : '';

  return `
    ${label ? `<div class="ctx-section-label">Previsão <span class="ctx-section-sub">${escapeHtml(pred.source || 'mercado')}</span></div>` : ''}
    <div class="rx-pred">
      ${bar}
      ${hasRadar ? renderPredictionsRadar(pred, homeTeam, awayTeam) : ''}
    </div>
  `;
}
export function renderRecentBlock(team, recentByTeam) {
  // Guarda defensiva: se o load de "jogos recentes" falhou (recentByTeam ausente),
  // mostra o estado vazio em vez de estourar e derrubar o painel inteiro.
  const rec = recentByTeam?.get?.(team);
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
    const comp = compRecent(r.competition);
    return `${divider}
      <li>
        <span class="rx-r ${res.c}">${res.l}</span>
        <span class="rx-when">${escapeHtml(fmtRecentDate(r.date))}</span>
        <span class="rx-opp-wrap">
          <span class="rx-opp">
            <span class="rx-loc ${r.home ? 'home' : 'away'}" title="${r.home ? 'Em casa' : 'Fora'}">${r.home ? 'C' : 'F'}</span>
            <span class="flag">${flag(r.opponent)}</span>
            <span class="rx-opp-name">${escapeHtml(teamPt(r.opponent))}</span>
          </span>
          ${comp ? `<span class="rx-comp">${escapeHtml(comp)}</span>` : ''}
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
export function renderH2HBlock(homeTeam, awayTeam, h2h) {
  const homePt = teamPt(homeTeam);
  const awayPt = teamPt(awayTeam);

  // Sem confrontos registrados → não mostra NADA (sem dado, sem seção). O gating
  // em rxSections já evita chegar aqui vazio; isto é a guarda defensiva pra
  // qualquer outro caller.
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

// Status AUTORITATIVO de uma linha: 'q' classificado direto, 'p' repescagem,
// '' não classificou (eliminado).
//
// Para TIME DA COPA o critério é o campo `playoff` (chave de repescagem real:
// UEFA_PO / INTERCONT), não a descrição. Isso evita o falso-positivo do Qatar e
// da Arábia, que ganharam a 4ª fase da AFC (= classificação DIRETA; a repescagem
// asiática é a 5ª fase, caminho do Iraque) mas cujas linhas da 3ª fase trazem
// "Play-offs - 4ª fase" — o heurístico antigo as marcava como repescagem.
//
// Só PARA LINHA DE CONTEXTO (time que NÃO está na Copa) o heurístico de
// descrição segue valendo, pra colorir na tabela quem foi à repescagem e caiu.
function qualStatusFor(qualifiers, team, desc) {
  const rec = qualifiers?.teams?.[team];
  if (rec && rec.format !== 'unknown') return rec.playoff ? 'p' : 'q';
  const d = String(desc || '').toLowerCase();
  if (d.includes('play') || d.includes('fifth stage') || /\(promotion\)\s*$/.test(d)) return 'p';
  return '';
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
function qualRows(group, focus, qualifiers) {
  return group.rows.map(r => {
    const st = qualStatusFor(qualifiers, r.team, r.description);
    return {
      pos: r.rank, team: r.team,
      j: r.played, v: r.win, e: r.draw, d: r.lose, sg: r.gd, pts: r.points,
      cls: st === 'q' ? 'qualified' : st === 'p' ? 'third' : 'out',
      hl: focus.get(r.team) || '',
    };
  });
}

// Card de um grupo (mesmo .group-card dos grupos), com a tabela canônica.
function renderQualGroupCard(group, focus, qualifiers) {
  const focusRow = group.rows.find(r => focus.has(r.team));
  const headTag = focusRow ? qualTag(qualStatusFor(qualifiers, focusRow.team, focusRow.description)) : '';
  return `
    <div class="group-card">
      <div class="group-head">
        <div class="group-name sm">${escapeHtml(groupNamePt(group.name))}</div>
        ${headTag}
      </div>
      ${renderStandingTable(qualRows(group, focus, qualifiers))}
    </div>`;
}

// Mostra apenas o(s) grupo(s) do(s) time(s) em foco (não a confederação inteira).
function renderConfederation(conf, focus, qualifiers) {
  const focusTeams = new Set(focus.keys());
  const hasFocus = g => g.rows.some(r => focusTeams.has(r.team));
  const focusGroups = conf.groups.filter(hasFocus);
  const groups = focusGroups.length ? focusGroups : conf.groups;
  return `<div class="groups-grid">${groups.map(g => renderQualGroupCard(g, focus, qualifiers)).join('')}</div>`;
}

function campaignSummaryLine(conf, team, qualifiers) {
  const hit = findTeamRow(conf, team);
  if (!hit) return '';
  const { group, row } = hit;
  return `<div class="rx-qsum"><b>${row.rank}º</b> · ${escapeHtml(groupNamePt(group.name))} · ${row.points} pts · ${row.played}J <span class="rx-qwld">${row.win}V ${row.draw}E ${row.lose}D</span> · SG ${row.gd > 0 ? '+' : ''}${row.gd} ${qualTag(qualStatusFor(qualifiers, team, row.description))}</div>`;
}

// Mantém só os confrontos no CAMINHO do time em foco. A repescagem
// intercontinental dá 2 vagas = 2 caminhos independentes, cada um com sua final;
// sem filtrar, o Raio-X de um time mostrava a final do OUTRO caminho também.
// Caminha de trás pra frente (final → semis): parte do time em foco e vai
// conectando quem ele (e seus adversários) enfrentou. Guarda: se o foco não
// aparece em nenhum confronto, devolve tudo.
function bracketFocusRounds(rounds, focusTeam) {
  if (!focusTeam) return rounds;
  const connected = new Set([focusTeam]);
  const kept = rounds.map(() => []);
  for (let i = rounds.length - 1; i >= 0; i--) {
    for (const t of rounds[i].ties) {
      if (connected.has(t.home) || connected.has(t.away)) {
        kept[i].push(t);
        if (t.home) connected.add(t.home);
        if (t.away) connected.add(t.away);
      }
    }
  }
  if (!kept.some(ties => ties.length)) return rounds;
  return rounds.map((rd, i) => ({ ...rd, ties: kept[i] })).filter(rd => rd.ties.length);
}

// Mata-mata → chave (rounds empilhados, com o time em foco destacado).
function renderQualBracket(br, focusTeam) {
  const rounds = bracketFocusRounds(br.rounds, focusTeam).map(rd => {
    const ties = rd.ties.map(t => {
      const hw = t.homeWinner === true || (t.homeGoals != null && t.awayGoals != null && t.homeGoals > t.awayGoals);
      const aw = t.awayWinner === true || (t.homeGoals != null && t.awayGoals != null && t.homeGoals < t.awayGoals);
      const focH = t.home === focusTeam, focA = t.away === focusTeam;
      return `
        <div class="rx-tie${focH || focA ? ' is-focus' : ''}">
          <span class="rx-tie-t home ${hw ? 'win' : ''}${focH ? ' foc' : ''}"><span class="flag">${flag(t.home)}</span>${escapeHtml(teamPt(t.home))}</span>
          <span class="rx-tie-sc"><b class="${hw ? 'win' : ''}">${t.homeGoals ?? '–'}</b><i>×</i><b class="${aw ? 'win' : ''}">${t.awayGoals ?? '–'}</b>${t.status === 'PEN' ? '<small class="rx-tie-pen">pên</small>' : ''}</span>
          <span class="rx-tie-t away ${aw ? 'win' : ''}${focA ? ' foc' : ''}">${escapeHtml(teamPt(t.away))}<span class="flag">${flag(t.away)}</span></span>
        </div>`;
    }).join('');
    return `<div class="rx-round"><div class="rx-round-name">${escapeHtml(roundPt(rd.name))}</div>${ties}</div>`;
  }).join('');
  return `<div class="rx-bracket">${rounds}</div>`;
}

// Bloco da repescagem (mata-mata) de um time, quando ele jogou tabela E um
// bracket de repescagem (ex.: vencedores da Intercontinental). Mostra só o
// CAMINHO do time (a final dele + a semi que a alimentou) — junto da tabela.
function renderPlayoffBlock(team, qualifiers) {
  const rec = qualifiers?.teams?.[team];
  const br = rec?.playoff && qualifiers.brackets?.[rec.playoff];
  if (!br) return '';
  return `
    <div class="rx-qplayoff">
      <div class="rx-qplayoff-h">${escapeHtml(br.namePt)}</div>
      ${renderQualBracket(br, team)}
    </div>`;
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
    sumLine = campaignSummaryLine(conf, team, qualifiers);
    // tabela da confederação + (se houve) o mata-mata da repescagem
    body = renderConfederation(conf, new Map([[team, 'focus']]), qualifiers)
         + renderPlayoffBlock(team, qualifiers);
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

export function renderQualifiersBlock(homeTeam, awayTeam, qualifiers, { label = true } = {}) {
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
      ${label ? `<div class="ctx-section-label">Eliminatórias <span class="ctx-section-sub">${escapeHtml(conf.namePt)}</span></div>` : ''}
      <div class="rx-qual">
        ${qualLegend(homeTeam, awayTeam)}
        ${renderConfederation(conf, focus, qualifiers)}
        ${renderPlayoffBlock(homeTeam, qualifiers)}
        ${renderPlayoffBlock(awayTeam, qualifiers)}
      </div>`;
  }

  return `
    ${label ? `<div class="ctx-section-label">Eliminatórias <span class="ctx-section-sub">campanha classificatória</span></div>` : ''}
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
  // Cada seção só conta se TEM dado real: previsão presente (barra das odds ou
  // radar), H2H com confrontos de verdade, forma recente, ou eliminatórias.
  const hasH2H = !!h2h?.fixtures?.length;
  const hasQual = qualHas(qualifiers, homeTeam) || qualHas(qualifiers, awayTeam);
  return !!predictions || hasH2H || hasQual
    || recentByTeam.has(homeTeam) || recentByTeam.has(awayTeam);
}

// ============================================================
// Faixa-resumo (o "de relance") + abas (o detalhe por seção)
// ============================================================
// V/E/D dos últimos 5 jogos de um time (pro card de forma).
function rxLast5(team, recentByTeam) {
  const rec = recentByTeam?.get?.(team);
  if (!rec || !rec.length) return null;
  return rec.slice(0, 5).map(r => recentResult(r.score).c); // 'v' | 'e' | 'd'
}
// Posição/condição de classificação de um time (pro card de eliminatórias).
function rxQualPos(qualifiers, team) {
  const rec = qualifiers?.teams?.[team];
  if (!rec || rec.format === 'unknown') return null;
  if (rec.format === 'host') return 'Sede';
  if (rec.format === 'bracket') return 'Mata-mata';
  const conf = qualifiers.confederations?.[rec.confederation];
  const hit = conf && findTeamRow(conf, team);
  return hit ? `${hit.row.rank}º` : null;
}

const RX_WDL_L = { v: 'V', e: 'E', d: 'D' };
function rxWdlChips(arr) {
  if (!arr) return `<span class="rxx-wdl-none">—</span>`;
  return `<span class="rxx-wdl">${arr.map(c => `<i class="${c}">${RX_WDL_L[c]}</i>`).join('')}</span>`;
}
function rxTwoRows(home, away, hv, av) {
  return `<div class="rxx-stat-forms">
    <div class="rxx-form-row"><span class="flag">${flag(home)}</span>${hv}</div>
    <div class="rxx-form-row"><span class="flag">${flag(away)}</span>${av}</div>
  </div>`;
}

// Cada card aponta (data-rxx-go) pra sua aba — clicar nele abre o detalhe.
function rxStatFav(home, away, pred) {
  if (!pred || (pct(pred.pHome) + pct(pred.pDraw) + pct(pred.pAway)) === 0) return '';
  const f = pred.favored;
  const name = f === 'home' ? teamPt(home) : f === 'away' ? teamPt(away) : 'Empate';
  const p = f === 'home' ? pct(pred.pHome) : f === 'away' ? pct(pred.pAway) : pct(pred.pDraw);
  const fl = f === 'draw' ? '' : `<span class="flag">${flag(f === 'home' ? home : away)}</span>`;
  return `<div class="rxx-stat" data-rxx-go="pred" role="button" tabindex="0">
    <div class="rxx-stat-l">Favorito</div>
    <div class="rxx-stat-v rxx-fav ${f}">${fl}<span class="rxx-fav-n">${escapeHtml(name)}</span><span class="pct">${Math.round(p)}%</span></div>
  </div>`;
}
function rxStatForm(home, away, recentByTeam) {
  const h = rxLast5(home, recentByTeam), a = rxLast5(away, recentByTeam);
  if (!h && !a) return '';
  return `<div class="rxx-stat" data-rxx-go="form" role="button" tabindex="0">
    <div class="rxx-stat-l">Forma · últimos 5</div>
    ${rxTwoRows(home, away, rxWdlChips(h), rxWdlChips(a))}
  </div>`;
}
function rxStatH2H(home, away, h2h) {
  if (!h2h?.fixtures?.length) return '';
  const s = h2h.summary || { home_wins: 0, draws: 0, away_wins: 0, total: 0 };
  return `<div class="rxx-stat" data-rxx-go="h2h" role="button" tabindex="0">
    <div class="rxx-stat-l">Confronto · ${s.total}</div>
    <div class="rxx-stat-v rxx-h2h"><span class="flag">${flag(home)}</span><b class="v">${s.home_wins}</b><i>·</i><b class="e">${s.draws}</b><i>·</i><b class="a">${s.away_wins}</b><span class="flag">${flag(away)}</span></div>
  </div>`;
}
function rxStatQual(home, away, qualifiers) {
  const ph = rxQualPos(qualifiers, home), pa = rxQualPos(qualifiers, away);
  if (!ph && !pa) return '';
  const cell = v => `<span class="rxx-qpos">${v ? escapeHtml(v) : '—'}</span>`;
  return `<div class="rxx-stat" data-rxx-go="qual" role="button" tabindex="0">
    <div class="rxx-stat-l">Eliminatórias</div>
    ${rxTwoRows(home, away, cell(ph), cell(pa))}
  </div>`;
}
function rxSummary(home, away, data) {
  const cards = [
    rxStatFav(home, away, data.predictions),
    rxStatForm(home, away, data.recentByTeam),
    rxStatH2H(home, away, data.h2h),
    rxStatQual(home, away, data.qualifiers),
  ].filter(Boolean);
  return cards.length ? `<div class="rxx-summary">${cards.join('')}</div>` : '';
}

// Seções (abas) — só as que têm dado; label interno desligado (a aba já nomeia).
const RX_TAB_ABBR = { qual: 'Elim.' }; // rótulo curto em telas estreitas
function rxSections(home, away, data) {
  const { recentByTeam, h2h, predictions, qualifiers } = data;
  const out = [];
  if (predictions)
    out.push({ key: 'pred', label: 'Previsão', html: renderPredictionsBlock(home, away, predictions, { label: false }) });
  if (recentByTeam.has(home) || recentByTeam.has(away))
    out.push({ key: 'form', label: 'Forma', html: `<div class="rx-recent">${renderRecentBlock(home, recentByTeam)}${renderRecentBlock(away, recentByTeam)}</div>` });
  if (h2h?.fixtures?.length)
    out.push({ key: 'h2h', label: 'Confronto', html: renderH2HBlock(home, away, h2h) });
  if (qualHas(qualifiers, home) || qualHas(qualifiers, away))
    out.push({ key: 'qual', label: 'Eliminatórias', html: renderQualifiersBlock(home, away, qualifiers, { label: false }) });
  return out.filter(s => s.html);
}

// Conteúdo do Raio-X: faixa-resumo (de relance) + abas com o detalhe pesado.
// Reutilizado pelo painel inline (grupos) e pelo modal (mata-mata). O container
// .rxx tem max-width: contém o painel inline largo do desktop e iguala o modal.
export function renderRaioXContent(homeTeam, awayTeam, data) {
  const summary = rxSummary(homeTeam, awayTeam, data);
  const secs = rxSections(homeTeam, awayTeam, data);

  let tabsBlock = '';
  if (secs.length) {
    const single = secs.length === 1;
    // uid único por instância — há vários Raio-X na mesma página (1 por jogo),
    // então ids de tab/painel não podem colidir (aria-controls/labelledby válidos).
    const uid = (renderRaioXContent._n = (renderRaioXContent._n || 0) + 1);
    const tabs = secs.map((s, i) => {
      const abbr = RX_TAB_ABBR[s.key];
      const lbl = abbr
        ? `<span class="rxx-tab-full">${s.label}</span><span class="rxx-tab-abbr">${abbr}</span>`
        : s.label;
      return `<button type="button" class="rxx-tab" role="tab" id="rxx-tab-${uid}-${s.key}" aria-controls="rxx-panel-${uid}-${s.key}" data-rxx-tab="${s.key}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${lbl}</button>`;
    }).join('');
    const panels = secs.map((s, i) =>
      `<div class="rxx-panel" id="rxx-panel-${uid}-${s.key}" data-rxx-key="${s.key}" role="tabpanel" aria-labelledby="rxx-tab-${uid}-${s.key}" tabindex="0"${i === 0 ? '' : ' hidden'}>${s.html}</div>`).join('');
    tabsBlock = `<div class="rxx-tabs${single ? ' is-single' : ''}" role="tablist">${tabs}</div><div class="rxx-panels">${panels}</div>`;
  }

  // Fonte dos dados: tudo vem da API-Football; a barra 1X2 usa odds (Betano)
  // quando há forecast de odds (predictions.source carrega o bookmaker).
  const src = ['API-Football'];
  const ps = data.predictions?.source;
  if (ps && ps !== 'API-Football') src.unshift(`odds ${ps}`);
  const footer = `<div class="rxx-source">Fonte: ${escapeHtml(src.join(' · '))}</div>`;

  return `<div class="ctx-inner"><div class="rxx">${summary}${tabsBlock}${footer}</div></div>`;
}

// Troca de aba — 1 listener global delegado, escopo por container .rxx. Atende
// também clique/teclado nos cards do resumo (data-rxx-go) como atalho pra abrir
// a aba correspondente. Idempotente.
let tabsAttached = false;
export function attachRaioXTabs() {
  if (tabsAttached) return;
  tabsAttached = true;
  const activate = (root, key) => {
    if (!root || !key) return;
    let found = false;
    root.querySelectorAll('.rxx-tab').forEach(t => {
      const on = t.dataset.rxxTab === key;
      if (on) found = true;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    if (!found) return;
    root.querySelectorAll('.rxx-panel').forEach(p => {
      p.toggleAttribute('hidden', p.dataset.rxxKey !== key);
    });
  };
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.rxx-tab[data-rxx-tab]');
    if (tab) return activate(tab.closest('.rxx'), tab.dataset.rxxTab);
    const card = e.target.closest('.rxx-stat[data-rxx-go]');
    if (card) activate(card.closest('.rxx'), card.dataset.rxxGo);
  });
  document.addEventListener('keydown', (e) => {
    // Navegação por seta/Home/End no tablist (WAI-ARIA tabs pattern).
    const tab = e.target.closest('.rxx-tab[data-rxx-tab]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      const tabs = [...tab.closest('.rxx-tabs').querySelectorAll('.rxx-tab')];
      const i = tabs.indexOf(tab);
      let j = i;
      if (e.key === 'ArrowLeft')  j = (i - 1 + tabs.length) % tabs.length;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      if (e.key === 'Home') j = 0;
      if (e.key === 'End')  j = tabs.length - 1;
      e.preventDefault();
      const next = tabs[j];
      activate(next.closest('.rxx'), next.dataset.rxxTab);
      next.focus();
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // Enter/Espaço em aba ou card de resumo.
    if (tab) { e.preventDefault(); return activate(tab.closest('.rxx'), tab.dataset.rxxTab); }
    const card = e.target.closest('.rxx-stat[data-rxx-go]');
    if (!card) return;
    e.preventDefault();
    activate(card.closest('.rxx'), card.dataset.rxxGo);
  });
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

let raioxLastFocus = null;
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
    if (modal.hidden) return;
    if (e.key === 'Escape') { closeRaioXModal(); return; }
    if (e.key === 'Tab') {
      const list = [...modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(el => el.offsetParent !== null);
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  return modal;
}

export function openRaioXModal({ homeTeam, awayTeam, titleHtml, data }) {
  const modal = ensureModal();
  raioxLastFocus = document.activeElement;   // pra restaurar o foco ao fechar
  modal.querySelector('.raiox-modal-title').innerHTML = titleHtml
    || `${escapeHtml(teamPt(homeTeam))} <span class="rx-vs">×</span> ${escapeHtml(teamPt(awayTeam))}`;
  modal.querySelector('.raiox-modal-body').innerHTML = renderRaioXContent(homeTeam, awayTeam, data);
  modal.hidden = false;
  document.body.classList.add('raiox-modal-open');
  modal.querySelector('.raiox-modal-x')?.focus();   // move o foco pra dentro do diálogo
}

export function closeRaioXModal() {
  const modal = document.getElementById('raioxModal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('raiox-modal-open');
  if (raioxLastFocus && typeof raioxLastFocus.focus === 'function') { raioxLastFocus.focus(); raioxLastFocus = null; }
}

// ============================================================
// Raio-X — painel de contexto do confronto
// ============================================================
// Conteúdo compartilhado entre a fase de grupos (painel inline expansível)
// e o mata-mata (modal flutuante, já que o card do bracket é compacto e
// re-renderiza a cada palpite). Duas seções:
//   1. Forma recente   — últimos jogos de cada seleção (recentByTeam)
//   2. Confronto direto — histórico H2H entre as duas seleções
//
// `data` é sempre { recentByTeam, h2h }.
//   recentByTeam: Map<team, [{ date, opponent, home, score, competition }]>
//   h2h:          objeto { fixtures, summary } já resolvido, ou null.
//                 - grupos: vem de match_h2h (por match_id, sempre presente)
//                 - mata:   buscado on-demand por par de times (pode faltar)

import { flag, escapeHtml, teamPt } from './util.js';

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

// ----- blocos -----
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

  if (!h2h || !h2h.fixtures?.length) {
    return `
      <div class="ctx-h2h is-empty">
        <p class="ctx-h2h-none">Sem partidas registradas entre ${escapeHtml(homePt)} e ${escapeHtml(awayPt)}.</p>
      </div>`;
  }

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
// API pública
// ============================================================
export function hasRaioX(homeTeam, awayTeam, data) {
  if (!homeTeam || !awayTeam) return false;
  const { recentByTeam, h2h } = data;
  return !!h2h || recentByTeam.has(homeTeam) || recentByTeam.has(awayTeam);
}

// Conteúdo interno (seções). Reutilizado pelo painel inline e pelo modal.
export function renderRaioXContent(homeTeam, awayTeam, data) {
  const { recentByTeam, h2h } = data;
  const hasRecent = recentByTeam.has(homeTeam) || recentByTeam.has(awayTeam);

  return `
    <div class="ctx-inner">
      ${hasRecent ? `
      <div class="ctx-section-label">Forma recente <span class="ctx-section-sub">últimos jogos</span></div>
      <div class="rx-recent">
        ${renderRecentBlock(homeTeam, recentByTeam)}
        ${renderRecentBlock(awayTeam, recentByTeam)}
      </div>` : ''}

      ${h2h ? `
      <div class="ctx-section-label">Confronto direto</div>
      ${renderH2HBlock(homeTeam, awayTeam, h2h)}` : ''}
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

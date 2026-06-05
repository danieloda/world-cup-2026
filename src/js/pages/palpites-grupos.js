import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, formatBrDate, formatTime,
  isLocked, isLive, lockCountdownLabel, showToast, loadRecentMatches,
  loadQualifiers, teamPt, groundShort, renderDateCalendar, predictionDeadline,
  localDateKey, oddsToProbs,
} from '../util.js';
import { matchPoints, scoreBreakdown } from '../scoring.js';
import {
  renderGroupCard, computeThirds, countThirdsComplete, renderThirdsTable,
} from '../standings-view.js';
import {
  renderRaioXToggle, renderRaioXPanel, attachRaioXInline, attachRaioXTabs,
} from '../raiox.js';

const GP = matchPoints('group'); // { ag:1, ave:4, dg:1, exact:7 }

// ============================================================
// Estado da página
// ============================================================
let profile, stats;
let matches = [];                    // 72 group-stage matches, ordered by date
let predsByMatch = new Map();        // match_id -> prediction row
let goalsByMatch = new Map();        // match_id -> [{player, goals}]
let oddsByMatch = new Map();         // match_id -> { odd_home, odd_draw, odd_away, bookmaker_name } — alimenta a barra 1X2 (prob. implícita); não mais exibida crua no card
let h2hByMatch = new Map();          // match_id -> { fixtures: [...], summary: {...}, api_team_home }
let predictionsByMatch = new Map();  // match_id -> previsão normalizada (ver raiox.js / renderPredictionsBlock)
let recentByTeam = new Map();        // team name -> [{ date, opponent, home, score, competition }] (forma recente)
let qualifiers = null;               // assets/data/qualifiers.json — campanha de eliminatórias (Raio-X)
let activeTab = 'palpites';          // 'palpites' | 'resultados'
let activeGroup = 'all';             // 'all' | 'A'..'L' (ambas as abas operam sempre por grupo)
let groupBy = 'date';                // 'group' | 'date' — dimensão do filtro/agrupamento (padrão: por data)
let activeDate = null;               // ISO yyyy-mm-dd quando groupBy === 'date'
const saveTimers = new Map();        // match_id -> setTimeout handle
const GROUPS = ['A','B','C','D','E','F','G','H','I','J','K','L'];

// Dados que alimentam o Raio-X (módulo ../raiox.js). h2h é a linha de match_h2h
// daquele jogo (ou null).
function raioxData(m) {
  return {
    recentByTeam,
    h2h: h2hByMatch.get(m.id) ?? null,
    predictions: buildForecast(m),
    qualifiers,
  };
}

// "Previsão" do Raio-X = barra 1X2 + radar de força. A BARRA agora vem das ODDS
// (probabilidade implícita de-margined, ver oddsToProbs); o RADAR continua vindo
// do /predictions da API-Football (form/ataque/defesa). Une os dois num objeto
// no shape que renderPredictionsBlock espera. Sem odds, a barra cai pro % da API
// (raro: as odds cobrem todos os jogos de grupo). Retorna null se não há nenhum.
function buildForecast(m) {
  const apiPred = predictionsByMatch.get(m.id) ?? null;   // { pHome,…, radar, comparison, source }
  const probs = oddsToProbs(oddsByMatch.get(m.id));       // das odds, ou null
  if (!probs && !apiPred) return null;
  const bar = probs
    ? { pHome: probs.pHome, pDraw: probs.pDraw, pAway: probs.pAway, favored: probs.favored,
        source: oddsByMatch.get(m.id)?.bookmaker_name || 'Betano' }
    : { pHome: apiPred.pHome, pDraw: apiPred.pDraw, pAway: apiPred.pAway, favored: apiPred.favored,
        source: apiPred.source || 'API-Football' };
  return { ...bar, radar: apiPred?.radar ?? null, comparison: apiPred?.comparison ?? null };
}

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  await loadData();

  applyHashRoute();  // deep-link opcional (ex.: redirects de grupos.html / terceiros.html)

  // Forma recente (últimos jogos de cada seleção) — antes ficava num hover no
  // nome do time; agora vai pro painel Raio-X. Guardado em var de módulo.
  recentByTeam = await loadRecentMatches();
  qualifiers = await loadQualifiers();

  const pageBody = await renderShell({ active: 'palpites-g', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');
  attachEventListeners();
  attachRaioXInline();
  attachRaioXTabs();
} catch (err) {
  console.error('[palpites-grupos] FATAL:', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:#fff; font-family:sans-serif;">
      <h1 style="color:#f15e6c">⚠️ Erro ao carregar Palpites</h1>
      <pre style="background:#000; padding:16px; border-radius:8px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:#f15e6c;">${err.stack || err.message || err}</pre>
      <p style="margin-top:20px;"><a href="inicio.html" style="color:#f4c430">← Voltar ao Início</a></p>
    </div>
  `;
}

// ============================================================
// Data
// ============================================================
async function loadData() {
  const [statsRes, matchesRes, predsRes, goalsRes, oddsRes, h2hRes, forecastRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    supabase.from('matches').select('*').eq('stage', 'group').order('match_date'),
    supabase.from('predictions').select('*').eq('user_id', profile.id),
    supabase.from('player_goals').select('*, players(full_name, team)'),
    supabase.from('match_odds').select('match_id, odd_home, odd_draw, odd_away, bookmaker_name'),
    supabase.from('match_h2h').select('match_id, fixtures, summary, api_team_home'),
    supabase.from('match_predictions').select('match_id, payload'),
  ]);

  if (matchesRes.error) throw matchesRes.error;
  if (predsRes.error)   throw predsRes.error;

  stats = statsRes.data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0 };
  matches = matchesRes.data ?? [];
  predsByMatch = new Map((predsRes.data ?? []).map(p => [p.match_id, p]));
  oddsByMatch = new Map((oddsRes.data ?? []).map(o => [o.match_id, o]));
  h2hByMatch  = new Map((h2hRes.data ?? []).map(h => [h.match_id, h]));
  // Previsão normalizada (match_predictions.payload) — só existe pra jogos que a
  // API trouxe dado útil; o front já não mostra nada pros demais. Degrada gracioso
  // se a migration ainda não foi aplicada (data null → mapa vazio).
  predictionsByMatch = new Map((forecastRes.data ?? []).map(p => [p.match_id, p.payload]));

  goalsByMatch = new Map();
  for (const g of (goalsRes.data ?? [])) {
    if (!goalsByMatch.has(g.match_id)) goalsByMatch.set(g.match_id, []);
    goalsByMatch.get(g.match_id).push(g);
  }
}

// ============================================================
// Render — page shell
// ============================================================
function renderPage() {
  const counts = computeCounts();
  return `
    <section class="hero">
      <div class="hero-kicker">Palpitar placares · Fase de grupos</div>
      <h1 class="hero-title">${heroTitle()}</h1>
      <div class="hero-meta">
        <b>${matches.length} jogos</b><span class="sep"></span>
        <b>${counts.totalDone}</b> palpitados<span class="sep"></span>
        <b>${counts.totalFinished}</b> finalizados
      </div>
    </section>

    <div class="admin-tabs">
      <button class="admin-tab ${activeTab === 'palpites' ? 'active' : ''}" data-tab="palpites">
        Palpites <span class="ct">${counts.totalRemaining}</span>
      </button>
      <button class="admin-tab ${activeTab === 'resultados' ? 'active' : ''}" data-tab="resultados">
        Resultados oficiais <span class="ct">${counts.totalFinished}</span>
      </button>
    </div>

    <div id="tabBody">
      ${renderActiveTab(counts)}
    </div>
  `;
}

// Deep-link via hash. Usado pelos redirects das antigas grupos.html / terceiros.html
// e por URLs compartilháveis. Define activeTab antes do primeiro render.
function applyHashRoute() {
  switch ((location.hash || '').replace('#', '')) {
    // Antigas sub-abas/páginas oficiais agora vivem todas na aba Resultados (por grupo).
    case 'classificacao':
    case 'terceiros':
    case 'jogos':
    case 'resultados':    activeTab = 'resultados'; break;
    // 'simulacao' foi fundida na aba Palpites (projeção + 3ºs no hover)
    case 'simulacao':     activeTab = 'palpites';   break;
    // 'palpites' ou vazio → mantém o default (aba Palpites)
  }
}

function heroTitle() {
  return activeTab === 'resultados' ? 'Resultados oficiais' : 'Seus palpites';
}

function renderActiveTab(counts) {
  return activeTab === 'resultados' ? renderResultadosTab(counts) : renderPalpitesTab(counts);
}

// ============================================================
// TAB: PALPITES (jogos abertos para palpitar)
// ============================================================
function renderPalpitesTab(counts) {
  // Garante uma seleção válida conforme a dimensão ativa.
  if (groupBy === 'date') {
    if (!datesFor('palpites').includes(activeDate)) activeDate = defaultDate('palpites');
  } else if (!GROUPS.includes(activeGroup)) {
    activeGroup = defaultPalpitesGroup();
  }

  return `
    <div class="note">
      <span class="note-head">Como você ganha pontos em cada jogo</span>
      <ul class="note-list">
        <li>🥅 <strong>+${GP.ag}</strong> se acertar quantos gols um time fez (pode valer pelos dois times)</li>
        <li>⚽ <strong>+${GP.ave}</strong> se acertar quem vence — ou que vai dar empate</li>
        <li>➕ <strong>+${GP.dg}</strong> se acertar a diferença de gols</li>
        <li>🎯 Cravou o placar exato? Soma tudo: <strong>${GP.exact} pontos</strong></li>
      </ul>
      <span class="note-deadline">⏰ Cada palpite fecha às 23h59 da véspera do jogo (um dia antes).
        <span class="sub">Até lá, é só digitar o placar — salva sozinho e pode mudar quantas vezes quiser.</span></span>
      <a class="note-link" href="regras.html">Ver todas as regras →</a>
    </div>

    ${renderKpisPalpites(counts)}

    ${renderViewToggle()}

    <div class="palpites-toolbar">
      <div class="chips" id="chips">
        ${groupBy === 'date'
          ? renderDatePicker(counts.openByDate, 'palpites')
          : GROUPS.map(g => renderChip(g, 'Grupo ' + g, counts.openByGroup[g]?.done ?? 0, counts.openByGroup[g]?.total ?? 0)).join('')}
      </div>
      ${groupBy === 'group' ? renderThirdsPop('sim') : ''}
    </div>

    <div class="tooltip-hint raiox-hint">
      🔍 Toque em <b>Raio-X</b> em cada jogo para ver o <b>favorito do mercado</b>, a <b>forma recente</b>, os <b>confrontos diretos</b> e a campanha nas <b>eliminatórias</b>.
    </div>

    <div id="matchesList">
      ${renderPalpitesList()}
    </div>

    <div id="palpitesGroupTable">
      ${groupBy === 'group' ? renderGroupTable('sim') : ''}
    </div>
  `;
}

// Primeiro grupo (A..L) com pelo menos 1 jogo em aberto; senão o primeiro grupo.
function defaultPalpitesGroup() {
  return GROUPS.find(g => matches.some(m => m.group_name === g && !m.finished)) || GROUPS[0];
}

// Popover (hover/clique) com os melhores 3ºs. mode 'sim' = projeção dos palpites;
// 'real' = oficial. Compartilhado por Palpites e Resultados.
function renderThirdsPop(mode = 'sim') {
  return `
    <div class="thirds-pop" id="thirdsPop">
      <button class="thirds-pop-trigger" type="button" data-action="toggle-thirds" aria-expanded="false">
        🥉 Melhores 3ºs <span class="hint">${mode === 'real' ? 'oficial' : 'sua projeção'}</span>
      </button>
      <div class="thirds-pop-panel" id="thirdsPopBody">
        ${renderThirdsPopBody(mode)}
      </div>
    </div>
  `;
}

function renderThirdsPopBody(mode = 'sim') {
  const thirds = computeThirds(matches, mode, predsByMatch);
  const completeCount = countThirdsComplete(thirds);
  const head = mode === 'real'
    ? [`8 melhores 3ºs (oficial)`, `${completeCount}/12 grupos finalizados · 8 avançam`]
    : [`Projeção dos 8 melhores 3ºs`, `${completeCount}/12 grupos palpitados · 8 avançam`];
  const empty = mode === 'real'
    ? `Os 3ºs lugares aparecem aqui conforme cada grupo termina.`
    : `Palpite todos os 6 jogos de pelo menos 1 grupo para ver a projeção dos 3ºs.`;
  return `
    <div class="thirds-pop-head">
      <strong>${head[0]}</strong>
      <span>${head[1]}</span>
    </div>
    ${completeCount === 0
      ? `<p class="thirds-pop-empty">${empty}</p>`
      : `<div class="thirds-wrap">${renderThirdsTable(thirds)}</div>`}
  `;
}

// Tabela de classificação do grupo selecionado. mode 'sim' = projeção dos palpites;
// 'real' = oficial. Compartilhada por Palpites e Resultados.
function renderGroupTable(mode = 'sim') {
  if (!GROUPS.includes(activeGroup)) return '';
  const gm = matches.filter(m => m.group_name === activeGroup);
  const title = mode === 'real' ? 'Classificação oficial' : 'Classificação projetada';
  const sub = mode === 'real'
    ? `${gm.filter(m => m.finished).length}/6 jogos finalizados`
    : `a partir dos seus palpites`;
  return `
    <div class="date-head" style="margin-top:28px;">
      <h4>${title} · Grupo ${activeGroup}</h4>
      <div class="sub">${sub}</div>
    </div>
    <div class="legend">
      <span class="dot adv">● Verde</span> = classificado direto (1º e 2º) ·
      <span class="dot third">● Bronze</span> = disputa vaga de 3º melhor ·
      <span class="dot out">● Cinza</span> = eliminado
      <br><span class="hint">Veja todos os 3ºs em <strong>Melhores 3ºs</strong>, no topo.</span>
    </div>
    <div class="groups-grid">
      ${renderGroupCard(activeGroup, matches, mode, predsByMatch)}
    </div>
  `;
}

function renderKpisPalpites(counts) {
  const open = counts.totalOpen;
  const doneOpen = counts.totalDoneOpen;
  const pctDone = open ? Math.round(doneOpen / open * 100) : 100;
  return `
    <div class="kpis">
      <div class="kpi green">
        <div class="kpi-label">Palpitados (em aberto)</div>
        <div class="kpi-num">${doneOpen}<small>/${open}</small></div>
        <div class="progress-bar-inline"><span style="width:${pctDone}%"></span></div>
      </div>
      <div class="kpi red">
        <div class="kpi-label">Faltando</div>
        <div class="kpi-num">${open - doneOpen}</div>
        <div class="kpi-sub">${open - doneOpen === 0 ? 'tudo pronto ✓' : 'palpites pendentes'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Total palpites</div>
        <div class="kpi-num">${counts.totalDone}<small>/${matches.length}</small></div>
        <div class="kpi-sub">inclui jogos travados</div>
      </div>
      <div class="kpi gold">
        <div class="kpi-label">Pontos ganhos</div>
        <div class="kpi-num">${counts.totalPoints}</div>
        <div class="kpi-sub">na fase de grupos</div>
      </div>
    </div>
  `;
}

function renderPalpitesList() {
  // Apenas jogos NÃO finalizados (e dentro do filtro)
  const open = matches.filter(m => !m.finished);
  const filtered = groupBy === 'date'
    ? (activeDate ? open.filter(m => dateKey(m) === activeDate) : open)
    : (activeGroup === 'all' ? open : open.filter(m => m.group_name === activeGroup));

  if (filtered.length === 0) {
    return `<div class="empty"><h3>Sem jogos abertos</h3><p>Nenhum jogo aberto para o filtro selecionado.</p></div>`;
  }

  return renderGroupedByDate(filtered, renderPalpiteRow);
}

function renderPalpiteRow(m) {
  const pred = predsByMatch.get(m.id);
  const locked = isLocked(m);
  const live = isLive(m);
  const homeVal = pred?.pred_home ?? '';
  const awayVal = pred?.pred_away ?? '';

  // Horário já aparece no .match-when (canto esquerdo); aqui a pill é só de
  // STATUS (ao vivo / travado). Jogo aberto não repete o horário — o aviso
  // "Bloqueia em X" abaixo já comunica que está aberto.
  const status = live ? `<span class="pill live">Ao vivo</span>`
    : locked ? `<span class="pill locked">Travado</span>`
    : '';
  const lockNote = (!live && !locked)
    ? `<div class="lock-note">${lockCountdownLabel(m.match_date)}</div>`
    : '';

  return `
    <div class="match ${locked ? 'locked' : ''}" data-match-id="${m.id}">
      <div class="match-when">
        <strong>${formatTime(m.match_date)}</strong>
        ${escapeHtml(groundShort(m.ground))}
      </div>
      <div class="team home">
        <span class="flag">${flag(m.team_home)}</span>
        <span class="team-name" data-team="${escapeHtml(m.team_home)}">${escapeHtml(teamPt(m.team_home))}</span>
      </div>
      <div class="score-cell">
        <div class="score-inputs">
          <input class="score-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2"
                 data-match="${m.id}" data-side="home"
                 aria-label="Gols ${escapeHtml(teamPt(m.team_home))}"
                 value="${homeVal}" ${locked ? 'disabled' : ''}>
          <span class="score-sep">–</span>
          <input class="score-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2"
                 data-match="${m.id}" data-side="away"
                 aria-label="Gols ${escapeHtml(teamPt(m.team_away))}"
                 value="${awayVal}" ${locked ? 'disabled' : ''}>
        </div>
      </div>
      <div class="team right away">
        <span class="team-name" data-team="${escapeHtml(m.team_away)}">${escapeHtml(teamPt(m.team_away))}</span>
        <span class="flag">${flag(m.team_away)}</span>
      </div>
      <div class="match-tail">
        ${status}
        ${lockNote}
        <div class="match-group">Grupo ${m.group_name}</div>
      </div>
      ${renderRaioXToggle(m.id, m.team_home, m.team_away, raioxData(m))}
    </div>
    ${renderRaioXPanel(m.id, m.team_home, m.team_away, raioxData(m))}
  `;
}

// Primeiro grupo (A..L) com pelo menos 1 jogo finalizado; senão o primeiro grupo.
function defaultJogosGroup() {
  return GROUPS.find(g => matches.some(m => m.group_name === g && m.finished)) || GROUPS[0];
}

function renderKpisResultados(counts) {
  const exact   = counts.exactCount;
  const partial = counts.partialCount;
  const miss    = counts.missCount;
  const total = counts.totalFinishedWithPred;
  const avg = total > 0 ? (counts.totalPoints / total).toFixed(1) : '0';

  return `
    <div class="kpis">
      <div class="kpi gold">
        <div class="kpi-label">Pontos ganhos</div>
        <div class="kpi-num">${counts.totalPoints}</div>
        <div class="kpi-sub">média ${avg} pts/jogo</div>
      </div>
      <div class="kpi green">
        <div class="kpi-label">Placares exatos</div>
        <div class="kpi-num">${exact}</div>
        <div class="kpi-sub">vale ${GP.exact} pts cada</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Acertos parciais</div>
        <div class="kpi-num">${partial}</div>
        <div class="kpi-sub">vencedor/saldo/gols</div>
      </div>
      <div class="kpi red">
        <div class="kpi-label">Erros</div>
        <div class="kpi-num">${miss}</div>
        <div class="kpi-sub">de ${total} palpites</div>
      </div>
    </div>
  `;
}

function renderResultadosList() {
  const filtered = groupBy === 'date'
    ? matches.filter(m => m.finished && activeDate && dateKey(m) === activeDate)
    : matches.filter(m => m.finished && m.group_name === activeGroup);

  if (filtered.length === 0) {
    const what = groupBy === 'date' ? 'nesta data' : `no Grupo ${activeGroup}`;
    return `
      <div class="empty">
        <h3>Nenhum resultado ${what} ainda</h3>
        <p>Os resultados aparecem aqui conforme o admin lança os placares dos jogos.</p>
        <a class="btn btn-ghost" href="palpites-grupos.html" onclick="document.querySelector('[data-tab=palpites]').click(); return false;">Ver palpites pendentes →</a>
      </div>
    `;
  }

  // Mais recentes primeiro
  const sorted = [...filtered].sort((a, b) => new Date(b.match_date) - new Date(a.match_date));
  return renderGroupedByDate(sorted, renderResultRow, /* descDate */ true);
}

function renderResultRow(m) {
  const pred = predsByMatch.get(m.id);
  const pts = pred?.points_earned;
  const isExact = pred && pred.pred_home === m.actual_home && pred.pred_away === m.actual_away;
  const cardClass = isExact ? 'exact' : pts > 0 ? 'partial' : pred ? 'miss' : 'no-pred';
  const ptsLabel = isExact ? 'Exato!' : pts > 0 ? 'Parcial' : (pred ? 'Errou' : 'Sem palpite');

  // Quebra aditiva do seu palpite (só quando há palpite)
  let breakRow = '';
  if (pred) {
    const { parts } = scoreBreakdown(
      pred.pred_home, pred.pred_away, pred.pred_pen_winner,
      m.actual_home, m.actual_away, m.pen_winner, m.stage,
    );
    breakRow = `<div class="result-card-break">${
      parts.length > 0
        ? parts.map(p => `<span class="brk ${p.key}">${p.label} <b>+${p.pts}</b></span>`).join('')
        : '<span class="brk miss">não pontuou</span>'
    }</div>`;
  }

  const goals = goalsByMatch.get(m.id) ?? [];
  const homeGoals = goals.filter(g => g.players.team === m.team_home);
  const awayGoals = goals.filter(g => g.players.team === m.team_away);

  return `
    <div class="result-card ${cardClass}">
      <div class="result-card-head">
        <div class="result-card-team">
          <span class="flag">${flag(m.team_home)}</span>
          <span class="team-name" data-team="${escapeHtml(m.team_home)}">${escapeHtml(teamPt(m.team_home))}</span>
        </div>
        <div class="result-card-score">${m.actual_home} — ${m.actual_away}</div>
        <div class="result-card-team right">
          <span class="team-name" data-team="${escapeHtml(m.team_away)}">${escapeHtml(teamPt(m.team_away))}</span>
          <span class="flag">${flag(m.team_away)}</span>
        </div>
      </div>

      <div class="result-card-bottom">
        <div class="result-card-info">
          ${pred
            ? `<span>Seu palpite:</span> <span class="pred-score">${pred.pred_home} – ${pred.pred_away}</span>`
            : `<span style="color:var(--text-mute); font-style:italic;">Sem palpite</span>`}
        </div>
        <div class="result-card-points">
          <span class="num">${pts != null ? (pts > 0 ? '+' + pts : pts) : '—'}</span>
          <span class="label">${ptsLabel}</span>
        </div>
        <div class="result-card-meta">
          ${formatBrDateShort(new Date(m.match_date))} · ${formatTime(m.match_date)}
          <br><span class="stage">Grupo ${m.group_name}</span>
        </div>
      </div>

      ${breakRow}

      ${goals.length > 0 ? `
        <div class="result-card-scorers">
          <span class="label">⚽ Gols:</span>
          ${homeGoals.map(g => `<span class="scorer">${escapeHtml(g.players.full_name)} <span class="num">${g.goals}'</span></span>`).join('')}
          ${homeGoals.length && awayGoals.length ? '<span style="color:var(--text-mute); margin: 0 4px;">·</span>' : ''}
          ${awayGoals.map(g => `<span class="scorer">${escapeHtml(g.players.full_name)} <span class="num">${g.goals}'</span></span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

// ============================================================
// TAB: RESULTADOS (oficial) — espelha a aba Palpites, por grupo:
// resultados do grupo → classificação oficial do grupo no fim → 3ºs no hover.
// ============================================================
function renderResultadosTab(counts) {
  // Garante seleção válida conforme a dimensão ativa.
  if (groupBy === 'date') {
    if (!datesFor('resultados').includes(activeDate)) activeDate = defaultDate('resultados');
  } else if (!GROUPS.includes(activeGroup)) {
    activeGroup = defaultJogosGroup();
  }

  return `
    ${renderKpisResultados(counts)}

    ${renderViewToggle()}

    <div class="palpites-toolbar">
      <div class="chips" id="chips">
        ${groupBy === 'date'
          ? renderDatePicker(counts.finishedByDate, 'resultados')
          : GROUPS.map(g => renderChip(g, 'Grupo ' + g, counts.finishedByGroup[g]?.done ?? 0, counts.finishedByGroup[g]?.total ?? 0)).join('')}
      </div>
      ${groupBy === 'group' ? renderThirdsPop('real') : ''}
    </div>

    <div id="matchesList">
      ${renderResultadosList()}
    </div>

    <div id="resultadosGroupTable">
      ${groupBy === 'group' ? renderGroupTable('real') : ''}
    </div>
  `;
}

// ============================================================
// Helpers
// ============================================================
function dateKey(m) {
  return localDateKey(m.match_date);
}

// Datas distintas (yyyy-mm-dd) relevantes para a aba: abertas (palpites) ou
// finalizadas (resultados). Resultados vêm com a data mais recente primeiro.
function datesFor(tab) {
  const rel = tab === 'resultados'
    ? matches.filter(m => m.finished)
    : matches.filter(m => !m.finished);
  const keys = [...new Set(rel.map(dateKey))].sort();
  if (tab === 'resultados') keys.reverse();
  return keys;
}

function defaultDate(tab) {
  return datesFor(tab)[0] ?? null;
}

function renderViewToggle() {
  return `
    <div class="palpites-views">
      <div class="view-toggle" role="tablist" aria-label="Modo de visualização">
        <button class="${groupBy === 'group' ? 'active' : ''}" data-view="group" type="button">Por grupo</button>
        <button class="${groupBy === 'date' ? 'active' : ''}" data-view="date" type="button">📅 Por data</button>
      </div>
    </div>
  `;
}

// Metadados por data para o calendário "Por data": grupos que jogam no dia,
// contador palpitados/total e prazo de bloqueio (para o alerta de cor).
function buildDateMeta(byDate) {
  const groupsByDate = {};
  const deadlineByDate = {};
  for (const m of matches) {
    const dk = dateKey(m);
    (groupsByDate[dk] ??= new Set()).add(m.group_name);
    const dl = predictionDeadline(m.match_date).getTime();
    deadlineByDate[dk] = Math.min(deadlineByDate[dk] ?? Infinity, dl);
  }
  const meta = {};
  for (const dk of Object.keys(byDate)) {
    const gs = [...(groupsByDate[dk] ?? [])].filter(Boolean).sort();
    meta[dk] = {
      info: gs.length ? gs.join(' ') : '',
      title: gs.length ? `Grupo${gs.length > 1 ? 's' : ''} ${gs.join(', ')}` : '',
      done: byDate[dk]?.done ?? 0,
      total: byDate[dk]?.total ?? 0,
      deadline: deadlineByDate[dk],
    };
  }
  return meta;
}

// Calendário de datas para a aba ('palpites' | 'resultados').
function renderDatePicker(byDate, tab) {
  return renderDateCalendar({
    dates: datesFor(tab),
    meta: buildDateMeta(byDate),
    activeDate,
  });
}

function renderGroupedByDate(list, rowRenderer, descDate = false) {
  const byDate = new Map();
  for (const m of list) {
    const key = dateKey(m);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(m);
  }
  const entries = [...byDate.entries()];
  if (descDate) entries.reverse();

  return entries.map(([dateKey, l]) => {
    const d = new Date(dateKey + 'T12:00:00');
    return `
      <div class="date-head">
        <h4>${formatBrDate(d)}</h4>
        <div class="sub">${l.length} jogo${l.length > 1 ? 's' : ''}</div>
      </div>
      ${l.map(rowRenderer).join('')}
    `;
  }).join('');
}

function renderChip(value, label, done, total) {
  const isActive = activeGroup === value;
  const complete = total > 0 && done === total;
  const cls = ['chip'];
  if (isActive) cls.push('active');
  if (complete) cls.push('complete');
  return `
    <button class="${cls.join(' ')}" data-group="${value}">
      ${escapeHtml(label)} <span class="ct">${done}/${total}</span>
    </button>
  `;
}

function computeCounts() {
  const openByGroup = { all: { done: 0, total: 0 } };
  const finishedByGroup = { all: { done: 0, total: 0 } };
  for (const g of GROUPS) {
    openByGroup[g] = { done: 0, total: 0 };
    finishedByGroup[g] = { done: 0, total: 0 };
  }
  const openByDate = {};       // yyyy-mm-dd -> { done, total }
  const finishedByDate = {};

  let totalDone = 0, totalDoneOpen = 0, totalOpen = 0, totalFinished = 0;
  let totalPoints = 0, exactCount = 0, partialCount = 0, missCount = 0, totalFinishedWithPred = 0;

  for (const m of matches) {
    const p = predsByMatch.get(m.id);
    const g = m.group_name;
    const dk = dateKey(m);
    const hasPred = !!p;

    if (hasPred) totalDone++;
    if (m.finished) totalFinished++;
    else totalOpen++;

    if (!m.finished) {
      openByGroup.all.total++;
      if (g) openByGroup[g].total++;
      (openByDate[dk] ??= { done: 0, total: 0 }).total++;
      if (hasPred) {
        totalDoneOpen++;
        openByGroup.all.done++;
        if (g) openByGroup[g].done++;
        openByDate[dk].done++;
      }
    } else {
      finishedByGroup.all.total++;
      if (g) finishedByGroup[g].total++;
      (finishedByDate[dk] ??= { done: 0, total: 0 }).total++;
      if (hasPred) {
        finishedByGroup.all.done++;
        if (g) finishedByGroup[g].done++;
        finishedByDate[dk].done++;
        totalFinishedWithPred++;
        const pts = p.points_earned ?? 0;
        totalPoints += pts;
        if (p.pred_home === m.actual_home && p.pred_away === m.actual_away) exactCount++;
        else if (pts > 0) partialCount++;
        else missCount++;
      }
    }
  }

  return {
    openByGroup, finishedByGroup, openByDate, finishedByDate,
    totalDone, totalRemaining: matches.length - totalDone,
    totalDoneOpen, totalOpen, totalFinished, totalFinishedWithPred,
    totalPoints, exactCount, partialCount, missCount,
  };
}

// ============================================================
// Eventos
// ============================================================
function attachEventListeners() {
  // Tab switching (abas + botões que apontam para uma aba, ex. empty-state)
  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      const t = tabBtn.dataset.tab;
      if (t !== activeTab) {
        activeTab = t;
        // Cada aba abre numa seleção válida da dimensão ativa.
        if (groupBy === 'date') activeDate = defaultDate(t);
        else activeGroup = t === 'palpites' ? defaultPalpitesGroup() : defaultJogosGroup();
        rerenderAll();
      }
      return;
    }

    // Toggle de visão: por grupo ⇄ por data
    const viewBtn = e.target.closest('.view-toggle button[data-view]');
    if (viewBtn) {
      const v = viewBtn.dataset.view;
      if (v !== groupBy) {
        groupBy = v;
        if (groupBy === 'date') activeDate = defaultDate(activeTab);
        else activeGroup = activeTab === 'palpites' ? defaultPalpitesGroup() : defaultJogosGroup();
        rerenderTabBody();
      }
      return;
    }

    // Dia do calendário (modo "por data")
    const dateCell = e.target.closest('.cal-day[data-date]');
    if (dateCell) {
      activeDate = dateCell.dataset.date;
      rerenderTabBody();
      return;
    }

    // Toggle do popover de 3ºs (necessário no toque, onde não há hover)
    const thirdsBtn = e.target.closest('[data-action="toggle-thirds"]');
    if (thirdsBtn) {
      const pop = thirdsBtn.closest('.thirds-pop');
      const open = pop.classList.toggle('open');
      thirdsBtn.setAttribute('aria-expanded', String(open));
      return;
    }
    // Clique fora fecha o popover aberto
    if (!e.target.closest('.thirds-pop')) {
      document.querySelectorAll('.thirds-pop.open').forEach(p => {
        p.classList.remove('open');
        p.querySelector('.thirds-pop-trigger')?.setAttribute('aria-expanded', 'false');
      });
    }

    const chip = e.target.closest('.chip[data-group]');
    if (chip) {
      activeGroup = chip.dataset.group;
      rerenderTabBody();
      return;
    }
  });

  // Inputs de placar (só na aba palpites)
  document.addEventListener('input', (e) => {
    const input = e.target.closest('.score-input[data-match]');
    if (!input) return;
    sanitizeInput(input);
    const matchId = parseInt(input.dataset.match, 10);
    scheduleSave(matchId);
  });
}

function sanitizeInput(input) {
  const v = input.value;
  if (v === '') return;
  let n = parseInt(v, 10);
  if (isNaN(n)) { input.value = ''; return; }
  if (n < 0) n = 0;
  if (n > 20) n = 20;
  if (String(n) !== v) input.value = n;
}

function scheduleSave(matchId) {
  if (saveTimers.has(matchId)) clearTimeout(saveTimers.get(matchId));
  const handle = setTimeout(() => doSave(matchId), 700);
  saveTimers.set(matchId, handle);
}

async function doSave(matchId) {
  const row = document.querySelector(`.match[data-match-id="${matchId}"]`);
  const home = row?.querySelector('input[data-side="home"]');
  const away = row?.querySelector('input[data-side="away"]');
  if (!home || !away) return;

  const h = home.value === '' ? null : parseInt(home.value, 10);
  const a = away.value === '' ? null : parseInt(away.value, 10);

  if (h === null || a === null || isNaN(h) || isNaN(a)) return;

  row.classList.remove('saved', 'error');
  row.classList.add('saving');

  const { data, error } = await supabase
    .from('predictions')
    .upsert(
      { user_id: profile.id, match_id: matchId, pred_home: h, pred_away: a },
      { onConflict: 'user_id,match_id' }
    )
    .select()
    .single();

  row.classList.remove('saving');

  if (error) {
    console.error('[save error]', error);
    row.classList.add('error');
    showToast('Erro ao salvar: ' + (error.message || 'desconhecido'), 'error', 3500);
    return;
  }

  predsByMatch.set(matchId, data);
  row.classList.add('saved');
  showToast(`Salvo ${getTeamLabel(matchId)}`, 'success', 1200);
  updateKpisAndChips();
  refreshProjection();
}

// Atualiza a tabela projetada do grupo e o popover de 3ºs após salvar um palpite
// (ficam fora dos inputs, então re-renderizar não rouba o foco).
function refreshProjection() {
  // Tabela projetada e 3ºs só existem no modo "por grupo".
  if (groupBy !== 'group') return;
  const gt = document.getElementById('palpitesGroupTable');
  if (gt) gt.innerHTML = renderGroupTable('sim');
  const tp = document.getElementById('thirdsPopBody');
  if (tp) tp.innerHTML = renderThirdsPopBody('sim');
}

function getTeamLabel(matchId) {
  const m = matches.find(mm => mm.id === matchId);
  if (!m) return '';
  return `${teamPt(m.team_home)} × ${teamPt(m.team_away)}`;
}

function rerenderAll() {
  const pageBody = document.getElementById('pageBody');
  pageBody.innerHTML = renderPage();
}

function rerenderTabBody() {
  const counts = computeCounts();
  const tabBody = document.getElementById('tabBody');
  if (!tabBody) return;
  tabBody.innerHTML = renderActiveTab(counts);
}

function updateKpisAndChips() {
  // Re-render apenas KPIs e chips (não a lista — preserva foco no input)
  const counts = computeCounts();
  // Chips
  const chips = document.getElementById('chips');
  if (chips) {
    if (groupBy === 'date') {
      const byDate = activeTab === 'palpites' ? counts.openByDate : counts.finishedByDate;
      chips.innerHTML = renderDatePicker(byDate, activeTab);
    } else {
      const byGroup = activeTab === 'palpites' ? counts.openByGroup : counts.finishedByGroup;
      chips.innerHTML =
        GROUPS.map(g => renderChip(g, 'Grupo ' + g, byGroup[g]?.done ?? 0, byGroup[g]?.total ?? 0)).join('');
    }
  }
  // KPIs
  const kpis = document.querySelector('.kpis');
  if (kpis) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = activeTab === 'palpites' ? renderKpisPalpites(counts) : renderKpisResultados(counts);
    kpis.replaceWith(wrapper.firstElementChild);
  }
}

function formatBrDateShort(d) {
  const MEZES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  return `${String(d.getDate()).padStart(2,'0')}/${MEZES[d.getMonth()]}`;
}

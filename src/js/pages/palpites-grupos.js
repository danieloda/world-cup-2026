import { requireAuth } from '../auth.js';
import { renderShell, refreshNavBadges } from '../sidebar.js';
import { KPI } from '../kpi-icons.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, formatBrDate, formatTime,
  isLocked, isLive, lockCountdownLabel, showToast, loadRecentMatches,
  loadQualifiers, teamPt, groundShort, renderDateCalendar, predictionDeadline,
  localDateKey, oddsToProbs, brParts,
} from '../util.js';
import { matchPoints, scoreBreakdown, scorerBonus } from '../scoring.js';
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
let scorerPickId = null;             // player_id do artilheiro escolhido (bônus por gol)
let activeGroup = 'all';             // 'all' | 'A'..'L'
let groupBy = 'date';                // 'group' | 'date' — dimensão do filtro/agrupamento (padrão: por data)
let activeDate = null;               // ISO yyyy-mm-dd quando groupBy === 'date'
let standMode = 'sim';               // 'sim' (projeção dos palpites) | 'real' (oficial) — lente da classificação/3ºs
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
  focusHashMatch();  // se veio de um card do Início (#jogo-<id>), rola até o jogo e pisca
} catch (err) {
  console.error('[palpites-grupos] FATAL:', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:#fff; font-family:'Figtree',system-ui,-apple-system,sans-serif;">
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
  const [statsRes, matchesRes, predsRes, goalsRes, oddsRes, h2hRes, forecastRes, scorerRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    supabase.from('matches').select('*').eq('stage', 'group').order('match_date'),
    supabase.from('predictions').select('*').eq('user_id', profile.id),
    supabase.from('player_goals').select('*, players(full_name, team)'),
    supabase.from('match_odds').select('match_id, odd_home, odd_draw, odd_away, bookmaker_name'),
    supabase.from('match_h2h').select('match_id, fixtures, summary, api_team_home'),
    supabase.from('match_predictions').select('match_id, payload'),
    supabase.from('top_scorer_picks').select('player_id').eq('user_id', profile.id).maybeSingle(),
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

  scorerPickId = scorerRes.data?.player_id ?? null;
}

// Bônus de artilheiro NESTE jogo: gols do jogador escolhido × multiplicador da fase
// (na fase de grupos o multiplicador é 1, então = 2 × gols).
function matchScorerPts(m) {
  if (!scorerPickId) return 0;
  const goal = (goalsByMatch.get(m.id) ?? []).find(g => g.player_id === scorerPickId);
  const n = goal?.goals ?? 0;
  return n > 0 ? scorerBonus(n, m.stage) : 0;
}

// ============================================================
// Render — page shell
// ============================================================
function renderPage() {
  const counts = computeCounts();
  return `
    <section class="hero">
      <div class="hero-kicker">Palpitar placares · Fase de grupos</div>
      <h1 class="hero-title">Fase de grupos</h1>
      <div class="hero-meta">
        <b>${matches.length} jogos</b><span class="sep"></span>
        Seu palpite e o resultado oficial no mesmo lugar<span class="sep"></span>
        <b>${counts.totalDone}</b> palpitados
      </div>
    </section>

    <div id="tabBody">${renderBody(counts)}</div>
  `;
}

// Deep-link via hash. Usado pelos redirects das antigas grupos.html / terceiros.html
// e por URLs compartilháveis. Define grupo/lente antes do primeiro render.
function applyHashRoute() {
  const h = (location.hash || '').replace('#', '');
  // Sub-páginas oficiais antigas → abre por grupo na lente oficial.
  if (['classificacao', 'terceiros', 'jogos', 'resultados'].includes(h)) {
    groupBy = 'group'; standMode = 'real';
  }
  // Deep-link pra um grupo específico (ex.: #grupo-A)
  const gm = /^grupo-([A-L])$/.exec(h);
  if (gm) { groupBy = 'group'; activeGroup = gm[1]; }

  // Deep-link pra um JOGO específico (cards de "próximos jogos" do Início → #jogo-<id>):
  // abre o grupo do jogo; o focusHashMatch() depois rola até ele e pisca.
  const jm = /^jogo-(\d+)$/.exec(h);
  if (jm) {
    const mt = matches.find(x => x.id === Number(jm[1]));
    if (mt && mt.group_name) { groupBy = 'group'; activeGroup = mt.group_name; }
  }
}

// Rola até o jogo do hash (#jogo-<id>) e dá um flash rápido pra localizar o card.
function focusHashMatch() {
  const jm = /^jogo-(\d+)$/.exec((location.hash || '').replace('#', ''));
  if (!jm) return;
  const el = document.querySelector(`.match[data-match-id="${jm[1]}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth; // reinicia a animação se a classe já existia
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

// ============================================================
// Corpo unificado: nota + KPIs + toggle de visão + navegação + lista de cards
// (aberto=inputs / encerrado=resultado) + classificação/3ºs com toggle de lente.
// ============================================================
function renderBody(counts) {
  // Garante uma seleção válida conforme a dimensão ativa.
  if (groupBy === 'date') {
    if (!allDates().includes(activeDate)) activeDate = defaultDate();
  } else if (!GROUPS.includes(activeGroup)) {
    activeGroup = defaultGroup();
  }

  return `
    <div class="note">
      <span class="note-head">Como você ganha pontos em cada jogo</span>
      <ul class="note-list">
        <li>🥅 <strong>+${GP.ag}</strong> se acertar quantos gols um time fez (pode valer pelos dois times)</li>
        <li>⚽ <strong>+${GP.ave}</strong> se acertar quem vence — ou que vai dar empate</li>
        <li>➕ <strong>+${GP.dg}</strong> se acertar a diferença de gols</li>
        <li>🎯 Cravou o placar exato? Soma tudo: <strong>${GP.exact} pontos</strong></li>
        <li>📊 <strong>Conforme os resultados saem</strong>, cada jogo mostra seu palpite ao lado do placar oficial e já soma os pontos que você fez ali (incluindo o bônus de artilheiro).</li>
      </ul>
      <span class="note-deadline">⏰ Cada palpite fecha às 23h59 da véspera do jogo (um dia antes).
        <span class="sub">Depois disso o jogo trava; quando termina, o card abre a comparação com o oficial.</span></span>
      <a class="note-link" href="regras.html">Ver todas as regras →</a>
    </div>

    ${renderKpis(counts)}

    ${renderViewToggle()}

    <div class="palpites-toolbar">
      <div class="chips" id="chips">
        ${groupBy === 'date'
          ? renderDatePicker(counts.allByDate)
          : renderGroupNav(counts.allByGroup)}
      </div>
      ${groupBy === 'group' ? renderThirdsPop(standMode) : ''}
    </div>

    <div class="tooltip-hint raiox-hint">
      🔍 Toque em <b>Raio-X</b> em cada jogo para ver o <b>favorito do mercado</b>, a <b>forma recente</b>, os <b>confrontos diretos</b> e a campanha nas <b>eliminatórias</b>.
    </div>

    <div id="matchesList">
      ${renderMatchesList()}
    </div>

    <div id="groupTableWrap">
      ${groupBy === 'group' ? renderGroupTableSection() : ''}
    </div>
  `;
}

// Primeiro grupo (A..L) com pelo menos 1 jogo em aberto; senão o primeiro grupo.
function defaultGroup() {
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
// Seção da classificação com o toggle de lente (Projeção ⇄ Oficial).
function renderGroupTableSection() {
  if (!GROUPS.includes(activeGroup)) return '';
  return `
    <div class="stand-toggle-row">
      <div class="view-toggle stand-toggle" role="tablist" aria-label="Lente da classificação">
        <button class="${standMode === 'sim' ? 'active' : ''}" data-stand="sim" type="button">Projeção</button>
        <button class="${standMode === 'real' ? 'active' : ''}" data-stand="real" type="button">Oficial</button>
      </div>
    </div>
    ${renderGroupTable(standMode)}
  `;
}

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

// KPIs unificados: progresso de palpites + desempenho (pontos/exatos) num strip só.
function renderKpis(counts) {
  const pct = matches.length ? Math.round(counts.totalDone / matches.length * 100) : 0;
  const fin = counts.totalFinishedWithPred;
  const avg = fin > 0 ? (counts.totalPoints / fin).toFixed(1) : '0';
  return `
    <div class="kpis">
      <div class="kpi green">
        <div class="kpi-top"><span class="kpi-cap">${KPI.done}</span><span class="kpi-label">Palpitados</span></div>
        <div class="kpi-num">${counts.totalDone}<small>/${matches.length}</small></div>
        <div class="progress-bar-inline"><span style="width:${pct}%"></span></div>
      </div>
      <div class="kpi gold">
        <div class="kpi-top"><span class="kpi-cap">${KPI.points}</span><span class="kpi-label">Pontos ganhos</span></div>
        <div class="kpi-num">${counts.totalPoints}</div>
        <div class="kpi-sub">${fin > 0 ? `média ${avg} pts/jogo` : 'aguardando jogos'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-top"><span class="kpi-cap">${KPI.exact}</span><span class="kpi-label">Placares exatos</span></div>
        <div class="kpi-num">${counts.exactCount}</div>
        <div class="kpi-sub">de ${fin} encerrado${fin !== 1 ? 's' : ''}</div>
      </div>
      <div class="kpi red">
        <div class="kpi-top"><span class="kpi-cap">${KPI.pending}</span><span class="kpi-label">Faltando</span></div>
        <div class="kpi-num">${counts.totalRemaining}</div>
        <div class="kpi-sub">${counts.totalRemaining === 0 ? 'tudo pronto ✓' : 'jogos pendentes'}</div>
      </div>
    </div>
  `;
}

// Lista unificada: TODOS os jogos do filtro (aberto=inputs / encerrado=resultado).
function renderMatchesList() {
  const inScope = groupBy === 'date'
    ? (activeDate ? matches.filter(m => dateKey(m) === activeDate) : matches)
    : (activeGroup === 'all' ? matches : matches.filter(m => m.group_name === activeGroup));

  if (inScope.length === 0) {
    return `
      <div class="empty">
        <div class="empty-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg></div>
        <h3>Sem jogos ${groupBy === 'date' ? 'nesta data' : `no Grupo ${activeGroup}`}</h3>
        <p>Escolha outra ${groupBy === 'date' ? 'data' : 'opção'} acima.</p>
      </div>`;
  }

  const sorted = [...inScope].sort((a, b) => new Date(a.match_date) - new Date(b.match_date));
  return renderGroupedByDate(sorted, m => (m.finished ? renderResultRow(m) : renderPalpiteRow(m)));
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
    <div class="match bet ${locked ? 'locked' : ''}" data-match-id="${m.id}">
      <div class="match-meta">
        <strong>${formatTime(m.match_date)}</strong>
        <span class="mm-sep">·</span>
        <span class="mm-ground">${escapeHtml(groundShort(m.ground))}</span>
        ${status}
        <span class="match-grp">Grupo ${m.group_name}</span>
      </div>
      <div class="team home">
        <span class="flag">${flag(m.team_home)}</span>
        <span class="team-name" data-team="${escapeHtml(m.team_home)}">${escapeHtml(teamPt(m.team_home))}</span>
      </div>
      <input class="score-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2"
             data-match="${m.id}" data-side="home"
             aria-label="Gols ${escapeHtml(teamPt(m.team_home))}"
             value="${homeVal}" ${locked ? 'disabled' : ''}>
      <span class="score-sep">–</span>
      <input class="score-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2"
             data-match="${m.id}" data-side="away"
             aria-label="Gols ${escapeHtml(teamPt(m.team_away))}"
             value="${awayVal}" ${locked ? 'disabled' : ''}>
      <div class="team away">
        <span class="flag">${flag(m.team_away)}</span>
        <span class="team-name" data-team="${escapeHtml(m.team_away)}">${escapeHtml(teamPt(m.team_away))}</span>
      </div>
      ${lockNote}
      ${renderRaioXToggle(m.id, m.team_home, m.team_away, raioxData(m))}
    </div>
    ${renderRaioXPanel(m.id, m.team_home, m.team_away, raioxData(m))}
  `;
}

// Card de RESULTADO de grupo (encerrado). Comparação você × oficial em colunas
// alinhadas + Pontuação — mesma linguagem visual do card de mata-mata.
function renderResultRow(m) {
  const pred = predsByMatch.get(m.id);
  const placarPts = pred?.points_earned ?? 0;
  const scorerPts = matchScorerPts(m);            // bônus por gol do seu artilheiro
  const pts = placarPts + scorerPts;               // total do jogo
  const isExact = pred && pred.pred_home === m.actual_home && pred.pred_away === m.actual_away;
  const resultClass = !pred && scorerPts === 0 ? 'no-pred'
    : isExact ? 'exact'
    : (placarPts > 0 || scorerPts > 0) ? 'partial' : 'miss';

  // Quebra aditiva do palpite (lado / resultado / saldo) + chip de artilheiro.
  const chipList = [];
  if (pred) {
    const { parts } = scoreBreakdown(
      pred.pred_home, pred.pred_away, pred.pred_pen_winner,
      m.actual_home, m.actual_away, m.pen_winner, m.stage,
    );
    chipList.push(...(parts.length > 0
      ? parts.map(p => `<span class="brk ${p.key}">${p.label} <b>+${p.pts}</b></span>`)
      : ['<span class="brk miss">não pontuou</span>']));
  }
  if (scorerPts > 0) chipList.push(`<span class="brk scorer">⚽ Artilheiro <b>+${scorerPts}</b></span>`);
  const chips = chipList.join('');

  const pointsBadge = (pred || scorerPts > 0)
    ? `<div class="bm-pts ${resultClass}">${pts > 0 ? '+' : ''}${pts} pts</div>`
    : '<div class="bm-pts no-pred">sem palpite</div>';

  const goals = goalsByMatch.get(m.id) ?? [];
  const homeGoals = goals.filter(g => g.players.team === m.team_home);
  const awayGoals = goals.filter(g => g.players.team === m.team_away);
  const goalsHtml = goals.length > 0
    ? `<div class="gr-goals">
         <span class="gr-goals-cap">⚽ Gols</span>
         ${homeGoals.map(g => `<span class="gr-scorer">${escapeHtml(g.players.full_name)} <b>${g.goals}'</b></span>`).join('')}
         ${homeGoals.length && awayGoals.length ? '<span class="gr-goals-sep">·</span>' : ''}
         ${awayGoals.map(g => `<span class="gr-scorer">${escapeHtml(g.players.full_name)} <b>${g.goals}'</b></span>`).join('')}
       </div>`
    : '';

  const dateLabel = `${formatBrDateShort(new Date(m.match_date))} · ${formatTime(m.match_date)}`;

  return `
    <div class="gr-card ${resultClass}" data-match-id="${m.id}">
      <div class="bm-id">
        <span class="bm-id-main">Grupo ${m.group_name}</span>
        <span class="when">${dateLabel} · <span class="km-tag-done">encerrado</span></span>
      </div>

      <div class="gr-grid">
        <div class="gr-colhead"><span></span><span></span><span class="gr-ch">você</span><span class="gr-ch">oficial</span></div>
        ${grTeamRow(m, 'home', pred)}
        ${grTeamRow(m, 'away', pred)}
      </div>

      <div class="km-foot">
        <div class="km-cap">Pontuação</div>
        <div class="km-foot-row">
          ${chips ? `<div class="bm-break">${chips}</div>` : '<span></span>'}
          ${pointsBadge}
        </div>
      </div>

      ${goalsHtml}
    </div>
  `;
}

// Uma linha do card de resultado: bandeira · nome · seu palpite · placar oficial.
function grTeamRow(m, side, pred) {
  const team = side === 'home' ? m.team_home : m.team_away;
  const actual = side === 'home' ? m.actual_home : m.actual_away;
  const ps = pred ? (side === 'home' ? pred.pred_home : pred.pred_away) : null;
  const isWinner =
    (side === 'home' && (m.actual_home > m.actual_away)) ||
    (side === 'away' && (m.actual_away > m.actual_home));
  const hit = ps != null && ps === actual;   // cravou os gols deste time
  return `
    <div class="gr-row ${isWinner ? 'winner' : ''}">
      <span class="flag">${flag(team)}</span>
      <span class="gr-name" data-team="${escapeHtml(team)}">${escapeHtml(teamPt(team))}</span>
      <span class="gr-pred ${hit ? 'hit' : ''}">${ps ?? '–'}</span>
      <span class="gr-score">${actual}</span>
    </div>
  `;
}

// ============================================================
// Helpers
// ============================================================
function dateKey(m) {
  return localDateKey(m.match_date);
}

// Todas as datas distintas (yyyy-mm-dd) dos jogos, em ordem cronológica.
function allDates() {
  return [...new Set(matches.map(dateKey))].sort();
}

// Data padrão: primeira com jogo ainda a palpitar; senão a primeira.
function defaultDate() {
  const ks = allDates();
  return ks.find(k => matches.some(m => dateKey(m) === k && !m.finished)) ?? ks[0] ?? null;
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
  const finByDate = {};     // yyyy-mm-dd -> nº de jogos já encerrados
  for (const m of matches) {
    const dk = dateKey(m);
    (groupsByDate[dk] ??= new Set()).add(m.group_name);
    const dl = predictionDeadline(m.match_date).getTime();
    deadlineByDate[dk] = Math.min(deadlineByDate[dk] ?? Infinity, dl);
    if (m.finished) finByDate[dk] = (finByDate[dk] ?? 0) + 1;
  }
  const meta = {};
  for (const dk of Object.keys(byDate)) {
    const gs = [...(groupsByDate[dk] ?? [])].filter(Boolean).sort();
    const total = byDate[dk]?.total ?? 0;
    meta[dk] = {
      info: gs.length ? gs.join(' ') : '',
      title: gs.length ? `Grupo${gs.length > 1 ? 's' : ''} ${gs.join(', ')}` : '',
      done: byDate[dk]?.done ?? 0,
      total,
      deadline: deadlineByDate[dk],
      played: total > 0 && (finByDate[dk] ?? 0) >= total,   // dia todo encerrado
    };
  }
  return meta;
}

// Calendário de datas (todas as datas; meta com palpitados/total por dia).
function renderDatePicker(byDate) {
  return renderDateCalendar({
    dates: allDates(),
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

// Navegação de grupos: stepper (‹ Grupo X ›) centralizado + 12 bolinhas de
// progresso (verde=completo / dourado=atual). Substitui os 12 chips (reduz a
// sobrecarga de escolha). byGroup = { A: {done,total}, ... }.
function renderGroupNav(byGroup) {
  const cur = GROUPS.includes(activeGroup) ? activeGroup : GROUPS[0];
  const c = byGroup[cur] || {};
  const dots = GROUPS.map(g => {
    const gc = byGroup[g] || {};
    const done = gc.done ?? 0, total = gc.total ?? 0;
    const cls = ['grp-dot'];
    if (g === cur) cls.push('cur');
    if (total > 0 && done === total) cls.push('done');
    return `<button class="${cls.join(' ')}" type="button" data-group="${g}" aria-label="Grupo ${g}: ${done} de ${total} palpitados"${g === cur ? ' aria-current="true"' : ''}>${g}</button>`;
  }).join('');
  return `
    <div class="grp-nav">
      <div class="grp-stepper">
        <button class="grp-arrow" type="button" data-grp-step="-1" aria-label="Grupo anterior">‹</button>
        <div class="grp-cur">Grupo <b>${cur}</b> <span class="grp-ct">${c.done ?? 0}/${c.total ?? 0}</span></div>
        <button class="grp-arrow" type="button" data-grp-step="1" aria-label="Próximo grupo">›</button>
      </div>
      <div class="grp-dots">${dots}</div>
    </div>
  `;
}

function computeCounts() {
  // Contadores por grupo/data agora abrangem TODOS os jogos (palpitados/total),
  // já que a lista é unificada (abertos + encerrados no mesmo fluxo).
  const allByGroup = { all: { done: 0, total: 0 } };
  for (const g of GROUPS) allByGroup[g] = { done: 0, total: 0 };
  const allByDate = {};        // yyyy-mm-dd -> { done, total }

  let totalDone = 0, totalFinished = 0;
  let totalPoints = 0, exactCount = 0, partialCount = 0, missCount = 0, totalFinishedWithPred = 0;

  for (const m of matches) {
    const p = predsByMatch.get(m.id);
    const g = m.group_name;
    const dk = dateKey(m);
    const hasPred = !!p;

    if (hasPred) totalDone++;
    if (m.finished) totalFinished++;

    allByGroup.all.total++;
    if (g) allByGroup[g].total++;
    (allByDate[dk] ??= { done: 0, total: 0 }).total++;
    if (hasPred) {
      allByGroup.all.done++;
      if (g) allByGroup[g].done++;
      allByDate[dk].done++;
    }

    if (m.finished && hasPred) {
      totalFinishedWithPred++;
      const pts = p.points_earned ?? 0;
      totalPoints += pts;
      if (p.pred_home === m.actual_home && p.pred_away === m.actual_away) exactCount++;
      else if (pts > 0) partialCount++;
      else missCount++;
    }
  }

  return {
    allByGroup, allByDate,
    totalDone, totalRemaining: matches.length - totalDone,
    totalFinished, totalFinishedWithPred,
    totalPoints, exactCount, partialCount, missCount,
  };
}

// ============================================================
// Eventos
// ============================================================
function attachEventListeners() {
  document.addEventListener('click', (e) => {
    // Toggle de visão: por grupo ⇄ por data
    const viewBtn = e.target.closest('.view-toggle button[data-view]');
    if (viewBtn) {
      const v = viewBtn.dataset.view;
      if (v !== groupBy) {
        groupBy = v;
        if (groupBy === 'date') activeDate = defaultDate();
        else activeGroup = defaultGroup();
        rerenderTabBody();
      }
      return;
    }

    // Toggle de lente da classificação/3ºs: Projeção ⇄ Oficial
    const standBtn = e.target.closest('[data-stand]');
    if (standBtn) {
      const s = standBtn.dataset.stand;
      if (s !== standMode) {
        standMode = s;
        const wrap = document.getElementById('groupTableWrap');
        if (wrap) wrap.innerHTML = renderGroupTableSection();
        const tp = document.getElementById('thirdsPopBody');
        if (tp) tp.innerHTML = renderThirdsPopBody(standMode);
        const trig = document.querySelector('.thirds-pop-trigger .hint');
        if (trig) trig.textContent = standMode === 'real' ? 'oficial' : 'sua projeção';
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

    // Stepper de grupos: setas (‹ ›) andam em ordem; bolinhas pulam direto.
    const grpStep = e.target.closest('[data-grp-step]');
    if (grpStep) {
      const i = GROUPS.includes(activeGroup) ? GROUPS.indexOf(activeGroup) : 0;
      activeGroup = GROUPS[(i + Number(grpStep.dataset.grpStep) + GROUPS.length) % GROUPS.length];
      rerenderTabBody();
      return;
    }
    const grpDot = e.target.closest('.grp-dot[data-group]');
    if (grpDot) {
      activeGroup = grpDot.dataset.group;
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
  refreshNavBadges(profile.id);  // baixa o badge de pendência na hora (sem F5)
}

// Atualiza a classificação do grupo e o popover de 3ºs após salvar um palpite
// (ficam fora dos inputs, então re-renderizar não rouba o foco). Só faz sentido
// quando a lente é projeção (oficial não muda com palpite).
function refreshProjection() {
  if (groupBy !== 'group' || standMode !== 'sim') return;
  const wrap = document.getElementById('groupTableWrap');
  if (wrap) wrap.innerHTML = renderGroupTableSection();
  const tp = document.getElementById('thirdsPopBody');
  if (tp) tp.innerHTML = renderThirdsPopBody('sim');
}

function getTeamLabel(matchId) {
  const m = matches.find(mm => mm.id === matchId);
  if (!m) return '';
  return `${teamPt(m.team_home)} × ${teamPt(m.team_away)}`;
}

function rerenderTabBody() {
  const counts = computeCounts();
  const tabBody = document.getElementById('tabBody');
  if (!tabBody) return;
  tabBody.innerHTML = renderBody(counts);
}

function updateKpisAndChips() {
  // Re-render apenas KPIs e chips (não a lista — preserva foco no input)
  const counts = computeCounts();
  const chips = document.getElementById('chips');
  if (chips) {
    chips.innerHTML = groupBy === 'date'
      ? renderDatePicker(counts.allByDate)
      : renderGroupNav(counts.allByGroup);
  }
  const kpis = document.querySelector('.kpis');
  if (kpis) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderKpis(counts);
    kpis.replaceWith(wrapper.firstElementChild);
  }
}

function formatBrDateShort(d) {
  const MEZES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const { day, month } = brParts(d);
  return `${String(day).padStart(2,'0')}/${MEZES[month - 1]}`;
}

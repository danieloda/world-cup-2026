import { requireAuth } from '../auth.js';
import { reportFatal } from '../error-reporter.js';
import { renderShell } from '../sidebar.js';
import { supabase, fetchAllPages } from '../supabase.js';
import {
  flag, escapeHtml, teamPt, formatBrShort, formatTime, stageLabel,
  isLive, avatarHtml, localDateKey, renderDateCalendar, firstName, heroMeta,
} from '../util.js';
import { scorerBonus, stageMultiplier } from '../scoring.js';
import { KPI } from '../kpi-icons.js';
import { startAutoRefresh } from '../auto-refresh.js';

// ============================================================
// Ícones (SVG inline — nada de emoji na UI)
// ============================================================
const ICON = {
  ball: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.6 5h-4.8L8 10z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v16l-7-3-7 3z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  chev: '<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
};

// Tinta sutil das cores do time no placar (--ch/--ca). Times sem mapa caem num
// neutro — o color-mix continua válido, só fica sem cor de marca.
const TEAM_TINT = {
  Brazil: '#009C3B', Argentina: '#6CACE4', France: '#0055A4', England: '#CF142B',
  Spain: '#AA151B', Germany: '#888', Portugal: '#006600', Netherlands: '#AE6A32',
  Croatia: '#C1272D', Italy: '#0066CC', Belgium: '#C8102E', Uruguay: '#5CBFEB',
  Mexico: '#006847', 'United States': '#3C3B6E', Canada: '#FF0000', Japan: '#BC002D',
  'South Korea': '#0047A0', Morocco: '#C1272D', Senegal: '#00853F', Ghana: '#006B3F',
  Nigeria: '#008751', Switzerland: '#D52B1E', Denmark: '#C60C30', Poland: '#DC143C',
  Colombia: '#FCD116', Ecuador: '#FFD100', Australia: '#00843D', 'Saudi Arabia': '#006C35',
  Qatar: '#8A1538', Iran: '#239F40', Serbia: '#C6363C', Austria: '#ED2939',
  Norway: '#BA0C2F', Sweden: '#FECC00', Scotland: '#005EB8', Haiti: '#00209F',
};
function teamTint(team) {
  return TEAM_TINT[team] || '#5b6472';
}

// ============================================================
// Estado
// ============================================================
let profile, stats;
let revealedMatches = [];          // jogos revelados (lacre publicado OU já começados), desc por data
let predsByMatch = new Map();      // match_id -> [{...prediction, profiles}]
let goalsByMatch = new Map();      // match_id -> [{...goal, players}]
let scorerPickByUser = new Map();  // user_id -> { playerId, name }  (artilheiro escolhido)
let activeStage = 'group';         // ABA 1 (fase): 'group' | 'ko'
let activeDay = null;              // ABA 2 (dia): 'YYYY-MM-DD' (sempre um dia específico)
let activeStatus = 'finished';     // FILTRO: 'finished' | 'awaiting'

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  await loadData();

  const pageBody = await renderShell({ active: 'historico', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');

  attachEventListeners();
  startAutoRefresh();  // lacre publicado / apito / resultado lançado → recarrega
} catch (err) {
  console.error('[historico] FATAL:', err);
  reportFatal('historico', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:#fff; font-family:'Figtree',system-ui,-apple-system,sans-serif;">
      <h1 style="color:#f15e6c">⚠️ Erro</h1>
      <pre style="background:#000; padding:16px; border-radius:8px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:#f15e6c;">${err.stack || err.message || err}</pre>
      <p style="margin-top:20px;"><a href="inicio.html" style="color:#f4c430">← Voltar</a></p>
    </div>
  `;
}

// ============================================================
// Data
// ============================================================
async function loadData() {
  const [statsRes, matchesRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    // Um jogo entra no Histórico quando os palpites de todos estão REVELADOS:
    // lacre do dia publicado no GitHub OU jogo já começado (fallback). A view
    // v_revealed_matches (migration 060) usa o MESMO predicado do RLS
    // (predictions_select_own_or_revealed) — página e banco nunca divergem.
    supabase.from('v_revealed_matches').select('*')
      .order('match_date', { ascending: false }),
  ]);

  if (matchesRes.error) throw matchesRes.error;
  stats = statsRes.data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0 };
  revealedMatches = matchesRes.data ?? [];

  if (revealedMatches.length === 0) return;

  const matchIds = revealedMatches.map(m => m.id);
  // Palpites de TODOS os participantes nos jogos revelados: cresce com
  // (usuários × jogos), então PAGINA — senão o PostgREST corta em 1000 linhas e
  // somem palpites dos cards quando o bolão fica grande. Ver fetchAllPages.
  const predsPromise = fetchAllPages(() =>
    supabase.from('predictions')
      .select('*, profiles(full_name, paid, avatar_url)')
      .in('match_id', matchIds).order('id'));

  // Artilheiros: o RLS só revela a escolha alheia após o deadline (10/jun). Como nenhum
  // jogo termina antes disso, nos cards finalizados sempre dá pra cruzar quem pontuou.
  const [predsRows, goalsRes, scorerRes] = await Promise.all([
    predsPromise,
    supabase.from('player_goals')
      .select('*, players(full_name, team)')
      .in('match_id', matchIds),
    supabase.from('top_scorer_picks')
      .select('user_id, player_id, players(full_name, team)'),
  ]);

  for (const p of (predsRows ?? [])) {
    if (!p.profiles?.paid) continue;  // só participantes do bolão (pagos)
    if (!predsByMatch.has(p.match_id)) predsByMatch.set(p.match_id, []);
    predsByMatch.get(p.match_id).push(p);
  }
  for (const g of (goalsRes.data ?? [])) {
    if (!goalsByMatch.has(g.match_id)) goalsByMatch.set(g.match_id, []);
    goalsByMatch.get(g.match_id).push(g);
  }
  for (const s of (scorerRes.data ?? [])) {
    scorerPickByUser.set(s.user_id, {
      playerId: s.player_id,
      name: s.players?.full_name || 'seu artilheiro',
      team: s.players?.team || null,
    });
  }
}

// ============================================================
// Helpers de estado/seleção
// ============================================================
// 'finished' → resultado lançado (pontua) · 'awaiting' → já começou, sem resultado
function matchStatus(m) {
  return m.finished ? 'finished' : 'awaiting';
}
function inStage(m, stage) {
  return stage === 'group' ? m.stage === 'group' : m.stage !== 'group';
}
function dayKey(m) {
  // Chave de dia no fuso de Brasília (mesmo de formatBrShort/formatTime), pra
  // que a aba de dia e a data do card nunca divirjam num jogo perto da meia-noite.
  return localDateKey(m.match_date);
}

function stageMatches() {
  return revealedMatches.filter(m => inStage(m, activeStage));
}
function dayMatches() {
  return stageMatches().filter(m => dayKey(m) === activeDay);
}
// Garante um dia válido selecionado para a fase ativa (o mais recente por padrão)
function ensureValidDay() {
  const days = stageDays();
  if (!days.some(([k]) => k === activeDay)) activeDay = days.length ? days[0][0] : null;
}
// Garante um status com jogos no dia (prefere Finalizadas; senão Próximas partidas)
function ensureValidStatus() {
  const scoped = dayMatches();
  const has = s => scoped.some(m => matchStatus(m) === s);
  if (!has(activeStatus)) activeStatus = has('finished') ? 'finished' : 'awaiting';
}
function visibleMatches() {
  const list = dayMatches().filter(m => matchStatus(m) === activeStatus);
  // Finalizadas: o jogo mais recente no topo (desc). Próximas partidas: o mais
  // perto do apito no topo (asc) — senão o jogo mais distante abriria a lista.
  const dir = activeStatus === 'awaiting' ? 1 : -1;
  return list.sort((a, b) => dir * (new Date(a.match_date) - new Date(b.match_date)));
}

// Dias distintos (desc) da fase ativa, com contagem
function stageDays() {
  const map = new Map(); // key -> count
  for (const m of stageMatches()) {
    map.set(dayKey(m), (map.get(dayKey(m)) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])); // desc por data
}

// ============================================================
// Render — página
// ============================================================
function renderPage() {
  // Antes do primeiro lacre publicado nenhum jogo foi revelado: em vez de uma
  // tela vazia, mostramos uma PRÉVIA desfocada do que a página vai exibir.
  if (revealedMatches.length === 0) {
    return `
      <section class="hero">
        <div class="hero-kicker">Veja o que cada jogador apostou, jogo a jogo</div>
        <h1 class="hero-title">Palpites da galera</h1>
        <div class="hero-meta">${heroMeta([
          '<b>A Copa ainda não começou</b>',
          { html: 'os palpites de todos aparecem aqui assim que o lacre do dia for publicado', flow: true },
        ])}</div>
      </section>

      ${renderPreview()}
    `;
  }

  const awaitingTotal = revealedMatches.filter(m => matchStatus(m) === 'awaiting').length;

  return `
    <section class="hero">
      <div class="hero-kicker">Veja o que cada jogador apostou, jogo a jogo</div>
      <h1 class="hero-title">Palpites da galera</h1>
      <div class="hero-meta">${heroMeta([
        `<b>${stats.finished_matches}</b> finalizados`,
        `<b>${awaitingTotal}</b> aguardando resultado`,
        `<b>${stats.pct_played}%</b> da Copa`,
      ])}</div>
    </section>

    ${renderStageTabs()}

    <div id="tabBody">
      ${renderTabBody()}
    </div>
  `;
}

// ----- ABA 1: FASE (controle segmentado; mantém #stageTabs + data-stage) -----
function renderStageTabs() {
  const groupCount = revealedMatches.filter(m => m.stage === 'group').length;
  const koCount    = revealedMatches.filter(m => m.stage !== 'group').length;
  return `
    <div class="admin-tabs hist-seg" id="stageTabs">
      <button class="admin-tab ${activeStage === 'group' ? 'active' : ''}" data-stage="group">
        Grupos <span class="ct">${groupCount}</span>
      </button>
      <button class="admin-tab ${activeStage === 'ko' ? 'active' : ''}" data-stage="ko">
        Mata-mata <span class="ct">${koCount}</span>
      </button>
    </div>
  `;
}

// ----- ABA 2 (calendário) + FILTRO de status + Resumo do dia + lista -----
function renderTabBody() {
  if (stageMatches().length === 0) {
    return renderEmptyStage();
  }
  ensureValidDay();
  ensureValidStatus();
  return `
    ${renderDayCalendar()}
    ${renderStatusChips()}
    ${renderDaySummary()}
    <div id="historyList">
      ${renderList()}
    </div>
  `;
}

// Calendário "Por data" — o MESMO componente das telas de palpite (renderDateCalendar).
// No Histórico a cor do dia conta o SEU desempenho:
//   âmbar (soon)   → dia em andamento (algum jogo sem resultado)
//   verde (done)   → dia encerrado em que você pontuou
//   vermelho (urg) → dia encerrado em que você zerou
function renderDayCalendar() {
  const days = stageDays();
  const dates = days.map(([k]) => k);
  const meta = {};
  for (const [k, count] of days) {
    const dayM = stageMatches().filter(m => dayKey(m) === k);
    const finished = dayM.filter(m => m.finished).length;
    const live = dayM.some(m => isLive(m));
    const allDone = finished >= count;
    const status = !allDone ? 'soon' : (myDayPoints(dayM) > 0 ? 'done' : 'urgent');
    const d = new Date(k + 'T12:00:00');
    meta[k] = {
      total: count,
      done: finished,
      title: formatBrShort(d),
      info: live ? 'ao vivo' : '',
      status,
    };
  }
  const legendLabels = { done: 'Você pontuou', urgent: 'Zerou o dia', soon: 'Em andamento' };
  return `<div class="hist-cal-wrap" id="dayTabs">${renderDateCalendar({ dates, meta, activeDate: activeDay, legendLabels })}</div>`;
}

// Pontos que VOCÊ fez nos jogos encerrados do dia (palpite + bônus de artilheiro).
function myDayPoints(dayM) {
  let pts = 0;
  for (const m of dayM) {
    if (!m.finished) continue;
    const mybet = (predsByMatch.get(m.id) ?? []).find(b => b.user_id === profile.id);
    if (!mybet) continue;
    pts += (mybet.points_earned ?? 0);
    const sc = scorerHitFor(mybet, m);
    if (sc) pts += sc.bonus;
  }
  return pts;
}

function renderStatusChips() {
  const scoped = dayMatches();
  const counts = {
    finished: scoped.filter(m => matchStatus(m) === 'finished').length,
    awaiting: scoped.filter(m => matchStatus(m) === 'awaiting').length,
  };
  const chip = (value, label, count) => `
    <button class="chip ${activeStatus === value ? 'active' : ''}" data-status="${value}">
      ${escapeHtml(label)} <span class="ct">${count}</span>
    </button>`;
  return `
    <div class="chips" id="statusChips">
      ${chip('finished', 'Finalizadas',       counts.finished)}
      ${chip('awaiting', 'Próximas partidas', counts.awaiting)}
    </div>
  `;
}

// ----- Resumo do dia (identidade) — derivado dos dados já carregados -----
function renderDaySummary() {
  const dayM = dayMatches();
  const finished = dayM.filter(m => m.finished);
  if (finished.length === 0) return '';

  let exactsTotal = 0, myPts = 0, myExacts = 0;
  const byUser = new Map(); // user_id -> { name, isMe, pts }
  for (const m of finished) {
    for (const b of (predsByMatch.get(m.id) ?? [])) {
      const sc = scorerHitFor(b, m);
      const tot = (b.points_earned ?? 0) + (sc ? sc.bonus : 0);
      const isExact = b.pred_home === m.actual_home && b.pred_away === m.actual_away;
      if (isExact) exactsTotal++;
      const isMe = b.user_id === profile.id;
      const u = byUser.get(b.user_id) ?? { name: b.profiles?.full_name || '?', isMe, pts: 0 };
      u.pts += tot;
      byUser.set(b.user_id, u);
      if (isMe) { myPts += tot; if (isExact) myExacts++; }
    }
  }
  let leader = null;
  for (const [, u] of byUser) if (!leader || u.pts > leader.pts) leader = u;
  const leaderName = leader ? (leader.isMe ? 'Você' : escapeHtml(firstName(leader.name))) : '—';
  const dayLabel = activeDay ? formatBrShort(new Date(activeDay + 'T12:00:00')) : '';

  const tile = (cls, icon, label, value, sub, big = false) => `
    <div class="kpi ${cls}">
      <div class="kpi-top"><span class="kpi-cap">${icon}</span><span class="kpi-label">${label}</span></div>
      <div class="kpi-num"${big ? ' style="font-size:20px"' : ''}>${value}</div>
      <div class="kpi-sub">${sub}</div>
    </div>`;

  return `
    <div class="hist-blocklabel">Resumo do dia · ${escapeHtml(dayLabel)}</div>
    <div class="kpis hist-summary">
      ${tile('', KPI.total, 'Jogos do dia', String(finished.length),
        finished.length === dayM.length ? 'todos encerrados' : `de ${dayM.length} no dia`)}
      ${tile('green', KPI.exact, 'Cravadas', String(exactsTotal), 'placares exatos no dia')}
      ${tile('gold', KPI.points, 'Líder do dia', leaderName, leader ? `+${leader.pts} no dia` : '', true)}
      ${tile('', KPI.position, 'Seu dia', `+${myPts}`,
        `${myExacts} placar${myExacts === 1 ? '' : 'es'} exato${myExacts === 1 ? '' : 's'}`)}
    </div>
  `;
}

// ----- Lista do dia selecionado -----
function renderList() {
  const list = visibleMatches();
  if (list.length === 0) return renderEmptyFilter();
  return `<div class="history-list">${list.map(renderMatchCard).join('')}</div>`;
}

function renderEmptyStage() {
  const stageName = activeStage === 'group' ? 'fase de grupos' : 'mata-mata';
  return `
    <div class="empty">
      <div class="empty-ic">${ICON.flag}</div>
      <h3>Nenhum jogo do ${stageName} começou ainda</h3>
      <p>O histórico aparece conforme os jogos começam.</p>
    </div>
  `;
}
function renderEmptyFilter() {
  return `
    <div class="empty">
      <div class="empty-ic">${ICON.info}</div>
      <h3>Nada nesse filtro</h3>
      <p>Tente outro dia ou status.</p>
    </div>
  `;
}

// ============================================================
// Card de jogo — placar (momento) + sua faixa + consenso + Raio-X (tiers)
// ============================================================
function renderMatchCard(m) {
  return matchStatus(m) === 'finished' ? renderFinishedCard(m) : renderAwaitingCard(m);
}

// group → neutro · final → dourado · third → bronze · demais (r32..sf) → ko (amarelo)
function stageCls(m) {
  const s = m.stage;
  return s === 'group' ? 'group' : s === 'final' ? 'final' : s === 'third' ? 'third' : 'ko';
}
function stageDisp(m) {
  return m.stage === 'group' ? `Grupo ${m.group_name}` : stageLabel(m.stage);
}
// "1.5" / "2" / "5" — sem zeros à toa (multiplicador do bônus de artilheiro)
function fmtMult(stage) {
  return String(stageMultiplier(stage)).replace(/\.0$/, '');
}
// Total de gols de um palpite (chave de ordenação nas "próximas partidas")
function predGoals(p) {
  return (p.pred_home ?? 0) + (p.pred_away ?? 0);
}

// Bônus de artilheiro que ESTE usuário ganhou NESTA partida (ou null se não pontuou aqui).
function scorerHitFor(bet, m) {
  const pick = scorerPickByUser.get(bet.user_id);
  if (!pick) return null;
  const goal = (goalsByMatch.get(m.id) ?? []).find(g => g.player_id === pick.playerId);
  const n = goal?.goals ?? 0;
  if (n <= 0) return null;
  return { goals: n, bonus: scorerBonus(n, m.stage), name: pick.name, team: pick.team };
}

// ----- Placar central (com leve tinta das cores dos times) -----
function boardHtml(m, inner) {
  const finished = m.finished;
  const mult = stageMultiplier(m.stage);
  const multBadge = mult > 1 ? `<span class="mult">Artilheiro ×${fmtMult(m.stage)}</span>` : '';
  const score = finished
    ? `<span class="bscore">${m.actual_home}<span class="x">–</span>${m.actual_away}</span>`
    : `<span class="bscore bs-vs">vs</span>`;
  const pen = (finished && m.pen_winner)
    ? `<div class="bpen">Pênaltis: ${escapeHtml(m.pen_winner === 'home' ? teamPt(m.team_home) : teamPt(m.team_away))}</div>` : '';
  const goals = goalsByMatch.get(m.id) ?? [];
  const scorers = (finished && goals.length)
    ? `<div class="scorers">${goals.map(g => `<span class="sc">${flag(g.players.team)} ${escapeHtml(g.players.full_name)} <b>${g.goals}</b></span>`).join('')}</div>` : '';
  return `
    <div class="board" style="--ch:${teamTint(m.team_home)};--ca:${teamTint(m.team_away)}">
      <div class="board-meta"><span class="m">${stageDisp(m)} · ${formatTime(m.match_date)}</span>${multBadge}</div>
      <div class="board-row">
        <span class="bteam">${flag(m.team_home)}<span class="bt-n">${escapeHtml(teamPt(m.team_home))}</span></span>
        ${score}
        <span class="bteam">${flag(m.team_away)}<span class="bt-n">${escapeHtml(teamPt(m.team_away))}</span></span>
      </div>
      ${pen}
      ${scorers}
      ${inner}
    </div>`;
}

// ----- Faixa "seu resultado" (sempre logo abaixo do placar) -----
function mybandHtml(m) {
  const mybet = (predsByMatch.get(m.id) ?? []).find(b => b.user_id === profile.id);
  if (!mybet) return `<div class="myline"><span class="myband miss">Você não palpitou neste jogo</span></div>`;
  const pts = mybet.points_earned ?? 0;
  const isExact = mybet.pred_home === m.actual_home && mybet.pred_away === m.actual_away;
  const isDraw = m.actual_home === m.actual_away;
  const lvl = isExact ? 'exact' : pts > 0 ? 'partial' : 'miss';
  const pred = `${mybet.pred_home}–${mybet.pred_away}`;
  const verb = isExact ? 'cravou' : 'palpitou';
  const tag = isExact ? '<span class="rk">placar exato</span>'
    : pts > 0 ? `<span class="rk">${isDraw ? 'acertou o empate' : 'acertou o vencedor'}</span>`
    : '';
  const sc = scorerHitFor(mybet, m);
  const ball = sc ? ` <span class="rk rk-ball">${ICON.ball} +${sc.bonus}</span>` : '';
  const ptsTxt = pts > 0 ? `+${pts}` : '0 pts';
  return `<div class="myline"><span class="myband ${lvl}">Você ${verb} ${pred} <span class="pts">${ptsTxt}</span> ${tag}${ball}</span></div>`;
}

// ----- Consenso: placares mais palpitados (token) + o SEU palpite -----
function consensusHtml(m, bets, finished) {
  if (!bets.length) return '';
  const freq = new Map();
  for (const b of bets) {
    const k = `${b.pred_home}-${b.pred_away}`;
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, finished ? 2 : 3);
  const pills = top.map(([k, n], i) => {
    const [h, a] = k.split('-');
    return `<span class="cpill ${i === 0 ? 'lead' : ''}"><span class="sb">${h}–${a}</span> <span class="n"><b>${n}</b>${i === 0 ? ' palpites' : ''}</span></span>`;
  }).join('');
  const mybet = bets.find(b => b.user_id === profile.id);
  const you = mybet ? `<span class="you">você <span class="sb">${mybet.pred_home}–${mybet.pred_away}</span></span>` : '';
  return `<div class="consensus"><span class="ttl">Mais palpitados</span>${pills}${you}</div>`;
}

// ----- Raio-X: tiers (cravaram / acertaram vencedor / não pontuaram) -----
function tiersHtml(m, bets) {
  const levels = { exact: [], partial: [], miss: [] };
  for (const b of bets) {
    const pts = b.points_earned ?? 0;
    const isExact = b.pred_home === m.actual_home && b.pred_away === m.actual_away;
    levels[isExact ? 'exact' : pts > 0 ? 'partial' : 'miss'].push(b);
  }
  const isDraw = m.actual_home === m.actual_away;
  const out = [];
  if (levels.exact.length)   out.push(tierHtml(m, 'exact',   'Cravaram o placar', levels.exact, true));
  if (levels.partial.length) out.push(tierHtml(m, 'partial', isDraw ? 'Acertaram o empate' : 'Acertaram o vencedor', levels.partial, false));
  if (levels.miss.length)    out.push(tierHtml(m, 'miss',    'Não pontuaram', levels.miss, false));
  return `<div class="tiers">${out.join('')}</div>`;
}

const TIER_ICON = { exact: () => ICON.check, partial: () => ICON.arrow, miss: () => ICON.x };

function tierHtml(m, level, label, list, flat) {
  const hasMe = list.some(b => b.user_id === profile.id);
  const ptsList = list.map(b => b.points_earned ?? 0);
  const min = Math.min(...ptsList), max = Math.max(...ptsList);
  const ptsLabel = level === 'miss' ? '0' : (min === max ? `+${max}` : `+${min} a +${max}`);
  const body = flat ? flatPeople(m, list) : groupedPeople(m, list);
  return `
    <details class="tier t-${level}${hasMe ? ' has-me' : ''}"${hasMe ? ' open' : ''}>
      <summary>
        <span class="t-ic">${TIER_ICON[level]()}</span>
        <span>${label}</span><span class="t-cnt">${list.length}</span>
        <span class="t-pts">${ptsLabel}</span>
        ${ICON.chev}
      </summary>
      <div class="people${flat ? ' flat' : ''}">${body}</div>
    </details>`;
}

// "Você" sempre primeiro; depois ordem alfabética
function sortMeFirst(list) {
  return [...list].sort((a, b) =>
    (b.user_id === profile.id) - (a.user_id === profile.id)
    || (a.profiles?.full_name || '').localeCompare(b.profiles?.full_name || ''));
}
function personChip(m, b) {
  const isMe = b.user_id === profile.id;
  const name = isMe ? 'Você' : (b.profiles?.full_name || '?');
  const sc = scorerHitFor(b, m);
  const ball = sc ? `<span class="ball">${ICON.ball}+${sc.bonus}</span>` : '';
  return `<span class="pp ${isMe ? 'me' : ''}"><span class="av">${avatarHtml(b.profiles)}</span><span class="nm">${escapeHtml(name)}</span>${ball}</span>`;
}
// Tier de placar único (cravaram): grade simples de chips
function flatPeople(m, list) {
  return sortMeFirst(list).map(b => personChip(m, b)).join('');
}
// Tiers parcial/zerou: subgrupos por placar, ORDENADOS POR PONTOS desc (freq desempata)
function groupedPeople(m, list) {
  const groups = new Map(); // "h-a" -> { home, away, pts, bets:[] }
  for (const b of list) {
    const key = `${b.pred_home}-${b.pred_away}`;
    if (!groups.has(key)) groups.set(key, { home: b.pred_home, away: b.pred_away, pts: b.points_earned ?? 0, bets: [] });
    groups.get(key).bets.push(b);
  }
  const arr = [...groups.values()].sort((a, b) => b.pts - a.pts || b.bets.length - a.bets.length);
  return arr.map(g => {
    const ptsBadge = g.pts > 0 ? `<span class="gp">+${g.pts}</span>` : '';
    const n = g.bets.length;
    const chips = sortMeFirst(g.bets).map(b => personChip(m, b)).join('');
    return `
      <div class="pgroup">
        <div class="pgroup-h"><span class="sb">${g.home}–${g.away}</span>${ptsBadge}<span class="cnt">${n} ${n === 1 ? 'pessoa' : 'pessoas'}</span></div>
        <div class="pgroup-people">${chips}</div>
      </div>`;
  }).join('');
}

// ----- Finalizada -----
function renderFinishedCard(m) {
  const bets = predsByMatch.get(m.id) ?? [];
  const body = bets.length
    ? `<div class="card-body">
         <div class="rx-h">Raio-X dos <span class="n">${bets.length} palpite${bets.length === 1 ? '' : 's'}</span></div>
         ${consensusHtml(m, bets, true)}
         ${tiersHtml(m, bets)}
       </div>`
    : `<div class="card-body"><div class="bets-empty">Nenhum palpite registrado pra este jogo.</div></div>`;
  return `<article class="rcard ${stageCls(m)}">${boardHtml(m, mybandHtml(m))}${body}</article>`;
}

// ----- Próxima partida (aguardando): palpites de todos, SEM pontos -----
function renderAwaitingCard(m) {
  const live = isLive(m);
  const started = new Date(m.match_date) <= new Date();
  const pillTxt = live ? 'Ao vivo' : started ? 'Aguardando resultado' : 'Lacrado · aguarda o apito';
  const pill = `<div class="myline"><span class="pill ${live ? 'live' : 'locked'}">${live ? '<span class="ld"></span>' : ''}${pillTxt}</span></div>`;

  const bets = predsByMatch.get(m.id) ?? [];
  let body;
  if (!bets.length) {
    body = `<div class="card-body"><div class="bets-empty">Nenhum palpite registrado pra este jogo.</div></div>`;
  } else {
    const mybet = bets.find(b => b.user_id === profile.id);
    const others = [...bets]
      .filter(b => b.user_id !== profile.id)
      .sort((a, b) => predGoals(b) - predGoals(a)
        || (b.pred_home ?? 0) - (a.pred_home ?? 0)
        || (a.profiles?.full_name || '').localeCompare(b.profiles?.full_name || ''));
    body = `
      <div class="card-body">
        ${consensusHtml(m, bets, false)}
        ${mybet ? awaitingRow(mybet) : ''}
        <details class="allbets">
          <summary><span>Ver os ${bets.length} palpites</span>${ICON.chev}</summary>
          ${others.map(awaitingRow).join('')}
        </details>
      </div>`;
  }
  return `<article class="rcard ${stageCls(m)} awaiting">${boardHtml(m, pill)}${body}</article>`;
}
function awaitingRow(b) {
  const isMe = b.user_id === profile.id;
  const name = isMe ? 'Você' : (b.profiles?.full_name || '?');
  return `
    <div class="abrow ${isMe ? 'me' : ''}">
      <span class="player"><span class="av">${avatarHtml(b.profiles)}</span><span class="nm">${escapeHtml(name)}</span></span>
      <span class="pred">${b.pred_home}<span class="x">–</span>${b.pred_away}</span>
    </div>`;
}

// ============================================================
// Prévia (pré-Copa) — ilustração desfocada, dados fictícios
// ============================================================
function renderPreview() {
  const chip = (av, name, me = false) =>
    `<span class="pp ${me ? 'me' : ''}"><span class="av">${av}</span><span class="nm">${name}</span></span>`;
  const card = `
    <article class="rcard group">
      <div class="board" style="--ch:#009C3B;--ca:#C1272D">
        <div class="board-meta"><span class="m">Grupo C · 16:00</span></div>
        <div class="board-row">
          <span class="bteam">${flag('Brazil')}<span class="bt-n">Brasil</span></span>
          <span class="bscore">2<span class="x">–</span>1</span>
          <span class="bteam">${flag('Croatia')}<span class="bt-n">Croácia</span></span>
        </div>
        <div class="myline"><span class="myband exact">Você cravou 2–1 <span class="pts">+7</span> <span class="rk">placar exato</span></span></div>
      </div>
      <div class="card-body">
        <div class="rx-h">Raio-X dos <span class="n">62 palpites</span></div>
        <div class="consensus"><span class="ttl">Mais palpitados</span>
          <span class="cpill lead"><span class="sb">2–1</span> <span class="n"><b>19</b> palpites</span></span>
          <span class="cpill"><span class="sb">2–0</span> <span class="n"><b>12</b></span></span>
          <span class="you">você <span class="sb">2–1</span></span>
        </div>
        <div class="tiers">
          <details class="tier t-exact has-me" open>
            <summary><span class="t-ic">${ICON.check}</span><span>Cravaram o placar</span><span class="t-cnt">4</span><span class="t-pts">+7</span>${ICON.chev}</summary>
            <div class="people flat">${chip('VC', 'Você', true)}${chip('AN', 'Ana')}${chip('BR', 'Bruno')}${chip('CA', 'Carla')}</div>
          </details>
          <details class="tier t-partial">
            <summary><span class="t-ic">${ICON.arrow}</span><span>Acertaram o vencedor</span><span class="t-cnt">36</span><span class="t-pts">+3 a +4</span>${ICON.chev}</summary>
            <div class="people"></div>
          </details>
        </div>
      </div>
    </article>`;
  return `
    <div class="preview-wrap">
      <div class="preview-blurred" aria-hidden="true">
        <div class="history-list">${card}</div>
      </div>
      <div class="preview-overlay">
        <span class="preview-badge">${ICON.eye} Prévia</span>
        <h3>É assim que vai ficar</h3>
        <p>Quando a Copa começar, cada jogo mostra aqui o <strong>palpite de todos os participantes</strong>,
           agrupados por acerto. Os nomes e placares acima são <strong>só de exemplo</strong> — nada aqui é real ainda.</p>
        <a class="btn btn-green" href="palpites-grupos.html">Fazer meus palpites →</a>
      </div>
    </div>
  `;
}

// ============================================================
// Eventos
// ============================================================
function attachEventListeners() {
  document.addEventListener('click', (e) => {
    // ABA 1: fase
    const tab = e.target.closest('.admin-tab[data-stage]');
    if (tab) {
      if (tab.dataset.stage !== activeStage) {
        activeStage = tab.dataset.stage;
        activeDay = null;          // renderTabBody → ensureValidDay seleciona o dia mais recente
        activeStatus = 'finished'; // renderTabBody → ensureValidStatus ajusta se o dia não tiver finalizadas
        document.querySelectorAll('#stageTabs .admin-tab').forEach(t =>
          t.classList.toggle('active', t.dataset.stage === activeStage));
        document.getElementById('tabBody').innerHTML = renderTabBody();
      }
      return;
    }
    // ABA 2: dia (célula do calendário)
    const dayCell = e.target.closest('.cal-day[data-date]');
    if (dayCell) {
      if (dayCell.dataset.date !== activeDay) {
        activeDay = dayCell.dataset.date;
        ensureValidStatus();  // mantém o status atual se houver jogos; senão troca
        document.getElementById('tabBody').innerHTML = renderTabBody();
      }
      return;
    }
    // FILTRO: status
    const chip = e.target.closest('[data-status]');
    if (chip) {
      if (chip.dataset.status === activeStatus) return;
      activeStatus = chip.dataset.status;
      document.querySelectorAll('#statusChips .chip').forEach(c =>
        c.classList.toggle('active', c.dataset.status === activeStatus));
      document.getElementById('historyList').innerHTML = renderList();
      return;
    }
  });
}

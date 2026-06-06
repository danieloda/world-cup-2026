import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase, fetchAllPages } from '../supabase.js';
import {
  flag, escapeHtml, teamPt, formatBrShort, formatTime, stageLabel,
  isLive, avatarHtml, localDateKey,
} from '../util.js';
import { scorerBonus, stageMultiplier, scoreBreakdown } from '../scoring.js';

// ============================================================
// Estado
// ============================================================
let profile, stats;
let revealedMatches = [];          // jogos já iniciados (match_date <= now), desc por data
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
} catch (err) {
  console.error('[historico] FATAL:', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:#fff; font-family:sans-serif;">
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
    // Um jogo entra no Histórico quando JÁ COMEÇOU (apito inicial): é o momento
    // em que o RLS revela os palpites alheios (predictions_select_own_or_locked).
    supabase.from('matches').select('*').lte('match_date', new Date().toISOString())
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
  // Chave de dia no fuso de Brasília (mesmo de formatBrShort/formatBrDate), pra
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
  return dayMatches().filter(m => matchStatus(m) === activeStatus);
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
  // Antes da Copa começar nenhum jogo foi revelado (nenhum começou): em vez de uma
  // tela vazia, mostramos uma PRÉVIA desfocada do que a página vai exibir.
  if (revealedMatches.length === 0) {
    return `
      <section class="hero">
        <div class="hero-kicker">Veja o que cada jogador apostou, jogo a jogo</div>
        <h1 class="hero-title">Palpites da galera</h1>
        <div class="hero-meta">
          <b>A Copa ainda não começou</b><span class="sep"></span>
          os palpites de todos aparecem aqui assim que a bola rolar
        </div>
      </section>

      ${renderPreview()}
    `;
  }

  const awaitingTotal = revealedMatches.filter(m => matchStatus(m) === 'awaiting').length;

  return `
    <section class="hero">
      <div class="hero-kicker">Veja o que cada jogador apostou, jogo a jogo</div>
      <h1 class="hero-title">Palpites da galera</h1>
      <div class="hero-meta">
        <b>${stats.finished_matches}</b> finalizados<span class="sep"></span>
        <b>${awaitingTotal}</b> aguardando resultado<span class="sep"></span>
        <b>${stats.pct_played}%</b> da Copa
      </div>
    </section>

    <p class="hist-note">Os palpites de todos ficam visíveis quando o jogo começa — em <b>Próximas partidas</b> sem pontos, e em <b>Finalizadas</b> já pontuados.</p>

    ${renderStageTabs()}

    <div id="tabBody">
      ${renderTabBody()}
    </div>
  `;
}

// ============================================================
// Prévia (pré-Copa) — ilustração desfocada, dados fictícios
// ============================================================
function renderPreview() {
  // Exemplos 100% fictícios só para mostrar o formato da tela. Ninguém vê palpite
  // de ninguém antes do apito inicial — por isso fica borrado e marcado como "Prévia".
  const demos = [
    {
      home: 'Brazil', away: 'Croatia', sh: 2, sa: 1, stage: 'Grupo C',
      bets: [
        { name: 'Você',  ph: 2, pa: 1, pts: 7, cls: 'win-exact',   pcls: 'exact',   me: true },
        { name: 'Ana',   ph: 2, pa: 0, pts: 5, cls: 'win-partial', pcls: 'partial' },
        { name: 'Bruno', ph: 1, pa: 1, pts: 1, cls: 'win-partial', pcls: 'partial' },
        { name: 'Carla', ph: 0, pa: 2, pts: 0, cls: 'miss',        pcls: 'zero' },
      ],
    },
    {
      home: 'Argentina', away: 'France', sh: 1, sa: 1, stage: 'Grupo D',
      bets: [
        { name: 'Diego', ph: 1, pa: 1, pts: 7, cls: 'win-exact',   pcls: 'exact' },
        { name: 'Elis',  ph: 0, pa: 0, pts: 5, cls: 'win-partial', pcls: 'partial' },
        { name: 'Você',  ph: 2, pa: 1, pts: 1, cls: 'win-partial', pcls: 'partial', me: true },
      ],
    },
  ];

  const cards = demos.map(d => `
    <div class="history-card group">
      <div class="history-head">
        <div class="date">16:00</div>
        <div class="matchup">
          <span class="flag">${flag(d.home)}</span>
          <span>${escapeHtml(teamPt(d.home))}</span>
          <span style="color:var(--text-mute); font-weight:500;">×</span>
          <span>${escapeHtml(teamPt(d.away))}</span>
          <span class="flag">${flag(d.away)}</span>
        </div>
        <div class="score">${d.sh} — ${d.sa}</div>
        <div class="stage">${d.stage}</div>
      </div>
      <div class="history-bets">
        ${d.bets.map(b => `
          <div class="hb-row ${b.cls} ${b.me ? 'me' : ''}">
            <div class="av-mini">${avatarHtml({ full_name: b.name })}</div>
            <div class="nm">${escapeHtml(b.name)}</div>
            <span class="pred">${b.ph}<span class="x">–</span>${b.pa}</span>
            <span class="pts ${b.pcls}">${b.pts > 0 ? '+' + b.pts : '0'}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  return `
    <div class="preview-wrap">
      <div class="preview-blurred" aria-hidden="true">
        <div class="history-list">${cards}</div>
      </div>
      <div class="preview-overlay">
        <span class="preview-badge">👀 Prévia</span>
        <h3>É assim que vai ficar</h3>
        <p>Quando a Copa começar, cada jogo mostra aqui o <strong>palpite de todos os participantes</strong>,
           com os pontos de cada um. Os nomes e placares acima são <strong>só de exemplo</strong> — nada aqui é real ainda.</p>
        <a class="btn btn-green" href="palpites-grupos.html">Fazer meus palpites →</a>
      </div>
    </div>
  `;
}

// ----- ABA 1: FASE -----
function renderStageTabs() {
  const groupCount = revealedMatches.filter(m => m.stage === 'group').length;
  const koCount    = revealedMatches.filter(m => m.stage !== 'group').length;
  return `
    <div class="admin-tabs" id="stageTabs">
      <button class="admin-tab ${activeStage === 'group' ? 'active' : ''}" data-stage="group">
        Grupos <span class="ct">${groupCount}</span>
      </button>
      <button class="admin-tab ${activeStage === 'ko' ? 'active' : ''}" data-stage="ko">
        Mata-mata <span class="ct">${koCount}</span>
      </button>
    </div>
  `;
}

// ----- ABA 2 (dias) + FILTRO de status + lista -----
function renderTabBody() {
  if (stageMatches().length === 0) {
    return renderEmptyStage();
  }
  ensureValidDay();
  ensureValidStatus();
  return `
    ${renderDayTabs()}
    ${renderStatusChips()}
    <div id="historyList">
      ${renderList()}
    </div>
  `;
}

function renderDayTabs() {
  const days = stageDays();
  return `
    <div class="day-tabs" id="dayTabs">
      ${days.map(([key, count]) => {
        const d = new Date(key + 'T12:00:00');
        return `
          <button class="day-tab ${activeDay === key ? 'active' : ''}" data-day="${key}">
            ${formatBrShort(d)} <span class="ct">${count}</span>
          </button>
        `;
      }).join('')}
    </div>
  `;
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
      <h3>Nenhum jogo do ${stageName} começou ainda</h3>
      <p>O histórico aparece conforme os jogos começam.</p>
    </div>
  `;
}
function renderEmptyFilter() {
  return `
    <div class="empty">
      <h3>Nada nesse filtro</h3>
      <p>Tente outro dia ou status.</p>
    </div>
  `;
}

// ============================================================
// Card de jogo
// ============================================================
function renderMatchCard(m) {
  return matchStatus(m) === 'finished' ? renderFinishedCard(m) : renderAwaitingCard(m);
}

function matchupHtml(m) {
  return `
    <div class="matchup">
      <span class="flag">${flag(m.team_home)}</span>
      <span>${escapeHtml(teamPt(m.team_home))}</span>
      <span style="color:var(--text-mute); font-weight:500;">×</span>
      <span>${escapeHtml(teamPt(m.team_away))}</span>
      <span class="flag">${flag(m.team_away)}</span>
    </div>
  `;
}

function stageDisp(m) {
  return m.stage === 'group' ? `Grupo ${m.group_name}` : stageLabel(m.stage);
}

// Total de gols de um palpite (chave de ordenação)
function predGoals(p) {
  return (p.pred_home ?? 0) + (p.pred_away ?? 0);
}

// Bônus de artilheiro que ESTE usuário ganhou NESTA partida (ou null se não pontuou aqui).
// Cruza o artilheiro escolhido com os gols marcados no jogo.
function scorerHitFor(bet, m) {
  const pick = scorerPickByUser.get(bet.user_id);
  if (!pick) return null;
  const goal = (goalsByMatch.get(m.id) ?? []).find(g => g.player_id === pick.playerId);
  const n = goal?.goals ?? 0;
  if (n <= 0) return null;
  return { goals: n, bonus: scorerBonus(n, m.stage), name: pick.name, team: pick.team };
}

// "1.5" / "2" / "5" — sem zeros à toa (multiplicador do bônus de artilheiro)
function fmtMult(stage) {
  return String(stageMultiplier(stage)).replace(/\.0$/, '');
}

// ----- Conteúdo dos popovers (tooltip estilizado, montado em hover) -----
// Cada gatilho carrega seu HTML num <template hidden> irmão; ver initTooltips().
function tipShell(kicker, tier, tierCls, rowsHtml, totalCls, totalTxt) {
  return `
    <div class="tip-head">
      <span class="tip-kicker">${escapeHtml(kicker)}</span>
      <span class="tip-tier ${tierCls}">${escapeHtml(tier)}</span>
    </div>
    <div class="tip-rows">${rowsHtml}</div>
    <div class="tip-total">
      <span class="tip-total-lbl">Total no jogo</span>
      <span class="tip-total-sum ${totalCls}">${totalTxt}</span>
    </div>`;
}

// Palpite: modelo ADITIVO — cada acerto soma; o "peso" é o valor da fase (não há ×N único).
function betTipHtml(bet, m, pts, isExact) {
  const tier = isExact ? ['Placar exato', 'exact']
    : pts > 0 ? ['Acerto parcial', 'partial']
    : ['Não pontuou', 'zero'];
  const { parts } = scoreBreakdown(
    bet.pred_home, bet.pred_away, bet.pred_pen_winner,
    m.actual_home, m.actual_away, m.pen_winner, m.stage,
  );
  const rows = parts.length > 0
    ? parts.map(p => `
        <div class="tip-row">
          <span class="tip-row-lbl">${escapeHtml(p.label)}</span>
          <span class="tip-row-val add"><span class="op">+</span>${p.pts}</span>
        </div>`).join('')
    : `<div class="tip-row miss-row"><span class="tip-row-lbl">Errou gols, resultado e saldo</span></div>`;
  return tipShell(stageDisp(m), tier[0], tier[1], rows, tier[1], pts > 0 ? `+${pts}` : '0');
}

// Artilheiro: bônus MULTIPLICATIVO — gols × 2 × peso da fase.
function scorerTipHtml(sc, m) {
  const mult = stageMultiplier(m.stage);
  const golLbl = `Gols na partida${sc.goals > 1 ? ` (${sc.goals})` : ''}`;
  let rows = `
    <div class="tip-player">${flag(sc.team)} <span>${escapeHtml(sc.name)}</span></div>
    <div class="tip-row">
      <span class="tip-row-lbl">${golLbl}</span>
      <span class="tip-row-val">${sc.goals}</span>
    </div>
    <div class="tip-row">
      <span class="tip-row-lbl">Pontos por gol</span>
      <span class="tip-row-val"><span class="op">×</span>2</span>
    </div>`;
  if (mult > 1) {
    rows += `
    <div class="tip-row">
      <span class="tip-row-lbl">Peso · ${escapeHtml(stageLabel(m.stage))}</span>
      <span class="tip-row-val mult"><span class="op">×</span>${fmtMult(m.stage)}</span>
    </div>`;
  }
  return tipShell('Bônus de artilheiro', 'Seu artilheiro', 'scorer', rows, 'scorer', `+${sc.bonus}`);
}

// ----- Finalizada: resultado + pontos + gols -----
function renderFinishedCard(m) {
  // Ordena: pontos desc → total de gols desc → mandante desc → nome
  const bets = [...(predsByMatch.get(m.id) ?? [])].sort((a, b) =>
    (b.points_earned ?? 0) - (a.points_earned ?? 0)
    || predGoals(b) - predGoals(a)
    || (b.pred_home ?? 0) - (a.pred_home ?? 0)
    || (a.profiles?.full_name || '').localeCompare(b.profiles?.full_name || '')
  );
  const goals = goalsByMatch.get(m.id) ?? [];
  const penInfo = m.pen_winner
    ? `<small>pen: ${m.pen_winner === 'home' ? teamPt(m.team_home) : teamPt(m.team_away)}</small>` : '';
  // Fases de peso (×>1) valem mais no bônus de artilheiro — sinaliza no topo do card.
  const mult = stageMultiplier(m.stage);
  const multBadge = mult > 1 ? ` <span class="stage-mult">· Artilheiro ×${fmtMult(m.stage)}</span>` : '';

  return `
    <div class="history-card ${m.stage}">
      <div class="history-head">
        <div class="date">${formatTime(m.match_date)}</div>
        ${matchupHtml(m)}
        <div class="score">${m.actual_home} — ${m.actual_away}${penInfo}</div>
        <div class="stage">${stageDisp(m)}${multBadge}</div>
      </div>

      ${renderBetsList(m, bets, true)}

      ${goals.length > 0 ? `
        <div class="history-scorers">
          <span class="label">⚽ Gols:</span>
          ${goals.map(g => `<span class="scorer"><span class="fl">${flag(g.players.team)}</span> ${escapeHtml(g.players.full_name)} <span class="num">${g.goals}</span></span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

// ----- Próxima partida (aguardando): palpites de todos, SEM pontos -----
function renderAwaitingCard(m) {
  const live = isLive(m);
  // Ordena por total de gols desc → mandante desc → nome ("Você" fica destacado pelo estilo)
  const bets = [...(predsByMatch.get(m.id) ?? [])].sort((a, b) =>
    predGoals(b) - predGoals(a)
    || (b.pred_home ?? 0) - (a.pred_home ?? 0)
    || (a.profiles?.full_name || '').localeCompare(b.profiles?.full_name || '')
  );

  return `
    <div class="history-card ${m.stage} awaiting">
      <div class="history-head">
        <div class="date">${formatTime(m.match_date)}</div>
        ${matchupHtml(m)}
        <div class="status-cell">
          <span class="pill ${live ? 'live' : 'locked'}">${live ? 'Ao vivo' : 'Aguardando resultado'}</span>
        </div>
        <div class="stage">${stageDisp(m)}</div>
      </div>

      ${renderBetsList(m, bets, false)}
    </div>
  `;
}

// ----- Lista vertical de palpites -----
function renderBetsList(m, bets, finished) {
  if (bets.length === 0) {
    return `<div class="history-bets-empty">Nenhum palpite registrado pra este jogo.</div>`;
  }
  return `
    <div class="history-bets">
      ${bets.map(b => renderBetRow(b, m, finished)).join('')}
    </div>
  `;
}

function renderBetRow(bet, m, finished) {
  const isMe = bet.user_id === profile.id;
  const name = isMe ? 'Você' : (bet.profiles?.full_name || '?');

  if (!finished) {
    return `
      <div class="hb-row ${isMe ? 'me' : ''}">
        <div class="av-mini">${avatarHtml(bet.profiles)}</div>
        <div class="nm">${escapeHtml(name)}</div>
        <span class="pred">${bet.pred_home}<span class="x">–</span>${bet.pred_away}</span>
      </div>
    `;
  }

  const pts = bet.points_earned ?? 0;
  const isExact = bet.pred_home === m.actual_home && bet.pred_away === m.actual_away;
  const rowClass = isExact ? 'win-exact' : pts > 0 ? 'win-partial' : 'miss';
  const ptsClass = isExact ? 'exact' : pts > 0 ? 'partial' : 'zero';

  // Bônus de artilheiro: chip discreto quando o artilheiro DESTA pessoa marcou no jogo.
  const sc = scorerHitFor(bet, m);
  const scorerChip = sc
    ? `<span class="hb-scorer" data-tip>⚽+${sc.bonus}</span>` +
      `<template class="tip-src">${scorerTipHtml(sc, m)}</template>`
    : '';

  return `
    <div class="hb-row ${rowClass} ${isMe ? 'me' : ''}">
      <div class="av-mini">${avatarHtml(bet.profiles)}</div>
      <div class="nm">${escapeHtml(name)}</div>
      <span class="pred">${bet.pred_home}<span class="x">–</span>${bet.pred_away}</span>
      <span class="pts ${ptsClass}" data-tip>${pts > 0 ? '+' + pts : '0'}</span>
      <template class="tip-src">${betTipHtml(bet, m, pts, isExact)}</template>
      ${scorerChip}
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
    // ABA 2: dia
    const dayTab = e.target.closest('.day-tab[data-day]');
    if (dayTab) {
      if (dayTab.dataset.day !== activeDay) {
        activeDay = dayTab.dataset.day;
        ensureValidStatus();  // mantém o status atual se houver jogos; senão troca
        document.querySelectorAll('#dayTabs .day-tab').forEach(t =>
          t.classList.toggle('active', t.dataset.day === activeDay));
        // recontagem do status dentro do dia + lista
        document.getElementById('statusChips').outerHTML = renderStatusChips();
        document.getElementById('historyList').innerHTML = renderList();
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

  initTooltips();
}

// ============================================================
// Tooltip flutuante (popover de pontos / artilheiro)
// ------------------------------------------------------------
// Um único elemento reaproveitado, anexado ao <body> e posicionado via JS.
// O conteúdo de cada gatilho vem do <template.tip-src> irmão. Delegação no
// document → sobrevive aos re-renders das abas. Hover no desktop, toque no mobile.
// ============================================================
function initTooltips() {
  let tipEl = null;
  let current = null;   // gatilho atualmente exibido (p/ toggle no toque)

  const ensure = () => {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'hist-tip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  };

  function show(trigger) {
    const src = trigger.nextElementSibling;
    if (!src || !src.classList.contains('tip-src')) return;
    const el = ensure();
    el.innerHTML = src.innerHTML;
    el.classList.add('show');
    current = trigger;
    position(trigger, el);
  }

  function hide() {
    if (tipEl) tipEl.classList.remove('show');
    current = null;
  }

  function position(trigger, el) {
    // mede com a tip já visível mas fora da tela
    el.style.left = '-9999px';
    el.style.top = '0';
    const r = trigger.getBoundingClientRect();
    const tw = el.offsetWidth, th = el.offsetHeight;
    const gap = 9, pad = 8;
    // centraliza no gatilho, prefere ACIMA; cai pra baixo se não couber
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
    let top = r.top - th - gap;
    let place = 'top';
    if (top < pad) { top = r.bottom + gap; place = 'bottom'; }
    el.dataset.place = place;
    // seta apontando pro centro do gatilho (clampada à largura da tip)
    const ax = Math.max(14, Math.min(r.left + r.width / 2 - left, tw - 14));
    el.style.setProperty('--tip-arrow', `${ax}px`);
    el.style.left = `${Math.round(left + window.scrollX)}px`;
    el.style.top = `${Math.round(top + window.scrollY)}px`;
  }

  // Desktop: hover
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) show(t);
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) hide();
  });
  // Mobile: toque alterna; tocar fora fecha
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) { (current === t) ? hide() : show(t); }
    else if (current) hide();
  });
  // Some ao rolar (captura também o scroll de containers internos)
  document.addEventListener('scroll', hide, { passive: true, capture: true });
}

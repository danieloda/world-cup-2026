import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, teamPt, formatBrShort, formatTime, stageLabel,
  attachTeamTooltips, loadRecentMatches, avatarHtml,
} from '../util.js';

// ============================================================
// Estado
// ============================================================
let profile, stats;
let finishedMatches = [];          // só finished=true, desc por data
let predsByMatch = new Map();      // match_id -> [{...prediction, profiles}]
let goalsByMatch = new Map();      // match_id -> [{...goal, players}]
let activeFilter = 'all';          // 'all' | 'today' | 'yesterday' | 'week' | 'group' | 'ko'

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

  const recentByTeam = await loadRecentMatches();
  attachTeamTooltips(recentByTeam);
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
    supabase.from('matches').select('*').eq('finished', true).order('match_date', { ascending: false }),
  ]);

  if (matchesRes.error) throw matchesRes.error;
  stats = statsRes.data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0 };
  finishedMatches = matchesRes.data ?? [];

  if (finishedMatches.length === 0) return;

  // Carrega palpites + gols só dos jogos finalizados
  const matchIds = finishedMatches.map(m => m.id);
  const [predsRes, goalsRes] = await Promise.all([
    supabase.from('predictions')
      .select('*, profiles(full_name, email, paid, avatar_url)')
      .in('match_id', matchIds),
    supabase.from('player_goals')
      .select('*, players(full_name, team)')
      .in('match_id', matchIds),
  ]);

  // Agrupa
  for (const p of (predsRes.data ?? [])) {
    if (!p.profiles?.paid) continue;  // só palpites de usuários pagos
    if (!predsByMatch.has(p.match_id)) predsByMatch.set(p.match_id, []);
    predsByMatch.get(p.match_id).push(p);
  }
  for (const g of (goalsRes.data ?? [])) {
    if (!goalsByMatch.has(g.match_id)) goalsByMatch.set(g.match_id, []);
    goalsByMatch.get(g.match_id).push(g);
  }
}

// ============================================================
// Filtros
// ============================================================
function applyFilter(matches, filter) {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekAgo = new Date(todayStart); weekAgo.setDate(weekAgo.getDate() - 7);

  switch (filter) {
    case 'today':
      return matches.filter(m => new Date(m.match_date) >= todayStart);
    case 'yesterday':
      return matches.filter(m => {
        const d = new Date(m.match_date);
        return d >= yesterdayStart && d < todayStart;
      });
    case 'week':
      return matches.filter(m => new Date(m.match_date) >= weekAgo);
    case 'group':
      return matches.filter(m => m.stage === 'group');
    case 'ko':
      return matches.filter(m => m.stage !== 'group');
    default:
      return matches;
  }
}

function getCounts() {
  return {
    all: finishedMatches.length,
    today: applyFilter(finishedMatches, 'today').length,
    yesterday: applyFilter(finishedMatches, 'yesterday').length,
    week: applyFilter(finishedMatches, 'week').length,
    group: applyFilter(finishedMatches, 'group').length,
    ko: applyFilter(finishedMatches, 'ko').length,
  };
}

// ============================================================
// Render
// ============================================================
function renderPage() {
  const counts = getCounts();
  const totalPaid = stats.paid_users;

  return `
    <section class="hero">
      <div class="hero-kicker">Resultados e palpites de todos</div>
      <h1 class="hero-title">Histórico</h1>
      <div class="hero-meta">
        <b>${stats.finished_matches}</b> jogos finalizados<span class="sep"></span>
        <b>${totalPaid}</b> jogadores<span class="sep"></span>
        <b>${stats.pct_played}%</b> da Copa
      </div>
    </section>

    <div class="note" style="margin-bottom:20px; padding:12px 16px; background:var(--card); border-left:3px solid var(--green); border-radius:0 6px 6px 0; font-size:12px; color:var(--text-dim);">
      <strong style="color:var(--green);">Transparência total:</strong>
      Veja o palpite de cada jogador após o apito final. Quem acertou? Quem errou feio? Confira tudo aqui.
    </div>

    <div class="chips" id="chips">
      ${renderChip('all',       'Todos',       counts.all)}
      ${renderChip('today',     'Hoje',        counts.today)}
      ${renderChip('yesterday', 'Ontem',       counts.yesterday)}
      ${renderChip('week',      'Esta semana', counts.week)}
      ${renderChip('group',     'Grupos',      counts.group)}
      ${renderChip('ko',        'Mata-mata',   counts.ko)}
    </div>

    <div id="historyList">
      ${renderList()}
    </div>
  `;
}

function renderChip(value, label, count) {
  const isActive = activeFilter === value;
  return `
    <button class="chip ${isActive ? 'active' : ''}" data-filter="${value}">
      ${escapeHtml(label)} <span class="ct">${count}</span>
    </button>
  `;
}

function renderList() {
  const filtered = applyFilter(finishedMatches, activeFilter);

  if (filtered.length === 0) {
    return renderEmpty();
  }

  return `
    <div class="history-list">
      ${filtered.map(renderHistoryCard).join('')}
    </div>
  `;
}

function renderEmpty() {
  if (finishedMatches.length === 0) {
    return `
      <div class="empty">
        <h3>Nenhum jogo finalizado ainda</h3>
        <p>O histórico aparece conforme o admin lança os resultados.
          Volte aqui após o início da Copa pra ver os palpites de todos os jogadores.</p>
        <a class="btn btn-ghost" href="inicio.html">← Início</a>
      </div>
    `;
  }
  return `
    <div class="empty">
      <h3>Sem jogos nesse filtro</h3>
      <p>Tente outro período ou veja todos os jogos finalizados.</p>
      <button class="btn btn-ghost" onclick="document.querySelector('[data-filter=all]').click()">Ver todos</button>
    </div>
  `;
}

function renderHistoryCard(m) {
  const bets = predsByMatch.get(m.id) ?? [];
  const goals = goalsByMatch.get(m.id) ?? [];

  // Sort bets: pts desc, then nome
  const sortedBets = [...bets].sort((a, b) => {
    const pa = a.points_earned ?? 0;
    const pb = b.points_earned ?? 0;
    if (pb !== pa) return pb - pa;
    return (a.profiles?.full_name || '').localeCompare(b.profiles?.full_name || '');
  });

  const stageDisp = m.stage === 'group' ? `Grupo ${m.group_name}` : stageLabel(m.stage);
  const penInfo = m.pen_winner ? `<small>pen: ${m.pen_winner === 'home' ? teamPt(m.team_home) : teamPt(m.team_away)}</small>` : '';

  return `
    <div class="history-card ${m.stage}">
      <div class="history-head">
        <div class="date">${formatBrShort(new Date(m.match_date))} · ${formatTime(m.match_date)}</div>
        <div class="matchup">
          <span class="flag">${flag(m.team_home)}</span>
          <span class="team-name" data-team="${escapeHtml(m.team_home)}">${escapeHtml(teamPt(m.team_home))}</span>
          <span style="color:var(--text-mute); font-weight:500;">×</span>
          <span class="team-name" data-team="${escapeHtml(m.team_away)}">${escapeHtml(teamPt(m.team_away))}</span>
          <span class="flag">${flag(m.team_away)}</span>
        </div>
        <div class="score">
          ${m.actual_home} — ${m.actual_away}
          ${penInfo}
        </div>
        <div class="stage">${stageDisp}</div>
      </div>

      ${sortedBets.length > 0 ? `
        <div class="history-bets">
          ${sortedBets.map(b => renderBetCell(b)).join('')}
        </div>
      ` : '<div style="padding-top:12px; border-top:1px solid var(--line); font-size:12px; color:var(--text-mute); font-style:italic;">Nenhum palpite registrado pra este jogo.</div>'}

      ${goals.length > 0 ? `
        <div class="history-scorers">
          <span class="label">⚽ Gols:</span>
          ${goals.map(g => `<span class="scorer">${escapeHtml(g.players.full_name)} <span class="num">${g.goals}'</span></span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderBetCell(bet) {
  const pts = bet.points_earned ?? 0;
  const isMe = bet.user_id === profile.id;
  const ptsClass = pts === 5 ? 'exact' : pts > 0 ? 'partial' : 'zero';
  const cellClass = pts === 5 ? 'win-exact' : pts > 0 ? 'win-partial' : '';
  const cls = ['hb-cell', cellClass, isMe ? 'me' : ''].filter(Boolean).join(' ');
  const displayName = isMe ? 'Você' : (bet.profiles?.full_name || '?').split(' ')[0];

  return `
    <div class="${cls}">
      <div class="av-mini">${avatarHtml(bet.profiles)}</div>
      <div class="nm">${escapeHtml(displayName)}</div>
      <div class="pred-and-pts">
        <span class="pred">${bet.pred_home}-${bet.pred_away}</span>
        <span class="pts ${ptsClass}">${pts > 0 ? '+' + pts : '0'}</span>
      </div>
    </div>
  `;
}

// ============================================================
// Eventos
// ============================================================
function attachEventListeners() {
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-filter]');
    if (!chip) return;
    const f = chip.dataset.filter;
    if (f === activeFilter) return;
    activeFilter = f;
    // Re-render chips e lista
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.filter === f));
    document.getElementById('historyList').innerHTML = renderList();
  });
}


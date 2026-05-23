import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, greeting, firstName, daysToKickoffLabel,
  formatBrDate, formatTime, formatRelative, stageLabel, isLive,
  teamPt, groundShort,
} from '../util.js';

// Estado da página
let profile, stats, todayMatches, upcomingMatches, myStanding;

// ============================================================
// Queries
// ============================================================
async function matchesToday() {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end   = new Date(now); end.setHours(23, 59, 59, 999);
  return supabase
    .from('matches')
    .select('*')
    .gte('match_date', start.toISOString())
    .lte('match_date', end.toISOString())
    .order('match_date');
}

async function matchesUpcoming(limit) {
  return supabase
    .from('matches')
    .select('*')
    .gt('match_date', new Date().toISOString())
    .eq('finished', false)
    .order('match_date')
    .limit(limit);
}

// ============================================================
// Render
// ============================================================
function renderInicio() {
  return `
    <section class="hero">
      <div class="hero-kicker">${greeting()}, ${escapeHtml(firstName(profile.full_name))}</div>
      <h1 class="hero-title">${todayMatches.length > 0 ? 'Jogos de hoje' : daysToKickoffLabel()}</h1>
      <div class="hero-meta">
        <b>${stats.finished_matches}/${stats.total_matches} jogos</b>
        <span class="sep"></span>
        <b>${stats.pct_played ?? 0}%</b> da Copa disputada
        ${stats.paid_users ? `<span class="sep"></span><b>${stats.paid_users}</b> jogadores no bolão` : ''}
      </div>
    </section>

    ${renderKpis()}

    ${todayMatches.length > 0 ? renderTodaySection() : ''}

    ${renderUpcomingSection()}

    ${renderQuickLinks()}
  `;
}

function renderKpis() {
  const pointsDisplay = myStanding?.total_pts ?? 0;
  const exactsDisplay = myStanding?.exact_count ?? 0;
  const scorerPts = myStanding?.scorer_pts ?? 0;
  return `
    <div class="kpis">
      <div class="kpi green">
        <div class="kpi-label">Sua posição</div>
        <div class="kpi-num">—</div>
        <div class="kpi-sub">${stats.paid_users ? `de ${stats.paid_users} jogadores` : 'aguardando jogos'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Seus pontos</div>
        <div class="kpi-num">${pointsDisplay}</div>
        <div class="kpi-sub">${scorerPts ? `+${scorerPts} artilheiro` : 'sem jogos ainda'}</div>
      </div>
      <div class="kpi gold">
        <div class="kpi-label">Placares exatos</div>
        <div class="kpi-num">${exactsDisplay}</div>
        <div class="kpi-sub">vale 5 pts cada</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Copa disputada</div>
        <div class="kpi-num">${stats.pct_played ?? 0}<small>%</small></div>
        <div class="kpi-sub">${stats.finished_matches}/${stats.total_matches} jogos</div>
      </div>
    </div>
  `;
}

function renderTodaySection() {
  return `
    <div class="section-head">
      <h3>Hoje · ${formatBrDate(new Date())}</h3>
      <a class="see-all" href="historico.html">Ver tudo →</a>
    </div>
    <div class="today-grid">
      ${todayMatches.map(renderTodayCard).join('')}
    </div>
  `;
}

function renderTodayCard(m) {
  const live = isLive(m);
  const score = m.finished || live
    ? `<div class="today-score ${live ? 'live' : ''}">${m.actual_home ?? '–'} — ${m.actual_away ?? '–'}</div>`
    : `<div class="today-score">— —</div>`;
  const status = m.finished ? '<span class="pill done">Finalizado</span>'
    : live ? '<span class="pill live">Ao vivo</span>'
    : `<span class="pill open">${formatTime(m.match_date)}</span>`;
  return `
    <div class="today-card">
      <div class="today-card-head">
        <span class="today-card-time">${escapeHtml(groundShort(m.ground))} ${m.group_name ? `· Grupo ${m.group_name}` : ''}</span>
        ${status}
      </div>
      <div class="today-teams">
        <div class="today-team">
          <div class="flag">${flag(m.team_home)}</div>
          <div class="nm">${escapeHtml(teamPt(m.team_home))}</div>
        </div>
        ${score}
        <div class="today-team">
          <div class="flag">${flag(m.team_away)}</div>
          <div class="nm">${escapeHtml(teamPt(m.team_away))}</div>
        </div>
      </div>
    </div>
  `;
}

function renderUpcomingSection() {
  if (upcomingMatches.length === 0) {
    return `
      <div class="empty" style="margin-top:32px;">
        <h3>Copa encerrada 🏆</h3>
        <p>Todos os jogos foram disputados. Confira o ranking final.</p>
        <a class="btn btn-green" href="ranking.html">Ver ranking</a>
      </div>
    `;
  }
  return `
    <div class="section-head">
      <h3>Próximos jogos</h3>
      <a class="see-all" href="palpites-grupos.html">Fazer palpites →</a>
    </div>
    ${upcomingMatches.map(renderMatchRow).join('')}
  `;
}

function renderMatchRow(m) {
  return `
    <div class="match">
      <div class="match-when">
        <strong>${formatTime(m.match_date)}</strong>
        ${escapeHtml(groundShort(m.ground))}
      </div>
      <div class="team home">
        <span class="flag">${flag(m.team_home)}</span> ${escapeHtml(teamPt(m.team_home))}
      </div>
      <div class="score-cell">
        <span style="color:var(--text-mute); font-size:13px; font-weight:600;">
          ${formatRelative(m.match_date)}
        </span>
      </div>
      <div class="team right away">
        ${escapeHtml(teamPt(m.team_away))} <span class="flag">${flag(m.team_away)}</span>
      </div>
      <div class="match-tail">${m.group_name ? 'Grupo ' + m.group_name : stageLabel(m.stage)}</div>
    </div>
  `;
}

function renderQuickLinks() {
  return `
    <div class="section-head" style="margin-top:48px;">
      <h3>Acesso rápido</h3>
    </div>
    <div class="kpis">
      <a class="kpi card hov" href="palpites-grupos.html" style="text-decoration:none;">
        <div class="kpi-label">📊 Palpites</div>
        <div class="kpi-num" style="font-size:18px; font-weight:700;">Fazer palpites</div>
        <div class="kpi-sub">Grupos e mata-mata</div>
      </a>
      <a class="kpi card hov" href="ranking.html" style="text-decoration:none;">
        <div class="kpi-label">🏆 Ranking</div>
        <div class="kpi-num" style="font-size:18px; font-weight:700;">Ver classificação</div>
        <div class="kpi-sub">${stats.paid_users || 0} jogadores</div>
      </a>
      <a class="kpi card hov" href="campeao-artilheiro.html" style="text-decoration:none;">
        <div class="kpi-label">⭐ Campeão & Artilheiro</div>
        <div class="kpi-num" style="font-size:18px; font-weight:700;">Escolher</div>
        <div class="kpi-sub">Até 10/jun 23:59</div>
      </a>
    </div>
  `;
}

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed (no session)');
  profile = auth.profile;

  const [statsRes, todayRes, upcomingRes, myStandingRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    matchesToday(),
    matchesUpcoming(5),
    supabase.from('v_leaderboard').select('*').eq('user_id', profile.id).maybeSingle(),
  ]);

  stats = statsRes.data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0, total_pot: 0 };
  todayMatches = todayRes.data ?? [];
  upcomingMatches = upcomingRes.data ?? [];
  myStanding = myStandingRes.data;

  const pageBody = await renderShell({ active: 'inicio', profile, stats });
  pageBody.innerHTML = renderInicio();
  pageBody.classList.add('fade-up');
} catch (err) {
  console.error('[inicio] FATAL:', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:#fff; font-family:sans-serif;">
      <h1 style="color:#f15e6c">⚠️ Erro ao carregar Início</h1>
      <pre style="background:#000; padding:16px; border-radius:8px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:#f15e6c;">${err.stack || err.message || err}</pre>
      <p style="margin-top:20px;"><a href="login.html" style="color:#1DB954">← Voltar ao login</a></p>
    </div>
  `;
}

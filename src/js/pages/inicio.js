import { requireAuth } from '../auth.js';
import { renderShell, iconChart, iconClipboard, iconTrophy } from '../sidebar.js';
import { supabase } from '../supabase.js';
import { loadLockAlerts } from '../lock-alerts.js';
import {
  flag, escapeHtml, greeting, firstName, daysToKickoffLabel,
  formatBrDate, formatTime, lockCountdownLabel, stageLabel, isLive,
  teamPt, groundShort,
} from '../util.js';

// Estado da página
let profile, stats, todayMatches, upcomingMatches, myStanding, lockAlerts;
let myPosition = null;   // posição no ranking (1-based); null antes de haver jogos
let totalPlayers = 0;    // jogadores no ranking (denominador da posição)

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
    ${renderLockBanner()}

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

// Banner de alerta: jogos pendentes (sem palpite) perto do bloqueio.
// Vermelho + pulso quando há algo travando em <48h; âmbar quando só <1 semana.
// Some por completo quando não há nada pendente na janela.
function renderLockBanner() {
  const a = lockAlerts;
  if (!a || a.total === 0) return '';

  const urgent = a.urgent > 0;
  const theme = urgent ? 'urgent' : 'soon';
  const n = a.total;
  const headline = urgent
    ? `${a.urgent} ${a.urgent === 1 ? 'jogo trava' : 'jogos travam'} em menos de 48h`
    : `${n} ${n === 1 ? 'jogo trava' : 'jogos travam'} esta semana`;

  // Barra que esvazia: quanto resta da janela (48h se urgente, 1 semana se não)
  // até o PRÓXIMO prazo. Quase vazia = aperto.
  const windowMs = urgent ? 48 * 3600000 : 7 * 24 * 3600000;
  const nearest = a.matches[0];
  const remainPct = nearest ? Math.max(4, Math.min(100, (nearest.diff / windowMs) * 100)) : 100;

  const chips = a.matches.slice(0, 3).map(m => `
    <div class="la-game">
      <span class="la-game-teams">
        <span class="flag">${flag(m.team_home)}</span>
        <span class="la-vs">×</span>
        <span class="flag">${flag(m.team_away)}</span>
      </span>
      <span class="la-game-clock">${lockCountdownLabel(m.match_date)}</span>
    </div>
  `).join('');
  const more = n > 3 ? `<span class="la-more">+${n - 3} jogo${n - 3 > 1 ? 's' : ''}</span>` : '';

  const href = nearest?.stage === 'group' || !nearest?.stage
    ? 'palpites-grupos.html' : 'palpites-mata.html';

  return `
    <a class="lock-alert ${theme}" href="${href}">
      <span class="la-rail" aria-hidden="true"></span>
      <div class="la-icon" aria-hidden="true">${iconClockAlert()}</div>
      <div class="la-body">
        <div class="la-head">
          <span class="la-tag">${urgent ? 'Prazo apertando' : 'Fica de olho'}</span>
          <h3 class="la-headline">${headline}</h3>
        </div>
        <p class="la-sub">Você ainda não palpitou — depois do bloqueio não dá mais.</p>
        <div class="la-meter" aria-hidden="true"><span style="width:${remainPct}%"></span></div>
        <div class="la-games">${chips}${more}</div>
      </div>
      <span class="la-cta">Palpitar agora <span class="la-arrow" aria-hidden="true">→</span></span>
    </a>
  `;
}

function iconClockAlert() {
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>`;
}

function renderKpis() {
  const pointsDisplay = myStanding?.total_pts ?? 0;
  const exactsDisplay = myStanding?.exact_count ?? 0;
  const scorerPts = myStanding?.scorer_pts ?? 0;
  return `
    <div class="kpis">
      <div class="kpi green">
        <div class="kpi-label">Sua posição</div>
        <div class="kpi-num">${myPosition ? `${myPosition}º` : '—'}</div>
        <div class="kpi-sub">${myPosition
          ? `de ${totalPlayers} jogador${totalPlayers === 1 ? '' : 'es'}`
          : 'começa com os jogos'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Seus pontos</div>
        <div class="kpi-num">${pointsDisplay}</div>
        <div class="kpi-sub">${scorerPts ? `+${scorerPts} artilheiro` : 'sem jogos ainda'}</div>
      </div>
      <div class="kpi gold">
        <div class="kpi-label">Placares exatos</div>
        <div class="kpi-num">${exactsDisplay}</div>
        <div class="kpi-sub">seu maior acerto</div>
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
        <div class="empty-ic green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M5 4H3v2a3 3 0 0 0 3 3M19 4h2v2a3 3 0 0 1-3 3"/></svg></div>
        <h3>Copa encerrada</h3>
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
  // Card clicável → leva pra tela de palpite e rola/pisca o jogo (#jogo-<id>);
  // mata-mata abre a tela do mata.
  const href = m.group_name
    ? `palpites-grupos.html#jogo-${m.id}`
    : 'palpites-mata.html';
  return `
    <a class="match next" href="${href}"
       aria-label="Palpitar ${escapeHtml(teamPt(m.team_home))} x ${escapeHtml(teamPt(m.team_away))}">
      <div class="match-meta">
        <strong>${formatTime(m.match_date)}</strong>
        <span class="mm-sep">·</span>
        <span class="mm-ground">${escapeHtml(groundShort(m.ground))}</span>
        <span class="match-grp">${m.group_name ? 'Grupo ' + m.group_name : escapeHtml(stageLabel(m.stage))}</span>
      </div>
      <div class="team home">
        <span class="flag">${flag(m.team_home)}</span>
        <span class="team-name">${escapeHtml(teamPt(m.team_home))}</span>
      </div>
      <div class="match-cd">${lockCountdownLabel(m.match_date)}</div>
      <div class="team away">
        <span class="flag">${flag(m.team_away)}</span>
        <span class="team-name">${escapeHtml(teamPt(m.team_away))}</span>
      </div>
    </a>
  `;
}

function renderQuickLinks() {
  return `
    <div class="section-head" style="margin-top:48px;">
      <h3>Acesso rápido</h3>
    </div>
    <div class="kpis">
      <a class="kpi card hov" href="palpites-grupos.html" style="text-decoration:none;">
        <div class="kpi-label"><span class="kpi-ic">${iconClipboard()}</span>Palpites</div>
        <div class="kpi-num" style="font-size:18px; font-weight:700;">Fazer palpites</div>
        <div class="kpi-sub">Grupos e mata-mata</div>
      </a>
      <a class="kpi card hov" href="ranking.html" style="text-decoration:none;">
        <div class="kpi-label"><span class="kpi-ic">${iconChart()}</span>Ranking</div>
        <div class="kpi-num" style="font-size:18px; font-weight:700;">Ver classificação</div>
        <div class="kpi-sub">${stats.paid_users || 0} jogadores</div>
      </a>
      <a class="kpi card hov" href="campeao-artilheiro.html" style="text-decoration:none;">
        <div class="kpi-label"><span class="kpi-ic">${iconTrophy()}</span>Campeão &amp; Artilheiro</div>
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

  const [statsRes, todayRes, upcomingRes, leaderRes, alertsRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    matchesToday(),
    matchesUpcoming(5),
    supabase.from('v_leaderboard').select('*').order('total_pts', { ascending: false }),
    loadLockAlerts(profile.id),
  ]);

  stats = statsRes.data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0, total_pot: 0 };
  todayMatches = todayRes.data ?? [];
  upcomingMatches = upcomingRes.data ?? [];
  lockAlerts = alertsRes;

  // Posição derivada do ranking completo (mesma ordenação da página Ranking).
  const leaderboard = leaderRes.data ?? [];
  totalPlayers = leaderboard.length;
  myStanding = leaderboard.find(u => u.user_id === profile.id) ?? null;
  if (myStanding && stats.finished_matches > 0) {
    // Ranking de competição (1224): conta quantos têm estritamente mais pontos.
    const ahead = leaderboard.filter(u => (u.total_pts ?? 0) > (myStanding.total_pts ?? 0)).length;
    myPosition = ahead + 1;
  }

  const pageBody = await renderShell({ active: 'inicio', profile, stats, lockAlerts });
  pageBody.innerHTML = renderInicio();
  pageBody.classList.add('fade-up');
} catch (err) {
  console.error('[inicio] FATAL:', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:#fff; font-family:sans-serif;">
      <h1 style="color:#f15e6c">⚠️ Erro ao carregar Início</h1>
      <pre style="background:#000; padding:16px; border-radius:8px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:#f15e6c;">${err.stack || err.message || err}</pre>
      <p style="margin-top:20px;"><a href="login.html" style="color:#f4c430">← Voltar ao login</a></p>
    </div>
  `;
}

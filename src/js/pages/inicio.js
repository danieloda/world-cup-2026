import { requireAuth } from '../auth.js';
import { reportFatal } from '../error-reporter.js';
import { renderShell, iconChart, iconClipboard, iconTrophy } from '../sidebar.js';
import { KPI } from '../kpi-icons.js';
import { supabase } from '../supabase.js';
import { loadLockAlerts } from '../lock-alerts.js';
import {
  flag, escapeHtml, greeting, firstName, daysToKickoffLabel, brDayWindowUtc,
  formatBrDate, formatTime, lockCountdownLabel, stageLabel, isLive,
  teamPt, groundShort, heroMeta, slotShortLabel, loadTopScorers,
} from '../util.js';
import { isRealTeam } from '../bracket.js';
import { renderJourneyChart } from '../journey-chart.js';
import { renderJourneyDashboard, renderJourneyBets, renderJourneyProjection } from '../journey-dashboard.js';
import { loadProgression, demoProgression } from '../progression.js';
import { startAutoRefresh } from '../auto-refresh.js';

// Estado da página
let profile, stats, todayMatches, upcomingMatches, myStanding, lockAlerts;
let myPosition = null;   // posição no ranking (1-based); null antes de haver jogos
let totalPlayers = 0;    // jogadores no ranking (denominador da posição)
let leaderboardRows = []; // v_leaderboard completo (dashboard da jornada)

// ============================================================
// Queries
// ============================================================
async function matchesToday() {
  // "Hoje" = dia civil de BRASÍLIA (princípio de exibição do util.js), não o
  // dia do fuso do dispositivo — o heading "Hoje · formatBrDate()" já é BRT e
  // a lista precisa concordar com ele p/ usuário fora do Brasil.
  const { startIso, endIso } = brDayWindowUtc();
  return supabase
    .from('matches')
    .select('*')
    .gte('match_date', startIso)
    .lte('match_date', endIso)
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
      <div class="hero-meta">${heroMeta([
        `<b>${stats.finished_matches}/${stats.total_matches} jogos</b>`,
        `<b>${stats.pct_played ?? 0}%</b> da Copa disputada`,
        stats.paid_users ? `<b>${stats.paid_users}</b> jogadores no bolão` : null,
      ])}</div>
    </section>

    ${renderKpis()}

    ${renderNextMatch()}

    ${todayMatches.length > 0 ? renderTodaySection() : ''}

    ${renderJourneySection()}

    ${renderUpcomingSection()}

    ${renderQuickLinks()}
  `;
}

// Bloco em destaque: o próximo jogo a ser disputado + countdown ao vivo até o
// apito inicial + atalho pra palpitar (com scroll/flash via #jogo-<id>).
// Fase-dependente: some quando não há jogos futuros (copa encerrada).
function renderNextMatch() {
  const m = upcomingMatches[0];
  if (!m) return '';
  const href = m.group_name ? `palpites-grupos.html#jogo-${m.id}` : 'palpites-mata.html';
  const where = m.group_name ? 'Grupo ' + m.group_name : stageLabel(m.stage);
  return `
    <section class="next-hero">
      <div class="nh-head">
        <span class="nh-kicker">Próximo jogo</span>
        <span class="nh-when">${escapeHtml(formatBrDate(new Date(m.match_date)))} · ${formatTime(m.match_date)} · ${escapeHtml(where)}</span>
      </div>
      <div class="nh-match">
        <span class="nh-team"><span class="flag">${flag(m.team_home)}</span><span class="nh-name">${escapeHtml(teamPt(m.team_home))}</span></span>
        <span class="nh-x">×</span>
        <span class="nh-team"><span class="nh-name">${escapeHtml(teamPt(m.team_away))}</span><span class="flag">${flag(m.team_away)}</span></span>
      </div>
      <div class="countdown" data-deadline="${new Date(m.match_date).toISOString()}" aria-label="Tempo até o apito inicial">
        <div class="cd-u"><b data-cd="d">--</b><span>dias</span></div>
        <div class="cd-u"><b data-cd="h">--</b><span>hrs</span></div>
        <div class="cd-u"><b data-cd="m">--</b><span>min</span></div>
        <div class="cd-u"><b data-cd="s">--</b><span>seg</span></div>
      </div>
      <a class="btn btn-green nh-cta" href="${href}">Palpitar este jogo →</a>
    </section>
  `;
}

// Countdown ao vivo do bloco "próximo jogo" (atualiza a cada segundo).
function startCountdown() {
  const el = document.querySelector('.countdown[data-deadline]');
  if (!el) return;
  const target = new Date(el.dataset.deadline).getTime();
  const set = (k, v) => { const n = el.querySelector(`[data-cd="${k}"]`); if (n) n.textContent = String(v).padStart(2, '0'); };
  const tick = () => {
    const s = Math.max(0, Math.floor((target - Date.now()) / 1000));
    set('d', Math.floor(s / 86400));
    set('h', Math.floor((s % 86400) / 3600));
    set('m', Math.floor((s % 3600) / 60));
    set('s', s % 60);
  };
  tick();
  setInterval(tick, 1000);
}

// Lado de um confronto no chip do banner: bandeira quando o time já é real;
// rótulo da vaga (ex.: "2º A", "3º") quando é mata-mata ainda indefinido — aí
// não há bandeira e o fi-xx aparecia como quadrado branco quebrado.
function lockTeamMark(name) {
  return isRealTeam(name)
    ? `<span class="flag">${flag(name)}</span>`
    : `<span class="la-slot">${escapeHtml(slotShortLabel(name))}</span>`;
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
        ${lockTeamMark(m.team_home)}
        <span class="la-vs">×</span>
        ${lockTeamMark(m.team_away)}
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

// settings.value pode vir como string JSON (mesmo tryParse de ranking.js)
function tryParse(s) { try { return JSON.parse(s); } catch { return s; } }

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
        <div class="kpi-top"><span class="kpi-cap">${KPI.position}</span><span class="kpi-label">Sua posição</span></div>
        <div class="kpi-num">${myPosition ? `${myPosition}º` : '—'}</div>
        <div class="kpi-sub">${myPosition
          ? `de ${totalPlayers} jogador${totalPlayers === 1 ? '' : 'es'}`
          : 'começa com os jogos'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-top"><span class="kpi-cap">${KPI.points}</span><span class="kpi-label">Seus pontos</span>${scorerPts ? `<span class="kpi-delta up">+${scorerPts} ↗</span>` : ''}</div>
        <div class="kpi-num">${pointsDisplay}</div>
        <div class="kpi-sub">${scorerPts ? 'inclui o artilheiro' : 'sem jogos ainda'}</div>
      </div>
      <div class="kpi gold">
        <div class="kpi-top"><span class="kpi-cap">${KPI.exact}</span><span class="kpi-label">Placares exatos</span></div>
        <div class="kpi-num">${exactsDisplay}</div>
        <div class="kpi-sub">seu maior acerto</div>
      </div>
      <div class="kpi">
        <div class="kpi-top"><span class="kpi-cap">${KPI.cup}</span><span class="kpi-label">Copa disputada</span></div>
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
      <div class="mn-fix">
        <span class="team home"><span class="flag">${flag(m.team_home)}</span><span class="team-name">${escapeHtml(teamPt(m.team_home))}</span></span>
        <span class="mn-x">×</span>
        <span class="team away"><span class="flag">${flag(m.team_away)}</span><span class="team-name">${escapeHtml(teamPt(m.team_away))}</span></span>
      </div>
      <div class="match-cd">${lockCountdownLabel(m.match_date)}</div>
    </a>
  `;
}

// ============================================================
// Sua jornada — card pessoal de evolução no ranking
// ============================================================
// Três estados:
//  • sem jogos finalizados → prévia desfocada com CTA (mesmo padrão do
//    preview do gráfico no Ranking)
//  • com jogos + usuário no ranking → gráfico real (carrega pós-paint)
//  • usuário fora do ranking (não pago) → seção não aparece
function renderJourneySection() {
  const hasData = (stats.finished_matches ?? 0) > 0;
  if (hasData && !myStanding) return '';
  return `
    <section id="journeySection">
      <div class="section-head">
        <h3>Sua jornada</h3>
        <a class="see-all" href="ranking.html">Ver ranking completo →</a>
      </div>
      ${hasData
        ? `
        <div class="jd-layout">
          <div class="journey-card" id="journeyChart"><div class="rc-loading">Carregando sua jornada…</div></div>
          <aside class="jd-rail" id="jdRail" hidden></aside>
        </div>
        <div class="jd-bets" id="jdBets" hidden></div>
        <div class="jd-bets" id="jdProj" hidden></div>
        <div class="jd-dna" id="jdDna" hidden></div>`
        : `
        <div class="preview-wrap">
          <div class="preview-blurred" aria-hidden="true">
            <div class="journey-card" id="journeyPreview"></div>
          </div>
          <div class="preview-overlay">
            <span class="preview-badge">👀 Prévia</span>
            <h3>É assim que vai ficar</h3>
            <p>Assim que os jogos começarem, este card conta a <strong>sua história na Copa</strong> —
               melhor momento, arrancadas e tombos, dia a dia. Os dados acima são <strong>só de exemplo</strong>.</p>
            <a class="btn btn-green" href="palpites-grupos.html">Fazer meus palpites →</a>
          </div>
        </div>`}
    </section>
  `;
}

// Carrega o replay e desenha a jornada (ou a prévia demo). Qualquer falha
// derruba a seção inteira — o Início nunca quebra por causa do gráfico.
function mountJourney() {
  const section = document.getElementById('journeySection');
  if (!section) return;

  const previewMount = document.getElementById('journeyPreview');
  if (previewMount) {
    try {
      renderJourneyChart(previewMount, { ...demoProgression(), meId: 'demo-me' });
    } catch (err) {
      console.error('[inicio] prévia da jornada:', err);
      section.remove();
    }
    return;
  }

  const mount = document.getElementById('journeyChart');
  if (!mount) return;

  // Apostas vivas (F2) + o que vem por aí (F3): fetches leves em paralelo com a
  // progressão. Busca TODOS os jogos (F3 resolve o bracket) e os meus palpites.
  // O .catch garante que qualquer falha aqui degrada pra "fileira não aparece" —
  // nunca derruba o gráfico nem os outros widgets.
  const betsPromise = Promise.all([
    supabase.from('champion_picks').select('user_id, team'),
    supabase.from('top_scorer_picks')
      .select('player_id, players(full_name, team, api_player_id)')
      .eq('user_id', profile.id).maybeSingle(),
    supabase.from('matches').select('*').order('match_date'),
    supabase.from('settings').select('key, value'),
    loadTopScorers(),
    supabase.from('predictions')
      .select('match_id, pred_home, pred_away, pred_pen_winner')
      .eq('user_id', profile.id),
  ]).catch(err => { console.error('[inicio] apostas vivas:', err); return null; });

  loadProgression()
    .then(prog => {
      if (!prog) { section.remove(); return; }
      // Dashboard ANTES do gráfico: ele liga o .jd-on que estreita a coluna,
      // e o gráfico mede host.clientWidth no draw() — na ordem inversa o SVG
      // nasceria na largura cheia e ficaria reescalado até um resize. Falha
      // aqui não derruba nada (renderJourneyDashboard captura as próprias
      // exceções; no pior caso os containers só continuam escondidos).
      renderJourneyDashboard({
        railMount: document.getElementById('jdRail'),
        dnaMount: document.getElementById('jdDna'),
        series: prog.series,
        matches: prog.matches,
        // leaderboard da MESMA carga das séries — o fetch do load da página
        // pode estar defasado se um scoring rodou entre os dois
        leaderboard: prog.leaderboard ?? leaderboardRows,
        meId: profile.id,
        nextStage: upcomingMatches[0]?.stage ?? null,
        finishedMatches: stats.finished_matches ?? 0,
      });
      const ok = renderJourneyChart(mount, { ...prog, meId: profile.id });
      if (!ok) { section.remove(); return; }

      betsPromise.then(bets => {
        if (!bets) return;
        const [champRes, myScorerRes, matchesRes, settingsRes, feed, predsRes] = bets;
        const settings = Object.fromEntries((settingsRes.data ?? [])
          .map(r => [r.key, typeof r.value === 'string' ? tryParse(r.value) : r.value]));
        const sp = myScorerRes.data;
        const scorerPick = sp?.players ? {
          apiId: sp.players.api_player_id ?? null,
          name: sp.players.full_name ?? null,
          team: sp.players.team ?? null,
        } : null;
        const myChampionPick = (champRes.data ?? []).find(p => p.user_id === profile.id) ?? null;
        // matches falho → null p/ suprimir (não chutar "vivo" sem os jogos)
        const allMatches = matchesRes.error ? null : matchesRes.data ?? [];
        const koMatches = allMatches ? allMatches.filter(m => m.stage !== 'group') : null;
        const leaderboard = prog.leaderboard ?? leaderboardRows;
        const myStanding = leaderboard.find(u => u.user_id === profile.id);

        const betsMount = document.getElementById('jdBets');
        if (betsMount) renderJourneyBets({
          mount: betsMount,
          myChampionPick, allChampionPicks: champRes.data ?? [], scorerPick,
          scorers: feed.scorers,
          koMatches,
          leaderboard, meId: profile.id, settings,
          paidUsers: stats.paid_users,
          nextStage: upcomingMatches[0]?.stage ?? null,
        });

        // F3 — o que vem por aí
        const projMount = document.getElementById('jdProj');
        const nextMatch = upcomingMatches[0] ?? null;
        const predsByMatch = new Map((predsRes.data ?? []).map(p => [p.match_id, p]));
        if (projMount) renderJourneyProjection({
          mount: projMount,
          nextMatch,
          myPred: nextMatch ? predsByMatch.get(nextMatch.id) ?? null : null,
          scorerTeam: scorerPick?.team ?? null,
          allMatches,
          predsByMatch,
          guaranteed: myStanding?.total_pts ?? 0,
          myChampionTeam: myChampionPick?.team ?? null,
        });
      });
    })
    .catch(err => {
      console.error('[inicio] jornada:', err);
      section.remove();
    });
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
  leaderboardRows = leaderboard;
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
  startCountdown();  // ticker do bloco "próximo jogo"
  mountJourney();    // gráfico "Sua jornada" (assíncrono, não trava a página)
  startAutoRefresh(); // resultado lançado / jogo começando → recarrega (KPIs, jornada)
} catch (err) {
  console.error('[inicio] FATAL:', err);
  reportFatal('inicio', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:var(--text); font-family:'Figtree',system-ui,-apple-system,sans-serif;">
      <h1 style="color:var(--red)">⚠️ Erro ao carregar Início</h1>
      <pre style="background:#000; padding:16px; border-radius:8px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:var(--red);">${err.stack || err.message || err}</pre>
      <p style="margin-top:20px;"><a href="login.html" style="color:var(--accent)">← Voltar ao login</a></p>
    </div>
  `;
}

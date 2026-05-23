import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, teamPt, computeStandings,
  attachTeamTooltips, loadRecentMatches,
} from '../util.js';

// ============================================================
// Estado
// ============================================================
let profile, stats;
let allGroupMatches = [];        // 72 group-stage matches
let predsByMatch = new Map();    // match_id -> prediction
let mode = 'real';               // 'real' | 'sim'
const GROUPS = ['A','B','C','D','E','F','G','H','I','J','K','L'];

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  await loadData();

  // Auto-detect mode: se não há jogos finalizados, abre em 'sim'
  const anyFinished = allGroupMatches.some(m => m.finished);
  const anyPredicted = predsByMatch.size > 0;
  mode = anyFinished ? 'real' : (anyPredicted ? 'sim' : 'real');

  const pageBody = await renderShell({ active: 'grupos', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');

  attachEventListeners();

  const recentByTeam = await loadRecentMatches();
  attachTeamTooltips(recentByTeam);
} catch (err) {
  console.error('[grupos] FATAL:', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:#fff; font-family:sans-serif;">
      <h1 style="color:#f15e6c">⚠️ Erro ao carregar Grupos</h1>
      <pre style="background:#000; padding:16px; border-radius:8px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:#f15e6c;">${err.stack || err.message || err}</pre>
      <p style="margin-top:20px;"><a href="inicio.html" style="color:#f4c430">← Voltar ao Início</a></p>
    </div>
  `;
}

// ============================================================
// Data
// ============================================================
async function loadData() {
  const [statsRes, matchesRes, predsRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    supabase.from('matches').select('*').eq('stage', 'group').order('match_date'),
    supabase.from('predictions').select('*').eq('user_id', profile.id),
  ]);

  if (matchesRes.error) throw matchesRes.error;
  if (predsRes.error)   throw predsRes.error;

  stats = statsRes.data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0 };
  allGroupMatches = matchesRes.data ?? [];
  predsByMatch = new Map((predsRes.data ?? []).map(p => [p.match_id, p]));
}

// ============================================================
// Render
// ============================================================
function renderPage() {
  const totalFinished = allGroupMatches.filter(m => m.finished).length;
  const totalPredicted = allGroupMatches.filter(m => predsByMatch.has(m.id)).length;

  return `
    <section class="hero">
      <div class="hero-kicker">Fase de grupos</div>
      <h1 class="hero-title">Classificação</h1>
      <div class="hero-meta">
        <b>12 grupos</b><span class="sep"></span>
        48 seleções<span class="sep"></span>
        2 melhores + 8 melhores 3ºs avançam
      </div>
    </section>

    <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin-bottom: 24px;">
      <div class="toggle" id="modeToggle">
        <button class="${mode === 'real' ? 'active' : ''}" data-mode="real">
          Real (oficial)
        </button>
        <button class="${mode === 'sim' ? 'active' : ''}" data-mode="sim">
          Minha simulação
        </button>
      </div>
      <span id="modeInfo" style="font-size:11px; color: var(--text-mute);">
        ${mode === 'real'
          ? `${totalFinished}/72 jogos finalizados`
          : `Baseado em ${totalPredicted}/72 palpites seus`}
      </span>
    </div>

    <div class="note" style="margin-bottom:20px; padding:12px 16px; background:var(--card); border-left:3px solid var(--green); border-radius:0 6px 6px 0; font-size:12px; color:var(--text-dim);">
      <strong style="color:var(--green);">Legenda:</strong>
      <span style="color:var(--green); font-weight:700;">verde</span> = classificado (1º e 2º) ·
      <span style="color:var(--medal-bronze); font-weight:700;">bronze</span> = candidato a 3º melhor ·
      cinza = eliminado.
      <strong style="color:var(--text);">Critério:</strong> PTS → SG → GP.
    </div>

    <div class="groups-grid" id="groupsGrid">
      ${GROUPS.map(renderGroupCard).join('')}
    </div>
  `;
}

function renderGroupCard(g) {
  const matches = allGroupMatches.filter(m => m.group_name === g);
  const finishedCount = matches.filter(m => m.finished).length;
  const predictedCount = matches.filter(m => predsByMatch.has(m.id)).length;

  const standings = computeStandings(matches, mode, predsByMatch);

  // Status text (right of group head)
  const statusText = mode === 'real'
    ? `${finishedCount}/6 jogos`
    : `${predictedCount}/6 palpitados`;

  return `
    <div class="group-card">
      <div class="group-head">
        <div class="group-name">Grupo ${g}</div>
        <div class="group-stage-info">${statusText}</div>
      </div>
      <table class="group-table">
        <thead>
          <tr>
            <th class="left">Time</th>
            <th>J</th><th>V</th><th>E</th><th>D</th>
            <th>SG</th><th>PTS</th>
          </tr>
        </thead>
        <tbody>
          ${renderStandingsRows(standings, matches)}
        </tbody>
      </table>
    </div>
  `;
}

function renderStandingsRows(standings, matches) {
  // Se nenhum jogo finalizado/palpitado, mostra times sem stats
  if (standings.length === 0) {
    // Pega os 4 times únicos das partidas
    const teams = new Set();
    for (const m of matches) {
      teams.add(m.team_home);
      teams.add(m.team_away);
    }
    return [...teams].map((team, i) => `
      <tr class="out">
        <td class="team-cell">
          <span class="position">${i+1}</span>
          <span class="flag">${flag(team)}</span>
          <span class="team-name" data-team="${escapeHtml(team)}">${escapeHtml(teamPt(team))}</span>
        </td>
        <td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td class="pts">0</td>
      </tr>
    `).join('');
  }

  return standings.map((s, idx) => {
    const pos = idx + 1;
    const rowClass = pos <= 2 ? 'qualified' : (pos === 3 ? 'third' : 'out');
    const sgStr = s.sg > 0 ? `+${s.sg}` : s.sg;
    return `
      <tr class="${rowClass}">
        <td class="team-cell">
          <span class="position">${pos}</span>
          <span class="flag">${flag(s.team)}</span>
          <span class="team-name" data-team="${escapeHtml(s.team)}">${escapeHtml(teamPt(s.team))}</span>
        </td>
        <td>${s.j}</td>
        <td>${s.v}</td>
        <td>${s.e}</td>
        <td>${s.d}</td>
        <td>${sgStr}</td>
        <td class="pts">${s.pts}</td>
      </tr>
    `;
  }).join('');
}

// ============================================================
// Eventos
// ============================================================
function attachEventListeners() {
  document.getElementById('modeToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    const newMode = btn.dataset.mode;
    if (newMode === mode) return;
    mode = newMode;
    rerenderGroups();
  });
}

function rerenderGroups() {
  // Re-render toggle (estado active)
  document.querySelectorAll('#modeToggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });

  // Re-render info text
  const totalFinished = allGroupMatches.filter(m => m.finished).length;
  const totalPredicted = allGroupMatches.filter(m => predsByMatch.has(m.id)).length;
  document.getElementById('modeInfo').textContent = mode === 'real'
    ? `${totalFinished}/72 jogos finalizados`
    : `Baseado em ${totalPredicted}/72 palpites seus`;

  // Re-render cards
  document.getElementById('groupsGrid').innerHTML = GROUPS.map(renderGroupCard).join('');
}

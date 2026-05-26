import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, teamPt, computeStandings,
  attachTeamTooltips, loadRecentMatches,
} from '../util.js';
import { fifaRank } from '../fifa-rank.js';

// ============================================================
// Estado
// ============================================================
let profile, stats;
let allGroupMatches = [];        // 72 group matches
let predsByMatch = new Map();    // match_id -> prediction
let mode = 'real';               // 'real' | 'sim'
const GROUPS = ['A','B','C','D','E','F','G','H','I','J','K','L'];
const ADVANCE_COUNT = 8;         // 8 melhores 3ºs avançam

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  await loadData();

  // Auto-detect mode (mesma lógica de grupos)
  const anyFinished = allGroupMatches.some(m => m.finished);
  const anyPredicted = predsByMatch.size > 0;
  mode = anyFinished ? 'real' : (anyPredicted ? 'sim' : 'real');

  const pageBody = await renderShell({ active: 'terceiros', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');

  attachEventListeners();

  const recentByTeam = await loadRecentMatches();
  attachTeamTooltips(recentByTeam);
} catch (err) {
  console.error('[terceiros] FATAL:', err);
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
// Lógica: extrair os 12 terceiros
// ============================================================
/**
 * Retorna lista dos 3ºs colocados de todos os grupos, ordenados.
 * Cada item: { team, group, j, v, e, d, gp, gc, sg, pts, complete }
 *   complete: true se o grupo está completo no modo atual
 */
function computeThirds() {
  const thirds = [];
  for (const g of GROUPS) {
    const groupMatches = allGroupMatches.filter(m => m.group_name === g);
    const standings = computeStandings(groupMatches, mode, predsByMatch);
    const third = standings[2];

    // No modo real, só conta se TODOS os 6 jogos do grupo terminaram
    // No modo sim, só conta se TODOS os 6 jogos foram palpitados
    let complete;
    if (mode === 'real') {
      complete = groupMatches.every(m => m.finished);
    } else {
      complete = groupMatches.every(m => predsByMatch.has(m.id));
    }

    if (third && complete) {
      thirds.push({ ...third, group: g, complete: true });
    } else if (third) {
      // Parcial — mostra mas marca incompleto
      thirds.push({ ...third, group: g, complete: false });
    } else {
      // Nenhum dado ainda — placeholder
      thirds.push({ team: null, group: g, complete: false });
    }
  }

  // Ordenar: completos primeiro, depois por PTS → SG → GP → FIFA rank (oficial)
  return thirds.sort((x, y) => {
    if (x.complete !== y.complete) return x.complete ? -1 : 1;
    if (!x.complete && !y.complete) return 0;
    return (y.pts ?? 0) - (x.pts ?? 0)
        || (y.sg  ?? 0) - (x.sg  ?? 0)
        || (y.gp  ?? 0) - (x.gp  ?? 0)
        || fifaRank(x.team) - fifaRank(y.team);
  });
}

// ============================================================
// Render
// ============================================================
function renderPage() {
  const thirds = computeThirds();
  const completeCount = thirds.filter(t => t.complete).length;

  return `
    <section class="hero">
      <div class="hero-kicker">Quais 3ºs colocados passam?</div>
      <h1 class="hero-title">Melhores 3ºs</h1>
      <div class="hero-meta">
        <b>${ADVANCE_COUNT} de 12</b> avançam aos 32-avos<span class="sep"></span>
        Critério: PTS → SG → GP → Ranking FIFA
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
          ? `${completeCount}/12 grupos finalizados`
          : `Baseado em ${completeCount}/12 grupos palpitados`}
      </span>
    </div>

    <div class="note" style="margin-bottom:20px; padding:12px 16px; background:var(--card); border-left:3px solid var(--green); border-radius:0 6px 6px 0; font-size:12px; color:var(--text-dim);">
      <span style="color:#1DB954; font-weight:700;">● Verde</span> = avança aos 32-avos ·
      <span style="color:var(--text-mute);">● Cinza</span> = eliminado
      <br><span style="color:var(--text-mute);">8 de 12 passam · Desempate: Pontos → Saldo → Gols pró → Ranking FIFA</span>
    </div>

    ${completeCount === 0
      ? renderEmpty()
      : `<div class="thirds-wrap">${renderTable(thirds)}</div>`}
  `;
}

function renderEmpty() {
  return `
    <div class="empty">
      <h3>${mode === 'real' ? 'Nenhum grupo finalizado' : 'Nenhum grupo palpitado completamente'}</h3>
      <p>${mode === 'real'
        ? 'Os 3ºs lugares aparecem aqui conforme cada grupo termina.'
        : 'Palpite todos os 6 jogos de pelo menos 1 grupo para ver a projeção.'}</p>
      ${mode === 'sim'
        ? '<a class="btn btn-green" href="palpites-grupos.html">Ir para palpites</a>'
        : '<a class="btn btn-ghost" href="grupos.html">Ver grupos</a>'}
    </div>
  `;
}

function renderTable(thirds) {
  return `
    <table class="thirds-table">
      <thead>
        <tr>
          <th class="left">#</th>
          <th class="left">Seleção</th>
          <th class="left">Grupo</th>
          <th>J</th><th>V</th><th>E</th><th>D</th>
          <th>GP</th><th>GC</th><th>SG</th><th>PTS</th>
        </tr>
      </thead>
      <tbody>
        ${renderRows(thirds)}
      </tbody>
    </table>
  `;
}

function renderRows(thirds) {
  const rows = [];
  let dividerInserted = false;

  thirds.forEach((t, idx) => {
    const rank = idx + 1;
    const isOut = rank > ADVANCE_COUNT;

    // Inserir linha de corte antes do primeiro eliminado
    if (isOut && !dividerInserted) {
      rows.push(`
        <tr class="divider">
          <td colspan="11">— linha de corte · ${ADVANCE_COUNT} avançam · 4 eliminados —</td>
        </tr>
      `);
      dividerInserted = true;
    }

    rows.push(renderRow(t, rank, isOut));
  });

  return rows.join('');
}

function renderRow(t, rank, isOut) {
  const rowClass = t.complete ? (isOut ? 'out' : 'adv') : 'out';

  if (!t.team) {
    // Placeholder: sem dados ainda
    return `
      <tr class="out">
        <td class="left"><span class="rank">${rank}</span></td>
        <td class="left" style="color:var(--text-mute); font-style:italic;">aguardando…</td>
        <td class="left"><span class="group-badge">${t.group}</span></td>
        <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
      </tr>
    `;
  }

  const sgStr = t.sg > 0 ? `+${t.sg}` : t.sg;
  return `
    <tr class="${rowClass}">
      <td class="left"><span class="rank">${rank}</span></td>
      <td class="left">
        <div class="team-cell">
          <span class="flag">${flag(t.team)}</span>
          <span class="team-name" data-team="${escapeHtml(t.team)}">${escapeHtml(teamPt(t.team))}</span>
        </div>
      </td>
      <td class="left"><span class="group-badge">${t.group}</span></td>
      <td>${t.j}</td>
      <td>${t.v}</td>
      <td>${t.e}</td>
      <td>${t.d}</td>
      <td>${t.gp}</td>
      <td>${t.gc}</td>
      <td>${sgStr}</td>
      <td>${t.pts}</td>
    </tr>
  `;
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

    // Re-render full page (toggle + table)
    const pageBody = document.getElementById('pageBody');
    if (pageBody) {
      pageBody.innerHTML = renderPage();
      attachEventListeners();
    }
  });
}

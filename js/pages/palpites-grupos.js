import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, formatBrDate, formatTime, shortGround,
  isLocked, isLive, showToast,
} from '../util.js';

// ============================================================
// Estado da página
// ============================================================
let profile, stats;
let matches = [];                    // 72 group-stage matches, ordered by date
let predsByMatch = new Map();        // match_id -> prediction row
let activeGroup = 'all';             // 'all' | 'A'..'L'
const saveTimers = new Map();        // match_id -> setTimeout handle
const GROUPS = ['A','B','C','D','E','F','G','H','I','J','K','L'];

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  await loadData();

  const pageBody = await renderShell({ active: 'palpites-g', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');
  attachEventListeners();
} catch (err) {
  console.error('[palpites-grupos] FATAL:', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:#fff; font-family:sans-serif;">
      <h1 style="color:#f15e6c">⚠️ Erro ao carregar Palpites</h1>
      <pre style="background:#000; padding:16px; border-radius:8px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:#f15e6c;">${err.stack || err.message || err}</pre>
      <p style="margin-top:20px;"><a href="inicio.html" style="color:#1DB954">← Voltar ao Início</a></p>
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
  matches = matchesRes.data ?? [];
  predsByMatch = new Map((predsRes.data ?? []).map(p => [p.match_id, p]));
}

// ============================================================
// Render
// ============================================================
function renderPage() {
  const counts = computeCounts();
  return `
    <section class="hero">
      <div class="hero-kicker">Seus palpites</div>
      <h1 class="hero-title">Fase de Grupos</h1>
      <div class="hero-meta">
        <b>${matches.length} jogos</b><span class="sep"></span>
        <b>${counts.totalDone}</b> palpitados<span class="sep"></span>
        <b>${counts.totalRemaining}</b> faltando
      </div>
    </section>

    ${renderKpis(counts)}

    <div class="chips" id="chips">
      ${renderChip('all', 'Todos', counts.totalDone, matches.length)}
      ${GROUPS.map(g => renderChip(g, 'Grupo ' + g, counts.byGroup[g]?.done ?? 0, counts.byGroup[g]?.total ?? 0)).join('')}
    </div>

    <div id="matchesList">
      ${renderMatchesList()}
    </div>

    <div class="note" style="margin-top:36px; padding:14px 18px; background:var(--card); border-left:3px solid var(--gold); border-radius:0 6px 6px 0; font-size:12px; color:var(--text-dim);">
      <strong style="color:var(--gold);">Como funciona:</strong>
      Cada palpite trava automaticamente no apito inicial do jogo.
      Salva sozinho conforme você digita.
      Pontuação: <b>placar exato = 5pts</b> · vencedor + saldo = 3pts · só vencedor = 2pts · gols de um lado = 1pt.
    </div>
  `;
}

function renderKpis(counts) {
  const pctDone = matches.length ? Math.round(counts.totalDone / matches.length * 100) : 0;
  return `
    <div class="kpis">
      <div class="kpi green">
        <div class="kpi-label">Palpitados</div>
        <div class="kpi-num">${counts.totalDone}<small>/${matches.length}</small></div>
        <div class="progress-bar-inline"><span style="width:${pctDone}%"></span></div>
      </div>
      <div class="kpi red">
        <div class="kpi-label">Faltando</div>
        <div class="kpi-num">${counts.totalRemaining}</div>
        <div class="kpi-sub">${counts.totalRemaining === 0 ? 'tudo pronto ✓' : 'palpites pendentes'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Travados</div>
        <div class="kpi-num">${counts.totalLocked}</div>
        <div class="kpi-sub">jogos já iniciados</div>
      </div>
      <div class="kpi gold">
        <div class="kpi-label">Pontos ganhos</div>
        <div class="kpi-num">${counts.totalPoints}</div>
        <div class="kpi-sub">${counts.totalLocked === 0 ? 'aguardando jogos' : 'na fase de grupos'}</div>
      </div>
    </div>
  `;
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

function renderMatchesList() {
  const filtered = activeGroup === 'all'
    ? matches
    : matches.filter(m => m.group_name === activeGroup);

  if (filtered.length === 0) {
    return `<div class="empty"><h3>Nenhum jogo</h3><p>Sem jogos para o filtro selecionado.</p></div>`;
  }

  // Group by ISO date (YYYY-MM-DD)
  const byDate = new Map();
  for (const m of filtered) {
    const key = new Date(m.match_date).toISOString().slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(m);
  }

  return [...byDate.entries()].map(([dateKey, list]) => {
    const d = new Date(dateKey + 'T12:00:00');
    return `
      <div class="date-head">
        <h4>${formatBrDate(d)}</h4>
        <div class="sub">${list.length} jogo${list.length > 1 ? 's' : ''}</div>
      </div>
      ${list.map(renderMatchRow).join('')}
    `;
  }).join('');
}

function renderMatchRow(m) {
  const pred = predsByMatch.get(m.id);
  const locked = isLocked(m);
  const live = isLive(m);
  const homeVal = pred?.pred_home ?? '';
  const awayVal = pred?.pred_away ?? '';

  const status = m.finished ? `<span class="pill done">Finalizado</span>`
    : live ? `<span class="pill live">Ao vivo</span>`
    : locked ? `<span class="pill locked">Travado</span>`
    : `<span class="pill open">${formatTime(m.match_date)}</span>`;

  const pointsBadge = pred?.points_earned != null
    ? `<div style="color:${pred.points_earned > 0 ? 'var(--green)' : 'var(--text-mute)'}; font-weight:800; font-size:13px; margin-top:4px;">
         ${pred.points_earned > 0 ? '+' : ''}${pred.points_earned} pts
       </div>`
    : '';

  const actualScore = m.finished
    ? `<div style="color:var(--text-mute); font-size:11px; margin-top:6px;">
         real: <b style="color:var(--text)">${m.actual_home} — ${m.actual_away}</b>
       </div>`
    : '';

  return `
    <div class="match ${locked ? 'locked' : ''}" data-match-id="${m.id}">
      <div class="match-when">
        <strong>${formatTime(m.match_date)}</strong>
        ${escapeHtml(shortGround(m.ground))}
      </div>
      <div class="team home">
        <span class="flag">${flag(m.team_home)}</span> ${escapeHtml(m.team_home)}
      </div>
      <div class="score-cell">
        <input class="score-input" type="number" min="0" max="20" inputmode="numeric"
               data-match="${m.id}" data-side="home"
               value="${homeVal}" ${locked ? 'disabled' : ''}>
        <span class="score-sep">–</span>
        <input class="score-input" type="number" min="0" max="20" inputmode="numeric"
               data-match="${m.id}" data-side="away"
               value="${awayVal}" ${locked ? 'disabled' : ''}>
      </div>
      <div class="team right away">
        ${escapeHtml(m.team_away)} <span class="flag">${flag(m.team_away)}</span>
      </div>
      <div class="match-tail">
        ${status}
        ${actualScore}
        ${pointsBadge}
      </div>
    </div>
  `;
}

function computeCounts() {
  const byGroup = {};
  for (const g of GROUPS) byGroup[g] = { total: 0, done: 0 };

  let totalDone = 0, totalLocked = 0, totalPoints = 0;
  for (const m of matches) {
    if (m.group_name && byGroup[m.group_name]) byGroup[m.group_name].total++;
    const p = predsByMatch.get(m.id);
    if (p) {
      totalDone++;
      if (m.group_name && byGroup[m.group_name]) byGroup[m.group_name].done++;
      if (typeof p.points_earned === 'number') totalPoints += p.points_earned;
    }
    if (isLocked(m)) totalLocked++;
  }

  return {
    byGroup,
    totalDone,
    totalRemaining: matches.length - totalDone,
    totalLocked,
    totalPoints,
  };
}

// ============================================================
// Eventos
// ============================================================
function attachEventListeners() {
  // Chips de filtro
  document.getElementById('chips').addEventListener('click', e => {
    const btn = e.target.closest('.chip[data-group]');
    if (!btn) return;
    activeGroup = btn.dataset.group;
    rerenderChipsAndList();
  });

  // Inputs de placar
  document.getElementById('matchesList').addEventListener('input', e => {
    const input = e.target.closest('.score-input[data-match]');
    if (!input) return;
    sanitizeInput(input);
    const matchId = parseInt(input.dataset.match, 10);
    scheduleSave(matchId);
  });
}

function sanitizeInput(input) {
  // Limita ao range válido (0..20). Permite vazio.
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

  // Ambos precisam estar preenchidos para salvar.
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

  // Atualiza estado local
  predsByMatch.set(matchId, data);
  row.classList.add('saved');
  showToast(`Salvo ${getTeamLabel(matchId)}`, 'success', 1200);
  updateKpisAndChips();
}

function getTeamLabel(matchId) {
  const m = matches.find(mm => mm.id === matchId);
  if (!m) return '';
  return `${m.team_home} × ${m.team_away}`;
}

function rerenderChipsAndList() {
  const counts = computeCounts();
  document.getElementById('chips').innerHTML =
    renderChip('all', 'Todos', counts.totalDone, matches.length) +
    GROUPS.map(g => renderChip(g, 'Grupo ' + g, counts.byGroup[g]?.done ?? 0, counts.byGroup[g]?.total ?? 0)).join('');
  document.getElementById('matchesList').innerHTML = renderMatchesList();
}

function updateKpisAndChips() {
  // Re-renderiza chips (contagem por grupo) e KPIs sem mexer no input atual.
  const counts = computeCounts();
  // Chips
  document.getElementById('chips').innerHTML =
    renderChip('all', 'Todos', counts.totalDone, matches.length) +
    GROUPS.map(g => renderChip(g, 'Grupo ' + g, counts.byGroup[g]?.done ?? 0, counts.byGroup[g]?.total ?? 0)).join('');
  // KPIs (procura container existente e substitui)
  const old = document.querySelector('.kpis');
  if (old) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderKpis(counts);
    old.replaceWith(wrapper.firstElementChild);
  }
}

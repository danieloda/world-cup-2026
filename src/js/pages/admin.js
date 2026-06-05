import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import {
  flag, flagEmoji, escapeHtml, teamPt, groundShort, formatTime, formatBrDate,
  stageLabel, roundLabelPt, showToast, localDateKey,
} from '../util.js';

// ============================================================
// Estado
// ============================================================
let profile, stats;
let activeTab = 'users';   // 'users' | 'results' | 'settings'
let resultsSubTab = 'pending';  // 'pending' | 'launched'
let resultsFilter = '';         // busca por time/sede na lista de resultados

// Data por aba (lazy-loaded)
const cache = {
  users: null,
  predictions_count: null, // Map<user_id, count>
  matches: null,
  players: null,
  player_goals: null,
  settings: null,
};

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth({ adminOnly: true });
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  const { data: statsData } = await supabase.from('v_pool_stats').select('*').single();
  stats = statsData ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0, total_pot: 0 };

  const pageBody = await renderShell({ active: 'admin', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');

  attachListeners();
  await loadTab('users');
} catch (err) {
  console.error('[admin] FATAL:', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:#fff; font-family:sans-serif;">
      <h1 style="color:#f15e6c">⚠️ Erro</h1>
      <pre style="background:#000; padding:16px; border-radius:8px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:#f15e6c;">${err.stack || err.message || err}</pre>
      <p style="margin-top:20px;"><a href="inicio.html" style="color:#f4c430">← Voltar</a></p>
    </div>
  `;
}

// ============================================================
// Render structure
// ============================================================
function renderPage() {
  return `
    <section class="hero">
      <div class="hero-kicker">Modo administrador</div>
      <h1 class="hero-title">Painel Admin</h1>
      <div class="hero-meta">
        <b id="kpiPaid">—</b> pagos
        <span class="sep"></span>
        <b id="kpiTotal">—</b> total
        <span class="sep"></span>
        <b id="kpiPot">—</b> no caixa
        <span class="sep"></span>
        <b>${stats.finished_matches}/${stats.total_matches}</b> jogos finalizados
      </div>
    </section>

    <div class="admin-tabs">
      <button class="admin-tab" data-tab="users" id="tab-users">
        Usuários <span class="ct" id="ct-users">—</span>
      </button>
      <button class="admin-tab" data-tab="results" id="tab-results">
        Resultados & Gols <span class="ct" id="ct-results">—</span>
      </button>
      <button class="admin-tab" data-tab="settings" id="tab-settings">
        Configurações
      </button>
    </div>

    <div id="tabBody"></div>

    <div class="note" style="margin-top:36px; padding:14px 18px; background:var(--card); border-left:3px solid var(--red); border-radius:0 6px 6px 0; font-size:12px; color:var(--text-dim);">
      <strong style="color:var(--red);">Atenção:</strong>
      Alterações no admin são imediatas e afetam todos os usuários. Para criar novo usuário,
      vá ao painel Supabase → Authentication → Add user. No primeiro login do usuário,
      o profile é auto-criado e aparece aqui.
    </div>
  `;
}

function attachListeners() {
  // Score inputs: atualiza linha quando user digita (para validar marcadores)
  document.addEventListener('input', async (e) => {
    const t = e.target;
    if (t.id === 'resultsSearch') {
      resultsFilter = t.value;
      document.getElementById('tabBody').innerHTML = await renderResultsTab();
      // re-render troca o input; refoca e põe o caret no fim
      const s = document.getElementById('resultsSearch');
      if (s) { s.focus(); const v = s.value; s.value = ''; s.value = v; }
      return;
    }
    if (t.id && (t.id.startsWith('rh_') || t.id.startsWith('ra_'))) {
      const matchId = parseInt(t.id.slice(3), 10);
      const m = cache.matches?.find(x => x.id === matchId);
      if (!m) return;
      const newVal = parseInt(t.value, 10);
      if (t.id.startsWith('rh_')) m.actual_home = isNaN(newVal) ? null : newVal;
      else                         m.actual_away = isNaN(newVal) ? null : newVal;
      rerenderResultRow(matchId);
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.flag-select')) {
      document.querySelectorAll('.flag-select-list').forEach(l => l.setAttribute('hidden', ''));
    }
  });

  document.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      const t = tabBtn.dataset.tab;
      if (t !== activeTab) await loadTab(t);
      return;
    }

    const action = e.target.closest('[data-action]');
    if (!action) return;
    const a = action.dataset.action;
    if (a === 'toggle-paid')   await togglePaid(action.dataset.id);
    if (a === 'toggle-admin')  await toggleAdmin(action.dataset.id);
    if (a === 'remove-user')   await removeUser(action.dataset.id, action.dataset.name);
    if (a === 'flag-select-toggle') {
      const targetId = action.dataset.target;
      const root = document.querySelector(`.flag-select[data-target="${targetId}"]`);
      const list = root?.querySelector('.flag-select-list');
      const willOpen = list && list.hasAttribute('hidden');
      document.querySelectorAll('.flag-select-list').forEach(l => l.setAttribute('hidden', ''));
      if (willOpen) list.removeAttribute('hidden');
      return;
    }
    if (a === 'flag-select-pick') {
      const targetId = action.dataset.target;
      const value = action.dataset.value;
      const display = action.dataset.display;
      const team = action.dataset.team;
      const position = action.dataset.position;
      const hidden = document.getElementById(targetId);
      const root = document.querySelector(`.flag-select[data-target="${targetId}"]`);
      const trigger = root?.querySelector('.flag-select-display');
      if (hidden) hidden.value = value;
      if (trigger) {
        const posBadge = position ? `<span class="pos-badge pos-${position}">${position}</span>` : '';
        trigger.innerHTML = `<span class="flag">${flag(team)}</span> ${posBadge} <span class="name">${display}</span>`;
      }
      root?.querySelector('.flag-select-list')?.setAttribute('hidden', '');
      return;
    }
    if (a === 'results-subtab') {
      resultsSubTab = action.dataset.sub;
      document.getElementById('tabBody').innerHTML = await renderResultsTab();
      return;
    }
    if (a === 'save-result')   await saveResult(action.dataset.matchId);
    if (a === 'clear-result')  await clearResult(action.dataset.matchId);
    if (a === 'set-pen')       setPenWinner(action.dataset.matchId, action.dataset.side);
    if (a === 'save-settings') await saveSettings();
    if (a === 'add-scorer')    await addScorer(action.dataset.matchId);
    if (a === 'remove-goal')   await removeGoal(action.dataset.goalId, action.dataset.matchId);
    if (a === 'load-players') {
      action.disabled = true;
      action.textContent = 'Carregando...';
      await loadPlayersForTeams(action.dataset.home, action.dataset.away);
      rerenderResultRow(parseInt(action.dataset.matchId, 10));
    }
  });
}

// ============================================================
// Tab switching
// ============================================================
async function loadTab(tab) {
  activeTab = tab;
  // Update tab UI
  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  const body = document.getElementById('tabBody');
  body.innerHTML = `<div class="loader"></div>`;

  if (tab === 'users')    body.innerHTML = await renderUsersTab();
  if (tab === 'results')  body.innerHTML = await renderResultsTab();
  if (tab === 'settings') body.innerHTML = await renderSettingsTab();
  updateGlobalKpis();
}

function updateGlobalKpis() {
  const users = cache.users ?? [];
  const paid = users.filter(u => u.paid).length;
  const total = users.length;
  const fee = cache.settings?.fee_amount ?? 100;
  const pot = paid * fee;
  document.getElementById('kpiPaid').textContent = paid;
  document.getElementById('kpiTotal').textContent = total;
  document.getElementById('kpiPot').textContent = `R$ ${pot.toLocaleString('pt-BR')}`;
  document.getElementById('ct-users').textContent = total;
  const unfinished = (cache.matches ?? []).filter(m => !m.finished).length;
  document.getElementById('ct-results').textContent = unfinished;
}

// ============================================================
// USERS TAB
// ============================================================
async function loadUsers() {
  // Progresso agregado no SERVIDOR (1 linha por usuário) — evita o teto de ~1000
  // linhas do PostgREST que truncava a contagem com muitos palpites (104 × N).
  const [usersRes, progRes] = await Promise.all([
    supabase.from('profiles').select('*').order('created_at'),
    supabase.rpc('admin_pred_progress'),
  ]);
  if (usersRes.error) throw usersRes.error;
  if (progRes.error) throw progRes.error;
  cache.users = usersRes.data;
  cache.pred_progress = new Map((progRes.data ?? []).map(r => [r.user_id, r]));

  // settings (for fee)
  if (!cache.settings) {
    const { data } = await supabase.from('settings').select('key, value');
    cache.settings = Object.fromEntries((data ?? []).map(r => [r.key, unwrap(r.value)]));
  }
}

async function renderUsersTab() {
  if (!cache.users) await loadUsers();

  const users = cache.users;
  const progress = cache.pred_progress ?? new Map();
  const fullCount = users.filter(u => (progress.get(u.id)?.total_count ?? 0) >= 104).length;

  return `
    <div class="kpis">
      <div class="kpi green">
        <div class="kpi-label">Pagos</div>
        <div class="kpi-num">${users.filter(u => u.paid).length}<small>/${users.length}</small></div>
      </div>
      <div class="kpi red">
        <div class="kpi-label">Pendentes</div>
        <div class="kpi-num">${users.filter(u => !u.paid).length}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Admins</div>
        <div class="kpi-num">${users.filter(u => u.is_admin).length}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Palpitaram tudo</div>
        <div class="kpi-num">${fullCount}<small>/${users.length}</small></div>
      </div>
      <div class="kpi gold">
        <div class="kpi-label">Caixa</div>
        <div class="kpi-num">R$ ${(users.filter(u => u.paid).length * (cache.settings?.fee_amount ?? 100)).toLocaleString('pt-BR')}</div>
      </div>
    </div>

    <table class="admin-table">
      <thead>
        <tr>
          <th>Nome</th>
          <th>Email</th>
          <th>Palpites</th>
          <th>Pago</th>
          <th>Admin</th>
          <th>Criado</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${users.map(u => {
          const pr = progress.get(u.id) ?? { total_count: 0, group_count: 0, ko_count: 0, has_champion: false, has_scorer: false };
          const count = pr.total_count ?? 0;
          const isMe = u.id === profile.id;
          const csBadges =
            `<span class="cs-mini ${pr.has_champion ? 'on' : ''}" title="Campeão ${pr.has_champion ? 'escolhido' : 'pendente'}">🏆</span>` +
            `<span class="cs-mini ${pr.has_scorer ? 'on' : ''}" title="Artilheiro ${pr.has_scorer ? 'escolhido' : 'pendente'}">⚽</span>`;
          return `
            <tr>
              <td><strong>${escapeHtml(u.full_name)}</strong>${isMe ? ' <small style="color:var(--accent);font-weight:800">VOCÊ</small>' : ''}</td>
              <td><span class="em-cell">${escapeHtml(u.email)}</span></td>
              <td>
                <span class="pill ${count >= 104 ? 'open' : count > 0 ? 'done' : 'locked'}" title="Grupos ${pr.group_count}/72 · Mata-mata ${pr.ko_count}/32">${count}/104</span>
                <div class="pred-breakdown">G ${pr.group_count}/72 · M ${pr.ko_count}/32 ${csBadges}</div>
              </td>
              <td>
                <button class="admin-action ${u.paid ? 'green-active' : ''}"
                        data-action="toggle-paid" data-id="${u.id}">
                  ${u.paid ? `✓ R$ ${cache.settings?.fee_amount ?? 100}` : 'Marcar pago'}
                </button>
              </td>
              <td>
                <button class="admin-action ${u.is_admin ? 'green-active' : ''}"
                        data-action="toggle-admin" data-id="${u.id}"
                        ${isMe ? 'disabled title="Não pode remover seu próprio admin"' : ''}>
                  ${u.is_admin ? '✓ Admin' : 'Promover'}
                </button>
              </td>
              <td><small style="color:var(--text-dim)">${shortDate(u.created_at)}</small></td>
              <td>
                ${isMe ? '' : `<button class="admin-action danger" data-action="remove-user" data-id="${u.id}" data-name="${escapeHtml(u.full_name)}">Remover</button>`}
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function togglePaid(id) {
  const user = cache.users.find(u => u.id === id);
  if (!user) return;
  const newPaid = !user.paid;
  const { error } = await supabase
    .from('profiles')
    .update({ paid: newPaid, paid_at: newPaid ? new Date().toISOString() : null })
    .eq('id', id);
  if (error) {
    showToast('Erro: ' + error.message, 'error', 3500);
    return;
  }
  user.paid = newPaid;
  user.paid_at = newPaid ? new Date().toISOString() : null;
  showToast(newPaid ? `${user.full_name} marcado como pago` : `${user.full_name} desmarcado`, 'success');
  if (activeTab === 'users') document.getElementById('tabBody').innerHTML = await renderUsersTab();
  updateGlobalKpis();
}

async function toggleAdmin(id) {
  const user = cache.users.find(u => u.id === id);
  if (!user) return;
  if (user.id === profile.id) {
    showToast('Não pode remover seu próprio admin', 'error', 2500);
    return;
  }
  const newAdmin = !user.is_admin;
  const { error } = await supabase
    .from('profiles')
    .update({ is_admin: newAdmin })
    .eq('id', id);
  if (error) {
    showToast('Erro: ' + error.message, 'error', 3500);
    return;
  }
  user.is_admin = newAdmin;
  showToast(newAdmin ? `${user.full_name} promovido a admin` : `${user.full_name} removido do admin`, 'success');
  if (activeTab === 'users') document.getElementById('tabBody').innerHTML = await renderUsersTab();
}

async function removeUser(id, name) {
  if (!confirm(`Remover ${name} permanentemente?\n\nIsso apaga TODOS os palpites dele.\nA conta de auth.users continua existindo no Supabase.\n\nContinuar?`)) return;
  const { error } = await supabase.from('profiles').delete().eq('id', id);
  if (error) {
    showToast('Erro: ' + error.message, 'error', 3500);
    return;
  }
  cache.users = cache.users.filter(u => u.id !== id);
  showToast(`${name} removido`, 'success');
  document.getElementById('tabBody').innerHTML = await renderUsersTab();
  updateGlobalKpis();
}

// ============================================================
// RESULTS TAB (com entrada de marcadores integrada)
// ============================================================
async function loadMatches() {
  const [matchesRes, goalsRes] = await Promise.all([
    supabase.from('matches').select('*').order('match_date'),
    supabase.from('player_goals').select('*, players(full_name, team)').order('created_at'),
  ]);
  if (matchesRes.error) throw matchesRes.error;
  if (goalsRes.error)   throw goalsRes.error;
  cache.matches = matchesRes.data;

  // Only keep player_goals for finished matches - prevents phantom scorers
  const finishedIds = new Set(cache.matches.filter(m => m.finished).map(m => m.id));
  cache.player_goals = (goalsRes.data ?? []).filter(g => finishedIds.has(g.match_id));

  cache.playersByTeam = {}; // Will be loaded on demand
}

// Alias: alguns times tem nomes diferentes entre matches e players
// (e.g. matches="USA", players="United States")
const TEAM_PLAYERS_ALIAS = {
  USA: 'United States',
  // Türkiye já está como 'Türkiye' em ambos players e matches (migration 018)
  Curaçao: 'Curacao',
  'Cape Verde': 'Cape Verde Islands',
  'Congo DR': 'DR Congo',
};

// Load players for specific teams (on demand)
async function loadPlayersForTeams(homeTeam, awayTeam) {
  const teams = [homeTeam, awayTeam].filter(Boolean);
  const missing = teams.filter(t => !cache.playersByTeam[t]);

  if (missing.length === 0) {
    return [...(cache.playersByTeam[homeTeam] || []), ...(cache.playersByTeam[awayTeam] || [])];
  }

  // Expande pra incluir aliases (busca tanto "USA" quanto "United States")
  const teamsToQuery = [...missing];
  for (const t of missing) {
    const alias = TEAM_PLAYERS_ALIAS[t];
    if (alias && !teamsToQuery.includes(alias)) teamsToQuery.push(alias);
  }

  const { data, error } = await supabase
    .from('players')
    .select('*')
    .in('team', teamsToQuery)
    .order('full_name');

  if (error) {
    console.error('[loadPlayersForTeams]', error);
    return [];
  }

  // Cache by team (mapeia players de alias pro nome do match)
  for (const team of missing) {
    const alias = TEAM_PLAYERS_ALIAS[team];
    cache.playersByTeam[team] = (data || []).filter(p => p.team === team || p.team === alias);
  }

  return [...(cache.playersByTeam[homeTeam] || []), ...(cache.playersByTeam[awayTeam] || [])];
}

async function renderResultsTab() {
  if (!cache.matches) await loadMatches();

  const matches = cache.matches;

  const pending = matches.filter(m => !m.finished);
  const launched = matches.filter(m => m.finished)
    .sort((a, b) => new Date(b.finished_at || b.match_date) - new Date(a.finished_at || a.match_date));

  let showing = resultsSubTab === 'pending' ? pending : launched;

  // Filtro de busca (time pt/raw ou sede). Com busca ativa, mostra TODOS os jogos
  // que casam (sem o cap de 60) — assim qualquer resultado antigo é alcançável p/ corrigir.
  const filter = resultsFilter.trim().toLowerCase();
  if (filter) {
    showing = showing.filter(m =>
      [m.team_home, m.team_away, teamPt(m.team_home), teamPt(m.team_away), m.ground]
        .some(v => (v || '').toLowerCase().includes(filter))
    );
  }
  const CAP = 60;
  const capped = !filter && showing.length > CAP;
  const visible = capped ? showing.slice(0, CAP) : showing;

  return `
    <div class="kpis">
      <div class="kpi green">
        <div class="kpi-label">Finalizados</div>
        <div class="kpi-num">${launched.length}<small>/${matches.length}</small></div>
      </div>
      <div class="kpi red">
        <div class="kpi-label">Pendentes</div>
        <div class="kpi-num">${pending.length}</div>
      </div>
      <div class="kpi gold">
        <div class="kpi-label">% Copa</div>
        <div class="kpi-num">${stats.pct_played ?? 0}<small>%</small></div>
      </div>
    </div>

    <div class="toggle" id="resultsSubTabs" style="margin-bottom:18px;">
      <button class="${resultsSubTab === 'pending' ? 'active' : ''}" data-action="results-subtab" data-sub="pending">
        Lançar (${pending.length})
      </button>
      <button class="${resultsSubTab === 'launched' ? 'active' : ''}" data-action="results-subtab" data-sub="launched">
        Lançados (${launched.length})
      </button>
    </div>

    ${resultsSubTab === 'pending' ? `
      <p style="color:var(--text-dim); margin-bottom:16px; font-size:13px;">
        ${pending.length === 0 ? 'Todos os jogos finalizados. 🎉' : `${pending.length} jogo${pending.length > 1 ? 's' : ''} pendente${pending.length > 1 ? 's' : ''}.`}
        Preencha os placares e clique <strong>Lançar</strong>. Pontos dos usuários são recalculados automaticamente.
      </p>
    ` : `
      <p style="color:var(--text-dim); margin-bottom:16px; font-size:13px;">
        Resultados já lançados. Edite o placar ou marcadores e clique <strong>Atualizar</strong> para corrigir inserções erradas. Use <strong>Limpar resultado</strong> para zerar.
      </p>
    `}

    <input id="resultsSearch" type="search" placeholder="🔎 Buscar por time ou sede…" autocomplete="off"
           value="${escapeHtml(resultsFilter)}"
           style="width:100%; margin-bottom:16px; padding:10px 14px; background:var(--card); border:1px solid var(--line); border-radius:8px; color:var(--text); font-size:14px;">

    ${groupMatchesByDate(visible).map(([dateKey, list]) => `
      <div class="date-head">
        <h4>${formatBrDate(new Date(dateKey + 'T12:00:00'))}</h4>
        <div class="sub">${list.length} jogo${list.length > 1 ? 's' : ''}</div>
      </div>
      ${list.map(renderResultRow).join('')}
    `).join('')}

    ${capped ? `<p style="color:var(--text-mute); font-size:12px; text-align:center; margin:20px 0;">Mostrando os ${CAP} mais recentes de ${showing.length}. Use a busca acima para achar os demais.</p>` : ''}
    ${showing.length === 0 ? `<p style="color:var(--text-mute); text-align:center; margin:40px 0; font-style:italic;">${filter ? 'Nenhum jogo casa com a busca.' : 'Nenhum jogo nesta aba.'}</p>` : ''}
  `;
}

function renderResultRow(m) {
  const isKO = m.stage !== 'group';
  const homeVal = m.actual_home ?? '';
  const awayVal = m.actual_away ?? '';
  const isDraw = m.actual_home != null && m.actual_home === m.actual_away;

  const scorers = (cache.player_goals ?? []).filter(g => g.match_id === m.id);
  const goalsAttributed = scorers.reduce((s, g) => s + g.goals, 0);
  const totalGoals = (parseInt(homeVal, 10) || 0) + (parseInt(awayVal, 10) || 0);
  const scoreFilled = homeVal !== '' && awayVal !== '';
  const goalsValid = scoreFilled && goalsAttributed === totalGoals;
  // Score basta para salvar; gols são opcionais (apenas pontuam top scorer).
  const canSave = scoreFilled && (!isKO || !isDraw || m.pen_winner);

  // Filtra jogadores que possam ter marcado (do home ou away team)
  const homePlayers = cache.playersByTeam?.[m.team_home] ?? [];
  const awayPlayers = cache.playersByTeam?.[m.team_away] ?? [];
  const eligible = [...homePlayers, ...awayPlayers];
  const already = new Set(scorers.map(s => s.player_id));
  const available = eligible.filter(p => !already.has(p.id));
  // Check if we've attempted to load (cache key exists), not just if players were found.
  // AMBOS os times precisam estar em cache — senão o dropdown renderiza só com o time
  // já cacheado e os jogadores do outro (recém-encontrado num jogo anterior) somem.
  const playersLoaded = cache.playersByTeam?.[m.team_home] !== undefined && cache.playersByTeam?.[m.team_away] !== undefined;

  return `
    <div class="result-row ${m.finished ? 'done' : ''}" data-match-id="${m.id}">
      <div class="result-row-top">
        <div class="when">
          <strong>${formatTime(m.match_date)}</strong>
          ${escapeHtml(groundShort(m.ground))}<br>
          <small>${escapeHtml(formatBrDateShort(new Date(m.match_date)))} · ${escapeHtml(roundLabelPt(m.round_label))}</small>
        </div>
        <div class="team-disp">
          <span class="flag">${flag(m.team_home)}</span>
          ${escapeHtml(teamPt(m.team_home))}
        </div>
        <div class="score-cell" style="justify-content:center;">
          <input class="score-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2"
                 id="rh_${m.id}" value="${homeVal}" placeholder="–">
          <span class="score-sep">–</span>
          <input class="score-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2"
                 id="ra_${m.id}" value="${awayVal}" placeholder="–">
        </div>
        <div class="team-disp right">
          ${escapeHtml(teamPt(m.team_away))}
          <span class="flag">${flag(m.team_away)}</span>
        </div>
        <div style="text-align:right;">
          ${isKO ? `
            <div style="font-size:10px; color:var(--text-mute); margin-bottom:4px; letter-spacing:.1em; text-transform:uppercase;">
              Vencedor pênaltis
            </div>
            <div class="pen-toggle">
              <button class="${m.pen_winner === 'home' ? 'active' : ''}" data-action="set-pen" data-match-id="${m.id}" data-side="home">CASA</button>
              <button class="${m.pen_winner == null ? 'active' : ''}" data-action="set-pen" data-match-id="${m.id}" data-side="">—</button>
              <button class="${m.pen_winner === 'away' ? 'active' : ''}" data-action="set-pen" data-match-id="${m.id}" data-side="away">FORA</button>
            </div>
          ` : ''}
        </div>
      </div>

      ${scoreFilled ? `
        <div class="scorers">
          <div class="scorers-head">
            <span>⚽ Marcadores</span>
            <span class="count ${goalsValid ? 'ok' : (scoreFilled ? 'warn' : '')}">
              ${goalsAttributed}/${scoreFilled ? totalGoals : '?'} gols atribuídos
              ${goalsValid ? '✓' : (scoreFilled ? '⚠' : '')}
            </span>
          </div>

          <div class="scorer-list">
            ${scorers.map(s => `
              <div class="scorer-row" data-goal-id="${s.id}">
                <span class="flag">${flag(s.players.team)}</span>
                <span class="name">
                  ${escapeHtml(s.players.full_name)}
                  <small>${escapeHtml(teamPt(s.players.team))}</small>
                </span>
                <span class="qty">${s.goals} ${s.goals === 1 ? 'gol' : 'gols'}</span>
                <button class="remove" data-action="remove-goal" data-goal-id="${s.id}" data-match-id="${m.id}" title="Remover">×</button>
              </div>
            `).join('')}
            ${scorers.length === 0 ? '<div style="font-size:12px; color:var(--text-mute); padding:6px 4px; font-style:italic;">Nenhum marcador atribuído ainda.</div>' : ''}
          </div>

          ${goalsAttributed < totalGoals ? (
            !playersLoaded ? `
              <div class="scorer-add">
                <button class="btn btn-dark btn-sm" data-action="load-players" data-match-id="${m.id}" data-home="${escapeHtml(m.team_home)}" data-away="${escapeHtml(m.team_away)}">
                  Carregar jogadores de ${escapeHtml(teamPt(m.team_home))} e ${escapeHtml(teamPt(m.team_away))}
                </button>
              </div>
            ` : (eligible.length === 0 ? `
              <div style="font-size:12px; color:var(--yellow); padding:6px 4px; font-style:italic;">
                ⚠ Nenhum jogador cadastrado para essas seleções. Pode salvar sem atribuir marcadores.
              </div>
            ` : (available.length > 0 ? `
              <div class="scorer-add">
                ${renderPlayerSelect(m.id, available, m.team_home, m.team_away)}
                <input id="addQty_${m.id}" type="number" min="1" max="${Math.max(1, totalGoals - goalsAttributed)}" value="1">
                <button class="btn btn-dark btn-sm" data-action="add-scorer" data-match-id="${m.id}">+ Adicionar</button>
              </div>
            ` : `
              <div style="font-size:12px; color:var(--text-mute); padding:6px 4px; font-style:italic;">
                Todos os jogadores já atribuídos.
              </div>
            `))
          ) : ''}
        </div>
      ` : ''}

      <div style="margin-top:12px; display:flex; justify-content:flex-end; gap:8px; align-items:center;">
        ${!canSave && scoreFilled ? `<span style="font-size:11px; color:var(--red); margin-right:8px;">${
          !goalsValid ? '⚠ atribua os marcadores' :
          (isKO && isDraw && !m.pen_winner) ? '⚠ defina vencedor dos pênaltis' : ''
        }</span>` : ''}
        ${m.finished ? `<button class="admin-action danger" data-action="clear-result" data-match-id="${m.id}">Limpar resultado</button>` : ''}
        <button class="btn btn-green btn-sm" data-action="save-result" data-match-id="${m.id}" ${!canSave ? 'disabled' : ''}>
          ${m.finished ? 'Atualizar' : 'Lançar'}
        </button>
      </div>
    </div>
  `;
}

// Position order for sorting (attackers first - more likely to score)
const POS_ORDER = { ATA: 0, MEI: 1, DEF: 2, GOL: 3 };

function renderPlayerSelect(matchId, players, homeTeam, awayTeam) {
  const isTeam = (playerTeam, target) =>
    playerTeam === target || TEAM_PLAYERS_ALIAS[target] === playerTeam || TEAM_PLAYERS_ALIAS[playerTeam] === target;

  const sortFn = (a, b) => {
    const posA = POS_ORDER[a.position] ?? 9;
    const posB = POS_ORDER[b.position] ?? 9;
    return posA - posB || a.full_name.localeCompare(b.full_name);
  };
  const homePlayers = players.filter(p => isTeam(p.team, homeTeam)).sort(sortFn);
  const awayPlayers = players.filter(p => isTeam(p.team, awayTeam)).sort(sortFn);

  const renderItem = p => `
    <div class="flag-select-item" data-action="flag-select-pick" data-target="addPlayer_${matchId}" data-value="${p.id}" data-display="${escapeHtml(p.full_name)}${p.shirt_number ? ' #' + p.shirt_number : ''}" data-team="${escapeHtml(p.team)}" data-position="${p.position || ''}">
      <span class="flag">${flag(p.team)}</span>
      ${p.position ? `<span class="pos-badge pos-${p.position}" title="${p.position}">${p.position}</span>` : '<span class="pos-badge"></span>'}
      <span class="name">${escapeHtml(p.full_name)}</span>
      <span class="meta">${p.shirt_number ? '#' + p.shirt_number : ''}</span>
    </div>
  `;

  const renderGroup = (team, list) => list.length === 0 ? '' : `
    <div class="flag-select-group">
      <div class="flag-select-group-label">
        <span class="flag">${flag(team)}</span>
        ${escapeHtml(teamPt(team))} <small>(${list.length})</small>
      </div>
      ${list.map(renderItem).join('')}
    </div>
  `;

  return `
    <div class="flag-select" data-target="addPlayer_${matchId}">
      <input type="hidden" id="addPlayer_${matchId}" value="">
      <button type="button" class="flag-select-trigger" data-action="flag-select-toggle" data-target="addPlayer_${matchId}">
        <span class="flag-select-display"><em>Selecione um jogador...</em></span>
        <span class="flag-select-caret">▾</span>
      </button>
      <div class="flag-select-list" hidden>
        ${renderGroup(homeTeam, homePlayers)}
        ${renderGroup(awayTeam, awayPlayers)}
      </div>
    </div>
  `;
}

function setPenWinner(matchId, side) {
  const m = cache.matches.find(x => x.id === Number(matchId));
  if (!m) return;
  m.pen_winner = side === '' ? null : side;
  // Re-render this row only
  rerenderResultRow(matchId);
}

function rerenderResultRow(matchId) {
  const row = document.querySelector(`.result-row[data-match-id="${matchId}"]`);
  if (!row) return;
  const m = cache.matches.find(x => x.id === Number(matchId));
  if (!m) return;

  // Preserva foco e caret position
  const focused = document.activeElement;
  let focusInfo = null;
  if (focused && row.contains(focused) && focused.id) {
    focusInfo = {
      id: focused.id,
      start: typeof focused.selectionStart === 'number' ? focused.selectionStart : null,
      end:   typeof focused.selectionEnd   === 'number' ? focused.selectionEnd   : null,
    };
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderResultRow(m);
  const newRow = wrapper.firstElementChild;
  row.replaceWith(newRow);

  if (focusInfo) {
    const el = document.getElementById(focusInfo.id);
    if (el) {
      el.focus();
      if (focusInfo.start != null && el.setSelectionRange) {
        try { el.setSelectionRange(focusInfo.start, focusInfo.end); } catch {}
      }
    }
  }
}

async function saveResult(matchId) {
  const id = parseInt(matchId, 10);
  const m = cache.matches.find(x => x.id === id);
  if (!m) return;
  const hEl = document.getElementById(`rh_${id}`);
  const aEl = document.getElementById(`ra_${id}`);
  const h = parseInt(hEl.value, 10);
  const a = parseInt(aEl.value, 10);
  if (isNaN(h) || isNaN(a)) {
    showToast('Preencha ambos os placares', 'error', 2500);
    return;
  }

  // BLOCKER: nao permitir salvar KO se time ainda eh slot (W##, 1A, 3A/B/C/D/F)
  const isSlot = (s) => !s || /^[0-9WL]/.test(s) || s.includes('/');
  if (isSlot(m.team_home) || isSlot(m.team_away)) {
    showToast(`Aguarde os times serem resolvidos. Atual: ${m.team_home} vs ${m.team_away}`, 'error', 4000);
    return;
  }

  const isKO = m.stage !== 'group';
  if (isKO && h === a && !m.pen_winner) {
    showToast('Empate no mata-mata: defina o vencedor dos pênaltis', 'error', 3000);
    return;
  }

  // Validação de marcadores: gols por time devem bater com placar
  // Skip validation per-team if that team has no players registered
  const homePlayers = cache.playersByTeam?.[m.team_home] ?? [];
  const awayPlayers = cache.playersByTeam?.[m.team_away] ?? [];
  const scorers = cache.player_goals.filter(g => g.match_id === id);

  // Compara team com alias (ex: 'USA' === 'United States')
  const teamMatches = (a, b) => a === b || TEAM_PLAYERS_ALIAS[a] === b || TEAM_PLAYERS_ALIAS[b] === a;

  // Only validate home goals if home team has players
  if (homePlayers.length > 0) {
    const homeGoals = scorers
      .filter(s => teamMatches(s.players?.team, m.team_home))
      .reduce((sum, s) => sum + s.goals, 0);
    if (homeGoals !== h) {
      showToast(`Gols ${teamPt(m.team_home)}: ${homeGoals} atribuídos, esperado ${h}`, 'error', 3500);
      return;
    }
  }

  // Only validate away goals if away team has players
  if (awayPlayers.length > 0) {
    const awayGoals = scorers
      .filter(s => teamMatches(s.players?.team, m.team_away))
      .reduce((sum, s) => sum + s.goals, 0);
    if (awayGoals !== a) {
      showToast(`Gols ${teamPt(m.team_away)}: ${awayGoals} atribuídos, esperado ${a}`, 'error', 3500);
      return;
    }
  }

  const payload = {
    actual_home: h,
    actual_away: a,
    pen_winner: (isKO && h === a) ? m.pen_winner : null,
    finished: true,
    finished_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('matches')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    showToast('Erro: ' + error.message, 'error', 3500);
    return;
  }

  Object.assign(m, data);
  showToast(`Lançado: ${teamPt(m.team_home)} ${h}–${a} ${teamPt(m.team_away)}`, 'success', 2500);
  rerenderResultRow(id);
  const finishedTotal = cache.matches.filter(x => x.finished).length;
  stats.finished_matches = finishedTotal;
  stats.pct_played = Math.round(finishedTotal / cache.matches.length * 100 * 10) / 10;
}

async function clearResult(matchId) {
  const id = parseInt(matchId, 10);
  if (!confirm('Limpar resultado e remover todos os marcadores deste jogo?\nPontos dos usuários serão recalculados.')) return;

  // Limpa match
  const { error: e1 } = await supabase
    .from('matches')
    .update({ actual_home: null, actual_away: null, pen_winner: null, finished: false, finished_at: null })
    .eq('id', id);
  if (e1) { showToast('Erro: ' + e1.message, 'error', 3500); return; }

  // Limpa player_goals deste match
  const { error: e2 } = await supabase.from('player_goals').delete().eq('match_id', id);
  if (e2) { showToast('Erro ao limpar gols: ' + e2.message, 'error', 3500); return; }

  // Limpa pontos das predictions
  await supabase.from('predictions').update({ points_earned: null }).eq('match_id', id);

  // Update local cache
  const m = cache.matches.find(x => x.id === id);
  if (m) {
    m.actual_home = null; m.actual_away = null; m.pen_winner = null;
    m.finished = false; m.finished_at = null;
  }
  cache.player_goals = cache.player_goals.filter(g => g.match_id !== id);

  showToast('Resultado e marcadores limpos', 'info');
  document.getElementById('tabBody').innerHTML = await renderResultsTab();
}

async function addScorer(matchId) {
  const id = parseInt(matchId, 10);
  const playerSelect = document.getElementById(`addPlayer_${id}`);
  const qtyInput = document.getElementById(`addQty_${id}`);
  if (!playerSelect || !qtyInput) return;

  const playerId = parseInt(playerSelect.value, 10);
  const qty = parseInt(qtyInput.value, 10);
  if (!playerId || !qty || qty < 1) {
    showToast('Escolha jogador e quantidade', 'error', 2500);
    return;
  }

  // Valida que não excede o total de gols
  const m = cache.matches.find(x => x.id === id);
  const hVal = parseInt(document.getElementById(`rh_${id}`).value, 10);
  const aVal = parseInt(document.getElementById(`ra_${id}`).value, 10);
  if (isNaN(hVal) || isNaN(aVal)) {
    showToast('Preencha o placar antes', 'error', 2500);
    return;
  }
  const totalGoals = hVal + aVal;
  const current = cache.player_goals.filter(g => g.match_id === id).reduce((s, g) => s + g.goals, 0);
  if (current + qty > totalGoals) {
    showToast(`Excede o total (${current + qty} > ${totalGoals})`, 'error', 2500);
    return;
  }

  const { data, error } = await supabase
    .from('player_goals')
    .upsert({ match_id: id, player_id: playerId, goals: qty }, { onConflict: 'player_id,match_id' })
    .select('*, players(full_name, team)')
    .single();

  if (error) {
    showToast('Erro: ' + error.message, 'error', 3500);
    return;
  }

  // Update cache (replace or insert)
  const idx = cache.player_goals.findIndex(g => g.player_id === playerId && g.match_id === id);
  if (idx >= 0) cache.player_goals[idx] = data;
  else          cache.player_goals.push(data);

  showToast(`${data.players.full_name} · ${qty} ${qty === 1 ? 'gol' : 'gols'}`, 'success');
  rerenderResultRow(id);
}

async function removeGoal(goalId, matchId) {
  if (!confirm('Remover este marcador?')) return;
  const { error } = await supabase.from('player_goals').delete().eq('id', goalId);
  if (error) {
    showToast('Erro: ' + error.message, 'error', 3500);
    return;
  }
  cache.player_goals = cache.player_goals.filter(g => g.id != goalId);
  showToast('Marcador removido', 'info');
  rerenderResultRow(parseInt(matchId, 10));
}

// ============================================================
// SETTINGS TAB
// ============================================================
async function loadSettings() {
  const { data, error } = await supabase.from('settings').select('key, value');
  if (error) throw error;
  cache.settings = Object.fromEntries((data ?? []).map(r => [r.key, unwrap(r.value)]));
}

async function renderSettingsTab() {
  if (!cache.settings) await loadSettings();
  const s = cache.settings;
  const split = s.prize_split || { first: 70, second: 20, third: 10 };
  const dl = s.deadline_champion_scorer ? new Date(s.deadline_champion_scorer) : new Date('2026-06-11T02:59:00Z');
  const dlLocal = toLocalDatetimeStr(dl);

  return `
    <div class="setting-form">
      <div class="field">
        <label>Nome do bolão</label>
        <input id="setPoolName" type="text" value="${escapeHtml(s.pool_name || 'SBC 2026')}">
      </div>
      <div class="field">
        <label>Valor da taxa (R$ por jogador)
          <small>Multiplicado pelo número de pagos = bolso total</small>
        </label>
        <input id="setFee" type="number" min="0" value="${s.fee_amount ?? 100}">
      </div>
      <div class="field">
        <label>Deadline campeão & artilheiro
          <small>Após esta data/hora, as escolhas travam (formato local)</small>
        </label>
        <input id="setDeadline" type="datetime-local" value="${dlLocal}">
      </div>
      <div class="field">
        <label>Divisão de prêmios (%)
          <small>1º + 2º + 3º deve somar 100. Atual: ${split.first}/${split.second}/${split.third}</small>
        </label>
        <div class="triple">
          <input id="setFirst" type="number" min="0" max="100" value="${split.first}" placeholder="1º">
          <input id="setSecond" type="number" min="0" max="100" value="${split.second}" placeholder="2º">
          <input id="setThird" type="number" min="0" max="100" value="${split.third}" placeholder="3º">
        </div>
      </div>
      <button class="btn btn-green" data-action="save-settings">Salvar configurações</button>
    </div>
  `;
}

async function saveSettings() {
  const poolName = document.getElementById('setPoolName').value.trim();
  const fee      = parseFloat(document.getElementById('setFee').value);
  const dlLocal  = document.getElementById('setDeadline').value;
  const first    = parseInt(document.getElementById('setFirst').value, 10);
  const second   = parseInt(document.getElementById('setSecond').value, 10);
  const third    = parseInt(document.getElementById('setThird').value, 10);

  if (!poolName) { showToast('Nome do bolão obrigatório', 'error'); return; }
  if (isNaN(fee) || fee < 0) { showToast('Taxa inválida', 'error'); return; }
  if (first + second + third !== 100) {
    showToast(`Divisão deve somar 100% (atual: ${first + second + third})`, 'error', 3000);
    return;
  }
  if (!dlLocal) { showToast('Deadline obrigatório', 'error'); return; }

  const deadlineIso = new Date(dlLocal).toISOString();

  // A coluna settings.value é jsonb e o supabase-js já serializa: passamos valores
  // NATIVOS (não JSON.stringify, senão duplo-codifica e vira '"2026-..."' com aspas,
  // que quebra new Date() no front e o cast ::timestamptz no cs_deadline() do SQL).
  const updates = [
    { key: 'pool_name', value: poolName },
    { key: 'fee_amount', value: fee },
    { key: 'deadline_champion_scorer', value: deadlineIso },
    { key: 'prize_split', value: { first, second, third } },
  ];

  const errors = [];
  for (const u of updates) {
    const { error } = await supabase.from('settings').upsert(u, { onConflict: 'key' });
    if (error) errors.push(error.message);
  }

  if (errors.length) {
    showToast('Erro: ' + errors.join(' | '), 'error', 4000);
    return;
  }

  cache.settings = { pool_name: poolName, fee_amount: fee, deadline_champion_scorer: deadlineIso, prize_split: { first, second, third } };
  showToast('Configurações salvas', 'success');
  updateGlobalKpis();
}

// ============================================================
// Helpers
// ============================================================
function unwrap(v) {
  // Supabase jsonb pode vir como string serializada ou já parseada
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][d.getMonth()]}`;
}

function formatBrDateShort(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][d.getMonth()]}`;
}

function toLocalDatetimeStr(d) {
  // YYYY-MM-DDTHH:MM em local time (formato input[type=datetime-local])
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function groupMatchesByDate(matches) {
  const map = new Map();
  for (const m of matches) {
    const key = localDateKey(m.match_date);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return [...map.entries()];
}

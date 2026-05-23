import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, teamPt, showToast,
  attachTeamTooltips, loadRecentMatches,
} from '../util.js';

// ============================================================
// Estado
// ============================================================
let profile, stats;
let teams = [];               // 48 country names from matches table (group stage)
let players = [];             // ~52 candidatos a artilheiro
let championPick = null;      // { team }
let scorerPick = null;        // { player_id, ... } merged with player info
let deadline = null;          // Date — quando trava
let teamSearch = '';
let playerSearch = '';

const KICKOFF_BOLAO = new Date('2026-06-11T02:59:00Z'); // 10/jun 23:59 BRT default

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  await loadData();

  const pageBody = await renderShell({ active: 'campeao', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');
  attachEventListeners();

  const recentByTeam = await loadRecentMatches();
  attachTeamTooltips(recentByTeam);

  // Atualiza countdown a cada minuto
  startCountdown();
} catch (err) {
  console.error('[campeao-artilheiro] FATAL:', err);
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
  const [statsRes, teamsRes, playersRes, champRes, scorerRes, settingsRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    supabase.from('matches').select('team_home, team_away').eq('stage', 'group'),
    supabase.from('players').select('*').order('full_name'),
    supabase.from('champion_picks').select('*').eq('user_id', profile.id).maybeSingle(),
    supabase.from('top_scorer_picks').select('*, players(*)').eq('user_id', profile.id).maybeSingle(),
    supabase.from('settings').select('value').eq('key', 'deadline_champion_scorer').maybeSingle(),
  ]);

  if (teamsRes.error)   throw teamsRes.error;
  if (playersRes.error) throw playersRes.error;

  stats = statsRes.data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0 };

  // Times únicos das partidas de grupo (48)
  const set = new Set();
  for (const m of teamsRes.data) {
    set.add(m.team_home);
    set.add(m.team_away);
  }
  teams = [...set].sort((a, b) => teamPt(a).localeCompare(teamPt(b), 'pt-BR'));

  players = playersRes.data ?? [];
  championPick = champRes.data ?? null;
  scorerPick = scorerRes.data ?? null;

  // Deadline: settings ou default 10/jun 23:59 BRT
  const sv = settingsRes.data?.value;
  deadline = sv ? new Date(typeof sv === 'string' ? sv : sv.toString().replace(/^"|"$/g, '')) : KICKOFF_BOLAO;
}

// ============================================================
// Render
// ============================================================
function renderPage() {
  const locked = new Date() >= deadline;
  return `
    <section class="hero">
      <div class="hero-kicker">Apostas exclusivas</div>
      <h1 class="hero-title">Campeão & Artilheiro</h1>
      <div class="hero-meta">
        <b>Escolha única</b><span class="sep"></span>
        ${locked
          ? `<span style="color:var(--red); font-weight:700;">🔒 Travado</span>`
          : `Trava em <strong style="color:var(--gold)">${formatDeadline(deadline)}</strong>`}
        <span class="sep"></span>
        <span id="countdown" style="color:var(--text-dim); font-family:ui-monospace,monospace; font-size:13px;"></span>
      </div>
    </section>

    <div class="cs-split">
      ${renderChampionCard(locked)}
      ${renderScorerCard(locked)}
    </div>

    <div class="note" style="margin-top:36px; padding:14px 18px; background:var(--card); border-left:3px solid var(--gold); border-radius:0 6px 6px 0; font-size:12px; color:var(--text-dim);">
      <strong style="color:var(--gold);">Como funciona:</strong>
      <strong>Campeão</strong> = +30 pts se a sua seleção levantar a taça.
      <strong>Artilheiro</strong> = +2 pts × multiplicador da fase por gol do seu jogador
      (grupos ×1, oitavas ×2, quartas ×2.5, semis ×3, final ×4).
    </div>
  `;
}

function renderChampionCard(locked) {
  const filtered = teams.filter(t =>
    !teamSearch || teamPt(t).toLowerCase().includes(teamSearch.toLowerCase())
  );

  return `
    <div class="cs-card" id="cardChampion">
      <div class="cs-card-icon">🏆</div>
      <div class="cs-card-kicker">Aposta 1 · Valor: 30 pts</div>
      <h3>Campeão da Copa</h3>
      <p class="desc">Qual seleção vai levantar a taça em 19/jul no MetLife Stadium?</p>

      ${championPick
        ? `<div class="cs-pick-box">
            <div class="cs-pick-flag">${flag(championPick.team)}</div>
            <div class="cs-pick-info">
              <div class="cs-pick-name">${escapeHtml(teamPt(championPick.team))}</div>
              <div class="cs-pick-sub">Sua escolha atual</div>
            </div>
          </div>`
        : `<div class="cs-pick-box empty">Nenhuma escolha ainda — selecione uma seleção abaixo</div>`}

      <div class="cs-search ${locked ? 'locked' : ''}">
        <input id="searchTeam" type="text" placeholder="Buscar seleção…"
               value="${escapeHtml(teamSearch)}" ${locked ? 'disabled' : ''}>
      </div>

      <div class="cs-list" id="teamList">
        ${filtered.map(t => `
          <div class="cs-row ${championPick?.team === t ? 'selected' : ''} ${locked ? 'disabled' : ''}"
               data-action="pick-team" data-team="${escapeHtml(t)}">
            <span class="flag">${flag(t)}</span>
            <span class="nm">${escapeHtml(teamPt(t))}</span>
            ${championPick?.team === t ? '<span class="check">✓</span>' : ''}
          </div>
        `).join('')}
        ${filtered.length === 0 ? '<div style="padding:20px; text-align:center; color:var(--text-mute); font-size:12px;">Nenhum resultado</div>' : ''}
      </div>

      <div class="cs-deadline ${locked ? 'locked' : ''}">
        ${locked ? '🔒' : '⏱'} ${locked ? 'Trancado em' : 'Fecha em'}
        <strong>${formatDeadline(deadline)}</strong>
      </div>
    </div>
  `;
}

function renderScorerCard(locked) {
  const filtered = players.filter(p => {
    if (!playerSearch) return true;
    const q = playerSearch.toLowerCase();
    return p.full_name.toLowerCase().includes(q)
        || teamPt(p.team).toLowerCase().includes(q)
        || p.team.toLowerCase().includes(q);
  });

  const current = scorerPick?.players;

  return `
    <div class="cs-card" id="cardScorer">
      <div class="cs-card-icon">⭐</div>
      <div class="cs-card-kicker">Aposta 2 · +2 pts × multiplicador por gol</div>
      <h3>Artilheiro do Bolão</h3>
      <p class="desc">Escolha 1 jogador. Cada gol dele vale +2 pts (escalando até ×4 na final).</p>

      ${current
        ? `<div class="cs-pick-box">
            <div class="cs-pick-flag">${flag(current.team)}</div>
            <div class="cs-pick-info">
              <div class="cs-pick-name">${escapeHtml(current.full_name)}</div>
              <div class="cs-pick-sub">${escapeHtml(teamPt(current.team))} · ${escapeHtml(current.position || '')}${current.shirt_number ? ' · #' + current.shirt_number : ''}</div>
            </div>
          </div>`
        : `<div class="cs-pick-box empty">Nenhuma escolha ainda — selecione um jogador abaixo</div>`}

      <div class="cs-search ${locked ? 'locked' : ''}">
        <input id="searchPlayer" type="text" placeholder="Buscar jogador ou seleção…"
               value="${escapeHtml(playerSearch)}" ${locked ? 'disabled' : ''}>
      </div>

      <div class="cs-list" id="playerList">
        ${filtered.map(p => `
          <div class="cs-row ${scorerPick?.player_id === p.id ? 'selected' : ''} ${locked ? 'disabled' : ''}"
               data-action="pick-player" data-player="${p.id}">
            <span class="flag">${flag(p.team)}</span>
            <span class="nm">${escapeHtml(p.full_name)}</span>
            <span class="meta">${escapeHtml(p.position || '')}${p.shirt_number ? ' #' + p.shirt_number : ''}</span>
            ${scorerPick?.player_id === p.id ? '<span class="check">✓</span>' : ''}
          </div>
        `).join('')}
        ${filtered.length === 0 ? '<div style="padding:20px; text-align:center; color:var(--text-mute); font-size:12px;">Nenhum resultado</div>' : ''}
      </div>

      <div class="cs-deadline ${locked ? 'locked' : ''}">
        ${locked ? '🔒' : '⏱'} ${locked ? 'Trancado em' : 'Fecha em'}
        <strong>${formatDeadline(deadline)}</strong>
      </div>
    </div>
  `;
}

// ============================================================
// Eventos
// ============================================================
function attachEventListeners() {
  document.addEventListener('click', async (e) => {
    const row = e.target.closest('.cs-row');
    if (!row || row.classList.contains('disabled')) return;
    const action = row.dataset.action;
    if (action === 'pick-team') {
      await pickChampion(row.dataset.team);
    } else if (action === 'pick-player') {
      await pickScorer(parseInt(row.dataset.player, 10));
    }
  });

  // Busca de seleções (filtra lista)
  document.addEventListener('input', (e) => {
    if (e.target.id === 'searchTeam') {
      teamSearch = e.target.value;
      rerenderTeamList();
    } else if (e.target.id === 'searchPlayer') {
      playerSearch = e.target.value;
      rerenderPlayerList();
    }
  });
}

async function pickChampion(team) {
  const previous = championPick;
  championPick = { team, user_id: profile.id }; // optimistic
  rerenderChampion();

  const { data, error } = await supabase
    .from('champion_picks')
    .upsert({ user_id: profile.id, team }, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) {
    console.error('[champion error]', error);
    championPick = previous;
    rerenderChampion();
    showToast('Erro ao salvar campeão: ' + error.message, 'error', 3500);
    return;
  }

  championPick = data;
  showToast(`Campeão: ${teamPt(team)}`, 'success');
}

async function pickScorer(playerId) {
  const player = players.find(p => p.id === playerId);
  if (!player) return;
  const previous = scorerPick;
  scorerPick = { user_id: profile.id, player_id: playerId, players: player };
  rerenderScorer();

  const { data, error } = await supabase
    .from('top_scorer_picks')
    .upsert({ user_id: profile.id, player_id: playerId }, { onConflict: 'user_id' })
    .select('*, players(*)')
    .single();

  if (error) {
    console.error('[scorer error]', error);
    scorerPick = previous;
    rerenderScorer();
    showToast('Erro ao salvar artilheiro: ' + error.message, 'error', 3500);
    return;
  }

  scorerPick = data;
  showToast(`Artilheiro: ${player.full_name}`, 'success');
}

// ============================================================
// Re-renders
// ============================================================
function rerenderChampion() {
  const locked = new Date() >= deadline;
  const el = document.getElementById('cardChampion');
  if (el) el.outerHTML = renderChampionCard(locked);
}

function rerenderScorer() {
  const locked = new Date() >= deadline;
  const el = document.getElementById('cardScorer');
  if (el) el.outerHTML = renderScorerCard(locked);
}

function rerenderTeamList() {
  const locked = new Date() >= deadline;
  const filtered = teams.filter(t =>
    !teamSearch || teamPt(t).toLowerCase().includes(teamSearch.toLowerCase())
  );
  const list = document.getElementById('teamList');
  if (!list) return;
  list.innerHTML = filtered.map(t => `
    <div class="cs-row ${championPick?.team === t ? 'selected' : ''} ${locked ? 'disabled' : ''}"
         data-action="pick-team" data-team="${escapeHtml(t)}">
      <span class="flag">${flag(t)}</span>
      <span class="nm">${escapeHtml(teamPt(t))}</span>
      ${championPick?.team === t ? '<span class="check">✓</span>' : ''}
    </div>
  `).join('') + (filtered.length === 0 ? '<div style="padding:20px; text-align:center; color:var(--text-mute); font-size:12px;">Nenhum resultado</div>' : '');
}

function rerenderPlayerList() {
  const locked = new Date() >= deadline;
  const filtered = players.filter(p => {
    if (!playerSearch) return true;
    const q = playerSearch.toLowerCase();
    return p.full_name.toLowerCase().includes(q)
        || teamPt(p.team).toLowerCase().includes(q)
        || p.team.toLowerCase().includes(q);
  });
  const list = document.getElementById('playerList');
  if (!list) return;
  list.innerHTML = filtered.map(p => `
    <div class="cs-row ${scorerPick?.player_id === p.id ? 'selected' : ''} ${locked ? 'disabled' : ''}"
         data-action="pick-player" data-player="${p.id}">
      <span class="flag">${flag(p.team)}</span>
      <span class="nm">${escapeHtml(p.full_name)}</span>
      <span class="meta">${escapeHtml(p.position || '')}${p.shirt_number ? ' #' + p.shirt_number : ''}</span>
      ${scorerPick?.player_id === p.id ? '<span class="check">✓</span>' : ''}
    </div>
  `).join('') + (filtered.length === 0 ? '<div style="padding:20px; text-align:center; color:var(--text-mute); font-size:12px;">Nenhum resultado</div>' : '');
}

// ============================================================
// Formatters
// ============================================================
function formatDeadline(d) {
  const dia = String(d.getDate()).padStart(2, '0');
  const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const mes = meses[d.getMonth()];
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${dia}/${mes} · ${h}h${m}`;
}

function startCountdown() {
  function tick() {
    const el = document.getElementById('countdown');
    if (!el) return;
    const diff = deadline - new Date();
    if (diff <= 0) {
      el.textContent = '— escolhas trancadas —';
      el.style.color = 'var(--red)';
      return;
    }
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff / 3600000) % 24);
    const minutes = Math.floor((diff / 60000) % 60);
    el.textContent = `${days}d ${String(hours).padStart(2,'0')}h ${String(minutes).padStart(2,'0')}m restantes`;
  }
  tick();
  setInterval(tick, 60000);
}

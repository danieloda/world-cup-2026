import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, teamPt, showToast,
} from '../util.js';
import { matchPoints, championBonus } from '../scoring.js';

// ============================================================
// Estado
// ============================================================
let profile, stats;
let teams = [];               // 48 country names from matches table (group stage)
let championPick = null;      // { team }
let scorerPick = null;        // { player_id, ... } merged with player info
let deadline = null;          // Date — quando trava
let teamSearch = '';
let finalMatch = null;        // { actual_home, actual_away, pen_winner, team_home, team_away, finished }
let scorerGoals = [];         // [{ goals, match: { id, stage, round_label, team_home, team_away, actual_home, actual_away } }]

// Artilheiro two-step selection state
let scorerStep = 'country';   // 'country' | 'player'
let selectedCountry = null;   // Country selected for artilheiro
let countryPlayers = [];      // Players from selected country
let countrySearch = '';       // Search within country list
let playerSearch = '';        // Search within player list
let loadingPlayers = false;

const KICKOFF_BOLAO = new Date('2026-06-11T02:59:00Z'); // 10/jun 23:59 BRT default

// Position order for sorting (attackers first for top scorer)
const POS_ORDER = { ATA: 0, MEI: 1, DEF: 2, GOL: 3 };

// Stage multipliers para o ARTILHEIRO (2 × gols × mult). Mirror de stage_multiplier (003).
const STAGE_MULT = { group: 1.0, r32: 1.5, r16: 2.0, qf: 3.0, sf: 4.0, third: 2.0, final: 5.0 };
const STAGE_LABEL = { group: 'Grupos', r32: '32-avos', r16: 'Oitavas', qf: 'Quartas', sf: 'Semis', third: '3º Lugar', final: 'Final' };
const CHAMPION_BONUS_PTS = championBonus(true);  // canônico (scoring.js → champion_bonus_for 022)
const GROUP_EXACT = matchPoints('group').exact; // 7 — p/ a comparação "equivale a X exatos"

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
  const [statsRes, teamsRes, champRes, scorerRes, settingsRes, finalRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    supabase.from('matches').select('team_home, team_away').eq('stage', 'group'),
    supabase.from('champion_picks').select('*').eq('user_id', profile.id).maybeSingle(),
    supabase.from('top_scorer_picks').select('*, players(*)').eq('user_id', profile.id).maybeSingle(),
    supabase.from('settings').select('value').eq('key', 'deadline_champion_scorer').maybeSingle(),
    supabase.from('matches').select('team_home, team_away, actual_home, actual_away, pen_winner, finished').eq('stage', 'final').maybeSingle(),
  ]);

  if (teamsRes.error) throw teamsRes.error;

  stats = statsRes.data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0 };
  finalMatch = finalRes.data ?? null;

  // Times únicos das partidas de grupo (48)
  const set = new Set();
  for (const m of teamsRes.data) {
    set.add(m.team_home);
    set.add(m.team_away);
  }
  teams = [...set].sort((a, b) => teamPt(a).localeCompare(teamPt(b), 'pt-BR'));

  championPick = champRes.data ?? null;
  scorerPick = scorerRes.data ?? null;

  // If user already has a scorer pick, load their goals from finished matches
  if (scorerPick?.player_id) {
    const { data: goals } = await supabase
      .from('player_goals')
      .select('goals, match:matches!inner(id, stage, round_label, team_home, team_away, actual_home, actual_away, match_date)')
      .eq('player_id', scorerPick.player_id)
      .eq('match.finished', true);
    scorerGoals = (goals ?? []).sort((a, b) =>
      new Date(a.match.match_date) - new Date(b.match.match_date)
    );
  }

  // If user already has a scorer pick AND we're not locked yet, prepare player step for that country
  const lockedNow = settingsRes.data?.value
    ? new Date(typeof settingsRes.data.value === 'string' ? settingsRes.data.value : settingsRes.data.value.toString().replace(/^"|"$/g, ''))
    : KICKOFF_BOLAO;
  if (scorerPick?.players?.team && new Date() < lockedNow) {
    selectedCountry = scorerPick.players.team;
    scorerStep = 'player';
    await loadPlayersForCountry(selectedCountry);
  }

  // Deadline: settings ou default 10/jun 23:59 BRT.
  // settings.value pode vir duplo-codificado ('"2026-..."') de saves antigos do admin → parse robusto.
  deadline = parseSettingDate(settingsRes.data?.value) ?? KICKOFF_BOLAO;
}

// Lê uma data salva em settings (jsonb), tolerando dupla codificação ('"..."').
// Retorna null se não der uma data válida.
function parseSettingDate(sv) {
  if (sv == null) return null;
  let s = sv;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch { /* string simples, mantém */ }
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function isAllFinished() {
  return stats && stats.finished_matches === stats.total_matches && stats.total_matches > 0;
}

function isFinalDone() {
  return finalMatch?.finished === true;
}

function actualChampion() {
  if (!isFinalDone()) return null;
  const fm = finalMatch;
  if (fm.actual_home > fm.actual_away) return fm.team_home;
  if (fm.actual_away > fm.actual_home) return fm.team_away;
  if (fm.pen_winner === 'home') return fm.team_home;
  if (fm.pen_winner === 'away') return fm.team_away;
  return null;
}

function computeScorerBreakdown() {
  // Returns { entries: [{match, goals, mult, basePts, totalPts}], totalPts, totalGoals }
  const entries = scorerGoals.map(g => {
    const mult = STAGE_MULT[g.match.stage] ?? 1.0;
    const basePts = g.goals * 2;
    const totalPts = Math.round(basePts * mult);
    return { match: g.match, goals: g.goals, mult, basePts, totalPts };
  });
  const totalPts = entries.reduce((s, e) => s + e.totalPts, 0);
  const totalGoals = entries.reduce((s, e) => s + e.goals, 0);
  return { entries, totalPts, totalGoals };
}

async function loadPlayersForCountry(country) {
  loadingPlayers = true;
  rerenderScorer();

  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('team', country)
    .order('full_name');

  if (error) {
    console.error('[loadPlayersForCountry]', error);
    countryPlayers = [];
  } else {
    // Sort: position (ATA first), then name
    countryPlayers = (data ?? []).sort((a, b) => {
      const posA = POS_ORDER[a.position] ?? 9;
      const posB = POS_ORDER[b.position] ?? 9;
      if (posA !== posB) return posA - posB;
      return a.full_name.localeCompare(b.full_name, 'pt-BR');
    });
  }

  loadingPlayers = false;
  rerenderScorer();
}

// ============================================================
// Render
// ============================================================
function renderPage() {
  const locked = new Date() >= deadline;
  return `
    <section class="hero">
      <div class="hero-kicker">Palpites bônus · Pontos extras</div>
      <h1 class="hero-title">Campeão & Artilheiro</h1>
      <div class="hero-meta">
        <b>Escolha única antes da Copa</b><span class="sep"></span>
        ${locked
          ? `<span style="color:var(--red); font-weight:700;">🔒 Travado</span>`
          : `<span style="color:var(--accent)">Trava ${formatDeadline(deadline)}</span><span class="sep"></span><span id="countdown" style="color:var(--text-dim)">…</span>`}
      </div>
    </section>

    <div class="note">
      <span class="note-head">Dois palpites bônus, feitos uma única vez</span>
      <ul class="note-list">
        <li>🏆 Acertar o <strong>Campeão</strong>: <strong>+${CHAMPION_BONUS_PTS} pontos</strong> (vale como ${Math.round(CHAMPION_BONUS_PTS / GROUP_EXACT)} placares exatos dos grupos — pense com calma)</li>
        <li>⚽ <strong>Artilheiro</strong>: <strong>+2 pontos por gol</strong> do jogador que você escolher (vale mais nas fases finais)</li>
      </ul>
      <span class="note-deadline">⏰ ${locked ? 'Os palpites já fecharam.' : `Você pode escolher e mudar até ${formatDeadline(deadline)}.`}
        <span class="sub">Depois disso ficam travados.</span></span>
      <a class="note-link" href="regras.html">Ver todas as regras →</a>
    </div>

    <div class="cs-split">
      ${renderChampionCard(locked)}
      ${renderScorerCard(locked)}
    </div>
  `;
}

function renderChampionCard(locked) {
  // STATE 3: Final terminou — mostra UI de acerto/erro
  if (isFinalDone() && championPick) {
    return renderChampionResult();
  }

  // STATE 2: Locked (após deadline) mas final ainda não rolou
  if (locked && championPick) {
    return renderChampionLocked();
  }

  // STATE 1: Pré-deadline — UI de seleção
  return renderChampionSelection(locked);
}

function renderChampionResult() {
  const actualWin = actualChampion();
  const hit = actualWin && championPick.team === actualWin;
  const earned = hit ? CHAMPION_BONUS_PTS : 0;

  return `
    <div class="cs-card cs-result ${hit ? 'hit' : 'miss'}" id="cardChampion">
      <div class="cs-card-icon">🏆</div>
      <div class="cs-card-kicker">Aposta 1 · Campeão</div>
      <h3>Campeão da Copa</h3>

      <div class="cs-result-pick">
        <div class="cs-result-label">Sua escolha:</div>
        <div class="cs-pick-box ${hit ? 'win' : 'lose'}">
          <div class="cs-pick-flag">${flag(championPick.team)}</div>
          <div class="cs-pick-info">
            <div class="cs-pick-name">${escapeHtml(teamPt(championPick.team))}</div>
            <div class="cs-pick-sub">${hit ? '✓ Campeão!' : '✗ Não foi campeão'}</div>
          </div>
        </div>
      </div>

      ${!hit && actualWin ? `
        <div class="cs-result-pick">
          <div class="cs-result-label">Campeão real:</div>
          <div class="cs-pick-box neutral">
            <div class="cs-pick-flag">${flag(actualWin)}</div>
            <div class="cs-pick-info">
              <div class="cs-pick-name">${escapeHtml(teamPt(actualWin))}</div>
              <div class="cs-pick-sub">Levantou a taça</div>
            </div>
          </div>
        </div>
      ` : ''}

      <div class="cs-result-points ${hit ? 'hit' : 'miss'}">
        <div class="cs-result-points-label">Pontos do palpite</div>
        <div class="cs-result-points-value">${hit ? '+' : ''}${earned} pts</div>
        <div class="cs-result-points-sub">${hit ? `Bônus de campeão` : 'Sem bônus'}</div>
      </div>
    </div>
  `;
}

function renderChampionLocked() {
  return `
    <div class="cs-card cs-locked" id="cardChampion">
      <div class="cs-card-icon">🏆</div>
      <div class="cs-card-kicker">Aposta 1 · Campeão · 🔒 Travado</div>
      <h3>Campeão da Copa</h3>
      <p class="desc">Sua escolha está travada. Aguarde o fim da Final pra ver se acertou.</p>

      <div class="cs-pick-box locked">
        <div class="cs-pick-flag">${flag(championPick.team)}</div>
        <div class="cs-pick-info">
          <div class="cs-pick-name">${escapeHtml(teamPt(championPick.team))}</div>
          <div class="cs-pick-sub">🔒 Sua escolha final · +${CHAMPION_BONUS_PTS} pts se acertar</div>
        </div>
      </div>

      <div class="cs-deadline locked">
        🔒 Trancado em <strong>${formatDeadline(deadline)}</strong>
      </div>
    </div>
  `;
}

function renderChampionSelection(locked) {
  const filtered = teams.filter(t =>
    !teamSearch || teamPt(t).toLowerCase().includes(teamSearch.toLowerCase())
  );

  return `
    <div class="cs-card" id="cardChampion">
      <div class="cs-card-icon">🏆</div>
      <div class="cs-card-kicker">Aposta 1 · +${CHAMPION_BONUS_PTS} pts se acertar</div>
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
  const current = scorerPick?.players;

  // STATE 3: Torneio terminou — mostra breakdown de gols e pontos
  if (isAllFinished() && current) {
    return renderScorerResult();
  }

  // STATE 2: Locked mas torneio não terminou
  if (locked && current) {
    return renderScorerLocked();
  }

  // STATE 1: Pré-deadline — UI de seleção
  return `
    <div class="cs-card" id="cardScorer">
      <div class="cs-card-icon">⚽</div>
      <div class="cs-card-kicker">Aposta 2 · +2 pts por gol</div>
      <h3>Artilheiro do Bolão</h3>
      <p class="desc">Escolha 1 jogador. Cada gol dele soma pontos — e gols nas fases finais valem ainda mais.</p>

      ${current
        ? `<div class="cs-pick-box">
            <div class="cs-pick-flag">${flag(current.team)}</div>
            <div class="cs-pick-info">
              <div class="cs-pick-name">${escapeHtml(current.full_name)}</div>
              <div class="cs-pick-sub">${escapeHtml(teamPt(current.team))} · ${escapeHtml(current.position || '')}${current.shirt_number ? ' · #' + current.shirt_number : ''}</div>
            </div>
          </div>`
        : `<div class="cs-pick-box empty">Nenhuma escolha ainda — selecione abaixo</div>`}

      ${scorerStep === 'country' ? renderCountryStep(locked) : renderPlayerStep(locked)}

      <div class="cs-deadline ${locked ? 'locked' : ''}">
        ${locked ? '🔒' : '⏱'} ${locked ? 'Trancado em' : 'Fecha em'}
        <strong>${formatDeadline(deadline)}</strong>
      </div>
    </div>
  `;
}

function renderScorerLocked() {
  const current = scorerPick.players;
  return `
    <div class="cs-card cs-locked" id="cardScorer">
      <div class="cs-card-icon">⚽</div>
      <div class="cs-card-kicker">Aposta 2 · Artilheiro · 🔒 Travado</div>
      <h3>Artilheiro do Bolão</h3>
      <p class="desc">Sua escolha está travada. Os pontos vão entrando conforme ele marca gols.</p>

      <div class="cs-pick-box locked">
        <div class="cs-pick-flag">${flag(current.team)}</div>
        <div class="cs-pick-info">
          <div class="cs-pick-name">${escapeHtml(current.full_name)}</div>
          <div class="cs-pick-sub">🔒 ${escapeHtml(teamPt(current.team))} · ${escapeHtml(current.position || '')}${current.shirt_number ? ' · #' + current.shirt_number : ''}</div>
        </div>
      </div>

      ${scorerGoals.length > 0 ? `
        <div class="cs-scorer-running">
          <div class="cs-scorer-running-label">Pontos parciais</div>
          <div class="cs-scorer-running-value">+${computeScorerBreakdown().totalPts} pts</div>
          <div class="cs-scorer-running-sub">${computeScorerBreakdown().totalGoals} gol${computeScorerBreakdown().totalGoals !== 1 ? 's' : ''} marcado${computeScorerBreakdown().totalGoals !== 1 ? 's' : ''} até agora</div>
        </div>
      ` : ''}

      <div class="cs-deadline locked">
        🔒 Trancado em <strong>${formatDeadline(deadline)}</strong>
      </div>
    </div>
  `;
}

function renderScorerResult() {
  const current = scorerPick.players;
  const { entries, totalPts, totalGoals } = computeScorerBreakdown();
  const noGoals = entries.length === 0;

  return `
    <div class="cs-card cs-result ${noGoals ? 'miss' : 'hit'}" id="cardScorer">
      <div class="cs-card-icon">⚽</div>
      <div class="cs-card-kicker">Aposta 2 · Artilheiro</div>
      <h3>Artilheiro do Bolão</h3>

      <div class="cs-pick-box ${noGoals ? 'lose' : 'win'}">
        <div class="cs-pick-flag">${flag(current.team)}</div>
        <div class="cs-pick-info">
          <div class="cs-pick-name">${escapeHtml(current.full_name)}</div>
          <div class="cs-pick-sub">${escapeHtml(teamPt(current.team))} · ${escapeHtml(current.position || '')}${current.shirt_number ? ' · #' + current.shirt_number : ''}</div>
        </div>
      </div>

      ${noGoals ? `
        <div class="cs-empty-goals">
          <p>Seu artilheiro não marcou nenhum gol no torneio. 😔</p>
        </div>
      ` : `
        <div class="cs-goals-breakdown">
          <div class="cs-goals-head">
            <span>⚽ Histórico de gols</span>
            <span>${totalGoals} gol${totalGoals !== 1 ? 's' : ''} em ${entries.length} jogo${entries.length !== 1 ? 's' : ''}</span>
          </div>
          ${entries.map(e => {
            const m = e.match;
            const stageLabel = STAGE_LABEL[m.stage] || m.stage;
            return `
              <div class="cs-goal-row">
                <div class="cs-goal-match">
                  <span class="stage-tag">${escapeHtml(stageLabel)}</span>
                  <span class="match-teams">
                    ${flag(m.team_home)} ${escapeHtml(teamPt(m.team_home))}
                    <span class="score">${m.actual_home}–${m.actual_away}</span>
                    ${escapeHtml(teamPt(m.team_away))} ${flag(m.team_away)}
                  </span>
                </div>
                <div class="cs-goal-pts">
                  <span class="formula">${e.goals}gol${e.goals !== 1 ? 's' : ''} × 2 × ${e.mult}</span>
                  <span class="total">= +${e.totalPts} pts</span>
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <div class="cs-result-points hit">
          <div class="cs-result-points-label">Total dos gols</div>
          <div class="cs-result-points-value">+${totalPts} pts</div>
          <div class="cs-result-points-sub">${totalGoals} gol${totalGoals !== 1 ? 's' : ''}, valendo mais nas fases finais</div>
        </div>
      `}
    </div>
  `;
}

function renderCountryStep(locked) {
  const filtered = teams.filter(t =>
    !countrySearch || teamPt(t).toLowerCase().includes(countrySearch.toLowerCase())
  );

  return `
    <div class="cs-step-header">
      <div class="cs-step-badge">1</div>
      <div class="cs-step-title">Selecione a seleção</div>
    </div>

    <div class="cs-search ${locked ? 'locked' : ''}">
      <input id="searchCountry" type="text" placeholder="Buscar seleção…"
             value="${escapeHtml(countrySearch)}" ${locked ? 'disabled' : ''}>
    </div>

    <div class="cs-list cs-country-grid" id="countryList">
      ${filtered.map(t => `
        <div class="cs-country-item ${locked ? 'disabled' : ''}"
             data-action="select-country" data-country="${escapeHtml(t)}">
          <span class="flag">${flag(t)}</span>
          <span class="nm">${escapeHtml(teamPt(t))}</span>
        </div>
      `).join('')}
      ${filtered.length === 0 ? '<div class="cs-empty">Nenhum resultado</div>' : ''}
    </div>
  `;
}

function renderPlayerStep(locked) {
  const filtered = countryPlayers.filter(p => {
    if (!playerSearch) return true;
    const q = playerSearch.toLowerCase();
    return p.full_name.toLowerCase().includes(q);
  });

  return `
    <div class="cs-step-header">
      <button class="cs-back-btn" data-action="back-to-country" ${locked ? 'disabled' : ''}>
        ← Voltar
      </button>
      <div class="cs-step-badge">2</div>
      <div class="cs-step-title">
        <span class="flag">${flag(selectedCountry)}</span>
        ${escapeHtml(teamPt(selectedCountry))}
      </div>
    </div>

    <div class="cs-search ${locked ? 'locked' : ''}">
      <input id="searchPlayer" type="text" placeholder="Buscar jogador…"
             value="${escapeHtml(playerSearch)}" ${locked ? 'disabled' : ''}>
    </div>

    <div class="cs-list" id="playerList">
      ${loadingPlayers
        ? '<div class="cs-loading"><div class="cs-spinner"></div> Carregando jogadores…</div>'
        : filtered.map(p => `
          <div class="cs-row ${scorerPick?.player_id === p.id ? 'selected' : ''} ${locked ? 'disabled' : ''}"
               data-action="pick-player" data-player="${p.id}">
            <span class="pos-badge pos-${p.position?.toLowerCase() || 'unk'}">${escapeHtml(p.position || '?')}</span>
            <span class="nm">${escapeHtml(p.full_name)}</span>
            <span class="meta">${p.shirt_number ? '#' + p.shirt_number : ''}</span>
            ${scorerPick?.player_id === p.id ? '<span class="check">✓</span>' : ''}
          </div>
        `).join('')}
      ${!loadingPlayers && filtered.length === 0 ? '<div class="cs-empty">Nenhum jogador encontrado</div>' : ''}
    </div>
  `;
}

// ============================================================
// Eventos
// ============================================================
function attachEventListeners() {
  document.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-action]');
    if (!row || row.classList.contains('disabled')) return;

    const action = row.dataset.action;

    if (action === 'pick-team') {
      await pickChampion(row.dataset.team);
    } else if (action === 'select-country') {
      await selectCountry(row.dataset.country);
    } else if (action === 'back-to-country') {
      backToCountry();
    } else if (action === 'pick-player') {
      await pickScorer(parseInt(row.dataset.player, 10));
    }
  });

  // Busca (filtra listas)
  document.addEventListener('input', (e) => {
    if (e.target.id === 'searchTeam') {
      teamSearch = e.target.value;
      rerenderTeamList();
    } else if (e.target.id === 'searchCountry') {
      countrySearch = e.target.value;
      rerenderCountryList();
    } else if (e.target.id === 'searchPlayer') {
      playerSearch = e.target.value;
      rerenderPlayerList();
    }
  });
}

async function selectCountry(country) {
  selectedCountry = country;
  countrySearch = '';
  playerSearch = '';
  scorerStep = 'player';
  await loadPlayersForCountry(country);
}

function backToCountry() {
  scorerStep = 'country';
  selectedCountry = null;
  countryPlayers = [];
  playerSearch = '';
  rerenderScorer();
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
  const player = countryPlayers.find(p => p.id === playerId);
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
  `).join('') + (filtered.length === 0 ? '<div class="cs-empty">Nenhum resultado</div>' : '');
}

function rerenderCountryList() {
  const locked = new Date() >= deadline;
  const filtered = teams.filter(t =>
    !countrySearch || teamPt(t).toLowerCase().includes(countrySearch.toLowerCase())
  );
  const list = document.getElementById('countryList');
  if (!list) return;
  list.innerHTML = filtered.map(t => `
    <div class="cs-country-item ${locked ? 'disabled' : ''}"
         data-action="select-country" data-country="${escapeHtml(t)}">
      <span class="flag">${flag(t)}</span>
      <span class="nm">${escapeHtml(teamPt(t))}</span>
    </div>
  `).join('') + (filtered.length === 0 ? '<div class="cs-empty">Nenhum resultado</div>' : '');
}

function rerenderPlayerList() {
  const locked = new Date() >= deadline;
  const filtered = countryPlayers.filter(p => {
    if (!playerSearch) return true;
    const q = playerSearch.toLowerCase();
    return p.full_name.toLowerCase().includes(q);
  });
  const list = document.getElementById('playerList');
  if (!list) return;
  list.innerHTML = filtered.map(p => `
    <div class="cs-row ${scorerPick?.player_id === p.id ? 'selected' : ''} ${locked ? 'disabled' : ''}"
         data-action="pick-player" data-player="${p.id}">
      <span class="pos-badge pos-${p.position?.toLowerCase() || 'unk'}">${escapeHtml(p.position || '?')}</span>
      <span class="nm">${escapeHtml(p.full_name)}</span>
      <span class="meta">${p.shirt_number ? '#' + p.shirt_number : ''}</span>
      ${scorerPick?.player_id === p.id ? '<span class="check">✓</span>' : ''}
    </div>
  `).join('') + (filtered.length === 0 ? '<div class="cs-empty">Nenhum jogador encontrado</div>' : '');
}

// ============================================================
// Formatters
// ============================================================
function formatDeadline(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return 'o prazo';
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

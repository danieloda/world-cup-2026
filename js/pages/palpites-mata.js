import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, formatTime, isLocked, showToast,
  attachTeamTooltips, loadRecentMatches, teamPt,
  computeStandings as utilComputeStandings,
} from '../util.js';

// ============================================================
// Constantes
// ============================================================
const STAGES = [
  { id: 'r32',   label: '32-avos',        mult: 1.5 },
  { id: 'r16',   label: 'Oitavas',        mult: 2.0 },
  { id: 'qf',    label: 'Quartas',        mult: 2.5 },
  { id: 'sf',    label: 'Semifinais',     mult: 3.0 },
  { id: 'final', label: 'Final · 3º Lugar', mult: 4.0 },  // agrupa Final + 3º na mesma coluna
];

const MEZES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

// ============================================================
// Estado
// ============================================================
let profile, stats;
let matches = [];                    // 32 matches KO
let allMatches = [];                 // 104 matches (incluindo grupos)
let predsByMatch = new Map();        // match_id -> prediction row (TODAS as predictions)
let goalsByMatch = new Map();        // match_id -> [{player, goals}]
let slotResolution = new Map();      // slot string -> { team, source } (baseado nos palpites)
let activeTab = 'palpites';          // 'palpites' | 'resultados'
const saveTimers = new Map();        // match_id -> setTimeout handle

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  await loadData();

  const recentByTeam = await loadRecentMatches();

  const pageBody = await renderShell({ active: 'palpites-k', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');

  attachEventListeners();
  attachTeamTooltips(recentByTeam);
} catch (err) {
  console.error('[palpites-mata] FATAL:', err);
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
  const [statsRes, matchesRes, predsRes, goalsRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    supabase.from('matches').select('*').order('match_date'),
    supabase.from('predictions').select('*').eq('user_id', profile.id),
    supabase.from('player_goals').select('*, players(full_name, team)'),
  ]);

  if (matchesRes.error) throw matchesRes.error;
  if (predsRes.error)   throw predsRes.error;

  stats = statsRes.data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0 };
  allMatches = matchesRes.data ?? [];
  matches = allMatches.filter(m => m.stage !== 'group');
  predsByMatch = new Map((predsRes.data ?? []).map(p => [p.match_id, p]));

  goalsByMatch = new Map();
  for (const g of (goalsRes.data ?? [])) {
    if (!goalsByMatch.has(g.match_id)) goalsByMatch.set(g.match_id, []);
    goalsByMatch.get(g.match_id).push(g);
  }

  slotResolution = computeSlotResolution();
}

// ============================================================
// Helpers
// ============================================================
function isRealTeam(name) {
  if (!name) return false;
  return !/^[\dLW]/.test(name) && !name.includes('/');
}

/**
 * Computa qual time deveria ocupar cada slot ("1A", "W73") com base nos
 * palpites do usuário. Retorna Map<slot, {team, source}>.
 *   source: 'pred-group' | 'pred-ko' | 'real'
 */
function computeSlotResolution() {
  const res = new Map();
  const thirdsRanked = [];  // [{ group, team, pts, sg, gp, source }]

  // === 1) Group winners (1X), runners-up (2X) e third (3X) ===
  const groupLetters = [...new Set(allMatches.filter(m => m.group_name).map(m => m.group_name))];
  for (const g of groupLetters) {
    const groupMatches = allMatches.filter(m => m.group_name === g && m.stage === 'group');
    const allFinished = groupMatches.every(m => m.finished);
    const allPredicted = groupMatches.every(m => predsByMatch.has(m.id));

    let standings, source;
    if (allFinished) {
      standings = computeStandings(groupMatches, /* useReal= */ true);
      source = 'real';
    } else if (allPredicted) {
      standings = computeStandings(groupMatches, /* useReal= */ false);
      source = 'pred-group';
    } else {
      continue;  // dados incompletos pra esse grupo
    }

    if (standings.length >= 2) {
      res.set('1' + g, { team: standings[0].team, source });
      res.set('2' + g, { team: standings[1].team, source });
    }
    if (standings[2]) {
      res.set('3' + g, { team: standings[2].team, source });
      thirdsRanked.push({
        group: g,
        team: standings[2].team,
        pts: standings[2].pts,
        sg: standings[2].sg,
        gp: standings[2].gp,
        source,
      });
    }
  }

  // === 1.5) Slots compostos de 3ºs lugares (3A/B/C/D/F, 3C/D/F/G/H, etc.) ===
  // Ordena os 3ºs por critério FIFA: PTS → SG → GP
  thirdsRanked.sort((a, b) =>
    b.pts - a.pts || b.sg - a.sg || b.gp - a.gp
  );
  // Greedy: pra cada slot composto, atribui o melhor 3º disponível cujo grupo está na lista
  const usedThirds = new Set();
  // Ordena slots por match_id (R32 vem primeiro)
  const koMatchesSorted = [...matches].sort((a, b) => a.id - b.id);
  for (const m of koMatchesSorted) {
    for (const side of ['team_home', 'team_away']) {
      const slot = m[side];
      if (!slot || !slot.startsWith('3') || !slot.includes('/')) continue;
      // Slot tipo "3A/B/C/D/F"
      const validGroups = slot.slice(1).split('/');
      const candidate = thirdsRanked.find(t =>
        validGroups.includes(t.group) && !usedThirds.has(t.team)
      );
      if (candidate) {
        res.set(slot, { team: candidate.team, source: candidate.source });
        usedThirds.add(candidate.team);
      }
    }
  }

  // === 2) W### e L### dos jogos de mata-mata ===
  // Itera em ordem de match_date (R32 → R16 → QF → SF → Final) para que
  // jogos posteriores possam usar resoluções de jogos anteriores.
  const koSorted = [...matches].sort((a, b) => new Date(a.match_date) - new Date(b.match_date));
  for (const m of koSorted) {
    const homeTeam = resolveSlotToTeam(m.team_home, res);
    const awayTeam = resolveSlotToTeam(m.team_away, res);

    // Se algum lado não resolveu, pula
    if (!homeTeam || !awayTeam) continue;

    // Usa resultado real se finalizado
    let winner, loser, source = 'pred-ko';
    if (m.finished && m.actual_home != null && m.actual_away != null) {
      if (m.actual_home > m.actual_away) { winner = homeTeam; loser = awayTeam; source = 'real'; }
      else if (m.actual_away > m.actual_home) { winner = awayTeam; loser = homeTeam; source = 'real'; }
      else if (m.pen_winner === 'home') { winner = homeTeam; loser = awayTeam; source = 'real'; }
      else if (m.pen_winner === 'away') { winner = awayTeam; loser = homeTeam; source = 'real'; }
    } else {
      // Usa palpite do user
      const p = predsByMatch.get(m.id);
      if (!p || p.pred_home == null || p.pred_away == null) continue;
      if (p.pred_home > p.pred_away) { winner = homeTeam; loser = awayTeam; }
      else if (p.pred_away > p.pred_home) { winner = awayTeam; loser = homeTeam; }
      else if (p.pred_pen_winner === 'home') { winner = homeTeam; loser = awayTeam; }
      else if (p.pred_pen_winner === 'away') { winner = awayTeam; loser = homeTeam; }
      else continue;  // empate sem pen winner
    }

    res.set('W' + m.id, { team: winner, source });
    res.set('L' + m.id, { team: loser, source });
  }

  return res;
}

/**
 * Resolve uma string de slot para o nome do time, se possível.
 * Retorna null se não conseguir resolver.
 */
function resolveSlotToTeam(slot, res) {
  if (!slot) return null;
  if (isRealTeam(slot)) return slot;
  const entry = res.get(slot);
  return entry?.team ?? null;
}

/**
 * Adapter: chama computeStandings do util com formato esperado aqui.
 */
function computeStandings(groupMatches, useReal) {
  return utilComputeStandings(groupMatches, useReal ? 'real' : 'sim', predsByMatch);
}

function teamDisplay(slot) {
  if (isRealTeam(slot)) return teamPt(slot);
  // Slot human-readable
  // "1A" → "1º Grupo A", "2B" → "2º Grupo B"
  // "3A/B/C/D/F" → "3º A/B/C/D/F"
  // "W73" → "Vencedor M73", "L101" → "Perdedor M101"
  if (/^\d[A-L]$/.test(slot)) return `${slot[0]}º Grupo ${slot[1]}`;
  if (/^3[A-Z/]+$/.test(slot)) return `3º ${slot.slice(1)}`;
  if (/^W\d+$/.test(slot)) return `Venc. M${slot.slice(1)}`;
  if (/^L\d+$/.test(slot)) return `Perd. M${slot.slice(1)}`;
  return slot;
}

function totalPotentialPoints() {
  // Pontos máximos teóricos por jogo: placar exato (5) × multiplicador da fase
  return matches.reduce((sum, m) => {
    const mult = STAGES.find(s => s.id === m.stage)?.mult
              || (m.stage === 'third' ? 2.0 : 1.0);
    return sum + Math.round(5 * mult);
  }, 0);
}

// ============================================================
// Render
// ============================================================
function renderPage() {
  const counts = computeCounts();
  return `
    <section class="hero">
      <div class="hero-kicker">Mata-mata</div>
      <h1 class="hero-title">${activeTab === 'palpites' ? 'Seus palpites' : 'Resultados'}</h1>
      <div class="hero-meta">
        <b>${matches.length} jogos</b><span class="sep"></span>
        Multiplicador ×1.5 → ×4 (final)<span class="sep"></span>
        <b>${counts.totalDone}</b> palpitados<span class="sep"></span>
        <b>${counts.totalFinished}</b> finalizados
      </div>
    </section>

    <div class="admin-tabs">
      <button class="admin-tab ${activeTab === 'palpites' ? 'active' : ''}" data-tab="palpites">
        Palpites <span class="ct">${counts.totalRemaining}</span>
      </button>
      <button class="admin-tab ${activeTab === 'resultados' ? 'active' : ''}" data-tab="resultados">
        Resultados <span class="ct">${counts.totalFinished}</span>
      </button>
    </div>

    <div id="tabBody">
      ${activeTab === 'palpites' ? renderPalpitesTab(counts) : renderResultadosTab(counts)}
    </div>
  `;
}


function renderPalpitesTab(counts) {
  const grouped = groupByStage();
  return `
    <div class="note" style="margin-bottom:20px; padding:12px 16px; background:var(--card); border-left:3px solid var(--gold); border-radius:0 6px 6px 0; font-size:12px; color:var(--text-dim);">
      <strong style="color:var(--gold);">Como funciona:</strong>
      Palpites travam no apito de cada jogo. Slots (1º A, 2º B, etc.) viram times reais quando os grupos terminam. Empate → escolha o vencedor dos pênaltis.
    </div>

    ${renderKpis(counts)}

    <div class="bracket-wrap">
      <div class="bracket">
        ${STAGES.map(stage => renderStageColumn(stage, grouped)).join('')}
      </div>
    </div>
  `;
}

function renderResultadosTab(counts) {
  const finished = matches.filter(m => m.finished);
  if (finished.length === 0) {
    return `
      <div class="empty">
        <h3>Nenhum resultado ainda</h3>
        <p>Os jogos de mata-mata começam em 28 de junho. Os resultados aparecem aqui conforme o admin lança os placares.</p>
      </div>
    `;
  }
  return `
    ${renderKpisResultados(counts)}
    ${renderResultadosList(finished)}
  `;
}

function renderKpisResultados(counts) {
  const total = counts.totalFinishedWithPred;
  const avg = total > 0 ? (counts.totalPoints / total).toFixed(1) : '0';
  return `
    <div class="kpis">
      <div class="kpi gold">
        <div class="kpi-label">Pontos ganhos</div>
        <div class="kpi-num">${counts.totalPoints}</div>
        <div class="kpi-sub">média ${avg} pts/jogo</div>
      </div>
      <div class="kpi green">
        <div class="kpi-label">Placares exatos</div>
        <div class="kpi-num">${counts.exactCount}</div>
        <div class="kpi-sub">vale 5 × mult cada</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Acertos parciais</div>
        <div class="kpi-num">${counts.partialCount}</div>
        <div class="kpi-sub">de ${total}</div>
      </div>
      <div class="kpi red">
        <div class="kpi-label">Erros</div>
        <div class="kpi-num">${counts.missCount}</div>
        <div class="kpi-sub">0 pts ganhos</div>
      </div>
    </div>
  `;
}

function renderResultadosList(finished) {
  // Ordem: mais recente primeiro
  const sorted = [...finished].sort((a, b) => new Date(b.match_date) - new Date(a.match_date));
  return sorted.map(renderResultCard).join('');
}

function renderResultCard(m) {
  const pred = predsByMatch.get(m.id);
  const pts = pred?.points_earned;
  const mult = STAGES.find(s => s.id === m.stage)?.mult || (m.stage === 'third' ? 2.0 : 1.0);
  const cardClass = pts >= Math.round(5 * mult) ? 'exact' : (pts > 0 ? 'partial' : 'miss');
  const ptsLabel = pts >= Math.round(5 * mult) ? 'Exato!' : pts > 0 ? 'Parcial' : (pred ? 'Errou' : 'Sem palpite');
  // Extra: classe especial pra final/3º lugar
  const stageClass = m.stage === 'final' ? 'final' : m.stage === 'third' ? 'third' : '';

  const goals = goalsByMatch.get(m.id) ?? [];
  const homeGoals = goals.filter(g => g.players.team === m.team_home);
  const awayGoals = goals.filter(g => g.players.team === m.team_away);

  const stageDisplay = m.stage === 'third' ? '🥉 3º Lugar'
    : m.stage === 'final' ? '🏆 Final'
    : STAGES.find(s => s.id === m.stage)?.label || m.stage;

  return `
    <div class="result-card ${cardClass} ${stageClass}">
      <div class="result-card-head">
        <div class="result-card-team">
          <span class="flag">${flag(m.team_home)}</span>
          <span class="team-name" data-team="${escapeHtml(m.team_home)}">${escapeHtml(teamPt(m.team_home))}</span>
        </div>
        <div class="result-card-score">${m.actual_home} — ${m.actual_away}${m.pen_winner ? `<small style="font-size:13px; color:var(--text-mute); display:block; font-weight:700;">pen: ${m.pen_winner === 'home' ? teamPt(m.team_home) : teamPt(m.team_away)}</small>` : ''}</div>
        <div class="result-card-team right">
          <span class="team-name" data-team="${escapeHtml(m.team_away)}">${escapeHtml(teamPt(m.team_away))}</span>
          <span class="flag">${flag(m.team_away)}</span>
        </div>
      </div>

      <div class="result-card-bottom">
        <div class="result-card-info">
          ${pred
            ? `<span>Seu palpite:</span> <span class="pred-score">${pred.pred_home} – ${pred.pred_away}</span>${pred.pred_pen_winner ? ` <small style="color:var(--text-mute)">pen: ${pred.pred_pen_winner === 'home' ? 'casa' : 'fora'}</small>` : ''}`
            : `<span style="color:var(--text-mute); font-style:italic;">Sem palpite</span>`}
        </div>
        <div class="result-card-points">
          <span class="num">${pts != null ? (pts > 0 ? '+' + pts : pts) : '—'}</span>
          <span class="label">${ptsLabel}</span>
        </div>
        <div class="result-card-meta">
          ${formatBrDateShort(new Date(m.match_date))} · ${formatTime(m.match_date)}
          <br><span class="stage">${stageDisplay} · ×${mult}</span>
        </div>
      </div>

      ${goals.length > 0 ? `
        <div class="result-card-scorers">
          <span class="label">⚽ Gols:</span>
          ${homeGoals.map(g => `<span class="scorer">${escapeHtml(g.players.full_name)} <span class="num">${g.goals}'</span></span>`).join('')}
          ${homeGoals.length && awayGoals.length ? '<span style="color:var(--text-mute); margin: 0 4px;">·</span>' : ''}
          ${awayGoals.map(g => `<span class="scorer">${escapeHtml(g.players.full_name)} <span class="num">${g.goals}'</span></span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function formatBrDateShort(d) {
  return `${String(d.getDate()).padStart(2,'0')}/${MEZES[d.getMonth()]}`;
}

function renderKpis(counts) {
  const pct = matches.length ? Math.round(counts.totalDone / matches.length * 100) : 0;
  return `
    <div class="kpis">
      <div class="kpi green">
        <div class="kpi-label">Palpitados</div>
        <div class="kpi-num">${counts.totalDone}<small>/${matches.length}</small></div>
        <div class="progress-bar-inline"><span style="width:${pct}%"></span></div>
      </div>
      <div class="kpi red">
        <div class="kpi-label">Faltando</div>
        <div class="kpi-num">${counts.totalRemaining}</div>
        <div class="kpi-sub">${counts.totalRemaining === 0 ? 'tudo pronto ✓' : 'jogos pendentes'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Travados</div>
        <div class="kpi-num">${counts.totalLocked}</div>
        <div class="kpi-sub">jogos já iniciados</div>
      </div>
      <div class="kpi gold">
        <div class="kpi-label">Pontos máx</div>
        <div class="kpi-num">${totalPotentialPoints()}</div>
        <div class="kpi-sub">se acertar tudo exato</div>
      </div>
    </div>
  `;
}

function groupByStage() {
  // Agrupa por stage. Final + third entram juntos numa coluna 'final'.
  const map = { r32: [], r16: [], qf: [], sf: [], final: [] };
  for (const m of matches) {
    if (m.stage === 'third' || m.stage === 'final') map.final.push(m);
    else if (map[m.stage]) map[m.stage].push(m);
  }
  // Ordena por data dentro de cada fase
  for (const arr of Object.values(map)) {
    arr.sort((a, b) => new Date(a.match_date) - new Date(b.match_date));
  }
  return map;
}

function renderStageColumn(stage, grouped) {
  const list = grouped[stage.id] || [];
  return `
    <div class="bracket-col">
      <h4>
        ${escapeHtml(stage.label)}
        <span class="mult">×${stage.mult}</span>
        <span class="count">${list.length} jogo${list.length !== 1 ? 's' : ''}</span>
      </h4>
      ${list.map(renderBracketMatch).join('')}
    </div>
  `;
}

function renderBracketMatch(m) {
  const pred = predsByMatch.get(m.id);
  const locked = isLocked(m);
  const homeVal = pred?.pred_home ?? '';
  const awayVal = pred?.pred_away ?? '';

  const homeIsDraw = homeVal !== '' && awayVal !== '' && parseInt(homeVal) === parseInt(awayVal);
  const showPen = !locked && homeIsDraw;
  const penWinner = pred?.pred_pen_winner;

  const dt = new Date(m.match_date);
  const dateLabel = `${String(dt.getDate()).padStart(2,'0')}/${MEZES[dt.getMonth()]}`;
  const timeLabel = formatTime(m.match_date);

  const isFinal = m.stage === 'final';
  const isThird = m.stage === 'third';
  const classes = ['bracket-match'];
  if (locked) classes.push('locked');
  if (isFinal) classes.push('final-match');
  if (isThird) classes.push('third-place');

  const pointsBadge = pred?.points_earned != null
    ? `<div class="bm-pts ${pred.points_earned > 0 ? 'win' : ''}">
         ${pred.points_earned > 0 ? '+' : ''}${pred.points_earned} pts
       </div>`
    : '';

  return `
    <div class="${classes.join(' ')}" data-match-id="${m.id}">
      <div class="bm-id">
        <span>${isThird ? '🥉 3º Lugar' : isFinal ? '🏆 Final' : `M${m.id}`}</span>
        <span class="when">${dateLabel} · ${timeLabel}</span>
      </div>

      ${renderTeamRow(m, 'home', homeVal, locked)}
      ${renderTeamRow(m, 'away', awayVal, locked)}

      ${showPen ? renderPenToggle(m, penWinner) : ''}

      ${pointsBadge}
    </div>
  `;
}

function renderPenToggle(m, penWinner) {
  // Pega os times resolvidos pra mostrar bandeira + nome
  const homeTeam = isRealTeam(m.team_home) ? m.team_home : slotResolution.get(m.team_home)?.team;
  const awayTeam = isRealTeam(m.team_away) ? m.team_away : slotResolution.get(m.team_away)?.team;

  const homeLabel = homeTeam ? teamPt(homeTeam) : 'Casa';
  const awayLabel = awayTeam ? teamPt(awayTeam) : 'Fora';
  const homeFlag = homeTeam ? flag(homeTeam) : '🏠';
  const awayFlag = awayTeam ? flag(awayTeam) : '✈️';

  return `
    <div class="bm-pen-wrap">
      <div class="bm-pen-title">Empate — quem ganha nos pênaltis?</div>
      <div class="bm-pen">
        <button class="${penWinner === 'home' ? 'active' : ''}" data-action="set-pen" data-match-id="${m.id}" data-side="home" title="${escapeHtml(homeLabel)}">
          <span class="flag">${homeFlag}</span>
          <span class="nm">${escapeHtml(homeLabel)}</span>
        </button>
        <span class="bm-pen-vs">vs</span>
        <button class="${penWinner === 'away' ? 'active' : ''}" data-action="set-pen" data-match-id="${m.id}" data-side="away" title="${escapeHtml(awayLabel)}">
          <span class="flag">${awayFlag}</span>
          <span class="nm">${escapeHtml(awayLabel)}</span>
        </button>
      </div>
    </div>
  `;
}

function renderTeamRow(m, side, val, locked) {
  const slot = side === 'home' ? m.team_home : m.team_away;
  const isReal = isRealTeam(slot);
  const resolved = !isReal ? slotResolution.get(slot) : null;
  const team = isReal ? slot : (resolved?.team ?? null);
  const showFlag = !!team;
  const source = resolved?.source;
  const isPredSource = source === 'pred-group' || source === 'pred-ko';

  let nameHtml;
  if (team) {
    const sourceBadge = isPredSource
      ? '<span class="pred-source" title="Baseado nos seus palpites">P</span>'
      : '';
    const sublabel = !isReal
      ? `<div class="slot-sublabel">${escapeHtml(teamDisplay(slot))}</div>`
      : '';
    nameHtml = `
      <div class="nm">
        <div class="team-line">
          <span class="team-name" data-team="${escapeHtml(team)}">${escapeHtml(teamPt(team))}</span>
          ${sourceBadge}
        </div>
        ${sublabel}
      </div>`;
  } else {
    nameHtml = `<div class="nm slot">${escapeHtml(teamDisplay(slot))}</div>`;
  }

  return `
    <div class="bm-team">
      ${showFlag ? `<span class="flag">${flag(team)}</span>` : '<span></span>'}
      ${nameHtml}
      <input class="mini-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2"
             data-match="${m.id}" data-side="${side}"
             value="${val}" ${locked ? 'disabled' : ''}>
    </div>
  `;
}

function computeCounts() {
  let totalDone = 0, totalLocked = 0, totalFinished = 0;
  let totalPoints = 0, exactCount = 0, partialCount = 0, missCount = 0, totalFinishedWithPred = 0;

  for (const m of matches) {
    const p = predsByMatch.get(m.id);
    if (p) totalDone++;
    if (isLocked(m)) totalLocked++;
    if (m.finished) totalFinished++;

    if (m.finished && p) {
      totalFinishedWithPred++;
      const pts = p.points_earned ?? 0;
      totalPoints += pts;
      const mult = STAGES.find(s => s.id === m.stage)?.mult || (m.stage === 'third' ? 2.0 : 1.0);
      if (pts >= Math.round(5 * mult)) exactCount++;
      else if (pts > 0) partialCount++;
      else missCount++;
    }
  }

  return {
    totalDone,
    totalRemaining: matches.length - totalDone,
    totalLocked,
    totalFinished,
    totalFinishedWithPred,
    totalPoints,
    exactCount,
    partialCount,
    missCount,
  };
}

// ============================================================
// Eventos
// ============================================================
function attachEventListeners() {
  document.addEventListener('input', (e) => {
    const input = e.target.closest('.mini-input[data-match]');
    if (!input) return;
    sanitizeInput(input);
    const matchId = parseInt(input.dataset.match, 10);

    // Atualiza estado local IMEDIATAMENTE (não espera o save)
    const card = input.closest('.bracket-match');
    const homeInput = card.querySelector('input[data-side="home"]');
    const awayInput = card.querySelector('input[data-side="away"]');
    const h = homeInput.value === '' ? null : parseInt(homeInput.value, 10);
    const a = awayInput.value === '' ? null : parseInt(awayInput.value, 10);

    const existing = predsByMatch.get(matchId) ?? { match_id: matchId, user_id: profile.id, pred_pen_winner: null };
    existing.pred_home = h;
    existing.pred_away = a;
    predsByMatch.set(matchId, existing);

    // Re-render SOMENTE se estado de empate mudou (mostrar/esconder pen toggle)
    const hasPenToggle = !!card.querySelector('.bm-pen-wrap');
    const isDrawNow = h !== null && a !== null && h === a;
    if (hasPenToggle !== isDrawNow) {
      rerenderMatchAndKeepFocus(matchId);
    }

    scheduleSave(matchId);
  });

  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.admin-tab[data-tab]');
    if (tabBtn) {
      const t = tabBtn.dataset.tab;
      if (t !== activeTab) {
        activeTab = t;
        const pageBody = document.getElementById('pageBody');
        if (pageBody) pageBody.innerHTML = renderPage();
      }
      return;
    }

    const penBtn = e.target.closest('[data-action="set-pen"]');
    if (penBtn) {
      const matchId = parseInt(penBtn.dataset.matchId, 10);
      const side = penBtn.dataset.side;
      setPenWinner(matchId, side);
    }
  });
}

function sanitizeInput(input) {
  const v = input.value;
  if (v === '') return;
  let n = parseInt(v, 10);
  if (isNaN(n)) { input.value = ''; return; }
  if (n < 0) n = 0;
  if (n > 20) n = 20;
  if (String(n) !== v) input.value = n;
}

function setPenWinner(matchId, side) {
  const pred = predsByMatch.get(matchId) ?? { match_id: matchId, user_id: profile.id };
  pred.pred_pen_winner = side;
  predsByMatch.set(matchId, pred);
  rerenderMatchAndKeepFocus(matchId);
  scheduleSave(matchId);
}

function scheduleSave(matchId) {
  if (saveTimers.has(matchId)) clearTimeout(saveTimers.get(matchId));
  const handle = setTimeout(() => doSave(matchId), 700);
  saveTimers.set(matchId, handle);
}

async function doSave(matchId) {
  const card = document.querySelector(`.bracket-match[data-match-id="${matchId}"]`);
  const home = card?.querySelector('input[data-side="home"]');
  const away = card?.querySelector('input[data-side="away"]');
  if (!home || !away) return;

  const h = home.value === '' ? null : parseInt(home.value, 10);
  const a = away.value === '' ? null : parseInt(away.value, 10);
  if (h === null || a === null || isNaN(h) || isNaN(a)) return;

  const pred = predsByMatch.get(matchId);
  const penWinner = (h === a && pred?.pred_pen_winner) ? pred.pred_pen_winner : null;

  // Empate sem pen winner → não salva ainda (espera o user marcar)
  if (h === a && !penWinner) {
    return;
  }

  card.classList.remove('saved', 'error');
  card.classList.add('saving');

  const { data, error } = await supabase
    .from('predictions')
    .upsert(
      {
        user_id: profile.id,
        match_id: matchId,
        pred_home: h,
        pred_away: a,
        pred_pen_winner: penWinner,
      },
      { onConflict: 'user_id,match_id' }
    )
    .select()
    .single();

  card.classList.remove('saving');

  if (error) {
    console.error('[mata save error]', error);
    card.classList.add('error');
    showToast('Erro ao salvar: ' + (error.message || 'desconhecido'), 'error', 3500);
    return;
  }

  predsByMatch.set(matchId, data);
  card.classList.add('saved');

  // Recomputa resolução dos slots (palpite pode ter mudado W{id} / L{id})
  slotResolution = computeSlotResolution();

  const m = matches.find(mm => mm.id === matchId);
  const homeName = resolveSlotToTeam(m.team_home, slotResolution) ?? teamDisplay(m.team_home);
  const awayName = resolveSlotToTeam(m.team_away, slotResolution) ?? teamDisplay(m.team_away);
  showToast(`Salvo ${teamPt(homeName)} ${h}–${a} ${teamPt(awayName)}`, 'success', 1500);
  updateKpis();
  rerenderAllBracketRows();
}

/**
 * Re-renderiza todos os cards do bracket (mantém os de mata-mata
 * em sincronia quando um W{X}/L{X} muda).
 */
function rerenderAllBracketRows() {
  // Salva foco
  const focused = document.activeElement;
  let focusInfo = null;
  if (focused && focused.dataset?.match) {
    focusInfo = {
      matchId: focused.dataset.match,
      side: focused.dataset.side,
      start: focused.selectionStart,
      end: focused.selectionEnd,
    };
  }

  for (const m of matches) {
    const card = document.querySelector(`.bracket-match[data-match-id="${m.id}"]`);
    if (!card) continue;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderBracketMatch(m);
    card.replaceWith(wrapper.firstElementChild);
  }

  if (focusInfo) {
    const el = document.querySelector(
      `.bracket-match[data-match-id="${focusInfo.matchId}"] input[data-side="${focusInfo.side}"]`
    );
    if (el) {
      el.focus();
      if (focusInfo.start != null) {
        try { el.setSelectionRange(focusInfo.start, focusInfo.end); } catch {}
      }
    }
  }
}

function rerenderMatchAndKeepFocus(matchId) {
  const card = document.querySelector(`.bracket-match[data-match-id="${matchId}"]`);
  if (!card) return;
  const m = matches.find(mm => mm.id === matchId);
  if (!m) return;

  const focused = document.activeElement;
  let focusInfo = null;
  if (focused && card.contains(focused) && focused.dataset.side) {
    focusInfo = {
      side: focused.dataset.side,
      start: focused.selectionStart,
      end: focused.selectionEnd,
    };
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderBracketMatch(m);
  const newCard = wrapper.firstElementChild;
  card.replaceWith(newCard);

  if (focusInfo) {
    const newInput = newCard.querySelector(`input[data-side="${focusInfo.side}"]`);
    if (newInput) {
      newInput.focus();
      if (focusInfo.start != null) {
        try { newInput.setSelectionRange(focusInfo.start, focusInfo.end); } catch {}
      }
    }
  }
}

function updateKpis() {
  const counts = computeCounts();
  const kpis = document.querySelector('.kpis');
  if (kpis) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderKpis(counts);
    kpis.replaceWith(wrapper.firstElementChild);
  }
}

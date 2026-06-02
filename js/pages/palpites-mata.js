import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, formatTime, isLocked, showToast,
  attachTeamTooltips, loadRecentMatches, teamPt,
  computeStandings as utilComputeStandings,
} from '../util.js';
import { fifaRank } from '../fifa-rank.js';
import { matchPoints, scoreBreakdown } from '../scoring.js';

// ============================================================
// Constantes
// ============================================================
// Colunas do bracket. A coluna "final" agrupa Final + 3º lugar.
const STAGES = [
  { id: 'r32',   label: '32-avos' },
  { id: 'r16',   label: 'Oitavas' },
  { id: 'qf',    label: 'Quartas' },
  { id: 'sf',    label: 'Semifinais' },
  { id: 'final', label: 'Final & 3º lugar' },
];

// Placar exato de cada fase (pontuação aditiva, vem de js/scoring.js — sem drift).
function stageExact(stageId) { return matchPoints(stageId).exact; }

const MEZES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

// ============================================================
// Estado
// ============================================================
let profile, stats;
let matches = [];                    // 32 matches KO
let allMatches = [];                 // 104 matches (incluindo grupos)
let predsByMatch = new Map();        // match_id -> prediction row (TODAS as predictions)
let goalsByMatch = new Map();        // match_id -> [{player, goals}]
let slotResolution = new Map();      // slot string -> { team, source } (real-first: resultado real ou palpite)
let predSlotResolution = new Map();  // slot string -> { team, source } (apenas palpites do user)
let qualifierBySide = new Map();     // "matchId:side" -> { kind:'bpe'|'bp', pts, pred, actual } (do cache SQL)
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
  const [statsRes, matchesRes, predsRes, goalsRes, qualRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    supabase.from('matches').select('*').order('match_date'),
    supabase.from('predictions').select('*').eq('user_id', profile.id),
    supabase.from('player_goals').select('*, players(full_name, team)'),
    supabase.from('user_qualifier_points').select('breakdown').eq('user_id', profile.id).maybeSingle(),
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

  slotResolution = computeSlotResolution('real-first');
  predSlotResolution = computeSlotResolution('pred-only');

  // Bônus de classificado (BPE/BP) — fonte da verdade é o cache SQL (user_qualifier_points).
  // Só exibimos o que foi gravado; não recalculamos no cliente.
  qualifierBySide = new Map();
  const items = qualRes.data?.breakdown?.items ?? [];
  for (const it of items) {
    qualifierBySide.set(`${it.match_id}:${it.side}`, it);
  }
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
 *
 * @param {string} mode - 'real-first' (default): usa resultado real se houver, senão palpite.
 *                       'pred-only': sempre usa o palpite do user (ignora resultado real).
 */
function computeSlotResolution(mode = 'real-first') {
  const res = new Map();
  const thirdsRanked = [];  // [{ group, team, pts, sg, gp, source }]
  const usePredOnly = mode === 'pred-only';

  // === 1) Group winners (1X), runners-up (2X) e third (3X) ===
  const groupLetters = [...new Set(allMatches.filter(m => m.group_name).map(m => m.group_name))];
  for (const g of groupLetters) {
    const groupMatches = allMatches.filter(m => m.group_name === g && m.stage === 'group');
    const allFinished = groupMatches.every(m => m.finished);
    const allPredicted = groupMatches.every(m => predsByMatch.has(m.id));

    let standings, source;
    if (!usePredOnly && allFinished) {
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
  // Desempate oficial: pts → SG → GF → FIFA rank (igual DB resolve_match_slots e terceiros.js)
  thirdsRanked.sort((a, b) =>
    b.pts - a.pts || b.sg - a.sg || b.gp - a.gp || fifaRank(a.team) - fifaRank(b.team)
  );
  const usedThirds = new Set();
  const koMatchesSorted = [...matches].sort((a, b) => a.id - b.id);
  for (const m of koMatchesSorted) {
    // Use slot_home/slot_away (original slot reference) — team_home may already be resolved to a real team
    for (const slotKey of [m.slot_home, m.slot_away]) {
      if (!slotKey || !slotKey.startsWith('3') || !slotKey.includes('/')) continue;
      const validGroups = slotKey.slice(1).split('/');
      const candidate = thirdsRanked.find(t =>
        validGroups.includes(t.group) && !usedThirds.has(t.team)
      );
      if (candidate) {
        res.set(slotKey, { team: candidate.team, source: candidate.source });
        usedThirds.add(candidate.team);
      }
    }
  }

  // === 2) W### e L### dos jogos de mata-mata ===
  // Use slot_home/slot_away (original slot references) instead of team_home/team_away
  // (which may have been overwritten with real teams by the DB trigger).
  const koSorted = [...matches].sort((a, b) => new Date(a.match_date) - new Date(b.match_date));
  for (const m of koSorted) {
    // Resolve each side using the slot reference (W73, 1A, etc.) when present
    const homeSlot = m.slot_home || m.team_home;
    const awaySlot = m.slot_away || m.team_away;
    const homeTeam = resolveSlotToTeam(homeSlot, res);
    const awayTeam = resolveSlotToTeam(awaySlot, res);

    if (!homeTeam || !awayTeam) continue;

    let winner, loser, source = 'pred-ko';
    if (!usePredOnly && m.finished && m.actual_home != null && m.actual_away != null) {
      if (m.actual_home > m.actual_away) { winner = homeTeam; loser = awayTeam; source = 'real'; }
      else if (m.actual_away > m.actual_home) { winner = awayTeam; loser = homeTeam; source = 'real'; }
      else if (m.pen_winner === 'home') { winner = homeTeam; loser = awayTeam; source = 'real'; }
      else if (m.pen_winner === 'away') { winner = awayTeam; loser = homeTeam; source = 'real'; }
    } else {
      const p = predsByMatch.get(m.id);
      if (!p || p.pred_home == null || p.pred_away == null) continue;
      if (p.pred_home > p.pred_away) { winner = homeTeam; loser = awayTeam; }
      else if (p.pred_away > p.pred_home) { winner = awayTeam; loser = homeTeam; }
      else if (p.pred_pen_winner === 'home') { winner = homeTeam; loser = awayTeam; }
      else if (p.pred_pen_winner === 'away') { winner = awayTeam; loser = homeTeam; }
      else continue;
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
  // Pontos máximos teóricos por jogo: o placar exato de cada fase.
  return matches.reduce((sum, m) => sum + stageExact(m.stage), 0);
}

// Acertou o placar exato deste jogo?
function isExactPred(m, pred) {
  return !!pred && m.finished
    && pred.pred_home === m.actual_home && pred.pred_away === m.actual_away;
}

// ============================================================
// Render
// ============================================================
function renderPage() {
  const counts = computeCounts();
  return `
    <section class="hero">
      <div class="hero-kicker">Palpitar placares · Mata-mata</div>
      <h1 class="hero-title">${activeTab === 'palpites' ? 'Seus palpites' : 'Meus resultados'}</h1>
      <div class="hero-meta">
        <b>${matches.length} jogos</b><span class="sep"></span>
        Quanto mais perto da final, mais pontos<span class="sep"></span>
        <b>${counts.totalDone}</b> palpitados
      </div>
    </section>

    <div class="admin-tabs">
      <button class="admin-tab ${activeTab === 'palpites' ? 'active' : ''}" data-tab="palpites">
        Palpites <span class="ct">${counts.totalRemaining}</span>
      </button>
      <button class="admin-tab ${activeTab === 'resultados' ? 'active' : ''}" data-tab="resultados">
        Meus resultados <span class="ct">${counts.totalFinished}</span>
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
    <div class="note">
      <span class="note-head">Como funcionam os palpites do mata-mata</span>
      <ul class="note-list">
        <li>📈 <strong>Cada fase vale mais.</strong> Placar exato: 32-avos ${stageExact('r32')} · oitavas ${stageExact('r16')} · quartas ${stageExact('qf')} · semis ${stageExact('sf')} · 3º lugar ${stageExact('third')} · <strong>final ${stageExact('final')}</strong> pontos.</li>
        <li>➕ Não precisa cravar tudo — cada parte do placar (gols de um time, quem vence, diferença) já dá pontos.</li>
        <li>🏳️ <strong>Regra da vaga:</strong> você dá o placar de uma posição (ex.: "1º do Grupo A × 2º do Grupo B"). Vale para a seleção que <strong>realmente se classificar</strong> ali — as bandeiras são só um guia.</li>
        <li>⚽ Acha que vai dar empate? <strong>Escolha quem passa nos pênaltis</strong> (conta o placar do tempo normal).</li>
      </ul>
      <span class="note-deadline">⏰ Cada palpite fecha às 23h59 da véspera do jogo (um dia antes).
        <span class="sub">As vagas viram seleções de verdade quando os grupos terminam.</span></span>
      <a class="note-link" href="regras.html">Ver todas as regras →</a>
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
  const grouped = groupByStage();
  return `
    ${renderKpisResultados(counts)}

    <div class="bracket-wrap">
      <div class="bracket">
        ${STAGES.map(stage => renderResultStageColumn(stage, grouped)).join('')}
      </div>
    </div>
  `;
}

function renderResultStageColumn(stage, grouped) {
  const list = grouped[stage.id] || [];
  return `
    <div class="bracket-col">
      <h4>
        ${escapeHtml(stage.label)}
        <span class="mult" title="Placar exato vale ${stageExact(stage.id)} pts">exato ${stageExact(stage.id)}</span>
        <span class="count">${list.length} jogo${list.length !== 1 ? 's' : ''}</span>
      </h4>
      ${list.map(renderResultBracketMatch).join('')}
    </div>
  `;
}

function renderResultBracketMatch(m) {
  const pred = predsByMatch.get(m.id);
  const pts = pred?.points_earned ?? 0;

  const dt = new Date(m.match_date);
  const dateLabel = `${String(dt.getDate()).padStart(2,'0')}/${MEZES[dt.getMonth()]}`;
  const timeLabel = formatTime(m.match_date);

  const isFinal = m.stage === 'final';
  const isThird = m.stage === 'third';

  let resultClass = '';
  if (m.finished && pred) {
    if (isExactPred(m, pred)) resultClass = 'exact';
    else if (pts > 0) resultClass = 'partial';
    else resultClass = 'miss';
  } else if (m.finished && !pred) {
    resultClass = 'no-pred';
  }

  const classes = ['bracket-match', 'result-mode'];
  if (isFinal) classes.push('final-match');
  if (isThird) classes.push('third-place');
  if (resultClass) classes.push(resultClass);
  if (m.finished) classes.push('finished');

  const pointsBadge = m.finished && pred
    ? renderPointsBadge(pts, stageExact(m.stage), resultClass)
    : (m.finished && !pred ? '<div class="bm-pts no-pred">sem palpite</div>' : '');

  // Quebra aditiva (lado / resultado / saldo) — só em jogo finalizado com palpite
  const breakdown = (m.finished && pred) ? renderBmBreak(m, pred) : '';

  return `
    <div class="${classes.join(' ')}" data-match-id="${m.id}">
      <div class="bm-id">
        <span>${isThird ? '🥉 3º Lugar' : isFinal ? '🏆 Final' : `M${m.id}`}</span>
        <span class="when">${dateLabel} · ${timeLabel}</span>
      </div>

      ${renderResultTeamRow(m, 'home')}
      ${renderResultTeamRow(m, 'away')}

      ${m.pen_winner ? `
        <div class="bm-pen-result">
          <span>⚽ Pênaltis:</span> ${m.pen_winner === 'home' ? teamPt(m.team_home) : teamPt(m.team_away)}
        </div>
      ` : ''}

      ${pred ? `
        <div class="bm-pred-compare">
          <span class="label">Seu palpite:</span>
          <span class="score">${pred.pred_home} – ${pred.pred_away}</span>
          ${pred.pred_pen_winner ? `<span class="pen">(pen: ${pred.pred_pen_winner === 'home' ? 'casa' : 'fora'})</span>` : ''}
        </div>
      ` : ''}

      ${breakdown}
      ${pointsBadge}
    </div>
  `;
}

// Quebra aditiva do palpite num card de resultado do bracket
function renderBmBreak(m, pred) {
  const { parts } = scoreBreakdown(
    pred.pred_home, pred.pred_away, pred.pred_pen_winner,
    m.actual_home, m.actual_away, m.pen_winner, m.stage,
  );
  if (parts.length === 0) return '';
  return `<div class="bm-break">${parts.map(p =>
    `<span class="brk ${p.key}">${p.label} <b>+${p.pts}</b></span>`).join('')}</div>`;
}

function renderResultTeamRow(m, side) {
  const team = side === 'home' ? m.team_home : m.team_away;
  const slotOriginal = side === 'home' ? m.slot_home : m.slot_away;
  const score = side === 'home' ? m.actual_home : m.actual_away;
  const isWinner = m.finished && (
    (side === 'home' && (m.actual_home > m.actual_away || (m.actual_home === m.actual_away && m.pen_winner === 'home'))) ||
    (side === 'away' && (m.actual_away > m.actual_home || (m.actual_home === m.actual_away && m.pen_winner === 'away')))
  );

  const slotBadge = slotOriginal ? `<span class="slot-badge" title="${escapeHtml(teamDisplay(slotOriginal))}">${escapeHtml(formatSlotShort(slotOriginal))}</span>` : '';

  return `
    <div class="bm-team ${isWinner ? 'winner' : ''}">
      <span class="flag">${flag(team)}</span>
      <div class="nm">
        <div class="team-line">
          <span class="team-name" data-team="${escapeHtml(team)}">${escapeHtml(teamPt(team))}</span>
          ${slotBadge}
        </div>
        ${renderQualBadge(m.id, side)}
      </div>
      <span class="result-score">${m.finished ? score : '–'}</span>
    </div>
  `;
}

// Selo de bônus de classificado (lê o breakdown gravado pelo SQL).
function renderQualBadge(matchId, side) {
  const q = qualifierBySide.get(`${matchId}:${side}`);
  if (!q) return '';
  if (q.kind === 'bpe') {
    return `<span class="qual-badge bpe" title="Acertou a seleção classificada nesta vaga">✓ classificado +${q.pts}</span>`;
  }
  return `<span class="qual-badge bp" title="Time certo na fase, vaga errada">~ time certo, vaga errada +${q.pts}</span>`;
}

function formatSlotShort(slot) {
  if (!slot) return '';
  if (/^\d[A-L]$/.test(slot)) return slot;
  if (/^3[A-Z/]+$/.test(slot)) return '3º';
  if (/^[WL]\d+$/.test(slot)) return slot;
  return slot;
}

/**
 * Selo de pontos do jogo: "+N pts" e, quando há máximo, "de M".
 * @param {number} pts pontos ganhos
 * @param {number} [max] placar exato da fase (referência)
 */
function renderPointsBadge(pts, max, extraClass = '') {
  if (pts == null) return '';
  // extraClass (exact/partial/miss) define a cor; sem ela, cai no 'win' antigo
  const cls = `bm-pts ${extraClass || (pts > 0 ? 'win' : '')}`.trim();
  if (max) {
    return `<div class="${cls}">
      <span class="formula">+${pts}<small> de ${max}</small></span>
    </div>`;
  }
  return `<div class="${cls}">${pts > 0 ? '+' : ''}${pts} pts</div>`;
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
        <div class="kpi-sub">vale mais a cada fase</div>
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
        <span class="mult" title="Placar exato vale ${stageExact(stage.id)} pts">exato ${stageExact(stage.id)}</span>
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
    ? renderPointsBadge(pred.points_earned, stageExact(m.stage))
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
  // Pega os times resolvidos pra mostrar bandeira + nome (usa palpites do user)
  const homeSlot = m.slot_home || m.team_home;
  const awaySlot = m.slot_away || m.team_away;
  const homeTeam = isRealTeam(homeSlot) ? homeSlot : predSlotResolution.get(homeSlot)?.team;
  const awayTeam = isRealTeam(awaySlot) ? awaySlot : predSlotResolution.get(awaySlot)?.team;

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
  // Para a aba Palpites, usa SEMPRE o slot original (slot_home/slot_away) e resolve
  // através do predSlotResolution (baseado APENAS nos palpites do user).
  // Assim o time mostrado é quem o USUÁRIO previu que avançaria, não o time real.
  const slotOriginal = side === 'home' ? m.slot_home : m.slot_away;
  const realTeam = side === 'home' ? m.team_home : m.team_away;

  // Se tem slot_home/away, usa ele; senão, é grupo (sem slot) e usa team_home/away direto
  const slot = slotOriginal || realTeam;
  const isReal = isRealTeam(slot);
  const resolved = !isReal ? predSlotResolution.get(slot) : null;
  const team = isReal ? slot : (resolved?.team ?? null);
  const showFlag = !!team;
  const source = resolved?.source;
  const isPredSource = source === 'pred-group' || source === 'pred-ko';

  const slotBadge = slotOriginal ? `<span class="slot-badge" title="${escapeHtml(teamDisplay(slotOriginal))}">${escapeHtml(formatSlotShort(slotOriginal))}</span>` : '';

  let nameHtml;
  if (team) {
    const sourceBadge = isPredSource
      ? '<span class="pred-source" title="Baseado nos seus palpites">P</span>'
      : '';
    nameHtml = `
      <div class="nm">
        <div class="team-line">
          <span class="team-name" data-team="${escapeHtml(team)}">${escapeHtml(teamPt(team))}</span>
          ${slotBadge}
          ${sourceBadge}
        </div>
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
             aria-label="Gols ${escapeHtml(team ? teamPt(team) : teamDisplay(slot))}"
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
      if (isExactPred(m, p)) exactCount++;
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
  slotResolution = computeSlotResolution('real-first');
  predSlotResolution = computeSlotResolution('pred-only');

  const m = matches.find(mm => mm.id === matchId);
  const homeSlot = m.slot_home || m.team_home;
  const awaySlot = m.slot_away || m.team_away;
  const homeName = resolveSlotToTeam(homeSlot, predSlotResolution) ?? teamDisplay(homeSlot);
  const awayName = resolveSlotToTeam(awaySlot, predSlotResolution) ?? teamDisplay(awaySlot);
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

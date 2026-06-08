import { requireAuth } from '../auth.js';
import { renderShell, refreshNavBadges } from '../sidebar.js';
import { KPI } from '../kpi-icons.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, formatTime, formatBrDate, isLocked, lockCountdownLabel, showToast,
  loadRecentMatches, loadQualifiers, teamPt, renderDateCalendar, predictionDeadline,
  localDateKey, brParts,
} from '../util.js';
import { isRealTeam, resolveSlotToTeam, computeSlotResolution } from '../bracket.js';
import { matchPoints, scoreBreakdown, stageMultiplier, scorerBonus, championBonus } from '../scoring.js';
import {
  renderRaioXModalButton, openRaioXModal, attachRaioXTabs,
} from '../raiox.js';

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

// Selos do cabeçalho de cada fase: placar exato + os dois multiplicadores
// (multiplicador de fase e bônus de artilheiro por gol), tudo de js/scoring.js.
function stageHeaderBadges(stageId) {
  const exact = stageExact(stageId);
  const multPt = String(stageMultiplier(stageId)).replace('.', ',');
  const scorer = scorerBonus(1, stageId);
  return `
    <span class="mult" title="Placar exato vale ${exact} pts">exato ${exact}</span>
    <span class="mult is-phase" title="Multiplicador desta fase (×${multPt})">fase ×${multPt}</span>
    <span class="mult is-scorer" title="Bônus de artilheiro: +${scorer} pts por gol do seu artilheiro nesta fase">artilheiro +${scorer}/gol</span>
  `;
}

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
let thirdSlotIndex = new Map();      // slot "3A/B/C/D/F" -> 1..8 (numera as vagas de melhor-3º)
let scorerPickId = null;             // player_id do artilheiro escolhido (bônus por gol)
let championPickTeam = null;         // time escolhido como campeão (bônus na final)
let realChampion = null;             // campeão real (vencedor da final, quando jogada)
let recentByTeam = new Map();        // team -> forma recente (Raio-X)
let qualifiers = null;               // assets/data/qualifiers.json — campanha de eliminatórias (Raio-X)
let viewMode = 'date';               // 'bracket' | 'date' — layout: chave ou lista por data (padrão: por data)
let activeDate = null;               // ISO yyyy-mm-dd quando viewMode === 'date'
const saveTimers = new Map();        // match_id -> setTimeout handle

// Rótulos curtos de fase (para o selo no card em "Por data").
const STAGE_LABELS = { r32: '32-avos', r16: 'Oitavas', qf: 'Quartas', sf: 'Semifinais', third: '3º lugar', final: 'Final' };

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  await loadData();

  // Forma recente (Raio-X) — antes alimentava o hover, agora o modal.
  recentByTeam = await loadRecentMatches();
  qualifiers = await loadQualifiers();

  const pageBody = await renderShell({ active: 'palpites-k', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');

  attachEventListeners();
  attachRaioXTabs();
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
  const [statsRes, matchesRes, predsRes, goalsRes, qualRes, scorerRes, champRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    supabase.from('matches').select('*').order('match_date'),
    supabase.from('predictions').select('*').eq('user_id', profile.id),
    supabase.from('player_goals').select('*, players(full_name, team)'),
    supabase.from('user_qualifier_points').select('breakdown').eq('user_id', profile.id).maybeSingle(),
    supabase.from('top_scorer_picks').select('player_id, players(full_name)').eq('user_id', profile.id).maybeSingle(),
    supabase.from('champion_picks').select('team').eq('user_id', profile.id).maybeSingle(),
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

  slotResolution = computeSlotResolution({ allMatches, matches, predsByMatch, mode: 'real-first' });
  predSlotResolution = computeSlotResolution({ allMatches, matches, predsByMatch, mode: 'pred-only' });

  // Bônus de classificado (BPE/BP) — fonte da verdade é o cache SQL (user_qualifier_points).
  // Só exibimos o que foi gravado; não recalculamos no cliente.
  qualifierBySide = new Map();
  const items = qualRes.data?.breakdown?.items ?? [];
  for (const it of items) {
    qualifierBySide.set(`${it.match_id}:${it.side}`, it);
  }

  // Artilheiro escolhido pelo usuário (p/ o bônus por gol dele em cada jogo).
  scorerPickId = scorerRes.data?.player_id ?? null;

  // Campeão: pick do usuário + campeão real (vencedor da final, quando finalizada).
  championPickTeam = champRes.data?.team ?? null;
  const finalM = matches.find(m => m.stage === 'final');
  realChampion = (finalM && finalM.finished)
    ? (finalM.actual_home > finalM.actual_away ? finalM.team_home
       : finalM.actual_away > finalM.actual_home ? finalM.team_away
       : finalM.pen_winner === 'home' ? finalM.team_home
       : finalM.pen_winner === 'away' ? finalM.team_away : null)
    : null;

  // Numera as vagas de melhor-3º (1..8) por ordem de jogo, pra cada uma ser
  // distinguível ("3º①", "3º②"…) em vez de todas mostrarem só "3º".
  thirdSlotIndex = new Map();
  let ti = 0;
  const r32 = matches.filter(m => m.stage === 'r32').sort((a, b) => a.id - b.id);
  for (const m of r32) {
    for (const s of [m.slot_home, m.slot_away]) {
      if (s && /^3[A-Z/]+$/.test(s) && !thirdSlotIndex.has(s)) thirdSlotIndex.set(s, ++ti);
    }
  }
}

// ============================================================
// Helpers
// ============================================================
// Resolve o time real de um lado do confronto (via palpites do user). null se
// ainda é um slot não resolvido. Usado pelo Raio-X (só aparece com 2 times reais).
function resolveSide(m, side) {
  const realTeam = side === 'home' ? m.team_home : m.team_away;
  if (isRealTeam(realTeam)) return realTeam;   // time real já saiu (upstream resolvido)
  const slotOriginal = side === 'home' ? m.slot_home : m.slot_away;
  const slot = slotOriginal || realTeam;
  if (isRealTeam(slot)) return slot;
  return predSlotResolution.get(slot)?.team ?? null;  // senão, seu palpite de vaga
}

// Dados que alimentam o Raio-X (módulo ../raiox.js). No render do botão o H2H
// ainda não foi buscado (h2h null); ele é resolvido on-demand ao abrir o modal.
function raioxData(h2h = null) {
  return { recentByTeam, h2h, qualifiers };
}

// Busca o confronto direto entre dois times (tabela team_h2h, par canônico
// alfabético). Reorienta o summary para a ótica do mandante do confronto.
async function fetchH2HPair(homeTeam, awayTeam) {
  const [a, b] = [homeTeam, awayTeam].slice().sort();
  const { data } = await supabase
    .from('team_h2h').select('fixtures, summary')
    .eq('team_a', a).eq('team_b', b).maybeSingle();
  if (!data) return null;
  let summary = data.summary;
  if (homeTeam !== a) {  // mandante é o team_b canônico → inverte vitórias
    summary = { home_wins: summary.away_wins, draws: summary.draws, away_wins: summary.home_wins, total: summary.total };
  }
  return { fixtures: data.fixtures, summary };
}

// Busca o H2H do par e abre o modal do Raio-X (forma recente + confronto direto).
async function openRaioXForMata(homeTeam, awayTeam) {
  let h2h = null;
  try { h2h = await fetchH2HPair(homeTeam, awayTeam); } catch (e) { console.warn('[h2h]', e); }
  openRaioXModal({ homeTeam, awayTeam, data: raioxData(h2h) });
}

// A resolução do bracket (slots → times) vive em ../bracket.js (puro, testável).
// Aqui só passamos o estado de módulo e consumimos o Map resultante.

const ORDINAIS = ['Primeiro','Segundo','Terceiro','Quarto','Quinto','Sexto','Sétimo','Oitavo','Nono','Décimo','Décimo-primeiro','Décimo-segundo'];

function teamDisplay(slot) {
  if (isRealTeam(slot)) return teamPt(slot);
  // Slot human-readable (tooltip detalhado)
  if (/^\d[A-L]$/.test(slot)) return `${slot[0]}º Grupo ${slot[1]}`;
  if (/^3[A-Z/]+$/.test(slot)) {
    const i = thirdSlotIndex.get(slot);
    const groups = slot.slice(1);
    return i ? `3º (${ORDINAIS[i - 1] ?? i + 'º'} Colocado) · grupos ${groups}` : `3º ${groups}`;
  }
  if (/^W\d+$/.test(slot)) return `Vencedor da M${slot.slice(1)}`;
  if (/^L\d+$/.test(slot)) return `Perdedor da M${slot.slice(1)}`;
  return slot;
}

// Rótulo curto da vaga pra sublinha do card ("vaga: …").
function slotLineLabel(slot) {
  if (!slot) return '';
  if (/^\d[A-L]$/.test(slot)) return `${slot[0]}º Grupo ${slot[1]}`;
  if (/^3[A-Z/]+$/.test(slot)) {
    const i = thirdSlotIndex.get(slot);
    return i ? `3º (${ORDINAIS[i - 1] ?? i + 'º'} Colocado)` : '3º melhor';
  }
  if (/^W\d+$/.test(slot)) return `Venc. M${slot.slice(1)}`;
  if (/^L\d+$/.test(slot)) return `Perd. M${slot.slice(1)}`;
  return slot;
}

// Acertou o placar exato deste jogo?
function isExactPred(m, pred) {
  return !!pred && m.finished
    && pred.pred_home === m.actual_home && pred.pred_away === m.actual_away;
}

// ============================================================
// Visão por data
// ============================================================
function dateKey(m) {
  return localDateKey(m.match_date);
}

// Datas distintas (yyyy-mm-dd) dos jogos de mata-mata, em ordem cronológica.
function datesFor() {
  return [...new Set(matches.map(dateKey))].sort();
}

function defaultDate() {
  const ks = datesFor();
  // Primeira data com jogo ainda a palpitar; senão a primeira data.
  const pick = ks.find(k => matches.some(m => dateKey(m) === k && !m.finished));
  return pick ?? ks[0] ?? null;
}

function renderViewToggle() {
  return `
    <div class="palpites-views">
      <div class="view-toggle" role="tablist" aria-label="Modo de visualização">
        <button class="${viewMode === 'bracket' ? 'active' : ''}" data-view="bracket" type="button">Chave</button>
        <button class="${viewMode === 'date' ? 'active' : ''}" data-view="date" type="button">📅 Por data</button>
      </div>
    </div>
  `;
}

// Metadados por data para o calendário "Por data": nome curto da(s) fase(s) do
// dia, contador palpitados/total e prazo de bloqueio (para o alerta de cor).
function buildDateMeta(byDate) {
  const stagesByDate = {};
  const deadlineByDate = {};
  const finByDate = {};     // yyyy-mm-dd -> nº de jogos já encerrados
  for (const m of matches) {
    const dk = dateKey(m);
    (stagesByDate[dk] ??= new Set()).add(m.stage);
    const dl = predictionDeadline(m.match_date).getTime();
    deadlineByDate[dk] = Math.min(deadlineByDate[dk] ?? Infinity, dl);
    if (m.finished) finByDate[dk] = (finByDate[dk] ?? 0) + 1;
  }
  const meta = {};
  for (const dk of datesFor()) {
    const labels = [...(stagesByDate[dk] ?? [])].map(s => STAGE_LABELS[s] ?? s);
    const total = byDate[dk]?.total ?? 0;
    meta[dk] = {
      info: labels[0] ?? '',
      title: labels.join(' · '),
      done: byDate[dk]?.done ?? 0,
      total,
      deadline: deadlineByDate[dk],
      played: total > 0 && (finByDate[dk] ?? 0) >= total,   // dia todo encerrado
    };
  }
  return meta;
}

function renderDatePicker(byDate) {
  return renderDateCalendar({ dates: datesFor(), meta: buildDateMeta(byDate), activeDate });
}

// Selo de fase mostrado no card só quando em "Por data" (na chave a fase é a coluna).
function stageTagFor(m) {
  if (viewMode !== 'date') return '';
  const label = STAGE_LABELS[m.stage] ?? m.stage;
  const multPt = String(stageMultiplier(m.stage)).replace('.', ',');
  return `<span class="bm-stage-tag" title="Placar exato ${stageExact(m.stage)} pts · fase ×${multPt}">${escapeHtml(label)}</span>`;
}

function renderBracketView(colRenderer) {
  const grouped = groupByStage();
  return `
    <div class="bracket-wrap">
      <div class="bracket">
        ${STAGES.map(stage => colRenderer(stage, grouped)).join('')}
      </div>
    </div>
  `;
}

function renderDateView(counts, cardRenderer) {
  const ks = datesFor();
  if (!ks.includes(activeDate)) activeDate = defaultDate();

  const dayMatches = activeDate
    ? matches.filter(m => dateKey(m) === activeDate).sort((a, b) => new Date(a.match_date) - new Date(b.match_date))
    : [];

  const chips = renderDatePicker(counts.byDate);

  const body = dayMatches.length
    ? `
      <div class="date-head">
        <h4>${formatBrDate(new Date(activeDate + 'T12:00:00'))}</h4>
        <div class="sub">${dayMatches.length} jogo${dayMatches.length > 1 ? 's' : ''}</div>
      </div>
      <div class="bracket-date-list">${dayMatches.map(cardRenderer).join('')}</div>`
    : `<div class="empty">
        <div class="empty-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg></div>
        <h3>Sem jogos nesta data</h3><p>Escolha outra data acima.</p></div>`;

  return `
    <div class="palpites-toolbar">
      <div class="chips" id="chips">${chips}</div>
    </div>
    ${body}
  `;
}

// ============================================================
// Render
// ============================================================
function renderPage() {
  const counts = computeCounts();
  return `
    <section class="hero">
      <div class="hero-kicker">Palpitar placares · Mata-mata</div>
      <h1 class="hero-title">Mata-mata</h1>
      <div class="hero-meta">
        <b>${matches.length} jogos</b><span class="sep"></span>
        Seu palpite e o resultado oficial no mesmo lugar<span class="sep"></span>
        <b>${counts.totalDone}</b> palpitados
      </div>
    </section>

    ${renderNote()}

    <div id="tabBody">${renderBody(counts)}</div>
  `;
}

// Corpo que re-renderiza (KPIs + toggle de visão + lista de cards unificados).
function renderBody(counts) {
  return `
    ${renderKpis(counts)}
    ${renderViewToggle()}
    ${viewMode === 'date'
      ? renderDateView(counts, renderCard)
      : renderBracketView(renderStageColumn)}
  `;
}

function renderNote() {
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
        <span class="sub">Quando o jogo encerra, o card mostra seu palpite ao lado do resultado oficial.</span></span>
      <a class="note-link" href="regras.html">Ver todas as regras →</a>
    </div>
  `;
}

// ============================================================
// Card unificado — despacha pelo estado do jogo.
//   encerrado → duas faixas (seu palpite | oficial) + pontos
//   aberto    → faixa única editável (time real se já saiu, senão seu bracket)
// ============================================================
function renderCard(m) {
  return m.finished ? renderFinishedCard(m) : renderOpenCard(m);
}

// ---- ENCERRADO: duas faixas lado a lado (seu palpite × oficial) ----
function renderFinishedCard(m) {
  const pred = predsByMatch.get(m.id);
  const pts = pred?.points_earned ?? 0;

  const { day: _d, month: _mo } = brParts(m.match_date);
  const dateLabel = `${String(_d).padStart(2,'0')}/${MEZES[_mo - 1]}`;
  const timeLabel = formatTime(m.match_date);

  const isFinal = m.stage === 'final';
  const isThird = m.stage === 'third';

  const qualPts = matchQualPts(m);          // bônus por acertar quem classificou
  const scorerPts = matchScorerPts(m);       // bônus por gol do seu artilheiro
  const champPts = matchChampionPts(m);      // bônus de campeão (só na final)
  const totalPts = pts + qualPts + scorerPts + champPts;
  const hasBonus = qualPts > 0 || scorerPts > 0 || champPts > 0;
  // Ganhou ALGO neste jogo? (placar previsto OU bônus de classificado/artilheiro,
  // que independem de ter palpitado o placar — vêm dos palpites de grupo/artilheiro).
  const hasAny = !!pred || hasBonus;

  // Classificado/artilheiro já contam como acerto parcial, mesmo sem palpite de placar.
  const resultClass = !pred
    ? (hasBonus ? 'partial' : 'no-pred')
    : isExactPred(m, pred) ? 'exact'
    : (pts > 0 || hasBonus) ? 'partial' : 'miss';

  const classes = ['bracket-match', 'km-finished', resultClass, 'finished'];
  if (isFinal) classes.push('final-match');
  if (isThird) classes.push('third-place');

  const pointsBadge = hasAny
    ? renderPointsBadge(totalPts, null, resultClass)
    : '<div class="bm-pts no-pred">sem palpite</div>';
  const breakdown = hasAny ? renderBmBreak(m, pred, qualPts, scorerPts, champPts) : '';

  return `
    <div class="${classes.join(' ')}" data-match-id="${m.id}">
      <div class="bm-id">
        <span class="bm-id-main">${stageTagFor(m)}${isThird ? '🥉 3º Lugar' : isFinal ? '🏆 Final' : `M${m.id}`}</span>
        <span class="when">${dateLabel} · ${timeLabel} · <span class="km-tag-done">encerrado</span></span>
      </div>

      <div class="km-lanes">
        <div class="km-cap km-area-predcap">Seu palpite</div>
        <div class="km-cap km-cap-off km-area-offcap">Resultado oficial</div>
        ${renderFinRow(m, 'pred', 'home')}
        ${renderFinRow(m, 'official', 'home')}
        ${renderFinRow(m, 'pred', 'away')}
        ${renderFinRow(m, 'official', 'away')}
      </div>
      ${m.pen_winner ? `<div class="km-pen">⚽ Pênaltis: ${m.pen_winner === 'home' ? teamPt(m.team_home) : teamPt(m.team_away)}</div>` : ''}

      <div class="km-foot">
        <div class="km-cap">Pontuação</div>
        <div class="km-foot-row">
          ${breakdown}
          ${pointsBadge}
        </div>
      </div>
    </div>
  `;
}

// Uma linha do card encerrado. lens='pred' (seu palpite) | 'official' (real); side='home'|'away'.
// Recebe uma classe de área do grid (km-area-*) p/ alinhar home-com-home e away-com-away
// entre as duas faixas mesmo quando um lado tem o selo "classificado".
function renderFinRow(m, lens, side) {
  const realTeam = side === 'home' ? m.team_home : m.team_away;
  const slotOriginal = side === 'home' ? m.slot_home : m.slot_away;
  const slot = slotOriginal || realTeam;
  const predTeam = isRealTeam(slot) ? slot : (predSlotResolution.get(slot)?.team ?? null);
  const pred = predsByMatch.get(m.id);
  const area = `km-area-${lens === 'official' ? 'off' : 'pred'}${side}`;

  // Vaga de origem (ex.: "2A"). Mesmo spot nas duas faixas → casa palpite × oficial.
  const slotLine = slotOriginal
    ? `<span class="km-slot-line" title="${escapeHtml(teamDisplay(slotOriginal))}">vaga: ${escapeHtml(slotLineLabel(slotOriginal))}</span>`
    : '';

  if (lens === 'official') {
    const score = side === 'home' ? m.actual_home : m.actual_away;
    const isWinner =
      (side === 'home' && (m.actual_home > m.actual_away || (m.actual_home === m.actual_away && m.pen_winner === 'home'))) ||
      (side === 'away' && (m.actual_away > m.actual_home || (m.actual_home === m.actual_away && m.pen_winner === 'away')));
    const qual = renderQualBadge(m.id, side);
    return `
      <div class="km-row km-off ${area} ${isWinner ? 'winner' : ''}">
        <span class="flag">${flag(realTeam)}</span>
        <div class="km-nm">
          <span class="km-name" data-team="${escapeHtml(realTeam || '')}">${escapeHtml(teamPt(realTeam))}</span>
          ${slotLine}
          ${qual}
        </div>
        <span class="km-score">${score}</span>
      </div>`;
  }

  // lens === 'pred' — time que VOCÊ imaginava na vaga + seu placar
  const pscore = pred ? (side === 'home' ? pred.pred_home : pred.pred_away) : null;
  const diverged = predTeam && isRealTeam(realTeam) && predTeam !== realTeam;
  return `
    <div class="km-row km-pred ${area} ${diverged ? 'diverged' : ''}">
      <span class="flag">${predTeam ? flag(predTeam) : ''}</span>
      <div class="km-nm">
        <span class="km-name">${predTeam ? escapeHtml(teamPt(predTeam)) : '—'}</span>
        ${slotLine}
      </div>
      <span class="km-score">${pscore ?? '–'}</span>
    </div>`;
}

// Soma o bônus de classificado (BPE/BP) dos dois lados do confronto.
function matchQualPts(m) {
  let sum = 0;
  for (const side of ['home', 'away']) {
    const q = qualifierBySide.get(`${m.id}:${side}`);
    if (q) sum += q.pts || 0;
  }
  return sum;
}

// Bônus de artilheiro NESTE jogo: gols do jogador escolhido × multiplicador da fase.
function matchScorerPts(m) {
  if (!scorerPickId) return 0;
  const goal = (goalsByMatch.get(m.id) ?? []).find(g => g.player_id === scorerPickId);
  const n = goal?.goals ?? 0;
  return n > 0 ? scorerBonus(n, m.stage) : 0;
}

// Bônus de campeão: cai SÓ no jogo da final, quando você acertou o campeão.
function matchChampionPts(m) {
  if (m.stage !== 'final' || !championPickTeam || !realChampion) return 0;
  return championPickTeam === realChampion ? championBonus(true) : 0;
}

// Quebra aditiva da pontuação: chips do placar (lado/resultado/saldo) + chips de
// "Classificado +N" e "Artilheiro +N" quando houver esses bônus no jogo.
function renderBmBreak(m, pred, qualPts = 0, scorerPts = 0, champPts = 0) {
  const chips = [];
  if (pred) {
    const { parts } = scoreBreakdown(
      pred.pred_home, pred.pred_away, pred.pred_pen_winner,
      m.actual_home, m.actual_away, m.pen_winner, m.stage,
    );
    chips.push(...parts.map(p => `<span class="brk ${p.key}">${p.label} <b>+${p.pts}</b></span>`));
  }
  if (qualPts > 0) chips.push(`<span class="brk qual">Classificado <b>+${qualPts}</b></span>`);
  if (scorerPts > 0) chips.push(`<span class="brk scorer">⚽ Artilheiro <b>+${scorerPts}</b></span>`);
  if (champPts > 0) chips.push(`<span class="brk champ">🏆 Campeão <b>+${champPts}</b></span>`);
  if (chips.length === 0) return '';
  return `<div class="bm-break">${chips.join('')}</div>`;
}

// Selo de bônus de classificado (lê o breakdown gravado pelo SQL).
function renderQualBadge(matchId, side) {
  const q = qualifierBySide.get(`${matchId}:${side}`);
  if (!q) return '';
  // Selo qualitativo (marca o acerto da vaga). Os pontos vivem na seção Pontuação.
  if (q.kind === 'bpe') {
    return `<span class="qual-badge bpe" title="Você acertou quem se classificou nesta vaga (+${q.pts} na pontuação)">✓ classificado</span>`;
  }
  return `<span class="qual-badge bp" title="Time certo na fase, vaga errada (+${q.pts} na pontuação)">~ vaga errada</span>`;
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

// KPIs unificados: progresso de palpites + desempenho (pontos/exatos) num strip só.
function renderKpis(counts) {
  const pct = matches.length ? Math.round(counts.totalDone / matches.length * 100) : 0;
  const fin = counts.totalFinishedWithPred;
  const avg = fin > 0 ? (counts.totalPoints / fin).toFixed(1) : '0';
  return `
    <div class="kpis">
      <div class="kpi green">
        <div class="kpi-top"><span class="kpi-cap">${KPI.done}</span><span class="kpi-label">Palpitados</span></div>
        <div class="kpi-num">${counts.totalDone}<small>/${matches.length}</small></div>
        <div class="progress-bar-inline"><span style="width:${pct}%"></span></div>
      </div>
      <div class="kpi gold">
        <div class="kpi-top"><span class="kpi-cap">${KPI.points}</span><span class="kpi-label">Pontos ganhos</span></div>
        <div class="kpi-num">${counts.totalPoints}</div>
        <div class="kpi-sub">${fin > 0 ? `média ${avg} pts/jogo` : 'aguardando jogos'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-top"><span class="kpi-cap">${KPI.exact}</span><span class="kpi-label">Placares exatos</span></div>
        <div class="kpi-num">${counts.exactCount}</div>
        <div class="kpi-sub">de ${fin} encerrado${fin !== 1 ? 's' : ''}</div>
      </div>
      <div class="kpi red">
        <div class="kpi-top"><span class="kpi-cap">${KPI.pending}</span><span class="kpi-label">Faltando</span></div>
        <div class="kpi-num">${counts.totalRemaining}</div>
        <div class="kpi-sub">${counts.totalRemaining === 0 ? 'tudo pronto ✓' : 'jogos pendentes'}</div>
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
        ${stageHeaderBadges(stage.id)}
        <span class="count">${list.length} jogo${list.length !== 1 ? 's' : ''}</span>
      </h4>
      ${list.map(renderCard).join('')}
    </div>
  `;
}

// ---- ABERTO: faixa única editável. Mostra o time REAL quando já saiu (oitavas
// após os grupos), senão o time que VOCÊ previu na vaga; sinaliza divergência. ----
function renderOpenCard(m) {
  const pred = predsByMatch.get(m.id);
  const locked = isLocked(m);
  const homeVal = pred?.pred_home ?? '';
  const awayVal = pred?.pred_away ?? '';

  const homeIsDraw = homeVal !== '' && awayVal !== '' && parseInt(homeVal) === parseInt(awayVal);
  const showPen = !locked && homeIsDraw;
  const penWinner = pred?.pred_pen_winner;

  const { day: _d, month: _mo } = brParts(m.match_date);
  const dateLabel = `${String(_d).padStart(2,'0')}/${MEZES[_mo - 1]}`;
  const timeLabel = formatTime(m.match_date);

  const isFinal = m.stage === 'final';
  const isThird = m.stage === 'third';
  const classes = ['bracket-match'];
  if (locked) classes.push('locked');
  if (isFinal) classes.push('final-match');
  if (isThird) classes.push('third-place');

  // Raio-X só quando os dois lados já são times reais (slots resolvidos).
  const raioxBtn = renderRaioXModalButton(m.id, resolveSide(m, 'home'), resolveSide(m, 'away'), raioxData());

  return `
    <div class="${classes.join(' ')}" data-match-id="${m.id}">
      <div class="bm-id">
        <span class="bm-id-main">${stageTagFor(m)}${isThird ? '🥉 3º Lugar' : isFinal ? '🏆 Final' : `M${m.id}`}</span>
        <span class="when">${dateLabel} · ${timeLabel}</span>
      </div>
      <div class="bm-lock">${locked ? 'Bloqueado' : lockCountdownLabel(m.match_date)}</div>

      ${renderOpenTeamRow(m, 'home', homeVal, locked)}
      ${renderOpenTeamRow(m, 'away', awayVal, locked)}

      ${showPen ? renderPenToggle(m, penWinner) : ''}

      ${raioxBtn ? `<div class="bm-raiox">${raioxBtn}</div>` : ''}
    </div>
  `;
}

function renderPenToggle(m, penWinner) {
  // Bandeira + nome dos lados: time real se já saiu, senão o seu palpite de vaga.
  const homeTeam = resolveSide(m, 'home');
  const awayTeam = resolveSide(m, 'away');

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

function renderOpenTeamRow(m, side, val, locked) {
  const slotOriginal = side === 'home' ? m.slot_home : m.slot_away;
  const realTeam = side === 'home' ? m.team_home : m.team_away;
  const realKnown = isRealTeam(realTeam);

  // Time que VOCÊ previu nessa vaga (lente de palpite).
  const slot = slotOriginal || realTeam;
  const isReal = isRealTeam(slot);
  const resolved = !isReal ? predSlotResolution.get(slot) : null;
  const predTeam = isReal ? slot : (resolved?.team ?? null);

  // Mostra o time REAL quando já saiu; senão o seu palpite de vaga.
  const shown = realKnown ? realTeam : predTeam;
  const showFlag = !!shown;
  const source = resolved?.source;
  const isPredSource = !realKnown && (source === 'pred-group' || source === 'pred-ko');
  const diverged = realKnown && predTeam && predTeam !== realTeam;

  // Vaga de origem como sublinha (consistente com o card encerrado).
  const slotLine = slotOriginal
    ? `<div class="bm-slot-line" title="${escapeHtml(teamDisplay(slotOriginal))}">vaga: ${escapeHtml(slotLineLabel(slotOriginal))}</div>`
    : '';

  let nameHtml;
  if (shown) {
    const sourceBadge = isPredSource
      ? '<span class="pred-source" title="Baseado nos seus palpites">P</span>'
      : '';
    // Chip de divergência: você botou outro time nessa vaga.
    const divChip = diverged
      ? `<div class="bm-diverge" title="Quem você previu nesta vaga">na sua simulação: <span class="dv-flag">${flag(predTeam)}</span> ${escapeHtml(teamPt(predTeam))}</div>`
      : '';
    nameHtml = `
      <div class="nm">
        <div class="team-line">
          <span class="team-name" data-team="${escapeHtml(shown)}">${escapeHtml(teamPt(shown))}</span>
          ${sourceBadge}
        </div>
        ${slotLine}
        ${divChip}
      </div>`;
  } else {
    nameHtml = `<div class="nm slot">${escapeHtml(teamDisplay(slot))}</div>`;
  }

  return `
    <div class="bm-team">
      ${showFlag ? `<span class="flag">${flag(shown)}</span>` : '<span></span>'}
      ${nameHtml}
      <input class="mini-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2"
             data-match="${m.id}" data-side="${side}"
             aria-label="Gols ${escapeHtml(shown ? teamPt(shown) : teamDisplay(slot))}"
             value="${val}" ${locked ? 'disabled' : ''}>
    </div>
  `;
}

function computeCounts() {
  let totalDone = 0, totalLocked = 0, totalFinished = 0;
  let totalPoints = 0, exactCount = 0, partialCount = 0, missCount = 0, totalFinishedWithPred = 0;
  const byDate = {};   // yyyy-mm-dd -> { done, total } (palpitados / jogos do dia)

  for (const m of matches) {
    const p = predsByMatch.get(m.id);
    const dk = dateKey(m);
    (byDate[dk] ??= { done: 0, total: 0 }).total++;
    if (p) { totalDone++; byDate[dk].done++; }
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
    byDate,
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
    // Raio-X (modal) — resolve os times na hora (slot pode ter mudado)
    const raioxBtn = e.target.closest('[data-raiox-modal]');
    if (raioxBtn) {
      const matchId = parseInt(raioxBtn.dataset.raioxModal, 10);
      const m = matches.find(mm => mm.id === matchId);
      const homeTeam = m && resolveSide(m, 'home');
      const awayTeam = m && resolveSide(m, 'away');
      if (homeTeam && awayTeam) openRaioXForMata(homeTeam, awayTeam);
      return;
    }

    // Toggle de visão: chave ⇄ por data
    const viewBtn = e.target.closest('.view-toggle button[data-view]');
    if (viewBtn) {
      const v = viewBtn.dataset.view;
      if (v !== viewMode) {
        viewMode = v;
        if (viewMode === 'date' && !activeDate) activeDate = defaultDate();
        rerenderTabBody();
      }
      return;
    }

    // Dia do calendário (modo "por data")
    const dateCell = e.target.closest('.cal-day[data-date]');
    if (dateCell) {
      activeDate = dateCell.dataset.date;
      rerenderTabBody();
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
  slotResolution = computeSlotResolution({ allMatches, matches, predsByMatch, mode: 'real-first' });
  predSlotResolution = computeSlotResolution({ allMatches, matches, predsByMatch, mode: 'pred-only' });

  const m = matches.find(mm => mm.id === matchId);
  const homeSlot = m.slot_home || m.team_home;
  const awaySlot = m.slot_away || m.team_away;
  const homeName = resolveSlotToTeam(homeSlot, predSlotResolution) ?? teamDisplay(homeSlot);
  const awayName = resolveSlotToTeam(awaySlot, predSlotResolution) ?? teamDisplay(awaySlot);
  showToast(`Salvo ${teamPt(homeName)} ${h}–${a} ${teamPt(awayName)}`, 'success', 1500);
  updateKpis();
  rerenderAllBracketRows();
  refreshNavBadges(profile.id);  // baixa o badge de pendência na hora (sem F5)
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
    wrapper.innerHTML = renderCard(m);
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
  wrapper.innerHTML = renderOpenCard(m);
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
  // No modo "por data", mantém a contagem dos chips em dia após salvar.
  if (viewMode === 'date') {
    const chips = document.getElementById('chips');
    if (chips) chips.innerHTML = renderDatePicker(counts.byDate);
  }
}

// Re-renderiza só o corpo (usado por toggle de visão e chips de data).
function rerenderTabBody() {
  const counts = computeCounts();
  const tabBody = document.getElementById('tabBody');
  if (tabBody) tabBody.innerHTML = renderBody(counts);
}

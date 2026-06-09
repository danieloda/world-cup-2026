import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase, fetchAllPages } from '../supabase.js';
import {
  flag, escapeHtml, teamPt, formatBrShort, formatTime, stageLabel,
  isLive, avatarHtml, localDateKey, renderDateCalendar, firstName,
} from '../util.js';
import { scorerBonus, stageMultiplier, scoreBreakdown } from '../scoring.js';
import { KPI } from '../kpi-icons.js';
import { initTooltips } from '../tooltip.js';

// ============================================================
// Ícones (SVG inline — nada de emoji na UI)
// ============================================================
const ICON = {
  ball: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.6 5h-4.8L8 10z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v16l-7-3-7 3z"/></svg>',
};

// ============================================================
// Estado
// ============================================================
let profile, stats;
let revealedMatches = [];          // jogos já iniciados (match_date <= now), desc por data
let predsByMatch = new Map();      // match_id -> [{...prediction, profiles}]
let goalsByMatch = new Map();      // match_id -> [{...goal, players}]
let scorerPickByUser = new Map();  // user_id -> { playerId, name }  (artilheiro escolhido)
let activeStage = 'group';         // ABA 1 (fase): 'group' | 'ko'
let activeDay = null;              // ABA 2 (dia): 'YYYY-MM-DD' (sempre um dia específico)
let activeStatus = 'finished';     // FILTRO: 'finished' | 'awaiting'

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  await loadData();

  const pageBody = await renderShell({ active: 'historico', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');

  attachEventListeners();
} catch (err) {
  console.error('[historico] FATAL:', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:#fff; font-family:'Figtree',system-ui,-apple-system,sans-serif;">
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
  const [statsRes, matchesRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    // Um jogo entra no Histórico quando JÁ COMEÇOU (apito inicial): é o momento
    // em que o RLS revela os palpites alheios (predictions_select_own_or_locked).
    supabase.from('matches').select('*').lte('match_date', new Date().toISOString())
      .order('match_date', { ascending: false }),
  ]);

  if (matchesRes.error) throw matchesRes.error;
  stats = statsRes.data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0 };
  revealedMatches = matchesRes.data ?? [];

  if (revealedMatches.length === 0) return;

  const matchIds = revealedMatches.map(m => m.id);
  // Palpites de TODOS os participantes nos jogos revelados: cresce com
  // (usuários × jogos), então PAGINA — senão o PostgREST corta em 1000 linhas e
  // somem palpites dos cards quando o bolão fica grande. Ver fetchAllPages.
  const predsPromise = fetchAllPages(() =>
    supabase.from('predictions')
      .select('*, profiles(full_name, paid, avatar_url)')
      .in('match_id', matchIds).order('id'));

  // Artilheiros: o RLS só revela a escolha alheia após o deadline (10/jun). Como nenhum
  // jogo termina antes disso, nos cards finalizados sempre dá pra cruzar quem pontuou.
  const [predsRows, goalsRes, scorerRes] = await Promise.all([
    predsPromise,
    supabase.from('player_goals')
      .select('*, players(full_name, team)')
      .in('match_id', matchIds),
    supabase.from('top_scorer_picks')
      .select('user_id, player_id, players(full_name, team)'),
  ]);

  for (const p of (predsRows ?? [])) {
    if (!p.profiles?.paid) continue;  // só participantes do bolão (pagos)
    if (!predsByMatch.has(p.match_id)) predsByMatch.set(p.match_id, []);
    predsByMatch.get(p.match_id).push(p);
  }
  for (const g of (goalsRes.data ?? [])) {
    if (!goalsByMatch.has(g.match_id)) goalsByMatch.set(g.match_id, []);
    goalsByMatch.get(g.match_id).push(g);
  }
  for (const s of (scorerRes.data ?? [])) {
    scorerPickByUser.set(s.user_id, {
      playerId: s.player_id,
      name: s.players?.full_name || 'seu artilheiro',
      team: s.players?.team || null,
    });
  }
}

// ============================================================
// Helpers de estado/seleção
// ============================================================
// 'finished' → resultado lançado (pontua) · 'awaiting' → já começou, sem resultado
function matchStatus(m) {
  return m.finished ? 'finished' : 'awaiting';
}
function inStage(m, stage) {
  return stage === 'group' ? m.stage === 'group' : m.stage !== 'group';
}
function dayKey(m) {
  // Chave de dia no fuso de Brasília (mesmo de formatBrShort/formatBrDate), pra
  // que a aba de dia e a data do card nunca divirjam num jogo perto da meia-noite.
  return localDateKey(m.match_date);
}

function stageMatches() {
  return revealedMatches.filter(m => inStage(m, activeStage));
}
function dayMatches() {
  return stageMatches().filter(m => dayKey(m) === activeDay);
}
// Garante um dia válido selecionado para a fase ativa (o mais recente por padrão)
function ensureValidDay() {
  const days = stageDays();
  if (!days.some(([k]) => k === activeDay)) activeDay = days.length ? days[0][0] : null;
}
// Garante um status com jogos no dia (prefere Finalizadas; senão Próximas partidas)
function ensureValidStatus() {
  const scoped = dayMatches();
  const has = s => scoped.some(m => matchStatus(m) === s);
  if (!has(activeStatus)) activeStatus = has('finished') ? 'finished' : 'awaiting';
}
function visibleMatches() {
  return dayMatches().filter(m => matchStatus(m) === activeStatus);
}

// Dias distintos (desc) da fase ativa, com contagem
function stageDays() {
  const map = new Map(); // key -> count
  for (const m of stageMatches()) {
    map.set(dayKey(m), (map.get(dayKey(m)) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])); // desc por data
}

// ============================================================
// Render — página
// ============================================================
function renderPage() {
  // Antes da Copa começar nenhum jogo foi revelado (nenhum começou): em vez de uma
  // tela vazia, mostramos uma PRÉVIA desfocada do que a página vai exibir.
  if (revealedMatches.length === 0) {
    return `
      <section class="hero">
        <div class="hero-kicker">Veja o que cada jogador apostou, jogo a jogo</div>
        <h1 class="hero-title">Palpites da galera</h1>
        <div class="hero-meta">
          <b>A Copa ainda não começou</b><span class="sep"></span>
          os palpites de todos aparecem aqui assim que a bola rolar
        </div>
      </section>

      ${renderPreview()}
    `;
  }

  const awaitingTotal = revealedMatches.filter(m => matchStatus(m) === 'awaiting').length;

  return `
    <section class="hero">
      <div class="hero-kicker">Veja o que cada jogador apostou, jogo a jogo</div>
      <h1 class="hero-title">Palpites da galera</h1>
      <div class="hero-meta">
        <b>${stats.finished_matches}</b> finalizados<span class="sep"></span>
        <b>${awaitingTotal}</b> aguardando resultado<span class="sep"></span>
        <b>${stats.pct_played}%</b> da Copa
      </div>
    </section>

    <div class="hist-note">
      ${ICON.info}
      <span>Os palpites de todos ficam visíveis quando o jogo começa — em <b>Próximas partidas</b> sem pontos, e em <b>Finalizadas</b> já pontuados.</span>
    </div>

    ${renderStageTabs()}

    <div id="tabBody">
      ${renderTabBody()}
    </div>
  `;
}

// ============================================================
// Prévia (pré-Copa) — ilustração desfocada, dados fictícios
// ============================================================
function renderPreview() {
  // Exemplos 100% fictícios só para mostrar o formato da tela. Ninguém vê palpite
  // de ninguém antes do apito inicial — por isso fica borrado e marcado como "Prévia".
  const demos = [
    {
      home: 'Brazil', away: 'Croatia', sh: 2, sa: 1, stage: 'Grupo C',
      bets: [
        { name: 'Você',  ph: 2, pa: 1, pts: 7, cls: 'win-exact',   pcls: 'exact',   rcls: 'exact',   rlbl: 'Placar exato',  me: true },
        { name: 'Ana',   ph: 2, pa: 0, pts: 5, cls: 'win-partial', pcls: 'partial', rcls: 'partial', rlbl: 'Acerto parcial' },
        { name: 'Bruno', ph: 1, pa: 1, pts: 1, cls: 'win-partial', pcls: 'partial', rcls: 'partial', rlbl: 'Acerto parcial' },
        { name: 'Carla', ph: 0, pa: 2, pts: 0, cls: 'miss',        pcls: 'zero',    rcls: 'miss',    rlbl: 'Não pontuou' },
      ],
    },
    {
      home: 'Argentina', away: 'France', sh: 1, sa: 1, stage: 'Grupo D',
      bets: [
        { name: 'Diego', ph: 1, pa: 1, pts: 7, cls: 'win-exact',   pcls: 'exact',   rcls: 'exact',   rlbl: 'Placar exato' },
        { name: 'Elis',  ph: 0, pa: 0, pts: 5, cls: 'win-partial', pcls: 'partial', rcls: 'partial', rlbl: 'Acerto parcial' },
        { name: 'Você',  ph: 2, pa: 1, pts: 1, cls: 'win-partial', pcls: 'partial', rcls: 'partial', rlbl: 'Acerto parcial', me: true },
      ],
    },
  ];

  const resIcon = c => c === 'exact' ? KPI.exact : c === 'partial' ? KPI.partial : KPI.miss;

  const cards = demos.map(d => `
    <div class="history-card group">
      <div class="history-head">
        <div class="hh-meta">${d.stage} · 16:00</div>
        <div class="hh-score">${d.sh}<i>–</i>${d.sa}</div>
      </div>
      <div class="history-fixture">
        <span class="hh-team home">${flag(d.home)}<span class="tn">${escapeHtml(teamPt(d.home))}</span></span>
        <span class="hh-rule"></span>
        <span class="hh-team away">${flag(d.away)}<span class="tn">${escapeHtml(teamPt(d.away))}</span></span>
      </div>
      <div class="history-bets">
        <div class="hb-head"><span class="c">#</span><span>Jogador</span><span class="c">Palpite</span><span>Resultado</span><span class="r">Pts</span></div>
        ${d.bets.map((b, i) => `
          <div class="hb-row ${b.cls} ${b.me ? 'me' : ''} ${i === 0 ? 'top' : ''}">
            <span class="hb-rank">${i + 1}</span>
            <span class="hb-player"><span class="av-mini">${avatarHtml({ full_name: b.name })}</span><span class="nm">${escapeHtml(b.name)}</span></span>
            <span class="pred">${b.ph}<span class="x">–</span>${b.pa}</span>
            <span class="hb-res ${b.rcls}">${resIcon(b.rcls)}<span class="w">${b.rlbl}</span></span>
            <span class="hb-ptswrap"><span class="pts ${b.pcls}">${b.pts > 0 ? '+' + b.pts : '0'}</span></span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  return `
    <div class="preview-wrap">
      <div class="preview-blurred" aria-hidden="true">
        <div class="history-list">${cards}</div>
      </div>
      <div class="preview-overlay">
        <span class="preview-badge">${ICON.eye} Prévia</span>
        <h3>É assim que vai ficar</h3>
        <p>Quando a Copa começar, cada jogo mostra aqui o <strong>palpite de todos os participantes</strong>,
           com os pontos de cada um. Os nomes e placares acima são <strong>só de exemplo</strong> — nada aqui é real ainda.</p>
        <a class="btn btn-green" href="palpites-grupos.html">Fazer meus palpites →</a>
      </div>
    </div>
  `;
}

// ----- ABA 1: FASE (controle segmentado; mantém #stageTabs + data-stage) -----
function renderStageTabs() {
  const groupCount = revealedMatches.filter(m => m.stage === 'group').length;
  const koCount    = revealedMatches.filter(m => m.stage !== 'group').length;
  return `
    <div class="admin-tabs hist-seg" id="stageTabs">
      <button class="admin-tab ${activeStage === 'group' ? 'active' : ''}" data-stage="group">
        Grupos <span class="ct">${groupCount}</span>
      </button>
      <button class="admin-tab ${activeStage === 'ko' ? 'active' : ''}" data-stage="ko">
        Mata-mata <span class="ct">${koCount}</span>
      </button>
    </div>
  `;
}

// ----- ABA 2 (calendário) + FILTRO de status + Resumo do dia + lista -----
function renderTabBody() {
  if (stageMatches().length === 0) {
    return renderEmptyStage();
  }
  ensureValidDay();
  ensureValidStatus();
  return `
    ${renderDayCalendar()}
    ${renderStatusChips()}
    ${renderDaySummary()}
    <div id="historyList">
      ${renderList()}
    </div>
  `;
}

// Calendário "Por data" — o MESMO componente das telas de palpite (renderDateCalendar).
// Dias passados ficam neutros (regra: nada verde no passado); o dia em andamento
// recebe destaque ('soon') via override de status no meta.
function renderDayCalendar() {
  const days = stageDays();
  const dates = days.map(([k]) => k);
  const meta = {};
  for (const [k, count] of days) {
    const dayM = stageMatches().filter(m => dayKey(m) === k);
    const finished = dayM.filter(m => m.finished).length;
    const live = dayM.some(m => isLive(m));
    const d = new Date(k + 'T12:00:00');
    meta[k] = {
      total: count,
      done: finished,
      played: finished >= count,   // dia todo encerrado → 'past' (neutro)
      title: formatBrShort(d),
      info: live ? 'ao vivo' : '',
      status: live ? 'soon' : undefined,
    };
  }
  return `<div class="hist-cal-wrap" id="dayTabs">${renderDateCalendar({ dates, meta, activeDate: activeDay })}</div>`;
}

function renderStatusChips() {
  const scoped = dayMatches();
  const counts = {
    finished: scoped.filter(m => matchStatus(m) === 'finished').length,
    awaiting: scoped.filter(m => matchStatus(m) === 'awaiting').length,
  };
  const chip = (value, label, count) => `
    <button class="chip ${activeStatus === value ? 'active' : ''}" data-status="${value}">
      ${escapeHtml(label)} <span class="ct">${count}</span>
    </button>`;
  return `
    <div class="chips" id="statusChips">
      ${chip('finished', 'Finalizadas',       counts.finished)}
      ${chip('awaiting', 'Próximas partidas', counts.awaiting)}
    </div>
  `;
}

// ----- Resumo do dia (identidade) — derivado dos dados já carregados -----
function renderDaySummary() {
  const dayM = dayMatches();
  const finished = dayM.filter(m => m.finished);
  if (finished.length === 0) return '';

  let exactsTotal = 0, myPts = 0, myExacts = 0;
  const byUser = new Map(); // user_id -> { name, isMe, pts }
  for (const m of finished) {
    for (const b of (predsByMatch.get(m.id) ?? [])) {
      const sc = scorerHitFor(b, m);
      const tot = (b.points_earned ?? 0) + (sc ? sc.bonus : 0);
      const isExact = b.pred_home === m.actual_home && b.pred_away === m.actual_away;
      if (isExact) exactsTotal++;
      const isMe = b.user_id === profile.id;
      const u = byUser.get(b.user_id) ?? { name: b.profiles?.full_name || '?', isMe, pts: 0 };
      u.pts += tot;
      byUser.set(b.user_id, u);
      if (isMe) { myPts += tot; if (isExact) myExacts++; }
    }
  }
  let leader = null;
  for (const [, u] of byUser) if (!leader || u.pts > leader.pts) leader = u;
  const leaderName = leader ? (leader.isMe ? 'Você' : escapeHtml(firstName(leader.name))) : '—';
  const dayLabel = activeDay ? formatBrShort(new Date(activeDay + 'T12:00:00')) : '';

  const tile = (cls, icon, label, value, sub, big = false) => `
    <div class="kpi ${cls}">
      <div class="kpi-top"><span class="kpi-cap">${icon}</span><span class="kpi-label">${label}</span></div>
      <div class="kpi-num"${big ? ' style="font-size:20px"' : ''}>${value}</div>
      <div class="kpi-sub">${sub}</div>
    </div>`;

  return `
    <div class="hist-blocklabel">Resumo do dia · ${escapeHtml(dayLabel)}</div>
    <div class="kpis hist-summary">
      ${tile('', KPI.total, 'Jogos do dia', String(finished.length),
        finished.length === dayM.length ? 'todos encerrados' : `de ${dayM.length} no dia`)}
      ${tile('green', KPI.exact, 'Cravadas', String(exactsTotal), 'placares exatos no dia')}
      ${tile('gold', KPI.points, 'Líder do dia', leaderName, leader ? `+${leader.pts} no dia` : '', true)}
      ${tile('', KPI.position, 'Seu dia', `+${myPts}`,
        `${myExacts} placar${myExacts === 1 ? '' : 'es'} exato${myExacts === 1 ? '' : 's'}`)}
    </div>
  `;
}

// ----- Lista do dia selecionado -----
function renderList() {
  const list = visibleMatches();
  if (list.length === 0) return renderEmptyFilter();
  return `<div class="history-list">${list.map(renderMatchCard).join('')}</div>`;
}

function renderEmptyStage() {
  const stageName = activeStage === 'group' ? 'fase de grupos' : 'mata-mata';
  return `
    <div class="empty">
      <div class="empty-ic">${ICON.flag}</div>
      <h3>Nenhum jogo do ${stageName} começou ainda</h3>
      <p>O histórico aparece conforme os jogos começam.</p>
    </div>
  `;
}
function renderEmptyFilter() {
  return `
    <div class="empty">
      <div class="empty-ic">${ICON.info}</div>
      <h3>Nada nesse filtro</h3>
      <p>Tente outro dia ou status.</p>
    </div>
  `;
}

// ============================================================
// Card de jogo (editorial / tabela)
// ============================================================
function renderMatchCard(m) {
  return matchStatus(m) === 'finished' ? renderFinishedCard(m) : renderAwaitingCard(m);
}

// group → neutro · final → dourado · third → bronze · demais (r32..sf) → ko (amarelo)
function stageCls(m) {
  const s = m.stage;
  return s === 'group' ? 'group' : s === 'final' ? 'final' : s === 'third' ? 'third' : 'ko';
}

function stageDisp(m) {
  return m.stage === 'group' ? `Grupo ${m.group_name}` : stageLabel(m.stage);
}

function fixtureHtml(m) {
  return `
    <div class="history-fixture">
      <span class="hh-team home">${flag(m.team_home)}<span class="tn">${escapeHtml(teamPt(m.team_home))}</span></span>
      <span class="hh-rule"></span>
      <span class="hh-team away">${flag(m.team_away)}<span class="tn">${escapeHtml(teamPt(m.team_away))}</span></span>
    </div>
  `;
}

function cardHead(m, rightHtml) {
  // Fases de peso (×>1) valem mais no bônus de artilheiro — sinaliza no topo do card.
  const mult = stageMultiplier(m.stage);
  const multBadge = mult > 1 ? ` <span class="hh-mult">· Artilheiro ×${fmtMult(m.stage)}</span>` : '';
  return `
    <div class="history-head">
      <div class="hh-meta">${stageDisp(m)} · ${formatTime(m.match_date)}${multBadge}</div>
      ${rightHtml}
    </div>
    ${fixtureHtml(m)}
  `;
}

// Total de gols de um palpite (chave de ordenação)
function predGoals(p) {
  return (p.pred_home ?? 0) + (p.pred_away ?? 0);
}

// Bônus de artilheiro que ESTE usuário ganhou NESTA partida (ou null se não pontuou aqui).
// Cruza o artilheiro escolhido com os gols marcados no jogo.
function scorerHitFor(bet, m) {
  const pick = scorerPickByUser.get(bet.user_id);
  if (!pick) return null;
  const goal = (goalsByMatch.get(m.id) ?? []).find(g => g.player_id === pick.playerId);
  const n = goal?.goals ?? 0;
  if (n <= 0) return null;
  return { goals: n, bonus: scorerBonus(n, m.stage), name: pick.name, team: pick.team };
}

// "1.5" / "2" / "5" — sem zeros à toa (multiplicador do bônus de artilheiro)
function fmtMult(stage) {
  return String(stageMultiplier(stage)).replace(/\.0$/, '');
}

// ----- Conteúdo dos popovers (tooltip estilizado, montado em hover) -----
// Cada gatilho carrega seu HTML num <template hidden> irmão; ver initTooltips().
function tipShell(kicker, tier, tierCls, rowsHtml, totalCls, totalTxt) {
  return `
    <div class="tip-head">
      <span class="tip-kicker">${escapeHtml(kicker)}</span>
      <span class="tip-tier ${tierCls}">${escapeHtml(tier)}</span>
    </div>
    <div class="tip-rows">${rowsHtml}</div>
    <div class="tip-total">
      <span class="tip-total-lbl">Total no jogo</span>
      <span class="tip-total-sum ${totalCls}">${totalTxt}</span>
    </div>`;
}

// Palpite: modelo ADITIVO — cada acerto soma; o "peso" é o valor da fase (não há ×N único).
function betTipHtml(bet, m, pts, isExact) {
  const tier = isExact ? ['Placar exato', 'exact']
    : pts > 0 ? ['Acerto parcial', 'partial']
    : ['Não pontuou', 'zero'];
  const { parts } = scoreBreakdown(
    bet.pred_home, bet.pred_away, bet.pred_pen_winner,
    m.actual_home, m.actual_away, m.pen_winner, m.stage,
  );
  const rows = parts.length > 0
    ? parts.map(p => `
        <div class="tip-row">
          <span class="tip-row-lbl">${escapeHtml(p.label)}</span>
          <span class="tip-row-val add"><span class="op">+</span>${p.pts}</span>
        </div>`).join('')
    : `<div class="tip-row miss-row"><span class="tip-row-lbl">Errou gols, resultado e saldo</span></div>`;
  return tipShell(stageDisp(m), tier[0], tier[1], rows, tier[1], pts > 0 ? `+${pts}` : '0');
}

// Artilheiro: bônus MULTIPLICATIVO — gols × 2 × peso da fase.
function scorerTipHtml(sc, m) {
  const mult = stageMultiplier(m.stage);
  const golLbl = `Gols na partida${sc.goals > 1 ? ` (${sc.goals})` : ''}`;
  let rows = `
    <div class="tip-player">${flag(sc.team)} <span>${escapeHtml(sc.name)}</span></div>
    <div class="tip-row">
      <span class="tip-row-lbl">${golLbl}</span>
      <span class="tip-row-val">${sc.goals}</span>
    </div>
    <div class="tip-row">
      <span class="tip-row-lbl">Pontos por gol</span>
      <span class="tip-row-val"><span class="op">×</span>2</span>
    </div>`;
  if (mult > 1) {
    rows += `
    <div class="tip-row">
      <span class="tip-row-lbl">Peso · ${escapeHtml(stageLabel(m.stage))}</span>
      <span class="tip-row-val mult"><span class="op">×</span>${fmtMult(m.stage)}</span>
    </div>`;
  }
  return tipShell('Bônus de artilheiro', 'Seu artilheiro', 'scorer', rows, 'scorer', `+${sc.bonus}`);
}

// ----- Finalizada: resultado + pontos + gols -----
function renderFinishedCard(m) {
  // Ordena: pontos desc → total de gols desc → mandante desc → nome
  const bets = [...(predsByMatch.get(m.id) ?? [])].sort((a, b) =>
    (b.points_earned ?? 0) - (a.points_earned ?? 0)
    || predGoals(b) - predGoals(a)
    || (b.pred_home ?? 0) - (a.pred_home ?? 0)
    || (a.profiles?.full_name || '').localeCompare(b.profiles?.full_name || '')
  );
  const goals = goalsByMatch.get(m.id) ?? [];
  const penInfo = m.pen_winner
    ? `<small>pen: ${m.pen_winner === 'home' ? teamPt(m.team_home) : teamPt(m.team_away)}</small>` : '';
  const score = `<div class="hh-score">${m.actual_home}<i>–</i>${m.actual_away}${penInfo}</div>`;

  return `
    <div class="history-card ${stageCls(m)}">
      ${cardHead(m, score)}

      ${renderBetsList(m, bets, true)}

      ${goals.length > 0 ? `
        <div class="history-scorers">
          <span class="label">${ICON.ball} Gols</span>
          ${goals.map(g => `<span class="scorer"><span class="fl">${flag(g.players.team)}</span> ${escapeHtml(g.players.full_name)} <span class="num">${g.goals}</span></span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

// ----- Próxima partida (aguardando): palpites de todos, SEM pontos -----
function renderAwaitingCard(m) {
  const live = isLive(m);
  // Ordena por total de gols desc → mandante desc → nome ("Você" fica destacado pelo estilo)
  const bets = [...(predsByMatch.get(m.id) ?? [])].sort((a, b) =>
    predGoals(b) - predGoals(a)
    || (b.pred_home ?? 0) - (a.pred_home ?? 0)
    || (a.profiles?.full_name || '').localeCompare(b.profiles?.full_name || '')
  );
  const status = `<div class="hh-status"><span class="pill ${live ? 'live' : 'locked'}">${live ? 'Ao vivo' : 'Aguardando resultado'}</span></div>`;

  return `
    <div class="history-card ${stageCls(m)} awaiting">
      ${cardHead(m, status)}

      ${renderBetsList(m, bets, false)}
    </div>
  `;
}

// ----- Lista de palpites (tabela editorial) -----
function renderBetsList(m, bets, finished) {
  if (bets.length === 0) {
    return `<div class="history-bets-empty">Nenhum palpite registrado pra este jogo.</div>`;
  }
  if (!finished) {
    return `
      <div class="history-bets awaiting">
        ${bets.map(renderAwaitingRow).join('')}
      </div>
    `;
  }
  return `
    <div class="history-bets">
      <div class="hb-head"><span class="c">#</span><span>Jogador</span><span class="c">Palpite</span><span>Resultado</span><span class="r">Pts</span></div>
      ${bets.map((b, i) => renderBetRow(b, m, i + 1)).join('')}
    </div>
  `;
}

function renderAwaitingRow(bet) {
  const isMe = bet.user_id === profile.id;
  const name = isMe ? 'Você' : (bet.profiles?.full_name || '?');
  return `
    <div class="hb-row ${isMe ? 'me' : ''}">
      <span class="hb-rank">—</span>
      <span class="hb-player"><span class="av-mini">${avatarHtml(bet.profiles)}</span><span class="nm">${escapeHtml(name)}</span></span>
      <span class="pred">${bet.pred_home}<span class="x">–</span>${bet.pred_away}</span>
    </div>
  `;
}

function renderBetRow(bet, m, rank) {
  const isMe = bet.user_id === profile.id;
  const name = isMe ? 'Você' : (bet.profiles?.full_name || '?');

  const pts = bet.points_earned ?? 0;
  const isExact = bet.pred_home === m.actual_home && bet.pred_away === m.actual_away;
  const rowClass = isExact ? 'win-exact' : pts > 0 ? 'win-partial' : 'miss';
  const ptsClass = isExact ? 'exact' : pts > 0 ? 'partial' : 'zero';
  const resClass = isExact ? 'exact' : pts > 0 ? 'partial' : 'miss';
  const resIcon  = isExact ? KPI.exact : pts > 0 ? KPI.partial : KPI.miss;
  const resLabel = isExact ? 'Placar exato' : pts > 0 ? 'Acerto parcial' : 'Não pontuou';

  // Bônus de artilheiro: chip discreto quando o artilheiro DESTA pessoa marcou no jogo.
  // O <template class="tip-src"> tem que ser o irmão IMEDIATO do gatilho [data-tip].
  const sc = scorerHitFor(bet, m);
  const scorerChip = sc
    ? `<span class="hb-scorer" data-tip>${ICON.ball}+${sc.bonus}</span><template class="tip-src">${scorerTipHtml(sc, m)}</template>`
    : '';

  return `
    <div class="hb-row ${rowClass} ${isMe ? 'me' : ''} ${rank === 1 ? 'top' : ''}">
      <span class="hb-rank">${rank}</span>
      <span class="hb-player"><span class="av-mini">${avatarHtml(bet.profiles)}</span><span class="nm">${escapeHtml(name)}</span></span>
      <span class="pred">${bet.pred_home}<span class="x">–</span>${bet.pred_away}</span>
      <span class="hb-res ${resClass}">${resIcon}<span class="w">${resLabel}</span></span>
      <span class="hb-ptswrap"><span class="pts ${ptsClass}" data-tip>${pts > 0 ? '+' + pts : '0'}</span><template class="tip-src">${betTipHtml(bet, m, pts, isExact)}</template>${scorerChip}</span>
    </div>
  `;
}

// ============================================================
// Eventos
// ============================================================
function attachEventListeners() {
  document.addEventListener('click', (e) => {
    // ABA 1: fase
    const tab = e.target.closest('.admin-tab[data-stage]');
    if (tab) {
      if (tab.dataset.stage !== activeStage) {
        activeStage = tab.dataset.stage;
        activeDay = null;          // renderTabBody → ensureValidDay seleciona o dia mais recente
        activeStatus = 'finished'; // renderTabBody → ensureValidStatus ajusta se o dia não tiver finalizadas
        document.querySelectorAll('#stageTabs .admin-tab').forEach(t =>
          t.classList.toggle('active', t.dataset.stage === activeStage));
        document.getElementById('tabBody').innerHTML = renderTabBody();
      }
      return;
    }
    // ABA 2: dia (célula do calendário)
    const dayCell = e.target.closest('.cal-day[data-date]');
    if (dayCell) {
      if (dayCell.dataset.date !== activeDay) {
        activeDay = dayCell.dataset.date;
        ensureValidStatus();  // mantém o status atual se houver jogos; senão troca
        // re-render do corpo: move o destaque do calendário + recontagem dos chips
        // + Resumo do dia + lista, tudo coerente com o novo dia.
        document.getElementById('tabBody').innerHTML = renderTabBody();
      }
      return;
    }
    // FILTRO: status
    const chip = e.target.closest('[data-status]');
    if (chip) {
      if (chip.dataset.status === activeStatus) return;
      activeStatus = chip.dataset.status;
      document.querySelectorAll('#statusChips .chip').forEach(c =>
        c.classList.toggle('active', c.dataset.status === activeStatus));
      document.getElementById('historyList').innerHTML = renderList();
      return;
    }
  });

  initTooltips();
}

// Tooltip flutuante (pontos / artilheiro) vem do módulo compartilhado ../tooltip.js —
// mesmo contrato: gatilho [data-tip] + <template class="tip-src"> irmão com o HTML.

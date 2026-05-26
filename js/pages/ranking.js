import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import {
  flag, escapeHtml, teamPt, formatBrShort, formatTime, showToast,
  avatarHtml, getInitials,
} from '../util.js';

// ============================================================
// Estado
// ============================================================
let profile, stats, settings;
let leaderboard = [];        // ranked users from v_leaderboard
let scorerRanking = [];      // v_scorer_ranking
let championPicksByUser = new Map();  // user_id -> { team }
let scorerPicksByUser = new Map();    // user_id -> { player_id, players: {...} }
let expandedUserId = null;
let realChampion = null;     // string — campeão real (null se final não terminou)
const profileCache = new Map();

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  await loadData();

  const pageBody = await renderShell({ active: 'ranking', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');

  attachEventListeners();
} catch (err) {
  console.error('[ranking] FATAL:', err);
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
  const [statsRes, leaderRes, scorerRes, settingsRes, champRes, sPickRes, profilesRes, finalRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    supabase.from('v_leaderboard').select('*'),
    supabase.from('v_scorer_ranking').select('*'),
    supabase.from('settings').select('key, value'),
    supabase.from('champion_picks').select('*'),
    supabase.from('top_scorer_picks').select('*, players(full_name, team)'),
    supabase.from('profiles').select('id, avatar_url'),
    supabase.from('matches').select('team_home, team_away, actual_home, actual_away, pen_winner, finished').eq('stage', 'final').maybeSingle(),
  ]);

  if (leaderRes.error) throw leaderRes.error;

  stats = statsRes.data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0, total_pot: 0 };
  leaderboard = leaderRes.data ?? [];
  scorerRanking = scorerRes.data ?? [];

  // Determina campeão real da Final
  const fm = finalRes.data;
  if (fm?.finished) {
    if (fm.actual_home > fm.actual_away) realChampion = fm.team_home;
    else if (fm.actual_away > fm.actual_home) realChampion = fm.team_away;
    else if (fm.pen_winner === 'home') realChampion = fm.team_home;
    else if (fm.pen_winner === 'away') realChampion = fm.team_away;
  }

  // Merge avatar_url no leaderboard
  const avatarMap = new Map((profilesRes.data ?? []).map(p => [p.id, p.avatar_url]));
  leaderboard = leaderboard.map(u => ({ ...u, avatar_url: avatarMap.get(u.user_id) }));

  championPicksByUser = new Map((champRes.data ?? []).map(p => [p.user_id, p]));
  scorerPicksByUser   = new Map((sPickRes.data ?? []).map(p => [p.user_id, p]));

  settings = Object.fromEntries(
    (settingsRes.data ?? []).map(r => [r.key, typeof r.value === 'string' ? tryParse(r.value) : r.value])
  );
}

function tryParse(s) { try { return JSON.parse(s); } catch { return s; } }

// ============================================================
// Render
// ============================================================
function renderPage() {
  const totalPot = computeTotalPot();
  const split = settings.prize_split || { first: 70, second: 20, third: 10 };

  return `
    <section class="hero">
      <div class="hero-kicker">Quem está ganhando o bolão</div>
      <h1 class="hero-title">Ranking</h1>
      <div class="hero-meta">
        <b>${leaderboard.length}</b> jogadores<span class="sep"></span>
        <b>${stats.finished_matches}</b> jogos finalizados<span class="sep"></span>
        atualiza em tempo real
      </div>
    </section>

    ${renderPot(totalPot, split)}

    ${leaderboard.length === 0 ? renderEmpty() : renderPodium(totalPot, split)}

    ${leaderboard.length > 0 ? `
      <div class="section-head"><h3>Tabela completa</h3></div>
      <div class="rank-table-wrap">
        <table class="rank-table" id="rankTable">
          <thead>
            <tr>
              <th class="left col-pos">#</th>
              <th class="left col-player">Jogador</th>
              <th class="col-stat">Exatos</th>
              <th class="col-stat">V+SG</th>
              <th class="col-stat">V</th>
              <th class="col-stat">1 Lado</th>
              <th class="left col-pick">Campeão</th>
              <th class="left col-pick">Artilheiro</th>
              <th class="col-pts">Pts</th>
            </tr>
          </thead>
          <tbody id="rankBody">
            ${leaderboard.map(renderRankRow).join('')}
          </tbody>
        </table>
      </div>
    ` : ''}

    <div id="drillDown"></div>
  `;
}

function renderEmpty() {
  return `
    <div class="empty">
      <h3>Ainda sem jogadores ou jogos pontuados</h3>
      <p>O ranking começa a aparecer assim que:
        <br>1) houver usuários pagos no bolão (marcar no Admin)
        <br>2) houver pelo menos 1 jogo finalizado com resultado lançado</p>
      <a class="btn btn-ghost" href="inicio.html">← Início</a>
    </div>
  `;
}

function renderPot(totalPot, split) {
  const first  = Math.round(totalPot * split.first  / 100);
  const second = Math.round(totalPot * split.second / 100);
  const third  = Math.round(totalPot * split.third  / 100);

  return `
    <div class="pot">
      <div class="pot-cell big">
        <div class="lbl">Bolso total</div>
        <div class="val">${formatBRL(totalPot)}</div>
      </div>
      <div class="pot-cell">
        <div class="lbl">1º · ${split.first}%</div>
        <div class="val">${formatBRL(first)}</div>
      </div>
      <div class="pot-cell">
        <div class="lbl">2º · ${split.second}%</div>
        <div class="val">${formatBRL(second)}</div>
      </div>
      <div class="pot-cell">
        <div class="lbl">3º · ${split.third}%</div>
        <div class="val">${formatBRL(third)}</div>
      </div>
      <div class="pot-cell">
        <div class="lbl">Pagos</div>
        <div class="val">${stats.paid_users}</div>
      </div>
    </div>
  `;
}

function renderPodium(totalPot, split) {
  const top3 = leaderboard.slice(0, 3);
  if (top3.length === 0) return '';
  const prizes = [
    Math.round(totalPot * split.first  / 100),
    Math.round(totalPot * split.second / 100),
    Math.round(totalPot * split.third  / 100),
  ];

  // ordem visual: 2º · 1º · 3º
  const order = top3.length === 1 ? [0]
              : top3.length === 2 ? [1, 0]
              : [1, 0, 2];

  return `
    <div class="podium">
      ${order.map(idx => {
        const u = top3[idx];
        if (!u) return '<div></div>';
        const place = idx + 1;
        return `
          <div class="podium-card ${place === 1 ? 'first' : ''}" data-user-id="${u.user_id}">
            <div class="podium-place">${place}º</div>
            <div class="podium-av">${avatarHtml(u)}</div>
            <div class="podium-name">${escapeHtml(u.full_name)}</div>
            <div class="podium-pts">${u.total_pts} pts · ${u.exact_count} exatos</div>
            <div class="podium-prize">${formatBRL(prizes[idx])}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderRankRow(u, idx) {
  const pos = idx + 1;
  const isMe = u.user_id === profile.id;
  const posClass = pos <= 3 ? 'pos pos-top' : 'pos';
  const rowClass = isMe ? 'me-row' : '';

  // Campeão: mostra a escolha + pontos. Quando a Final terminou e errou, mostra "0" apagado.
  const champPick = championPicksByUser.get(u.user_id);
  const finalDone = realChampion !== null;
  let champPtsBadge = '';
  if (champPick) {
    if (u.champion_pts > 0) {
      champPtsBadge = `<span class="pick-pts">+${u.champion_pts}</span>`;
    } else if (finalDone) {
      // Final acabou e o palpite errou → mostra 0 apagado
      champPtsBadge = `<span class="pick-pts zero" title="Não acertou o campeão">0</span>`;
    }
  }
  const champCell = champPick
    ? `<div class="pick-cell">
         <span class="flag">${flag(champPick.team)}</span>
         <span class="pick-name">${escapeHtml(teamPt(champPick.team))}</span>
         ${champPtsBadge}
       </div>`
    : '<span style="color:var(--text-mute); font-style:italic;">—</span>';

  // Artilheiro: mostra escolha + gols + pontos. Quando torneio acabou e 0 gols, mostra "0" apagado.
  const sPick = scorerPicksByUser.get(u.user_id);
  const scorerStats = scorerRanking.find(s => s.user_id === u.user_id);
  const goals = scorerStats?.goals ?? 0;
  const tournamentDone = stats?.finished_matches === stats?.total_matches && stats?.total_matches > 0;
  let scorerPtsBadge = '';
  if (sPick) {
    if (u.scorer_pts > 0) {
      scorerPtsBadge = `<span class="pick-pts">+${u.scorer_pts}</span>`;
    } else if (tournamentDone) {
      scorerPtsBadge = `<span class="pick-pts zero" title="Jogador não marcou nenhum gol">0</span>`;
    }
  }
  const scorerCell = sPick
    ? `<div class="pick-cell">
         <span class="flag">${flag(sPick.players.team)}</span>
         <span class="pick-name">${escapeHtml(lastName(sPick.players.full_name))}</span>
         ${goals > 0 ? `<span class="pick-pts">${goals}⚽</span>` : ''}
         ${scorerPtsBadge}
       </div>`
    : '<span style="color:var(--text-mute); font-style:italic;">—</span>';

  return `
    <tr class="${rowClass}" data-user-id="${u.user_id}">
      <td class="left"><span class="${posClass}">${pos}</span></td>
      <td class="left">
        <div class="user-cell">
          <div class="av-mini">${avatarHtml(u)}</div>
          <div style="min-width:0;">
            <div class="nm">${escapeHtml(u.full_name)}${isMe ? '<span class="me-badge">VOCÊ</span>' : ''}</div>
          </div>
        </div>
      </td>
      <td>${u.exact_count}</td>
      <td>${u.winner_sg_count}</td>
      <td>${u.winner_count}</td>
      <td>${u.side_count}</td>
      <td class="left pick-col">${champCell}</td>
      <td class="left pick-col">${scorerCell}</td>
      <td class="pts">${u.total_pts}</td>
    </tr>
  `;
}

function lastName(s) {
  // "Kylian Mbappé" → "Mbappé"
  // Útil pra coluna estreita
  const parts = (s || '').trim().split(/\s+/);
  return parts[parts.length - 1] || s;
}

// ============================================================
// Drill-down (perfil expandido)
// ============================================================
async function expandUser(userId) {
  expandedUserId = userId;
  const u = leaderboard.find(x => x.user_id === userId);
  if (!u) return;

  const container = document.getElementById('drillDown');
  container.innerHTML = `<div class="loader" style="min-height: 100px;"></div>`;

  // Marca linha como expanded
  document.querySelectorAll('#rankBody tr').forEach(tr => {
    tr.classList.toggle('expanded', tr.dataset.userId === userId);
  });

  // Scroll suave
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Carrega palpites (cache)
  let payload = profileCache.get(userId);
  if (!payload) {
    payload = await loadUserDetails(userId);
    profileCache.set(userId, payload);
  }

  container.innerHTML = renderDrill(u, payload);
}

async function loadUserDetails(userId) {
  const [predsRes, champRes, scorerPickRes] = await Promise.all([
    supabase.from('predictions')
      .select('*, matches(*)')
      .eq('user_id', userId)
      .order('match_id'),
    supabase.from('champion_picks').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('top_scorer_picks').select('*, players(*)').eq('user_id', userId).maybeSingle(),
  ]);

  return {
    preds: predsRes.data ?? [],
    champion: champRes.data,
    scorer: scorerPickRes.data,
  };
}

function renderDrill(u, payload) {
  const { preds, champion, scorer } = payload;

  // Stats
  const scored = preds.filter(p => p.matches?.finished && p.points_earned != null);
  const exactos = scored.filter(p => p.points_earned === 5).length;
  const parciais = scored.filter(p => p.points_earned > 0 && p.points_earned !== 5).length;
  const erros = scored.filter(p => p.points_earned === 0).length;

  // KO multiplier-aware exact count: pts >= 5 = exact
  const finishedKO = scored.filter(p => p.matches?.stage !== 'group');

  return `
    <div class="profile-drill">
      <div class="profile-head">
        <div class="profile-av">${avatarHtml(u)}</div>
        <div class="profile-info">
          <h3>${escapeHtml(u.full_name)}</h3>
          <p>${u.total_pts} pts · ${preds.length} palpites · ${u.paid ? 'pagou' : 'pendente'}</p>
        </div>
        <button class="profile-close" data-action="close-drill" title="Fechar">×</button>
      </div>

      <div class="profile-stats">
        <div class="profile-stat">
          <div class="v">${u.match_pts}</div>
          <div class="l">Pts jogos</div>
        </div>
        <div class="profile-stat">
          <div class="v gold">${u.champion_pts}</div>
          <div class="l">Pts campeão</div>
        </div>
        <div class="profile-stat">
          <div class="v gold">${u.scorer_pts}</div>
          <div class="l">Pts artilheiro</div>
        </div>
        <div class="profile-stat">
          <div class="v green">${exactos}</div>
          <div class="l">Placares exatos</div>
        </div>
        <div class="profile-stat">
          <div class="v">${parciais}</div>
          <div class="l">Acertos parciais</div>
        </div>
        <div class="profile-stat">
          <div class="v red">${erros}</div>
          <div class="l">Erros</div>
        </div>
      </div>

      <div class="profile-section-title">Apostas únicas</div>
      ${renderChampionResultRow(u, champion)}
      <div class="profile-row" style="grid-template-columns: 1fr auto; cursor: default; margin-bottom: 12px;">
        <div class="vs">⚽ Artilheiro: ${scorer ? `<strong>${flag(scorer.players.team)} ${escapeHtml(scorer.players.full_name)}</strong>` : '<em style="color:var(--text-mute);">não escolheu</em>'}</div>
        <div class="pts-cell ${u.scorer_pts > 0 ? 'win' : 'zero'}">${u.scorer_pts > 0 ? '+' + u.scorer_pts : '—'}</div>
      </div>

      ${scored.length > 0 ? `
        <div class="profile-section-title">Histórico de palpites pontuados (${scored.length})</div>
        ${scored.map(renderPredRow).join('')}
      ` : `
        <div class="profile-section-title">Histórico de palpites</div>
        <div class="empty" style="padding:24px;"><p>Nenhum palpite pontuado ainda. Aguardando resultados dos jogos.</p></div>
      `}

      ${preds.length > scored.length ? `
        <div style="margin-top:12px; font-size:12px; color:var(--text-mute); text-align:center;">
          + ${preds.length - scored.length} palpite${preds.length - scored.length > 1 ? 's' : ''} pendente${preds.length - scored.length > 1 ? 's' : ''} (jogos não finalizados)
        </div>
      ` : ''}
    </div>
  `;
}

function renderChampionResultRow(u, champion) {
  const finalDone = realChampion !== null;
  const hit = finalDone && champion && champion.team === realChampion;
  const missed = finalDone && champion && champion.team !== realChampion;
  const isMe = u.user_id === profile.id;

  if (!champion) {
    return `
      <div class="profile-row champion-result" style="grid-template-columns: 1fr auto; cursor: default; margin-bottom: 8px;">
        <div class="vs">🏆 Campeão: <em style="color:var(--text-mute);">não escolheu</em></div>
        <div class="pts-cell zero">—</div>
      </div>
    `;
  }

  // Caso final ainda não terminou
  if (!finalDone) {
    return `
      <div class="profile-row champion-result" style="grid-template-columns: 1fr auto; cursor: default; margin-bottom: 8px;">
        <div class="vs">🏆 Campeão: <strong>${flag(champion.team)} ${escapeHtml(teamPt(champion.team))}</strong></div>
        <div class="pts-cell zero">—</div>
      </div>
    `;
  }

  // Final terminou — mostra acerto/erro com info clara
  return `
    <div class="profile-row champion-result ${hit ? 'champion-hit' : 'champion-miss'}" style="grid-template-columns: 1fr auto; cursor: default; margin-bottom: 8px;">
      <div class="vs">
        🏆 Campeão: <strong>${flag(champion.team)} ${escapeHtml(teamPt(champion.team))}</strong>
        ${hit
          ? `<span class="champion-tag hit">✓ levantou a taça</span>`
          : `<span class="champion-tag miss">✗ não foi campeão${isMe ? ` — você não ganhou pontos colocando ${escapeHtml(teamPt(champion.team))} como campeão` : ''}</span>`}
      </div>
      <div class="pts-cell ${hit ? 'win' : 'zero'}">${hit ? '+' + u.champion_pts : '0'}</div>
    </div>
    ${missed ? `
      <div class="profile-row champion-actual" style="grid-template-columns: 1fr auto; cursor: default; margin-bottom: 12px;">
        <div class="vs" style="color: var(--text-dim); font-size: 12px;">
          Campeão real: <strong style="color: var(--text);">${flag(realChampion)} ${escapeHtml(teamPt(realChampion))}</strong>
          ${isMe ? `<span style="color: var(--red); margin-left: 6px;">· você perdeu ${50} pts de bônus por errar</span>` : ''}
        </div>
        <div></div>
      </div>
    ` : ''}
  `;
}

function renderPredRow(p) {
  const m = p.matches;
  const pts = p.points_earned ?? 0;
  const ptsClass = pts >= 5 ? 'win' : pts > 0 ? 'partial' : 'zero';
  return `
    <div class="profile-row">
      <div class="when">${formatBrShort(new Date(m.match_date))} · ${formatTime(m.match_date)}</div>
      <div class="vs">${flag(m.team_home)} ${escapeHtml(teamPt(m.team_home))} × ${escapeHtml(teamPt(m.team_away))} ${flag(m.team_away)}</div>
      <div class="got">Palpitou ${p.pred_home}-${p.pred_away}</div>
      <div class="real">Real ${m.actual_home}-${m.actual_away}</div>
      <div class="pts-cell ${ptsClass}">${pts > 0 ? '+' + pts : '0'}</div>
    </div>
  `;
}

function closeDrill() {
  expandedUserId = null;
  document.getElementById('drillDown').innerHTML = '';
  document.querySelectorAll('#rankBody tr').forEach(tr => tr.classList.remove('expanded'));
}

// ============================================================
// Eventos
// ============================================================
function attachEventListeners() {
  document.addEventListener('click', (e) => {
    // Click na linha do ranking
    const row = e.target.closest('#rankBody tr[data-user-id]');
    if (row) {
      const uid = row.dataset.userId;
      if (uid === expandedUserId) closeDrill();
      else expandUser(uid);
      return;
    }
    // Click no card de pódio
    const podium = e.target.closest('.podium-card[data-user-id]');
    if (podium) {
      expandUser(podium.dataset.userId);
      return;
    }
    // Fechar drill
    if (e.target.closest('[data-action="close-drill"]')) {
      closeDrill();
      return;
    }
  });
}

// ============================================================
// Helpers
// ============================================================
function computeTotalPot() {
  const fee = settings.fee_amount ?? 100;
  return stats.paid_users * fee;
}

function formatBRL(value) {
  return `R$ ${Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}


import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase, fetchAllPages } from '../supabase.js';
import {
  flag, escapeHtml, teamPt, formatBrShort, formatTime, showToast,
  avatarHtml, getInitials, localDateKey,
} from '../util.js';
import { championBonus, scoreBreakdown, scorerBonus } from '../scoring.js';
import { renderRankChart } from '../rank-chart.js';
import { initTooltips } from '../tooltip.js';

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

// Dados p/ o gráfico de evolução (reconstruído por replay; ver buildProgression)
let finishedMatches = [];    // jogos finalizados, asc por data
let predPtsByUserMatch = new Map();  // `${user}|${match}` -> points_earned
let goalsByMatchPlayer = new Map();  // `${match}|${player}` -> goals
let qualByUserMatch = new Map();     // `${user}|${match}` -> pts (bônus classificado, jogo JÁ disputado)
let qualSpillByUser = new Map();     // user -> pts de classificado cujo jogo-ref ainda não foi disputado
let finalMatchId = null;

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

  const chartMount = document.getElementById('rankChart');
  if (chartMount) {
    const progression = buildProgression();
    if (progression) renderRankChart(chartMount, { progression, meId: profile.id });
  }

  // Prévia do gráfico (mesma vibe de "Palpites da galera") enquanto não há jogos.
  const chartPreviewMount = document.getElementById('rankChartPreview');
  if (chartPreviewMount) renderRankChart(chartPreviewMount, { progression: demoProgression(), meId: 'demo-me' });

  attachEventListeners();
  initTooltips();  // tooltips dos termos de pontuação (cabeçalhos da tabela)
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
  // Palpites pontuados de TODO o bolão: cresce com (usuários × jogos), então
  // PAGINA — sem isso o PostgREST corta em 1000 linhas e o gráfico subconta os
  // pontos (o fim das séries deixa de bater com o v_leaderboard). Ver fetchAllPages.
  const predPtsPromise = fetchAllPages(() =>
    supabase.from('predictions').select('user_id, match_id, points_earned')
      .not('points_earned', 'is', null).order('id'));

  const [statsRes, leaderRes, scorerRes, settingsRes, champRes, sPickRes, profilesRes, finalRes,
         finMatchesRes, predPtsRows, goalsRes, qualRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    supabase.from('v_leaderboard').select('*'),
    supabase.from('v_scorer_ranking').select('*'),
    supabase.from('settings').select('key, value'),
    supabase.from('champion_picks').select('*'),
    supabase.from('top_scorer_picks').select('*, players(full_name, team)'),
    supabase.from('profiles').select('id, avatar_url'),
    supabase.from('matches').select('team_home, team_away, actual_home, actual_away, pen_winner, finished').eq('stage', 'final').maybeSingle(),
    // ---- dados p/ reconstruir a evolução do ranking (replay por data do jogo) ----
    supabase.from('matches').select('id, match_date, stage, group_name, team_home, team_away, actual_home, actual_away')
      .eq('finished', true).order('match_date', { ascending: true }),
    predPtsPromise,
    supabase.from('player_goals').select('player_id, match_id, goals'),
    supabase.from('user_qualifier_points').select('user_id, breakdown'),
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

  // ---- prepara os índices p/ o replay da evolução ----
  finishedMatches = finMatchesRes.data ?? [];
  finalMatchId = finishedMatches.find(m => m.stage === 'final')?.id ?? null;
  const finishedIds = new Set(finishedMatches.map(m => m.id));

  for (const p of (predPtsRows ?? [])) {
    predPtsByUserMatch.set(`${p.user_id}|${p.match_id}`, p.points_earned ?? 0);
  }
  for (const g of (goalsRes.data ?? [])) {
    goalsByMatchPlayer.set(`${g.match_id}|${g.player_id}`, g.goals ?? 0);
  }
  // Bônus de classificado: cada item referencia o JOGO do mata-mata da vaga. Esse
  // jogo pode ainda não ter sido disputado (os pontos são creditados quando as
  // vagas se definem, p.ex. fim dos grupos). Se já foi disputado, atribui ao jogo;
  // senão joga no "spillover" (entra no último jogo disputado, garantindo que o
  // fim de cada série == total_pts da tabela).
  for (const row of (qualRes.data ?? [])) {
    for (const it of (row.breakdown?.items ?? [])) {
      const pts = it.pts ?? 0;
      if (pts === 0) continue;
      if (it.match_id != null && finishedIds.has(it.match_id)) {
        const k = `${row.user_id}|${it.match_id}`;
        qualByUserMatch.set(k, (qualByUserMatch.get(k) ?? 0) + pts);
      } else {
        qualSpillByUser.set(row.user_id, (qualSpillByUser.get(row.user_id) ?? 0) + pts);
      }
    }
  }
}

// ============================================================
// Evolução do ranking — replay determinístico
// ============================================================
// NÃO guardamos snapshots: a posição em qualquer momento é reconstruída
// somando, em ordem de DATA do jogo, tudo que é atribuível a um jogo:
//   • pontos do palpite (predictions.points_earned)
//   • artilheiro (gols do escolhido naquele jogo × multiplicador da fase)
//   • classificado (itens do breakdown, cada um com seu match_id)
//   • campeão (no jogo da final)
// A última coordenada de cada série == total_pts do v_leaderboard.
function dayKey(iso) {
  return localDateKey(iso);  // chave de dia no fuso de Brasília (SSOT)
}

function matchDelta(userId, m) {
  let d = predPtsByUserMatch.get(`${userId}|${m.id}`) ?? 0;

  // artilheiro: gols do jogador escolhido NESTE jogo
  const sPick = scorerPicksByUser.get(userId);
  if (sPick?.player_id != null) {
    const goals = goalsByMatchPlayer.get(`${m.id}|${sPick.player_id}`) ?? 0;
    if (goals > 0) d += scorerBonus(goals, m.stage);
  }

  // classificado: pontos atribuídos a este jogo
  d += qualByUserMatch.get(`${userId}|${m.id}`) ?? 0;

  // campeão: cai no jogo da final
  if (m.id === finalMatchId) {
    const champ = championPicksByUser.get(userId);
    if (champ && realChampion && champ.team === realChampion) d += championBonus(true);
  }

  return d;
}

function buildProgression() {
  const users = leaderboard.map(u => ({ userId: u.user_id, name: u.full_name, avatar_url: u.avatar_url }));
  if (finishedMatches.length === 0 || users.length === 0) return null;

  const lastIdx = finishedMatches.length - 1;

  // ----- Por jogo: uma coluna por partida finalizada -----
  const gameLabels = finishedMatches.map((_, i) => `Jogo ${i + 1}`);
  const gameSeries = users.map(u => {
    const spill = qualSpillByUser.get(u.userId) ?? 0;
    const values = [0];  // ponto inicial (antes de qualquer jogo)
    let acc = 0;
    finishedMatches.forEach((m, i) => {
      acc += matchDelta(u.userId, m);
      if (i === lastIdx) acc += spill;
      values.push(acc);
    });
    return { userId: u.userId, name: u.name, avatar_url: u.avatar_url, values };
  });

  // ----- Por dia: agrupa por data do jogo -----
  const days = [...new Set(finishedMatches.map(m => dayKey(m.match_date)))].sort();
  const dayLabels = days.map(k => {
    const [, mo, d] = k.split('-');  // k é yyyy-mm-dd (BRT) — sem Date, sem fuso
    return `${+d}/${+mo}`;
  });
  const matchesByDay = new Map(days.map(k => [k, finishedMatches.filter(m => dayKey(m.match_date) === k)]));
  const lastDayIdx = days.length - 1;
  const daySeries = users.map(u => {
    const spill = qualSpillByUser.get(u.userId) ?? 0;
    const values = [0];
    let acc = 0;
    days.forEach((k, i) => {
      for (const m of matchesByDay.get(k)) acc += matchDelta(u.userId, m);
      if (i === lastDayIdx) acc += spill;
      values.push(acc);
    });
    return { userId: u.userId, name: u.name, avatar_url: u.avatar_url, values };
  });

  return {
    game: { labels: gameLabels, series: gameSeries, matches: finishedMatches },
    day:  { labels: dayLabels, series: daySeries },
  };
}

function tryParse(s) { try { return JSON.parse(s); } catch { return s; } }

// ============================================================
// Render
// ============================================================
function renderPage() {
  const totalPot = computeTotalPot();
  const split = settings.prize_split || { first: 70, second: 20, third: 10 };
  const prizeByPos = [
    Math.round(totalPot * split.first  / 100),
    Math.round(totalPot * split.second / 100),
    Math.round(totalPot * split.third  / 100),
  ];
  // Atribui a cada jogador a posição (compartilhada em caso de empate total) e o
  // valor do prêmio já com o rateio aplicado. Muta o leaderboard adicionando
  // pos / tied / tieSize / prizeShare — usado por pódio e tabela.
  assignRanksAndPrizes(leaderboard, prizeByPos);

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

    <p class="hist-note">Quatro formas de pontuar: <b>Jogos</b> (cada acerto soma — lado, resultado e saldo) · <b>Campeão</b> +${championBonus(true)} · <b>Artilheiro</b> (gols × fase) · <b>Classificados</b> (time na fase certa). <a href="regras.html">Ver regras →</a></p>

    ${renderPot(totalPot, split)}

    ${leaderboard.length === 0 ? renderEmpty() : renderPodium()}

    ${leaderboard.length > 0 ? `
      <div class="section-head"><h3>Tabela completa</h3></div>
      <div class="rank-table-wrap">
        <table class="rank-table" id="rankTable">
          <thead>
            <tr>
              <th class="left col-pos">#</th>
              <th class="left col-player">Jogador</th>
              <th class="col-stat col-tiebreak" data-tip="Placares cravados — 1º critério de desempate depois dos pontos" tabindex="0">Exatos</th>
              <th class="col-stat col-tiebreak" data-tip="Acertou o vencedor E o saldo de gols, sem cravar — 2º critério de desempate" tabindex="0">V+S</th>
              <th class="col-stat col-soft" data-tip="Acertou só quem venceu (errou o saldo de gols)" tabindex="0">Venc.</th>
              <th class="col-stat col-soft" data-tip="Errou o vencedor, mas acertou os gols de um dos times" tabindex="0">Parc.</th>
              <th class="col-stat col-soft" data-tip="Palpites de jogos finalizados que não pontuaram" tabindex="0">Erros</th>
              <th class="col-stat" data-tip="Pontos dos palpites de jogos (lado + resultado + saldo)" tabindex="0">Jogos</th>
              <th class="left col-pick">Campeão</th>
              <th class="left col-pick">Artilheiro</th>
              <th class="col-stat" data-tip="Bônus por acertar times classificados (BPE/BP)" tabindex="0">Classif.</th>
              <th class="col-pts">Pts</th>
            </tr>
          </thead>
          <tbody id="rankBody">
            ${leaderboard.map(renderRankRow).join('')}
          </tbody>
        </table>
      </div>
      <p class="hist-note rank-legend">
        <b>Exatos</b> cravou o placar · <b>V+S</b> vencedor + saldo · <b>Venc.</b> só o vencedor · <b>Parc.</b> gols de um time · <b>Erros</b> não pontuou.
        Empate em <b>Pts</b> é desempatado por <b>Exatos</b>, depois por <b>V+S</b>. Empatou nos três? Os jogadores dividem a mesma posição e o prêmio é rateado.
        <a href="regras.html#desempate">Ver regras de desempate →</a>
      </p>
    ` : ''}

    <div id="drillDown"></div>

    ${leaderboard.length > 0 ? renderChartSection() : ''}
  `;
}

function renderChartSection() {
  const hasData = finishedMatches.length > 0;
  return `
    <div class="section-head">
      <h3>Evolução do ranking</h3>
      <span class="see-all">posição ao longo da Copa</span>
    </div>
    ${hasData
      ? `<div class="rank-chart" id="rankChart"></div>`
      : renderChartPreview()}
  `;
}

// Prévia "É assim que vai ficar": um bump chart de exemplo, desfocado, com
// chamada pra ação — espelha o preview de "Palpites da galera" (historico.js).
function renderChartPreview() {
  return `
    <div class="preview-wrap">
      <div class="preview-blurred" aria-hidden="true">
        <div class="rank-chart" id="rankChartPreview"></div>
      </div>
      <div class="preview-overlay">
        <span class="preview-badge">👀 Prévia</span>
        <h3>É assim que vai ficar</h3>
        <p>Assim que os jogos começarem, este gráfico mostra a <strong>posição de cada jogador ao longo da Copa</strong>
           — jogo a jogo e dia a dia, com cada virada. Os nomes acima são <strong>só de exemplo</strong>.</p>
        <a class="btn btn-green" href="palpites-grupos.html">Fazer meus palpites →</a>
      </div>
    </div>
  `;
}

// Progressão fictícia (pontos acumulados) pra ilustrar a prévia do gráfico.
// Mesmo formato de buildProgression: values[0] = 0 e cada etapa só soma.
function demoProgression() {
  const demo = [
    { userId: 'demo-me', name: 'Você', game: [0, 7, 14, 21, 33, 40, 52], day: [0, 14, 33, 52] },
    { userId: 'demo-1',  name: 'Diego', game: [0, 9, 12, 25, 28, 41, 47], day: [0, 12, 28, 47] },
    { userId: 'demo-2',  name: 'Elis',  game: [0, 5, 16, 19, 31, 38, 50], day: [0, 16, 31, 50] },
    { userId: 'demo-3',  name: 'Bia',   game: [0, 7, 11, 22, 30, 35, 44], day: [0, 11, 30, 44] },
    { userId: 'demo-4',  name: 'Caio',  game: [0, 3, 13, 18, 26, 37, 48], day: [0, 13, 26, 48] },
  ];
  const series = (key) => demo.map(d => ({ userId: d.userId, name: d.name, avatar_url: null, values: d[key] }));
  return {
    game: { labels: ['Jogo 1', 'Jogo 2', 'Jogo 3', 'Jogo 4', 'Jogo 5', 'Jogo 6'], series: series('game') },
    day:  { labels: ['11/6', '12/6', '13/6', '14/6'], series: series('day') },
  };
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

function renderPodium() {
  const top3 = leaderboard.slice(0, 3);
  if (top3.length === 0) return '';

  // A casa (1º/2º/3º) e o prêmio já vêm calculados por assignRanksAndPrizes —
  // assim empates aparecem como mesma posição e o prêmio já é o do rateio.
  const placeClass = (pos) => pos === 1 ? 'first' : pos === 2 ? 'second' : pos === 3 ? 'third' : '';

  // ordem visual: 2º · 1º · 3º
  const order = top3.length === 1 ? [0]
              : top3.length === 2 ? [1, 0]
              : [1, 0, 2];

  return `
    <div class="podium">
      ${order.map(idx => {
        const u = top3[idx];
        if (!u) return '<div></div>';
        return `
          <div class="podium-card ${placeClass(u.pos)}" data-user-id="${u.user_id}" role="button" tabindex="0" aria-label="Ver perfil de ${escapeHtml(u.full_name)}">
            <div class="podium-place">${u.pos}º</div>
            <div class="podium-av">${avatarHtml(u)}</div>
            <div class="podium-name">${escapeHtml(u.full_name)}</div>
            <div class="podium-pts">${u.total_pts} pts · ${u.exact_count} exatos</div>
            <div class="podium-prize">${formatBRL(Math.round(u.prizeShare))}</div>
            ${u.tied ? `<div class="podium-split">empate · rateio entre ${u.tieSize}</div>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderRankRow(u) {
  const pos = u.pos;
  const isMe = u.user_id === profile.id;
  const posClass = pos <= 3 ? `pos pos-top pos-${pos}` : 'pos';
  const rowClass = `${isMe ? 'me-row' : ''}${u.tied ? ' tied-row' : ''}`.trim();
  // Empate em TODOS os critérios → mesma posição, prêmio rateado (regra SBC 2022).
  const tieTag = u.tied
    ? `<span class="pos-tie" title="Empate em todos os critérios — mesma posição e prêmio dividido (rateio) entre ${u.tieSize}">=</span>`
    : '';

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
    <tr class="${rowClass}" data-user-id="${u.user_id}" tabindex="0" role="button" aria-expanded="false" aria-label="Ver perfil de ${escapeHtml(u.full_name)}">
      <td class="left"><span class="${posClass}">${pos}</span>${tieTag}</td>
      <td class="left">
        <div class="user-cell">
          <div class="av-mini">${avatarHtml(u)}</div>
          <div style="min-width:0;">
            <div class="nm">${escapeHtml(u.full_name)}${isMe ? '<span class="me-badge">VOCÊ</span>' : ''}</div>
          </div>
        </div>
      </td>
      <td class="tb">${u.exact_count}</td>
      <td class="tb">${u.winner_sg_count ?? 0}</td>
      <td class="soft">${u.winner_count ?? 0}</td>
      <td class="soft">${u.side_count ?? 0}</td>
      <td class="soft">${u.miss_count ?? 0}</td>
      <td>${u.match_pts}</td>
      <td class="left pick-col">${champCell}</td>
      <td class="left pick-col">${scorerCell}</td>
      <td>${(u.qualifier_pts ?? 0) > 0
            ? `<span class="qual-pts">+${u.qualifier_pts}</span>`
            : '<span style="color:var(--text-mute);">—</span>'}</td>
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
    const on = tr.dataset.userId === userId;
    tr.classList.toggle('expanded', on);
    if (tr.hasAttribute('aria-expanded')) tr.setAttribute('aria-expanded', String(on));
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
  const isExact = (p) => p.pred_home === p.matches.actual_home && p.pred_away === p.matches.actual_away;
  const exactos = scored.filter(isExact).length;
  const parciais = scored.filter(p => !isExact(p) && p.points_earned > 0).length;
  const erros = scored.filter(p => p.points_earned === 0).length;

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
          <div class="v gold">${u.qualifier_pts ?? 0}</div>
          <div class="l">Pts classificados</div>
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
          ${isMe ? `<span style="color: var(--red); margin-left: 6px;">· você perdeu ${championBonus(true)} pts de bônus por errar</span>` : ''}
        </div>
        <div></div>
      </div>
    ` : ''}
  `;
}

function renderPredRow(p) {
  const m = p.matches;
  const pts = p.points_earned ?? 0;
  const isExact = p.pred_home === m.actual_home && p.pred_away === m.actual_away;
  const ptsClass = isExact ? 'win' : pts > 0 ? 'partial' : 'zero';

  // Quebra aditiva: quais partes acertaram (lado / resultado / saldo)
  const { parts } = scoreBreakdown(
    p.pred_home, p.pred_away, p.pred_pen_winner,
    m.actual_home, m.actual_away, m.pen_winner, m.stage,
  );
  const breakdown = parts.length > 0
    ? `<div class="pred-break">${parts.map(part =>
        `<span class="brk ${part.key}">${part.label} <b>+${part.pts}</b></span>`).join('')}</div>`
    : `<div class="pred-break"><span class="brk miss">não pontuou</span></div>`;

  return `
    <div class="pred-entry">
      <div class="profile-row">
        <div class="when">${formatBrShort(new Date(m.match_date))} · ${formatTime(m.match_date)}</div>
        <div class="vs">${flag(m.team_home)} ${escapeHtml(teamPt(m.team_home))} × ${escapeHtml(teamPt(m.team_away))} ${flag(m.team_away)}</div>
        <div class="got">Palpitou ${p.pred_home}-${p.pred_away}</div>
        <div class="real">Real ${m.actual_home}-${m.actual_away}</div>
        <div class="pts-cell ${ptsClass}">${pts > 0 ? '+' + pts : '0'}</div>
      </div>
      ${breakdown}
    </div>
  `;
}

function closeDrill() {
  expandedUserId = null;
  document.getElementById('drillDown').innerHTML = '';
  document.querySelectorAll('#rankBody tr').forEach(tr => {
    tr.classList.remove('expanded');
    if (tr.hasAttribute('aria-expanded')) tr.setAttribute('aria-expanded', 'false');
  });
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
  // Teclado: Enter/Espaço abre/fecha o drill-down na linha/pódio focado
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('#rankBody tr[data-user-id]');
    const podium = e.target.closest('.podium-card[data-user-id]');
    if (!row && !podium) return;
    e.preventDefault();
    const uid = (row || podium).dataset.userId;
    if (row && uid === expandedUserId) closeDrill();
    else expandUser(uid);
  });
}

// ============================================================
// Posições com empate + rateio do prêmio (regra SBC 2022)
// ============================================================
// O v_leaderboard já vem ordenado por total_pts → exact_count → winner_sg_count
// (os 3 critérios de desempate da página de Regras). Quando dois jogadores
// empatam NOS TRÊS não há como separá-los: dividem a MESMA posição (ex.: dois
// "2º") e, se essa posição premia, os prêmios das casas que eles ocupam são
// somados e divididos por igual — o rateio.

// Dois jogadores empatam de verdade quando são iguais nos 3 critérios.
function tiedPair(a, b) {
  return a.total_pts === b.total_pts
      && a.exact_count === b.exact_count
      && (a.winner_sg_count ?? 0) === (b.winner_sg_count ?? 0);
}

// Muta cada linha adicionando: pos (posição "competição padrão": 1,2,2,4…),
// tied (compartilha posição), tieSize (quantos no bloco) e prizeShare (R$ já rateado).
// prizeByPos = [prêmio 1º, prêmio 2º, prêmio 3º] em reais.
function assignRanksAndPrizes(rows, prizeByPos) {
  rows.forEach((u, i) => {
    u.pos = (i > 0 && tiedPair(rows[i - 1], u)) ? rows[i - 1].pos : i + 1;
  });

  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].pos === rows[i].pos) j++;
    const size = j - i + 1;
    // Soma os prêmios das casas realmente ocupadas pelo bloco (pos … pos+size-1).
    let pool = 0;
    for (let k = 0; k < size; k++) {
      const slot = rows[i].pos + k; // casa 1-based
      if (slot >= 1 && slot <= prizeByPos.length) pool += prizeByPos[slot - 1];
    }
    const share = pool / size;
    for (let r = i; r <= j; r++) {
      rows[r].tied = size > 1;
      rows[r].tieSize = size;
      rows[r].prizeShare = share;
    }
    i = j + 1;
  }
  return rows;
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


// ============================================================
// Corrida da Chuteira de Ouro — artilharia ao vivo da Copa
// ============================================================
// Pódio dos 3 primeiros + lista do 4º em diante, alimentado por
// assets/data/topscorers.json (loadTopScorers em util.js). Destaca o artilheiro
// escolhido pelo usuário (linkagem por api_id == players.api_player_id).
//
// renderScorerRace(scorers, { pick, updatedAt }) -> HTML (string) | ''
//   scorers: [{ api_id, name, team, goals, assists, minutes }] (gols desc)
//   pick:    { apiId, name, team, localGoals } | null  — palpite do usuário
//
// Gating (princípio do projeto): sem artilheiros, NÃO renderiza nada.

import { flag, teamPt, escapeHtml } from './util.js';

// rank de competição: empatados dividem o posto (1,1,1,4,...)
function rankOf(scorers, s) {
  return scorers.filter((o) => o.goals > s.goals).length + 1;
}

// "há 2h" / "há 3 dias" / "agora" — rótulo discreto de frescor.
function freshLabel(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '';
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'atualizado agora';
  if (h < 24) return `atualizado há ${h}h`;
  const d = Math.floor(h / 24);
  return `atualizado há ${d} ${d === 1 ? 'dia' : 'dias'}`;
}

const mineTag = (txt = 'Seu palpite') => `<span class="ar-mine-tag">${txt}</span>`;

function pickBand(scorers, pick) {
  if (!pick?.apiId) return '';
  const inFeed = scorers.find((s) => s.api_id === pick.apiId) || null;
  const goals = inFeed ? inFeed.goals : (pick.localGoals ?? 0);
  const rank = inFeed ? rankOf(scorers, inFeed) : null;
  const tied = inFeed && scorers.filter((s) => s.goals === inFeed.goals).length > 1;

  let rk;
  if (rank === 1) rk = tied ? 'líder (empatado) 🥇' : 'líder isolado 🥇';
  else if (rank) rk = `${rank}º na artilharia`;
  else if (goals > 0) rk = 'fora do Top 20';
  else rk = 'ainda sem marcar';

  return `
    <div class="ar-mypick">
      <div class="ar-mypick-head">
        <span class="ar-mypick-ic" aria-hidden="true">⚽</span>
        <span class="ar-mypick-label">Seu artilheiro</span>
        <span class="ar-mypick-rk">${rk}</span>
      </div>
      <div class="ar-mypick-row">
        <span class="ar-mypick-name">${flag(pick.team)} <span class="nm">${escapeHtml(pick.name)}</span> <small>${escapeHtml(teamPt(pick.team))}</small></span>
        <span class="ar-mypick-stat"><b>${goals}</b><span class="u">${goals === 1 ? 'gol' : 'gols'}</span></span>
      </div>
    </div>`;
}

function podium(scorers, myApiId) {
  const top = scorers.slice(0, 3);
  // centro = 1º; ladeado por 2º (esq) e 3º (dir). Com <3, ordem natural.
  const order = top.length === 3 ? [1, 0, 2] : top.map((_, i) => i);
  const posCls = { 0: 'p1', 1: 'p2', 2: 'p3' };
  const cards = order.map((idx) => {
    const s = top[idx];
    const isMine = s.api_id === myApiId;
    return `
      <div class="ar-pod ${posCls[idx]}${isMine ? ' is-mine' : ''}">
        <div class="ar-pod-medal">${idx + 1}</div>
        <div class="ar-pod-flag">${flag(s.team)}</div>
        <div class="ar-pod-name">${escapeHtml(s.name)}</div>
        <div class="ar-pod-team">${escapeHtml(teamPt(s.team))}</div>
        <div class="ar-pod-goals">${s.goals}<span class="u">${s.goals === 1 ? 'gol' : 'gols'}</span></div>
        ${isMine ? mineTag() : ''}
      </div>`;
  }).join('');
  return `<div class="ar-podium">${cards}</div>`;
}

function listRow(scorers, s, myApiId) {
  const isMine = s.api_id === myApiId;
  return `
    <li class="ar-row${isMine ? ' is-mine' : ''}">
      <span class="ar-rank">${rankOf(scorers, s)}</span>
      ${flag(s.team)}
      <span class="ar-pl"><span class="ar-pl-txt">
        <div class="ar-pl-name">${escapeHtml(s.name)}</div>
        <div class="ar-pl-team">${escapeHtml(teamPt(s.team))}</div>
      </span></span>
      <span class="ar-g">${s.goals}<span class="u">G</span></span>
      <span class="ar-a">${s.assists ? s.assists + ' assist.' : '—'}</span>
    </li>`;
}

// Linha fixada para o palpite que está FORA do top (presença mesmo sem aparecer
// na lista da API). Usa o gol local (player_goals) já que não está no feed.
function pinnedPickRow(pick) {
  const g = pick.localGoals ?? 0;
  return `
    <li class="ar-row is-mine ar-row-pinned">
      <span class="ar-rank">—</span>
      ${flag(pick.team)}
      <span class="ar-pl"><span class="ar-pl-txt">
        <div class="ar-pl-name">${escapeHtml(pick.name)}</div>
        <div class="ar-pl-team">${escapeHtml(teamPt(pick.team))} · fora do Top 20</div>
      </span></span>
      <span class="ar-g">${g}<span class="u">G</span></span>
      <span class="ar-a">—</span>
    </li>`;
}

export function renderScorerRace(scorers, { pick = null, updatedAt = null } = {}) {
  if (!Array.isArray(scorers) || scorers.length === 0) return '';
  const myApiId = pick?.apiId ?? null;

  const rest = scorers.slice(3).map((s) => listRow(scorers, s, myApiId)).join('');
  const pickOutside = pick?.apiId && !scorers.some((s) => s.api_id === pick.apiId);
  const fresh = freshLabel(updatedAt);

  return `
    <section class="ar" id="scorerRace" aria-label="Corrida da Chuteira de Ouro">
      ${pickBand(scorers, pick)}
      <div class="section-head">
        <h3>Corrida da Chuteira de Ouro</h3>
        ${fresh ? `<span class="see-all">${fresh}</span>` : ''}
      </div>
      ${podium(scorers, myApiId)}
      ${rest || pickOutside ? `<ol class="ar-list">${rest}${pickOutside ? pinnedPickRow(pick) : ''}</ol>` : ''}
    </section>`;
}

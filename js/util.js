// Utilitários compartilhados entre páginas.

import { fifaRank } from './fifa-rank.js';

// ===== Bandeiras (flag-icons) =====
// Mapa de países para códigos ISO 3166-1 alpha-2 (lowercase)
// Inclui as 48 seleções da Copa + adversários dos amistosos/eliminatórias
export const FLAGS = {
  // Copa 2026
  Algeria: 'dz', Argentina: 'ar', Australia: 'au', Austria: 'at',
  Belgium: 'be', 'Bosnia & Herzegovina': 'ba', Brazil: 'br', Canada: 'ca',
  'Cape Verde': 'cv', Colombia: 'co', Croatia: 'hr', 'Curaçao': 'cw',
  'Czech Republic': 'cz', 'DR Congo': 'cd', Ecuador: 'ec', Egypt: 'eg',
  England: 'gb-eng', France: 'fr', Germany: 'de', Ghana: 'gh',
  Haiti: 'ht', Iran: 'ir', Iraq: 'iq', 'Ivory Coast': 'ci',
  Japan: 'jp', Jordan: 'jo', Mexico: 'mx', Morocco: 'ma',
  Netherlands: 'nl', 'New Zealand': 'nz', Norway: 'no', Panama: 'pa',
  Paraguay: 'py', Portugal: 'pt', Qatar: 'qa', 'Saudi Arabia': 'sa',
  Scotland: 'gb-sct', Senegal: 'sn', 'South Africa': 'za', 'South Korea': 'kr',
  Spain: 'es', Sweden: 'se', Switzerland: 'ch', Tunisia: 'tn',
  Turkey: 'tr', Uruguay: 'uy', USA: 'us', Uzbekistan: 'uz',
  // Outros adversários (amistosos / eliminatórias / Copa África)
  Albania: 'al', Angola: 'ao', Armenia: 'am', Azerbaijan: 'az',
  Bahrain: 'bh', Belarus: 'by', Bermuda: 'bm', Bolivia: 'bo',
  Botswana: 'bw', Bulgaria: 'bg', 'Burkina Faso': 'bf',
  Cameroon: 'cm', Chile: 'cl', China: 'cn', Comoros: 'km',
  'Costa Rica': 'cr', Cyprus: 'cy', Denmark: 'dk',
  'El Salvador': 'sv', 'Equatorial Guinea': 'gq', Estonia: 'ee',
  Eswatini: 'sz', 'Faroe Islands': 'fo', Finland: 'fi',
  Gabon: 'ga', Gambia: 'gm', Georgia: 'ge', Gibraltar: 'gi',
  Greece: 'gr', Guatemala: 'gt', Honduras: 'hn', Hungary: 'hu',
  Iceland: 'is', Ireland: 'ie', Italy: 'it', Jamaica: 'jm',
  Kazakhstan: 'kz', Kosovo: 'xk', Latvia: 'lv', Liechtenstein: 'li',
  Lithuania: 'lt', Luxembourg: 'lu', Mali: 'ml', Malta: 'mt',
  Mauritania: 'mr', Montenegro: 'me', Nicaragua: 'ni', Nigeria: 'ng',
  'Northern Ireland': 'gb-nir', Palestine: 'ps', Peru: 'pe', Poland: 'pl',
  'Puerto Rico': 'pr', Romania: 'ro', 'San Marino': 'sm',
  Serbia: 'rs', Slovakia: 'sk', Slovenia: 'si', Sudan: 'sd',
  Syria: 'sy', Tanzania: 'tz', 'Trinidad & Tobago': 'tt',
  Ukraine: 'ua', 'United Arab Emirates': 'ae', Venezuela: 've',
  Wales: 'gb-wls', Zambia: 'zm', Zimbabwe: 'zw',
  // Alias para nomes alternativos
  'United States': 'us',
};

/**
 * Retorna HTML de bandeira usando flag-icons.
 * @param {string} team - Nome do país
 * @returns {string} HTML span com classe flag-icons
 */
export function flag(team) {
  const code = FLAGS[decodeHtmlEntities(team)];
  if (!code) return '<span class="fi fi-xx"></span>'; // fallback
  return `<span class="fi fi-${code}"></span>`;
}

/**
 * Decodifica entities HTML básicas — recent.json tem strings como "Bosnia &amp; Herzegovina".
 */
export function decodeHtmlEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ============================================================
// Traduções PT-BR (display apenas — chaves originais no DB)
// ============================================================

// ===== Nomes de seleções =====
const TEAM_PT = {
  // Copa 2026
  Algeria: 'Argélia', Argentina: 'Argentina', Australia: 'Austrália', Austria: 'Áustria',
  Belgium: 'Bélgica', 'Bosnia & Herzegovina': 'Bósnia e Herzegovina', Brazil: 'Brasil', Canada: 'Canadá',
  'Cape Verde': 'Cabo Verde', Colombia: 'Colômbia', Croatia: 'Croácia', 'Curaçao': 'Curaçao',
  'Czech Republic': 'Tchéquia', 'DR Congo': 'RD Congo', Ecuador: 'Equador', Egypt: 'Egito',
  England: 'Inglaterra', France: 'França', Germany: 'Alemanha', Ghana: 'Gana',
  Haiti: 'Haiti', Iran: 'Irã', Iraq: 'Iraque', 'Ivory Coast': 'Costa do Marfim',
  Japan: 'Japão', Jordan: 'Jordânia', Mexico: 'México', Morocco: 'Marrocos',
  Netherlands: 'Países Baixos', 'New Zealand': 'Nova Zelândia', Norway: 'Noruega', Panama: 'Panamá',
  Paraguay: 'Paraguai', Portugal: 'Portugal', Qatar: 'Catar', 'Saudi Arabia': 'Arábia Saudita',
  Scotland: 'Escócia', Senegal: 'Senegal', 'South Africa': 'África do Sul', 'South Korea': 'Coreia do Sul',
  Spain: 'Espanha', Sweden: 'Suécia', Switzerland: 'Suíça', Tunisia: 'Tunísia',
  Turkey: 'Turquia', Uruguay: 'Uruguai', USA: 'Estados Unidos', 'United States': 'Estados Unidos',
  Uzbekistan: 'Uzbequistão',
  // Adversários em amistosos / eliminatórias
  Albania: 'Albânia', Angola: 'Angola', Armenia: 'Armênia', Azerbaijan: 'Azerbaijão',
  Bahrain: 'Bahrein', Belarus: 'Belarus', Bermuda: 'Bermudas', Bolivia: 'Bolívia',
  Botswana: 'Botsuana', Bulgaria: 'Bulgária', 'Burkina Faso': 'Burkina Faso',
  Cameroon: 'Camarões', Chile: 'Chile', China: 'China', Comoros: 'Comores',
  'Costa Rica': 'Costa Rica', Cyprus: 'Chipre', Denmark: 'Dinamarca',
  'El Salvador': 'El Salvador', 'Equatorial Guinea': 'Guiné Equatorial', Estonia: 'Estônia',
  Eswatini: 'Essuatíni', 'Faroe Islands': 'Ilhas Faroé', Finland: 'Finlândia',
  Gabon: 'Gabão', Gambia: 'Gâmbia', Georgia: 'Geórgia', Gibraltar: 'Gibraltar',
  Greece: 'Grécia', Guatemala: 'Guatemala', Honduras: 'Honduras', Hungary: 'Hungria',
  Iceland: 'Islândia', Ireland: 'Irlanda', Italy: 'Itália', Jamaica: 'Jamaica',
  Kazakhstan: 'Cazaquistão', Kosovo: 'Kosovo', Latvia: 'Letônia', Liechtenstein: 'Liechtenstein',
  Lithuania: 'Lituânia', Luxembourg: 'Luxemburgo', Mali: 'Mali', Malta: 'Malta',
  Mauritania: 'Mauritânia', Montenegro: 'Montenegro', Nicaragua: 'Nicarágua', Nigeria: 'Nigéria',
  'Northern Ireland': 'Irlanda do Norte', Palestine: 'Palestina', Peru: 'Peru', Poland: 'Polônia',
  'Puerto Rico': 'Porto Rico', Romania: 'Romênia', 'San Marino': 'San Marino',
  Serbia: 'Sérvia', Slovakia: 'Eslováquia', Slovenia: 'Eslovênia', Sudan: 'Sudão',
  Syria: 'Síria', Tanzania: 'Tanzânia', 'Trinidad & Tobago': 'Trinidad e Tobago',
  Ukraine: 'Ucrânia', 'United Arab Emirates': 'Emirados Árabes Unidos', Venezuela: 'Venezuela',
  Wales: 'País de Gales', Zambia: 'Zâmbia', Zimbabwe: 'Zimbábue',
};

/**
 * Traduz nome do time para PT-BR. Se não encontrar, retorna o original.
 */
export function teamPt(name) {
  if (!name) return name;
  const decoded = decodeHtmlEntities(name);
  return TEAM_PT[decoded] || decoded;
}

// ===== Cidades-sede =====
const GROUND_PT = {
  'Atlanta':                           'Atlanta',
  'Boston (Foxborough)':               'Boston (Foxborough)',
  'Dallas (Arlington)':                'Dallas (Arlington)',
  'Guadalajara (Zapopan)':             'Guadalajara (Zapopan)',
  'Houston':                           'Houston',
  'Kansas City':                       'Kansas City',
  'Los Angeles (Inglewood)':           'Los Angeles (Inglewood)',
  'Mexico City':                       'Cidade do México',
  'Miami (Miami Gardens)':             'Miami (Miami Gardens)',
  'Monterrey (Guadalupe)':             'Monterrey (Guadalupe)',
  'New York/New Jersey (East Rutherford)': 'Nova Iorque/Nova Jersey',
  'Philadelphia':                      'Filadélfia',
  'San Francisco Bay Area (Santa Clara)': 'São Francisco (Santa Clara)',
  'Seattle':                           'Seattle',
  'Toronto':                           'Toronto',
  'Vancouver':                         'Vancouver',
};

export function groundPt(name) {
  if (!name) return name;
  return GROUND_PT[name] || name;
}

// Versão curta (sem parênteses) para espaços apertados
export function groundShort(name) {
  const full = groundPt(name);
  return full.split(' (')[0];
}

// ===== Fases / round labels =====
/**
 * Traduz round_label de inglês para PT-BR.
 *   Matchday N           → Rodada N
 *   Round of 32          → 32-avos
 *   Round of 16          → Oitavas
 *   Quarter-final        → Quartas
 *   Semi-final           → Semifinais
 *   Match for third place→ Disputa do 3º Lugar
 *   Final                → Final
 */
export function roundLabelPt(label) {
  if (!label) return label;
  const m = /^Matchday\s+(\d+)$/i.exec(label);
  if (m) return `Rodada ${m[1]}`;
  switch (label) {
    case 'Round of 32':           return '32-avos';
    case 'Round of 16':           return 'Oitavas';
    case 'Quarter-final':         return 'Quartas';
    case 'Semi-final':            return 'Semifinais';
    case 'Match for third place': return 'Disputa do 3º Lugar';
    case 'Final':                 return 'Final';
    default: return label;
  }
}

// ===== Avatar helper =====
/**
 * Retorna HTML pra renderizar dentro de um .av/.av-mini/.podium-av/.profile-av:
 *   - se profile tem avatar_url: <img>
 *   - senão: iniciais (texto)
 */
export function avatarHtml(profileLike) {
  const url = profileLike?.avatar_url;
  if (url) {
    const name = profileLike?.full_name || profileLike?.email || '';
    return `<img src="${escapeAttr(url)}" alt="${escapeAttr(name)}">`;
  }
  return getInitials(profileLike?.full_name || profileLike?.email || '?');
}

export function getInitials(s) {
  return (s || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() || '').join('') || '?';
}

function escapeAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== Escape HTML =====
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ===== Saudação =====
export function greeting() {
  const h = new Date().getHours();
  if (h < 6)  return 'Boa madrugada';
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

export function firstName(s) {
  return (s || 'amigo').trim().split(/\s+/)[0];
}

// ===== Datas =====
export function daysToKickoffLabel() {
  const kickoff = new Date('2026-06-11T13:00:00-06:00');
  const days = Math.ceil((kickoff - new Date()) / 86400000);
  if (days <= 0) return 'Copa do Mundo 2026';
  return `Faltam ${days} dias`;
}

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function formatBrDate(d) {
  return `${DIAS[d.getDay()]} · ${d.getDate()}/${MESES[d.getMonth()]}`;
}

export function formatBrShort(d) {
  return `${d.getDate()}/${MESES[d.getMonth()]}`;
}

export function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function formatRelative(iso) {
  const diff = new Date(iso) - new Date();
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor(diff / 3600000);
  if (days >= 1) return `Em ${days} dia${days > 1 ? 's' : ''}`;
  if (hours >= 1) return `Em ${hours}h`;
  if (diff > 0)   return 'Em breve';
  return 'Iniciado';
}

// ===== Match helpers =====
export function stageLabel(s) {
  return {
    group: 'Grupos', r32: '32-avos', r16: 'Oitavas', qf: 'Quartas',
    sf: 'Semis', third: '3º Lugar', final: 'Final',
  }[s] || s;
}

/**
 * Computa standings de um grupo a partir de uma lista de jogos.
 * @param matches  jogos do grupo (12 grupos × 6 = 72 total)
 * @param mode     'real' = usa actual_home/away; 'sim' = usa pred_home/away
 * @param preds    Map<match_id, prediction> (necessário se mode='sim')
 * @returns [{ team, j, v, e, d, gp, gc, sg, pts }] ordenado por pts/sg/gp
 */
export function computeStandings(matches, mode, preds) {
  const stats = new Map();
  function ensure(team) {
    if (!stats.has(team)) {
      stats.set(team, { team, j: 0, v: 0, e: 0, d: 0, gp: 0, gc: 0, sg: 0, pts: 0 });
    }
    return stats.get(team);
  }

  // Initialize ALL teams from the group (even if they haven't played yet)
  for (const m of matches) {
    ensure(m.team_home);
    ensure(m.team_away);
  }

  for (const m of matches) {
    let h, a;
    if (mode === 'real') {
      if (!m.finished) continue;
      h = m.actual_home; a = m.actual_away;
    } else {
      const p = preds?.get(m.id);
      if (!p) continue;
      h = p.pred_home; a = p.pred_away;
    }
    if (h == null || a == null) continue;

    const sh = ensure(m.team_home);
    const sa = ensure(m.team_away);
    sh.j++; sa.j++;
    sh.gp += h; sh.gc += a;
    sa.gp += a; sa.gc += h;

    if (h > a)       { sh.v++; sa.d++; sh.pts += 3; }
    else if (a > h)  { sa.v++; sh.d++; sa.pts += 3; }
    else             { sh.e++; sa.e++; sh.pts += 1; sa.pts += 1; }
  }

  // Compute SG
  for (const s of stats.values()) s.sg = s.gp - s.gc;

  // Sort: PTS desc → SG desc → GP desc → FIFA rank asc (oficial)
  // Mesmo critério do SQL (resolve_match_slots): pts/sg/gf + fifa_rank tiebreaker.
  return [...stats.values()].sort((x, y) =>
    y.pts - x.pts
    || y.sg - x.sg
    || y.gp - x.gp
    || fifaRank(x.team) - fifaRank(y.team)
  );
}

/**
 * Match está acontecendo agora (entre kickoff e kickoff + 2.5h).
 */
export function isLive(m) {
  if (m.finished) return false;
  const start = new Date(m.match_date);
  const now = new Date();
  return now >= start && now < new Date(start.getTime() + 2.5 * 3600000);
}

/**
 * Match está travado para palpites (já começou ou já acabou).
 */
export function isLocked(m) {
  return new Date(m.match_date) <= new Date();
}

// ============================================================
// Recent matches loader (últimos jogos reais de cada seleção)
// ============================================================
// Carrega assets/data/recent.json e retorna Map<teamName, recentMatches[]>
// Cada recent match = { date, opponent, home, score, competition }
// Cacheado em memória para múltiplas chamadas.

let _recentCache = null;
export async function loadRecentMatches() {
  if (_recentCache) return _recentCache;
  try {
    const res = await fetch('assets/data/recent.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const map = new Map();
    for (const [team, rows] of Object.entries(raw)) {
      map.set(decodeHtmlEntities(team), rows.map(r => ({
        date: r[0],
        opponent: decodeHtmlEntities(r[1]),
        home: r[2],
        score: r[3],
        competition: decodeHtmlEntities(r[4]),
      })));
    }
    _recentCache = map;
    return map;
  } catch (err) {
    console.warn('[loadRecentMatches] failed:', err);
    return new Map();
  }
}

// ============================================================
// Team Tooltip — hover popover com últimos 5 jogos da seleção
// ============================================================
// Uso:
//   const recentByTeam = await loadRecentMatches();
//   attachTeamTooltips(recentByTeam);
//
// No HTML, envolva o nome do país em:
//   <span class="team-name" data-team="Brazil">Brazil</span>
//
// É seguro chamar múltiplas vezes (limpa handlers antigos).

let tooltipState = null;

export function attachTeamTooltips(recentByTeam) {
  // Singleton tooltip element
  let tooltip = document.getElementById('teamTooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'teamTooltip';
    tooltip.className = 'team-tooltip';
    document.body.appendChild(tooltip);
  }

  // Remove handlers de invocação anterior
  if (tooltipState) {
    document.removeEventListener('mouseover', tooltipState.onMouseOver);
    document.removeEventListener('mouseout', tooltipState.onMouseOut);
    window.removeEventListener('scroll', tooltipState.onScroll, true);
  }

  const onMouseOver = (e) => {
    const trigger = e.target.closest('.team-name[data-team]');
    if (!trigger) return;
    showTooltip(trigger, recentByTeam);
  };
  const onMouseOut = (e) => {
    const trigger = e.target.closest('.team-name[data-team]');
    if (!trigger) return;
    if (e.relatedTarget && trigger.contains(e.relatedTarget)) return;
    hideTooltip();
  };
  const onScroll = () => hideTooltip();

  document.addEventListener('mouseover', onMouseOver);
  document.addEventListener('mouseout', onMouseOut);
  window.addEventListener('scroll', onScroll, true);

  tooltipState = { onMouseOver, onMouseOut, onScroll };
}

function showTooltip(trigger, recentByTeam) {
  const team = trigger.dataset.team;
  const recent = recentByTeam.get(team);
  if (!recent || recent.length === 0) {
    // Time sem histórico carregado — mostra fallback simples
    const tooltip = document.getElementById('teamTooltip');
    tooltip.innerHTML = `
      <div class="tt-head">
        <span class="flag">${flag(team)}</span>
        <div class="info">
          <div class="nm">${escapeHtml(teamPt(team))}</div>
          <div class="sub">Sem histórico recente disponível</div>
        </div>
      </div>
    `;
    tooltip.classList.add('show');
    positionTooltip(trigger, tooltip);
    return;
  }

  const tooltip = document.getElementById('teamTooltip');
  tooltip.innerHTML = renderTooltipContent(team, recent);
  tooltip.classList.add('show');
  positionTooltip(trigger, tooltip);
}

function positionTooltip(trigger, tooltip) {
  const triggerRect = trigger.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const margin = 8;

  let left = triggerRect.left + (triggerRect.width / 2) - (tooltipRect.width / 2);
  let top  = triggerRect.bottom + margin;

  if (left < margin) left = margin;
  if (left + tooltipRect.width > window.innerWidth - margin) {
    left = window.innerWidth - tooltipRect.width - margin;
  }
  if (top + tooltipRect.height > window.innerHeight - margin) {
    top = triggerRect.top - tooltipRect.height - margin;
  }
  if (top < margin) top = margin;

  tooltip.style.left = left + 'px';
  tooltip.style.top  = top  + 'px';
}

function hideTooltip() {
  const tooltip = document.getElementById('teamTooltip');
  if (tooltip) tooltip.classList.remove('show');
}

function renderTooltipContent(team, recent) {
  const wins   = recent.filter(r => scoreResult(r.score) === 'W').length;
  const draws  = recent.filter(r => scoreResult(r.score) === 'D').length;
  const losses = recent.filter(r => scoreResult(r.score) === 'L').length;
  return `
    <div class="tt-head">
      <span class="flag">${flag(team)}</span>
      <div class="info">
        <div class="nm">${escapeHtml(teamPt(team))}</div>
        <div class="sub">
          Últimos ${recent.length} jogos ·
          <span style="color:var(--gold)">${wins}V</span>
          <span style="color:var(--text-mute)">${draws}E</span>
          <span style="color:var(--red)">${losses}D</span>
        </div>
      </div>
    </div>
    ${recent.map(renderRecentMatch).join('')}
  `;
}

function renderRecentMatch(m) {
  const result = scoreResult(m.score);
  const dt = new Date(m.date + 'T12:00:00');
  const dia = String(dt.getDate()).padStart(2, '0');
  const mes = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][dt.getMonth()];
  const ano = dt.getFullYear() !== new Date().getFullYear() ? `/${String(dt.getFullYear()).slice(2)}` : '';
  const venueBadge = m.home
    ? '<span class="tt-venue home">CASA</span>'
    : '<span class="tt-venue away">FORA</span>';
  const oppFlag = `<span class="flag">${flag(m.opponent)}</span>`;

  const resultClass = { W: 'win', D: 'draw', L: 'loss' }[result];
  const resultText  = { W: 'V', D: 'E', L: 'D' }[result];

  // Trunca competição: se tiver "·" pega só a primeira parte
  // (ex: "Copa Árabe 25 · Quartas" → "Copa Árabe 25")
  const compFull = m.competition;
  const compShort = compFull.split('·')[0].trim();
  const tooLong = compFull.length > 18;
  const compDisplay = tooLong ? compShort : compFull;

  return `
    <div class="tt-match">
      <div class="when">
        <strong>${dia}/${mes}${ano}</strong>
        <span class="tt-result ${resultClass}">${resultText}</span>
      </div>
      <div class="opp">
        <span class="opp-line">
          ${venueBadge}${oppFlag} <span class="opp-name">${escapeHtml(teamPt(m.opponent))}</span>
        </span>
        <span class="pred" title="${escapeHtml(compFull)}">${escapeHtml(compDisplay)}</span>
      </div>
      <span class="res finished">${escapeHtml(m.score)}</span>
    </div>
  `;
}

function scoreResult(score) {
  const [a, b] = String(score).split('-').map(s => parseInt(s, 10));
  if (isNaN(a) || isNaN(b)) return 'D';
  if (a > b) return 'W';
  if (a < b) return 'L';
  return 'D';
}

// ===== Toast =====
let toastTimeout;
export function showToast(message, kind = 'success', durationMs = 1800) {
  let toast = document.getElementById('saveToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'saveToast';
    toast.className = 'save-toast';
    document.body.appendChild(toast);
  }
  toast.className = `save-toast ${kind} show`;
  toast.textContent = message;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), durationMs);
}

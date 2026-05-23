// PANINI World Cup 2026 — simulador interativo

const FLAG = {
  'Mexico':'mx','South Africa':'za','South Korea':'kr','Czech Republic':'cz',
  'Canada':'ca','Bosnia & Herzegovina':'ba','Qatar':'qa','Switzerland':'ch',
  'Brazil':'br','Morocco':'ma','Haiti':'ht','Scotland':'gb-sct',
  'USA':'us','Paraguay':'py','Australia':'au','Turkey':'tr',
  'Germany':'de','Curaçao':'cw','Ivory Coast':'ci','Ecuador':'ec',
  'Netherlands':'nl','Japan':'jp','Sweden':'se','Tunisia':'tn',
  'Belgium':'be','Egypt':'eg','Iran':'ir','New Zealand':'nz',
  'Spain':'es','Cape Verde':'cv','Saudi Arabia':'sa','Uruguay':'uy',
  'France':'fr','Senegal':'sn','Iraq':'iq','Norway':'no',
  'Argentina':'ar','Algeria':'dz','Austria':'at','Jordan':'jo',
  'Portugal':'pt','DR Congo':'cd','Uzbekistan':'uz','Colombia':'co',
  'England':'gb-eng','Croatia':'hr','Ghana':'gh','Panama':'pa'
};

const PT_NAME = {
  'Mexico':'México','South Africa':'África do Sul','South Korea':'Coreia do Sul','Czech Republic':'Tchéquia',
  'Canada':'Canadá','Bosnia & Herzegovina':'Bósnia e Herzegovina','Qatar':'Catar','Switzerland':'Suíça',
  'Brazil':'Brasil','Morocco':'Marrocos','Haiti':'Haiti','Scotland':'Escócia',
  'USA':'Estados Unidos','Paraguay':'Paraguai','Australia':'Austrália','Turkey':'Turquia',
  'Germany':'Alemanha','Curaçao':'Curaçao','Ivory Coast':'Costa do Marfim','Ecuador':'Equador',
  'Netherlands':'Holanda','Japan':'Japão','Sweden':'Suécia','Tunisia':'Tunísia',
  'Belgium':'Bélgica','Egypt':'Egito','Iran':'Irã','New Zealand':'Nova Zelândia',
  'Spain':'Espanha','Cape Verde':'Cabo Verde','Saudi Arabia':'Arábia Saudita','Uruguay':'Uruguai',
  'France':'França','Senegal':'Senegal','Iraq':'Iraque','Norway':'Noruega',
  'Argentina':'Argentina','Algeria':'Argélia','Austria':'Áustria','Jordan':'Jordânia',
  'Portugal':'Portugal','DR Congo':'RD Congo','Uzbekistan':'Uzbequistão','Colombia':'Colômbia',
  'England':'Inglaterra','Croatia':'Croácia','Ghana':'Gana','Panama':'Panamá',
  // adversários extras (aparecem apenas no tooltip de "últimos jogos")
  'Serbia':'Sérvia','Slovenia':'Eslovênia','Kazakhstan':'Cazaquistão',
  'Italy':'Itália','Hungary':'Hungria','Poland':'Polônia','Denmark':'Dinamarca',
  'Greece':'Grécia','Ireland':'Irlanda','Finland':'Finlândia','Latvia':'Letônia',
  'Albania':'Albânia','Ukraine':'Ucrânia','Israel':'Israel','Wales':'País de Gales',
  'Northern Ireland':'Irlanda do Norte','Luxembourg':'Luxemburgo','Moldova':'Moldávia',
  'Cyprus':'Chipre','Slovakia':'Eslováquia','Azerbaijan':'Azerbaijão','Estonia':'Estônia',
  'Faroe Islands':'Ilhas Faroé','Georgia':'Geórgia','Montenegro':'Montenegro','Iceland':'Islândia',
  'Bolivia':'Bolívia','Venezuela':'Venezuela','Chile':'Chile','Peru':'Peru',
  'China':'China','Indonesia':'Indonésia','Bahrain':'Bahrein','UAE':'Emirados Árabes',
  'North Korea':'Coreia do Norte','Kyrgyzstan':'Quirguistão','Oman':'Omã','Palestine':'Palestina',
  'Kuwait':'Kuwait','Cameroon':'Camarões','Mauritius':'Maurício','Angola':'Angola',
  'Libya':'Líbia','Sudan':'Sudão','Mauritania':'Mauritânia','Togo':'Togo',
  'Burundi':'Burundi','Burkina Faso':'Burkina Faso','Malawi':'Maláui','Niger':'Níger',
  'Mozambique':'Moçambique','Botswana':'Botsuana','Equatorial Guinea':'Guiné Equatorial',
  'Liberia':'Libéria','Sierra Leone':'Serra Leoa','Comoros':'Comores','Madagascar':'Madagascar',
  'Lesotho':'Lesoto','Gabon':'Gabão','Central African Rep.':'Rep. Centro-Africana',
  'Tanzania':'Tanzânia','Kenya':'Quênia','Zambia':'Zâmbia','Benin':'Benim',
  'Uganda':'Uganda','South Sudan':'Sudão do Sul','Zimbabwe':'Zimbábue','Gambia':'Gâmbia',
  'Chad':'Chade','Honduras':'Honduras','Jamaica':'Jamaica','Suriname':'Suriname',
  'Trinidad':'Trinidad e Tobago','El Salvador':'El Salvador','Guatemala':'Guatemala',
  'Costa Rica':'Costa Rica','Cuba':'Cuba','Fiji':'Fiji','Tahiti':'Taiti',
  'Vanuatu':'Vanuatu','Samoa':'Samoa'
};

const ptName = (en) => PT_NAME[en] || en;
const flagUrl = (en) => `https://flagcdn.com/${FLAG[en] || 'un'}.svg`;
const flagHtml = (en) =>
  `<img class="flag-img" src="${flagUrl(en)}" alt="Bandeira ${ptName(en)}" loading="lazy">`;

// ---------- últimos jogos por seleção ----------
// formato: [data, adversário(EN), foiCasa, "placar do time-placar adversário", competição]
// Carregado dinamicamente de assets/data/recent.json
let RECENT_MATCHES = {};
async function loadRecentMatches() {
  try {
    const r = await fetch('assets/data/recent.json', { cache: 'no-cache' });
    if (r.ok) RECENT_MATCHES = await r.json();
  } catch (e) { console.warn('Não foi possível carregar recent.json', e); }
}

function recentMatchesHtml(team) {
  const matches = RECENT_MATCHES[team];
  if (!matches || !matches.length) {
    return `<header class="rm-header">${ptName(team)}</header>
            <p class="rm-empty">Sem jogos registrados.</p>`;
  }
  const rows = matches.map(([d, opp, isHome, score]) => {
    const [gf, ga] = score.split('-').map(n => parseInt(n, 10));
    const res = gf > ga ? 'win' : (gf < ga ? 'loss' : 'draw');
    const [y, mo, da] = d.split('-');
    const dateBr = `${da}/${mo}/${y.slice(2)}`;
    return `<li class="rm-row rm-${res}">
      <span class="rm-date">${dateBr}</span>
      <span class="rm-venue ${isHome ? 'home' : 'away'}" title="${isHome ? 'Em casa' : 'Fora de casa'}">${isHome ? 'C' : 'F'}</span>
      <span class="rm-vs">${ptName(opp)}</span>
      <span class="rm-score">${score}</span>
    </li>`;
  }).join('');
  return `<header class="rm-header">${ptName(team)} · Últimos jogos</header>
          <ul class="rm-list">${rows}</ul>`;
}

// ---------- tooltip global de últimos jogos ----------
let __teamTooltipEl = null;
function ensureTeamTooltip() {
  if (__teamTooltipEl) return __teamTooltipEl;
  const el = document.createElement('div');
  el.id = 'teamTooltip';
  el.className = 'recent-tooltip';
  el.setAttribute('role','tooltip');
  document.body.appendChild(el);
  __teamTooltipEl = el;
  return el;
}
function showTeamTooltip(team, anchor) {
  if (!RECENT_MATCHES[team]) return;
  const tip = ensureTeamTooltip();
  tip.innerHTML = recentMatchesHtml(team);
  tip.classList.add('show');
  const r = anchor.getBoundingClientRect();
  const tipW = tip.offsetWidth, tipH = tip.offsetHeight;
  const pad = 8;
  let left = r.right + pad;
  let top  = r.top + (r.height/2) - (tipH/2);
  // se não couber à direita, mostra à esquerda
  if (left + tipW > window.innerWidth - 4) left = r.left - tipW - pad;
  if (left < 4) left = 4;
  if (top < 4) top = 4;
  if (top + tipH > window.innerHeight - 4) top = window.innerHeight - tipH - 4;
  tip.style.left = (left + window.scrollX) + 'px';
  tip.style.top  = (top  + window.scrollY) + 'px';
}
function hideTeamTooltip() {
  if (__teamTooltipEl) __teamTooltipEl.classList.remove('show');
}
function bindTeamHover() {
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-team-hover]');
    if (!el) return;
    showTeamTooltip(el.dataset.teamHover, el);
  });
  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest('[data-team-hover]');
    if (!el) return;
    if (el.contains(e.relatedTarget)) return;
    hideTeamTooltip();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-team-hover]');
    if (el) showTeamTooltip(el.dataset.teamHover, el);
  });
  document.addEventListener('focusout', (e) => {
    const el = e.target.closest('[data-team-hover]');
    if (el) hideTeamTooltip();
  });
  window.addEventListener('scroll', hideTeamTooltip, { passive: true });
}

// ---------- estado / persistência ----------
const STATE_KEY = 'panini-wc2026-sim-v2';
const SIM = { group: {}, ko: {} };

function loadSim() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) Object.assign(SIM, JSON.parse(raw));
  } catch {}
  if (!SIM.group) SIM.group = {};
  if (!SIM.ko) SIM.ko = {};
}
function saveSim() { localStorage.setItem(STATE_KEY, JSON.stringify(SIM)); }
function resetSim() {
  if (!confirm('Resetar toda a simulação? Todos os placares serão apagados.')) return;
  SIM.group = {}; SIM.ko = {}; saveSim();
  renderAll();
}

// chave estável para um jogo da fase de grupos
const gKey = (m) => `${m.group}|${m.team1}|${m.team2}|${m.date}`;

// ---------- dados ----------
let DATA = null;
let GROUPS = {};        // { 'A': ['Brazil', ...] }
let GROUP_MATCHES = []; // 72 matches
let KO_MATCHES = [];    // 32 matches (R32→Final), com num

async function init() {
  try {
    const res = await fetch('assets/data/worldcup.json');
    DATA = await res.json();
  } catch {
    document.getElementById('groupsContainer').innerHTML =
      '<div class="alert alert-danger">Erro ao carregar dados. Sirva o site via servidor HTTP (não file://).</div>';
    return;
  }
  await loadRecentMatches();
  loadSim();
  GROUP_MATCHES = DATA.matches.filter(m => m.group && m.group.startsWith('Group '));
  KO_MATCHES = DATA.matches.filter(m => !m.group || !m.group.startsWith('Group '))
    .sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time));
  // garante num para 3º lugar e Final
  KO_MATCHES.forEach((m, i) => { if (!m.num) m.num = 73 + i; });

  buildGroupsMap();
  renderGroups();
  populateFilters();
  document.getElementById('btnReset').addEventListener('click', resetSim);
  bindFilters();
  bindTeamHover();
  renderAll();
  refreshScrollSpy();
}

function buildGroupsMap() {
  const m = {};
  for (const match of GROUP_MATCHES) {
    const letter = match.group.replace('Group ','');
    if (!m[letter]) m[letter] = new Set();
    m[letter].add(match.team1);
    m[letter].add(match.team2);
  }
  GROUPS = {};
  Object.keys(m).sort().forEach(k => GROUPS[k] = [...m[k]].sort((a,b)=>ptName(a).localeCompare(ptName(b),'pt')));
}

function renderAll() {
  renderMatches();
  renderStandings();
  renderThirds();
  renderBracket();
}

// ---------- grupos (cards) ----------
function renderGroups() {
  const container = document.getElementById('groupsContainer');
  container.innerHTML = Object.entries(GROUPS).map(([letter, teams]) => `
    <div class="col-md-6 col-lg-4">
      <article class="group-card h-100">
        <header class="group-card-header" data-group="${letter}" role="button" tabindex="0" title="Ver jogos do Grupo ${letter}">
          <h3>Grupo ${letter}</h3>
          <span class="badge-letter">${letter}</span>
        </header>
        <ul>
          ${teams.map(t => `
            <li data-team="${t}" data-team-hover="${t}" class="group-team">
              ${flagHtml(t)}
              <span class="team-name">${ptName(t)}</span>
            </li>`).join('')}
        </ul>
      </article>
    </div>
  `).join('');

  const goToMatches = () => document.getElementById('jogos').scrollIntoView({behavior:'smooth'});

  container.querySelectorAll('li[data-team]').forEach(li => {
    li.addEventListener('click', () => {
      const ft = document.getElementById('filterTeam');
      const fg = document.getElementById('filterGroup');
      ft.value = li.dataset.team; fg.value = '';
      renderMatches();
      goToMatches();
    });
  });

  container.querySelectorAll('[data-group]').forEach(h => {
    const filterByGroup = () => {
      const ft = document.getElementById('filterTeam');
      const fg = document.getElementById('filterGroup');
      fg.value = 'Group ' + h.dataset.group; ft.value = '';
      renderMatches();
      goToMatches();
    };
    h.addEventListener('click', filterByGroup);
    h.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); filterByGroup(); }});
  });
}

// ---------- jogos (com inputs de placar) ----------
function populateFilters() {
  const fg = document.getElementById('filterGroup');
  Object.keys(GROUPS).forEach(l => fg.insertAdjacentHTML('beforeend', `<option value="Group ${l}">Grupo ${l}</option>`));
  const ft = document.getElementById('filterTeam');
  const teams = [...new Set(Object.values(GROUPS).flat())].sort((a,b)=>ptName(a).localeCompare(ptName(b),'pt'));
  teams.forEach(t => ft.insertAdjacentHTML('beforeend', `<option value="${t}">${ptName(t)}</option>`));
}

function bindFilters() {
  const fg = document.getElementById('filterGroup');
  const ft = document.getElementById('filterTeam');
  fg.addEventListener('change', () => { if (fg.value) ft.value = ''; renderMatches(); });
  ft.addEventListener('change', () => { if (ft.value) fg.value = ''; renderMatches(); });
}

function formatDate(iso) {
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function renderMatches() {
  const fg = document.getElementById('filterGroup').value;
  const ft = document.getElementById('filterTeam').value;
  const container = document.getElementById('matchesContainer');

  const list = GROUP_MATCHES
    .filter(m => !fg || m.group === fg)
    .filter(m => !ft || m.team1 === ft || m.team2 === ft)
    .sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time));

  if (list.length === 0) {
    container.innerHTML = '<div class="col-12 text-center text-muted py-5">Nenhum jogo encontrado para os filtros selecionados.</div>';
    return;
  }

  container.innerHTML = list.map(m => {
    const k = gKey(m);
    const s = SIM.group[k] || {};
    return `
    <div class="col-md-6 col-lg-4">
      <article class="match-card h-100" data-key="${k}">
        <div class="match-meta">
          <span class="badge-group">${m.group.replace('Group ','Grupo ')}</span>
          <span><i class="bi bi-calendar3"></i> ${formatDate(m.date)} · ${m.time}</span>
          <span><i class="bi bi-geo-alt"></i> ${m.ground}</span>
        </div>
        <div class="match-team home" data-team-hover="${m.team1}" tabindex="0">
          ${flagHtml(m.team1)}
          <span class="team-label">${ptName(m.team1)}</span>
        </div>
        <div class="score-box">
          <input type="number" min="0" max="20" class="score-input" data-side="h" value="${s.h ?? ''}" aria-label="Gols ${ptName(m.team1)}">
          <span class="match-vs">×</span>
          <input type="number" min="0" max="20" class="score-input" data-side="a" value="${s.a ?? ''}" aria-label="Gols ${ptName(m.team2)}">
        </div>
        <div class="match-team away" data-team-hover="${m.team2}" tabindex="0">
          <span class="team-label">${ptName(m.team2)}</span>
          ${flagHtml(m.team2)}
        </div>
      </article>
    </div>`;
  }).join('');

  container.querySelectorAll('.match-card').forEach(card => {
    const key = card.dataset.key;
    card.querySelectorAll('.score-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const h = card.querySelector('[data-side="h"]').value;
        const a = card.querySelector('[data-side="a"]').value;
        SIM.group[key] = {
          h: h === '' ? null : Math.max(0, parseInt(h,10) || 0),
          a: a === '' ? null : Math.max(0, parseInt(a,10) || 0),
        };
        saveSim();
        renderStandings(); renderThirds(); renderBracket();
      });
    });
  });
}

// ---------- classificação ----------
function computeStandings(letter) {
  const teams = GROUPS[letter];
  const stats = Object.fromEntries(teams.map(t => [t, {
    team: t, P:0, J:0, V:0, E:0, D:0, GP:0, GC:0, SG:0, Pts:0
  }]));
  GROUP_MATCHES
    .filter(m => m.group === 'Group ' + letter)
    .forEach(m => {
      const s = SIM.group[gKey(m)];
      if (!s || s.h == null || s.a == null) return;
      const h = stats[m.team1], a = stats[m.team2];
      h.J++; a.J++;
      h.GP += s.h; h.GC += s.a;
      a.GP += s.a; a.GC += s.h;
      if (s.h > s.a) { h.V++; a.D++; h.Pts += 3; }
      else if (s.h < s.a) { a.V++; h.D++; a.Pts += 3; }
      else { h.E++; a.E++; h.Pts++; a.Pts++; }
    });
  Object.values(stats).forEach(s => { s.SG = s.GP - s.GC; });
  const sorted = Object.values(stats).sort((a,b) =>
    b.Pts - a.Pts || b.SG - a.SG || b.GP - a.GP || ptName(a.team).localeCompare(ptName(b.team),'pt')
  );
  sorted.forEach((s,i) => s.P = i+1);
  return sorted;
}

function renderStandings() {
  const container = document.getElementById('standingsContainer');
  container.innerHTML = Object.keys(GROUPS).map(letter => {
    const rows = computeStandings(letter);
    return `
    <div class="col-md-6 col-lg-4">
      <div class="standings-card">
        <h3>Grupo ${letter}</h3>
        <table class="standings-table">
          <thead>
            <tr><th>P</th><th>Seleção</th><th>J</th><th>V</th><th>E</th><th>D</th><th>SG</th><th>Pts</th></tr>
          </thead>
          <tbody>
            ${rows.map((s,i) => `
              <tr class="${i===0?'pos-1':i===1?'pos-2':i===2?'pos-3':'pos-4'}">
                <td>${s.P}</td>
                <td><div class="d-flex align-items-center gap-2" data-team-hover="${s.team}" tabindex="0">${flagHtml(s.team)}<span>${ptName(s.team)}</span></div></td>
                <td>${s.J}</td><td>${s.V}</td><td>${s.E}</td><td>${s.D}</td>
                <td>${s.SG>0?'+'+s.SG:s.SG}</td>
                <td class="pts">${s.Pts}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

// ---------- ranking dos terceiros ----------
function getThirds() {
  // retorna lista de 12 objetos {letter, ...stats} ordenada do melhor para o pior 3º
  const list = Object.keys(GROUPS).map(letter => {
    const s = computeStandings(letter)[2];
    return { letter, ...s };
  });
  list.sort((a,b) =>
    b.Pts - a.Pts || b.SG - a.SG || b.GP - a.GP || ptName(a.team).localeCompare(ptName(b.team),'pt')
  );
  return list;
}

function renderThirds() {
  const list = getThirds();
  const container = document.getElementById('thirdsContainer');
  container.innerHTML = `
    <div class="standings-card mx-auto" style="max-width:780px">
      <h3>Melhores 3º colocados</h3>
      <table class="standings-table">
        <thead>
          <tr><th>#</th><th>Grupo</th><th>Seleção</th><th>J</th><th>SG</th><th>Pts</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${list.map((s,i) => `
            <tr class="${i<8 ? 'pos-1' : 'pos-out'}">
              <td>${i+1}</td>
              <td><strong>${s.letter}</strong></td>
              <td><div class="d-flex align-items-center gap-2" data-team-hover="${s.team}" tabindex="0">${flagHtml(s.team)}<span>${ptName(s.team)}</span></div></td>
              <td>${s.J}</td>
              <td>${s.SG>0?'+'+s.SG:s.SG}</td>
              <td class="pts">${s.Pts}</td>
              <td>${i<8 ? '<span class="badge bg-success">Avança</span>' : '<span class="badge bg-secondary">Eliminado</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ---------- resolução de slots do bracket ----------
// Identifica o time real para um slot tipo "1A", "2B", "3A/B/C/D/F", "W74", "L101"
function resolveSlot(slot, ctx) {
  if (!slot) return null;
  // posicional simples: 1X, 2X
  let mm = slot.match(/^([12])([A-L])$/);
  if (mm) {
    const rows = computeStandings(mm[2]);
    const pos = parseInt(mm[1],10);
    const row = rows[pos-1];
    return row && row.J > 0 ? row.team : null;
  }
  // 3X — terceiro específico (raro; o JSON usa "3A/B/C/D/F")
  mm = slot.match(/^3([A-L])$/);
  if (mm) {
    const rows = computeStandings(mm[1]);
    return rows[2] && rows[2].J > 0 ? rows[2].team : null;
  }
  // 3 eligível de um conjunto
  mm = slot.match(/^3([A-L/]+)$/);
  if (mm) {
    return ctx.thirdsAssign[slot] || null;
  }
  // W## ou L##
  mm = slot.match(/^([WL])(\d+)$/);
  if (mm) {
    const result = ctx.koResults[mm[2]];
    if (!result) return null;
    return mm[1] === 'W' ? result.winner : result.loser;
  }
  return null;
}

// Atribui os 8 melhores terceiros (que classificaram) aos 8 slots "3X/Y/..." dos R32
function assignThirds() {
  const thirds = getThirds().filter(t => t.J > 0);     // só terceiros com jogos preenchidos
  const top8 = thirds.slice(0, 8);

  // slots na ordem dos R32 (a partir do JSON)
  const r32 = KO_MATCHES.filter(m => m.round === 'Round of 32');
  const slots = [];
  r32.forEach(m => {
    [m.team1, m.team2].forEach(t => {
      if (/^3[A-L/]+$/.test(t) && t.includes('/')) slots.push(t);
    });
  });

  const assign = {};
  const available = [...top8];
  slots.forEach(slot => {
    const eligibleLetters = slot.replace('3','').split('/');
    const pick = available.find(t => eligibleLetters.includes(t.letter))
              || available[0]; // fallback
    if (pick) {
      assign[slot] = pick.team;
      available.splice(available.indexOf(pick), 1);
    }
  });
  return assign;
}

// Resolve um jogo do KO a partir do estado: retorna { winner, loser } ou null
function resolveKoMatch(num, ctx) {
  const score = SIM.ko[num];
  if (!score || score.h == null || score.a == null) return null;
  const m = KO_MATCHES.find(x => x.num === num);
  if (!m) return null;
  const home = resolveSlot(m.team1, ctx);
  const away = resolveSlot(m.team2, ctx);
  if (!home || !away) return null;
  if (score.h > score.a) return { winner: home, loser: away };
  if (score.h < score.a) return { winner: away, loser: home };
  // empate → pênaltis
  if (score.ph != null && score.pa != null && score.ph !== score.pa) {
    return score.ph > score.pa
      ? { winner: home, loser: away }
      : { winner: away, loser: home };
  }
  return null;
}

function computeKoContext() {
  const ctx = { thirdsAssign: assignThirds(), koResults: {} };
  // resolve em ordem crescente de num — cada round depende do anterior
  [...KO_MATCHES].sort((a,b) => a.num - b.num).forEach(m => {
    const r = resolveKoMatch(m.num, ctx);
    if (r) ctx.koResults[m.num] = r;
  });
  return ctx;
}

// ---------- bracket ----------
const ROUND_PT = {
  'Round of 32': '32 avos',
  'Round of 16': 'Oitavas',
  'Quarter-final': 'Quartas',
  'Semi-final': 'Semis',
  'Match for third place': '3º Lugar',
  'Final': 'Final',
};

function renderBracket() {
  const ctx = computeKoContext();
  const container = document.getElementById('bracketContainer');

  const rounds = ['Round of 32','Round of 16','Quarter-final','Semi-final','Match for third place','Final'];
  container.innerHTML = rounds.map(rname => {
    const games = KO_MATCHES.filter(m => m.round === rname).sort((a,b)=>a.num-b.num);
    return `
      <div class="bracket-round">
        <h4>${ROUND_PT[rname]}</h4>
        ${games.map(m => renderKoMatch(m, ctx)).join('')}
      </div>`;
  }).join('');

  container.querySelectorAll('.ko-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const card = inp.closest('.bracket-match');
      const num = parseInt(card.dataset.num, 10);
      const get = (sel) => {
        const v = card.querySelector(sel).value;
        return v === '' ? null : Math.max(0, parseInt(v,10)||0);
      };
      SIM.ko[num] = {
        h:  get('[data-k="h"]'),
        a:  get('[data-k="a"]'),
        ph: get('[data-k="ph"]'),
        pa: get('[data-k="pa"]'),
      };
      saveSim();
      renderBracket();
    });
  });
}

function teamCell(slot, resolved) {
  if (resolved) {
    return `<div class="ko-team" data-team-hover="${resolved}" tabindex="0">${flagHtml(resolved)}<span>${ptName(resolved)}</span></div>`;
  }
  return `<div class="ko-team ko-team-tbd"><span class="ko-slot">${slot}</span></div>`;
}

function renderKoMatch(m, ctx) {
  const home = resolveSlot(m.team1, ctx);
  const away = resolveSlot(m.team2, ctx);
  const s = SIM.ko[m.num] || {};
  const tied = s.h != null && s.a != null && s.h === s.a;
  const ready = home && away;

  return `
    <div class="bracket-match" data-num="${m.num}">
      <div class="bm-label">${ROUND_PT[m.round]} · Jogo ${m.num}</div>
      <div class="ko-row">
        ${teamCell(m.team1, home)}
        <input type="number" min="0" max="20" class="ko-input ko-score" data-k="h" value="${s.h ?? ''}" ${ready?'':'disabled'} aria-label="Gols mandante">
      </div>
      <div class="ko-row">
        ${teamCell(m.team2, away)}
        <input type="number" min="0" max="20" class="ko-input ko-score" data-k="a" value="${s.a ?? ''}" ${ready?'':'disabled'} aria-label="Gols visitante">
      </div>
      ${tied ? `
        <div class="ko-pen">
          <span class="ko-pen-label">Pênaltis</span>
          <input type="number" min="0" max="20" class="ko-input ko-pen-input" data-k="ph" value="${s.ph ?? ''}" aria-label="Pênaltis mandante">
          <span>×</span>
          <input type="number" min="0" max="20" class="ko-input ko-pen-input" data-k="pa" value="${s.pa ?? ''}" aria-label="Pênaltis visitante">
        </div>` : ''}
      <div class="bm-meta">${formatDate(m.date)} · ${m.time}<br>${m.ground}</div>
    </div>`;
}

function refreshScrollSpy() {
  const spy = bootstrap.ScrollSpy.getInstance(document.body);
  if (spy) spy.refresh();
}

document.addEventListener('DOMContentLoaded', init);

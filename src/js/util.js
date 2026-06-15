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
  Türkiye: 'tr', Turkey: 'tr',  // alias antigo, mantém pra retrocompat
  Uruguay: 'uy', USA: 'us', Uzbekistan: 'uz',
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
  // Demais seleções das eliminatórias (fora da Copa, mas aparecem nas tabelas)
  Andorra: 'ad', Benin: 'bj', Burundi: 'bi', 'Central African Republic': 'cf',
  Chad: 'td', Congo: 'cg', Djibouti: 'dj', Eritrea: 'er', Ethiopia: 'et',
  'FYR Macedonia': 'mk', Fiji: 'fj', Guinea: 'gn', 'Guinea-Bissau': 'gw',
  Indonesia: 'id', Israel: 'il', Kenya: 'ke', Kuwait: 'kw', Kyrgyzstan: 'kg',
  Lesotho: 'ls', Liberia: 'lr', Libya: 'ly', Madagascar: 'mg', Malawi: 'mw',
  Mauritius: 'mu', Moldova: 'md', Mozambique: 'mz', Namibia: 'na',
  'New Caledonia': 'nc', Niger: 'ne', 'North Korea': 'kp', Oman: 'om',
  'Rep. Of Ireland': 'ie', Rwanda: 'rw', 'Sao Tome and Principe': 'st',
  Seychelles: 'sc', 'Sierra Leone': 'sl', Somalia: 'so', 'South Sudan': 'ss',
  Suriname: 'sr', Tahiti: 'pf', Togo: 'tg', 'Trinidad and Tobago': 'tt',
  Uganda: 'ug',
  // Alias para nomes alternativos
  'United States': 'us',
};

/**
 * Retorna HTML de bandeira usando flag-icons.
 * @param {string} team - Nome do país
 * @returns {string} HTML span com classe flag-icons
 */
// Nome-base de um time reserva: "Ghana B" → "Ghana". Seleções B (squads
// reservas em amistosos/FIFA Series) usam a bandeira e o nome do país.
function baseTeam(name) {
  return String(name ?? '').replace(/\s+B$/, '');
}

export function flag(team) {
  const decoded = decodeHtmlEntities(team);
  const code = FLAGS[decoded] || FLAGS[baseTeam(decoded)];
  if (!code) return '<span class="fi fi-xx"></span>'; // fallback
  return `<span class="fi fi-${code}"></span>`;
}

/**
 * Retorna emoji unicode da bandeira — pra usar em <option> onde HTML não renderiza.
 * Pares de regional indicators (A-Z → U+1F1E6 - U+1F1FF). Códigos compostos (gb-wls)
 * fallback pra 🏴.
 */
export function flagEmoji(team) {
  const code = FLAGS[decodeHtmlEntities(team)];
  if (!code || code.length !== 2) return '🏴';
  const A = 0x1F1E6;
  return String.fromCodePoint(A + code.charCodeAt(0) - 97, A + code.charCodeAt(1) - 97);
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
  Türkiye: 'Turquia', Turkey: 'Turquia',  // alias antigo
  Uruguay: 'Uruguai', USA: 'Estados Unidos', 'United States': 'Estados Unidos',
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
  // Demais seleções das eliminatórias (fora da Copa)
  Andorra: 'Andorra', Benin: 'Benin', Burundi: 'Burundi',
  'Central African Republic': 'Rep. Centro-Africana', Chad: 'Chade', Congo: 'Congo',
  Djibouti: 'Djibuti', Eritrea: 'Eritreia', Ethiopia: 'Etiópia',
  'FYR Macedonia': 'Macedônia do Norte', Fiji: 'Fiji', Guinea: 'Guiné',
  'Guinea-Bissau': 'Guiné-Bissau', Indonesia: 'Indonésia', Israel: 'Israel',
  Kenya: 'Quênia', Kuwait: 'Kuwait', Kyrgyzstan: 'Quirguistão', Lesotho: 'Lesoto',
  Liberia: 'Libéria', Libya: 'Líbia', Madagascar: 'Madagascar', Malawi: 'Malaui',
  Mauritius: 'Maurício', Moldova: 'Moldávia', Mozambique: 'Moçambique',
  Namibia: 'Namíbia', 'New Caledonia': 'Nova Caledônia', Niger: 'Níger',
  'North Korea': 'Coreia do Norte', Oman: 'Omã', 'Rep. Of Ireland': 'Irlanda',
  Rwanda: 'Ruanda', 'Sao Tome and Principe': 'São Tomé e Príncipe',
  Seychelles: 'Seicheles', 'Sierra Leone': 'Serra Leoa', Somalia: 'Somália',
  'South Sudan': 'Sudão do Sul', Suriname: 'Suriname', Tahiti: 'Taiti',
  Togo: 'Togo', 'Trinidad and Tobago': 'Trinidad e Tobago', Uganda: 'Uganda',
};

/**
 * Traduz nome do time para PT-BR. Se não encontrar, retorna o original.
 */
export function teamPt(name) {
  if (!name) return name;
  const decoded = decodeHtmlEntities(name);
  if (TEAM_PT[decoded]) return TEAM_PT[decoded];
  // time reserva "X B": traduz o país e mantém o " B" (ex.: "Ghana B" → "Gana B")
  const base = baseTeam(decoded);
  if (base !== decoded && TEAM_PT[base]) return `${TEAM_PT[base]} B`;
  return decoded;
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
  if (!name) return '';
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
// Estreia: 11/jun 13h00 no México (16h00 BRT).
const KICKOFF_2026 = new Date('2026-06-11T13:00:00-06:00');

export function daysToKickoffLabel(now = new Date()) {
  // Dias CIVIS no calendário de Brasília — a véspera é sempre "amanhã",
  // independente da hora. (Math.ceil sobre horas corridas até o kickoff dava
  // "Faltam 2 dias" na manhã da véspera: 30h ≠ 2 dias de calendário.)
  const days = brDaysUntil(KICKOFF_2026, now);
  if (days <= 0) return 'Copa do Mundo 2026';
  if (days === 1) return 'A Copa começa amanhã!';
  return `Faltam ${days} dias`;
}

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// Fuso oficial de EXIBIÇÃO do bolão: tudo (hora e dia do jogo) é mostrado no
// relógio de Brasília, INDEPENDENTE do fuso do dispositivo do usuário — um
// brasileiro viajando vê o mesmo horário de quem está no Brasil. NÃO confiar no
// fuso do navegador (getHours/getDate/toLocale* sem timeZone): foi o bug em que
// usuário fora do BRT via data/hora deslocada (DB certo, frontend errado).
// predictionDeadline já era TZ-independente (offset fixo); as funções abaixo
// agora também. Coberto por tests/unit/date-tz-invariance.test.js (fuzzer).
const BR_TZ = 'America/Sao_Paulo';
const _brFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: BR_TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/**
 * Campos civis (ano/mês/dia/hora/min/dia-da-semana) de um instante, no fuso de
 * Brasília. PRIMITIVA ÚNICA de fuso para exibição — qualquer página que precise
 * montar um rótulo de data/hora deve usar isto (e NUNCA new Date(...).getDate()
 * etc., que devolve o fuso do navegador). Mês é 1-indexed; dow é 0=domingo.
 */
export function brParts(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const p = {};
  for (const { type, value } of _brFmt.formatToParts(d)) p[type] = value;
  const year = +p.year, month = +p.month, day = +p.day;
  let hour = +p.hour; if (hour === 24) hour = 0;  // alguns ICUs emitem '24' à meia-noite
  const minute = +p.minute;
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();  // dia da semana civil, TZ-indep
  return { year, month, day, hour, minute, dow };
}

/**
 * Dias civis (calendário de Brasília) de `now` até `target`: 0 = mesmo dia,
 * 1 = amanhã, negativo = passado. Independe da hora e do fuso do dispositivo.
 */
export function brDaysUntil(target, now = new Date()) {
  const a = brParts(now), b = brParts(target);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000
  );
}

/**
 * Janela [início, fim] do dia civil de BRASÍLIA que contém `now`, como
 * instantes UTC em ISO — p/ queries "jogos de hoje". BRT é UTC-3 fixo (sem
 * horário de verão desde 2019), mesmo offset de predictionDeadline.
 */
export function brDayWindowUtc(now = new Date()) {
  const { year, month, day } = brParts(now);
  const startMs = Date.UTC(year, month - 1, day) + BRT_OFFSET_MS; // 00:00 BRT
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(startMs + 86400000 - 1).toISOString(),       // 23:59:59.999 BRT
  };
}

const _pad2 = (n) => String(n).padStart(2, '0');

export function formatBrDate(dateLike) {
  const { dow, day, month } = brParts(dateLike);
  return `${DIAS[dow]} · ${day}/${MESES[month - 1]}`;
}

export function formatBrShort(dateLike) {
  const { day, month } = brParts(dateLike);
  return `${day}/${MESES[month - 1]}`;
}

export function formatTime(iso) {
  const { hour, minute } = brParts(iso);
  return `${_pad2(hour)}:${_pad2(minute)}`;
}

// ===== Match helpers =====
export function stageLabel(s) {
  return {
    group: 'Grupos', r32: '32-avos', r16: 'Oitavas', qf: 'Quartas',
    sf: 'Semis', third: '3º Lugar', final: 'Final',
  }[s] || s;
}

// ===== Calendário "Por data" =====
const MESES_LONG = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
const DOW_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Estados de palpite por dia (cor + rótulo da legenda, na ordem de exibição).
const CAL_STATUSES = [
  { id: 'done',    label: 'Palpitado' },
  { id: 'urgent',  label: 'Bloqueia em <48h' },
  { id: 'soon',    label: 'Bloqueia em <1 semana' },
  { id: 'pending', label: 'Pendente' },
  { id: 'locked',  label: 'Não palpitado' },
  { id: 'past',    label: 'Encerrado' },
];

function calDateKey(y, mo, d) {
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Chave de data (yyyy-mm-dd) no fuso de BRASÍLIA — consistente com formatTime,
 * que exibe o horário de Brasília. Usar isto para agrupar jogos por dia.
 *
 * ⚠️ NÃO usar `new Date(iso).toISOString().slice(0,10)` (devolve UTC) NEM
 * getFullYear/getMonth/getDate (devolve o fuso do navegador): jogos noturnos
 * caíam no dia errado para quem não estava no BRT. Ver date-tz-invariance.test.js.
 */
export function localDateKey(dateLike) {
  const { year, month, day } = brParts(dateLike);
  return calDateKey(year, month - 1, day);  // calDateKey espera mês 0-indexed
}

/** Chave do dia de hoje (yyyy-mm-dd) no fuso do navegador. */
export function todayKey() {
  return localDateKey(new Date());
}

/**
 * Estado de palpite de um dia, para a cor do calendário:
 *  'past'    = dia já encerrado/jogado (histórico) — neutro, não fica verde
 *  'done'    = todos os jogos do dia já palpitados (e ainda por jogar)
 *  'urgent'  = pendente e o bloqueio é em <48h (muito perto)
 *  'soon'    = pendente e o bloqueio é em <1 semana (perto)
 *  'pending' = pendente, bloqueio ainda distante
 *  'locked'  = prazo passou sem palpitar tudo (perdeu a janela)
 * @param done      jogos palpitados no dia
 * @param total     jogos do dia
 * @param deadline  instante de bloqueio do dia (Date|ms) — opcional
 * @param played    true se os jogos do dia já foram disputados (encerrados)
 */
export function dayPredictionStatus(done, total, deadline, played = false) {
  const ms = deadline == null ? null : (deadline instanceof Date ? deadline.getTime() : +deadline);
  const passed = played || (ms != null && ms - Date.now() <= 0);
  // Dia que já passou/jogou: histórico. Verde só pra dias FUTUROS já palpitados.
  if (passed) return (total && done >= total) ? 'past' : 'locked';
  if (!total || done >= total) return 'done';
  if (ms == null) return 'pending';
  const hours = (ms - Date.now()) / 3600000;
  if (hours <= 48) return 'urgent';
  if (hours <= 168) return 'soon';
  return 'pending';
}

/**
 * Calendário de seleção de datas (substitui a fileira de chips no modo "Por data").
 * Mostra os meses do torneio em grade semanal e colore cada dia pelo estado dos
 * palpites (palpitado, pendente, alerta de bloqueio perto/muito perto, bloqueado),
 * com uma informação curta do dia (grupos que jogam ou nome da fase) + contador.
 *
 * @param dates       array de yyyy-mm-dd selecionáveis (dias com jogo na aba atual)
 * @param meta        { [yyyy-mm-dd]: { info, title, done, total, deadline } }
 * @param activeDate  yyyy-mm-dd atualmente selecionado
 */
export function renderDateCalendar({ dates, meta = {}, activeDate } = {}) {
  if (!dates || !dates.length) return '';
  const set = new Set(dates);
  const sorted = [...dates].sort();
  const first = new Date(sorted[0] + 'T12:00:00');
  const last = new Date(sorted[sorted.length - 1] + 'T12:00:00');
  const todayKeyStr = todayKey();

  // Status do dia: usa override explícito (meta[k].status) quando fornecido —
  // o Histórico passa 'soon' para o dia em andamento; as telas de palpite não
  // passam nada e caem no cálculo por prazo (retrocompatível).
  const statusOf = (m) => m.status || dayPredictionStatus(m.done ?? 0, m.total ?? 0, m.deadline, m.played);

  // Quais estados aparecem de fato (para a legenda enxugar o que não há).
  const present = new Set(dates.map(k => statusOf(meta[k] || {})));

  const months = [];
  let cur = new Date(first.getFullYear(), first.getMonth(), 1);
  const end = new Date(last.getFullYear(), last.getMonth(), 1);
  while (cur <= end) { months.push(new Date(cur)); cur.setMonth(cur.getMonth() + 1); }

  const monthsHtml = months.map(mDate => {
    const y = mDate.getFullYear();
    const mo = mDate.getMonth();
    const daysInMonth = new Date(y, mo + 1, 0).getDate();
    const startDow = new Date(y, mo, 1).getDay();

    // Cada célula: { match, html }. Marcamos quais são dias com jogo para depois
    // descartar as semanas inteiras sem jogo (enxuga a altura do calendário).
    const cells = [];
    for (let i = 0; i < startDow; i++) cells.push({ match: false, html: '<div class="cal-cell cal-pad"></div>' });

    for (let d = 1; d <= daysInMonth; d++) {
      const key = calDateKey(y, mo, d);
      if (!set.has(key)) {
        cells.push({ match: false, html: `<div class="cal-cell cal-off"><span class="cal-dnum">${d}</span></div>` });
        continue;
      }
      const m = meta[key] || {};
      const total = m.total ?? 0;
      const done = m.done ?? 0;
      const status = statusOf(m);
      const cls = ['cal-cell', 'cal-day', `st-${status}`];
      if (key === activeDate) cls.push('active');
      if (key === todayKeyStr) cls.push('today');
      cells.push({ match: true, html: `
        <button class="${cls.join(' ')}" data-date="${key}"${m.title ? ` title="${escapeHtml(m.title)}"` : ''}>
          <span class="cal-dnum">${d}</span>
          ${m.info ? `<span class="cal-info">${escapeHtml(m.info)}</span>` : ''}
          <span class="cal-ct">${done}/${total}</span>
        </button>` });
    }

    while (cells.length % 7) cells.push({ match: false, html: '<div class="cal-cell cal-pad"></div>' });

    // Mantém só as semanas (linhas de 7) que têm ao menos um jogo.
    let grid = '';
    for (let i = 0; i < cells.length; i += 7) {
      const week = cells.slice(i, i + 7);
      if (week.some(c => c.match)) grid += week.map(c => c.html).join('');
    }

    return `
      <div class="cal-month">
        <div class="cal-mhead">${MESES_LONG[mo]} ${y}</div>
        <div class="cal-grid">
          ${DOW_SHORT.map(d => `<div class="cal-dow"><span class="dow-3">${d}</span><span class="dow-1">${d[0]}</span></div>`).join('')}
          ${grid}
        </div>
      </div>`;
  }).join('');

  const legend = CAL_STATUSES.filter(s => present.has(s.id)).map(s =>
    `<span class="cal-leg st-${s.id}"><i></i>${s.label}</span>`
  ).join('');

  return `
    <div class="cal" id="cal">
      <div class="cal-months">${monthsHtml}</div>
      <div class="cal-legend">${legend}</div>
    </div>`;
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

// Horário de Brasília (UTC-3, sem horário de verão desde 2019).
const BRT_OFFSET_MS = 3 * 3600000;

/**
 * Prazo do palpite: 23h59 (horário de Brasília) da VÉSPERA do jogo.
 * Ex.: jogo 15/jun 16h → fecha 14/jun 23h59. KEEP IN SYNC com
 * public.prediction_deadline() (migration 023).
 * @param {string|Date} matchDate
 * @returns {Date} instante em que o palpite trava
 */
export function predictionDeadline(matchDate) {
  // Desloca para o relógio de Brasília lendo os campos UTC.
  const brt = new Date(new Date(matchDate).getTime() - BRT_OFFSET_MS);
  // 23h59 do dia anterior, no relógio de Brasília...
  const wallMs = Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate() - 1, 23, 59, 0);
  // ...convertido de volta para o instante UTC real.
  return new Date(wallMs + BRT_OFFSET_MS);
}

/**
 * Match travado para palpites: passou das 23h59 (Brasília) da véspera do jogo.
 */
export function isLocked(m) {
  return new Date() >= predictionDeadline(m.match_date);
}

/**
 * Rótulo de contagem regressiva até o BLOQUEIO do palpite (não até o jogo).
 * Bloqueio = 23h59 (Brasília) da véspera. Ex.: "Bloqueia em 9 dias",
 * "Bloqueia em 5h", "Bloqueado". Use onde aparece um palpite de partida.
 * @param {string|Date} matchDate
 * @returns {string}
 */
export function lockCountdownLabel(matchDate) {
  const diff = predictionDeadline(matchDate) - new Date();
  if (diff <= 0) return 'Bloqueado';
  const days = Math.floor(diff / 86400000);
  if (days >= 1) return `Bloqueia em ${days} dia${days > 1 ? 's' : ''}`;
  const hours = Math.floor(diff / 3600000);
  if (hours >= 1) return `Bloqueia em ${hours}h`;
  return 'Bloqueia em breve';
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
    // 'no-cache' = ainda usa o cache do navegador, mas SEMPRE revalida via etag
    // (304 barato se nada mudou). Garante que, após a action atualizar o
    // recent.json, o usuário pega o dado novo no próximo load — sem hard-refresh.
    const res = await fetch('assets/data/recent.json', { cache: 'no-cache' });
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
// Qualifiers loader (campanha classificatória — Eliminatórias)
// ============================================================
// Carrega assets/data/qualifiers.json (gerado por scripts/fetch-qualifiers.js)
// e devolve a estrutura { confederations, brackets, teams } usada pela seção
// "Eliminatórias" do Raio-X (ver js/raiox.js). Cacheado em memória.

let _qualifiersCache = null;
export async function loadQualifiers() {
  if (_qualifiersCache) return _qualifiersCache;
  try {
    const res = await fetch('assets/data/qualifiers.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _qualifiersCache = await res.json();
    return _qualifiersCache;
  } catch (err) {
    console.warn('[loadQualifiers] failed:', err);
    return null;
  }
}

// ============================================================
// Top scorers loader (artilharia — "Corrida da Chuteira de Ouro")
// ============================================================
// Carrega assets/data/topscorers.json (gerado por scripts/data/fetch-topscorers.js,
// atualizado pela action Refresh Top Scorers) e devolve { updated_at, season,
// scorers:[{ api_id, name, team, goals, assists, minutes }] }. `api_id` casa com
// players.api_player_id (linkagem do palpite de artilheiro). Cacheado em memória.
let _topScorersCache = null;
export async function loadTopScorers() {
  if (_topScorersCache) return _topScorersCache;
  try {
    const res = await fetch('assets/data/topscorers.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _topScorersCache = { updated_at: data.updated_at ?? null, scorers: data.scorers ?? [] };
    return _topScorersCache;
  } catch (err) {
    console.warn('[loadTopScorers] failed:', err);
    return { updated_at: null, scorers: [] };
  }
}

// ============================================================
// Odds → probabilidade implícita (alimenta a barra 1X2 do Raio-X)
// ============================================================
// Converte odds decimais (casa/empate/fora) em probabilidades que somam 100%.
// A chance bruta de cada resultado é 1/odd; a soma das três passa de 100% pela
// margem da casa (overround/"vig"). Normaliza dividindo pela soma pra remover a
// margem. Retorna { pHome, pDraw, pAway } em % + o favorito, ou null se as odds
// não forem válidas (precisam ser > 1).
export function oddsToProbs(o) {
  const oh = Number(o?.odd_home), od = Number(o?.odd_draw), oa = Number(o?.odd_away);
  if (!(oh > 1) || !(od > 1) || !(oa > 1)) return null;
  const ih = 1 / oh, id = 1 / od, ia = 1 / oa;
  const sum = ih + id + ia;
  const pHome = (ih / sum) * 100, pDraw = (id / sum) * 100, pAway = (ia / sum) * 100;
  const favored = (pHome >= pDraw && pHome >= pAway) ? 'home'
                : (pAway >= pDraw && pAway >= pHome) ? 'away' : 'draw';
  return { pHome, pDraw, pAway, favored };
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
  // Marca o body: a afordância visual (cursor help + sublinhado pontilhado)
  // dos .team-name só aparece quando o tooltip está realmente ativo na página.
  // Páginas que não chamam esta função não exibem o "?" órfão.
  document.body.classList.add('has-team-tooltips');

  // Singleton tooltip element
  let tooltip = document.getElementById('teamTooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'teamTooltip';
    tooltip.className = 'team-tooltip';
    document.body.appendChild(tooltip);
  }

  // Em telas sem mouse (celular/tablet) usamos toque; com mouse, hover.
  const canHover = window.matchMedia('(hover: hover)').matches;

  // Dica visível pro usuário descobrir o tooltip
  if (!document.getElementById('teamTooltipHint')) {
    const firstTeam = document.querySelector('.team-name[data-team]');
    if (firstTeam) {
      const hint = document.createElement('div');
      hint.id = 'teamTooltipHint';
      hint.className = 'tooltip-hint';
      hint.innerHTML = canHover
        ? '💡 Passe o mouse sobre o nome de uma seleção para ver as <b>últimas partidas</b>.'
        : '💡 Toque no nome de uma seleção para ver as <b>últimas partidas</b>.';
      const main = document.querySelector('main') || document.body;
      const hero = main.querySelector('.hero');
      if (hero && hero.parentNode) hero.parentNode.insertBefore(hint, hero.nextSibling);
      else main.insertBefore(hint, main.firstChild);
    }
  }

  // Remove handlers de invocação anterior
  if (tooltipState) {
    document.removeEventListener('mouseover', tooltipState.onMouseOver);
    document.removeEventListener('mouseout', tooltipState.onMouseOut);
    document.removeEventListener('click', tooltipState.onClick);
    window.removeEventListener('scroll', tooltipState.onScroll, true);
  }

  const onScroll = () => hideTooltip();
  tooltipState = { onScroll, activeTrigger: null };

  if (canHover) {
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
    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', onMouseOut);
    tooltipState.onMouseOver = onMouseOver;
    tooltipState.onMouseOut = onMouseOut;
  } else {
    // Toque: tap no nome abre/fecha; tap fora fecha.
    const onClick = (e) => {
      const trigger = e.target.closest('.team-name[data-team]');
      const tt = document.getElementById('teamTooltip');
      if (trigger) {
        e.preventDefault();
        const isOpen = tt?.classList.contains('show') && tooltipState.activeTrigger === trigger;
        if (isOpen) {
          hideTooltip();
          tooltipState.activeTrigger = null;
        } else {
          showTooltip(trigger, recentByTeam);
          tooltipState.activeTrigger = trigger;
        }
        return;
      }
      if (!e.target.closest('#teamTooltip')) {
        hideTooltip();
        tooltipState.activeTrigger = null;
      }
    };
    document.addEventListener('click', onClick);
    tooltipState.onClick = onClick;
  }

  window.addEventListener('scroll', onScroll, true);
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
          <span style="color:var(--positive)">${wins}V</span>
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

// ===== Linha de meta do hero =====
// .hero-meta é flex: <b>/texto soltos viram flex items independentes e quebram
// separados ("62" numa linha, "jogadores no bolão" na outra) com "·" órfão.
// Cada parte vira UM token nowrap com o separador colado no fim (nunca abre linha).
// Partes longas (frases) passam { html, flow: true } para poderem quebrar por dentro.
export function heroMeta(parts) {
  const t = parts.filter(Boolean).map(p => (typeof p === 'string' ? { html: p } : p));
  return t.map((p, i) =>
    `<span class="seg${p.flow ? ' seg-flow' : ''}">${p.html}${i < t.length - 1 ? '<span class="sep"></span>' : ''}</span>`
  ).join('');
}

// ===== Scroll horizontal com affordance =====
// Tabelas largas no mobile: marca .can-left/.can-right no wrapper .hscroll
// para o CSS desenhar o fade de "tem mais conteúdo" só quando dá pra rolar.
export function wireHScroll(root = document) {
  root.querySelectorAll('.hscroll').forEach((box) => {
    const inner = box.querySelector('.hscroll-in');
    if (!inner || box.dataset.wired) return;
    box.dataset.wired = '1';
    const upd = () => {
      box.classList.toggle('can-left', inner.scrollLeft > 2);
      box.classList.toggle('can-right', inner.scrollLeft + inner.clientWidth < inner.scrollWidth - 2);
    };
    inner.addEventListener('scroll', upd, { passive: true });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(upd).observe(inner);
    upd();
  });
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

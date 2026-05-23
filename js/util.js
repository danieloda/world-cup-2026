// Utilitários compartilhados entre páginas.

// ===== Bandeiras (emoji por enquanto) =====
export const FLAGS = {
  Algeria: '🇩🇿', Argentina: '🇦🇷', Australia: '🇦🇺', Austria: '🇦🇹',
  Belgium: '🇧🇪', 'Bosnia & Herzegovina': '🇧🇦', Brazil: '🇧🇷', Canada: '🇨🇦',
  'Cape Verde': '🇨🇻', Colombia: '🇨🇴', Croatia: '🇭🇷', 'Curaçao': '🇨🇼',
  'Czech Republic': '🇨🇿', 'DR Congo': '🇨🇩', Ecuador: '🇪🇨', Egypt: '🇪🇬',
  England: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', France: '🇫🇷', Germany: '🇩🇪', Ghana: '🇬🇭',
  Haiti: '🇭🇹', Iran: '🇮🇷', Iraq: '🇮🇶', 'Ivory Coast': '🇨🇮',
  Japan: '🇯🇵', Jordan: '🇯🇴', Mexico: '🇲🇽', Morocco: '🇲🇦',
  Netherlands: '🇳🇱', 'New Zealand': '🇳🇿', Norway: '🇳🇴', Panama: '🇵🇦',
  Paraguay: '🇵🇾', Portugal: '🇵🇹', Qatar: '🇶🇦', 'Saudi Arabia': '🇸🇦',
  Scotland: '🏴󠁧󠁢󠁳󠁣󠁴󠁿', Senegal: '🇸🇳', 'South Africa': '🇿🇦', 'South Korea': '🇰🇷',
  Spain: '🇪🇸', Sweden: '🇸🇪', Switzerland: '🇨🇭', Tunisia: '🇹🇳',
  Turkey: '🇹🇷', Uruguay: '🇺🇾', USA: '🇺🇸', Uzbekistan: '🇺🇿',
};
export function flag(team) { return FLAGS[team] || '🏳️'; }

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
export function shortGround(g) {
  if (!g) return '';
  return g.split(' (')[0];
}

export function stageLabel(s) {
  return {
    group: 'Grupos', r32: '32-avos', r16: 'Oitavas', qf: 'Quartas',
    sf: 'Semis', third: '3º Lugar', final: 'Final',
  }[s] || s;
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

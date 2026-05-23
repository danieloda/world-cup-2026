// Sidebar component — renderiza a barra lateral fixa em todas as páginas do app.
// Uso: import { renderShell } from './sidebar.js'; renderShell({ active: 'inicio', profile, stats });

import { signOut } from './auth.js';
import { supabase } from './supabase.js';

const NAV = [
  { id: 'inicio',     href: 'inicio.html',     label: 'Início',                  icon: iconHome },
  { id: 'grupos',     href: 'grupos.html',     label: 'Grupos & Classificação',  icon: iconGrid },
  { id: 'palpites-g', href: 'palpites-grupos.html', label: 'Palpites — Grupos',   icon: iconTarget },
  { id: 'terceiros',  href: 'terceiros.html',  label: '3ºs Lugares',             icon: iconStar },
  { id: 'palpites-k', href: 'palpites-mata.html', label: 'Palpites — Mata-mata', icon: iconBracket },
  { id: 'campeao',    href: 'campeao-artilheiro.html', label: 'Campeão & Artilheiro', icon: iconTrophy },
  { id: 'historico',  href: 'historico.html',  label: 'Histórico do Bolão',      icon: iconClock },
  { id: 'ranking',    href: 'ranking.html',    label: 'Ranking',                 icon: iconChart },
];

const ADMIN_LINK = {
  id: 'admin', href: 'admin.html', label: 'Admin', icon: iconGear, admin: true,
};

/**
 * Renderiza a estrutura completa da página com sidebar + topbar.
 * Esperado o body conter <div id="app"></div>; o conteúdo da página vai em <main id="pageBody"></main>.
 *
 * @param {Object} opts
 * @param {string} opts.active            — id do item ativo (ex: 'inicio')
 * @param {Object} opts.profile           — profile do usuário (full_name, is_admin, ...)
 * @param {Object} [opts.stats]           — pool stats (pct_played, finished_matches, total_matches)
 * @param {string} [opts.stageLabel]      — fase atual (ex: 'Fase de Grupos')
 */
export async function renderShell({ active, profile, stats, stageLabel }) {
  const app = document.getElementById('app');
  if (!app) throw new Error('Elemento #app não encontrado.');

  const adminClass = profile?.is_admin ? 'admin' : '';
  const initials = getInitials(profile?.full_name || profile?.email || '?');
  const items = profile?.is_admin ? [...NAV, ADMIN_LINK] : NAV;
  const navHtml = items.map(item => navItem(item, active)).join('');

  const pct = stats?.pct_played ?? 0;
  const finished = stats?.finished_matches ?? 0;
  const total = stats?.total_matches ?? 104;
  const stageTxt = stageLabel || stageFromProgress(pct);

  app.innerHTML = `
    <aside class="sidebar" id="sidebar">
      <div class="sb-brand">
        <div class="sb-brand-logo">⚽</div>
        Bolão 2026
      </div>
      <div class="sb-section">${navHtml}</div>
      <div class="sb-progress">
        <div class="sb-progress-label">Copa 2026</div>
        <div class="sb-progress-title">${pct}% disputada</div>
        <div class="sb-progress-bar"><span style="width:${pct}%"></span></div>
        <div class="sb-progress-text">${finished}/${total} jogos · ${stageTxt}</div>
      </div>
    </aside>
    <div class="sidebar-backdrop" id="sidebarBackdrop"></div>
    <div class="main">
      <div class="topbar">
        <div style="display:flex; align-items:center;">
          <button class="menu-toggle" id="menuToggle" aria-label="Menu">☰</button>
          <div class="topbar-nav">
            <button class="topbar-back" onclick="history.back()" aria-label="Voltar">‹</button>
            <button class="topbar-back" onclick="history.forward()" aria-label="Avançar">›</button>
          </div>
        </div>
        <div class="topbar-user ${adminClass}" id="topbarUser">
          <span>${escapeHtml(profile?.full_name || 'Usuário')}</span>
          <div class="av">${initials}</div>
        </div>
      </div>
      <div class="body" id="pageBody"></div>
    </div>
  `;

  // Mobile menu
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  document.getElementById('menuToggle')?.addEventListener('click', () => sidebar.classList.toggle('open'));
  backdrop?.addEventListener('click', () => sidebar.classList.remove('open'));

  // Click no avatar / nome → menu de logout
  document.getElementById('topbarUser')?.addEventListener('click', async () => {
    if (confirm('Sair da conta?')) await signOut();
  });

  return document.getElementById('pageBody');
}

function navItem(item, activeId) {
  const isActive = item.id === activeId;
  const cls = ['sb-link'];
  if (item.admin) cls.push('admin');
  if (isActive) cls.push('active');
  return `<a class="${cls.join(' ')}" href="${item.href}">${item.icon()}${escapeHtml(item.label)}</a>`;
}

function getInitials(s) {
  return s.trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() || '').join('') || '?';
}

function stageFromProgress(pct) {
  if (pct === 0) return 'Aguardando início';
  if (pct < 70) return 'Fase de Grupos';
  if (pct < 85) return 'Mata-mata';
  if (pct < 100) return 'Fase Final';
  return 'Copa encerrada';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== Ícones SVG (inline, sem dependência) =====
function svg(d) { return `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`; }
function iconHome()    { return svg('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>'); }
function iconGrid()    { return svg('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>'); }
function iconTarget()  { return svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'); }
function iconStar()    { return svg('<path d="M12 2l2 7h7l-6 4 2 7-7-4-7 4 2-7-6-4h7z"/>'); }
function iconBracket() { return svg('<path d="M6 9l6 6 6-6"/>'); }
function iconTrophy()  { return svg('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/>'); }
function iconClock()   { return svg('<path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/>'); }
function iconChart()   { return svg('<path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 6-6"/>'); }
function iconGear()    { return svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'); }

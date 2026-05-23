// Sidebar component — barra lateral fixa em todas as páginas do app.
// Uso: renderShell({ active: 'inicio', profile, stats })

import { signOut } from './auth.js';
import { avatarHtml } from './util.js';

// Agrupamento de navegação por seção
const NAV_SECTIONS = [
  {
    label: 'Principal',
    items: [
      { id: 'inicio', href: 'inicio.html', label: 'Início', icon: iconHome },
    ],
  },
  {
    label: 'Bolão',
    items: [
      { id: 'grupos',     href: 'grupos.html',     label: 'Grupos & Classificação', icon: iconGrid },
      { id: 'terceiros',  href: 'terceiros.html',  label: '3ºs Lugares',            icon: iconPodium },
      { id: 'historico',  href: 'historico.html',  label: 'Histórico',              icon: iconClock },
      { id: 'ranking',    href: 'ranking.html',    label: 'Ranking',                icon: iconChart },
    ],
  },
  {
    label: 'Palpites',
    items: [
      { id: 'palpites-g', href: 'palpites-grupos.html',    label: 'Grupos',              icon: iconClipboard },
      { id: 'palpites-k', href: 'palpites-mata.html',      label: 'Mata-mata',           icon: iconBracket },
      { id: 'campeao',    href: 'campeao-artilheiro.html', label: 'Campeão & Artilheiro', icon: iconTrophy },
    ],
  },
];

const ADMIN_SECTION = {
  label: 'Administração',
  items: [
    { id: 'admin', href: 'admin.html', label: 'Admin', icon: iconGear, admin: true },
  ],
};

const COLLAPSED_KEY = 'bolao-sidebar-collapsed';

/**
 * Renderiza a estrutura completa da página com sidebar + topbar.
 */
export async function renderShell({ active, profile, stats, stageLabel }) {
  const app = document.getElementById('app');
  if (!app) throw new Error('Elemento #app não encontrado.');

  const sections = profile?.is_admin ? [...NAV_SECTIONS, ADMIN_SECTION] : NAV_SECTIONS;
  const avatar = avatarHtml(profile);
  const adminClass = profile?.is_admin ? 'admin' : '';

  const pct = stats?.pct_played ?? 0;
  const finished = stats?.finished_matches ?? 0;
  const total = stats?.total_matches ?? 104;
  const stageTxt = stageLabel || stageFromProgress(pct);

  const startCollapsed = localStorage.getItem(COLLAPSED_KEY) === '1';

  app.innerHTML = `
    <aside class="sidebar ${startCollapsed ? 'collapsed' : ''}" id="sidebar">
      <div class="sb-brand">
        <a href="inicio.html" class="sb-brand-link">
          <img src="assets/fifa-2026-logo.png" alt="FIFA 2026" class="sb-fifa-logo">
        </a>
      </div>

      <nav class="sb-nav">
        ${sections.map(section => renderSection(section, active)).join('')}
      </nav>

      <div class="sb-progress">
        <div class="sb-progress-label">Copa 2026</div>
        <div class="sb-progress-bar"><span style="width:${pct}%"></span></div>
        <div class="sb-progress-stats">
          <strong>${pct}%</strong>
          <span>${finished}/${total} jogos</span>
        </div>
        <div class="sb-progress-stage">${stageTxt}</div>
      </div>
    </aside>

    <button class="sb-collapse-btn" id="sbCollapseBtn" aria-label="Recolher menu" title="Recolher menu">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
    </button>

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
          <div class="av">${avatar}</div>
        </div>
      </div>
      <div class="body" id="pageBody"></div>
    </div>
  `;

  // Collapse toggle
  const sidebar = document.getElementById('sidebar');
  document.getElementById('sbCollapseBtn').addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    const isCollapsed = sidebar.classList.contains('collapsed');
    localStorage.setItem(COLLAPSED_KEY, isCollapsed ? '1' : '0');
  });

  // Mobile menu
  const backdrop = document.getElementById('sidebarBackdrop');
  document.getElementById('menuToggle')?.addEventListener('click', () => sidebar.classList.toggle('open'));
  backdrop?.addEventListener('click', () => sidebar.classList.remove('open'));

  // Click no nome → menu de logout
  document.getElementById('topbarUser')?.addEventListener('click', async () => {
    if (confirm('Sair da conta?')) await signOut();
  });

  return document.getElementById('pageBody');
}

function renderSection(section, activeId) {
  return `
    <div class="sb-section-group">
      <div class="sb-section-label">${escapeHtml(section.label)}</div>
      ${section.items.map(item => renderNavItem(item, activeId)).join('')}
    </div>
  `;
}

function renderNavItem(item, activeId) {
  const isActive = item.id === activeId;
  const cls = ['sb-link'];
  if (item.admin) cls.push('admin');
  if (isActive) cls.push('active');
  return `
    <a class="${cls.join(' ')}" href="${item.href}" title="${escapeHtml(item.label)}">
      ${item.icon()}
      <span class="sb-link-label">${escapeHtml(item.label)}</span>
    </a>
  `;
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

// ===== Ícones SVG (Lucide-inspired, outlines limpos) =====
function svg(d) { return `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`; }

// Casa
function iconHome() {
  return svg('<path d="M3 9.5L12 2l9 7.5V21a2 2 0 0 1-2 2h-3v-7h-8v7H5a2 2 0 0 1-2-2z"/>');
}

// Grupos & Classificação — tabela de standings
function iconGrid() {
  return svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>');
}

// 3ºs Lugares — pódio com 3 degraus
function iconPodium() {
  return svg('<rect x="9" y="8" width="6" height="13"/><rect x="2" y="13" width="6" height="8"/><rect x="16" y="11" width="6" height="10"/><path d="M3 21h18"/>');
}

// Histórico — relógio com seta
function iconClock() {
  return svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><polyline points="3 3 3 8 8 8"/><path d="M12 7v5l3 2"/>');
}

// Ranking — barras crescentes
function iconChart() {
  return svg('<line x1="6" y1="20" x2="6" y2="14"/><line x1="12" y1="20" x2="12" y2="8"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="3" y1="20" x2="21" y2="20"/>');
}

// Palpites Grupos — clipboard com check
function iconClipboard() {
  return svg('<rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 4h6v3H9z"/><polyline points="9 14 11 16 15 12"/>');
}

// Palpites Mata-mata — bracket clássico (igual a referência)
function iconBracket() {
  return svg('<path d="M3 5v3a2 2 0 0 0 2 2h2a2 2 0 0 1 2 2v4M3 19v-3a2 2 0 0 1 2-2h2a2 2 0 0 0 2-2v-4"/><path d="M21 5v3a2 2 0 0 1-2 2h-2a2 2 0 0 0-2 2v4M21 19v-3a2 2 0 0 0-2-2h-2a2 2 0 0 1-2-2v-4"/><line x1="9" y1="12" x2="15" y2="12"/>');
}

// Campeão & Artilheiro — troféu (filled bowl)
function iconTrophy() {
  return svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 4h3v2a3 3 0 0 1-3 3M7 4H4v2a3 3 0 0 0 3 3"/>');
}

// Admin — engrenagem
function iconGear() {
  return svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>');
}

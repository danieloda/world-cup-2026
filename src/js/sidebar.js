// Sidebar component — barra lateral fixa em todas as páginas do app.
// Uso: renderShell({ active: 'inicio', profile, stats })

import { signOut } from './auth.js';
import { supabase } from './supabase.js';
import { loadLockAlerts } from './lock-alerts.js';
import { avatarHtml, getInitials, showToast } from './util.js';

// Agrupamento de navegação por seção
const NAV_SECTIONS = [
  {
    label: 'Principal',
    items: [
      { id: 'inicio', href: 'inicio.html', label: 'Início', icon: iconHome },
      { id: 'regras', href: 'regras.html', label: 'Regras & Pontuação', icon: iconBook },
    ],
  },
  {
    label: 'Bolão',
    items: [
      { id: 'historico',  href: 'historico.html',  label: 'Palpites da galera', icon: iconClock },
      { id: 'ranking',    href: 'ranking.html',    label: 'Ranking',    icon: iconChart },
    ],
  },
  {
    label: 'Palpites',
    items: [
      { id: 'palpites-g', href: 'palpites-grupos.html',    label: 'Grupos & Classificação', icon: iconClipboard },
      { id: 'palpites-k', href: 'palpites-mata.html',      label: 'Mata-mata',              icon: iconBracket },
      { id: 'campeao',    href: 'campeao-artilheiro.html', label: 'Campeão & Artilheiro',   icon: iconTrophy },
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
 *
 * Garante que o loader FIFA fique visível por no mínimo MIN_DELAY ms.
 * Se a página carrega em 50ms, espera mais 350ms. Se carrega em 600ms,
 * vai direto. Evita "flash" do loader desaparecendo instantaneamente.
 */
const MIN_LOADER_MS = 400;

export async function renderShell({ active, profile, stats, stageLabel, lockAlerts }) {
  const elapsed = performance.now();
  if (elapsed < MIN_LOADER_MS) {
    await new Promise(r => setTimeout(r, MIN_LOADER_MS - elapsed));
  }

  // Badge de pendência por item de palpite. O Início já calcula e passa
  // (lockAlerts); as demais páginas deixam a sidebar buscar sozinha.
  const alerts = lockAlerts ?? await loadLockAlerts(profile?.id).catch(() => null);
  const navBadges = buildNavBadges(alerts);

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
        <a href="inicio.html" class="sb-brand-link sb-brand-link--sbc" aria-label="SBC 2026">
          <img src="assets/icons/logo-social.png" alt="SBC 2026" class="sb-sbc-logo">
        </a>
        <span class="sb-brand-sep" aria-hidden="true"></span>
        <a href="inicio.html" class="sb-brand-link" aria-label="FIFA World Cup 2026">
          <img src="assets/fifa-2026-logo.png" alt="FIFA 2026" class="sb-fifa-logo">
        </a>
      </div>

      <nav class="sb-nav">
        ${sections.map(section => renderSection(section, active, navBadges)).join('')}
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
        <div class="topbar-account ${adminClass}" id="topbarAccount">
          <button class="topbar-user ${adminClass}" id="topbarUser" type="button"
                  aria-haspopup="menu" aria-expanded="false" title="Sua conta">
            <span class="tu-name">${escapeHtml(profile?.full_name || 'Usuário')}</span>
            <div class="av">${avatar}</div>
            <svg class="tu-caret" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="account-menu ${adminClass}" id="accountMenu" role="menu" aria-label="Menu da conta">
            <div class="account-head">
              <div class="account-head-av">${avatar}</div>
              <div class="account-head-info">
                <div class="account-head-name" id="accHeadName">${escapeHtml(profile?.full_name || 'Usuário')}</div>
                <div class="account-head-email">${escapeHtml(profile?.email || '')}</div>
              </div>
            </div>
            <div class="account-menu-items">
              <button class="account-item" type="button" data-account-action="name" role="menuitem">${iconEdit()}<span>Alterar nome</span></button>
              <button class="account-item" type="button" data-account-action="photo" role="menuitem">${iconImage()}<span>Alterar foto</span></button>
              <div class="account-sep"></div>
              <button class="account-item danger" type="button" data-account-action="logout" role="menuitem">${iconLogout()}<span>Sair</span></button>
            </div>
          </div>
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

  // Click no nome/foto → menu da conta (alterar nome, alterar foto, sair)
  wireAccountMenu(profile);

  return document.getElementById('pageBody');
}

function renderSection(section, activeId, badges = {}) {
  return `
    <div class="sb-section-group">
      <div class="sb-section-label">${escapeHtml(section.label)}</div>
      ${section.items.map(item => renderNavItem(item, activeId, badges)).join('')}
    </div>
  `;
}

function renderNavItem(item, activeId, badges = {}) {
  const isActive = item.id === activeId;
  const cls = ['sb-link'];
  if (item.admin) cls.push('admin');
  if (isActive) cls.push('active');
  const badge = badges[item.id];
  const badgeHtml = badge
    ? `<span class="sb-badge ${badge.urgent ? 'urgent' : ''}" title="${badge.count} palpite${badge.count > 1 ? 's' : ''} perto de bloquear">${badge.count}</span>`
    : '';
  return `
    <a class="${cls.join(' ')}" href="${item.href}" title="${escapeHtml(item.label)}">
      ${item.icon()}
      <span class="sb-link-label">${escapeHtml(item.label)}</span>
      ${badgeHtml}
    </a>
  `;
}

// Mapeia os alertas de bloqueio para badges por item de navegação:
// jogos de grupo → "Grupos & Classificação"; mata-mata → "Mata-mata".
// urgent = há algo travando em <48h naquele item.
function buildNavBadges(alerts) {
  if (!alerts || alerts.total === 0) return {};
  const H48_MS = 48 * 3600000;
  const buckets = { 'palpites-g': [], 'palpites-k': [] };
  for (const m of alerts.matches) {
    const id = m.stage && m.stage !== 'group' ? 'palpites-k' : 'palpites-g';
    buckets[id].push(m);
  }
  const badges = {};
  for (const [id, list] of Object.entries(buckets)) {
    if (!list.length) continue;
    badges[id] = { count: list.length, urgent: list.some(m => m.diff <= H48_MS) };
  }
  return badges;
}

// ============================================================
// Menu da conta (topbar) — alterar nome, alterar foto, sair
// ============================================================
function wireAccountMenu(profile) {
  const accountEl = document.getElementById('topbarAccount');
  const userBtn = document.getElementById('topbarUser');
  const menu = document.getElementById('accountMenu');
  if (!accountEl || !userBtn || !menu) return;

  const open = () => { accountEl.classList.add('open'); userBtn.setAttribute('aria-expanded', 'true'); };
  const close = () => { accountEl.classList.remove('open'); userBtn.setAttribute('aria-expanded', 'false'); };

  userBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    accountEl.classList.contains('open') ? close() : open();
  });
  // Clique fora fecha
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#topbarAccount')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('accountModal')?.classList.contains('show')) close();
  });

  menu.querySelectorAll('[data-account-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.accountAction;
      close();
      if (action === 'logout') return void signOut();
      if (action === 'name') openNameModal(profile);
      if (action === 'photo') openPhotoModal(profile);
    });
  });
}

/** Propaga nome/avatar atualizados pra topbar e cabeçalho do menu. */
function applyProfileToTopbar(profile) {
  const av = avatarHtml(profile);
  const name = profile.full_name || 'Usuário';
  document.querySelectorAll('#topbarUser .av').forEach(el => { el.innerHTML = av; });
  const tn = document.querySelector('#topbarUser .tu-name'); if (tn) tn.textContent = name;
  const hn = document.getElementById('accHeadName'); if (hn) hn.textContent = name;
  const ha = document.querySelector('.account-head-av'); if (ha) ha.innerHTML = av;
}

// ----- Modal genérico -----
function ensureModalRoot() {
  let root = document.getElementById('accountModal');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'accountModal';
  root.className = 'modal-overlay';
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="accountModalTitle">
      <div class="modal-head">
        <h3 id="accountModalTitle"></h3>
        <button class="modal-close" type="button" aria-label="Fechar">&times;</button>
      </div>
      <div class="modal-body" id="accountModalBody"></div>
    </div>`;
  document.body.appendChild(root);
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target.closest('.modal-close') || e.target.closest('[data-close]')) closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  return root;
}

function openModal(title, bodyHtml) {
  const root = ensureModalRoot();
  root.querySelector('#accountModalTitle').textContent = title;
  root.querySelector('#accountModalBody').innerHTML = bodyHtml;
  requestAnimationFrame(() => root.classList.add('show'));
  return root;
}

function closeModal() {
  document.getElementById('accountModal')?.classList.remove('show');
}

function showModalErr(el, msg) { el.textContent = msg; el.hidden = false; }

// ----- Alterar nome -----
function openNameModal(profile) {
  const current = profile?.full_name || '';
  openModal('Alterar nome', `
    <div class="login-field">
      <label for="accNameInput">Como você quer aparecer no bolão</label>
      <input id="accNameInput" type="text" maxlength="40" autocomplete="name" value="${escapeHtml(current)}">
    </div>
    <div class="login-error" id="accModalErr" hidden></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" type="button" data-close>Cancelar</button>
      <button class="btn btn-green" type="button" id="accNameSave">Salvar</button>
    </div>
  `);
  const input = document.getElementById('accNameInput');
  const save = document.getElementById('accNameSave');
  const err = document.getElementById('accModalErr');
  input.focus(); input.select();

  const submit = async () => {
    const name = input.value.trim();
    if (name.length < 2) return showModalErr(err, 'Digite pelo menos 2 caracteres.');
    if (name === current) return closeModal();
    save.disabled = true; save.textContent = 'Salvando…';
    const { error } = await supabase.from('profiles').update({ full_name: name }).eq('id', profile.id);
    if (error) {
      showModalErr(err, 'Não foi possível salvar. Tente de novo.');
      save.disabled = false; save.textContent = 'Salvar';
      return;
    }
    profile.full_name = name;
    applyProfileToTopbar(profile);
    closeModal();
    showToast('Nome atualizado!', 'success');
  };
  save.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

// ----- Alterar foto -----
function openPhotoModal(profile) {
  const MAX_BYTES = 2 * 1024 * 1024;
  const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];
  const prevInner = profile?.avatar_url
    ? `<img src="${escapeHtml(profile.avatar_url)}" alt="">`
    : escapeHtml(getInitials(profile?.full_name || profile?.email || '?'));

  openModal('Alterar foto', `
    <div class="avatar-upload">
      <div class="avatar-preview" id="accAvPrev">${prevInner}</div>
      <label class="btn btn-dark" for="accAvFile">Escolher imagem</label>
      <input id="accAvFile" type="file" accept="image/png,image/jpeg,image/webp" hidden>
      <p class="avatar-hint">PNG, JPG ou WEBP · máx 2MB</p>
    </div>
    <div class="login-error" id="accModalErr" hidden></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" type="button" data-close>Cancelar</button>
      <button class="btn btn-green" type="button" id="accPhotoSave" disabled>Salvar foto</button>
    </div>
  `);
  const fileInput = document.getElementById('accAvFile');
  const prev = document.getElementById('accAvPrev');
  const save = document.getElementById('accPhotoSave');
  const err = document.getElementById('accModalErr');
  let selected = null;

  fileInput.addEventListener('change', () => {
    err.hidden = true;
    const f = fileInput.files?.[0];
    if (!f) return;
    if (!ALLOWED.includes(f.type)) return showModalErr(err, 'Formato inválido. Use PNG, JPG ou WEBP.');
    if (f.size > MAX_BYTES) return showModalErr(err, 'Imagem muito grande (máx 2MB).');
    selected = f;
    const reader = new FileReader();
    reader.onload = (ev) => { prev.innerHTML = `<img src="${ev.target.result}" alt="">`; };
    reader.readAsDataURL(f);
    save.disabled = false;
  });

  save.addEventListener('click', async () => {
    if (!selected) return;
    save.disabled = true; save.textContent = 'Salvando…';
    try {
      const ext = selected.type === 'image/png' ? 'png' : selected.type === 'image/webp' ? 'webp' : 'jpg';
      const path = `${profile.id}/avatar.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('avatars')
        .upload(path, selected, { upsert: true, contentType: selected.type });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);
      const publicUrl = `${pub.publicUrl}?v=${Date.now()}`;
      const { error: updErr } = await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', profile.id);
      if (updErr) throw updErr;
      profile.avatar_url = publicUrl;
      applyProfileToTopbar(profile);
      closeModal();
      showToast('Foto atualizada!', 'success');
    } catch (e) {
      console.warn('avatar update failed:', e);
      showModalErr(err, 'Não foi possível salvar a foto. Tente de novo.');
      save.disabled = false; save.textContent = 'Salvar foto';
    }
  });
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

// Regras & Pontuação — livro aberto
function iconBook() {
  return svg('<path d="M2 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H2zM22 4h-6a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H22z"/>');
}

// Campeão & Artilheiro — troféu (filled bowl)
function iconTrophy() {
  return svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 4h3v2a3 3 0 0 1-3 3M7 4H4v2a3 3 0 0 0 3 3"/>');
}

// Alterar nome — lápis
function iconEdit() {
  return svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>');
}

// Alterar foto — imagem
function iconImage() {
  return svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>');
}

// Sair — log-out
function iconLogout() {
  return svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>');
}

// Admin — engrenagem
function iconGear() {
  return svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>');
}

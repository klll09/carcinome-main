// ============================================================
// Carcinome Home Care - Sidebar + mobile bottom nav
// Active state is computed from location.hash at render time -
// NOT from the router's cached route, which lags one navigation
// behind (the classic "wrong button highlighted" bug).
// ============================================================

import { getCurrentProfile, signOut } from '../auth.js';
import { navigate, legacyHashTarget } from '../router.js';
import { showToast } from './toast.js';
import { confirmModal } from './modal.js';
import { icon } from './icons.js';

// Care Board labels are per CONTRACTS: Dashboard, Cases, Patients, Nurses, Marketplace.
// The second section is titled "WhatsApp", not "System": everything in it is a
// surface of the one WhatsApp number. It is ordered the way an admin works a
// message - design the journey, bind the in-chat forms, write the copy, format
// the documents, then read the log and test a send.
const NAV_ITEMS = [
  {
    section: 'Care Board',
    items: [
      { id: 'dashboard', label: 'Dashboard',   icon: 'grid',        route: 'dashboard' },
      { id: 'cases',     label: 'Cases',       icon: 'clipboard',   route: 'cases' },
      { id: 'patients',  label: 'Patients',    icon: 'users',       route: 'patients' },
      { id: 'nurses',    label: 'Nurses',      icon: 'stethoscope', route: 'nurses' },
      { id: 'doctors',   label: 'Doctors',     icon: 'briefcase',   route: 'doctors' },
      { id: 'suppliers', label: 'Marketplace', icon: 'package',     route: 'suppliers' },
    ],
  },
  {
    section: 'WhatsApp',
    items: [
      { id: 'journeys',  label: 'Journeys',     icon: 'flow',        route: 'journeys' },
      { id: 'forms',     label: 'Forms',        icon: 'shieldCheck', route: 'forms' },
      { id: 'documents', label: 'Documents',    icon: 'fileText',    route: 'documents' },
      { id: 'chat',      label: 'Case chats',   icon: 'message',     route: 'chat' },
      { id: 'messages',  label: 'Message log',  icon: 'list',        route: 'messages' },
      { id: 'testsend',  label: 'Test send',    icon: 'send',        route: 'testsend' },
    ],
  },
  {
    section: 'Admin',
    items: [
      { id: 'settings', label: 'Settings', icon: 'settings', route: 'settings' },
    ],
  },
];

const AVATAR_COLORS = ['#0F8A5F', '#12867A', '#0A6545', '#C05A48', '#0E7490', '#16A371'];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Theme (light → dark → colorful → light), persisted ----
const THEMES = ['light', 'dark', 'colorful'];
const THEME_EMOJI = { light: '☀️', dark: '🌙', colorful: '🎨' };
export function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return THEMES.includes(t) ? t : 'light';
}
function themeEmoji() { return THEME_EMOJI[currentTheme()]; }
export function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  if (next === 'light') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  // The pre-paint script pins an inline black <html> background for dark -
  // clear it when leaving dark or it bleeds through the light themes.
  document.documentElement.style.background = next === 'dark' ? '#0B0C0B' : '';
  try { localStorage.setItem('carcinome_theme', next); } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'dark' ? '#0B0C0B' : '#0F8A5F');
  return next;
}

// Which nav route should be highlighted for the current hash?
// '#cases/abc-123' → 'cases'.
// Two normalisations first, both of which used to leave NO item highlighted:
//   - a query string ('#messages?failed=1' → 'messages')
//   - a legacy hash ('#flows/docs' → 'documents'), because the router rewrites
//     those with history.replaceState, which fires no hashchange for us.
function activeRouteFromHash() {
  let hash = (window.location.hash || '').slice(1);
  const qIdx = hash.indexOf('?');
  if (qIdx !== -1) hash = hash.slice(0, qIdx);
  hash = legacyHashTarget(hash) || hash;
  if (!hash) return 'dashboard';
  const allRoutes = NAV_ITEMS.flatMap(s => s.items.map(i => i.route));
  if (allRoutes.includes(hash)) return hash;
  // longest registered route that prefixes the hash ('cases/…' → 'cases')
  let best = '';
  for (const r of allRoutes) {
    if ((hash === r || hash.startsWith(r + '/')) && r.length > best.length) best = r;
  }
  return best || hash.split('/')[0];
}

export function renderSidebar() {
  const profile = getCurrentProfile();
  const active = activeRouteFromHash();

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const navHTML = NAV_ITEMS.map(section => `
    <div class="nav-section">
      <div class="nav-section-title">${section.section}</div>
      ${section.items.map(item => `
        <button class="nav-item ${active === item.route ? 'active' : ''}"
                data-route="${item.route}" id="nav-${item.id}" aria-current="${active === item.route ? 'page' : 'false'}">
          ${icon(item.icon)}
          <span>${item.label}</span>
        </button>
      `).join('')}
    </div>
  `).join('');

  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="sidebar-logo">${icon('heartPulse')}</div>
      <div class="sidebar-brand">
        <span class="sidebar-brand-name">Carcinome</span>
        <span class="sidebar-brand-sub">Home Care</span>
      </div>
    </div>
    <nav class="sidebar-nav">
      ${navHTML}
    </nav>
    <div class="sidebar-footer">
      <div class="sidebar-user">
        <div class="sidebar-user-main" id="sidebar-profile-chip" title="Signed in">
          <div class="avatar" style="background: ${avatarColor(profile?.full_name)}">${getInitials(profile?.full_name)}</div>
          <div class="sidebar-user-info">
            <div class="sidebar-user-name">${escapeHtml(profile?.full_name || 'Admin')}</div>
            <div class="sidebar-user-role">${escapeHtml(profile?.role || 'admin')}</div>
          </div>
        </div>
        <button class="sidebar-logout-btn" id="sidebar-theme-btn" title="Switch theme (light / dark / colorful)" aria-label="Switch theme" style="margin-right:4px">${themeEmoji()}</button>
        <button class="sidebar-logout-btn" id="sidebar-logout-btn" title="Sign out" aria-label="Sign out">${icon('logOut')}</button>
      </div>
    </div>
  `;

  sidebar.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      navigate(btn.dataset.route);
      sidebar.classList.remove('open');
      document.getElementById('sidebar-overlay')?.classList.remove('active');
    });
  });

  document.getElementById('sidebar-theme-btn')?.addEventListener('click', () => {
    const next = cycleTheme();
    const btn = document.getElementById('sidebar-theme-btn');
    if (btn) btn.textContent = THEME_EMOJI[next];
    showToast(`Theme: ${next}`, 'success');
  });

  // Signing out is its OWN button and asks first - one mis-tap must not
  // log the admin straight out.
  document.getElementById('sidebar-logout-btn')?.addEventListener('click', () => {
    confirmModal('Sign out of Carcinome Home Care?', async () => {
      try {
        await signOut();
        navigate('login');
        showToast('Signed out', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    }, { title: 'Sign out', confirmLabel: 'Sign out', danger: false });
  });

  renderBottomNav(active);
}

// Mobile bottom-nav: 5 priority destinations.
// "Log" rather than "Messages": the sidebar item it mirrors is now
// "Message log", and the short word fits a 5-up bar on a small phone.
function renderBottomNav(active) {
  const el = document.getElementById('bottom-nav');
  if (!el) return;

  const items = [
    { id: 'dashboard', label: 'Home',     route: 'dashboard', icon: 'grid' },
    { id: 'cases',     label: 'Cases',    route: 'cases',     icon: 'clipboard' },
    { id: 'patients',  label: 'Patients', route: 'patients',  icon: 'users' },
    { id: 'messages',  label: 'Log',      route: 'messages',  icon: 'message' },
    { id: 'settings',  label: 'Settings', route: 'settings',  icon: 'settings' },
  ];

  el.innerHTML = `
    <div class="bottom-nav-list">
      ${items.map(it => `
        <button class="bottom-nav-item ${active === it.route ? 'active' : ''}" data-route="${it.route}" aria-label="${it.label}">
          ${icon(it.icon)}
          <span>${it.label}</span>
        </button>
      `).join('')}
    </div>
  `;

  el.querySelectorAll('.bottom-nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.route));
  });
}

// Self-sync: one module-level listener; derives state from the hash,
// so it can never lag behind the router.
let syncBound = false;
export function bindSidebarSync() {
  if (syncBound) return;
  syncBound = true;
  window.addEventListener('hashchange', () => {
    if (document.getElementById('sidebar')) renderSidebar();
  });
}

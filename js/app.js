// ============================================================
// Carcinome Home Care - Main App Controller
// Boot: initAuth → login page OR app shell. Routes lazy-load
// js/pages/<name>.js modules: export default (container, params).
// ============================================================

import { CONFIG } from './config.js';
import { initAuth, getCurrentUser, getCurrentProfile, signIn, clearSession } from './auth.js';
import { registerRoute, initRouter, navigate, setAuthGuard } from './router.js';
import { getPortalSession } from './portal/api.js';
import { renderSidebar, bindSidebarSync } from './components/sidebar.js';
import { showToast } from './components/toast.js';
import { validateEmail } from './utils/validators.js';
import { escapeHtml } from './utils/formatters.js';
import { SESSION_KEY } from './portal/api.js';

const APP_BUILD = CONFIG.VERSION;
window.APP_BUILD = APP_BUILD;

let appBooted = false;

// ---- Route table: hash base → page module (js/pages/<name>.js) ----
// '#cases/:id' and '#patients/:id' resolve to the same module with
// params.id set (the router matches the longest registered prefix).
// Legacy hashes (#flows, #flows/docs, #flows/<id>, #sandbox) are NOT registered
// here: router.js rewrites them to their new route before resolution.
const PAGES = [
  'dashboard', 'cases', 'patients', 'nurses', 'doctors', 'suppliers',
  'journeys', 'forms', 'documents', 'messages', 'chat', 'testsend',
  'settings',
];

// A route whose page file still carries its old name declares the mapping here,
// so the sidebar can be renamed without touching the page modules another
// change owns. `params` pins a sub-view: #documents is what #flows/docs was,
// and flows.js reaches its document editor through params.id === 'docs'
// (and injects the stylesheet that page needs on the way in).
const ROUTE_PAGES = {
  journeys:  { module: 'flows' },
  documents: { module: 'flows', params: { id: 'docs' } },
  testsend:  { module: 'sandbox' },
};

// Routes registered ahead of the page module being built. The nav item exists
// so the destination is discoverable; until the file lands it shows this
// instead of a red failure panel.
// Empty today: js/pages/copy.js shipped, so #copy renders the real editor.
// The mechanism stays for the next route that is announced before it exists.
const PENDING_PAGES = {};

const PAGE_TITLES = {
  dashboard: 'Dashboard',
  cases: 'Cases',
  patients: 'Patients',
  nurses: 'Nurses',
  suppliers: 'Marketplace',
  journeys: 'Journeys',
  forms: 'WhatsApp forms',
  documents: 'Invoice and discharge formats',
  messages: 'Message log',
  chat: 'Case chats',
  testsend: 'Test send',
  doctors: 'Doctors',
  settings: 'Settings',
};

// #sandbox shipped for months with no PAGE_TITLES entry, so it rendered the
// bare app name in the header. Say so in the console rather than let the next
// one slip through the same gap.
for (const p of PAGES) {
  if (!PAGE_TITLES[p]) console.warn(`[app] route "${p}" has no PAGE_TITLES entry`);
}

// Import a page module. Tries the mapped module first, then the module named
// after the route, so this keeps working whether or not a page file is
// eventually renamed to match its route.
async function importPage(name) {
  const spec = ROUTE_PAGES[name] || {};
  const candidates = [...new Set([spec.module || name, name])];
  let firstErr = null;   // the intended module's error is the useful one
  for (const m of candidates) {
    try {
      const mod = await import(`./pages/${m}.js?v=${CONFIG.VERSION}`);
      return { mod, moduleName: m, extraParams: m === spec.module ? spec.params : null };
    } catch (err) {
      if (!firstErr) firstErr = err;
    }
  }
  throw firstErr || new Error(`no page module for route "${name}"`);
}

// Lazy page loader with cache-bust + graceful failure panel.
function pageHandler(name) {
  return async (container, params) => {
    setHeaderTitle(name);

    // Load and render are separate try blocks on purpose: a module that is not
    // there yet is a placeholder, a module that throws while rendering is a bug.
    // ALWAYS log the load failure first: import() rejects identically for a 404
    // and for a SyntaxError inside the module, so a silent placeholder would
    // hide a real bug the day the pending page actually lands.
    let loaded;
    try {
      loaded = await importPage(name);
    } catch (err) {
      console.error(`[app] page module for "${name}" failed to load:`, err);
      if (PENDING_PAGES[name]) { renderPendingPanel(container, name); return; }
      renderPageError(container, err);
      return;
    }

    try {
      const { mod } = loaded;
      if (typeof mod.default !== 'function') {
        throw new Error(`pages/${loaded.moduleName}.js has no default export`);
      }
      await mod.default(container, { ...params, ...(loaded.extraParams || {}) });
    } catch (err) {
      console.error(`[app] page "${name}" failed to render:`, err);
      renderPageError(container, err);
    }
  };
}

function renderPageError(container, err) {
  container.innerHTML = `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <h3>This page could not load</h3>
      <p>${escapeHtml(err?.message || 'Unknown error')}</p>
      <button class="btn btn-secondary" onclick="location.reload()">Reload the app</button>
    </div>`;
}

function renderPendingPanel(container, name) {
  container.innerHTML = `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <h3>${escapeHtml(PAGE_TITLES[name] || 'This page')} is coming next</h3>
      <p>${escapeHtml(PENDING_PAGES[name])}</p>
    </div>`;
}

// ---- Full-page routes (the doors) ----------------------------------------
// The landing page, the admin login and every portal route own the whole
// screen: they render into #app, not into the admin shell's #page-content,
// and they must work with NO shell mounted at all. router.js picks the
// container from the route's `fullPage` flag.
const DOOR_ROUTES = ['welcome', 'login', 'portal/login', 'portal/enter', 'portal/home', 'portal/chat'];

function hashBase(hash) {
  let p = String(hash || '').replace(/^#/, '');
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  return p;
}
const isDoorHash = () => DOOR_ROUTES.includes(hashBase(window.location.hash));
const isPortalHash = () => hashBase(window.location.hash).startsWith('portal/');

/** Lazy-load a full-page module. Failures paint into #app, not a card. */
function doorHandler(name) {
  return async (container, params) => {
    try {
      const mod = await import(`./pages/${name}.js?v=${CONFIG.VERSION}`);
      if (typeof mod.default !== 'function') throw new Error(`pages/${name}.js has no default export`);
      await mod.default(container, params);
    } catch (err) {
      console.error(`[app] door page "${name}" failed:`, err);
      document.getElementById('app').innerHTML =
        '<div class="boot-screen"><p class="boot-msg boot-error">This page could not load.<br>' +
        escapeHtml(err?.message || 'Unknown error') +
        '</p><button class="boot-link" onclick="location.reload()">Reload</button></div>';
    }
  };
}

function setHeaderTitle(routeName) {
  const el = document.getElementById('header-title');
  if (el) el.textContent = PAGE_TITLES[routeName] || CONFIG.APP_NAME;
  document.title = `${PAGE_TITLES[routeName] || 'Admin'} - ${CONFIG.APP_NAME}`;
}

// ---- Check config sanity ----
function checkConfig() {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    document.getElementById('app').innerHTML = `
      <div class="login-page">
        <div class="login-card">
          <div class="card" style="text-align:center">
            <h2>Setup required</h2>
            <p>Configure Supabase credentials in <code>js/config.js</code>.</p>
          </div>
        </div>
      </div>`;
    return false;
  }
  return true;
}

// ---- Render Login Page ----
function renderLoginPage() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="login-page">
      <div class="login-split">
        <aside class="login-hero">
          <div class="lh-brand">
            <div class="logo-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
            </div>
            <div>
              <div class="lh-word">Carcinome</div>
              <div class="lh-tag">Home Care</div>
            </div>
          </div>
          <div class="lh-statement">
            <p class="lh-eyebrow">Oncology care, at home</p>
            <h1>Every case, every message, <em>one board</em>.</h1>
            <p class="lh-sub">Registrations, nurse offers, consent, arrival OTPs, invoices and discharge summaries - the whole WhatsApp care loop, coordinated from here.</p>
          </div>
          <div class="lh-foot">
            <svg class="lh-ecg" viewBox="0 0 280 40" fill="none" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 20 H92 L104 20 112 7 122 33 130 20 H188 L196 20 202 12 208 27 214 20 H280" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="lh-mono">WhatsApp-first · Consent-led · Made with care</span>
          </div>
        </aside>
        <div class="login-card">
          <div class="card">
            <div class="lc-head">
              <div class="lc-kicker">Admin access</div>
              <h2>Welcome back.</h2>
              <p>Sign in to run today's home-care sessions.</p>
            </div>
            <form id="login-form">
              <div class="form-group">
                <label class="form-label" for="auth-email">Email</label>
                <input class="form-input" id="auth-email" type="email" placeholder="admin@carcinome.in" autocomplete="username" required />
              </div>
              <div class="form-group">
                <label class="form-label" for="auth-password">Password</label>
                <input class="form-input" id="auth-password" type="password" placeholder="••••••••" autocomplete="current-password" required />
              </div>
              <button type="submit" class="btn btn-primary btn-lg" style="width:100%" id="auth-submit-btn">Sign In</button>
            </form>
            <p style="text-align:center;margin-top:var(--space-4);font-size:var(--font-xs);color:var(--color-text-muted)">
              Access is limited to the Carcinome core team.
            </p>
            <!-- Without this, #login is a dead end: the staff door is hidden
                 on the landing page in production, so someone who lands here
                 by mistake has no way back to the patient/nurse/doctor doors. -->
            <button type="button" class="btn btn-ghost" id="auth-back"
                    style="width:100%;margin-top:var(--space-2);font-size:var(--font-xs)">
              &larr; Patient, nurse or doctor sign-in
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('auth-back')?.addEventListener('click', () => navigate('welcome'));

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const btn = document.getElementById('auth-submit-btn');

    if (!validateEmail(email)) { showToast('Please enter a valid email', 'warning'); return; }
    if (!password) { showToast('Please enter your password', 'warning'); return; }

    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';

    try {
      await signIn(email, password);
      console.log('[auth] signIn OK; mounting app shell');
      showToast('Welcome back!', 'success');
      bootApp();
      navigate('dashboard');
    } catch (err) {
      console.error('[auth] sign-in error:', err);
      showToast(err.message, 'error');
      // The form may have been replaced if boot half-happened; guard.
      const b = document.getElementById('auth-submit-btn');
      if (b) { b.disabled = false; b.textContent = 'Sign In'; }
    }
  });
}

// ---- Stranded-session recovery screen ----
// Shown when we have an auth session but couldn't load its profile
// (flaky network, or an account that was removed). Both exits are safe.
function renderAccountProblemScreen() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <div class="logo-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
          </div>
          <h1>We couldn't load your account</h1>
          <p>This is usually a weak connection - or a sign-in that is no longer valid on this device.</p>
        </div>
        <div class="card">
          <button class="btn btn-primary btn-lg" style="width:100%" id="acct-retry">Try again</button>
          <button class="btn btn-secondary btn-lg" style="width:100%;margin-top:var(--space-3)" id="acct-signout">Sign out &amp; sign in again</button>
        </div>
      </div>
    </div>`;
  document.getElementById('acct-retry')?.addEventListener('click', () => location.reload());
  document.getElementById('acct-signout')?.addEventListener('click', async () => {
    const btn = document.getElementById('acct-signout');
    btn.disabled = true; btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
    await clearSession();          // never throws - guarantees local teardown
    appBooted = false;
    renderLoginPage();
  });
}

// ---- Render App Shell ----
function renderAppShell() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="app-shell">
      <div class="sidebar-overlay" id="sidebar-overlay"></div>
      <aside class="sidebar" id="sidebar"></aside>
      <main class="main-content">
        <header class="header">
          <div class="header-left">
            <button class="mobile-menu-btn" id="mobile-menu-btn" aria-label="Open menu">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
            </button>
            <span class="header-title" id="header-title">${CONFIG.APP_NAME}</span>
          </div>
          <div class="header-right">
            <span class="live-dot" id="live-indicator" title="Realtime timeline connected">Live</span>
          </div>
        </header>
        <div class="page-content" id="page-content"></div>
      </main>
      <nav class="bottom-nav" id="bottom-nav" aria-label="Primary"></nav>
    </div>
  `;

  renderSidebar();

  // Mobile menu
  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('active');
  });
  document.getElementById('sidebar-overlay')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('active');
  });

  // Sidebar/bottom-nav active state self-syncs from location.hash -
  // a single module-level listener, registered once.
  bindSidebarSync();
}

// ---- Boot the shell + router ----
function gateAndBoot() {
  const prof = getCurrentProfile();
  // A session without a profile must never mount the shell: every query
  // would RLS-fail with no way out. Give the user a clear exit instead.
  if (!prof) { renderAccountProblemScreen(); return; }
  bootApp();
}

function bootApp() {
  console.log('[boot] bootApp called, appBooted=' + appBooted + ', hash=' + window.location.hash);
  if (appBooted) {
    console.log('[boot] already booted - skip');
    return;
  }
  appBooted = true;
  // Set the target hash BEFORE mounting the shell so the router's first
  // read doesn't trigger the login handler (which would overwrite the shell).
  const hash = window.location.hash.slice(1);
  if (!hash || hash === 'login') {
    history.replaceState(null, '', '#dashboard');
  }
  try {
    renderAppShell();
    console.log('[boot] app shell mounted');
    initRouter();
    console.log('[boot] router initialized');
  } catch (e) {
    console.error('[boot] FAILED to render shell:', e);
    appBooted = false;
    document.getElementById('app').innerHTML =
      '<div class="boot-screen"><p class="boot-msg boot-error">Boot error: ' +
      escapeHtml(e && e.message ? e.message : 'unknown') +
      '</p><button class="boot-link" onclick="location.reload()">Reload</button></div>';
  }
}

// ---- Initialize App ----
async function init() {
  console.log('[init] starting Carcinome Home Care build ' + APP_BUILD);
  if (!checkConfig()) return;

  // ---- Routes ----
  // Doors first: they need no admin session and own the whole screen.
  registerRoute('welcome', doorHandler('landing'), { requiresAuth: false, fullPage: true });
  registerRoute('portal/login', doorHandler('portal_login'), { requiresAuth: false, fullPage: true });
  registerRoute('portal/enter', doorHandler('portal_enter'), { requiresAuth: false, fullPage: true });
  registerRoute('portal/home', doorHandler('portal_home'), { requiresAuth: false, fullPage: true });
  registerRoute('portal/chat', doorHandler('portal_chat'), { requiresAuth: false, fullPage: true });
  registerRoute('login', () => renderLoginPage(), { requiresAuth: false, fullPage: true });
  for (const name of PAGES) {
    registerRoute(name, pageHandler(name), { requiresAuth: true });
  }

    // If a sign-in succeeds in ANOTHER tab (e.g. the browser opened the
  // WhatsApp link in a different tab than the one you're looking at), this
  // tab notices and follows automatically instead of you having to go hunt
  // for the right tab yourself. The 'storage' event only ever fires in
  // OTHER tabs, never the one that made the change, so this can't loop.
  window.addEventListener('storage', (e) => {
    if (e.key === SESSION_KEY && e.newValue) {
      location.reload();
    }
  });

  // Auth guard — admin routes only; the portal guards itself against
  // portal_sessions, which the admin session knows nothing about.
  setAuthGuard(() => !!getCurrentUser());

  // ---- Boot, in priority order ----
  // 1. A magic link in the URL outranks EVERYTHING, including an admin
  //    already signed in on this browser: the link belongs to a different
  //    person and redeeming it is the whole point of them tapping it.
  if (hashBase(window.location.hash) === 'portal/enter') {
    console.log('[init] magic link present — redeeming before anything else');
    initRouter();
    return;
  }

  // 2. A live portal session boots the portal and never the admin shell.
  if (getPortalSession()) {
    console.log('[init] portal session found — booting portal');
    if (!isPortalHash()) history.replaceState(null, '', '#portal/home');
    initRouter();
    return;
  }

  // Listen for sign-out to go back to login. Also handle SIGNED_IN events
  // that didn't come from our login form.
  // IMPORTANT: supabase-js holds an internal auth lock while these
  // callbacks run - calling getSession()/queries synchronously inside
  // deadlocks the whole client (boot screen forever after a reload).
  // Defer ALL work to the next tick so the lock is released first.
  const { getSupabase } = await import('./supabase.js');
  getSupabase().auth.onAuthStateChange((event, session) => {
    setTimeout(async () => {
      if (event === 'SIGNED_OUT') {
        appBooted = false;
        renderLoginPage();
      } else if (event === 'SIGNED_IN' && session && !appBooted) {
        // Wait for BOTH user and profile - booting before the profile
        // loads renders the shell with an empty user chip.
        if (!getCurrentUser() || !getCurrentProfile()) {
          const s = await initAuth();
          // initAuth tears down sessions with no usable profile - respect that.
          if (!s) { renderLoginPage(); return; }
        }
        gateAndBoot();
      }
    }, 0);
  });

  // 3. Admin session → the admin shell, exactly as before.
  console.log('[init] checking existing session…');
  const session = await initAuth();
  console.log('[init] session?', !!session);
  if (session) {
    gateAndBoot();
    return;
  }

  // 4. Nobody is signed in → the front door. A visitor who asked for a
  //    specific door (#login, #portal/…) keeps it; everything else, including
  //    a bare '#' and a deep link into the admin app, lands on #welcome and
  //    the auth guard sends admin routes on to #login from there.
  if (!isDoorHash()) history.replaceState(null, '', '#welcome');
  initRouter();
}

// Start the app - wrap in try/catch so a startup error never leaves the boot spinner up.
document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error('App init failed:', err);
    try { renderLoginPage(); }
    catch (_) {
      document.getElementById('app').innerHTML =
        '<div class="boot-screen"><p class="boot-msg boot-error">Failed to start: ' +
        (err && err.message ? err.message : 'unknown error') +
        '</p><button class="boot-link" onclick="location.reload()">Reload</button></div>';
    }
  });
});

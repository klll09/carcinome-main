// ============================================================
// Carcinome Home Care - SPA Router (hash-based)
// registerRoute / navigate / getRouteParams / auth guard.
// ============================================================

const routes = {};
let currentRoute = null;
let authGuard = null;

// Register a route
export function registerRoute(path, handler, options = {}) {
  routes[path] = { handler, ...options };
}

// Set auth guard callback
export function setAuthGuard(fn) { authGuard = fn; }

// Navigate to a route
export function navigate(path) {
  window.location.hash = path;
}

// Get current route
export function getCurrentRoute() { return currentRoute; }

// Get route params from hash (e.g., #cases/abc-123 → { id: 'abc-123' },
// #messages?failed=1 → { failed: '1' }; path params win on key collision)
export function getRouteParams() {
  const hash = window.location.hash.slice(1) || 'login';
  const qIdx = hash.indexOf('?');
  const path = qIdx === -1 ? hash : hash.slice(0, qIdx);
  const query = qIdx === -1 ? '' : hash.slice(qIdx + 1);
  const parts = path.split('/');
  const params = {};

  if (query) {
    for (const [key, value] of new URLSearchParams(query)) {
      params[key] = value;
    }
  }

  if (parts.length >= 2) {
    params.id = parts.slice(1).join('/');
  }

  return params;
}

// ---- Legacy hashes -------------------------------------------------------
// The "System" section was renamed to "WhatsApp" and its routes with it.
// #flows and #sandbox are bookmarked and are linked from inside pages, and
// getBasePath() below sends anything unregistered to #dashboard - so an old
// link would land somewhere plausible and wrong instead of erroring. Rewrite
// them first, keeping any :id segment and any query string.
const LEGACY_HASHES = [
  [/^flows\/docs\/?$/, () => 'documents'],
  [/^flows\/(.+)$/,    (m) => `journeys/${m[1]}`],   // #flows/<uuid> → #journeys/<uuid>
  [/^flows\/?$/,       () => 'journeys'],
  [/^sandbox\/?$/,     () => 'testsend'],
];

// The route a legacy hash should become, or null if it is not a legacy hash.
// Takes the hash with or without its leading '#'. Exported because the sidebar
// needs the same answer to highlight the right item.
export function legacyHashTarget(rawHash) {
  let path = String(rawHash || '');
  if (path.startsWith('#')) path = path.slice(1);
  const qIdx = path.indexOf('?');
  const query = qIdx === -1 ? '' : path.slice(qIdx);
  if (qIdx !== -1) path = path.slice(0, qIdx);
  for (const [re, to] of LEGACY_HASHES) {
    const m = path.match(re);
    if (m) return to(m) + query;
  }
  return null;
}

// Rewrite a legacy hash in place. replaceState rather than assigning
// location.hash: no second hashchange to handle, and the back button returns
// to where the user came from instead of bouncing off the old hash.
// No target of LEGACY_HASHES is itself a legacy hash, so this cannot loop.
function applyLegacyRedirect() {
  const target = legacyHashTarget(window.location.hash);
  if (!target) return false;
  history.replaceState(null, '', '#' + target);
  return true;
}

// Get the base route path (without params or query string)
function getBasePath(hash) {
  let path = hash.slice(1) || 'login';
  const qIdx = path.indexOf('?');
  if (qIdx !== -1) path = path.slice(0, qIdx) || 'login';
  // Try exact match first
  if (routes[path]) return path;

  // Try matching progressively shorter prefixes (e.g. 'cases/abc' → 'cases')
  const parts = path.split('/');
  for (let i = parts.length; i > 0; i--) {
    const base = parts.slice(0, i).join('/');
    if (routes[base]) return base;
  }

  return 'dashboard'; // fallback
}

// Handle route change
async function handleRouteChange() {
  // Old bookmarks first, BEFORE anything resolves the hash - getBasePath's
  // dashboard fallback would otherwise swallow #flows silently.
  applyLegacyRedirect();

  const hash = window.location.hash || '#login';
  const basePath = getBasePath(hash);
  const route = routes[basePath];

  if (!route) {
    navigate('dashboard');
    return;
  }

  // Auth guard
  if (route.requiresAuth !== false && authGuard) {
    const isAuthed = await authGuard();
    if (!isAuthed) {
      navigate('login');
      return;
    }
  }

  currentRoute = basePath;

  // Call the route handler.
  // Two kinds of route:
  //   normal   → renders INTO the admin shell's #page-content
  //   fullPage → owns the whole screen (#app): the landing door, the admin
  //              login, and every portal route. These must still run when no
  //              shell is mounted, which is why the container is chosen per
  //              route instead of always being #page-content — a logged-out
  //              visitor has no #page-content at all, and before this existed
  //              such routes silently did nothing.
  const container = route.fullPage
    ? document.getElementById('app')
    : document.getElementById('page-content');
  if (container && route.handler) {
    try {
      await route.handler(container, getRouteParams());
    } catch (e) {
      console.error('[router] route handler failed for', basePath, e);
    }
    if (!route.fullPage) {
      // Simple page-enter transition on every route render.
      container.classList.remove('page-enter');
      void container.offsetWidth; // restart the animation
      container.classList.add('page-enter');
    }
  }
}

// Initialize router (idempotent)
let routerInitialized = false;
export function initRouter() {
  if (routerInitialized) {
    handleRouteChange(); // just re-evaluate current route
    return;
  }
  routerInitialized = true;
  window.addEventListener('hashchange', handleRouteChange);
  // Handle initial route
  handleRouteChange();
}

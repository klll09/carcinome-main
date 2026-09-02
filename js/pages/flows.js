// ============================================================
// Carcinome Home Care - Journeys (reference maps)
// #journeys       → journey list (standard ones pinned, tag filter)
// #journeys/<id>  → infinite-canvas viewer/editor (Miro-style)
// #documents      → invoice / discharge formats (js/pages/flowdocs.js)
// Old hashes #flows, #flows/<id> and #flows/docs still land here.
//
// IMPORTANT - this page is PART documentation, PART control. Read the next
// paragraph before changing anything here.
//
// A node may carry `messageKey`, naming an entry in _shared/copy_registry.ts.
// Those cards render the LIVE body (published override, else the code default)
// and their "Edit wording" button deep-links to #copy/<key>. They are the map
// AND the way in. A node without a messageKey is a note: it still writes to
// flows.canvas and still changes nothing that a patient receives, and it is
// labelled "documentation only" on the card so the difference is visible.
//
// Seeded as ONE journey by scripts/seed_flows.mjs, laid out as swimlanes by
// role down the page and stage bands left to right. It used to be seven
// separate canvases, which is why nobody could answer "at this moment, who
// gets a message?" without opening several of them at once.
// Everything here reads and writes the `flows` table. No edge function under
// supabase/ ever reads flows.canvas, so editing a card changes a drawing and
// nothing else. Live wording lives on the Message copy page (#copy). Both the
// list and the editor carry a banner saying exactly that; do not remove it
// without making this page actually drive sends.
//
// Canvas model (persisted as flows.canvas JSONB):
//   nodes: [{ id, type: trigger|message|decision|note, x, y, w,
//             role: patient|nurse|doctor|team|supplier|system,
//             title, body(html, sanitized), channel }]
//   edges: [{ id, from, to, label }]
// ============================================================
import { CONFIG } from '../config.js';
import { getSupabase } from '../supabase.js';
import { getCurrentProfile } from '../auth.js';
import { showToast } from '../components/toast.js';
import { confirmModal } from '../components/modal.js';
import { navigate } from '../router.js';
import { adminAction } from '../utils/api.js';
import { escapeHtml, formatRelativeTime } from '../utils/formatters.js';

// ─── Vocabulary ─────────────────────────────────────────────────────────────
export const ROLE_META = {
  patient:  { label: 'Patient',  color: '#12867A' },
  nurse:    { label: 'Nurse',    color: '#2563B8' },
  doctor:   { label: 'Doctor',   color: '#7C3AED' },
  team:     { label: 'Team',     color: '#B45309' },
  supplier: { label: 'Supplier', color: '#0E7490' },
  system:   { label: 'System',   color: '#64748B' },
};
const CHANNEL_META = {
  template: '📨 Template', text: '💬 Text', buttons: '🔘 Buttons', list: '📋 List',
  flow: '🧾 Form', document: '📄 PDF', payment: '💳 Payment', admin: '🖱️ Dashboard',
  keyword: '⌨️ Typed', cron: '⏰ Scheduled',
};
const NODE_TYPES = [
  { type: 'trigger',  label: 'Trigger',  color: '#B45309', hint: 'an event that starts things' },
  { type: 'message',  label: 'Message',  color: '#0F8A5F', hint: 'something a phone receives' },
  { type: 'decision', label: 'Decision', color: '#7C3AED', hint: 'a branch - yes/no/timeout' },
  { type: 'note',     label: 'Note',     color: '#CA9A04', hint: 'sticky annotation' },
];
const GRID = 10;
const UNDO_DEPTH = 100;

// ─── Live wording ───────────────────────────────────────────────────────────
//
// messageKey -> the English body that is ACTUALLY live right now (the published
// override when there is one, otherwise the built-in default), or null when the
// key has been removed from the registry.
//
// This is what stops the canvas being a drawing. Cards used to carry
// hand-written prose describing what a message said, which was true on the day
// it was written and drifted every time anybody edited a message. Now the card
// shows the real thing, so it cannot lie.
//
// Loaded once per page visit, deliberately not per card, and the canvas renders
// immediately without waiting: a slow list_copy must never stop somebody
// opening the map.
const LIVE_COPY = new Map();
let liveCopyLoaded = false;

async function loadLiveCopy() {
  if (liveCopyLoaded) return;
  liveCopyLoaded = true;
  try {
    const res = await adminAction('list_copy', {});
    for (const k of res?.keys ?? res?.data ?? []) {
      const row = k.rows?.en ?? {};
      LIVE_COPY.set(k.key, row.published_body ?? k.defaults?.en ?? '');
    }
  } catch (err) {
    console.error('[journeys] could not load the live wording:', err);
    liveCopyLoaded = false; // let a later render retry
  }
}

/**
 * WhatsApp markup, rendered. Deliberately the same small set the phone
 * supports and nothing more: *bold* _italic_ ```mono``` and newlines. Escaped
 * first so a patient name can never inject markup into the card.
 */
function renderWa(body) {
  let h = escapeHtml(String(body ?? ''));
  const fences = [];
  h = h.replace(/```([\s\S]+?)```/g, (_m, inner) => { fences.push(inner); return ` FENCE${fences.length - 1} `; });
  const inline = (src, ch, tag) => src.replace(
    new RegExp(`(^|[\\s(])\\${ch}(?!\\s)([^\\${ch}\\n]+?)(?<!\\s)\\${ch}(?=[\\s.,;:!?)]|$)`, 'g'),
    `$1<${tag}>$2</${tag}>`,
  );
  h = inline(h, '*', 'b');
  h = inline(h, '_', 'i');
  h = h.replace(/ FENCE(\d+) /g, (_m, i) => `<code>${fences[Number(i)]}</code>`);
  h = h.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, '<span class="fe-tok">$1</span>');
  return h.replace(/\n/g, '<br>');
}

// ─── Sanitizer (whitelist walker - stored HTML is re-sanitized on render) ───
const OK_TAGS = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'BR', 'UL', 'OL', 'LI', 'IMG', 'DIV', 'P']);
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${String(html ?? '')}</div>`, 'text/html');
  const rootIn = doc.body.firstChild;
  const walk = (node, out) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        out.appendChild(document.createTextNode(child.textContent));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') continue;
        if (OK_TAGS.has(tag)) {
          const el = document.createElement(tag === 'P' ? 'DIV' : tag);
          if (tag === 'IMG') {
            const src = child.getAttribute('src') || '';
            if (!src.startsWith('data:image/')) continue; // only embedded images
            el.setAttribute('src', src);
          }
          out.appendChild(el);
          walk(child, el);
        } else {
          walk(child, out); // unwrap unknown tags, keep their content
        }
      }
    }
  };
  const rootOut = document.createElement('div');
  walk(rootIn, rootOut);
  return rootOut.innerHTML;
}

function uid() { return 'n' + Math.random().toString(36).slice(2, 9); }

// Canvas JSON comes from the DB - ids are interpolated into selectors and SVG
// markup, so they must be boring. Bad ids are regenerated (edges remapped);
// edges pointing nowhere are dropped; bodies re-sanitized.
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export function sanitizeCanvas(raw) {
  const nodesIn = Array.isArray(raw?.nodes) ? raw.nodes : [];
  const edgesIn = Array.isArray(raw?.edges) ? raw.edges : [];
  const remap = new Map();
  const nodes = nodesIn.filter((n) => n && typeof n === 'object').map((n) => {
    let id = String(n.id ?? '');
    if (!ID_RE.test(id)) { const fresh = uid(); remap.set(id, fresh); id = fresh; }
    return { w: 264, ...n, id, body: sanitizeHtml(n.body) };
  });
  const known = new Set(nodes.map((n) => n.id));
  const edges = edgesIn
    .filter((e) => e && e.from != null && e.to != null)
    .map((e) => ({
      id: ID_RE.test(String(e.id ?? '')) ? String(e.id) : uid(),
      from: remap.get(String(e.from)) ?? String(e.from),
      to: remap.get(String(e.to)) ?? String(e.to),
      label: String(e.label ?? ''),
    }))
    .filter((e) => known.has(e.from) && known.has(e.to));
  return { nodes, edges };
}
function snap(v) { return Math.round(v / GRID) * GRID; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function edgeClass(label) {
  const l = String(label ?? '').toLowerCase();
  if (/(^|\b)(yes|accept|paid|signed|correct|parsed|verified)/.test(l)) return 'yes';
  if (/(^|\b)(no|decline|refus)/.test(l)) return 'no';
  if (/timeout|no reply|silence|expired|exhaust/.test(l)) return 'warn';
  return '';
}

// journeys.css also carries the .fd-* rules the documents page uses, so the
// documents route imports this to get them.
export function injectCss() {
  if (document.querySelector('link[data-journeys-css]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = `css/journeys.css?v=${CONFIG.VERSION}`;
  l.dataset.journeysCss = '1';
  document.head.appendChild(l);
}

// The hash base this page is mounted under: 'journeys' (the real route),
// 'flows' (old bookmarks) or 'documents'.
function baseRoute() {
  return window.location.hash.slice(1).split(/[/?]/)[0] || 'journeys';
}
// Where "back to the list" goes. Someone who arrived on an old #flows link
// stays on it rather than being bounced onto a hash they did not type.
function listRoute() {
  return baseRoute() === 'flows' ? 'flows' : 'journeys';
}
// The canvas id in the hash, under either base. 'docs' is the old documents
// hash, never a canvas.
function editorIdFromHash() {
  const m = /^#(?:journeys|flows)\/([^?]+)/.exec(window.location.hash);
  const id = m ? m[1] : null;
  return id && id !== 'docs' ? id : null;
}

// The editor is a fullscreen overlay outside #page-content - tear it down the
// moment the hash leaves the canvas, or it would sit over other pages.
window.addEventListener('hashchange', () => {
  if (!editorIdFromHash()) closeEditorChrome();
});

// ════════════════════════════════════════════════════════════════════════════
// Router entry
// ════════════════════════════════════════════════════════════════════════════
export default async function renderFlows(container, params) {
  injectCss();
  closeEditorChrome();
  const id = params?.id;
  // Documents moved to its own route. Reached as #documents now, still as
  // #flows/docs from old bookmarks.
  if (id === 'docs' || baseRoute() === 'documents') {
    const mod = await import(`./flowdocs.js?v=${CONFIG.VERSION}`);
    return mod.renderFlowDocs(container);
  }
  if (id) return renderEditor(container, id);
  return renderList(container);
}

// This page reads and writes `flows` rows only - nothing under supabase/ reads
// them back. Say so on every surface where someone might start typing.
// The old banner said "Reference only. Editing these cards does not change what
// WhatsApp sends." That was true of every card and is now true of only some, so
// saying it flatly would be a lie in the other direction. Cards bound to a
// message key show the live wording and link to the editor; the rest are notes,
// and each one is labelled "documentation only" on its own face.
const referenceBanner = (cls) => `
  <div class="${cls}" role="note">
    <span class="ico" aria-hidden="true">👁</span>
    <span><b>Cards with a message key are live.</b> They show the wording that goes out right now, and
    <b>Edit wording</b> opens it in <a href="#copy">Message copy</a>. Cards marked
    <i>documentation only</i> are notes: moving or editing those changes nothing that a patient sees.</span>
  </div>`;

// ════════════════════════════════════════════════════════════════════════════
// List page
// ════════════════════════════════════════════════════════════════════════════
async function renderList(container) {
  container.innerHTML = `<div class="fl-head"><h2 style="margin:0">Journeys</h2></div><p style="color:var(--ink-soft,#777)">Loading journeys…</p>`;
  const sb = getSupabase();
  const { data: flows, error } = await sb
    .from('flows')
    .select('id, name, description, tags, status, is_template, sort_order, updated_by, updated_at, canvas')
    .neq('status', 'archived')
    .order('is_template', { ascending: false })
    .order('sort_order')
    .order('updated_at', { ascending: false });
  if (error) {
    container.innerHTML = `<div class="empty-state"><h3>Could not load journeys</h3><p>${escapeHtml(error.message)}</p></div>`;
    return;
  }

  let activeTag = null;
  const allTags = [...new Set((flows ?? []).flatMap((f) => f.tags ?? []))].sort();

  const draw = () => {
    const visible = (flows ?? []).filter((f) => !activeTag || (f.tags ?? []).includes(activeTag));
    const templates = visible.filter((f) => f.is_template);
    const custom = visible.filter((f) => !f.is_template);
    const card = (f) => `
      <div class="fl-card" data-open="${f.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(f.name)}">
        <div class="fl-card-actions">
          <button class="fl-iconbtn" data-dup="${f.id}" title="Duplicate this map">⧉</button>
          ${f.is_template ? '' : `<button class="fl-iconbtn" data-arch="${f.id}" title="Archive">🗑</button>`}
        </div>
        <h3>${escapeHtml(f.name)}</h3>
        <p>${escapeHtml(f.description ?? '')}</p>
        <div class="fl-card-meta">
          ${f.is_template ? '<span class="fl-chip tpl">STANDARD</span>' : ''}
          ${f.status === 'draft' ? '<span class="fl-chip draft">DRAFT</span>' : ''}
          ${(f.tags ?? []).map((t) => `<span class="fl-chip">${escapeHtml(t)}</span>`).join('')}
        </div>
        <div class="fl-card-stats">
          <span>${(f.canvas?.nodes ?? []).length} cards · ${(f.canvas?.edges ?? []).length} links</span>
          <span>${escapeHtml(f.updated_by ?? '')} · ${formatRelativeTime(f.updated_at)}</span>
        </div>
      </div>`;

    container.innerHTML = `
      <div class="fl-head">
        <div>
          <h2 style="margin:0 0 4px">Journeys</h2>
          <div style="font-size:12.5px;color:var(--ink-soft,#777)">A reference map of every WhatsApp journey: which phone hears what, in what order, and what moves each step along.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="fe-btn" id="fl-docs">📄 Documents</button>
          <button class="fe-btn primary" id="fl-new">＋ New journey</button>
        </div>
      </div>
      ${referenceBanner('fl-banner')}
      ${allTags.length ? `<div class="fl-tagbar">
        <button class="fl-tag ${!activeTag ? 'active' : ''}" data-tag="">All</button>
        ${allTags.map((t) => `<button class="fl-tag ${activeTag === t ? 'active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
      </div>` : ''}
      ${templates.length ? `<div class="fl-section-title">Standard journeys</div>
      <div class="fl-grid">${templates.map(card).join('')}</div>` : ''}
      <div class="fl-section-title">Your journeys</div>
      ${custom.length
        ? `<div class="fl-grid">${custom.map(card).join('')}</div>`
        : `<div class="empty-state" style="padding:30px"><h3>No journeys of your own yet</h3><p>Duplicate a standard journey above to sketch a variant, or start blank with “New journey”. Either way it stays a drawing for the team to read.</p></div>`}
    `;

    container.querySelectorAll('.fl-tag').forEach((b) => b.addEventListener('click', () => { activeTag = b.dataset.tag || null; draw(); }));
    const open = (id) => navigate(`${listRoute()}/${id}`);
    container.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', (e) => { if (e.target.closest('[data-dup],[data-arch]')) return; open(el.dataset.open); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(el.dataset.open); });
    });
    container.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', async () => {
      const src = flows.find((f) => f.id === b.dataset.dup);
      const { data, error: dupErr } = await sb.from('flows').insert({
        name: `${src.name} (copy)`, description: src.description, tags: src.tags,
        status: 'draft', canvas: src.canvas, is_template: false,
        updated_by: getCurrentProfile()?.full_name ?? 'admin',
      }).select('id').single();
      if (dupErr) return showToast(dupErr.message, 'error');
      showToast('Journey copied. It is a drawing, not a live message', 'success');
      open(data.id);
    }));
    container.querySelectorAll('[data-arch]').forEach((b) => b.addEventListener('click', () => {
      const f = flows.find((x) => x.id === b.dataset.arch);
      confirmModal(`Archive “${escapeHtml(f.name)}”? It disappears from this list (recoverable in the database).`, async () => {
        const { error: aErr } = await sb.from('flows').update({ status: 'archived' }).eq('id', f.id);
        if (aErr) return showToast(aErr.message, 'error');
        flows.splice(flows.indexOf(f), 1);
        draw();
      }, { title: 'Archive journey', confirmLabel: 'Archive', danger: true });
    }));
    container.querySelector('#fl-new')?.addEventListener('click', async () => {
      const { data, error: nErr } = await sb.from('flows').insert({
        name: 'Untitled journey', status: 'draft',
        canvas: { nodes: [], edges: [] },
        updated_by: getCurrentProfile()?.full_name ?? 'admin',
      }).select('id').single();
      if (nErr) return showToast(nErr.message, 'error');
      open(data.id);
    });
    container.querySelector('#fl-docs')?.addEventListener('click', () => navigate('documents'));
  };
  draw();
}

// ════════════════════════════════════════════════════════════════════════════
// Canvas editor
// ════════════════════════════════════════════════════════════════════════════
let editorCleanup = null;
function closeEditorChrome() {
  if (editorCleanup) { try { editorCleanup(); } catch {} editorCleanup = null; }
  document.querySelectorAll('.fe-wrap, .fe-richbar, .fe-inspector, .fe-drawer').forEach((el) => el.remove());
}

async function renderEditor(container, flowId) {
  container.innerHTML = '';
  const sb = getSupabase();
  const { data: flow, error } = await sb.from('flows').select('*').eq('id', flowId).maybeSingle();
  if (error || !flow) {
    container.innerHTML = `<div class="empty-state"><h3>Journey not found</h3><p>${escapeHtml(error?.message ?? '')}</p><button class="btn btn-secondary" onclick="location.hash='journeys'">Back to Journeys</button></div>`;
    return;
  }
  // The fetch awaited - if the user already navigated away, mounting now would
  // create a zombie fullscreen editor with global key handlers nobody owns.
  if (editorIdFromHash() !== flowId) return;
  closeEditorChrome();

  // ── State ──
  const canvas = sanitizeCanvas(flow.canvas);
  const view = { tx: 0, ty: 0, z: 1 };
  const sel = new Set();       // node ids
  let selEdge = null;          // edge id
  const undoStack = [];
  const redoStack = [];
  let savedAt = flow.updated_at;
  let saveTimer = null;
  let saveState = 'saved';     // saved | dirty | saving | error
  let editingEl = null;        // contenteditable currently active

  // ── Shell ──
  const wrap = document.createElement('div');
  wrap.className = 'fe-wrap';
  wrap.innerHTML = `
    <div class="fe-topbar">
      <button class="fe-btn" id="fe-back" title="Back to Journeys">←</button>
      <input class="fe-name" id="fe-name" value="${escapeHtml(flow.name)}" ${flow.is_template ? 'title="Standard journey. Rename freely: this is the map, not the message."' : ''} />
      <span class="fe-save" id="fe-save">Saved</span>
      <div class="fe-spacer"></div>
      <button class="fe-btn" id="fe-undo" title="Undo (Ctrl+Z)">↩</button>
      <button class="fe-btn" id="fe-redo" title="Redo (Ctrl+Y)">↪</button>
      <button class="fe-btn" id="fe-zoom-out" title="Zoom out">−</button>
      <span class="fe-zoom" id="fe-zoom">100%</span>
      <button class="fe-btn" id="fe-zoom-in" title="Zoom in">＋</button>
      <button class="fe-btn" id="fe-fit" title="Zoom to fit (Shift+1)">⛶ Fit</button>
      <button class="fe-btn" id="fe-img" title="Add an image from your device to the selected card">🖼 Image</button>
      <button class="fe-btn" id="fe-snap" title="Save a named version">📌 Snapshot</button>
      <button class="fe-btn" id="fe-hist" title="Version history">🕘</button>
      <button class="fe-btn" id="fe-del" title="Delete selected (Del)">🗑</button>
    </div>
    ${referenceBanner('fe-banner')}
    <div class="fe-viewport" id="fe-viewport">
      <div class="fe-world" id="fe-world">
        <svg class="fe-edges" id="fe-edges" width="1" height="1"></svg>
      </div>
      <div class="fe-palette" id="fe-palette">
        ${NODE_TYPES.map((t) => `<button class="fe-pal-btn" data-add="${t.type}" title="${t.hint}"><span class="dot" style="background:${t.color}"></span><span class="txt">${t.label}</span></button>`).join('')}
      </div>
      <div class="fe-legend">${Object.entries(ROLE_META).map(([, m]) => `<span class="lg"><i style="background:${m.color}"></i>${m.label}</span>`).join('')}</div>
      <div class="fe-hint">drag empty = select · wheel = pan · Ctrl+wheel = zoom · double-tap a card = edit text · drag ◦ from a card edge = link</div>
    </div>`;
  document.body.appendChild(wrap);
  const viewport = wrap.querySelector('#fe-viewport');
  const world = wrap.querySelector('#fe-world');
  const svg = wrap.querySelector('#fe-edges');

  const toWorld = (sx, sy) => {
    const r = viewport.getBoundingClientRect();
    return { x: (sx - r.left - view.tx) / view.z, y: (sy - r.top - view.ty) / view.z };
  };
  const applyView = () => {
    world.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.z})`;
    wrap.querySelector('#fe-zoom').textContent = `${Math.round(view.z * 100)}%`;
  };

  // ── Persistence ──
  const setSaveState = (s, msg) => {
    saveState = s;
    const el = wrap.querySelector('#fe-save');
    if (!el) return;
    el.className = `fe-save ${s === 'saving' ? 'saving' : s === 'error' ? 'error' : ''}`;
    el.textContent = s === 'saved' ? 'Saved' : s === 'dirty' ? 'Unsaved…' : s === 'saving' ? 'Saving…' : (msg || 'Save failed');
  };
  // Single-flight saves: a Back-click while the debounced save is mid-network
  // must NOT run a second update with the same optimistic-lock timestamp
  // (that would false-alarm "someone else edited"). Overlapping requests
  // coalesce into one follow-up save with the refreshed savedAt.
  let saveBusy = null;
  let saveQueued = false;
  const doSave = () => {
    if (saveBusy) { saveQueued = true; return saveBusy; }
    saveBusy = (async () => {
      setSaveState('saving');
      const payload = {
        canvas: { nodes: canvas.nodes, edges: canvas.edges },
        name: wrap.querySelector('#fe-name')?.value.trim() || 'Untitled journey',
        updated_by: getCurrentProfile()?.full_name ?? 'admin',
        updated_at: new Date().toISOString(),
      };
      const { data, error: sErr } = await sb.from('flows').update(payload).eq('id', flowId).eq('updated_at', savedAt).select('updated_at');
      if (sErr) { setSaveState('error', 'Save failed'); showToast(`Save failed: ${sErr.message}`, 'error'); return; }
      if (!data?.length) {
        setSaveState('error', 'Edited elsewhere');
        showToast('Someone else edited this journey. Reload to see their version before saving again.', 'error');
        return;
      }
      savedAt = data[0].updated_at;
      setSaveState('saved');
    })().finally(() => {
      saveBusy = null;
      if (saveQueued) { saveQueued = false; doSave(); }
    });
    return saveBusy;
  };
  let templateBackedUp = false;
  const scheduleSave = () => {
    setSaveState('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 1500);
    // First edit of a seeded STANDARD journey this session → automatic safety
    // snapshot, so an intern can always get the original back.
    if (flow.is_template && !templateBackedUp) {
      templateBackedUp = true;
      sb.from('flow_snapshots').insert({
        flow_id: flowId,
        label: 'auto-backup (before edits)',
        canvas: flow.canvas ?? { nodes: [], edges: [] },
        saved_by: 'auto',
      }).then(({ error: e }) => { if (e) console.error('auto-backup failed:', e.message); });
    }
  };
  // Tab closed / app backgrounded within the debounce window → flush now.
  const flushOnHide = () => {
    if (document.visibilityState === 'hidden' && saveState === 'dirty') {
      clearTimeout(saveTimer);
      doSave();
    }
  };
  document.addEventListener('visibilitychange', flushOnHide);

  // ── Undo/redo ──
  const snapshot = () => JSON.stringify({ nodes: canvas.nodes, edges: canvas.edges });
  const pushUndo = () => {
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
    redoStack.length = 0;
  };
  const restore = (json) => {
    const c = JSON.parse(json);
    canvas.nodes = c.nodes;
    canvas.edges = c.edges;
    sel.clear(); selEdge = null;
    renderAll();
    scheduleSave();
  };
  const undo = () => { if (!undoStack.length) return; commitEdit(); redoStack.push(snapshot()); restore(undoStack.pop()); };
  const redo = () => { if (!redoStack.length) return; commitEdit(); undoStack.push(snapshot()); restore(redoStack.pop()); };

  // ── Node/edge lookups ──
  const nodeById = (id) => canvas.nodes.find((n) => n.id === id);
  const nodeEl = (id) => world.querySelector(`[data-node="${CSS.escape(String(id))}"]`);

  // ── Edge geometry ──
  /**
   * All four ports of a card, each carrying its OUTWARD normal.
   *
   * This used to offer only the right edge ("out") and the left edge ("inn"),
   * which silently assumed every link runs left to right. On the merged journey
   * most links run between swimlanes, so they travel mostly VERTICALLY, and the
   * assumption became visible: the line went up the page while the arrowhead
   * still pointed right. The marker was never wrong, the geometry was. The
   * normal is what edgePath uses to leave and enter along the correct axis.
   */
  const anchors = (n) => {
    const el = nodeEl(n.id);
    const h = el ? el.offsetHeight : 80;
    const w = n.w ?? 264;
    const cx = n.x + w / 2;
    const cy = n.y + h / 2;
    return {
      right: { x: n.x + w, y: cy, nx: 1, ny: 0 },
      left: { x: n.x, y: cy, nx: -1, ny: 0 },
      bottom: { x: cx, y: n.y + h, nx: 0, ny: 1 },
      top: { x: cx, y: n.y, nx: 0, ny: -1 },
      cx,
      cy,
      // Kept so the link-drag ghost and any older caller still work unchanged.
      out: { x: n.x + w, y: cy, nx: 1, ny: 0 },
      inn: { x: n.x, y: cy, nx: -1, ny: 0 },
    };
  };

  /**
   * Leave from the side that faces the target and arrive on the side that faces
   * the source. Whichever axis dominates wins, so a card directly below is
   * joined bottom to top rather than looped out to the right and back.
   */
  const portsFor = (from, to) => {
    const A = anchors(from);
    const B = anchors(to);
    const dx = B.cx - A.cx;
    const dy = B.cy - A.cy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? { a: A.right, b: B.left } : { a: A.left, b: B.right };
    }
    return dy >= 0 ? { a: A.bottom, b: B.top } : { a: A.top, b: B.bottom };
  };

  /**
   * Cubic curve whose control handles run along each port's normal, so the
   * tangent where the line MEETS the card is the direction the line is actually
   * travelling. The arrow marker is orient="auto-start-reverse", so once the
   * tangent is right the arrowhead aligns itself with no further work.
   */
  const edgePath = (a, b) => {
    const anx = a.nx ?? 1, any = a.ny ?? 0;
    const bnx = b.nx ?? -1, bny = b.ny ?? 0;
    const k = Math.max(38, Math.min(130, Math.hypot(b.x - a.x, b.y - a.y) * 0.42));
    // b's handle sits OUTSIDE b along its outward normal, so the curve arrives
    // pointing into the card rather than out of it.
    return `M ${a.x} ${a.y} C ${a.x + anx * k} ${a.y + any * k}, ${b.x + bnx * k} ${b.y + bny * k}, ${b.x} ${b.y}`;
  };

  // The SVG is sized and positioned to COVER the edges each render - a 1×1
  // svg with overflow:visible gets clipped by several engines, which showed
  // up as "I can't see any connecting lines at all".
  const ARROW_COLORS = { plain: '#45514A', yes: '#12925B', no: '#C0392B', warn: '#B45309', sel: '#0F8A5F' };
  const renderEdges = (temp = null) => {
    world.querySelectorAll('.fe-edge-label').forEach((el) => el.remove());
    const segs = [];
    for (const e of canvas.edges) {
      const from = nodeById(e.from); const to = nodeById(e.to);
      if (!from || !to) continue;
      const p = portsFor(from, to);
      segs.push({ e, a: p.a, b: p.b });
    }
    if (temp) segs.push({ e: null, a: temp.a, b: temp.b });
    if (!segs.length) { svg.innerHTML = ''; svg.setAttribute('width', '1'); svg.setAttribute('height', '1'); return; }

    const PAD = 220;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of segs) {
      minX = Math.min(minX, s.a.x, s.b.x); maxX = Math.max(maxX, s.a.x, s.b.x);
      minY = Math.min(minY, s.a.y, s.b.y); maxY = Math.max(maxY, s.a.y, s.b.y);
    }
    const ox = Math.floor(minX - PAD), oy = Math.floor(minY - PAD);
    svg.style.left = `${ox}px`; svg.style.top = `${oy}px`;
    svg.setAttribute('width', String(Math.ceil(maxX - minX + 2 * PAD)));
    svg.setAttribute('height', String(Math.ceil(maxY - minY + 2 * PAD)));
    // Carry nx/ny through the shift into SVG space. Spreading rather than
    // rebuilding {x,y}: dropping the normals here silently reverted every edge
    // to the old horizontal-only curve, arrowheads and all.
    const S = (p) => ({ ...p, x: p.x - ox, y: p.y - oy });

    // Edge color comes from the theme; arrowheads get a marker per class so
    // they always match their line (no context-stroke compat gamble).
    const rootStyle = getComputedStyle(document.documentElement);
    const edgeColor = rootStyle.getPropertyValue('--canvas-edge').trim() || ARROW_COLORS.plain;
    const selColor = rootStyle.getPropertyValue('--primary').trim() || ARROW_COLORS.sel;
    let defs = '<defs>';
    for (const [k, color] of Object.entries({ ...ARROW_COLORS, plain: edgeColor, sel: selColor })) {
      defs += `<marker id="fe-arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
        <path d="M 0 1 L 9 5 L 0 9 z" fill="${color}"></path></marker>`;
    }
    defs += '</defs>';

    let paths = '';
    for (const s of segs) {
      const d = edgePath(S(s.a), S(s.b));
      if (!s.e) { // temp ghost while dragging a link
        paths += `<path class="line temp" style="stroke-dasharray:6 5" d="${d}" marker-end="url(#fe-arrow-plain)"></path>`;
        continue;
      }
      const e = s.e;
      const kind = selEdge === e.id ? 'sel' : (edgeClass(e.label) || 'plain');
      const cls = `line ${edgeClass(e.label)} ${selEdge === e.id ? 'sel' : ''}`;
      paths += `<path class="hit" data-edge="${escapeHtml(e.id)}" d="${d}"></path><path class="${cls}" d="${d}" marker-end="url(#fe-arrow-${kind})"></path>`;
      // The label belongs ON the curve, not on the straight chord between the
      // two ports. For a cubic those are the same point only when the curve is
      // a straight line; on the vertical cross-lane links they are far apart,
      // which left labels floating in empty space beside their own edge.
      // Bezier at t = 0.5 is (P0 + 3*C1 + 3*C2 + P3) / 8.
      const anx = s.a.nx ?? 1, any = s.a.ny ?? 0;
      const bnx = s.b.nx ?? -1, bny = s.b.ny ?? 0;
      const kk = Math.max(38, Math.min(130, Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) * 0.42));
      const mx = (s.a.x + 3 * (s.a.x + anx * kk) + 3 * (s.b.x + bnx * kk) + s.b.x) / 8;
      const my = (s.a.y + 3 * (s.a.y + any * kk) + 3 * (s.b.y + bny * kk) + s.b.y) / 8;
      const lbl = document.createElement('div');
      lbl.className = `fe-edge-label ${selEdge === e.id ? 'sel' : ''}`;
      lbl.style.left = `${mx}px`; lbl.style.top = `${my}px`;
      lbl.dataset.edgeLabel = e.id;
      lbl.textContent = e.label ?? '';
      world.appendChild(lbl);
    }
    svg.innerHTML = defs + paths;
    // Selecting an edge must NOT re-render when it is already the selection -
    // a re-render replaces the element mid-double-click and the label editor
    // could never open. stopPropagation also skips the viewport's commitEdit
    // guard, so commit any active text edit here first.
    const selectEdge = (id) => {
      commitEdit();
      if (selEdge === id) return;
      sel.clear(); selEdge = id;
      renderAll();
    };
    svg.querySelectorAll('.hit').forEach((p) => {
      p.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); selectEdge(p.dataset.edge); });
      p.addEventListener('dblclick', (ev) => { ev.stopPropagation(); editEdgeLabel(p.dataset.edge); });
    });
    world.querySelectorAll('[data-edge-label]').forEach((l) => {
      l.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); selectEdge(l.dataset.edgeLabel); });
      l.addEventListener('dblclick', (ev) => { ev.stopPropagation(); editEdgeLabel(l.dataset.edgeLabel); });
    });
  };

  const editEdgeLabel = (edgeId) => {
    const e = canvas.edges.find((x) => x.id === edgeId);
    if (!e) return;
    const label = prompt('Edge label (the trigger/condition, e.g. “taps Accept”, “10 min silence”):', e.label ?? '');
    if (label === null) return;
    pushUndo();
    e.label = label.trim();
    renderEdges();
    scheduleSave();
  };

  // ── Node rendering ──
  const lint = () => {
    const hasIn = new Set(canvas.edges.map((e) => e.to));
    const hasOut = new Set(canvas.edges.map((e) => e.from));
    const res = {};
    for (const n of canvas.nodes) {
      if (n.type === 'note') continue;
      if (!hasIn.has(n.id) && n.type !== 'trigger') res[n.id] = 'orphan';
      else if (!hasOut.has(n.id) && !hasIn.has(n.id)) res[n.id] = 'orphan';
    }
    return res;
  };

  const renderNodes = () => {
    world.querySelectorAll('.fe-node').forEach((el) => el.remove());
    const lints = lint();
    for (const n of canvas.nodes) {
      // Lane and stage headers are chrome, not cards: they are not draggable,
      // not linkable and not editable, so they render on their own path.
      if (n.isLaneHeader || n.isStageHeader) {
        const h = document.createElement('div');
        h.className = n.isLaneHeader ? 'fe-node fe-lane-head' : 'fe-node fe-stage-head';
        h.dataset.node = n.id;
        h.style.left = `${n.x}px`; h.style.top = `${n.y}px`; h.style.width = `${n.w ?? 220}px`;
        h.textContent = n.title ?? '';
        world.appendChild(h);
        continue;
      }

      const el = document.createElement('div');
      el.className = `fe-node type-${n.type} ${sel.has(n.id) ? 'sel' : ''} ${n.messageKey ? 'bound' : ''}`;
      el.dataset.node = n.id;
      el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; el.style.width = `${n.w ?? 264}px`;
      const role = ROLE_META[n.role] ?? ROLE_META.system;

      // A card bound to a registry key shows the wording that is LIVE, and
      // links to it. An unbound card is documentation and says so, because the
      // difference between "this changes what patients read" and "this is a
      // drawing" is the single most important thing on this page.
      const live = n.messageKey ? LIVE_COPY.get(n.messageKey) : null;
      const bodyHtml = n.messageKey
        ? (live === undefined
          ? `<div class="fe-live-load">loading the live wording…</div>`
          : live === null
            ? `<div class="fe-live-gone">⚠️ <b>${escapeHtml(n.messageKey)}</b> no longer exists in the message registry. This card is stale.</div>`
            : `<div class="fe-live">${renderWa(live)}</div>`)
        : sanitizeHtml(n.body ?? '');

      el.innerHTML = `
        <div class="fe-node-head" data-insp="1">
          <span class="fe-role" style="background:${role.color}">${role.label}</span>
          ${n.channel && CHANNEL_META[n.channel] ? `<span class="fe-chan">${CHANNEL_META[n.channel]}</span>` : ''}
          ${lints[n.id] ? `<span class="fe-lint ${lints[n.id]}" title="${lints[n.id] === 'orphan' ? 'Nothing connects here - is this card reachable?' : ''}"></span>` : ''}
        </div>
        <div class="fe-node-title" data-field="title">${escapeHtml(n.title ?? '')}</div>
        ${n.messageKey ? '' : '<div class="fe-doconly" title="This card is a note. Editing it does not change any message.">documentation only</div>'}
        <div class="fe-node-body" ${n.messageKey ? '' : 'data-field="body"'}>${bodyHtml}</div>
        ${n.messageKey ? `
          <div class="fe-bound">
            <code>${escapeHtml(n.messageKey)}</code>
            <button class="fe-edit-copy" data-copy-key="${escapeHtml(n.messageKey)}">Edit wording</button>
          </div>` : ''}
        ${n.type === 'note' ? '' : '<div class="fe-port in" data-port="in" title="in"></div><div class="fe-port out" data-port="out" title="drag to link"></div>'}
        <div class="fe-resize" data-resize="1"></div>`;
      world.appendChild(el);
    }

    // One click from "this is the message I mean" to changing it.
    world.querySelectorAll('.fe-edit-copy').forEach((b) => {
      b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        navigate(`#copy/${b.dataset.copyKey}`);
      });
    });
    // Data-URI images resolve async and change card heights - re-path edges
    // once each finishes loading so anchors stay glued to card midlines.
    world.querySelectorAll('.fe-node-body img').forEach((img) => {
      if (!img.complete) img.addEventListener('load', () => renderEdges(), { once: true });
    });
  };
  const renderAll = () => { renderNodes(); renderEdges(); };

  // ── Fit view ──
  const fit = (animate = false) => {
    if (!canvas.nodes.length) { view.tx = 60; view.ty = 60; view.z = 1; applyView(); return; }
    const xs = canvas.nodes.map((n) => n.x); const ys = canvas.nodes.map((n) => n.y);
    const xe = canvas.nodes.map((n) => n.x + (n.w ?? 264)); const ye = canvas.nodes.map((n) => n.y + 140);
    const minX = Math.min(...xs) - 60; const minY = Math.min(...ys) - 60;
    const maxX = Math.max(...xe) + 60; const maxY = Math.max(...ye) + 80;
    const r = viewport.getBoundingClientRect();
    const z = clamp(Math.min(r.width / (maxX - minX), r.height / (maxY - minY)), 0.1, 1.4);
    const tx = (r.width - (maxX - minX) * z) / 2 - minX * z;
    const ty = (r.height - (maxY - minY) * z) / 2 - minY * z;
    if (animate) {
      world.style.transition = 'transform .22s ease-out';
      setTimeout(() => { world.style.transition = ''; }, 240);
    }
    view.z = z; view.tx = tx; view.ty = ty;
    applyView();
  };

  // ── Text editing ──
  const richbar = document.createElement('div');
  richbar.className = 'fe-richbar';
  richbar.style.display = 'none';
  richbar.innerHTML = `
    <button data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
    <button data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
    <button data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
    <button data-cmd="insertUnorderedList" title="Bullet list">☰</button>
    <button data-img="1" title="Insert image">🖼</button>`;
  document.body.appendChild(richbar);
  const imgInput = document.createElement('input');
  imgInput.type = 'file'; imgInput.accept = 'image/*'; imgInput.style.display = 'none';
  document.body.appendChild(imgInput);
  // 'editing' → insert at the caret; a node id → append to that card's body.
  let imgTarget = 'editing';

  const placeRichbar = () => {
    const s = window.getSelection();
    if (!editingEl || !s || !s.rangeCount) { richbar.style.display = 'none'; return; }
    const r = s.getRangeAt(0).getBoundingClientRect();
    const host = (r.width || r.height) ? r : editingEl.getBoundingClientRect();
    richbar.style.display = 'flex';
    richbar.style.left = `${clamp(host.left + host.width / 2 - 80, 8, window.innerWidth - 180)}px`;
    richbar.style.top = `${clamp(host.top - 42, 8, window.innerHeight - 44)}px`;
    richbar.querySelectorAll('[data-cmd]').forEach((b) => {
      try { b.classList.toggle('on', document.queryCommandState(b.dataset.cmd)); } catch {}
    });
  };
  richbar.addEventListener('pointerdown', (e) => e.preventDefault());
  richbar.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(b.dataset.cmd, false);
    placeRichbar();
  }));
  richbar.querySelector('[data-img]').addEventListener('click', () => { imgTarget = 'editing'; imgInput.click(); });
  imgInput.addEventListener('change', async () => {
    const file = imgInput.files?.[0];
    imgInput.value = '';
    if (!file) return;
    const dataUrl = await downscaleImage(file, 640);
    if (!dataUrl) { showToast('Could not read that image file', 'error'); return; }
    if (imgTarget === 'editing') {
      if (editingEl) document.execCommand('insertHTML', false, `<img src="${dataUrl}">`);
      return;
    }
    // Append to the selected card - no edit mode needed.
    const n = nodeById(imgTarget);
    imgTarget = 'editing';
    if (!n) return;
    pushUndo();
    n.body = sanitizeHtml(`${n.body ?? ''}<img src="${dataUrl}">`);
    renderAll();
    scheduleSave();
    showToast('Image added to the card 🖼', 'success');
  });
  document.addEventListener('selectionchange', () => { if (editingEl) placeRichbar(); });

  const startEdit = (el, nodeId, field) => {
    if (editingEl) commitEdit();
    editingEl = el;
    el.contentEditable = field === 'title' ? 'plaintext-only' : 'true';
    el.classList.add('editing');
    el.dataset.editNode = nodeId;
    el.focus();
    // caret at end
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    if (field === 'body') placeRichbar();
  };
  const commitEdit = () => {
    if (!editingEl) return;
    const el = editingEl;
    editingEl = null;
    richbar.style.display = 'none';
    const n = nodeById(el.dataset.editNode);
    el.contentEditable = 'false';
    el.classList.remove('editing');
    if (!n) return;
    const field = el.dataset.field;
    const val = field === 'title' ? el.textContent.trim() : sanitizeHtml(el.innerHTML);
    if ((n[field] ?? '') !== val) {
      pushUndo();
      n[field] = val;
      scheduleSave();
    }
    renderAll();
  };

  const downscaleImage = (file, maxDim) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });

  // Paste: text stays plain-ish, images downscale.
  wrap.addEventListener('paste', async (e) => {
    if (!editingEl) return;
    e.preventDefault();
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    if (item) {
      const dataUrl = await downscaleImage(item.getAsFile(), 640);
      if (dataUrl) document.execCommand('insertHTML', false, `<img src="${dataUrl}">`);
      return;
    }
    const html = e.clipboardData?.getData('text/html');
    if (html) document.execCommand('insertHTML', false, sanitizeHtml(html));
    else document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
  });

  // ── Inspector (role/channel picker) ──
  let inspector = null;
  const closeInspector = () => { inspector?.remove(); inspector = null; };
  const openInspector = (nodeId, anchor) => {
    closeInspector();
    const n = nodeById(nodeId);
    if (!n) return;
    inspector = document.createElement('div');
    inspector.className = 'fe-inspector';
    inspector.innerHTML = `
      <div class="fe-insp-row">
        <div><label>Who receives</label>
          <select data-k="role">${Object.entries(ROLE_META).map(([k, m]) => `<option value="${k}" ${n.role === k ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
        </div>
        <div><label>How</label>
          <select data-k="channel"><option value="">None</option>${Object.entries(CHANNEL_META).map(([k, v]) => `<option value="${k}" ${n.channel === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
      </div>
      <label>Card type</label>
      <select data-k="type">${NODE_TYPES.map((t) => `<option value="${t.type}" ${n.type === t.type ? 'selected' : ''}>${t.label}</option>`).join('')}</select>`;
    document.body.appendChild(inspector);
    const r = anchor.getBoundingClientRect();
    inspector.style.left = `${clamp(r.left, 8, window.innerWidth - 266)}px`;
    inspector.style.top = `${clamp(r.bottom + 6, 8, window.innerHeight - 190)}px`;
    inspector.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => {
      pushUndo();
      n[s.dataset.k] = s.value || null;
      renderAll();
      scheduleSave();
    }));
  };

  // ── Adding nodes ──
  const addNode = (type) => {
    pushUndo();
    const r = viewport.getBoundingClientRect();
    const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    const n = {
      id: uid(), type, x: snap(c.x - 132), y: snap(c.y - 50), w: 264,
      role: type === 'trigger' ? 'team' : type === 'note' ? 'system' : 'patient',
      title: type === 'trigger' ? 'When…' : type === 'decision' ? 'Branch?' : type === 'note' ? 'Note' : 'New message',
      body: '', channel: null,
    };
    canvas.nodes.push(n);
    sel.clear(); sel.add(n.id); selEdge = null;
    renderAll();
    scheduleSave();
  };
  wrap.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => addNode(b.dataset.add)));

  // ── Delete selection ──
  const deleteSelection = () => {
    if (!sel.size && !selEdge) return;
    pushUndo();
    if (selEdge) canvas.edges = canvas.edges.filter((e) => e.id !== selEdge);
    if (sel.size) {
      canvas.nodes = canvas.nodes.filter((n) => !sel.has(n.id));
      canvas.edges = canvas.edges.filter((e) => !sel.has(e.from) && !sel.has(e.to));
    }
    sel.clear(); selEdge = null;
    closeInspector();
    renderAll();
    scheduleSave();
  };

  // ── Pointer machinery ──
  const pointers = new Map(); // pointerId → {x, y}
  let gesture = null; // {kind: 'pan'|'drag'|'marquee'|'edge'|'resize'|'pinch', ...}
  let spaceDown = false;

  const startDragNodes = (startWorld) => {
    const moved = [...sel].map((id) => { const n = nodeById(id); return { n, ox: n.x, oy: n.y }; });
    return { kind: 'drag', startWorld, moved, before: snapshot(), didMove: false };
  };

  // Per-kind cleanup + commit for a gesture that is ending OR being hijacked
  // (second touch → pinch). Without this, a pinch-takeover leaked the marquee
  // div, stuck the grabbing cursor, and dropped mid-drag moves from undo/save.
  const finishGesture = (g) => {
    viewport.classList.remove('panning');
    if (!g) return;
    if (g.kind === 'marquee') { g.el.remove(); return; }
    if (g.kind === 'drag') {
      if (g.didMove) {
        undoStack.push(g.before);
        if (undoStack.length > UNDO_DEPTH) undoStack.shift();
        redoStack.length = 0;
        renderEdges();
        scheduleSave();
      }
      return;
    }
    if (g.kind === 'resize') {
      undoStack.push(g.before);
      redoStack.length = 0;
      renderAll();
      scheduleSave();
      return;
    }
    if (g.kind === 'edge') {
      svg.querySelector('.temp')?.remove();
      world.querySelectorAll('.fe-port.in').forEach((p) => p.classList.remove('hot'));
    }
  };

  viewport.addEventListener('pointerdown', (e) => {
    // Palette/legend/hint live INSIDE the viewport - a gesture must never
    // start there (setPointerCapture would steal their click events).
    if (e.target.closest('.fe-palette, .fe-legend, .fe-hint')) return;
    if (editingEl && !e.target.closest('.fe-node-body.editing, .fe-node-title.editing')) commitEdit();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      // pinch start - finalize whatever the first finger was doing.
      finishGesture(gesture);
      const pts = [...pointers.values()];
      gesture = {
        kind: 'pinch',
        d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        z0: view.z,
        c0: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
        t0: { tx: view.tx, ty: view.ty },
      };
      return;
    }

    const nodeElHit = e.target.closest('.fe-node');
    const port = e.target.closest('.fe-port');
    const resize = e.target.closest('.fe-resize');

    if (port && nodeElHit && port.dataset.port === 'out') {
      e.stopPropagation();
      viewport.setPointerCapture(e.pointerId);
      gesture = { kind: 'edge', fromId: nodeElHit.dataset.node, cur: toWorld(e.clientX, e.clientY) };
      renderTempEdge(gesture);
      return;
    }
    if (resize && nodeElHit) {
      viewport.setPointerCapture(e.pointerId);
      const n = nodeById(nodeElHit.dataset.node);
      gesture = { kind: 'resize', n, ow: n.w ?? 264, sx: e.clientX, before: snapshot() };
      return;
    }
    if (nodeElHit) {
      const id = nodeElHit.dataset.node;
      if (e.shiftKey) { sel.has(id) ? sel.delete(id) : sel.add(id); selEdge = null; renderAll(); return; }
      if (!sel.has(id)) { sel.clear(); sel.add(id); selEdge = null; renderAll(); }
      if (e.target.closest('[data-insp]')) openInspector(id, e.target.closest('.fe-node-head'));
      else closeInspector();
      if (e.altKey) { // duplicate-drag
        pushUndo();
        const clones = [...sel].map((sid) => { const src = nodeById(sid); return { ...JSON.parse(JSON.stringify(src)), id: uid(), x: src.x + 20, y: src.y + 20 }; });
        canvas.nodes.push(...clones);
        sel.clear(); clones.forEach((c) => sel.add(c.id));
        renderAll();
      }
      viewport.setPointerCapture(e.pointerId);
      gesture = startDragNodes(toWorld(e.clientX, e.clientY));
      return;
    }

    closeInspector();
    // empty canvas: pan (space/middle/right/touch) or marquee (mouse left)
    const isTouch = e.pointerType === 'touch';
    if (spaceDown || e.button === 1 || e.button === 2 || isTouch) {
      viewport.setPointerCapture(e.pointerId);
      gesture = { kind: 'pan', sx: e.clientX, sy: e.clientY, t0: { tx: view.tx, ty: view.ty } };
      viewport.classList.add('panning');
    } else {
      viewport.setPointerCapture(e.pointerId);
      const m = document.createElement('div');
      m.className = 'fe-marquee';
      viewport.appendChild(m);
      gesture = { kind: 'marquee', sx: e.clientX, sy: e.clientY, el: m, add: e.shiftKey };
      if (!e.shiftKey) { sel.clear(); selEdge = null; renderAll(); }
    }
  });

  const renderTempEdge = (g) => {
    const from = nodeById(g.fromId);
    if (!from || !g.cur) return;
    renderEdges({ a: anchors(from).out, b: g.cur });
  };

  viewport.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;

    if (gesture.kind === 'pinch' && pointers.size === 2) {
      const pts = [...pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const c = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const r = viewport.getBoundingClientRect();
      const z = clamp(gesture.z0 * (d / gesture.d0), 0.1, 4);
      // keep the pinch centre stationary in world space, then apply centre pan
      const wx = (gesture.c0.x - r.left - gesture.t0.tx) / gesture.z0;
      const wy = (gesture.c0.y - r.top - gesture.t0.ty) / gesture.z0;
      view.z = z;
      view.tx = c.x - r.left - wx * z;
      view.ty = c.y - r.top - wy * z;
      applyView();
      return;
    }
    if (gesture.kind === 'pan') {
      view.tx = gesture.t0.tx + (e.clientX - gesture.sx);
      view.ty = gesture.t0.ty + (e.clientY - gesture.sy);
      applyView();
      return;
    }
    if (gesture.kind === 'marquee') {
      const r = viewport.getBoundingClientRect();
      const x1 = Math.min(gesture.sx, e.clientX) - r.left; const y1 = Math.min(gesture.sy, e.clientY) - r.top;
      const x2 = Math.max(gesture.sx, e.clientX) - r.left; const y2 = Math.max(gesture.sy, e.clientY) - r.top;
      Object.assign(gesture.el.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
      const a = toWorld(Math.min(gesture.sx, e.clientX), Math.min(gesture.sy, e.clientY));
      const b = toWorld(Math.max(gesture.sx, e.clientX), Math.max(gesture.sy, e.clientY));
      for (const n of canvas.nodes) {
        // Lane and stage headers are furniture. CSS pointer-events keeps them
        // out of click and drag, but a marquee is a geometry test and would
        // happily scoop them up, after which one Delete would strip the labels
        // off the whole map.
        if (n.isLaneHeader || n.isStageHeader) continue;
        const el = nodeEl(n.id);
        const h = el ? el.offsetHeight : 100;
        const hit = n.x < b.x && n.x + (n.w ?? 264) > a.x && n.y < b.y && n.y + h > a.y;
        if (hit) sel.add(n.id); else if (!gesture.add) sel.delete(n.id);
        el?.classList.toggle('sel', sel.has(n.id));
      }
      return;
    }
    if (gesture.kind === 'drag') {
      const w = toWorld(e.clientX, e.clientY);
      const dx = w.x - gesture.startWorld.x; const dy = w.y - gesture.startWorld.y;
      // Below the threshold NOTHING moves - a plain click on a Ctrl-placed
      // off-grid node must not snap it back to the grid.
      if (!gesture.didMove) {
        if (Math.abs(dx) + Math.abs(dy) <= 3) return;
        gesture.didMove = true;
        closeInspector();
      }
      for (const m of gesture.moved) {
        m.n.x = e.ctrlKey ? m.ox + dx : snap(m.ox + dx);
        m.n.y = e.ctrlKey ? m.oy + dy : snap(m.oy + dy);
        const el = nodeEl(m.n.id);
        if (el) { el.style.left = `${m.n.x}px`; el.style.top = `${m.n.y}px`; }
      }
      renderEdges();
      return;
    }
    if (gesture.kind === 'resize') {
      gesture.n.w = clamp(snap(gesture.ow + (e.clientX - gesture.sx) / view.z), 200, 480);
      const el = nodeEl(gesture.n.id);
      if (el) el.style.width = `${gesture.n.w}px`;
      renderEdges();
      return;
    }
    if (gesture.kind === 'edge') {
      gesture.cur = toWorld(e.clientX, e.clientY);
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.fe-node');
      world.querySelectorAll('.fe-port.in').forEach((p) => p.classList.remove('hot'));
      if (over && over.dataset.node !== gesture.fromId) over.querySelector('.fe-port.in')?.classList.add('hot');
      gesture.overId = over && over.dataset.node !== gesture.fromId ? over.dataset.node : null;
      renderTempEdge(gesture);
    }
  });

  const endGesture = (e) => {
    pointers.delete(e.pointerId);
    if (!gesture) return;
    const g = gesture;
    if (g.kind === 'pinch') { if (pointers.size < 2) { gesture = null; viewport.classList.remove('panning'); } return; }
    gesture = null;
    if (g.kind === 'edge') {
      finishGesture(g); // temp path + hot-port cleanup
      // The source node may have been deleted mid-draw - never persist a
      // dangling edge.
      if (!nodeById(g.fromId)) return;
      if (g.overId && nodeById(g.overId)) {
        if (!canvas.edges.some((x) => x.from === g.fromId && x.to === g.overId)) {
          pushUndo();
          canvas.edges.push({ id: uid(), from: g.fromId, to: g.overId, label: '' });
          renderEdges();
          scheduleSave();
        }
      } else if (g.cur) {
        // drop on empty canvas → quick-create a connected message card
        pushUndo();
        const n = { id: uid(), type: 'message', x: snap(g.cur.x), y: snap(g.cur.y - 40), w: 264, role: 'patient', title: 'New message', body: '', channel: null };
        canvas.nodes.push(n);
        canvas.edges.push({ id: uid(), from: g.fromId, to: n.id, label: '' });
        sel.clear(); sel.add(n.id);
        renderAll();
        scheduleSave();
      }
      return;
    }
    finishGesture(g);
  };
  viewport.addEventListener('pointerup', endGesture);
  viewport.addEventListener('pointercancel', endGesture);
  viewport.addEventListener('contextmenu', (e) => e.preventDefault());

  // Double-click/tap → edit text
  viewport.addEventListener('dblclick', (e) => {
    const field = e.target.closest('[data-field]');
    const nEl = e.target.closest('.fe-node');
    if (field && nEl) {
      // Already editing this field → let the native double-click select the
      // word (re-entering startEdit would commit + re-render + detach it).
      if (field.classList.contains('editing')) return;
      e.preventDefault();
      startEdit(field, nEl.dataset.node, field.dataset.field);
    }
  });
  // Keep pointer events inside an active editor from starting drags.
  viewport.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.editing')) e.stopPropagation();
  }, { capture: true });

  // Wheel: pan; ctrl/cmd+wheel: zoom to cursor (catches trackpad pinch too)
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = viewport.getBoundingClientRect();
      const z = clamp(view.z * Math.exp(-e.deltaY * 0.0022), 0.1, 4);
      const sx = e.clientX - r.left; const sy = e.clientY - r.top;
      view.tx = sx - ((sx - view.tx) / view.z) * z;
      view.ty = sy - ((sy - view.ty) / view.z) * z;
      view.z = z;
    } else if (e.shiftKey) {
      view.tx -= e.deltaY;
    } else {
      view.tx -= e.deltaX;
      view.ty -= e.deltaY;
    }
    applyView();
  }, { passive: false });

  // ── Keyboard ──
  const onKey = (e) => {
    if (document.activeElement?.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '')) {
      if (e.key === 'Escape') { commitEdit(); document.activeElement.blur?.(); }
      return;
    }
    if (e.key === ' ') { spaceDown = true; return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); sel.clear(); canvas.nodes.forEach((n) => sel.add(n.id)); renderAll(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (!sel.size) return;
      pushUndo();
      const clones = [...sel].map((sid) => { const src = nodeById(sid); return { ...JSON.parse(JSON.stringify(src)), id: uid(), x: src.x + 20, y: src.y + 20 }; });
      canvas.nodes.push(...clones);
      sel.clear(); clones.forEach((c) => sel.add(c.id));
      renderAll(); scheduleSave();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); view.z = 1; applyView(); return; }
    if (e.shiftKey && e.key === '!') { fit(true); return; } // Shift+1
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (gesture) return; // deleting mid-drag/edge-draw would corrupt the gesture's targets
      deleteSelection();
      return;
    }
    if (e.key === 'Escape') { sel.clear(); selEdge = null; closeInspector(); renderAll(); return; }
    if (e.key.startsWith('Arrow') && sel.size) {
      e.preventDefault();
      const step = e.shiftKey ? 50 : GRID;
      pushUndo();
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      sel.forEach((id) => { const n = nodeById(id); n.x += dx; n.y += dy; });
      renderAll(); scheduleSave();
    }
  };
  const onKeyUp = (e) => { if (e.key === ' ') spaceDown = false; };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);

  // ── Topbar ──
  wrap.querySelector('#fe-back').addEventListener('click', async () => {
    commitEdit();
    if (saveState !== 'saved') { clearTimeout(saveTimer); await doSave(); }
    navigate(listRoute());
  });
  wrap.querySelector('#fe-name').addEventListener('change', scheduleSave);
  wrap.querySelector('#fe-undo').addEventListener('click', undo);
  wrap.querySelector('#fe-redo').addEventListener('click', redo);
  wrap.querySelector('#fe-del').addEventListener('click', deleteSelection);
  wrap.querySelector('#fe-fit').addEventListener('click', () => fit(true));
  wrap.querySelector('#fe-zoom-in').addEventListener('click', () => { view.z = clamp(view.z * 1.25, 0.1, 4); applyView(); });
  wrap.querySelector('#fe-zoom-out').addEventListener('click', () => { view.z = clamp(view.z / 1.25, 0.1, 4); applyView(); });
  wrap.querySelector('#fe-img').addEventListener('click', () => {
    commitEdit(); // an in-progress text edit would silently revert the append
    if (sel.size !== 1) {
      showToast('Select ONE card first, then add the image', 'info');
      return;
    }
    imgTarget = [...sel][0];
    imgInput.click();
  });
  wrap.querySelector('#fe-snap').addEventListener('click', async () => {
    const label = prompt('Name this version (e.g. "before the palliative redraw"):', '');
    if (label === null) return;
    const { error: snapErr } = await sb.from('flow_snapshots').insert({
      flow_id: flowId, label: label.trim() || 'snapshot',
      canvas: { nodes: canvas.nodes, edges: canvas.edges },
      saved_by: getCurrentProfile()?.full_name ?? 'admin',
    });
    if (snapErr) return showToast(snapErr.message, 'error');
    showToast('Version saved 📌', 'success');
  });
  wrap.querySelector('#fe-hist').addEventListener('click', async () => {
    document.querySelector('.fe-drawer')?.remove();
    const { data: snaps } = await sb.from('flow_snapshots')
      .select('id, label, saved_by, created_at')
      .eq('flow_id', flowId)
      .order('created_at', { ascending: false })
      .limit(30);
    const drawer = document.createElement('div');
    drawer.className = 'fe-drawer';
    drawer.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;font-size:15px">Version history</h3>
        <button class="fe-btn" data-close="1">✕</button>
      </div>
      ${(snaps ?? []).length === 0 ? '<p style="font-size:13px;color:var(--ink-soft,#777)">No saved versions yet - use 📌 Snapshot before big changes.</p>' : ''}
      ${(snaps ?? []).map((s) => `
        <div class="fe-snap">
          <div><b>${escapeHtml(s.label ?? 'snapshot')}</b><br><span style="font-size:11px;color:var(--ink-soft,#888)">${escapeHtml(s.saved_by ?? '')} · ${formatRelativeTime(s.created_at)}</span></div>
          <button class="fe-btn" data-restore="${s.id}">Restore</button>
        </div>`).join('')}`;
    document.body.appendChild(drawer);
    drawer.querySelector('[data-close]').addEventListener('click', () => drawer.remove());
    drawer.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
      const { data: snapRow, error: rErr } = await sb.from('flow_snapshots').select('canvas').eq('id', b.dataset.restore).single();
      if (rErr) return showToast(rErr.message, 'error');
      pushUndo();
      const restored = sanitizeCanvas(snapRow.canvas);
      canvas.nodes = restored.nodes;
      canvas.edges = restored.edges;
      sel.clear(); selEdge = null;
      renderAll();
      scheduleSave();
      drawer.remove();
      showToast('Version restored (undo with Ctrl+Z)', 'success');
    }));
  });

  // ── Boot ──
  renderAll();
  fit();
  // Node heights affect edge anchors - re-path once layout settles.
  requestAnimationFrame(() => { renderEdges(); });

  // The live wording arrives after the map does, on purpose. A bound card shows
  // "loading the live wording" for a moment rather than the whole canvas
  // blocking on one list_copy call, and a failure leaves a readable map instead
  // of an empty page. Cards grow when the real body lands, so re-path the edges.
  if (canvas.nodes.some((n) => n.messageKey)) {
    loadLiveCopy().then(() => {
      renderAll();
      requestAnimationFrame(() => { renderEdges(); });
    });
  }

  editorCleanup = () => {
    // Any navigation away (sidebar click, browser Back, typed hash) must not
    // drop the debounced edits - flush before teardown. doSave closes over
    // canvas + the (soon detached, still readable) wrap DOM.
    commitEdit();
    if (saveState === 'dirty' || saveState === 'error') {
      clearTimeout(saveTimer);
      doSave();
    }
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('visibilitychange', flushOnHide);
    clearTimeout(saveTimer);
    richbar.remove();
    imgInput.remove();
    closeInspector();
    document.querySelector('.fe-drawer')?.remove();
    wrap.remove();
  };
}

// ============================================================
// Carcinome Home Care - #forms
// The three REAL WhatsApp in-chat forms (Meta Flows): consent,
// session completion report, feedback. Their screens live in this
// repo at wa/flows/*.json and are read here at runtime; the Meta
// id each one is bound to lives in settings.flow_ids and, until
// this page existed, could only be written by scripts/bootstrap_wa.mjs.
// Replies land in wa-webhook/handlers/flows.ts as nfm_reply.
// Nothing here is the Journeys canvas - these are the live forms.
// ============================================================

import { CONFIG } from '../config.js';
import { getSupabase } from '../supabase.js';
import { getCurrentProfile } from '../auth.js';
import { showToast } from '../components/toast.js';
import { escapeHtml, formatDateTime, capitalize } from '../utils/formatters.js';
import { navigate } from '../router.js';

// ---- page-scoped styles (injected once, id-guarded) ----
const STYLE_ID = 'forms-page-style';
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .wf-intro { font: var(--t-sm); color: var(--ink-3); max-width: 78ch; margin-bottom: var(--s5); }
    .wf-grid { display: grid; grid-template-columns: minmax(0, 1fr) 350px; gap: var(--s5); align-items: start; }
    .wf-col { display: flex; flex-direction: column; gap: var(--s5); min-width: 0; }
    .wf-side { position: sticky; top: var(--s5); }
    .wf-paths { display: flex; flex-direction: column; gap: 7px; margin-top: var(--s4); }
    .wf-path { display: flex; gap: 9px; align-items: baseline; font: var(--t-xs); color: var(--ink-3); }
    .wf-path .wf-path-k { flex: none; width: 92px; font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-4); }
    .wf-path code { font-family: var(--font-mono); font-size: 11.5px; color: var(--ink-2); background: var(--bg-sunken); border: 1px solid var(--line); border-radius: var(--r-xs); padding: 2px 6px; overflow-wrap: anywhere; }
    .wf-idrow { display: flex; gap: var(--s2); align-items: flex-start; }
    .wf-idrow .form-input { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 12.5px; }
    .wf-file { font: var(--t-mono); font-size: 11.5px; color: var(--ink-3); }

    /* ---- phone-shaped read-only preview ---- */
    .wf-phone { background: var(--chat-bg, var(--bg-sunken)); border: 1px solid var(--line-strong, var(--line)); border-radius: 24px; padding: 12px 10px 16px; box-shadow: var(--sh-2); }
    .wf-phone-bar { display: flex; align-items: center; justify-content: center; gap: 7px; padding-bottom: 10px; font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-4); }
    .wf-phone-bar::before, .wf-phone-bar::after { content: ""; flex: 1; height: 1px; background: var(--line); }
    .wf-screen { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; margin-bottom: 10px; }
    .wf-screen:last-child { margin-bottom: 0; }
    .wf-screen-bar { display: flex; align-items: center; gap: 7px; padding: 8px 11px; background: var(--bg-sunken); border-bottom: 1px solid var(--line); }
    .wf-screen-step { font: var(--t-mono); font-size: 10.5px; color: var(--ink-4); flex: none; }
    .wf-screen-title { font: var(--t-body-strong); font-size: 12.5px; color: var(--ink); overflow-wrap: anywhere; }
    .wf-screen-flag { margin-left: auto; flex: none; font: var(--t-mono-label); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ok); }
    .wf-screen-body { padding: 12px 13px; display: flex; flex-direction: column; gap: 11px; }
    .wf-heading { font: 700 15px/1.3 var(--font-display); color: var(--ink); }
    .wf-subheading { font: var(--t-body-strong); font-size: 13px; color: var(--ink); }
    /* pre-wrap, because the screens carry their own line breaks and indented
       second lines (the Hindi line, then the English one). Collapsing that
       whitespace made the preview read as one run-on paragraph, which is not
       what the family sees. */
    .wf-bodytext { font: var(--t-sm); font-size: 12.5px; line-height: 1.55; color: var(--ink-2); overflow-wrap: anywhere; white-space: pre-wrap; }
    .wf-caption { font: var(--t-xs); color: var(--ink-3); }
    .wf-field { display: block; }
    .wf-label { display: block; font: var(--t-xs); font-weight: 700; color: var(--ink-2); margin-bottom: 4px; }
    .wf-req { color: var(--danger); margin-left: 3px; }
    .wf-input { display: flex; align-items: center; min-height: 32px; padding: 7px 10px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg-sunken); font: var(--t-xs); color: var(--ink-4); font-style: italic; }
    .wf-input.tall { min-height: 52px; align-items: flex-start; }
    .wf-input.select::after { content: "\\25BE"; margin-left: auto; font-style: normal; color: var(--ink-3); }
    .wf-helper { font: var(--t-xs); font-size: 10.5px; color: var(--ink-4); margin-top: 4px; overflow-wrap: anywhere; }
    .wf-opt { display: flex; align-items: flex-start; gap: 8px; font: var(--t-xs); color: var(--ink-2); padding: 3px 0; }
    .wf-mark { flex: none; width: 13px; height: 13px; margin-top: 1px; border: 1.5px solid var(--ink-4); background: var(--surface); }
    .wf-mark.round { border-radius: 50%; }
    .wf-mark.square { border-radius: 3px; }
    .wf-mark.on { border-color: var(--primary); background: var(--primary); box-shadow: inset 0 0 0 2px var(--surface); }
    .wf-default { font: var(--t-xs); font-size: 10px; color: var(--ink-4); margin-left: 5px; }
    .wf-optin { display: flex; align-items: flex-start; gap: 8px; font: var(--t-xs); line-height: 1.5; color: var(--ink-2); overflow-wrap: anywhere; }
    .wf-cta { display: block; width: 100%; text-align: center; padding: 9px 12px; border-radius: var(--r-pill, 999px); background: var(--primary); color: var(--on-primary, #fff); font: var(--t-body-strong); font-size: 12.5px; }
    .wf-cta-note { font: var(--t-xs); font-size: 10.5px; color: var(--ink-4); text-align: center; margin-top: 5px; }
    .wf-unknown { font: var(--t-mono); font-size: 11px; color: var(--ink-4); border: 1px dashed var(--line); border-radius: var(--r-xs); padding: 6px 8px; }
    .wf-preview-note { font: var(--t-xs); color: var(--ink-4); margin-top: var(--s3); text-align: center; }
    .wf-preview-fail { border: 1px dashed var(--line); border-radius: var(--r-md); padding: var(--s5); text-align: center; }
    .wf-preview-fail p { font: var(--t-xs); color: var(--ink-3); margin: 0 0 var(--s3); }

    @media (max-width: 1000px) {
      .wf-grid { grid-template-columns: 1fr; }
      .wf-side { position: static; max-width: 380px; }
    }
  `;
  document.head.appendChild(style);
}

// ---- the three real forms ----
// Every path below was read from the source, not guessed. Entry screens mirror
// DEFAULT_SCREENS in supabase/functions/wa-webhook/handlers/_common.ts.
const FORMS = [
  {
    key: 'consent',
    flow: 'consent_v1',
    file: 'wa/flows/consent_v1.json',
    title: 'Consent form',
    blurb: 'The signed home-care consent. Until it comes back the session is not cleared to start.',
    entryScreen: 'INFO',
    audience: 'Patient',
    audienceDetail: 'Sent to the WhatsApp number registered for the patient, so a family member on that number may be the one who signs.',
    timing: 'The moment a nurse accepts and the case is assigned',
    timingDetail: 'The scheduler keeps chasing it until it is signed or the case moves on.',
    sentBy: [
      'supabase/functions/_shared/assign.ts -> sendConsentInvite()',
      'supabase/functions/scheduler/index.ts (consent chaser)',
    ],
    replyPath: 'supabase/functions/wa-webhook/handlers/flows.ts -> onConsent()',
    writesTo: 'consents',
    fallback: 'When the 24 hour chat window is shut the invite goes out as the approved template <code>consent_flow_invite</code>, which carries the same form behind a button.',
    missingConsequence: 'No consent form can be opened in chat, and the fallback template <code>consent_flow_invite</code> cannot be registered at Meta without an id either, so the ask never reaches the family.',
  },
  {
    key: 'completion',
    flow: 'completion_v1',
    file: 'wa/flows/completion_v1.json',
    title: 'Session completion report',
    blurb: 'What the nurse actually did in the session. It feeds the discharge summary and the invoice.',
    entryScreen: 'REPORT',
    audience: 'Nurse',
    audienceDetail: 'Sent to the nurse attending the session, on the number on their nurse record.',
    timing: 'At the end of the session, when the nurse marks the care done',
    timingDetail: 'Submitting it drives the whole care_done pipeline: discharge summary, invoice, payment ask.',
    sentBy: [
      'supabase/functions/wa-webhook/handlers/_common.ts -> sendCompletionFlow()',
    ],
    replyPath: 'supabase/functions/wa-webhook/handlers/flows.ts -> onCompletion()',
    writesTo: 'completion_reports',
    fallback: 'There is no template fallback for this one. With the chat window shut the nurse is asked in plain text to type the report instead.',
    missingConsequence: 'The nurse gets a plain "Report form unavailable" message asking them to type the details by hand, a <code>flow_unavailable</code> event is logged, and no completion_reports row is created, so no discharge summary and no invoice.',
  },
  {
    key: 'feedback',
    flow: 'feedback_v1',
    file: 'wa/flows/feedback_v1.json',
    title: 'Feedback form',
    blurb: 'The one-minute rating the family is asked for once the session is behind them.',
    entryScreen: 'FEEDBACK',
    audience: 'Patient',
    audienceDetail: 'Sent to the WhatsApp number registered for the patient.',
    timing: '2 hours after the case is completed',
    timingDetail: 'Chased at 24 hours and again at 72 hours, at most twice, and only while the "Feedback chaser" toggle in Settings is on.',
    sentBy: [
      'supabase/functions/scheduler/index.ts -> jobFeedbackChaser()',
      'supabase/functions/admin-actions/index.ts (send on demand from a case)',
    ],
    replyPath: 'supabase/functions/wa-webhook/handlers/flows.ts -> onFeedback()',
    writesTo: 'feedback',
    fallback: 'When the chat window is shut the ask goes out as the approved template <code>feedback_invite</code>, which opens the same form from a button.',
    missingConsequence: 'No feedback form can be opened in chat, and the fallback template <code>feedback_invite</code> cannot be registered at Meta without an id either, so no family is ever asked.',
  },
];

// Successful reads are cached for the session: the JSON files ship with the
// build and only change on deploy. Failures are NOT cached, so Retry works.
const specCache = new Map();

function formFor(id) {
  return FORMS.find(f => f.key === id || f.flow === id) || FORMS[0];
}

async function loadSpec(def) {
  if (specCache.has(def.flow)) return specCache.get(def.flow);
  try {
    const res = await fetch(`${def.file}?v=${CONFIG.VERSION}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText || 'could not be fetched'}`);
    const spec = await res.json();
    if (!spec || !Array.isArray(spec.screens)) throw new Error('The file has no screens array');
    const result = { spec, error: null };
    specCache.set(def.flow, result);
    return result;
  } catch (err) {
    console.error('[forms] could not read', def.file, err);
    return { spec: null, error: err.message || 'Unknown error' };
  }
}

async function loadFlowIds(sb) {
  const { data, error } = await sb.from('settings').select('value').eq('key', 'flow_ids').maybeSingle();
  if (error) throw new Error(error.message || 'Could not load settings.flow_ids');
  const v = data?.value;
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// Mirrors getFlowRef() in wa-webhook/handlers/_common.ts: the stored value is
// either the bare id string or { id, screen }.
function flowRef(flowIds, def) {
  const v = flowIds?.[def.flow];
  if (!v) return { id: '', screen: def.entryScreen };
  if (typeof v === 'string') return { id: v, screen: def.entryScreen };
  return { id: String(v.id ?? ''), screen: String(v.screen ?? def.entryScreen) };
}

function busy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>'; }
  else if (btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
}

// ============================================================ PREVIEW
// Renders the screens exactly as they are declared in the JSON. Read-only:
// the questions themselves are changed by editing the file and re-publishing
// the flow at Meta, never from here.

// Screens declare their inbound variables with an __example__ value. Swapping
// those in makes the preview read like a real message instead of "${data.x}".
function resolveBindings(text, screenData) {
  return String(text ?? '').replace(/\$\{data\.([A-Za-z0-9_]+)\}/g, (whole, key) => {
    const ex = screenData?.[key]?.__example__;
    return ex === undefined || ex === null ? whole : String(ex);
  });
}

function previewText(text, screenData) {
  return escapeHtml(resolveBindings(text, screenData)).replace(/\n/g, '<br />');
}

// A Form node is a grouping wrapper, not something the patient sees. Flatten it
// so the preview shows one continuous screen.
function flatChildren(children) {
  const out = [];
  for (const child of children || []) {
    if (!child || typeof child !== 'object') continue;
    if ((child.type === 'Form' || child.type === 'If') && Array.isArray(child.children)) {
      out.push(...flatChildren(child.children));
      continue;
    }
    out.push(child);
  }
  return out;
}

function optionList(child, mark) {
  const opts = Array.isArray(child['data-source']) ? child['data-source'] : [];
  if (!opts.length) return '<div class="wf-helper">Options are supplied at send time.</div>';
  // `init-value` is the answer already selected when the screen opens - the
  // completion form defaults complications to "none" so a nurse at the end of a
  // long shift taps nothing in the common case. Drawing every option unselected
  // would show a choice she does not actually have to make.
  const init = child['init-value'];
  return opts.map(o => {
    const on = init !== undefined && String(o?.id ?? '') === String(init);
    return `
    <div class="wf-opt"><span class="wf-mark ${mark}${on ? ' on' : ''}"></span><span>${escapeHtml(String(o?.title ?? o?.id ?? ''))}${
      on ? '<span class="wf-default">preselected</span>' : ''}</span></div>
  `;
  }).join('');
}

function footerNote(child) {
  const act = child['on-click-action'] || {};
  if (act.name === 'navigate') return `Opens screen ${escapeHtml(String(act.next?.name ?? 'the next one'))}`;
  if (act.name === 'complete') return 'Submits the form and closes it. The answers come back to the webhook.';
  if (act.name === 'data_exchange') return 'Sends the answers to the endpoint and waits for the next screen.';
  return act.name ? `Action: ${escapeHtml(String(act.name))}` : '';
}

function renderComponent(child, screenData) {
  const req = child.required === true ? '<span class="wf-req" title="Required">*</span>' : '';
  const label = child.label ? previewText(child.label, screenData) : '';
  const helper = child['helper-text']
    ? `<div class="wf-helper">${previewText(child['helper-text'], screenData)}</div>` : '';

  switch (child.type) {
    case 'TextHeading':
      return `<div class="wf-heading">${previewText(child.text, screenData)}</div>`;
    case 'TextSubheading':
      return `<div class="wf-subheading">${previewText(child.text, screenData)}</div>`;
    case 'TextBody':
      return `<div class="wf-bodytext">${previewText(child.text, screenData)}</div>`;
    case 'TextCaption':
      return `<div class="wf-caption">${previewText(child.text, screenData)}</div>`;
    case 'TextInput':
      return `<div class="wf-field">
        <span class="wf-label">${label}${req}</span>
        <span class="wf-input">${escapeHtml(String(child['input-type'] || 'text'))}</span>
        ${helper}
      </div>`;
    case 'TextArea':
      return `<div class="wf-field">
        <span class="wf-label">${label}${req}</span>
        <span class="wf-input tall">long answer</span>
        ${helper}
      </div>`;
    case 'DatePicker':
      return `<div class="wf-field">
        <span class="wf-label">${label}${req}</span>
        <span class="wf-input select">date</span>
        ${helper}
      </div>`;
    case 'Dropdown':
      return `<div class="wf-field">
        <span class="wf-label">${label}${req}</span>
        <span class="wf-input select">choose one</span>
        <div style="margin-top:5px">${optionList(child, 'round')}</div>
        ${helper}
      </div>`;
    case 'RadioButtonsGroup':
      return `<div class="wf-field">
        <span class="wf-label">${label}${req}</span>
        ${optionList(child, 'round')}
        ${helper}
      </div>`;
    case 'CheckboxGroup':
    case 'ChipsSelector':
      return `<div class="wf-field">
        <span class="wf-label">${label}${req}</span>
        ${optionList(child, 'square')}
        ${helper}
      </div>`;
    case 'OptIn':
      return `<div class="wf-optin"><span class="wf-mark square"></span><span>${label}${req}</span></div>`;
    case 'Image':
      return `<div class="wf-unknown">Image</div>`;
    case 'EmbeddedLink':
      return `<div class="wf-caption">${previewText(child.text, screenData)}</div>`;
    case 'Footer': {
      const note = footerNote(child);
      return `<div style="margin-top:2px">
        <span class="wf-cta">${previewText(child.label, screenData)}</span>
        ${note ? `<div class="wf-cta-note">${note}</div>` : ''}
      </div>`;
    }
    default:
      return `<div class="wf-unknown">${escapeHtml(String(child.type || 'component'))}${child.text ? `: ${previewText(child.text, screenData)}` : ''}</div>`;
  }
}

function renderScreen(screen, index, total) {
  const screenData = screen.data || {};
  const kids = flatChildren(screen.layout?.children);
  return `
    <div class="wf-screen">
      <div class="wf-screen-bar">
        <span class="wf-screen-step">${index + 1}/${total}</span>
        <span class="wf-screen-title">${escapeHtml(String(screen.title || screen.id || 'Screen'))}</span>
        ${screen.terminal ? '<span class="wf-screen-flag">submits</span>' : ''}
      </div>
      <div class="wf-screen-body">
        ${kids.length ? kids.map(k => renderComponent(k, screenData)).join('')
          : '<div class="wf-helper">This screen declares no components.</div>'}
      </div>
    </div>`;
}

function renderPreview(el, def, spec, specError) {
  if (specError || !spec) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Form preview</div>
          <div class="card-subtitle">The screens exactly as WhatsApp shows them.</div>
        </div>
        <div class="wf-preview-fail">
          <p>Could not read <code>${escapeHtml(def.file)}</code> from this build.<br />${escapeHtml(specError || 'Unknown error')}</p>
          <button class="btn btn-secondary btn-sm" data-retry-spec>Try again</button>
        </div>
        <div class="wf-preview-note">The binding and the records below are unaffected.</div>
      </div>`;
    return;
  }

  const screens = spec.screens;
  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Form preview</div>
        <div class="card-subtitle">Read-only. ${screens.length} screen${screens.length === 1 ? '' : 's'} from <code>${escapeHtml(def.file)}</code>.</div>
      </div>
      <div class="wf-phone">
        <div class="wf-phone-bar">WhatsApp</div>
        ${screens.map((s, i) => renderScreen(s, i, screens.length)).join('')}
      </div>
      <div class="wf-preview-note">To change a question, edit the JSON file and re-publish the flow at Meta. Published flows are immutable, so a change means a new flow and a new id.</div>
    </div>`;
}

// ============================================================ BINDING
// `def.missingConsequence` and `def.fallback` are trusted constants in this
// file and carry their own <code> markup, so they go in unescaped.
function renderBinding(el, def, flowIds, onSaved) {
  const ref = flowRef(flowIds, def);
  const bound = Boolean(ref.id);
  el.innerHTML = `
    <div class="card-header">
      <div class="card-title">Meta flow id</div>
      <div class="card-subtitle">Which form on Meta this send actually opens. Stored in <code>settings.flow_ids.${escapeHtml(def.flow)}</code>.</div>
    </div>
    ${bound ? '' : `
      <div class="warn-banner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <p><strong>This form cannot be sent.</strong> No id is bound, so ${def.missingConsequence}</p>
      </div>`}
    <div class="form-group" style="margin-bottom:var(--s2)">
      <label class="form-label" for="wf-id-${def.key}">Flow id</label>
      <div class="wf-idrow">
        <input class="form-input" id="wf-id-${def.key}" type="text" autocomplete="off" spellcheck="false"
               value="${escapeHtml(ref.id)}" placeholder="Paste the id from Meta WhatsApp Manager" />
        <button class="btn btn-primary btn-sm" data-save-id>Save</button>
      </div>
      <span class="form-hint">Entry screen <code>${escapeHtml(ref.screen)}</code>. Get the id from Meta WhatsApp Manager, or run <code>node scripts/bootstrap_wa.mjs</code> to create the flows and fill all three in.</span>
    </div>
    <div class="sp-note" style="display:flex;gap:9px;align-items:flex-start;font:var(--t-xs);color:var(--ink-3);margin-top:var(--s3)">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <span>Saving here changes the form opened inside a live chat straight away. Templates keep the id they were registered with at Meta, so re-run the bootstrap after changing this or the closed-window path will keep opening the old form.</span>
    </div>
  `;

  el.querySelector('[data-save-id]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const input = el.querySelector(`#wf-id-${def.key}`);
    const next = input.value.trim();
    if (!next) {
      showToast('Paste the Meta flow id first. Clearing it would stop the form being sent.', 'warning');
      input.focus();
      return;
    }
    if (!/^[A-Za-z0-9_-]{6,}$/.test(next)) {
      showToast('That does not look like a Meta flow id. Expect a long id with no spaces.', 'warning');
      input.focus();
      return;
    }
    if (next === ref.id) { showToast('That is already the bound id', 'info'); return; }

    busy(btn, true);
    try {
      const sb = getSupabase();
      // Re-read before merging: the bootstrap script writes this key too, and a
      // blind overwrite would drop the other two forms' ids.
      const current = await loadFlowIds(sb);
      const prev = current[def.flow];
      const value = prev && typeof prev === 'object' && !Array.isArray(prev)
        ? { ...prev, id: next }
        : next;
      const merged = { ...current, [def.flow]: value };
      const profile = getCurrentProfile();
      const { error } = await sb.from('settings').upsert(
        { key: 'flow_ids', value: merged, updated_at: new Date().toISOString(), updated_by: profile?.id ?? null },
        { onConflict: 'key' },
      );
      if (error) throw error;
      showToast(`${def.title} is now bound to ${next}`, 'success');
      Object.assign(flowIds, merged);
      // Re-render the whole page: the status badge, the unbound banner and the
      // tab markers all read the binding, and a stale "Not bound" is a lie.
      if (typeof onSaved === 'function') onSaved();
      else renderBinding(el, def, flowIds, onSaved);
    } catch (err) {
      console.error('[forms] flow id save failed:', err);
      showToast(err.message || 'Could not save the flow id', 'error');
      busy(el.querySelector('[data-save-id]'), false);
    }
  });
}

// ============================================================ ABOUT
function renderAbout(el, def, ref) {
  el.innerHTML = `
    <div class="card-header">
      <div class="card-title">${escapeHtml(def.title)}</div>
      <div class="card-subtitle">${escapeHtml(def.blurb)}</div>
    </div>
    <div class="kv">
      <div><div class="k">Who fills it in</div><div class="v">${escapeHtml(def.audience)}</div></div>
      <div><div class="k">When it is sent</div><div class="v">${escapeHtml(def.timing)}</div></div>
      <div><div class="k">Answers land in</div><div class="v"><code>${escapeHtml(def.writesTo)}</code></div></div>
      <div><div class="k">Status</div><div class="v">${ref.id
        ? '<span class="badge badge-ok">Bound</span>'
        : '<span class="badge badge-danger">Not bound</span>'}</div></div>
    </div>
    <div class="wf-paths">
      <div class="wf-path"><span class="wf-path-k">Detail</span><span>${escapeHtml(def.audienceDetail)} ${escapeHtml(def.timingDetail)}</span></div>
      ${def.sentBy.map((p, i) => `
        <div class="wf-path"><span class="wf-path-k">${i === 0 ? 'Sent by' : ''}</span><code>${escapeHtml(p)}</code></div>
      `).join('')}
      <div class="wf-path"><span class="wf-path-k">Reply handled</span><code>${escapeHtml(def.replyPath)}</code></div>
      <div class="wf-path"><span class="wf-path-k">Screens</span><span><code>${escapeHtml(def.file)}</code>, entry screen <code>${escapeHtml(ref.screen)}</code></span></div>
      <div class="wf-path"><span class="wf-path-k">Window shut</span><span>${def.fallback}</span></div>
    </div>
  `;
}

// ============================================================ CONSENT RECORDS
async function renderConsents(el) {
  el.innerHTML = `
    <div class="card-header">
      <div class="card-title">Signed consents</div>
      <div class="card-subtitle">The 25 most recent replies to this form, newest first.</div>
    </div>
    <div class="skeleton skeleton-row"></div>
    <div class="skeleton skeleton-row"></div>
    <div class="skeleton skeleton-row"></div>
  `;

  let rows = [];
  try {
    const { data, error } = await getSupabase()
      .from('consents')
      .select('id, case_id, signed_name, relationship, agreed, created_at, case:cases(case_code)')
      .order('created_at', { ascending: false })
      .limit(25);
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    console.error('[forms] consents load failed:', err);
    el.innerHTML = `
      <div class="card-header">
        <div class="card-title">Signed consents</div>
      </div>
      <div class="empty-state">
        <h3>Couldn't load consents</h3>
        <p>${escapeHtml(err.message || 'Unknown error')}</p>
        <button class="btn btn-secondary btn-sm" data-retry-consents>Try again</button>
      </div>`;
    el.querySelector('[data-retry-consents]')?.addEventListener('click', () => renderConsents(el));
    return;
  }

  el.innerHTML = `
    <div class="card-header">
      <div class="card-title">Signed consents</div>
      <div class="card-subtitle">${rows.length
        ? `The ${rows.length} most recent ${rows.length === 1 ? 'reply' : 'replies'} to this form, newest first. Open a row for the full case.`
        : 'Every reply to this form lands here.'}</div>
    </div>
    ${rows.length ? `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>
            <th>Case</th><th>Signed by</th><th>Relation</th><th>Result</th><th>Received (IST)</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr class="row-link" data-case-id="${escapeHtml(String(r.case_id))}" tabindex="0"
                  aria-label="Open case ${escapeHtml(String(r.case?.case_code || r.case_id))}">
                <td class="cell-mono">${escapeHtml(String(r.case?.case_code || '-'))}</td>
                <td>${escapeHtml(r.signed_name || '-')}</td>
                <td class="${r.relationship ? '' : 'hint'}">${escapeHtml(r.relationship ? capitalize(String(r.relationship)) : '-')}</td>
                <td>${r.agreed
                  ? '<span class="badge badge-ok">Agreed</span>'
                  : '<span class="badge badge-danger">Declined</span>'}</td>
                <td class="cell-mono">${escapeHtml(formatDateTime(r.created_at))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : `
      <div class="empty-state" style="padding: var(--s6)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <h3>No consent signed yet</h3>
        <p>Every reply to this form lands here. If cases are being assigned and nothing shows up, check that the flow id above is bound.</p>
      </div>`}
  `;

  const open = (row) => { if (row?.dataset.caseId) navigate(`cases/${row.dataset.caseId}`); };
  el.addEventListener('click', (e) => open(e.target.closest('tr[data-case-id]')));
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('tr[data-case-id]');
    if (row) { e.preventDefault(); open(row); }
  });
}

// ============================================================ PAGE ENTRY
export default async function renderForms(container, params) {
  injectStyles();
  const def = formFor(params?.id);

  container.innerHTML = `
    <div class="wf-grid">
      <div class="wf-col">
        <div class="card"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div></div>
        <div class="card"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-row"></div></div>
      </div>
      <div class="wf-side"><div class="card"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div></div></div>
    </div>`;

  let flowIds;
  try {
    flowIds = await loadFlowIds(getSupabase());
  } catch (err) {
    console.error('[forms] flow_ids load failed:', err);
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <h3>Couldn't load the form bindings</h3>
        <p>${escapeHtml(err.message || 'Unknown error')}</p>
        <button class="btn btn-secondary" data-retry>Try again</button>
      </div>`;
    container.querySelector('[data-retry]')?.addEventListener('click', () => renderForms(container, params));
    return;
  }

  // The route may have changed while we were loading.
  if (!container.isConnected) return;

  const { spec, error: specError } = await loadSpec(def);
  if (!container.isConnected) return;

  const unbound = FORMS.filter(f => !flowRef(flowIds, f).id);

  container.innerHTML = `
    <p class="wf-intro">
      These are the three real forms WhatsApp opens inside the chat: Meta hosts them, the patient or
      the nurse fills them in without leaving the conversation, and the answers come straight back
      into the database. Their screens live in this repo under <code>wa/flows/</code>; what you set
      here is which form on Meta each send is bound to.
    </p>
    ${unbound.length ? `
      <div class="warn-banner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <p>${unbound.length === 1
          ? `<strong>${escapeHtml(unbound[0].title)} has no Meta flow id</strong>, so it cannot be sent at all.`
          : `<strong>${unbound.length} of the 3 forms have no Meta flow id</strong> (${unbound.map(f => escapeHtml(f.title)).join(', ')}), so they cannot be sent at all.`}
          Bind the id below, or run <code>node scripts/bootstrap_wa.mjs</code> to create the flows at Meta and fill them in.</p>
      </div>` : ''}
    <div class="tabs">
      ${FORMS.map(f => {
        const bound = Boolean(flowRef(flowIds, f).id);
        return `<button class="tab ${f.key === def.key ? 'active' : ''}" data-form-tab="${f.key}">
          ${escapeHtml(f.title)}${bound ? '' : ' <span class="cnt" title="No flow id bound">!</span>'}
        </button>`;
      }).join('')}
    </div>
    <div class="wf-grid">
      <div class="wf-col">
        <div class="card" id="wf-about"></div>
        <div class="card" id="wf-binding"></div>
        ${def.key === 'consent' ? '<div class="card" id="wf-consents"></div>' : ''}
      </div>
      <div class="wf-side" id="wf-preview"></div>
    </div>`;

  container.querySelectorAll('[data-form-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-form-tab');
      if (key !== def.key) navigate(`forms/${key}`);
    });
  });

  renderAbout(container.querySelector('#wf-about'), def, flowRef(flowIds, def));
  renderBinding(container.querySelector('#wf-binding'), def, flowIds, () => renderForms(container, params));
  renderPreview(container.querySelector('#wf-preview'), def, spec, specError);
  container.querySelector('[data-retry-spec]')?.addEventListener('click', () => renderForms(container, params));

  if (def.key === 'consent') {
    await renderConsents(container.querySelector('#wf-consents'));
  }
}

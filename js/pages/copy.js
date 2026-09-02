// ============================================================
// Carcinome Home Care - Message copy (#copy)
//   Every WhatsApp body this system can send, editable in English
//   and Hindi, next to the phone preview the sender actually produces.
//
// A message here has three parts, and all three are edited on this page:
//   the WORDS, an optional PICTURE that rides above them, and the
//   BUTTONS underneath. The picture and the buttons are delivered inside
//   the 24 hour window only: outside it WhatsApp allows an approved
//   template, no approved template carries either, and the words go out
//   alone. That sentence is repeated next to every control that can be
//   affected by it, because it is the one fact that surprises people.
//
// THE ONE RULE OF THIS PAGE: it never renders a message by itself.
// Every preview, every character count and every red line comes back
// from preview_copy in admin-actions, which runs the SAME renderer and
// the SAME validator as the send path and as the publish gate. The only
// local rendering is the optimistic echo drawn while that call is in
// flight, and it is dimmed and labelled "checking" so nobody mistakes it
// for the truth. Meta's own limits arrive with list_copy as wa_limits,
// read from the same constant wa.ts slices with, so a counter here
// cannot drift from the cut on a phone.
//
// A BUTTON LABEL IS EDITABLE, A BUTTON'S MEANING IS NOT. We store a slot
// (0, 1, 2) and an action verb; copy.ts builds the payload the webhook
// routes on. So an intern can rewrite three labels into Hindi and no
// edit on this page can point a tap at the wrong case or at nothing.
//
// Reads:  adminAction('list_copy')  - the whole registry, rows and caps
//         message_copy_versions     - history, direct under RLS
// Writes: save_copy_draft / publish_copy / revert_copy, plus
//         refresh_copy_media (warms Meta's copy of a published picture)
//         and send_copy_test (one phone, no case, no publish). draft_*
//         is a scratchpad the send path never reads; the published_*
//         columns are the only thing that reaches a phone, and only
//         through Publish.
// ============================================================

import { getSupabase } from '../supabase.js';
import { adminAction, uploadCaseDoc, signedDocUrl } from '../utils/api.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal, confirmModal } from '../components/modal.js';
import { icon } from '../components/icons.js';
import {
  escapeHtml, formatDateTime, formatRelativeTime, formatTime,
} from '../utils/formatters.js';

// Who actually reads this, in the words an intern would use out loud.
// The registry's `audience` is a system word (poc, ops, pool); nobody on
// their first day knows what a "poc" is, and the whole point of the list
// is that they can pick the right message without asking.
const AUDIENCE_WORDS = {
  patient: 'the family',
  nurse: 'the nurse',
  pool: 'every nurse in the pool',
  doctor: 'the referring doctor',
  poc: 'the Carcinome POC who owns this family',
  ops: 'our own ops team',
  supplier: 'the supplier',
  participant: 'everyone on the case group',
  sender: 'whoever sent the message',
  public: 'anyone who writes to us',
};

const AUDIENCE_EMOJI = {
  patient: '🧑', nurse: '🩺', pool: '🩺', doctor: '🥼', poc: '📔',
  ops: '🛟', supplier: '📦', participant: '💬', sender: '💬', public: '💬',
};

const LANG_LABEL = { en: 'English', hi: 'Hindi' };

const ORIGIN_LABEL = {
  human: 'edited by hand',
  gemini: 'drafted by the writing assistant',
  revert: 'reverted to the built-in wording',
  seed: 'set by a migration',
};

// Plain-English prompts an intern can click instead of inventing one.
const AI_PRESETS = [
  'Make this warmer and shorter',
  'Use simpler words a worried family can read fast',
  'Explain what they should do next more clearly',
  'Keep the meaning, make it sound less robotic',
];

const PREVIEW_DEBOUNCE_MS = 420;
const DRAFT_MAX_CHARS = 8000;      // matches DRAFT_MAX_CHARS in admin-actions

/**
 * Meta's real numbers arrive on every list_copy as `wa_limits`, straight from
 * WA_LIMITS in _shared/wa.ts, which is the same constant the sender slices
 * with. Read them from there, never from here. This table exists only so a
 * counter still draws something sane against a function old enough not to send
 * them yet.
 */
const WA_FALLBACK = {
  BODY_MAX: 1024,          // an interactive bubble, buttons or not
  TEXT_MAX: 4096,          // a plain text bubble
  FOOTER_MAX: 60,
  BUTTON_TITLE_MAX: 20,
  BUTTON_MAX: 3,
  CTA_TEXT_MAX: 20,
  CTA_URL_MAX: 2000,
  IMAGE_MAX_BYTES: 5 * 1024 * 1024,
};
function waLimit(name) {
  const v = S?.data?.wa_limits?.[name];
  return typeof v === 'number' ? v : WA_FALLBACK[name];
}

/**
 * JPEG AND PNG ONLY, and the accept list says so.
 *
 * Meta's `image` message type takes image/jpeg and image/png. A WebP is a
 * STICKER to WhatsApp: it uploads to storage happily, passes every check an
 * editor can make in a browser, and then fails at Graph where no operator ever
 * sees it. This page used to offer image/webp in the picker, which is exactly
 * how that lands on a family.
 */
const IMAGE_ACCEPT = 'image/png,image/jpeg';
const IMAGE_MIME_RE = /^image\/(png|jpe?g)$/i;

/**
 * Measured, not guessed: a 16 by 16 pixel PNG was accepted by Meta's /media
 * upload, came back with a message id, and then failed to deliver hours later
 * with "image is invalid". Nothing in the send path can see that, so warn about
 * a postage-stamp picture here, where the person who chose it is standing.
 */
const IMAGE_MIN_PX = 64;

// Which storage the person is looking at, in the words on the buttons.
const USE_WORDS = {
  request: 'what is in the editor right now',
  draft: 'the saved draft',
  published: 'the published wording',
  default: 'the built-in wording',
};

// What actually left the building, for the test-send result.
const VIA_WORDS = {
  text: 'a plain text message',
  image: 'a picture with the words underneath it as the caption',
  'image+text': 'the picture first, then the words as their own message',
  interactive: 'a message with tappable buttons under it',
  cta_url: 'a message with a link button under it',
  template: 'the approved template, because the 24 hour window was shut',
};

// Why a part of the message did not travel. send_copy_test reports these codes
// on `dropped`; nobody outside this repo should ever read one of them.
const DROP_WORDS = {
  window_closed: 'the reader has not written to us in 24 hours, so this went out as a template and a template carries neither a picture nor buttons',
  not_supported: 'this message cannot carry one at all',
  mime_unsupported: 'WhatsApp takes JPG and PNG only',
  too_large: 'the picture is over 5 MB',
  upload_failed: 'WhatsApp would not accept the file',
  body_too_long: 'the words go past the 1024 characters a message with buttons is allowed',
};

/**
 * Graph's failure codes, in the words of somebody who has to act on them.
 * Order matters: the first pattern that matches wins, so put the specific
 * ones first. Anything unmatched keeps its raw text, tucked behind a fold.
 */
const SEND_ERROR_WORDS = [
  [/131047|re-?engagement/i, 'That phone has not written to us in the last 24 hours, so WhatsApp will only carry an approved template to it. Ask them to send us any message, then try again.'],
  [/131053|image is invalid/i, 'WhatsApp refused the picture itself. It has to be a real photograph-sized JPG or PNG; a tiny or unusual one is accepted on upload and then never delivered.'],
  [/131026/, 'That number cannot receive WhatsApp messages. Check the digits, and that the person actually uses WhatsApp on it.'],
  [/133010|not registered/i, 'Our WhatsApp number is not registered with Meta right now. This is an account problem, not a problem with your wording.'],
  [/131008|131009|132000|132001|132012/, 'WhatsApp refused the shape of this message. The wording is fine; something about the picture, the buttons or the template does not fit. Tell an engineer what you were sending.'],
  [/130472|user_?opt/i, 'That person has opted out of messages like this one.'],
  // (#368) is three digits and would match a trace id, so it is anchored to the
  // two shapes Graph actually returns it in.
  [/131031|\(#368\)|"code":\s*368|account.*restrict/i, 'Our WhatsApp account is restricted at Meta at the moment, so nothing is going out.'],
  [/130429|80007|rate limit/i, 'We are sending too fast for WhatsApp right now. Wait a minute and try again.'],
];
function sendErrorWords(raw) {
  const s = String(raw ?? '');
  for (const [re, words] of SEND_ERROR_WORDS) if (re.test(s)) return words;
  return 'WhatsApp did not accept it. The exact answer is below; send that line to an engineer.';
}

// A quick reply's verb is written for one kind of reader. "Mark care complete"
// on a message to the family answers the nurse's question, which is how a
// session gets closed by somebody who never attended it.
const AUDIENCE_GROUP = { patient: 'patient', nurse: 'nurse', pool: 'nurse' };

// ---- page-scoped styles (injected once) ----
const STYLE_ID = 'copy-page-style';
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .cp-top { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; margin-bottom: var(--s4); }
    .cp-top .table-search { flex: 1 1 220px; max-width: 340px; }
    .cp-top .form-select { width: auto; min-width: 150px; }
    .cp-count { font: var(--t-xs); color: var(--ink-3); margin-left: auto; }
    .cp-seg { display: inline-flex; background: var(--bg-sunken); border: 1px solid var(--line); border-radius: var(--r-pill); padding: 2px; }
    .cp-seg button { border: none; background: none; cursor: pointer; padding: 5px 13px; border-radius: var(--r-pill); font: var(--t-xs); font-weight: 600; color: var(--ink-3); }
    .cp-seg button[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: var(--sh-1); }
    .cp-seg button:focus-visible { outline: none; box-shadow: var(--ring); }

    .cp-wrap { display: grid; grid-template-columns: 330px minmax(0, 1fr); gap: var(--s5); align-items: start; }
    .cp-list { background: var(--bg-sunken); border: 1px solid var(--line); border-radius: var(--r-lg); padding: var(--s2); max-height: calc(100vh - 210px); overflow-y: auto; overscroll-behavior: contain; position: sticky; top: var(--s3); }
    .cp-stage { font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); padding: 12px 10px 6px; }
    .cp-row { display: flex; gap: 9px; width: 100%; text-align: left; background: var(--surface); border: 1px solid transparent; border-radius: var(--r-md); padding: 9px 10px; margin-bottom: 4px; cursor: pointer; transition: border-color var(--fast) var(--ease), transform var(--fast) var(--ease); }
    .cp-row:hover { border-color: var(--line-2); transform: translateX(2px); }
    .cp-row:focus-visible { outline: none; box-shadow: var(--ring); }
    .cp-row[aria-current="true"] { border-color: var(--primary); background: var(--primary-soft); }
    .cp-row-emoji { font-size: 15px; line-height: 1.3; flex: none; }
    .cp-row-main { min-width: 0; flex: 1; }
    .cp-row-title { display: block; font: var(--t-body-strong); font-size: 13.5px; color: var(--ink); overflow-wrap: anywhere; }
    .cp-row-sub { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font: var(--t-xs); font-weight: 400; color: var(--ink-3); margin-top: 2px; }
    .cp-row-flags { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: none; }
    .cp-tag { font: var(--t-mono-label); letter-spacing: 0.04em; border-radius: var(--r-pill); padding: 2px 7px; white-space: nowrap; }
    .cp-tag.edited { background: var(--ok-soft); color: var(--ok); }
    .cp-tag.draft { background: var(--warn-soft); color: var(--warn); }
    .cp-tag.locked { background: var(--bg-sunken); color: var(--ink-3); }
    .cp-tag.retired { background: var(--danger-soft); color: var(--danger); }

    .cp-work { min-width: 0; display: flex; flex-direction: column; gap: var(--s4); }
    .cp-head-top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s4); flex-wrap: wrap; }
    .cp-head h2 { font: 700 19px/1.25 var(--font-display); letter-spacing: -0.018em; color: var(--ink); }
    .cp-head .cp-who { font: var(--t-sm); color: var(--ink-2); margin-top: 5px; }
    .cp-head .cp-desc { font: var(--t-sm); color: var(--ink-3); margin-top: 6px; max-width: 74ch; }
    .cp-head-meta { display: flex; gap: 6px 12px; flex-wrap: wrap; margin-top: 10px; font: var(--t-mono); font-size: 11px; color: var(--ink-4); }
    .cp-help { margin-top: var(--s4); border-top: 1px solid var(--line); padding-top: var(--s3); }
    .cp-help summary { cursor: pointer; font: var(--t-xs); font-weight: 700; color: var(--primary); }
    .cp-help ul { margin: var(--s3) 0 0; padding-left: 18px; }
    .cp-help li { font: var(--t-sm); color: var(--ink-2); margin-bottom: 7px; }

    .cp-samples { margin-top: var(--s3); }
    .cp-samples summary { cursor: pointer; font: var(--t-xs); font-weight: 700; color: var(--ink-2); }
    .cp-sample-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: var(--s3); margin-top: var(--s3); }
    .cp-sample-grid label { display: block; font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-3); margin-bottom: 4px; }
    .cp-sample-grid input { font-size: 13px; }

    .cp-langs { display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); gap: var(--s4); align-items: start; }
    .cp-lang { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: var(--s4); box-shadow: var(--hi), var(--sh-1); min-width: 0; }
    .cp-lang-head { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; padding-bottom: var(--s3); border-bottom: 1px solid var(--line); margin-bottom: var(--s3); }
    .cp-lang-name { font: var(--t-h3); color: var(--ink); }
    .cp-state { font: var(--t-xs); color: var(--ink-3); flex-basis: 100%; }
    .cp-state b { color: var(--ink-2); }
    .cp-state .unsaved { color: var(--warn); font-weight: 700; }

    .cp-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: var(--s2); }
    .cp-chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--primary-soft-2); background: var(--primary-soft); color: var(--primary); border-radius: var(--r-pill); padding: 3px 10px; font: var(--t-mono); font-size: 11px; font-weight: 600; cursor: pointer; }
    .cp-chip:hover { background: var(--primary-soft-2); }
    .cp-chip:focus-visible { outline: none; box-shadow: var(--ring); }
    .cp-chip.req::after { content: "required"; font: var(--t-mono-label); background: var(--surface); color: var(--ink-3); border-radius: var(--r-pill); padding: 0 5px; }
    .cp-chips-hint { font: var(--t-xs); color: var(--ink-4); margin-bottom: var(--s3); }

    .cp-ta { width: 100%; min-height: 190px; resize: vertical; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.75; white-space: pre-wrap; tab-size: 2; }
    .cp-meter { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; margin-top: var(--s2); font: var(--t-xs); color: var(--ink-3); }
    .cp-bar { flex: 1 1 90px; height: 4px; border-radius: var(--r-pill); background: var(--bg-sunken); overflow: hidden; min-width: 70px; }
    .cp-bar i { display: block; height: 100%; background: var(--primary); transition: width var(--base) var(--ease); }
    .cp-bar.warn i { background: var(--warn); }
    .cp-bar.bad i { background: var(--danger); }

    .cp-issues { display: flex; flex-direction: column; gap: 6px; margin-top: var(--s3); }
    .cp-issue { display: flex; gap: 8px; align-items: flex-start; border-radius: var(--r-sm); padding: 8px 10px; font: var(--t-xs); line-height: 1.5; }
    .cp-issue.error { background: var(--danger-soft); color: var(--danger); }
    .cp-issue.warn { background: var(--warn-soft); color: var(--warn); }
    .cp-issue svg { width: 14px; height: 14px; flex: none; margin-top: 1px; }
    .cp-issue button { border: none; background: color-mix(in srgb, currentColor 14%, transparent); color: inherit; border-radius: var(--r-pill); padding: 1px 8px; font: var(--t-mono-label); cursor: pointer; flex: none; align-self: flex-start; }
    .cp-issue button:focus-visible { outline: none; box-shadow: var(--ring); }
    .cp-ok { display: flex; align-items: center; gap: 7px; margin-top: var(--s3); font: var(--t-xs); font-weight: 600; color: var(--ok); }
    .cp-ok svg { width: 14px; height: 14px; }

    /* ---- the phone ---- */
    .cp-phone { margin-top: var(--s4); border: 1px solid var(--line-2); border-radius: var(--r-lg); overflow: hidden; background: var(--chat-bg); }
    .cp-phone-bar { display: flex; align-items: center; gap: 9px; padding: 9px 12px; background: var(--panel); color: var(--panel-text); }
    .cp-phone-bar .av { width: 26px; height: 26px; border-radius: 50%; background: var(--panel-3); display: grid; place-items: center; font-size: 13px; flex: none; }
    .cp-phone-bar .who { font: var(--t-body-strong); font-size: 13px; }
    .cp-phone-bar .sub { font: var(--t-mono); font-size: 10px; color: var(--panel-text-3); }
    .cp-phone-bar .flag { margin-left: auto; font: var(--t-mono-label); color: var(--panel-text-3); }
    .cp-chatpane { padding: var(--s4) var(--s3) var(--s5); display: flex; flex-direction: column; align-items: flex-end; min-height: 120px; }
    .cp-bubble { max-width: 94%; background: var(--bubble-out); border: 1px solid var(--bubble-out-line); border-radius: 14px; border-top-right-radius: 5px; padding: 8px 11px 6px; box-shadow: 0 1px 1px rgba(29,39,51,0.08); font: var(--t-sm); color: var(--ink); line-height: 1.52; }
    /* pre-wrap lives on the TEXT node only. On the bubble it would also print
       the indentation of the template literal that built the bubble. */
    .cp-bubble-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .cp-bubble.checking { opacity: 0.55; }
    .cp-bubble strong { font-weight: 700; }
    .cp-bubble em { font-style: italic; }
    .cp-bubble s { text-decoration: line-through; }
    .cp-bubble code.wa-mono { font-family: var(--font-mono); font-size: 0.94em; white-space: pre-wrap; }
    .cp-bubble img { display: block; max-width: 100%; border-radius: 9px; margin-bottom: 6px; }
    .cp-bubble-meta { display: flex; align-items: center; justify-content: flex-end; gap: 5px; margin-top: 3px; font: var(--t-mono); font-size: 10px; color: var(--ink-3); }
    .cp-ticks { color: var(--tick-read); letter-spacing: -0.14em; font-size: 12px; }
    .cp-phone-foot { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: var(--surface-3); border-top: 1px solid var(--line); font: var(--t-xs); color: var(--ink-3); }
    .cp-phone-foot .dotp { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-4); flex: none; }
    .cp-phone-foot.live .dotp { background: var(--ok); }

    .cp-fold { margin-top: var(--s3); border: 1px solid var(--line); border-radius: var(--r-md); }
    .cp-fold > summary { cursor: pointer; padding: 9px 12px; font: var(--t-xs); font-weight: 700; color: var(--ink-2); list-style: none; display: flex; align-items: center; gap: 7px; }
    .cp-fold > summary::-webkit-details-marker { display: none; }
    .cp-fold > summary:focus-visible { outline: none; box-shadow: var(--ring); border-radius: var(--r-md); }
    .cp-fold > summary::before { content: "+"; font: var(--t-mono); color: var(--ink-4); }
    .cp-fold[open] > summary::before { content: "-"; }
    .cp-fold-body { padding: 0 12px 12px; }
    .cp-pre { font-family: var(--font-mono); font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg-sunken); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 10px 12px; color: var(--ink-2); max-height: 300px; overflow-y: auto; }
    .cp-pre .tok { background: var(--primary-soft); color: var(--primary); border-radius: 4px; padding: 0 3px; }

    .cp-img { display: flex; align-items: center; gap: var(--s3); margin-top: var(--s3); }
    .cp-img-thumb { width: 56px; height: 56px; border-radius: var(--r-sm); object-fit: cover; border: 1px solid var(--line); background: var(--bg-sunken); flex: none; }
    .cp-img-body { min-width: 0; flex: 1; }
    .cp-img-name { font: var(--t-xs); color: var(--ink-2); overflow-wrap: anywhere; }

    /* ---- the picture and the buttons ----
       Both are BLOCKS, not folds. "Where do I add a picture, where do I add an
       action" is the question this page is judged on, and an answer hidden
       behind a disclosure triangle is not an answer. */
    .cp-block { margin-top: var(--s4); border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface-2); padding: var(--s3); }
    .cp-block h4 { font: var(--t-body-strong); font-size: 13.5px; color: var(--ink); margin-bottom: 3px; }
    .cp-block .cp-chips-hint { margin: 0 0 var(--s2); }
    .cp-block-off { margin-top: var(--s4); border: 1px dashed var(--line-2); border-radius: var(--r-md); padding: var(--s3); }
    .cp-block-off h4 { font: var(--t-body-strong); font-size: 13.5px; color: var(--ink-3); margin-bottom: 3px; }
    .cp-block-off p { font: var(--t-xs); color: var(--ink-4); line-height: 1.55; }

    .cp-drop { display: flex; align-items: center; gap: var(--s3); width: 100%; text-align: left; border: 1.5px dashed var(--line-2); background: var(--surface); border-radius: var(--r-md); padding: var(--s3); cursor: pointer; color: var(--ink-2); font: var(--t-sm); }
    .cp-drop:hover, .cp-drop.over { border-color: var(--primary); background: var(--primary-soft); color: var(--primary); }
    .cp-drop:focus-visible { outline: none; box-shadow: var(--ring); }
    .cp-drop svg { width: 18px; height: 18px; flex: none; }
    .cp-drop b { display: block; font: var(--t-body-strong); font-size: 13px; }
    .cp-drop span { font: var(--t-xs); color: var(--ink-3); }
    .cp-drop:hover span, .cp-drop.over span { color: inherit; }
    /* dragging a replacement onto a picture that is already there */
    .cp-img.over { outline: 2px dashed var(--primary); outline-offset: 4px; border-radius: var(--r-sm); }
    .cp-img-warn { display: flex; gap: 7px; align-items: center; margin-top: var(--s2); border-radius: var(--r-sm); padding: 7px 9px; font: var(--t-xs); line-height: 1.5; background: var(--warn-soft); color: var(--warn); }
    .cp-img-warn svg { width: 13px; height: 13px; flex: none; }
    .cp-img-warn span { flex: 1; }
    /* .spinner is white on white outside a button (components.css) and the
       uploading state is not inside one. */
    .cp-block .spinner { border-color: var(--line-strong); border-top-color: var(--primary); }

    .cp-qr { border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); padding: var(--s2) var(--s3) var(--s3); margin-top: var(--s2); }
    .cp-qr-top { display: flex; align-items: center; gap: var(--s2); }
    .cp-qr-top .n { font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-3); flex: none; }
    .cp-qr-top .form-select { flex: 1 1 auto; min-width: 0; font-size: 13px; }
    .cp-qr-lab { display: flex; align-items: center; gap: var(--s2); margin-top: 6px; }
    .cp-qr-lab .form-input { flex: 1 1 auto; min-width: 0; font-size: 13px; }
    .cp-qr-url { margin-top: 6px; font-size: 12.5px; }
    .cp-qr-note { font: var(--t-xs); color: var(--ink-3); margin-top: 5px; line-height: 1.5; }
    .cp-qr-note.bad { color: var(--warn); font-weight: 600; }
    .cp-mini { border: none; background: none; color: var(--ink-3); cursor: pointer; padding: 3px; border-radius: var(--r-sm); line-height: 0; flex: none; }
    .cp-mini svg { width: 15px; height: 15px; }
    .cp-mini:hover { color: var(--danger); background: var(--danger-soft); }
    .cp-mini:focus-visible { outline: none; box-shadow: var(--ring); }
    .cp-num { font: var(--t-mono); font-size: 10.5px; color: var(--ink-3); flex: none; white-space: nowrap; }
    .cp-num.over { color: var(--danger); font-weight: 700; }
    .cp-addrow { display: flex; gap: var(--s2); flex-wrap: wrap; margin-top: var(--s2); }
    .cp-foot-edit { margin-top: var(--s3); padding-top: var(--s3); border-top: 1px dashed var(--line); }
    .cp-foot-edit label { display: block; font: var(--t-xs); font-weight: 600; color: var(--ink-2); margin-bottom: 4px; }
    .cp-foot-edit .row { display: flex; align-items: center; gap: var(--s2); }
    .cp-foot-edit .form-input { flex: 1 1 auto; min-width: 0; font-size: 13px; }

    /* ---- the phone, buttons half ----
       WhatsApp hangs quick replies off the BOTTOM of the bubble as full-width
       rows with a hairline between them, so the bubble loses its bottom
       corners when they are there. --tick-read is the real WhatsApp blue that
       variables.css already keeps for the read ticks. */
    .cp-out { max-width: 94%; display: flex; flex-direction: column; align-items: stretch; margin-bottom: 6px; }
    .cp-out .cp-bubble { max-width: 100%; }
    .cp-out.hasbtn .cp-bubble { border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom: none; }
    .cp-btns { background: var(--bubble-out); border: 1px solid var(--bubble-out-line); border-top: none; border-radius: 0 0 14px 14px; overflow: hidden; }
    .cp-btns .b { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--bubble-out-line); font: var(--t-body-strong); font-size: 13px; color: var(--tick-read); text-align: center; overflow-wrap: anywhere; }
    .cp-btns .b svg { width: 14px; height: 14px; flex: none; }
    .cp-btns .b.blank { color: var(--ink-4); font-style: italic; font-weight: 500; }
    .cp-bubble-foot { font: var(--t-xs); color: var(--ink-3); margin-top: 4px; overflow-wrap: anywhere; }
    .cp-imgwait { height: 110px; border-radius: 9px; margin-bottom: 6px; background: var(--bg-sunken); }
    .cp-phone-foot.split { color: var(--warn); }

    .cp-test { margin-top: var(--s3); border-radius: var(--r-md); padding: var(--s3); font: var(--t-sm); line-height: 1.55; }
    .cp-test.ok { background: var(--ok-soft); color: var(--ok); }
    .cp-test.bad { background: var(--danger-soft); color: var(--danger); }
    .cp-test.info { background: var(--info-soft); color: var(--info); }
    .cp-test b { font-weight: 700; }
    .cp-test ul { margin: 6px 0 0; padding-left: 17px; }
    .cp-test li { margin-top: 3px; }
    .cp-test details { margin-top: 7px; }
    .cp-test summary { cursor: pointer; font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.07em; }
    .cp-test pre { font-family: var(--font-mono); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 5px; }
    .cp-issue .field { font: var(--t-mono-label); background: color-mix(in srgb, currentColor 16%, transparent); border-radius: var(--r-pill); padding: 1px 6px; flex: none; align-self: flex-start; }
    .cp-radio { display: flex; align-items: flex-start; gap: 8px; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 9px 11px; margin-top: 6px; cursor: pointer; font: var(--t-sm); color: var(--ink-2); }
    .cp-radio:hover { border-color: var(--line-2); }
    .cp-radio input { margin-top: 2px; flex: none; }
    .cp-radio b { display: block; color: var(--ink); font: var(--t-body-strong); font-size: 13px; }

    .cp-ai textarea { min-height: 62px; font-size: 13px; }
    .cp-ai-presets { display: flex; flex-wrap: wrap; gap: 6px; margin: var(--s2) 0; }
    .cp-ai-presets button { border: 1px dashed var(--line-2); background: none; color: var(--ink-3); border-radius: var(--r-pill); padding: 3px 10px; font: var(--t-xs); cursor: pointer; }
    .cp-ai-presets button:hover { border-color: var(--primary); color: var(--primary); }
    .cp-ai-out { margin-top: var(--s3); border: 1px dashed var(--violet); background: var(--violet-soft); border-radius: var(--r-md); padding: var(--s3); }
    .cp-ai-out h4 { font: var(--t-xs); font-weight: 700; color: var(--violet); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 6px; }
    .cp-ai-note { font: var(--t-xs); color: var(--ink-2); margin-top: 7px; font-style: italic; }

    .cp-actions { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; margin-top: var(--s4); padding-top: var(--s3); border-top: 1px solid var(--line); }
    .cp-actions .grow { flex: 1; }
    .cp-actions .btn-publish { font-weight: 700; }

    .cp-hist { display: flex; flex-direction: column; gap: 6px; }
    .cp-hist-row { display: flex; gap: var(--s3); align-items: flex-start; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 8px 10px; }
    .cp-hist-v { font: var(--t-mono); font-size: 11px; font-weight: 700; color: var(--primary); flex: none; }
    .cp-hist-main { min-width: 0; flex: 1; }
    .cp-hist-meta { font: var(--t-xs); color: var(--ink-3); }
    .cp-hist-body { font-family: var(--font-mono); font-size: 11px; color: var(--ink-2); margin-top: 4px; white-space: pre-wrap; max-height: 62px; overflow: hidden; }

    /* ---- diff, used by the publish and conflict dialogs ---- */
    .cp-diff { font-family: var(--font-mono); font-size: 12px; line-height: 1.65; border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; max-height: 320px; overflow-y: auto; }
    .cp-diff div { padding: 1px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .cp-diff .add { background: var(--ok-soft); color: var(--ok); }
    .cp-diff .del { background: var(--danger-soft); color: var(--danger); text-decoration: line-through; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); }
    .cp-diff .same { color: var(--ink-3); }
    .cp-modal-note { font: var(--t-sm); color: var(--ink-2); margin-bottom: var(--s3); }
    .cp-two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s3); }
    .cp-two h4 { font: var(--t-mono-label); text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-3); margin-bottom: 5px; }

    @media (max-width: 1100px) {
      .cp-wrap { grid-template-columns: 1fr; }
      .cp-list { position: static; max-height: 340px; }
      .cp-two { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);
}

// ════════════════════════════════════════════════ WhatsApp text rendering

/**
 * WhatsApp's markup, as WhatsApp actually applies it.
 *
 * Three things matter and all three are wrong in every naive version of this:
 *   1. ``` fences run across the WHOLE message, not one line, which is why the
 *      server validator counts them over the whole body.
 *   2. *bold* / _italic_ / ~strike~ do NOT cross a line break, and a delimiter
 *      with a space next to it is literal text, not markup. So "5 * 3 = 15"
 *      stays "5 * 3 = 15".
 *   3. Escaping comes FIRST. The bodies contain patient names and a stray "<"
 *      in a note must never become a tag.
 */
function waHtml(text) {
  const esc = escapeHtml(String(text ?? ''));
  return esc
    .split('```')
    .map((part, i) => (i % 2 === 1 ? `<code class="wa-mono">${part}</code>` : waInline(part)))
    .join('');
}

// The character classes allow "&gt;" and the tags an earlier pass inserted, so
// *_bold italic_* nests the way it does on a phone.
const WA_OPEN = '(^|[\\s>(\\[{;])';
const WA_CLOSE = '(?=[\\s<.,!?;:)\\]}]|$)';
function waInline(s) {
  return s.split('\n').map((line) => {
    let l = line;
    for (const [ch, tag] of [['\\*', 'strong'], ['_', 'em'], ['~', 's']]) {
      const re = new RegExp(`${WA_OPEN}${ch}(\\S(?:[^${ch}\\n]*\\S)?)${ch}${WA_CLOSE}`, 'g');
      l = l.replace(re, `$1<${tag}>$2</${tag}>`);
    }
    return l;
  }).join('\n');
}

/**
 * The optimistic echo, used ONLY between a keystroke and preview_copy coming
 * back. It is deliberately a simplification of renderCopy(): substitute, then
 * drop any line whose every variable came out empty (which is what fmt.fact()
 * does), then collapse blank runs. It can differ from the server on the fancy
 * cases, so the bubble is drawn dimmed until the real render lands.
 */
function localRender(body, vars) {
  const val = (n) => {
    const v = vars ? vars[n] : undefined;
    return v === undefined || v === null ? '' : String(v);
  };
  const out = [];
  for (const line of String(body ?? '').split('\n')) {
    const tokens = [...line.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
    if (tokens.length && tokens.every((t) => !val(t))) continue;
    out.push(line.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, n) => val(n)));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Show a raw body with its {{tokens}} highlighted, for the "built-in wording" panes. */
function tokenHtml(body) {
  return escapeHtml(String(body ?? '')).replace(
    /\{\{\s*([\w.]+)\s*\}\}/g,
    (m) => `<span class="tok">${m}</span>`,
  );
}

/** Line diff (LCS). Bodies are ten lines, so the quadratic table is free. */
function diffLines(before, after) {
  const A = String(before ?? '').split('\n');
  const B = String(after ?? '').split('\n');
  const m = A.length, n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push(['same', A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['del', A[i]]); i++; }
    else { out.push(['add', B[j]]); j++; }
  }
  while (i < m) out.push(['del', A[i++]]);
  while (j < n) out.push(['add', B[j++]]);
  return out;
}

function diffHtml(before, after) {
  const rows = diffLines(before, after);
  if (!rows.some((r) => r[0] !== 'same')) {
    return `<div class="cp-diff"><div class="same">No difference.</div></div>`;
  }
  return `<div class="cp-diff">${rows.map(([t, s]) => {
    const mark = t === 'add' ? '+ ' : t === 'del' ? '- ' : '  ';
    return `<div class="${t}">${escapeHtml(mark + (s || ''))}</div>`;
  }).join('')}</div>`;
}

// ════════════════════════════════════════════════ state

let S = null;

/** The body a reader gets for this key and language RIGHT NOW. */
function liveBody(def, lang) {
  const row = def.rows?.[lang];
  if (row && row.published_body && row.published_body.trim()) return row.published_body;
  return def.defaults?.[lang] ?? '';
}

/** What the editor opens with: the saved draft, else what is live. */
function openingBody(def, lang) {
  const row = def.rows?.[lang];
  if (row && row.draft_body !== null && row.draft_body !== undefined) return row.draft_body;
  return liveBody(def, lang);
}

// ---- buttons ---------------------------------------------------------------
//
// The server stores, and parseButtons in _shared/copy.ts is the only thing that
// ever writes:
//     { quick_replies: [{ slot, action, title }], cta_url: {...}, footer: "" }
// The editor keeps the same three facts in a shape that is easier to mutate
// while somebody types, and converts on the way out. NOTHING here invents a
// payload id: we send a slot and a verb, and copy.ts builds the
// `<action>:<case_uuid>` the webhook routes on. That is the whole reason a
// label can be handed to an intern.

function emptyButtons() {
  return { quick: [], cta: null, footer: '' };
}

/** Server shape -> editor shape. Tolerant, because it also reads history rows. */
function toEditorButtons(raw) {
  const b = emptyButtons();
  if (!raw || typeof raw !== 'object') return b;
  for (const q of raw.quick_replies || []) {
    const slot = Number(q?.slot);
    b.quick.push({
      slot: Number.isInteger(slot) ? slot : 0,
      action: String(q?.action ?? ''),
      title: String(q?.title ?? ''),
    });
  }
  b.quick.sort((x, y) => x.slot - y.slot);
  if (raw.cta_url) {
    b.cta = { display_text: String(raw.cta_url.display_text ?? ''), url: String(raw.cta_url.url ?? '') };
  }
  b.footer = String(raw.footer ?? '');
  return b;
}

/**
 * Editor shape -> the wire. Returns null when there is nothing to carry, which
 * is exactly what the server's parseButtons returns for the same input, so the
 * two compare clean and "no buttons" has one representation on both sides.
 */
function buttonsPayload(b) {
  if (!b) return null;
  // The same tidy-up parseButtons does on the server. Doing it here as well is
  // what makes "has anything changed" answerable: otherwise a trailing space
  // the server silently trims leaves Publish lit up for ever.
  const tidy = (s) => String(s ?? '').replace(/[\n\r\t]+/g, ' ').trim();
  const out = {};
  // A half-added row (an action chosen, no label yet) is sent as it stands. The
  // server drops it and says so in red; hiding it here would let somebody
  // publish a message whose third button quietly never existed.
  const quick = b.quick.filter((q) => q.action || tidy(q.title));
  if (quick.length) out.quick_replies = quick.map((q) => ({ slot: q.slot, action: q.action, title: tidy(q.title) }));
  if (b.cta && (tidy(b.cta.url) || tidy(b.cta.display_text))) {
    out.cta_url = { display_text: tidy(b.cta.display_text), url: tidy(b.cta.url) };
  }
  const foot = tidy(b.footer);
  if (foot) out.footer = foot;
  return Object.keys(out).length ? out : null;
}

/** One string per state of the buttons, for every "has this changed" test. */
function buttonsJson(b) {
  return JSON.stringify(buttonsPayload(b));
}

/** Is there anything tappable? A footer on its own is not a button. */
function hasTappable(b) {
  const p = buttonsPayload(b);
  return !!p && (!!p.quick_replies?.length || !!p.cta_url);
}

function liveButtons(def, lang) {
  return def.rows?.[lang]?.published_buttons ?? null;
}

/** What the editor opens with: the saved draft's buttons, else what is live. */
function openingButtons(def, lang) {
  const row = def.rows?.[lang] || {};
  return toEditorButtons(row.draft_buttons ?? row.published_buttons ?? null);
}

/**
 * 0, 1, 2. The slot is the JOIN between the English row and the Hindi one: it
 * is what lets somebody retitle three buttons in Hindi without being able to
 * reorder them. A new button takes the lowest free slot and nothing renumbers.
 */
function freeSlot(b) {
  const taken = new Set(b.quick.map((q) => q.slot));
  for (let i = 0; i < waLimit('BUTTON_MAX'); i++) if (!taken.has(i)) return i;
  return null;
}

function actionMeta(action) {
  return (S?.data?.button_actions || []).find((a) => a.action === action) || null;
}

/**
 * The verb points at the wrong reader. Not a blocker (a group message legitimately
 * carries a nurse's button), but the single most expensive mistake available on
 * this panel, so it is said out loud under the control.
 */
function actionMismatch(def, action) {
  const meta = actionMeta(action);
  if (!meta || meta.needs === 'any') return null;
  const group = AUDIENCE_GROUP[def.audience];
  if (!group || group === meta.needs) return null;
  return `This action answers for ${AUDIENCE_WORDS[meta.needs] || meta.needs}, and this message goes to ${AUDIENCE_WORDS[def.audience] || def.audience}.`;
}

function isCustomised(def) {
  return def.languages.some((l) => (def.rows?.[l]?.version ?? 0) > 0 && def.rows?.[l]?.published_body);
}
function hasDraft(def) {
  return def.languages.some((l) => def.rows?.[l]?.dirty);
}

function whoLine(def) {
  const who = AUDIENCE_WORDS[def.audience] || `the ${def.audience}`;
  return `Goes to ${who}.`;
}

/**
 * Unsaved TYPING. The picture is deliberately not in here: attaching or
 * removing one writes the draft immediately, so it is never in the "in this box
 * only" state that this flag warns about. The buttons are, because they are
 * text somebody is in the middle of writing.
 */
function paneDirty(p) {
  return p.body !== p.baseline || buttonsJson(p.buttons) !== p.buttonsBaseline;
}

/** Everything a Publish would change: words, picture and buttons together. */
function paneSameAsLive(p) {
  return p.body === liveBody(p.def, p.lang)
    && (p.imagePath ?? null) === (p.row.published_image_path ?? null)
    && buttonsJson(p.buttons) === JSON.stringify(liveButtons(p.def, p.lang));
}

/** Any unsaved typing at all, including on a message the user clicked away from. */
function anyPaneDirty() {
  if (!S) return false;
  const groups = [S.panes, ...[...S.paneCache.values()].map((c) => c.panes)];
  return groups.some((g) => g && Object.values(g).some(paneDirty));
}

// ════════════════════════════════════════════════ data

async function loadAll() {
  const res = await adminAction('list_copy');
  if (!res?.ok) throw new Error(res?.error || 'Could not load the message list');
  return res;
}

/** Pull one key's rows back after a write, so the badges and versions are true. */
async function refreshKey(key) {
  try {
    const res = await adminAction('list_copy', { keys: [key] });
    const fresh = res?.keys?.[0];
    if (!fresh) return null;
    const idx = S.data.keys.findIndex((k) => k.key === key);
    if (idx >= 0) S.data.keys[idx] = fresh;
    S.byKey.set(key, fresh);
    adoptFresh(fresh);
    return fresh;
  } catch (err) {
    console.error('[copy] key refresh failed:', key, err);
    return null;
  }
}

/**
 * Hand the reloaded key def to BOTH language panes. Publishing the English
 * body bumps nothing in the Hindi row, but it does change the key-level badges,
 * and a pane holding last minute's def would draw "Built-in wording" over a
 * message that is now customised.
 * `expected` is deliberately left alone: it is the version THIS editor loaded,
 * and moving it under the editor is exactly how one admin silently overwrites
 * another.
 */
function adoptFresh(fresh) {
  if (!fresh || !S?.panes) return;
  for (const q of Object.values(S.panes)) {
    if (q.def.key !== fresh.key) continue;
    q.def = fresh;
    q.row = fresh.rows?.[q.lang] || q.row;
  }
}

// ════════════════════════════════════════════════ page entry

export default async function render(container, params = {}) {
  injectStyles();

  S = {
    container,
    data: null,
    byKey: new Map(),
    sel: null,          // selected key string
    panes: null,        // { en: pane, hi: pane } for the selected key
    paneCache: new Map(),  // key -> { panes, samples }, so a click away is lossless
    sampleOverrides: {},
    filters: { q: '', audience: '', mode: 'all' },
    wanted: params?.id || null,
  };

  container.innerHTML = `
    <div class="cp-top">
      <div class="skeleton skeleton-row" style="width:260px"></div>
    </div>
    <div class="cp-wrap">
      <div class="cp-list">${'<div class="skeleton skeleton-row"></div>'.repeat(8)}</div>
      <div class="card">${'<div class="skeleton skeleton-row"></div>'.repeat(6)}</div>
    </div>`;

  try {
    S.data = await loadAll();
  } catch (err) {
    console.error('[copy] load failed:', err);
    container.innerHTML = `
      <div class="empty-state">
        ${icon('alertCircle')}
        <h3>Couldn't load the messages</h3>
        <p>${escapeHtml(err.message || 'Unknown error')}</p>
        <button class="btn btn-secondary" data-retry>Try again</button>
      </div>`;
    container.querySelector('[data-retry]')?.addEventListener('click', () => render(container, params));
    return;
  }

  // The route may have changed while the list was loading.
  if (!container.isConnected) return;

  for (const k of S.data.keys) S.byKey.set(k.key, k);
  renderShell();

  const first = (S.wanted && S.byKey.has(S.wanted)) ? S.wanted : S.data.keys[0]?.key;
  if (first) selectKey(first, { replaceHash: false });
}

function renderShell() {
  const total = S.data.keys.length;
  const edited = S.data.keys.filter(isCustomised).length;
  const drafts = S.data.keys.filter(hasDraft).length;
  const auds = [...new Set(S.data.keys.map((k) => k.audience))];

  S.container.innerHTML = `
    ${S.data.overrides_enabled ? '' : `
      <div class="warn-banner">
        ${icon('alertTriangle')}
        <p><strong>Message customisation is switched off.</strong> Everything published on this page is being ignored right now and the built-in wording is going out instead. Turn the <code>copy_overrides</code> toggle back on before you rely on an edit here.</p>
      </div>`}
    <div class="cp-top">
      <div class="table-search">
        ${icon('search')}
        <input class="form-input" type="search" placeholder="Search a message, a word, a key" data-q aria-label="Search messages" />
      </div>
      <select class="form-select" data-audience aria-label="Filter by who receives the message">
        <option value="">Everyone</option>
        ${auds.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(AUDIENCE_WORDS[a] || a)}</option>`).join('')}
      </select>
      <div class="cp-seg" role="group" aria-label="Filter by state">
        <button type="button" data-mode="all" aria-pressed="true">All ${total}</button>
        <button type="button" data-mode="edited" aria-pressed="false">Customised ${edited}</button>
        <button type="button" data-mode="draft" aria-pressed="false">Unpublished drafts ${drafts}</button>
      </div>
      <button class="btn btn-secondary btn-sm" data-reload>${icon('refresh')} Reload</button>
    </div>
    <div class="cp-wrap">
      <div class="cp-list" id="cp-list" role="listbox" aria-label="Messages"></div>
      <div class="cp-work" id="cp-work"></div>
    </div>`;

  const q = S.container.querySelector('[data-q]');
  q.addEventListener('input', () => { S.filters.q = q.value.trim().toLowerCase(); renderList(); });
  S.container.querySelector('[data-audience]').addEventListener('change', (e) => {
    S.filters.audience = e.currentTarget.value; renderList();
  });
  S.container.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      S.filters.mode = btn.getAttribute('data-mode');
      S.container.querySelectorAll('[data-mode]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b === btn));
      });
      renderList();
    });
  });
  S.container.querySelector('[data-reload]').addEventListener('click', () => {
    const again = () => render(S.container, { id: S.sel });
    if (!anyPaneDirty()) { again(); return; }
    confirmModal(
      'There are changes in the editor that have not been saved. Reloading throws them away.',
      again,
      { title: 'Reload and lose the changes?', confirmLabel: 'Reload anyway', danger: true },
    );
  });

  renderList();
  // renderShell also runs on "clear filters", which blanks #cp-work. Put the
  // open message back rather than leaving an empty half-page behind.
  if (S.sel && S.panes) renderEditor();
}

// ════════════════════════════════════════════════ the list

function matchesFilters(def) {
  const f = S.filters;
  if (f.audience && def.audience !== f.audience) return false;
  if (f.mode === 'edited' && !isCustomised(def)) return false;
  if (f.mode === 'draft' && !hasDraft(def)) return false;
  if (!f.q) return true;
  const hay = [
    def.key, def.label, def.label_hi, def.description, def.description_hi,
    AUDIENCE_WORDS[def.audience], def.defaults?.en, def.defaults?.hi,
    def.rows?.en?.published_body, def.rows?.hi?.published_body,
    def.rows?.en?.draft_body, def.rows?.hi?.draft_body,
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(f.q);
}

function renderList() {
  const el = S.container.querySelector('#cp-list');
  if (!el) return;
  const shown = S.data.keys.filter(matchesFilters);

  if (!shown.length) {
    el.innerHTML = `
      <div class="empty-state" style="padding:var(--s6) var(--s3)">
        <h3>Nothing matches</h3>
        <p>No message matches that search or filter.</p>
        <button class="btn btn-secondary btn-sm" data-clear>Clear filters</button>
      </div>`;
    el.querySelector('[data-clear]')?.addEventListener('click', () => {
      S.filters = { q: '', audience: '', mode: 'all' };
      renderShell();
    });
    return;
  }

  // Journey order, straight from the server's STAGES array. Alphabetical would
  // put "arrive" before "offer", which is backwards in every real conversation.
  const order = S.data.stages;
  const byStage = new Map();
  for (const def of shown) {
    if (!byStage.has(def.stage)) byStage.set(def.stage, []);
    byStage.get(def.stage).push(def);
  }

  let html = '';
  for (const stage of order) {
    const group = byStage.get(stage);
    if (!group || !group.length) continue;
    html += `<div class="cp-stage">${escapeHtml(S.data.stage_header[stage] || stage)}</div>`;
    for (const def of group) {
      const flags = [];
      if (def.locked) flags.push('<span class="cp-tag locked">locked</span>');
      if (def.status === 'retired') flags.push('<span class="cp-tag retired">retired</span>');
      if (isCustomised(def)) flags.push('<span class="cp-tag edited">edited</span>');
      if (hasDraft(def)) flags.push('<span class="cp-tag draft">draft</span>');
      html += `
        <button class="cp-row" type="button" role="option" data-key="${escapeHtml(def.key)}"
                aria-current="${def.key === S.sel}" aria-selected="${def.key === S.sel}">
          <span class="cp-row-emoji" aria-hidden="true">${AUDIENCE_EMOJI[def.audience] || '💬'}</span>
          <span class="cp-row-main">
            <span class="cp-row-title">${escapeHtml(def.label)}</span>
            <span class="cp-row-sub">${escapeHtml(whoLine(def))} ${escapeHtml(def.description || '')}</span>
          </span>
          <span class="cp-row-flags">${flags.join('')}</span>
        </button>`;
    }
  }
  el.innerHTML = html;

  el.querySelectorAll('[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => selectKey(btn.getAttribute('data-key')));
  });
}

function selectKey(key, { replaceHash = true } = {}) {
  if (key === S.sel) return;
  const def = S.byKey.get(key);
  if (!def) return;

  // Panes are CACHED per key for the life of the page. Clicking another message
  // and coming back must not throw away half a rewritten Hindi paragraph, and a
  // "you have unsaved changes" dialog on every click is the kind of friction
  // that makes people stop exploring. Unsaved work is still called out in the
  // status line under each language, because only Save survives a refresh.
  if (S.sel) S.paneCache.set(S.sel, { panes: S.panes, samples: S.sampleOverrides });
  S.sel = key;
  const cached = S.paneCache.get(key);
  if (cached) {
    S.panes = cached.panes;
    S.sampleOverrides = cached.samples;
    // Somebody may have published this key from another pane since. Take the
    // rows, keep the typing.
    for (const q of Object.values(S.panes)) {
      q.def = def;
      q.row = def.rows?.[q.lang] || q.row;
    }
  } else {
    S.sampleOverrides = {};
    S.panes = {};
    for (const lang of def.languages) S.panes[lang] = makePane(def, lang);
  }

  // replaceState, not location.hash: assigning the hash fires hashchange and the
  // router would re-run this whole page, throwing away the editor mid-edit.
  if (replaceHash) {
    try { history.replaceState(null, '', `#copy/${key}`); } catch { /* private mode */ }
  }
  S.container.querySelectorAll('.cp-row').forEach((r) => {
    const on = r.getAttribute('data-key') === key;
    r.setAttribute('aria-current', String(on));
    r.setAttribute('aria-selected', String(on));
  });
  renderEditor();
}

function makePane(def, lang) {
  const row = def.rows?.[lang] || {};
  const body = openingBody(def, lang);
  const buttons = openingButtons(def, lang);
  return {
    def, lang, row,
    body,
    baseline: body,             // what is stored right now, for the unsaved dot
    imagePath: row.draft_image_path ?? row.published_image_path ?? null,
    imageUrl: null,
    imageBusy: false,
    imageBytes: null,           // known for a picture attached in this session
    imageWarn: null,            // "that picture is 16 by 16", measured in the browser
    mediaBusy: false,
    buttons,
    buttonsBaseline: buttonsJson(buttons),
    expected: row.version ?? 0,
    validation: null,
    previewBusy: false,
    previewError: null,
    seq: 0,
    timer: null,
    ai: { busy: false, result: null, error: null },
    test: null,                 // the last test send's result, drawn under the buttons
    history: null,
    historyBusy: false,
  };
}

// ════════════════════════════════════════════════ the editor

function renderEditor() {
  const work = S.container.querySelector('#cp-work');
  if (!work) return;
  const def = S.byKey.get(S.sel);
  if (!def) { work.innerHTML = ''; return; }

  const vars = def.vars || [];
  work.innerHTML = `
    <div class="card cp-head">
      <div class="cp-head-top">
        <div style="min-width:0">
          <h2>${escapeHtml(def.label)}</h2>
          <div class="cp-who">${escapeHtml(whoLine(def))}</div>
          <div class="cp-desc">${escapeHtml(def.description || '')}</div>
        </div>
        <div style="text-align:right;flex:none">
          ${def.locked ? '<span class="badge badge-neutral">Locked</span>' : ''}
          ${def.status === 'retired' ? '<span class="badge badge-danger">Retired</span>' : ''}
          ${def.status === 'blocked' ? '<span class="badge badge-danger">Not sending</span>' : ''}
          ${isCustomised(def) ? '<span class="badge badge-success">Customised</span>' : '<span class="badge badge-neutral">Built-in wording</span>'}
        </div>
      </div>
      <div class="cp-head-meta">
        <span>${escapeHtml(def.key)}</span>
        <span>sends as ${escapeHtml(def.surface)}</span>
        ${def.template ? `<span>falls back to template ${escapeHtml(def.template)}</span>` : '<span>no template fallback</span>'}
        ${def.sites?.length ? `<span>from ${escapeHtml(def.sites.join(', '))}</span>` : ''}
      </div>
      ${def.notes ? `<div class="cp-desc" style="margin-top:10px">${escapeHtml(def.notes)}</div>` : ''}
      ${def.status === 'retired' ? `
        <div class="warn-banner" style="margin:var(--s3) 0 0">
          ${icon('alertTriangle')}
          <p>Nothing sends this message any more, so an edit here reaches nobody.</p>
        </div>` : ''}
      ${vars.length ? `
        <details class="cp-samples">
          <summary>Preview values (change these to see how the message looks with a longer name or a blank field)</summary>
          <div class="cp-sample-grid">
            ${vars.map((v) => `
              <div>
                <label for="cp-s-${escapeHtml(v)}">${escapeHtml(v)}</label>
                <input class="form-input" id="cp-s-${escapeHtml(v)}" type="text" data-sample="${escapeHtml(v)}"
                       placeholder="${escapeHtml(String(def.sample_vars?.[v] ?? ''))}" />
              </div>`).join('')}
          </div>
          <div class="cp-chips-hint" style="margin-top:var(--s3)">Leave a box empty to use the sample value shown in grey. Type a space to see what happens when we have no value at all.</div>
        </details>` : ''}
      <details class="cp-help">
        <summary>How this page works (30 seconds)</summary>
        <ul>
          <li><b>The grey boxes like {{patient_name}} are variables.</b> They are filled in with the real name, date or code when the message is sent. Click a chip to drop one in; never type one by hand.</li>
          <li><b>Save draft is safe. Publish is not.</b> A draft is a scratchpad nobody receives. Publish is what real families and nurses start reading from the next message onward.</li>
          <li><b>Revert to built-in</b> puts the message back to the wording that ships in the code. Nothing is lost, and it can be published again later.</li>
          <li><b>The 24 hour window.</b> If someone has not written to us in the last 24 hours, WhatsApp only lets us send an approved template, and this wording is squeezed into one line with no picture and no buttons. That flattened line is shown under the phone.</li>
          <li><b>A picture and buttons are part of the message.</b> They are edited under the words, they show up in the phone preview where WhatsApp puts them, and they go live with the same Publish. A button's label is yours to write; what the button does is picked from a list, so no wording change can break it.</li>
          <li><b>Send a test to a phone</b> before you publish. It sends exactly what you are looking at to one number, touches no case, and tells you what really happened.</li>
        </ul>
      </details>
    </div>
    <div class="cp-langs" id="cp-langs"></div>`;

  work.querySelectorAll('[data-sample]').forEach((input) => {
    input.addEventListener('input', () => {
      const name = input.getAttribute('data-sample');
      const v = input.value;
      if (v === '') delete S.sampleOverrides[name];
      else S.sampleOverrides[name] = v;
      for (const p of Object.values(S.panes)) schedulePreview(p);
    });
  });

  const langs = work.querySelector('#cp-langs');
  for (const lang of def.languages) {
    const section = document.createElement('section');
    section.className = 'cp-lang';
    section.setAttribute('data-lang', lang);
    langs.appendChild(section);
    renderPane(section, S.panes[lang]);
  }

  // A key with no Hindi row says so where the Hindi column would have been,
  // instead of leaving the intern to wonder whether it is missing or broken.
  if (!def.languages.includes('hi')) {
    const note = document.createElement('section');
    note.className = 'cp-lang';
    note.innerHTML = `
      <div class="cp-lang-head"><span class="cp-lang-name">Hindi</span></div>
      <p style="font:var(--t-sm);color:var(--ink-3)">
        This message has no Hindi version. It goes to ${escapeHtml(AUDIENCE_WORDS[def.audience] || def.audience)},
        who read the English one, so a Hindi body here would never be sent.
      </p>`;
    langs.appendChild(note);
  }
}

function renderPane(el, p) {
  const def = p.def;
  const row = p.row;
  const readOnly = def.locked || def.status === 'blocked';
  // THE EFFECTIVE capabilities, decided by admin-actions and not by the raw
  // registry flag. Every one of the 183 registry keys ships allows_image:false,
  // so a page reading that flag hid the upload box on every message in
  // production and the whole feature was dead. list_copy sends the computed
  // answer as image_capable / buttons_capable, with a sentence saying why when
  // the answer is no.
  const allowsImage = !!(def.image_capable ?? def.allows_image);
  const allowsButtons = !!def.buttons_capable;

  el.innerHTML = `
    <div class="cp-lang-head">
      <span class="cp-lang-name">${LANG_LABEL[p.lang] || p.lang}</span>
      ${(row.version ?? 0) > 0 && row.published_body
        ? `<span class="badge badge-success">Customised v${row.version}</span>`
        : '<span class="badge badge-neutral">Built-in wording</span>'}
      <div class="cp-state" data-state></div>
    </div>

    ${def.vars?.length ? `
      <div class="cp-chips" data-chips>
        ${def.vars.map((v) => `
          <button type="button" class="cp-chip ${def.required_vars?.includes(v) ? 'req' : ''}"
                  data-var="${escapeHtml(v)}"
                  title="${escapeHtml(S.data.variables?.[v]?.describes || v)}">
            {{${escapeHtml(v)}}}
          </button>`).join('')}
      </div>
      <div class="cp-chips-hint">Click one to drop it in where the cursor is. These are the only variables this message is given a value for.</div>`
      : '<div class="cp-chips-hint">This message takes no variables. Everything in it is fixed wording.</div>'}

    <textarea class="form-input cp-ta" data-ta spellcheck="true" maxlength="${DRAFT_MAX_CHARS}"
              aria-label="${LANG_LABEL[p.lang]} message body" ${readOnly ? 'disabled' : ''}>${escapeHtml(p.body)}</textarea>
    <div class="cp-meter" data-meter></div>
    <div data-issues></div>

    ${allowsImage ? `
      <div class="cp-block" data-imgblock>
        <h4>Picture</h4>
        <div class="cp-chips-hint">
          A JPG or PNG, up to 5 MB. It sits above the words, exactly as it does in the preview below, and the words become its caption.
          It is delivered inside the 24 hour window only: to somebody who has not written to us since yesterday
          ${def.template
            ? `this goes out as the approved <b>${escapeHtml(def.template)}</b> template, which has no picture in it at all`
            : 'this goes out as an approved template, which has no picture in it at all'},
          so the words still arrive and the picture does not. Keep them complete on their own.
        </div>
        <div data-img></div>
        <input type="file" accept="${IMAGE_ACCEPT}" style="display:none" data-file
               aria-label="Choose a picture for this message" />
      </div>`
      : `
      <div class="cp-block-off">
        <h4>Picture</h4>
        <p>${escapeHtml(def.image_reason || `This one cannot carry a picture: it goes out as a ${def.surface}, which has no image slot.`)}</p>
      </div>`}

    ${allowsButtons ? `
      <div class="cp-block" data-btnblock>
        <h4>Buttons under the message</h4>
        <div class="cp-chips-hint">
          Up to ${waLimit('BUTTON_MAX')} tappable reply buttons, or one link button, never both.
          You pick what a button <b>does</b> from the list and write what it <b>says</b>, so the Hindi label and the English label always do the same thing and no wording change can break a tap.
          Buttons only reach somebody who has written to us in the last 24 hours:
          ${def.template
            ? `after that this message goes out as the approved <b>${escapeHtml(def.template)}</b> template and the buttons are dropped`
            : 'after that this message goes out as an approved template and the buttons are dropped'},
          so the words have to tell the reader what to reply.
        </div>
        <div data-btns></div>
      </div>`
      : `
      <div class="cp-block-off">
        <h4>Buttons under the message</h4>
        <p>${escapeHtml(def.buttons_reason || 'This message cannot carry buttons.')}</p>
      </div>`}

    <div class="cp-phone">
      <div class="cp-phone-bar">
        <span class="av" aria-hidden="true">${AUDIENCE_EMOJI[def.audience] || '💬'}</span>
        <div>
          <div class="who">${escapeHtml(capitaliseFirst(AUDIENCE_WORDS[def.audience] || def.audience))}</div>
          <div class="sub">WhatsApp ${escapeHtml(LANG_LABEL[p.lang] || p.lang)}</div>
        </div>
        <span class="flag">preview</span>
      </div>
      <div class="cp-chatpane" data-chat></div>
      <div class="cp-phone-foot" data-foot></div>
    </div>

    <details class="cp-fold" data-flat>
      <summary>Outside the 24 hour window this goes out as one flat line</summary>
      <div class="cp-fold-body">
        <div class="cp-pre" data-flatbody></div>
        <div class="cp-chips-hint" style="margin-top:8px" data-flatlost></div>
      </div>
    </details>

    <details class="cp-fold">
      <summary>Compare with the built-in wording</summary>
      <div class="cp-fold-body">
        <div class="cp-pre">${tokenHtml(def.defaults?.[p.lang] ?? '')}</div>
        <div class="cp-chips-hint" style="margin-top:8px">This is what ships in the code. It is what you go back to if you press Revert.</div>
        <button class="btn btn-secondary btn-sm" style="margin-top:8px" data-load-default>Load this into the editor</button>
      </div>
    </details>

    ${readOnly ? '' : `
      <details class="cp-fold cp-ai">
        <summary>Ask the writing assistant for a draft</summary>
        <div class="cp-fold-body">
          <div class="cp-ai-presets">
            ${AI_PRESETS.map((t) => `<button type="button" data-preset="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
          </div>
          <textarea class="form-input" data-ai-in placeholder="Tell it what to change, in your own words. For example: make this warmer and shorter."></textarea>
          <div style="display:flex;gap:var(--s2);margin-top:var(--s2)">
            <button class="btn btn-secondary btn-sm" data-ai-go>Write me a draft</button>
            <span class="cp-chips-hint" style="margin:0;align-self:center">It comes back as a draft. Nothing is saved or sent until you say so.</span>
          </div>
          <div data-ai-out></div>
        </div>
      </details>`}

    <div class="cp-actions" data-actions></div>
    <div data-testout></div>

    <details class="cp-fold" data-hist>
      <summary>History</summary>
      <div class="cp-fold-body" data-hist-body></div>
    </details>`;

  // ---- wiring ----
  const ta = el.querySelector('[data-ta]');
  if (ta && !readOnly) {
    ta.addEventListener('input', () => {
      p.body = ta.value;
      paintState(p);
      paintMeter(p);
      paintActions(p);
      schedulePreview(p);
    });
    ta.addEventListener('keydown', (e) => {
      // Ctrl/Cmd+S saves the draft, because that is what every hand expects and
      // the browser's own Save dialog helps nobody here.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveDraft(p);
      }
    });
  }

  el.querySelectorAll('[data-var]').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (readOnly || !ta) return;
      insertAtCursor(ta, `{{${chip.getAttribute('data-var')}}}`);
      p.body = ta.value;
      paintState(p); paintMeter(p); paintActions(p); schedulePreview(p);
    });
  });

  el.querySelector('[data-load-default]')?.addEventListener('click', () => {
    if (readOnly || !ta) return;
    ta.value = def.defaults?.[p.lang] ?? '';
    p.body = ta.value;
    paintState(p); paintMeter(p); paintActions(p); schedulePreview(p);
    ta.focus();
    showToast('Built-in wording loaded into the editor. Nothing is published yet.', 'info');
  });

  el.querySelectorAll('[data-preset]').forEach((b) => {
    b.addEventListener('click', () => {
      const input = el.querySelector('[data-ai-in]');
      if (input) { input.value = b.getAttribute('data-preset'); input.focus(); }
    });
  });
  el.querySelector('[data-ai-go]')?.addEventListener('click', () => askGemini(p, el));

  const histDetails = el.querySelector('[data-hist]');
  histDetails?.addEventListener('toggle', () => {
    if (histDetails.open && p.history === null && !p.historyBusy) loadHistory(p);
  });

  if (allowsImage) {
    const file = el.querySelector('[data-file]');
    file?.addEventListener('change', () => {
      const f = file.files && file.files[0];
      // Cleared BEFORE the upload starts, so choosing the same file twice in a
      // row still fires a change event.
      file.value = '';
      if (f) uploadImage(p, f);
    });

    // Drag and drop, wired on the block rather than on the drop zone: the zone
    // is repainted on every state change and would lose its listeners, the
    // block is not. dragover must preventDefault or the browser navigates to
    // the file instead of handing it to us.
    const block = el.querySelector('[data-imgblock]');
    const zone = () => el.querySelector('[data-drop-zone]');
    block?.addEventListener('dragover', (e) => {
      if (readOnly) return;
      e.preventDefault();
      zone()?.classList.add('over');
    });
    block?.addEventListener('dragleave', () => zone()?.classList.remove('over'));
    block?.addEventListener('drop', (e) => {
      e.preventDefault();
      zone()?.classList.remove('over');
      if (readOnly) return;
      const f = e.dataTransfer?.files?.[0];
      if (f) uploadImage(p, f);
    });
  }

  // p.el must be set before any paint*: every one of them queries through it.
  p.el = el;
  paintState(p);
  paintMeter(p);
  paintIssues(p);
  paintActions(p);
  paintImage(p);
  paintButtons(p);
  paintTest(p);
  paintPreview(p);
  schedulePreview(p);
}

function capitaliseFirst(s) {
  const t = String(s || '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function insertAtCursor(ta, text) {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const caret = start + text.length;
  ta.focus();
  ta.setSelectionRange(caret, caret);
}

/** Put the cursor on the line an issue points at, and select it. */
function focusLine(p, lineNo) {
  const ta = p.el?.querySelector('[data-ta]');
  if (!ta) return;
  const lines = ta.value.split('\n');
  let start = 0;
  for (let i = 0; i < lineNo - 1 && i < lines.length; i++) start += lines[i].length + 1;
  const end = start + (lines[lineNo - 1]?.length ?? 0);
  ta.focus();
  ta.setSelectionRange(start, end);
}

// ════════════════════════════════════════════════ painting (no full re-render)

function paintState(p) {
  const el = p.el?.querySelector('[data-state]');
  if (!el) return;
  const row = p.row;
  const bits = [];
  if ((row.version ?? 0) > 0 && row.published_body) {
    bits.push(`Live: your wording, version ${row.version}, published by <b>${escapeHtml(row.published_by_name || 'someone')}</b> ${escapeHtml(formatRelativeTime(row.published_at))}.`);
  } else if ((row.version ?? 0) > 0) {
    bits.push(`Live: the built-in wording (this key was reverted at version ${row.version}).`);
  } else {
    bits.push('Live: the built-in wording that ships in the code.');
  }
  if (paneDirty(p)) bits.push('<span class="unsaved">Unsaved changes in this box.</span>');
  else if (!paneSameAsLive(p)) bits.push('Draft saved. Not published yet, so nobody is reading it.');
  const stat = p.def.stats?.[p.lang];
  if (stat && stat.sent_count != null) bits.push(`Sent ${stat.sent_count} times in the last ${stat.window_days ?? 30} days.`);
  el.innerHTML = bits.join(' ');
}

function paintMeter(p) {
  const el = p.el?.querySelector('[data-meter]');
  if (!el) return;
  const max = p.def.max_chars?.[p.lang] || p.def.hard_cap || 4096;
  // Adding a button changes the limit. A plain bubble holds 4096 characters,
  // the interactive one that carries chips holds 1024, and past that the sender
  // keeps the words and throws the buttons away. Say so on the counter rather
  // than in a red line somebody reads afterwards.
  const withButtons = !!p.def.buttons_capable && hasTappable(p.buttons);
  const hard = withButtons ? waLimit('BODY_MAX') : (p.def.hard_cap || 4096);
  const n = p.body.length;
  const pct = Math.min(100, Math.round((n / max) * 100));
  const cls = n > hard ? 'bad' : n > max ? 'warn' : '';
  const rendered = p.validation?.rendered_chars;
  el.innerHTML = `
    <span>${n} / ${max} typed</span>
    <span class="cp-bar ${cls}"><i style="width:${pct}%"></i></span>
    ${rendered != null ? `<span>${rendered} with real values</span>` : ''}
    <span title="${withButtons
      ? 'A message with buttons under it is an interactive message, and WhatsApp stops one of those here'
      : `WhatsApp cuts a ${escapeHtml(p.def.surface)} message here`}">
      ${withButtons ? `with buttons, WhatsApp stops at ${hard}` : `WhatsApp cuts at ${hard}`}
    </span>`;
}

function paintIssues(p) {
  const el = p.el?.querySelector('[data-issues]');
  if (!el) return;
  if (p.previewError) {
    el.innerHTML = `<div class="cp-issue warn">${icon('alertTriangle')}<span>Could not check this wording just now (${escapeHtml(p.previewError)}). Your text is safe; try again in a moment.</span></div>`;
    return;
  }
  const issues = p.validation?.issues || [];
  if (!issues.length) {
    el.innerHTML = p.validation
      ? `<div class="cp-ok">${icon('checkCircle')} Reads clean. Nothing here would break on a phone.</div>`
      : '';
    return;
  }
  el.innerHTML = `<div class="cp-issues">${issues.map((iss, n) => {
    const tag = issueTag(iss);
    return `
    <div class="cp-issue ${iss.level === 'error' ? 'error' : 'warn'}">
      ${icon(iss.level === 'error' ? 'alertCircle' : 'alertTriangle')}
      ${tag ? `<span class="field">${escapeHtml(tag)}</span>` : ''}
      <span>${escapeHtml(iss.message)}</span>
      ${iss.line ? `<button type="button" data-goto="${n}">line ${iss.line}</button>`
        : iss.field ? `<button type="button" data-goto="${n}">show me</button>` : ''}
    </div>`;
  }).join('')}</div>`;
  el.querySelectorAll('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => {
      const iss = issues[Number(b.getAttribute('data-goto'))];
      if (!iss) return;
      if (iss.line) focusLine(p, iss.line);
      else focusField(p, iss);
    });
  });
}

// An issue about the picture or a button is not about a line of text, so it
// carries a `field` (and a `slot` for a button) instead of a line number.
const FIELD_WORDS = {
  image: 'Picture',
  footer: 'Footer line',
  cta_url: 'Link button',
  button: 'Buttons',
};
function issueTag(iss) {
  if (!iss?.field) return null;
  if (iss.field === 'button' && Number.isInteger(iss.slot)) return `Button ${iss.slot + 1}`;
  return FIELD_WORDS[iss.field] || null;
}

/** Put the person in front of the control the issue is about. */
function focusField(p, iss) {
  const el = p.el;
  if (!el) return;
  let target = null;
  if (iss.field === 'button' && Number.isInteger(iss.slot)) target = el.querySelector(`[data-btn-title="${iss.slot}"]`);
  if (!target && iss.field === 'button') target = el.querySelector('[data-btnblock]');
  if (iss.field === 'cta_url') target = el.querySelector('[data-cta-url]');
  if (iss.field === 'footer') target = el.querySelector('[data-footer]');
  if (iss.field === 'image') target = el.querySelector('[data-imgblock]');
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (typeof target.focus === 'function' && target.tagName === 'INPUT') target.focus();
}

function paintPreview(p) {
  const chat = p.el?.querySelector('[data-chat]');
  const foot = p.el?.querySelector('[data-foot]');
  if (!chat) return;

  const settled = !!p.validation && !p.previewBusy;
  const text = settled
    ? p.validation.rendered
    : localRender(p.body, { ...(p.def.sample_vars || {}), ...S.sampleOverrides });

  // The bucket is private, so the thumbnail arrives one signed URL later. The
  // picture is part of the message from the moment it is attached, so the
  // BUBBLE reserves its place immediately: waiting for the URL would make the
  // preview lie for a second and then jump.
  const hasImg = !!p.imagePath && !!(p.def.image_capable ?? p.def.allows_image);
  const img = !hasImg ? ''
    : p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="The picture attached to this message" />`
      : '<div class="cp-imgwait"></div>';

  const btns = p.def.buttons_capable ? buttonsPayload(p.buttons) : null;
  const quick = btns?.quick_replies || [];
  const cta = btns?.cta_url || null;
  const footer = btns?.footer || '';
  const tappable = !!quick.length || !!cta;

  // sendCopy's own decision, DRAWN rather than described. A bubble that carries
  // buttons is capped at 1024 characters where a plain one holds 4096, and the
  // words always win: past 1024 the buttons come off entirely, and a picture
  // stops being a caption and arrives as its own bubble just before the words.
  const bodyMax = waLimit('BODY_MAX');
  const over = String(text || '').length > bodyMax;
  const dropButtons = tappable && over;
  const splitImage = hasImg && over;
  const stamp = `<div class="cp-bubble-meta">${escapeHtml(formatTime(new Date().toISOString()))}`
    + `<span class="cp-ticks">&#10003;&#10003;</span></div>`;

  if (!String(text || '').trim()) {
    chat.innerHTML = `<div class="cp-out"><div class="cp-bubble" style="opacity:.6"><em>This renders to nothing, so the reader would get a blank message.</em></div></div>`;
  } else {
    let html = '';
    if (splitImage) {
      html += `<div class="cp-out"><div class="cp-bubble ${settled ? '' : 'checking'}">${img}${stamp}</div></div>`;
    }
    const drawButtons = tappable && !dropButtons;
    html += `<div class="cp-out ${drawButtons ? 'hasbtn' : ''}">`
      + `<div class="cp-bubble ${settled ? '' : 'checking'}">${splitImage ? '' : img}`
      + `<div class="cp-bubble-text">${waHtml(text)}</div>`
      + (footer && drawButtons ? `<div class="cp-bubble-foot">${escapeHtml(footer)}</div>` : '')
      + stamp + '</div>';
    if (drawButtons) {
      html += '<div class="cp-btns">';
      for (const q of quick) {
        html += q.title
          ? `<div class="b">${escapeHtml(q.title)}</div>`
          : `<div class="b blank">this button has no label yet</div>`;
      }
      if (cta) {
        html += `<div class="b">${icon('externalLink')}${escapeHtml(cta.display_text || 'this button has no label yet')}</div>`;
      }
      html += '</div>';
    }
    html += '</div>';
    chat.innerHTML = html;
  }

  if (foot) {
    // The order matters: a real consequence of the wording beats the reassurance
    // that the render is honest, because only one of the two needs acting on.
    let note = '';
    if (dropButtons) {
      note = `Over ${bodyMax} characters with real values, so WhatsApp would drop the buttons and send the words alone. Shorten it or take the buttons off.`;
    } else if (splitImage) {
      note = `Over ${bodyMax} characters, so the picture cannot be the caption. It arrives as its own bubble just before the words.`;
    }
    foot.className = `cp-phone-foot ${note ? 'split' : settled ? 'live' : ''}`;
    foot.innerHTML = note
      ? `<span class="dotp"></span><span>${escapeHtml(note)}</span>`
      : settled
        ? `<span class="dotp"></span><span>Exactly what the sender builds, rendered by the same code that sends it.</span>`
        : `<span class="dotp"></span><span>Checking with the sender...</span>`;
  }

  const flatBody = p.el?.querySelector('[data-flatbody]');
  if (flatBody) {
    flatBody.textContent = p.validation?.flat || '(shown once the check comes back)';
  }
  // What the flattened line LOSES, listed rather than implied. This is the
  // shape roughly three in ten readers actually get.
  const flatLost = p.el?.querySelector('[data-flatlost]');
  if (flatLost) {
    const lost = [];
    if (hasImg) lost.push('the picture');
    if (quick.length) lost.push(quick.length === 1 ? 'the button' : `all ${quick.length} buttons`);
    if (cta) lost.push('the link button');
    if (footer) lost.push('the grey footer line');
    flatLost.textContent = lost.length
      ? `In this shape ${lost.join(', ')} ${lost.length === 1 ? 'is' : 'are'} not sent at all. Only the line above arrives.`
      : 'This message carries nothing but words, so nothing is lost in this shape.';
  }
}

function paintActions(p) {
  const el = p.el?.querySelector('[data-actions]');
  if (!el) return;
  const def = p.def;
  const readOnly = def.locked || def.status === 'blocked';
  const dirty = paneDirty(p);
  // Publish is about the whole message, not only the words: a picture swapped
  // or a button relabelled with the body untouched is still a change nobody is
  // reading yet.
  const sameAsLive = paneSameAsLive(p);
  const canRevert = (p.row.version ?? 0) > 0 && !!p.row.published_body;
  const blocked = p.validation ? (p.validation.issues || []).some((i) => i.level === 'error') : false;

  if (readOnly) {
    el.innerHTML = `<span class="cp-chips-hint" style="margin:0">${def.locked
      ? 'This message is locked. Its wording is fixed at Meta or by law and cannot be edited here.'
      : 'This message is blocked and is not being sent at all, so there is nothing to publish.'}</span>`;
    return;
  }

  el.innerHTML = `
    <button class="btn btn-secondary btn-sm" data-save ${dirty ? '' : 'disabled'}>Save draft</button>
    <button class="btn btn-primary btn-publish" data-publish ${sameAsLive || blocked ? 'disabled' : ''}
            title="${sameAsLive ? 'This is already exactly what goes out.' : blocked ? 'Fix the red lines above first.' : 'Make this the message real people read.'}">
      Publish to WhatsApp
    </button>
    <button class="btn btn-secondary btn-sm" data-test title="Send exactly this to one phone. No case is touched and nothing is published.">
      ${icon('send')} Send a test to a phone
    </button>
    <span class="grow"></span>
    <button class="btn btn-ghost btn-sm" data-revert ${canRevert ? '' : 'disabled'}
            title="${canRevert ? 'Go back to the wording that ships in the code.' : 'Already on the built-in wording.'}">Revert to built-in</button>`;

  el.querySelector('[data-save]')?.addEventListener('click', () => saveDraft(p));
  el.querySelector('[data-publish]')?.addEventListener('click', () => openPublish(p));
  el.querySelector('[data-test]')?.addEventListener('click', () => openTestSend(p));
  el.querySelector('[data-revert]')?.addEventListener('click', () => openRevert(p));
}

function paintImage(p) {
  const box = p.el?.querySelector('[data-img]');
  if (!box) return;
  const readOnly = p.def.locked || p.def.status === 'blocked';

  if (p.imageBusy) {
    box.innerHTML = `<div class="cp-img"><div class="spinner"></div>
      <div class="cp-img-body"><div class="cp-img-name">Uploading the picture...</div></div></div>`;
    return;
  }

  if (!p.imagePath) {
    box.innerHTML = readOnly
      ? '<div class="cp-chips-hint" style="margin:0">No picture, and this message cannot be edited.</div>'
      : `
      <button type="button" class="cp-drop" data-drop-zone data-pick>
        ${icon('upload')}
        <span style="min-width:0">
          <b>Add a picture</b>
          <span>Click to choose one, or drag it onto this box. JPG or PNG, up to 5 MB.</span>
        </span>
      </button>`;
  } else {
    // Meta caches the picture under a media id that expires. `image_media_stale`
    // covers both "never uploaded" and "older than 25 days"; the two need
    // different sentences, because only one of them is a problem.
    const isLive = p.imagePath === p.row.published_image_path;
    const neverUploaded = isLive && !p.row.image_media_at;
    const aged = isLive && !neverUploaded && p.row.image_media_stale;
    const bytes = isLive && p.row.image_bytes ? p.row.image_bytes : p.imageBytes;
    box.innerHTML = `
      <div class="cp-img" data-drop-zone>
        ${p.imageUrl
          ? `<img class="cp-img-thumb" src="${escapeHtml(p.imageUrl)}" alt="The picture attached to this message" />`
          : '<div class="cp-img-thumb"></div>'}
        <div class="cp-img-body">
          <div class="cp-img-name">${escapeHtml(p.imagePath.split('/').pop())}</div>
          <div class="cp-chips-hint" style="margin:2px 0 0">
            ${isLive ? 'Live on this message right now.' : 'On the draft. It goes out when you publish.'}
            ${bytes ? ` ${escapeHtml(formatBytes(bytes))}.` : ''}
          </div>
        </div>
        ${readOnly ? '' : `
          <button class="btn btn-secondary btn-sm" data-pick>Replace</button>
          <button class="btn btn-ghost btn-sm" data-drop>Remove</button>`}
      </div>
      ${p.imageWarn ? `<div class="cp-img-warn">${icon('alertTriangle')}<span>${escapeHtml(p.imageWarn)}</span></div>` : ''}
      ${neverUploaded || aged ? `
        <div class="cp-img-warn">
          ${icon('info')}
          <span>
            ${neverUploaded
              ? 'WhatsApp does not have its own copy of this picture yet. It gets uploaded the first time this message is sent, which makes that one send slower.'
              : 'WhatsApp\'s copy of this picture has aged out and gets uploaded again on the next send.'}
          </span>
          <button class="btn btn-secondary btn-sm" data-warm ${p.mediaBusy ? 'disabled' : ''}>
            ${p.mediaBusy ? 'Sending it...' : 'Send it to WhatsApp now'}
          </button>
        </div>` : ''}`;
  }

  box.querySelector('[data-pick]')?.addEventListener('click', () => p.el.querySelector('[data-file]')?.click());
  box.querySelector('[data-drop]')?.addEventListener('click', () => removeImage(p));
  box.querySelector('[data-warm]')?.addEventListener('click', () => refreshMedia(p));

  // The bucket is private, so the thumbnail needs a signed URL. Fetch once.
  if (p.imagePath && !p.imageUrl) {
    signedDocUrl(p.imagePath, 900)
      .then((url) => {
        if (!S || S.panes?.[p.lang] !== p) return;   // key changed while signing
        p.imageUrl = url;
        paintImage(p);
        paintPreview(p);
      })
      .catch((err) => console.warn('[copy] could not sign image url:', err.message));
  }
}

/** Sizes an intern can compare to "5 MB", not raw bytes. */
function formatBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return `${Math.round((b / 1024 / 1024) * 10) / 10} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} bytes`;
}

// ════════════════════════════════════════════════ the buttons panel

function paintButtons(p) {
  const box = p.el?.querySelector('[data-btns]');
  if (!box) return;
  const def = p.def;
  const readOnly = def.locked || def.status === 'blocked';
  if (readOnly) {
    box.innerHTML = '<div class="cp-chips-hint" style="margin:0">This message is locked, buttons included.</div>';
    return;
  }

  const b = p.buttons;
  const max = waLimit('BUTTON_MAX');
  const titleMax = waLimit('BUTTON_TITLE_MAX');
  const ctaTextMax = waLimit('CTA_TEXT_MAX');
  const footMax = waLimit('FOOTER_MAX');
  const catalogue = S.data?.button_actions || [];
  const usedActions = new Map();
  for (const q of b.quick) usedActions.set(q.action, (usedActions.get(q.action) || 0) + 1);

  // Grouped by the reader the verb was written for, because "Mark care
  // complete" under a message to the family is the expensive mistake here.
  const groups = [['nurse', 'For the nurse'], ['patient', 'For the family'], ['any', 'For anyone']];
  const actionOptions = (selected) => groups.map(([needs, heading]) => {
    const inGroup = catalogue.filter((a) => a.needs === needs);
    if (!inGroup.length) return '';
    return `<optgroup label="${escapeHtml(heading)}">${inGroup.map((a) => `
      <option value="${escapeHtml(a.action)}" ${a.action === selected ? 'selected' : ''}>${escapeHtml(a.label)}</option>`).join('')}</optgroup>`;
  }).join('');

  let html = '';
  if (!b.quick.length && !b.cta) {
    html += '<div class="cp-chips-hint" style="margin:0">No buttons yet. The reader can only answer by typing.</div>';
  }

  for (const q of b.quick) {
    const len = q.title.length;
    const dup = (usedActions.get(q.action) || 0) > 1;
    const mismatch = actionMismatch(def, q.action);
    // Every note that applies, not the first one: "pick an action" and "the
    // action you picked answers for the wrong person" are different problems
    // and hiding the second behind the first is how the second one ships.
    const notes = [];
    if (!q.action) notes.push(['bad', 'Pick what this button does. Until then it cannot be published.']);
    else if (dup) notes.push(['bad', 'Another button already does this. WhatsApp refuses a message whose buttons are not all different.']);
    else notes.push(['', `Tapping this tells us: ${actionMeta(q.action)?.label || q.action}.`]);
    if (q.action && !q.title.trim()) notes.push(['bad', 'Write what this button says. A button with no words cannot be sent.']);
    if (mismatch) notes.push(['bad', mismatch]);
    html += `
      <div class="cp-qr">
        <div class="cp-qr-top">
          <span class="n">Button ${q.slot + 1}</span>
          <select class="form-select" data-qr-action="${q.slot}" aria-label="What button ${q.slot + 1} does">
            <option value="" ${q.action ? '' : 'selected'}>Choose what it does...</option>
            ${actionOptions(q.action)}
          </select>
          <button type="button" class="cp-mini" data-qr-del="${q.slot}"
                  title="Remove this button" aria-label="Remove button ${q.slot + 1}">${icon('trash')}</button>
        </div>
        <div class="cp-qr-lab">
          <input class="form-input" type="text" data-btn-title="${q.slot}" maxlength="200"
                 value="${escapeHtml(q.title)}" placeholder="What it says, for example: Yes, I can take it"
                 aria-label="The words on button ${q.slot + 1}" />
          <span class="cp-num ${len > titleMax ? 'over' : ''}" data-qr-count="${q.slot}">${len}/${titleMax}</span>
        </div>
        ${notes.map(([cls, text]) => `<div class="cp-qr-note ${cls}">${escapeHtml(text)}</div>`).join('')}
      </div>`;
  }

  if (b.cta) {
    const len = (b.cta.display_text || '').length;
    html += `
      <div class="cp-qr">
        <div class="cp-qr-top">
          <span class="n">Link button</span>
          <span class="grow" style="flex:1"></span>
          <button type="button" class="cp-mini" data-cta-del title="Remove the link button" aria-label="Remove the link button">${icon('trash')}</button>
        </div>
        <div class="cp-qr-lab">
          <input class="form-input" type="text" data-cta-text maxlength="200"
                 value="${escapeHtml(b.cta.display_text || '')}" placeholder="What it says, for example: View your invoice"
                 aria-label="The words on the link button" />
          <span class="cp-num ${len > ctaTextMax ? 'over' : ''}" data-cta-count>${len}/${ctaTextMax}</span>
        </div>
        <input class="form-input cp-qr-url" type="url" data-cta-url
               value="${escapeHtml(b.cta.url || '')}" placeholder="https://..." aria-label="Where the link button goes" />
        <div class="cp-qr-note">A tap on a link button tells us nothing at all: WhatsApp sends us no notification for it. If you need to know whether they acted, use a reply button instead.</div>
      </div>`;
  }

  const otherLang = p.lang === 'en' ? 'hi' : 'en';
  const other = S.panes?.[otherLang];
  const canMatch = !!other && hasTappable(other.buttons)
    && JSON.stringify(other.buttons.quick.map((q) => `${q.slot}:${q.action}`))
      !== JSON.stringify(b.quick.map((q) => `${q.slot}:${q.action}`));

  html += `
    <div class="cp-addrow">
      <button class="btn btn-secondary btn-sm" data-add-qr ${b.quick.length >= max || b.cta ? 'disabled' : ''}
              title="${b.cta ? 'Take the link button off first: a message carries reply buttons or one link button, never both.'
                : b.quick.length >= max ? `WhatsApp shows ${max} buttons and no more.` : 'A button the reader taps to answer.'}">
        ${icon('plus')} Add a reply button
      </button>
      <button class="btn btn-secondary btn-sm" data-add-cta ${b.cta || b.quick.length ? 'disabled' : ''}
              title="${b.quick.length ? 'Take the reply buttons off first: a message carries reply buttons or one link button, never both.'
                : b.cta ? 'There is already a link button. One is the limit.' : 'A button that opens a web page.'}">
        ${icon('plus')} Add a link button
      </button>
      ${canMatch ? `
        <button class="btn btn-ghost btn-sm" data-match
                title="Copy the actions and their order from the ${escapeHtml(LANG_LABEL[otherLang])} version, so both readers tap the same things.">
          Match the ${escapeHtml(LANG_LABEL[otherLang])} buttons
        </button>` : ''}
    </div>
    <div class="cp-foot-edit">
      <label for="cp-foot-${p.lang}">Small grey line under the message (optional)</label>
      <div class="row">
        <input class="form-input" type="text" id="cp-foot-${p.lang}" data-footer maxlength="200"
               value="${escapeHtml(b.footer || '')}" placeholder="For example: Not an emergency line. Call 108." />
        <span class="cp-num ${(b.footer || '').length > footMax ? 'over' : ''}" data-footer-count>${(b.footer || '').length}/${footMax}</span>
      </div>
      <div class="cp-qr-note">${hasTappable(b)
        ? 'It sits under the words in smaller grey type, and does not count against the message length.'
        : 'WhatsApp only draws this line on a message that has buttons. With no buttons it is dropped, so put the words in the message itself.'}</div>
    </div>`;

  box.innerHTML = html;

  // ---- wiring. Only STRUCTURAL changes repaint the panel; typing updates the
  // counter in place, because a repaint on every keystroke takes the cursor
  // out of the box the person is typing in.
  const touched = () => { paintState(p); paintMeter(p); paintActions(p); paintPreview(p); schedulePreview(p); };
  const restructured = () => {
    paintButtons(p);
    // The OTHER language's panel offers "match these buttons", and whether that
    // control exists depends on the buttons in THIS one. Adding a chip in
    // English has to make the offer appear in Hindi, not next time something
    // else happens to repaint it.
    for (const other of Object.values(S.panes || {})) {
      if (other !== p && other.el?.isConnected) paintButtons(other);
    }
    touched();
  };

  box.querySelectorAll('[data-qr-action]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const slot = Number(sel.getAttribute('data-qr-action'));
      const q = p.buttons.quick.find((x) => x.slot === slot);
      if (!q) return;
      q.action = sel.value;
      // A repaint here is deliberate: choosing an action changes the duplicate
      // and wrong-reader notes on the OTHER rows too.
      restructured();
      p.el?.querySelector(`[data-qr-action="${slot}"]`)?.focus();
    });
  });

  box.querySelectorAll('[data-qr-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slot = Number(btn.getAttribute('data-qr-del'));
      p.buttons.quick = p.buttons.quick.filter((x) => x.slot !== slot);
      restructured();
    });
  });

  box.querySelectorAll('[data-btn-title]').forEach((input) => {
    input.addEventListener('input', () => {
      const slot = Number(input.getAttribute('data-btn-title'));
      const q = p.buttons.quick.find((x) => x.slot === slot);
      if (!q) return;
      q.title = input.value;
      const counter = box.querySelector(`[data-qr-count="${slot}"]`);
      if (counter) {
        counter.textContent = `${q.title.length}/${titleMax}`;
        counter.classList.toggle('over', q.title.length > titleMax);
      }
      touched();
    });
  });

  box.querySelector('[data-cta-text]')?.addEventListener('input', (e) => {
    if (!p.buttons.cta) return;
    p.buttons.cta.display_text = e.currentTarget.value;
    const counter = box.querySelector('[data-cta-count]');
    if (counter) {
      counter.textContent = `${p.buttons.cta.display_text.length}/${ctaTextMax}`;
      counter.classList.toggle('over', p.buttons.cta.display_text.length > ctaTextMax);
    }
    touched();
  });
  box.querySelector('[data-cta-url]')?.addEventListener('input', (e) => {
    if (!p.buttons.cta) return;
    p.buttons.cta.url = e.currentTarget.value;
    touched();
  });
  box.querySelector('[data-cta-del]')?.addEventListener('click', () => {
    p.buttons.cta = null;
    restructured();
  });

  box.querySelector('[data-footer]')?.addEventListener('input', (e) => {
    p.buttons.footer = e.currentTarget.value;
    const counter = box.querySelector('[data-footer-count]');
    if (counter) {
      counter.textContent = `${p.buttons.footer.length}/${footMax}`;
      counter.classList.toggle('over', p.buttons.footer.length > footMax);
    }
    touched();
  });

  box.querySelector('[data-add-qr]')?.addEventListener('click', () => {
    const slot = freeSlot(p.buttons);
    if (slot === null) return;
    p.buttons.quick.push({ slot, action: '', title: '' });
    p.buttons.quick.sort((x, y) => x.slot - y.slot);
    restructured();
    p.el?.querySelector(`[data-qr-action="${slot}"]`)?.focus();
  });

  box.querySelector('[data-add-cta]')?.addEventListener('click', () => {
    p.buttons.cta = { display_text: '', url: '' };
    restructured();
    p.el?.querySelector('[data-cta-text]')?.focus();
  });

  box.querySelector('[data-match]')?.addEventListener('click', () => {
    if (!other) return;
    // Slots and verbs come across; a label already written for the same slot
    // and the same verb is KEPT, because that is the translation somebody did.
    const mine = new Map(p.buttons.quick.map((q) => [`${q.slot}:${q.action}`, q.title]));
    p.buttons.quick = other.buttons.quick.map((q) => ({
      slot: q.slot,
      action: q.action,
      title: mine.get(`${q.slot}:${q.action}`) ?? q.title,
    }));
    if (other.buttons.cta && !p.buttons.cta) {
      p.buttons.cta = { display_text: other.buttons.cta.display_text, url: other.buttons.cta.url };
    }
    restructured();
    showToast(`Actions copied from the ${LANG_LABEL[otherLang]} version. Translate the labels; the actions now match.`, 'info');
  });
}

// ════════════════════════════════════════════════ the live check

function schedulePreview(p) {
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => refreshPreview(p), PREVIEW_DEBOUNCE_MS);
  p.previewBusy = true;
  paintPreview(p);
}

async function refreshPreview(p) {
  const token = ++p.seq;
  p.previewBusy = true;
  p.previewError = null;
  try {
    const res = await adminAction('preview_copy', {
      key: p.def.key,
      lang: p.lang,
      body: p.body,
      vars: S.sampleOverrides,
      // Present on the request wins over anything stored, so the check is
      // against the WHOLE message on screen and not a body with yesterday's
      // picture and buttons attached to it.
      image_path: p.imagePath || null,
      buttons: buttonsPayload(p.buttons),
    });
    if (token !== p.seq) return;               // a newer keystroke already won
    // TRAP: actionPreviewCopy returns json({ ok:true, ..., ...validation }) and
    // CopyValidation itself carries an `ok`. The spread lands last, so res.ok is
    // the VALIDATION verdict, not "did the call work". A body with a red error
    // comes back HTTP 200 with ok:false and that is a normal, expected answer.
    p.validation = res;
  } catch (err) {
    if (token !== p.seq) return;
    console.error('[copy] preview failed:', err);
    p.validation = null;
    p.previewError = err.message || 'check failed';
  } finally {
    if (token === p.seq) {
      p.previewBusy = false;
      if (S && S.panes?.[p.lang] === p && p.el?.isConnected) {
        paintPreview(p); paintIssues(p); paintMeter(p); paintActions(p);
      }
    }
  }
}

function busy(btn, on, label) {
  if (!btn) return;
  btn.disabled = on;
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.innerHTML = '<div class="spinner" style="margin:0 auto"></div>';
  } else if (btn.dataset.label) {
    btn.innerHTML = label || btn.dataset.label;
    delete btn.dataset.label;
  }
}

// ════════════════════════════════════════════════ writes

async function saveDraft(p) {
  if (p.def.locked || p.def.status === 'blocked') return;
  const btn = p.el?.querySelector('[data-save]');
  busy(btn, true);
  try {
    await adminAction('save_copy_draft', {
      key: p.def.key,
      lang: p.lang,
      draft_body: p.body,
      draft_image_path: p.imagePath,
      draft_buttons: buttonsPayload(p.buttons),
    });
    p.baseline = p.body;
    p.buttonsBaseline = buttonsJson(p.buttons);
    await refreshKey(p.def.key);   // adoptFresh() hands the new def to both panes
    showToast('Draft saved. Nobody receives a draft.', 'success');
    renderList();
  } catch (err) {
    console.error('[copy] save draft failed:', err);
    showToast(err.message || 'Could not save the draft', 'error');
  } finally {
    // Restore the button BEFORE repainting: paintActions rebuilds this whole
    // row and computes the disabled state itself. Doing it the other way round
    // re-enables a Save button that has nothing left to save.
    busy(btn, false);
    paintState(p);
    paintActions(p);
  }
}

function openPublish(p) {
  const def = p.def;
  const before = liveBody(def, p.lang);
  const warns = (p.validation?.issues || []).filter((i) => i.level === 'warn');
  const errs = (p.validation?.issues || []).filter((i) => i.level === 'error');

  if (errs.length) {
    showToast('Fix the red lines before publishing', 'warning');
    return;
  }

  const content = document.createElement('div');
  content.innerHTML = `
    <p class="cp-modal-note">
      From the next message onward, ${escapeHtml(AUDIENCE_WORDS[def.audience] || def.audience)}
      will read this instead of what they read today. It takes effect immediately.
    </p>
    <div class="cp-modal-note">
      <b>Now:</b> ${(p.row.version ?? 0) > 0 && p.row.published_body
        ? `your wording, version ${p.row.version}, published by ${escapeHtml(p.row.published_by_name || 'someone')} ${escapeHtml(formatDateTime(p.row.published_at))}`
        : 'the built-in wording that ships in the code'}
    </div>
    ${diffHtml(before, p.body)}
    ${publishExtrasHtml(p)}
    ${warns.length ? `
      <div class="cp-issues" style="margin-top:var(--s3)">
        ${warns.map((w) => `<div class="cp-issue warn">${icon('alertTriangle')}<span>${escapeHtml(w.message)}</span></div>`).join('')}
      </div>
      <p class="cp-chips-hint">These are warnings, not blockers. Read them once, then decide.</p>` : ''}
    <div class="form-group" style="margin:var(--s4) 0 0">
      <label class="form-label" for="cp-pub-note">What changed? (optional, kept in the history)</label>
      <input class="form-input" id="cp-pub-note" type="text" maxlength="200" placeholder="Softened the opening line" />
    </div>`;

  const overlay = showModal({
    title: `Publish the ${LANG_LABEL[p.lang]} wording?`,
    content,
    size: 'lg',
    footer: `
      <button class="btn btn-secondary" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-go>Yes, publish it</button>`,
  });
  overlay.querySelector('[data-cancel]').addEventListener('click', () => closeModal());
  overlay.querySelector('[data-go]').addEventListener('click', async () => {
    const note = overlay.querySelector('#cp-pub-note')?.value?.trim() || null;
    const goBtn = overlay.querySelector('[data-go]');
    busy(goBtn, true);
    await doPublish(p, note, overlay);
  });
}

/**
 * The diff shows the words. A picture swapped or a button relabelled does not
 * show up in a line diff at all, and publishing it blind is how a QR code for
 * last month's account goes live. Say those in words, above the note box.
 */
function publishExtrasHtml(p) {
  const rows = [];
  const wasImg = p.row.published_image_path ?? null;
  const nowImg = p.imagePath ?? null;
  if (wasImg !== nowImg) {
    rows.push(nowImg && wasImg ? `The picture changes to <b>${escapeHtml(nowImg.split('/').pop())}</b>.`
      : nowImg ? `A picture goes live with it: <b>${escapeHtml(nowImg.split('/').pop())}</b>.`
        : 'The picture is removed from this message.');
  }
  const wasBtn = JSON.stringify(liveButtons(p.def, p.lang));
  const nowBtn = buttonsJson(p.buttons);
  if (wasBtn !== nowBtn) {
    const b = buttonsPayload(p.buttons);
    const quick = b?.quick_replies || [];
    if (quick.length) {
      rows.push(`The buttons under it become: ${quick.map((q) => `<b>${escapeHtml(q.title)}</b>`).join(', ')}.`);
    } else if (b?.cta_url) {
      rows.push(`A link button goes live: <b>${escapeHtml(b.cta_url.display_text)}</b>, opening ${escapeHtml(b.cta_url.url)}.`);
    } else {
      rows.push('The buttons are taken off this message.');
    }
    const wasFoot = toEditorButtons(liveButtons(p.def, p.lang)).footer;
    const nowFoot = (p.buttons.footer || '').trim();
    if (wasFoot !== nowFoot) {
      rows.push(nowFoot ? `The grey line under it becomes: <b>${escapeHtml(nowFoot)}</b>.` : 'The grey line under it is removed.');
    }
  }
  if (!rows.length) return '';
  return `<div class="cp-modal-note" style="margin-top:var(--s3)">
    <b>Not shown in the lines above:</b>
    <ul style="margin:6px 0 0;padding-left:18px">${rows.map((r) => `<li>${r}</li>`).join('')}</ul>
  </div>`;
}

/**
 * Publishing does not touch the draft columns, and admin-actions calls a row
 * dirty when its draft buttons differ from its published ones (copyRowState).
 * So publishing buttons straight from the editor, without pressing Save first,
 * would leave the message wearing an "unpublished draft" badge for good. Line
 * the scratchpad up with whatever just went live.
 *
 * Best effort on purpose: this is cosmetic, and a hiccup here must never turn a
 * publish that worked into an error the admin sees.
 */
async function alignDraftWith(p, { body, imagePath, buttons }) {
  try {
    await adminAction('save_copy_draft', {
      key: p.def.key,
      lang: p.lang,
      draft_body: body ?? null,
      draft_image_path: imagePath ?? null,
      draft_buttons: buttons ?? null,
    });
  } catch (err) {
    console.warn('[copy] could not line the draft up with what was published:', err.message);
  }
}

async function doPublish(p, note, overlay) {
  try {
    const res = await adminAction('publish_copy', {
      key: p.def.key,
      lang: p.lang,
      body: p.body,
      image_path: p.imagePath,
      // FULL REPLACE, every time: publish_copy takes the complete new state, so
      // leaving this off a key that had buttons would silently remove them.
      buttons: buttonsPayload(p.buttons),
      note,
      expected_version: p.expected,
    });

    if (res?.ok) {
      if (overlay) closeModal();
      p.baseline = p.body;
      p.buttonsBaseline = buttonsJson(p.buttons);
      p.expected = res.version;
      p.history = null;                       // stale now, reload on next open
      await alignDraftWith(p, { body: p.body, imagePath: p.imagePath, buttons: buttonsPayload(p.buttons) });
      await refreshKey(p.def.key);   // adoptFresh() hands the new def to both panes
      showToast(`Published. Version ${res.version} is what goes out now.`, 'success');
      renderList();
      if (p.el?.isConnected) renderPane(p.el, p);  // rebuilds every badge and button
      return;
    }

    if (res?.error === 'version_conflict') {
      if (overlay) closeModal();
      openConflict(p, res);
      return;
    }

    if (res?.error === 'validation_failed') {
      if (overlay) closeModal();
      p.validation = res.validation;
      paintIssues(p); paintActions(p); paintMeter(p);
      showToast('Publish blocked. The red lines above say why.', 'error');
      return;
    }

    if (overlay) closeModal();
    showToast(res?.error || 'Publish failed', 'error');
  } catch (err) {
    console.error('[copy] publish failed:', err);
    // The confirm dialog and the conflict dialog both land here, and their
    // confirm buttons have different names. busy(el, false) restores whatever
    // label it captured, so neither dialog is left spinning forever.
    if (overlay) {
      busy(overlay.querySelector('[data-go]') || overlay.querySelector('[data-take-mine]'), false);
    }
    showToast(err.message || 'Publish failed', 'error');
  }
}

/**
 * What the two of you differ on besides the words. The line diff cannot show a
 * picture or a button, and "keep theirs" replaces all three.
 */
function conflictExtrasHtml(p, res) {
  const rows = [];
  const theirImg = res.current_image_path ?? null;
  if (theirImg !== (p.imagePath ?? null)) {
    rows.push(`Their version ${theirImg ? `carries the picture <b>${escapeHtml(theirImg.split('/').pop())}</b>` : 'carries no picture'}, yours ${p.imagePath ? `carries <b>${escapeHtml(p.imagePath.split('/').pop())}</b>` : 'carries none'}.`);
  }
  const theirBtn = JSON.stringify(res.current_buttons ?? null);
  if (theirBtn !== buttonsJson(p.buttons)) {
    const t = toEditorButtons(res.current_buttons ?? null);
    const label = (b) => (b.quick.length ? b.quick.map((q) => `"${q.title}"`).join(', ')
      : b.cta ? `a link button, "${b.cta.display_text}"` : 'no buttons');
    rows.push(`Their buttons are ${escapeHtml(label(t))}; yours are ${escapeHtml(label(p.buttons))}.`);
  }
  if (!rows.length) return '';
  return `<div class="cp-modal-note" style="margin-top:var(--s3)">
    <ul style="margin:0;padding-left:18px">${rows.map((r) => `<li>${r}</li>`).join('')}</ul>
  </div>`;
}

/**
 * Two people opened the same message. Never merge, never force: show both
 * bodies and let the human decide which one a family should read.
 */
function openConflict(p, res) {
  const theirs = res.current_body ?? (p.def.defaults?.[p.lang] ?? '');
  const content = document.createElement('div');
  content.innerHTML = `
    <p class="cp-modal-note">
      Somebody else published this message while you were writing.
      <b>${escapeHtml(res.published_by_name || 'They')}</b> published version ${res.current_version}
      ${escapeHtml(formatRelativeTime(res.published_at))}. Nothing of yours has been lost, and nothing has been overwritten.
    </p>
    <div class="cp-two">
      <div>
        <h4>Live now (theirs, v${res.current_version})</h4>
        <div class="cp-pre">${tokenHtml(theirs)}</div>
      </div>
      <div>
        <h4>Yours (not published)</h4>
        <div class="cp-pre">${tokenHtml(p.body)}</div>
      </div>
    </div>
    <p class="cp-chips-hint" style="margin-top:var(--s3)">Line by line, going from theirs to yours:</p>
    ${diffHtml(theirs, p.body)}
    ${conflictExtrasHtml(p, res)}`;

  const overlay = showModal({
    title: 'Two people edited this message',
    content,
    size: 'lg',
    footer: `
      <button class="btn btn-secondary" data-take-theirs>Keep theirs, drop mine</button>
      <button class="btn btn-primary" data-take-mine>Publish mine over theirs</button>`,
  });

  overlay.querySelector('[data-take-theirs]').addEventListener('click', async () => {
    closeModal();
    p.body = theirs;
    p.baseline = theirs;
    p.expected = res.current_version;
    // Their whole message, not only their words: taking their body and keeping
    // your own buttons produces a message neither of you wrote.
    p.buttons = toEditorButtons(res.current_buttons ?? null);
    p.buttonsBaseline = buttonsJson(p.buttons);
    p.imagePath = res.current_image_path ?? null;
    p.imageUrl = null;
    p.imageWarn = null;
    await refreshKey(p.def.key);   // adoptFresh() hands the new def to both panes
    if (p.el?.isConnected) renderPane(p.el, p);
    renderList();
    showToast('Their message is loaded, buttons and picture included. Yours is gone from this box.', 'info');
  });

  overlay.querySelector('[data-take-mine]').addEventListener('click', async () => {
    const btn = overlay.querySelector('[data-take-mine]');
    busy(btn, true);
    p.expected = res.current_version;          // publish on top of what is live
    await doPublish(p, 'replaced a competing edit', overlay);
  });
}

function openRevert(p) {
  const def = p.def;
  const content = document.createElement('div');
  content.innerHTML = `
    <p class="cp-modal-note">
      This puts the message back to the wording that ships in the code. Your published version stays in the
      history and can be brought back later. From the next message onward, readers get this:
    </p>
    <div class="cp-pre">${tokenHtml(def.defaults?.[p.lang] ?? '')}</div>
    <p class="cp-chips-hint" style="margin-top:var(--s3)">
      Reverting also removes the picture and the buttons attached to this message. It goes back to being words alone.
    </p>`;
  const overlay = showModal({
    title: `Revert the ${LANG_LABEL[p.lang]} wording to the built-in one?`,
    content,
    size: 'lg',
    footer: `
      <button class="btn btn-secondary" data-cancel>Cancel</button>
      <button class="btn btn-danger" data-go>Revert to built-in</button>`,
  });
  overlay.querySelector('[data-cancel]').addEventListener('click', () => closeModal());
  overlay.querySelector('[data-go]').addEventListener('click', async () => {
    const btn = overlay.querySelector('[data-go]');
    busy(btn, true);
    try {
      const res = await adminAction('revert_copy', {
        key: def.key, lang: p.lang, expected_version: p.expected,
      });
      if (res?.ok) {
        closeModal();
        p.body = res.default_body ?? (def.defaults?.[p.lang] ?? '');
        p.baseline = p.body;
        p.expected = res.version;
        p.imagePath = null;
        p.imageUrl = null;
        p.imageBytes = null;
        p.imageWarn = null;
        p.buttons = emptyButtons();
        p.buttonsBaseline = buttonsJson(p.buttons);
        p.history = null;
        // revert_copy publishes NULL words, NULL picture and NULL buttons. The
        // draft columns are not part of that, so clear them too rather than
        // leaving a scratchpad that still holds the picture we just dropped.
        await alignDraftWith(p, { body: null, imagePath: null, buttons: null });
        await refreshKey(def.key);   // adoptFresh() hands the new def to both panes
        showToast('Reverted. The built-in wording is going out again.', 'success');
        renderList();
        if (p.el?.isConnected) renderPane(p.el, p);
        return;
      }
      if (res?.error === 'version_conflict') { closeModal(); openConflict(p, res); return; }
      closeModal();
      showToast(res?.error || 'Revert failed', 'error');
    } catch (err) {
      console.error('[copy] revert failed:', err);
      busy(btn, false);
      showToast(err.message || 'Revert failed', 'error');
    }
  });
}

// ════════════════════════════════════════════════ pictures

/**
 * Read the real pixel size in the browser, before anything is uploaded.
 *
 * Measured on the live number: a 16 by 16 pixel PNG was accepted by Meta's
 * media upload, came back with a message id, and then failed hours later with
 * "image is invalid". Nothing downstream can catch that, and nobody watches the
 * delivery webhook. Never throws; an unreadable file just returns null and the
 * upload carries on.
 */
function readImageSize(file) {
  return new Promise((resolve) => {
    let url = '';
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve(null);
      return;
    }
    const img = new Image();
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => done(null);
    img.src = url;
  });
}

async function uploadImage(p, file) {
  if (!IMAGE_MIME_RE.test(file.type || '')) {
    showToast(
      'WhatsApp takes a JPG or a PNG only. A WebP counts as a sticker there, so it uploads fine and then fails to send where nobody can see it.',
      'warning',
    );
    return;
  }
  if (file.size > waLimit('IMAGE_MAX_BYTES')) {
    showToast(`That picture is ${formatBytes(file.size)}. WhatsApp refuses anything over 5 MB. Shrink it and try again.`, 'warning');
    return;
  }

  const size = await readImageSize(file);
  p.imageBusy = true;
  paintImage(p);
  try {
    const path = await uploadCaseDoc(file, `copy_${p.def.key}_${p.lang}`);
    await adminAction('save_copy_draft', { key: p.def.key, lang: p.lang, draft_image_path: path });
    p.imagePath = path;
    p.imageUrl = null;
    p.imageBytes = file.size;
    p.imageWarn = size && (size.w < IMAGE_MIN_PX || size.h < IMAGE_MIN_PX)
      ? `This picture is only ${size.w} by ${size.h} pixels. WhatsApp accepts one that small and then fails to deliver it, with nothing on our side to show for it. Use a normal photo-sized picture.`
      : null;
    await refreshKey(p.def.key);   // adoptFresh() hands the new def to both panes
    showToast('Picture attached to the draft. Publish to make it live.', 'success');
  } catch (err) {
    console.error('[copy] image upload failed:', err);
    showToast(err.message || 'Could not attach that picture', 'error');
  } finally {
    p.imageBusy = false;
    paintImage(p);
    paintActions(p);
    paintPreview(p);
    schedulePreview(p);
  }
}

async function removeImage(p) {
  try {
    await adminAction('save_copy_draft', { key: p.def.key, lang: p.lang, draft_image_path: null });
    p.imagePath = null;
    p.imageUrl = null;
    p.imageBytes = null;
    p.imageWarn = null;
    await refreshKey(p.def.key);   // adoptFresh() hands the new def to both panes
    paintImage(p);
    paintActions(p);
    paintPreview(p);
    schedulePreview(p);
    showToast('Picture removed from the draft.', 'info');
  } catch (err) {
    console.error('[copy] image remove failed:', err);
    showToast(err.message || 'Could not remove the picture', 'error');
  }
}

/**
 * Hand the PUBLISHED picture to WhatsApp now, instead of on the first send.
 *
 * Meta keeps its own copy under a media id that ages out, and the nightly job
 * refreshes them. This is the button for the two moments that job does not
 * cover: just after publishing a picture, and while somebody is standing there
 * asking why it did not arrive.
 */
async function refreshMedia(p) {
  p.mediaBusy = true;
  paintImage(p);
  try {
    const res = await adminAction('refresh_copy_media', { key: p.def.key, lang: p.lang, force: true });
    const mine = (res?.results || []).find((r) => r.key === p.def.key && r.lang === p.lang);
    if (res?.ok && mine?.media_id) {
      showToast('WhatsApp has the picture. The next send goes out without waiting for an upload.', 'success');
    } else if (res?.ok) {
      showToast('WhatsApp would not take the picture. Check that it is a JPG or a PNG under 5 MB, and that it is published.', 'warning');
    } else {
      showToast(res?.error || 'Could not send the picture to WhatsApp', 'error');
    }
    await refreshKey(p.def.key);   // adoptFresh() hands the new def to both panes
  } catch (err) {
    console.error('[copy] media refresh failed:', err);
    showToast(err.message || 'Could not send the picture to WhatsApp', 'error');
  } finally {
    p.mediaBusy = false;
    paintImage(p);
  }
}

// ════════════════════════════════════════════════ send a test to a phone

// The number somebody tested with two minutes ago is almost always the number
// they want now. Kept across page loads, because the alternative is retyping a
// 10 digit number for every one of 183 messages.
const TEST_PHONE_STORE = 'cc_copy_test_phone';
function rememberedPhone() {
  if (S?.testPhone) return S.testPhone;
  try { return localStorage.getItem(TEST_PHONE_STORE) || ''; } catch { return ''; }
}
function rememberPhone(v) {
  if (S) S.testPhone = v;
  try { localStorage.setItem(TEST_PHONE_STORE, v); } catch { /* private mode */ }
}

/**
 * THE CONTROL THAT MAKES THE REST OF THE PAGE BELIEVABLE.
 *
 * Every argument about wording ends the moment somebody looks at the message on
 * a phone. send_copy_test sends the real shape (a picture with its caption, an
 * interactive bubble with the chips, or the flattened template when the
 * recipient's window is shut) to ONE number, with no case attached, nothing
 * published, and button payloads pointing at a case id that cannot exist.
 */
function openTestSend(p) {
  const def = p.def;
  const content = document.createElement('div');
  content.innerHTML = `
    <p class="cp-modal-note">
      This sends the message to one phone so you can look at it before a family does.
      It is not attached to any case, nothing is published, and a button tapped on the test does nothing at all.
    </p>
    <div class="form-group">
      <label class="form-label" for="cp-test-to">Which phone?</label>
      <input class="form-input" id="cp-test-to" type="tel" inputmode="tel" autocomplete="off"
             value="${escapeHtml(rememberedPhone())}" placeholder="98765 43210" />
      <div class="cp-chips-hint" style="margin-top:5px">
        Ten digits for an Indian number, or the full number with its country code. It has to be a phone that uses WhatsApp.
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Which version?</label>
      <label class="cp-radio">
        <input type="radio" name="cp-test-use" value="request" checked />
        <span><b>What is in the editor right now</b>The words, the picture and the buttons on this screen, saved or not.</span>
      </label>
      <label class="cp-radio">
        <input type="radio" name="cp-test-use" value="published" />
        <span><b>What is published</b>Exactly what real people are being sent today.</span>
      </label>
      <label class="cp-radio">
        <input type="radio" name="cp-test-use" value="default" />
        <span><b>The built-in wording</b>What ships in the code, before anybody edited it.</span>
      </label>
    </div>
    <div class="cp-chips-hint">
      The variables are filled with the sample values from the top of this page, so no real patient's name, code or amount goes out.
      ${def.template ? `If that phone has not written to us in the last 24 hours, WhatsApp only allows the approved template, and you will see the flattened version instead. That is the truth about this message, not a fault in the test.` : ''}
    </div>
    <div data-result></div>`;

  const overlay = showModal({
    title: `Send the ${LANG_LABEL[p.lang]} version to a phone`,
    content,
    size: 'lg',
    footer: `
      <button class="btn btn-secondary" data-cancel>Close</button>
      <button class="btn btn-primary" data-go>Send it now</button>`,
  });

  overlay.querySelector('[data-cancel]').addEventListener('click', () => closeModal());
  overlay.querySelector('[data-go]').addEventListener('click', async () => {
    const input = overlay.querySelector('#cp-test-to');
    const to = (input?.value || '').trim();
    if (to.replace(/\D+/g, '').length < 10) {
      showToast('Type the phone number first: at least 10 digits.', 'warning');
      input?.focus();
      return;
    }
    const use = overlay.querySelector('input[name="cp-test-use"]:checked')?.value || 'request';
    rememberPhone(to);

    const result = overlay.querySelector('[data-result]');
    const go = overlay.querySelector('[data-go]');
    result.innerHTML = '<div class="cp-test info">Sending it, and waiting for WhatsApp to answer...</div>';
    busy(go, true);
    try {
      const params = { key: def.key, lang: p.lang, to, use, vars: S.sampleOverrides };
      if (use === 'request') {
        // A field PRESENT on the request wins over anything stored, which is
        // what lets this send unsaved typing. The other two modes must NOT
        // carry these keys at all, or they would quietly send the editor's
        // copy while claiming to send what is published.
        params.body = p.body;
        params.image_path = p.imagePath || null;
        params.buttons = buttonsPayload(p.buttons);
      }
      const res = await adminAction('send_copy_test', params);
      p.test = { to, use, res };
      result.innerHTML = testResultHtml(res, p.test);
      paintTest(p);
      // A test send runs the same validator as publish, so a refusal here is
      // the same red line the editor has to show.
      if (res?.error === 'validation_failed' && res.validation) {
        p.validation = res.validation;
        paintIssues(p); paintMeter(p); paintActions(p);
      }
      if (res?.ok) showToast('Sent. Go and look at the phone.', 'success');
    } catch (err) {
      console.error('[copy] test send failed:', err);
      result.innerHTML = `<div class="cp-test bad"><b>Nothing was sent.</b> ${escapeHtml(err.message || 'The server could not be reached.')}</div>`;
    } finally {
      busy(go, false);
    }
  });
}

/** The last test's outcome, kept under the buttons after the dialog is closed. */
function paintTest(p) {
  const box = p.el?.querySelector('[data-testout]');
  if (!box) return;
  box.innerHTML = p.test ? testResultHtml(p.test.res, p.test) : '';
}

/**
 * What really happened, in the words of somebody who has to act on it. Every
 * code send_copy_test can return has a sentence here; the raw answer is kept
 * behind a fold for the one person who needs to forward it to an engineer.
 */
function testResultHtml(res, ctx) {
  if (!res) return '<div class="cp-test bad"><b>Nothing came back.</b> Try again in a moment.</div>';

  if (res.error === 'validation_failed') {
    return `<div class="cp-test bad">
      <b>Not sent.</b> There is something in this message that could not be published either,
      so sending a test of it would tell you nothing. The red lines in the editor say what to fix.
    </div>`;
  }

  const drops = [];
  if (res.dropped?.image) drops.push(`The picture did not go: ${DROP_WORDS[res.dropped.image] || res.dropped.image}.`);
  if (res.dropped?.buttons) drops.push(`The buttons did not go: ${DROP_WORDS[res.dropped.buttons] || res.dropped.buttons}.`);
  if (res.dropped?.caption) drops.push('The picture went as its own message just before the words, because the words are too long to sit under a picture as a caption.');

  const detail = [
    ctx?.use ? `version: ${USE_WORDS[ctx.use] || ctx.use}` : '',
    res.via ? `shape: ${res.via}` : '',
    res.wamid ? `WhatsApp id: ${res.wamid}` : '',
    res.message_id ? `message log row: ${res.message_id}` : '',
    res.error ? `answer: ${typeof res.error === 'string' ? res.error : JSON.stringify(res.error)}` : '',
  ].filter(Boolean).join('\n');

  if (res.ok) {
    return `<div class="cp-test ok">
      <b>Sent to ${escapeHtml(ctx?.to || 'that phone')}.</b> It went out as ${escapeHtml(VIA_WORDS[res.via] || 'a message')}.
      ${res.window_open === false ? `
        <div style="margin-top:5px">
          That phone has not written to us in the last 24 hours, so WhatsApp only allowed the approved template
          and the whole message was flattened onto one line inside it. Roughly three readers in ten get this shape.
        </div>` : ''}
      ${drops.length ? `<ul>${drops.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : ''}
      <div style="margin-top:6px">
        WhatsApp accepted it. Delivery happens a second or two later and is not part of this answer,
        so if nothing lands on the phone, that is a delivery problem and not a problem with your wording.
      </div>
      ${detail ? `<details><summary>Technical detail</summary><pre>${escapeHtml(detail)}</pre></details>` : ''}
    </div>`;
  }

  return `<div class="cp-test bad">
    <b>Not sent.</b> ${escapeHtml(sendErrorWords(res.error))}
    ${drops.length ? `<ul>${drops.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : ''}
    ${detail ? `<details><summary>Technical detail</summary><pre>${escapeHtml(detail)}</pre></details>` : ''}
  </div>`;
}

// ════════════════════════════════════════════════ the writing assistant

async function askGemini(p, el) {
  const input = el.querySelector('[data-ai-in]');
  const out = el.querySelector('[data-ai-out]');
  const btn = el.querySelector('[data-ai-go]');
  const instruction = (input?.value || '').trim();
  if (!instruction) { showToast('Tell it what to change first', 'warning'); input?.focus(); return; }

  busy(btn, true);
  out.innerHTML = '<div class="cp-ai-out">Writing a draft...</div>';
  try {
    const res = await adminAction('draft_copy_gemini', {
      key: p.def.key,
      lang: p.lang,
      instruction,
      base_body: p.body,
      // save:false on purpose. The server would otherwise write draft_body for
      // a suggestion the human has not looked at yet, and "Discard" would then
      // be a lie: the row would already hold the model's words.
      save: false,
    });

    if (!res?.ok) {
      out.innerHTML = `
        <div class="cp-ai-out">
          <h4>Not available</h4>
          <p style="font:var(--t-sm);color:var(--ink-2);margin:0">
            The writing assistant did not answer this time. Everything else on this page still works,
            and you can write the change yourself in the box above.
          </p>
        </div>`;
      return;
    }

    const issues = res.validation?.issues || [];
    out.innerHTML = `
      <div class="cp-ai-out">
        <h4>Draft suggestion, not saved and not sent</h4>
        <div class="cp-pre">${tokenHtml(res.body)}</div>
        ${res.note ? `<div class="cp-ai-note">${escapeHtml(res.note)}</div>` : ''}
        ${issues.length ? `<div class="cp-issues" style="margin-top:var(--s2)">
          ${issues.map((iss) => `<div class="cp-issue ${iss.level === 'error' ? 'error' : 'warn'}">${icon(iss.level === 'error' ? 'alertCircle' : 'alertTriangle')}<span>${escapeHtml(iss.message)}</span></div>`).join('')}
        </div>` : ''}
        <div style="display:flex;gap:var(--s2);margin-top:var(--s3)">
          <button class="btn btn-primary btn-sm" data-ai-take>Use this draft</button>
          <button class="btn btn-ghost btn-sm" data-ai-drop>Discard</button>
        </div>
      </div>`;

    out.querySelector('[data-ai-take]').addEventListener('click', () => {
      const ta = p.el.querySelector('[data-ta]');
      if (ta) { ta.value = res.body; ta.focus(); }
      p.body = res.body;
      out.innerHTML = '';
      if (input) input.value = '';
      paintState(p); paintMeter(p); paintActions(p); schedulePreview(p);
      showToast('Loaded into the editor. Read it, then save or publish.', 'success');
    });
    out.querySelector('[data-ai-drop]').addEventListener('click', () => { out.innerHTML = ''; });
  } catch (err) {
    console.error('[copy] gemini draft failed:', err);
    out.innerHTML = `<div class="cp-ai-out"><h4>Not available</h4><p style="font:var(--t-sm);color:var(--ink-2);margin:0">${escapeHtml(err.message || 'The writing assistant could not be reached.')}</p></div>`;
  } finally {
    busy(el.querySelector('[data-ai-go]'), false, 'Write me a draft');
  }
}

// ════════════════════════════════════════════════ history

async function loadHistory(p) {
  const box = p.el?.querySelector('[data-hist-body]');
  if (!box) return;
  p.historyBusy = true;
  box.innerHTML = '<div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div>';
  try {
    // Read straight from the table: message_copy_versions is admin-readable
    // under RLS and there is no list action for it.
    const { data, error } = await getSupabase()
      .from('message_copy_versions')
      .select('version, body, image_path, buttons, note, origin, published_by_name, created_at')
      .eq('message_key', p.def.key)
      .eq('language', p.lang)
      .order('version', { ascending: false })
      .limit(25);
    if (error) throw error;
    p.history = data || [];
  } catch (err) {
    console.error('[copy] history load failed:', err);
    p.history = null;
    box.innerHTML = `<p class="cp-chips-hint">Could not load the history (${escapeHtml(err.message || 'unknown error')}).</p>`;
    p.historyBusy = false;
    return;
  }
  p.historyBusy = false;
  paintHistory(p);
}

function paintHistory(p) {
  const box = p.el?.querySelector('[data-hist-body]');
  if (!box) return;
  if (!p.history?.length) {
    box.innerHTML = '<p class="cp-chips-hint">Nobody has published this message yet, so there is nothing in the history.</p>';
    return;
  }
  box.innerHTML = `<div class="cp-hist">${p.history.map((v, n) => `
    <div class="cp-hist-row">
      <span class="cp-hist-v">v${v.version}</span>
      <div class="cp-hist-main">
        <div class="cp-hist-meta">
          ${escapeHtml(formatDateTime(v.created_at))} ·
          ${escapeHtml(v.published_by_name || 'someone')} ·
          ${escapeHtml(ORIGIN_LABEL[v.origin] || v.origin)}
          ${v.image_path ? ' · with a picture' : ''}
          ${v.buttons ? ' · with buttons' : ''}
          ${v.note ? ` · ${escapeHtml(v.note)}` : ''}
        </div>
        <div class="cp-hist-body">${escapeHtml(v.body === null ? '(back to the built-in wording)' : v.body)}</div>
      </div>
      <button class="btn btn-secondary btn-sm" data-restore="${n}">Restore</button>
    </div>`).join('')}</div>`;

  box.querySelectorAll('[data-restore]').forEach((b) => {
    b.addEventListener('click', () => {
      const v = p.history[Number(b.getAttribute('data-restore'))];
      if (!v) return;
      if (v.body === null) { openRevert(p); return; }   // that version WAS a revert
      const ta = p.el.querySelector('[data-ta]');
      if (ta) ta.value = v.body;
      p.body = v.body;
      // A version is the WHOLE message. Publish is a full replace, so restoring
      // the words of a version that carried a picture and two buttons, while
      // leaving today's picture and buttons in place, would publish a message
      // that has never existed.
      p.imagePath = v.image_path ?? null;
      p.imageUrl = null;
      p.imageBytes = null;
      p.imageWarn = null;
      p.buttons = toEditorButtons(v.buttons ?? null);
      paintState(p); paintMeter(p); paintActions(p); paintImage(p); paintButtons(p);
      schedulePreview(p);
      openPublish(p);
    });
  });
}

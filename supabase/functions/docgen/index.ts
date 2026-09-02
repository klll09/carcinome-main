// docgen/index.ts — invoice + discharge-summary PDFs (CONTRACTS §docgen).
// Internal-only: Authorization Bearer must equal SERVICE_ROLE_KEY, OR
// x-internal-secret must equal CRON_SECRET. (verify_jwt is OFF; this guard is the auth.)
//
// POST { case_id, doc: 'invoice' | 'discharge' } →
//   { ok: true, path, media_id }   path = Storage key in bucket `case-docs`
//                                  media_id = WhatsApp media id (null if WA upload failed)
//
// Fonts: Noto Sans (₹) + Noto Sans Devanagari fetched once per isolate and cached in
// module scope; falls back to Helvetica with ₹→"Rs." and Devanagari stripped.
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from 'npm:pdf-lib@1.17.1';
import fontkit from 'npm:@pdf-lib/fontkit@1.1.1';
import { db, getSetting } from '../_shared/db.ts';
import { uploadMedia } from '../_shared/wa.ts';

const BUCKET = 'case-docs';
const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 40;
const BRAND = rgb(0.13, 0.23, 0.5);
const INK = rgb(0.13, 0.14, 0.17);
const MUTED = rgb(0.45, 0.47, 0.52);
const FAINT = rgb(0.93, 0.94, 0.96);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Constant-time string compare (fixed-length XOR loop over utf8 bytes). */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length === bb.length ? 0 : 1;
  const n = Math.max(ab.length, bb.length, 1);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i % (ab.length || 1)] ?? 0) ^ (bb[i % (bb.length || 1)] ?? 0);
  }
  return diff === 0;
}

// ─── Fonts (module-scope cache) ─────────────────────────────────────────────
const FONT_URLS = {
  regular: 'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf',
  bold: 'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Bold.ttf',
  devanagari: 'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSansDevanagari/hinted/ttf/NotoSansDevanagari-Regular.ttf',
};
let fontBytes: { regular: Uint8Array; bold: Uint8Array; devanagari: Uint8Array } | null = null;
let fontFetchFailed = false;

async function fetchFont(url: string): Promise<Uint8Array> {
  // Bounded: a slow CDN must degrade to the Helvetica fallback, not stall the
  // whole completion pipeline behind a hanging font download.
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`font fetch ${res.status}: ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function loadFontBytes(): Promise<typeof fontBytes> {
  if (fontBytes) return fontBytes;
  if (fontFetchFailed) return null;
  try {
    const [regular, bold, devanagari] = await Promise.all([
      fetchFont(FONT_URLS.regular),
      fetchFont(FONT_URLS.bold),
      fetchFont(FONT_URLS.devanagari),
    ]);
    fontBytes = { regular, bold, devanagari };
    return fontBytes;
  } catch (e) {
    console.error('font fetch failed — falling back to Helvetica:', e);
    fontFetchFailed = true;
    return null;
  }
}

// ─── Text handling ──────────────────────────────────────────────────────────
const DEVA_RE = /[ऀ-ॿ]/;

/** Keep only characters our fonts can render; harmonize punctuation. */
function cleanText(s: unknown, fallback: boolean): string {
  let t = String(s ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[\u2000-\u200B\u00A0]/g, ' ')
    .replace(/[\r\t]/g, ' ');
  if (fallback) {
    t = t.replace(/₹\s?/g, 'Rs. ').replace(/[ऀ-ॿ]/g, '');
    t = t.replace(/[^\x20-\x7E\n]/g, '');
  } else {
    // Noto Sans + Noto Sans Devanagari coverage: ASCII, Latin-1, punctuation, ₹, Devanagari.
    t = t.replace(/[^\x20-\x7E\n\u00A1-\u00FF\u2010-\u2027\u20B9\u0900-\u097F]/g, '');
  }
  return t;
}

type Fonts = { regular: PDFFont; bold: PDFFont; deva: PDFFont | null; fallback: boolean };

function splitRuns(text: string): { text: string; deva: boolean }[] {
  const runs: { text: string; deva: boolean }[] = [];
  let cur = '';
  let curDeva = false;
  for (const ch of text) {
    const d = DEVA_RE.test(ch);
    if (cur === '') {
      cur = ch;
      curDeva = d;
    } else if (d === curDeva || ch === ' ') {
      cur += ch; // spaces stay with the current run
    } else {
      runs.push({ text: cur, deva: curDeva });
      cur = ch;
      curDeva = d;
    }
  }
  if (cur) runs.push({ text: cur, deva: curDeva });
  return runs;
}

class Painter {
  constructor(public page: PDFPage, public f: Fonts) {}

  private fontFor(deva: boolean, bold: boolean): PDFFont {
    if (deva && this.f.deva) return this.f.deva;
    return bold ? this.f.bold : this.f.regular;
  }

  width(text: string, size: number, bold = false): number {
    const t = cleanText(text, this.f.fallback);
    let w = 0;
    for (const run of splitRuns(t)) {
      try {
        w += this.fontFor(run.deva, bold).widthOfTextAtSize(run.text, size);
      } catch {
        // unmeasurable run — approximate
        w += run.text.length * size * 0.55;
      }
    }
    return w;
  }

  /** Draw at (x, y). Returns the x after the drawn text. */
  text(
    text: string,
    x: number,
    y: number,
    opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {},
  ): number {
    const size = opts.size ?? 10;
    const color = opts.color ?? INK;
    const t = cleanText(text, this.f.fallback);
    let cx = x;
    for (const run of splitRuns(t)) {
      const font = this.fontFor(run.deva, opts.bold ?? false);
      try {
        this.page.drawText(run.text, { x: cx, y, size, font, color });
        cx += font.widthOfTextAtSize(run.text, size);
      } catch (e) {
        console.error('drawText run failed (skipped):', e);
      }
    }
    return cx;
  }

  textRight(text: string, xRight: number, y: number, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {}): void {
    const w = this.width(text, opts.size ?? 10, opts.bold ?? false);
    this.text(text, xRight - w, y, opts);
  }

  wrap(text: string, maxWidth: number, size: number, bold = false, maxLines = 12): string[] {
    const words = cleanText(text, this.f.fallback).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    let idx = 0;
    while (idx < words.length) {
      const candidate = line ? `${line} ${words[idx]}` : words[idx];
      if (!line || this.width(candidate, size, bold) <= maxWidth) {
        line = candidate; // a single overlong word still gets its own line
        idx++;
        continue;
      }
      if (lines.length >= maxLines - 1) break; // no room for another line
      lines.push(line);
      line = '';
    }
    if (idx < words.length) {
      // out of lines with words remaining — ellipsize the last line to fit
      let t = line;
      while (t.includes(' ') && this.width(`${t}...`, size, bold) > maxWidth) {
        t = t.slice(0, t.lastIndexOf(' '));
      }
      lines.push(`${t}...`);
    } else if (line) {
      lines.push(line);
    }
    return lines.length ? lines : [''];
  }

  rule(x1: number, y: number, x2: number, color = FAINT, thickness = 1): void {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, color, thickness });
  }

  rect(x: number, y: number, w: number, h: number, color: ReturnType<typeof rgb>, borderOnly = false): void {
    if (borderOnly) {
      this.page.drawRectangle({ x, y, width: w, height: h, borderColor: color, borderWidth: 1 });
    } else {
      this.page.drawRectangle({ x, y, width: w, height: h, color });
    }
  }
}

async function makeDoc(): Promise<{ pdf: PDFDocument; page: PDFPage; painter: Painter }> {
  const pdf = await PDFDocument.create();
  const bytes = await loadFontBytes();
  let fonts: Fonts;
  if (bytes) {
    try {
      // deno-lint-ignore no-explicit-any
      pdf.registerFontkit(fontkit as any);
      const [regular, bold, deva] = await Promise.all([
        pdf.embedFont(bytes.regular, { subset: true }),
        pdf.embedFont(bytes.bold, { subset: true }),
        pdf.embedFont(bytes.devanagari, { subset: true }),
      ]);
      fonts = { regular, bold, deva, fallback: false };
    } catch (e) {
      console.error('custom font embed failed — Helvetica fallback:', e);
      fonts = {
        regular: await pdf.embedFont(StandardFonts.Helvetica),
        bold: await pdf.embedFont(StandardFonts.HelveticaBold),
        deva: null,
        fallback: true,
      };
    }
  } else {
    fonts = {
      regular: await pdf.embedFont(StandardFonts.Helvetica),
      bold: await pdf.embedFont(StandardFonts.HelveticaBold),
      deva: null,
      fallback: true,
    };
  }
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  return { pdf, page, painter: new Painter(page, fonts) };
}

// ─── Shared bits ────────────────────────────────────────────────────────────
function fmtIST(ts: string | null | undefined, withTime = true): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      ...(withTime ? { hour: 'numeric', minute: '2-digit', hour12: true } : {}),
    });
  } catch {
    return String(ts);
  }
}

function money(n: number): string {
  return `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const CARE_LABELS: Record<string, string> = {
  one_time_infusion: 'One-time infusion',
  chemo_infusion: 'Chemotherapy infusion',
  nursing_12h: '12-hour nursing',
  nursing_24h: '24-hour nursing',
};
const LINE_LABELS: Record<string, string> = {
  chemo_port: 'Chemo Port',
  picc: 'PICC Line',
  peripheral: 'Peripheral Line',
  other: 'Other',
};

async function labels(): Promise<{ care: Record<string, string>; line: Record<string, string> }> {
  const care = (await getSetting<Record<string, string>>('care_type_labels')) ?? CARE_LABELS;
  const line = (await getSetting<Record<string, string>>('line_type_labels')) ?? LINE_LABELS;
  return { care: { ...CARE_LABELS, ...care }, line: { ...LINE_LABELS, ...line } };
}

// ─── Document templates (editable from the dashboard Flow Studio) ───────────
// Stored in settings as doc_template_invoice / doc_template_discharge; every
// string may carry {{placeholders}} resolved against the doc's data map. The
// defaults below mirror the original hardcoded layout exactly, and any missing
// key in a stored template falls back to them — a half-edited template can
// never blank out a document.

export type TplCell = { label: string; value: string; skip_if_empty?: boolean };
export type TplSection = { title: string; rows: TplCell[][] };

const INVOICE_TPL_DEFAULT = {
  title: 'INVOICE',
  accent: '#213B80',
  tagline: 'Oncology home care · WhatsApp-coordinated',
  labels: {
    bill_to: 'BILL TO',
    case_details: 'CASE DETAILS',
    description: 'DESCRIPTION',
    qty: 'QTY',
    amount: 'AMOUNT',
    subtotal: 'Subtotal',
    discount: 'Discount',
    total_due: 'TOTAL DUE',
    pay_via_upi: 'PAY VIA UPI',
    case: 'Case',
    care_type: 'Care type',
    session_date: 'Session date',
    completed: 'Completed',
    phone: 'Phone',
    patient_code: 'Patient code',
  },
  upi_help:
    'Open any UPI app, pay to the UPI ID above, then tap "I\'ve paid" on WhatsApp so our team can confirm your payment.',
  paid_note: 'PAID — payment received and verified. Thank you.',
  footer_note: '{{business}} · This is a computer-generated invoice; no signature is required.',
};

const DISCHARGE_TPL_DEFAULT = {
  title: 'DISCHARGE SUMMARY',
  accent: '#213B80',
  tagline: 'Oncology home care · WhatsApp-coordinated',
  sections: [
    {
      title: 'Patient',
      rows: [
        [{ label: 'Name', value: '{{patient.name}}' }, { label: 'Patient code', value: '{{patient.code}}' }],
        [{ label: 'Cancer type', value: '{{patient.cancer_type}}' }, { label: 'Phone', value: '{{patient.phone}}' }],
        [{ label: 'Address', value: '{{case.address}}' }],
      ],
    },
    {
      title: 'Care episode',
      rows: [
        [{ label: 'Case', value: '{{case.code}}' }, { label: 'Care type', value: '{{case.care_type}}' }],
        [{ label: 'Line / access', value: '{{case.line_type}}' }, { label: 'Referring doctor', value: '{{doctor.name}}' }],
        [{ label: 'Attending nurse', value: '{{nurse.name}}' }, { label: 'Scheduled', value: '{{case.scheduled}}' }],
        [{ label: 'Nurse arrival verified', value: '{{case.arrival_verified}}' }, { label: 'Care completed', value: '{{case.completed}}' }],
      ],
    },
    {
      title: 'Session report (as recorded by the attending nurse)',
      rows: [
        [{ label: 'Session started', value: '{{report.started}}' }, { label: 'Session ended', value: '{{report.ended}}' }],
        [{ label: 'Medications administered', value: '{{report.meds}}' }],
        [{ label: 'Complications', value: '{{report.complications}}' }],
        [{ label: 'Additional notes', value: '{{report.notes}}', skip_if_empty: true }],
      ],
    },
    {
      title: 'Consent',
      rows: [
        [{ label: 'Consent signed by', value: '{{consent.signed_by}}' }, { label: 'Consent status', value: '{{consent.status}}' }],
      ],
    },
  ] as TplSection[],
  signature_label: 'Authorised signatory — {{business}}',
  source_note: "Generated from the nurse's completion report — {{business}}",
  footer_note: "{{business}} · This summary is for the patient's medical records.",
};

function hexToRgb(hex: unknown): ReturnType<typeof rgb> {
  const m = String(hex ?? '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return BRAND;
  const v = parseInt(m[1], 16);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

/** Replace {{token}} against the data map; unknown tokens become ''. */
function resolveTpl(s: unknown, map: Record<string, string>): string {
  return String(s ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => map[k] ?? '');
}

/** Deep-ish merge a stored template over the default (labels merge, sections replace). */
// deno-lint-ignore no-explicit-any
function mergeTpl<T extends Record<string, any>>(def: T, stored: unknown): T {
  if (!stored || typeof stored !== 'object') return def;
  // deno-lint-ignore no-explicit-any
  const s = stored as Record<string, any>;
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = { ...def };
  for (const k of Object.keys(def)) {
    if (s[k] == null) continue;
    if (k === 'labels' && typeof s[k] === 'object') out[k] = { ...def[k], ...s[k] };
    else out[k] = s[k];
  }
  return out as T;
}

/** Clamp a stored sections array into a drawable shape (bad data must never crash docgen). */
function safeSections(raw: unknown, fallback: TplSection[]): TplSection[] {
  if (!Array.isArray(raw)) return fallback;
  const out: TplSection[] = [];
  for (const sec of raw.slice(0, 10)) {
    if (!sec || typeof sec !== 'object') continue;
    const rows: TplCell[][] = [];
    for (const row of (Array.isArray((sec as TplSection).rows) ? (sec as TplSection).rows : []).slice(0, 20)) {
      if (!Array.isArray(row)) continue;
      const cells = row.slice(0, 2)
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          label: String((c as TplCell).label ?? '').slice(0, 120),
          value: String((c as TplCell).value ?? '').slice(0, 600),
          skip_if_empty: Boolean((c as TplCell).skip_if_empty),
        }));
      if (cells.length) rows.push(cells);
    }
    out.push({ title: String((sec as TplSection).title ?? '').slice(0, 140), rows });
  }
  return out.length ? out : fallback;
}

async function loadTpl(kind: 'invoice' | 'discharge', override?: unknown) {
  const stored = override ?? (await getSetting(`doc_template_${kind}`));
  return kind === 'invoice' ? mergeTpl(INVOICE_TPL_DEFAULT, stored) : mergeTpl(DISCHARGE_TPL_DEFAULT, stored);
}

function brandBand(p: Painter, accent: ReturnType<typeof rgb>, businessName: string, tagline: string, docTitle: string, refLine: string, dateLine: string): number {
  p.rect(0, PAGE_H - 96, PAGE_W, 96, accent);
  p.text(businessName, MARGIN, PAGE_H - 46, { size: 19, bold: true, color: rgb(1, 1, 1) });
  p.text(tagline, MARGIN, PAGE_H - 64, { size: 9, color: rgb(0.85, 0.89, 1) });
  p.textRight(docTitle, PAGE_W - MARGIN, PAGE_H - 46, { size: 18, bold: true, color: rgb(1, 1, 1) });
  p.textRight(refLine, PAGE_W - MARGIN, PAGE_H - 64, { size: 10, color: rgb(0.85, 0.89, 1) });
  p.textRight(dateLine, PAGE_W - MARGIN, PAGE_H - 78, { size: 9, color: rgb(0.85, 0.89, 1) });
  return PAGE_H - 126; // first content y
}

function footer(p: Painter, note: string): void {
  p.rule(MARGIN, 58, PAGE_W - MARGIN, FAINT);
  p.text(note, MARGIN, 44, { size: 8, color: MUTED });
  p.textRight(`Generated ${fmtIST(new Date().toISOString())} IST`, PAGE_W - MARGIN, 44, { size: 8, color: MUTED });
}

/** Key/value row helper; returns next y. */
function kv(p: Painter, label: string, value: string, x: number, y: number, valueWidth = 380): number {
  p.text(label.toUpperCase(), x, y, { size: 7.5, bold: true, color: MUTED });
  const lines = p.wrap(value || '—', valueWidth, 10, false, 4);
  let yy = y - 12;
  for (const ln of lines) {
    p.text(ln, x, yy, { size: 10 });
    yy -= 13;
  }
  return yy - 4;
}

// ─── Invoice ────────────────────────────────────────────────────────────────
type InvoiceData = {
  map: Record<string, string>;
  items: { name: string; qty: number; amount: number }[];
  subtotal: number;
  discount: number;
  total: number;
  upi: string;
  paid: boolean;
};

async function renderInvoice(tpl: typeof INVOICE_TPL_DEFAULT, d: InvoiceData): Promise<Uint8Array> {
  const accent = hexToRgb(tpl.accent);
  const L = tpl.labels;
  const R = (s: unknown) => resolveTpl(s, d.map);
  const { pdf, painter: p } = await makeDoc();
  let y = brandBand(p, accent, d.map['business'], R(tpl.tagline), R(tpl.title), d.map['invoice.no'], `Date: ${d.map['invoice.date']}`);

  // Bill-to (left) + case meta (right)
  p.text(R(L.bill_to), MARGIN, y, { size: 7.5, bold: true, color: MUTED });
  p.text(R(L.case_details), 330, y, { size: 7.5, bold: true, color: MUTED });
  y -= 15;
  p.text(d.map['patient.name'] || '—', MARGIN, y, { size: 12, bold: true });
  let ly = y - 15;
  for (const ln of p.wrap(d.map['patient.address'] ?? '', 250, 9.5, false, 3)) {
    p.text(ln, MARGIN, ly, { size: 9.5, color: MUTED });
    ly -= 12;
  }
  p.text(`${R(L.phone)}: ${d.map['patient.phone'] || '—'}`, MARGIN, ly, { size: 9.5, color: MUTED });
  ly -= 12;
  p.text(`${R(L.patient_code)}: ${d.map['patient.code'] || '—'}`, MARGIN, ly, { size: 9.5, color: MUTED });

  let ry = y;
  const rlabel = (k: string, v: string) => {
    p.text(k, 330, ry, { size: 9, color: MUTED });
    p.textRight(v, PAGE_W - MARGIN, ry, { size: 9.5 });
    ry -= 14;
  };
  rlabel(R(L.case), d.map['case.code'] || '—');
  rlabel(R(L.care_type), d.map['case.care_type'] || '—');
  rlabel(R(L.session_date), d.map['case.scheduled'] || '—');
  rlabel(R(L.completed), d.map['case.completed'] || '—');

  y = Math.min(ly, ry) - 28;

  p.rect(MARGIN, y - 6, PAGE_W - 2 * MARGIN, 22, FAINT);
  p.text(R(L.description), MARGIN + 8, y, { size: 8, bold: true, color: MUTED });
  p.textRight(R(L.qty), 430, y, { size: 8, bold: true, color: MUTED });
  p.textRight(R(L.amount), PAGE_W - MARGIN - 8, y, { size: 8, bold: true, color: MUTED });
  y -= 24;

  // Items — bounded: totals + the UPI box below need ~250pt, so the table
  // stops with an honest "…and N more" line instead of drawing off the page.
  let drawn = 0;
  for (const it of d.items) {
    if (y < 340 && drawn < d.items.length - 1) break;
    const lines = p.wrap(it.name, 300, 10, false, 2);
    p.text(lines[0], MARGIN + 8, y, { size: 10 });
    p.textRight(String(it.qty), 430, y, { size: 10 });
    p.textRight(money(it.amount), PAGE_W - MARGIN - 8, y, { size: 10 });
    y -= 14;
    for (const extra of lines.slice(1)) {
      p.text(extra, MARGIN + 8, y, { size: 10 });
      y -= 14;
    }
    p.rule(MARGIN, y + 4, PAGE_W - MARGIN);
    y -= 8;
    drawn++;
  }
  if (drawn < d.items.length) {
    p.text(`… and ${d.items.length - drawn} more item(s) — the total below covers everything.`, MARGIN + 8, y, { size: 9, color: MUTED });
    y -= 18;
  }

  // Totals
  const totX = 360;
  const totRight = PAGE_W - MARGIN - 8;
  p.text(R(L.subtotal), totX, y, { size: 10, color: MUTED });
  p.textRight(money(d.subtotal), totRight, y, { size: 10 });
  y -= 16;
  if (d.discount > 0) {
    p.text(R(L.discount), totX, y, { size: 10, color: MUTED });
    p.textRight(`- ${money(d.discount)}`, totRight, y, { size: 10 });
    y -= 16;
  }
  y -= 10; // clear the row above before painting the highlight box
  p.rect(totX - 10, y - 8, PAGE_W - MARGIN - totX + 10, 26, FAINT);
  p.text(R(L.total_due), totX, y, { size: 11, bold: true });
  p.textRight(money(d.total), totRight, y, { size: 12, bold: true });
  y -= 44;

  // UPI box
  p.rect(MARGIN, y - 58, PAGE_W - 2 * MARGIN, 72, accent, true);
  p.text(R(L.pay_via_upi), MARGIN + 14, y - 6, { size: 8, bold: true, color: accent });
  p.text(d.upi || '—', MARGIN + 14, y - 24, { size: 14, bold: true });
  let uy = y - 42;
  for (const ln of p.wrap(R(tpl.upi_help), PAGE_W - 2 * MARGIN - 28, 8.5, false, 2)) {
    p.text(ln, MARGIN + 14, uy, { size: 8.5, color: MUTED });
    uy -= 11;
  }
  y -= 80;

  if (d.paid) {
    p.text(R(tpl.paid_note), MARGIN, y, { size: 10, bold: true, color: rgb(0.1, 0.5, 0.25) });
  }

  footer(p, R(tpl.footer_note));
  return new Uint8Array(await pdf.save());
}

// deno-lint-ignore no-explicit-any
async function buildInvoice(c: any): Promise<{ bytes: Uint8Array; invoiceId: string } | { error: string }> {
  const { data: inv, error } = await db.from('invoices').select('*').eq('case_id', c.id).maybeSingle();
  if (error) return { error: `invoice_lookup_failed: ${error.message}` };
  if (!inv) return { error: 'no_invoice_for_case' };

  const business = (await getSetting<string>('business_name')) ?? 'Carcinome Home Care';
  const upi = inv.upi_vpa || ((await getSetting<string>('upi_vpa')) ?? '');
  const { care } = await labels();
  const tpl = await loadTpl('invoice');
  const patient = c.patients ?? {};

  const items: { name: string; qty: number; amount: number }[] = [];
  const raw = Array.isArray(inv.line_items) ? inv.line_items.slice(0, 40) : [];
  for (const it of raw) {
    const qtyN = Number(it?.qty);
    const amtN = Number(it?.amount ?? it?.amount_inr ?? it?.total ?? 0);
    items.push({
      name: String(it?.name ?? it?.label ?? 'Home care service'),
      qty: isFinite(qtyN) && qtyN > 0 ? qtyN : 1,
      amount: isFinite(amtN) ? amtN : 0, // "₹NaN" must never reach a family's bill
    });
  }
  if (items.length === 0) {
    items.push({
      name: care[c.care_type] ?? 'Home care service',
      qty: 1,
      amount: Number(inv.subtotal_inr ?? c.price_inr ?? 0),
    });
  }

  const bytes = await renderInvoice(tpl as typeof INVOICE_TPL_DEFAULT, {
    map: {
      business,
      'invoice.no': String(inv.invoice_no ?? ''),
      'invoice.date': fmtIST(inv.created_at, false),
      'patient.name': patient.full_name ?? '—',
      'patient.address': patient.address ?? c.address ?? '',
      'patient.phone': `+${patient.phone ?? patient.wa_number ?? '—'}`,
      'patient.code': patient.patient_code ?? '—',
      'case.code': c.case_code ?? '—',
      'case.care_type': care[c.care_type] ?? c.care_type ?? '—',
      'case.scheduled': fmtIST(c.scheduled_at),
      'case.completed': fmtIST(c.completed_at),
      upi,
    },
    items,
    subtotal: isFinite(Number(inv.subtotal_inr)) ? Number(inv.subtotal_inr) : 0,
    discount: isFinite(Number(inv.discount_inr)) ? Number(inv.discount_inr) : 0,
    total: isFinite(Number(inv.total_inr)) ? Number(inv.total_inr) : 0,
    upi,
    paid: inv.status === 'paid_verified',
  });
  return { bytes, invoiceId: inv.id };
}

// ─── Discharge summary ──────────────────────────────────────────────────────
async function renderDischarge(
  tpl: typeof DISCHARGE_TPL_DEFAULT,
  map: Record<string, string>,
  opts: { reportMissing?: boolean; dateLine: string; refLine: string } ,
): Promise<Uint8Array> {
  const accent = hexToRgb(tpl.accent);
  const R = (s: unknown) => resolveTpl(s, map);
  const { pdf, painter: p } = await makeDoc();
  let y = brandBand(p, accent, map['business'], R(tpl.tagline), R(tpl.title), opts.refLine, `Date: ${opts.dateLine}`);

  const section = (title: string): void => {
    p.text(title.toUpperCase(), MARGIN, y, { size: 9, bold: true, color: accent });
    p.rule(MARGIN, y - 5, PAGE_W - MARGIN);
    y -= 22;
  };
  const colW = (PAGE_W - 2 * MARGIN) / 2;
  const pair = (l1: string, v1: string, l2?: string, v2?: string): void => {
    const yA = kv(p, l1, v1, MARGIN, y, colW - 20);
    const yB = l2 !== undefined ? kv(p, l2, v2 ?? '—', MARGIN + colW, y, colW - 20) : y - 29;
    y = Math.min(yA, yB) - 4;
  };

  const sections = safeSections(tpl.sections, DISCHARGE_TPL_DEFAULT.sections);
  // The "report not yet submitted" note belongs to whichever section actually
  // references report fields — never a hardcoded index (teams reorder sections).
  const reportSectionIdx = sections.findIndex((s) =>
    s.rows.some((row) => row.some((cell) => /\{\{\s*report\./.test(cell.value)))
  );
  // Rows are PRE-MEASURED (a two-cell row with 4-line wraps stands ~76pt tall)
  // so nothing can overprint the signature/footer band below y≈112.
  const FLOOR = 112;
  const rowHeight = (a: TplCell, v1: string, b?: TplCell, v2?: string): number => {
    const la = p.wrap(v1 || '—', colW - 20, 10, false, 4).length;
    const lb = b ? p.wrap(v2 || '—', colW - 20, 10, false, 4).length : 0;
    return 12 + Math.max(la, lb, 1) * 13 + 8;
  };
  let clipped = false;
  outer:
  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    if (y - 42 < FLOOR) { clipped = true; break; } // title + at least one row must fit
    section(sec.title);
    for (const row of sec.rows) {
      const [a, b] = row;
      const v1 = R(a.value);
      const v2 = b ? R(b.value) : undefined;
      if (a.skip_if_empty && !v1 && (!b || (b.skip_if_empty && !v2))) continue;
      if (y - rowHeight(a, v1, b, v2) < FLOOR) { clipped = true; break outer; }
      if (b) pair(R(a.label), v1 || '—', R(b.label), v2 || '—');
      else pair(R(a.label), v1 || '—');
    }
    if (si === reportSectionIdx && opts.reportMissing) {
      if (y - 20 < FLOOR) { clipped = true; break; }
      p.text('Completion report not yet submitted for this case.', MARGIN, y, { size: 9.5, color: MUTED });
      y -= 20;
    }
  }
  if (clipped) {
    p.text('… content trimmed to fit one page — shorten the template sections.', MARGIN, Math.max(y, FLOOR), { size: 8.5, color: MUTED });
    y = Math.max(y - 16, FLOOR - 2);
  }

  // Signature + disclaimer
  const sigY = Math.max(y - 30, 110);
  p.rule(PAGE_W - MARGIN - 180, sigY, PAGE_W - MARGIN, MUTED);
  p.textRight(R(tpl.signature_label), PAGE_W - MARGIN, sigY - 12, { size: 8.5, color: MUTED });
  p.text(R(tpl.source_note), MARGIN, 78, { size: 8.5, color: MUTED });
  footer(p, R(tpl.footer_note));
  return new Uint8Array(await pdf.save());
}

// deno-lint-ignore no-explicit-any
async function buildDischarge(c: any): Promise<{ bytes: Uint8Array } | { error: string }> {
  const [{ data: report }, { data: consent }] = await Promise.all([
    db.from('completion_reports').select('*').eq('case_id', c.id).maybeSingle(),
    db.from('consents').select('signed_name, relationship, agreed').eq('case_id', c.id).maybeSingle(),
  ]);
  const business = (await getSetting<string>('business_name')) ?? 'Carcinome Home Care';
  const { care, line } = await labels();
  const tpl = await loadTpl('discharge');
  const patient = c.patients ?? {};
  const doctor = c.doctors ?? null;
  const nurse = c.nurses ?? null;

  const compl = report?.complications ?? '';
  const map: Record<string, string> = {
    business,
    'patient.name': patient.full_name ?? '',
    'patient.code': patient.patient_code ?? '',
    'patient.cancer_type': patient.cancer_type ?? '',
    'patient.phone': `+${patient.phone ?? patient.wa_number ?? '—'}`,
    'case.address': c.address || patient.address || '',
    'case.code': c.case_code ?? '',
    'case.care_type': care[c.care_type] ?? c.care_type ?? '',
    'case.line_type': line[c.line_type] ?? c.line_type ?? '',
    'doctor.name': doctor
      ? `Dr. ${String(doctor.full_name).replace(/^\s*Dr\.?\s+/i, '')}${doctor.specialty ? ` (${doctor.specialty})` : ''}`
      : '',
    'nurse.name': nurse?.full_name ?? '',
    'case.scheduled': fmtIST(c.scheduled_at),
    'case.arrival_verified': fmtIST(c.arrival_verified_at),
    'case.completed': fmtIST(c.completed_at),
    'report.started': report?.started_hhmm ?? '',
    'report.ended': report?.ended_hhmm ?? '',
    'report.meds': report?.meds_administered ?? '',
    'report.complications': report?.complication_notes ? `${compl || '—'} — ${report.complication_notes}` : compl,
    'report.notes': report?.notes ?? '',
    'consent.signed_by': consent?.signed_name
      ? `${consent.signed_name}${consent.relationship ? ` (${consent.relationship})` : ''}`
      : '',
    'consent.status': consent ? (consent.agreed ? 'Given via WhatsApp consent form' : 'DECLINED') : 'Not on record',
  };

  const bytes = await renderDischarge(tpl as typeof DISCHARGE_TPL_DEFAULT, map, {
    reportMissing: !report,
    refLine: c.case_code ?? '',
    dateLine: fmtIST(c.completed_at ?? new Date().toISOString(), false),
  });
  return { bytes };
}

// ─── Preview (sample data, returned inline — powers the template editor) ────
async function buildPreview(doc: 'invoice' | 'discharge', override: unknown): Promise<Uint8Array> {
  const business = (await getSetting<string>('business_name')) ?? 'Carcinome Home Care';
  const upi = (await getSetting<string>('upi_vpa')) ?? 'carcinome@upi';
  const now = new Date().toISOString();
  if (doc === 'invoice') {
    const tpl = await loadTpl('invoice', override);
    return await renderInvoice(tpl as typeof INVOICE_TPL_DEFAULT, {
      map: {
        business,
        'invoice.no': 'INV-2026-0042',
        'invoice.date': fmtIST(now, false),
        'patient.name': 'Meera Sharma',
        'patient.address': '12 Rose Villa, Andheri West, Mumbai 400058',
        'patient.phone': '+91 90000 00010',
        'patient.code': 'CHC-2026-0042',
        'case.code': 'CASE-2026-0042',
        'case.care_type': 'Chemotherapy infusion',
        'case.scheduled': fmtIST(now),
        'case.completed': fmtIST(now),
        upi,
      },
      items: [{ name: 'Chemotherapy infusion — home visit', qty: 1, amount: 5000 }],
      subtotal: 5000,
      discount: 0,
      total: 5000,
      upi,
      paid: false,
    });
  }
  const tpl = await loadTpl('discharge', override);
  return await renderDischarge(tpl as typeof DISCHARGE_TPL_DEFAULT, {
    business,
    'patient.name': 'Meera Sharma',
    'patient.code': 'CHC-2026-0042',
    'patient.cancer_type': 'Breast cancer',
    'patient.phone': '+91 90000 00010',
    'case.address': '12 Rose Villa, Andheri West, Mumbai 400058',
    'case.code': 'CASE-2026-0042',
    'case.care_type': 'Chemotherapy infusion',
    'case.line_type': 'PICC Line',
    'doctor.name': 'Dr. Arjun Mehta (Medical Oncology)',
    'nurse.name': 'Priya',
    'case.scheduled': fmtIST(now),
    'case.arrival_verified': fmtIST(now),
    'case.completed': fmtIST(now),
    'report.started': '14:20',
    'report.ended': '16:05',
    'report.meds': 'Paclitaxel 175mg/m² IV over 3h; Ondansetron 8mg IV',
    'report.complications': 'None',
    'report.notes': 'Patient tolerated the session well. Next dressing change in 7 days.',
    'consent.signed_by': 'Ramesh Sharma (spouse)',
    'consent.status': 'Given via WhatsApp consent form',
  }, { reportMissing: false, refLine: 'CASE-2026-0042', dateLine: fmtIST(now, false) });
}

// ─── HTTP entry ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  // Internal guard
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const internal = req.headers.get('x-internal-secret') ?? '';
  const authorized = (serviceKey !== '' && safeEqual(bearer, serviceKey)) ||
    (cronSecret !== '' && safeEqual(internal, cronSecret));
  if (!authorized) return json({ ok: false, error: 'forbidden' }, 403);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const caseId = String(body?.case_id ?? '');
  const doc = String(body?.doc ?? '');
  if (!['invoice', 'discharge'].includes(doc)) {
    return json({ ok: false, error: "doc ('invoice'|'discharge') required" }, 400);
  }

  // Preview mode: render with SAMPLE data (optionally an unsaved template
  // override) and return the PDF inline — no storage, no WhatsApp upload.
  if (body?.preview === true) {
    try {
      const bytes = await buildPreview(doc as 'invoice' | 'discharge', body?.template ?? undefined);
      let b64 = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        b64 += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      return json({ ok: true, pdf_base64: btoa(b64) });
    } catch (e) {
      console.error(`docgen preview(${doc}) exception:`, e);
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  if (!caseId) {
    return json({ ok: false, error: 'case_id required' }, 400);
  }

  const { data: c, error: caseErr } = await db
    .from('cases')
    .select(
      'id, case_code, status, care_type, line_type, scheduled_at, address, price_inr, ' +
      'arrival_verified_at, completed_at, ' +
      'patients:patient_id(id, full_name, patient_code, cancer_type, address, phone, wa_number, language_pref), ' +
      'doctors:doctor_id(full_name, specialty), ' +
      'nurses:assigned_nurse_id(full_name, phone)',
    )
    .eq('id', caseId)
    .maybeSingle();
  if (caseErr) return json({ ok: false, error: `case_lookup_failed: ${caseErr.message}` }, 500);
  if (!c) return json({ ok: false, error: 'case_not_found' }, 404);

  try {
    let bytes: Uint8Array;
    let path: string;
    let invoiceId: string | null = null;

    if (doc === 'invoice') {
      const r = await buildInvoice(c);
      if ('error' in r) return json({ ok: false, error: r.error }, 400);
      bytes = r.bytes;
      invoiceId = r.invoiceId;
      path = `cases/${caseId}/invoice.pdf`;
    } else {
      const r = await buildDischarge(c);
      if ('error' in r) return json({ ok: false, error: r.error }, 400);
      bytes = r.bytes;
      path = `cases/${caseId}/discharge_summary.pdf`;
    }

    const { error: upErr } = await db.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) return json({ ok: false, error: `storage_upload_failed: ${upErr.message}` }, 500);

    if (invoiceId) {
      await db.from('invoices').update({ pdf_path: path }).eq('id', invoiceId);
    }

    let mediaId: string | null = null;
    let mediaError: string | undefined;
    try {
      mediaId = await uploadMedia(bytes, 'application/pdf');
    } catch (e) {
      console.error('WA media upload failed:', e);
      mediaError = String(e);
    }

    return json({ ok: true, path, media_id: mediaId, ...(mediaError ? { media_error: mediaError } : {}) });
  } catch (e) {
    console.error(`docgen(${doc}) exception:`, e);
    return json({ ok: false, error: String(e) }, 500);
  }
});

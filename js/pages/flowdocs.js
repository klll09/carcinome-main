// ============================================================
// Carcinome Home Care: Documents (#documents)
// Invoice and discharge formats. Edit the ACTUAL formats of the
// invoice + discharge summary PDFs the system sends. Stored in
// settings (doc_template_*); docgen merges them over its built-in
// defaults at send time.
// Live preview renders a real PDF with sample data.
// ============================================================
import { getSupabase } from '../supabase.js';
import { adminAction } from '../utils/api.js';
import { showToast } from '../components/toast.js';
import { confirmModal } from '../components/modal.js';
import { escapeHtml } from '../utils/formatters.js';

// Client-side copies of docgen's defaults, so the form always has something
// to show even before a template was ever customized. Keep in sync with docgen.
const INVOICE_DEFAULT = {
  title: 'INVOICE',
  accent: '#213B80',
  tagline: 'Oncology home care · WhatsApp-coordinated',
  labels: {
    bill_to: 'BILL TO', case_details: 'CASE DETAILS', description: 'DESCRIPTION', qty: 'QTY',
    amount: 'AMOUNT', subtotal: 'Subtotal', discount: 'Discount', total_due: 'TOTAL DUE',
    pay_via_upi: 'PAY VIA UPI', case: 'Case', care_type: 'Care type', session_date: 'Session date',
    completed: 'Completed', phone: 'Phone', patient_code: 'Patient code',
  },
  upi_help: 'Open any UPI app, pay to the UPI ID above, then tap "I\'ve paid" on WhatsApp so our team can confirm your payment.',
  paid_note: 'PAID - payment received and verified. Thank you.',
  footer_note: '{{business}} · This is a computer-generated invoice; no signature is required.',
};
const DISCHARGE_DEFAULT = {
  title: 'DISCHARGE SUMMARY',
  accent: '#213B80',
  tagline: 'Oncology home care · WhatsApp-coordinated',
  sections: [
    { title: 'Patient', rows: [
      [{ label: 'Name', value: '{{patient.name}}' }, { label: 'Patient code', value: '{{patient.code}}' }],
      [{ label: 'Cancer type', value: '{{patient.cancer_type}}' }, { label: 'Phone', value: '{{patient.phone}}' }],
      [{ label: 'Address', value: '{{case.address}}' }],
    ] },
    { title: 'Care episode', rows: [
      [{ label: 'Case', value: '{{case.code}}' }, { label: 'Care type', value: '{{case.care_type}}' }],
      [{ label: 'Line / access', value: '{{case.line_type}}' }, { label: 'Referring doctor', value: '{{doctor.name}}' }],
      [{ label: 'Attending nurse', value: '{{nurse.name}}' }, { label: 'Scheduled', value: '{{case.scheduled}}' }],
      [{ label: 'Nurse arrival verified', value: '{{case.arrival_verified}}' }, { label: 'Care completed', value: '{{case.completed}}' }],
    ] },
    { title: 'Session report (as recorded by the attending nurse)', rows: [
      [{ label: 'Session started', value: '{{report.started}}' }, { label: 'Session ended', value: '{{report.ended}}' }],
      [{ label: 'Medications administered', value: '{{report.meds}}' }],
      [{ label: 'Complications', value: '{{report.complications}}' }],
      [{ label: 'Additional notes', value: '{{report.notes}}', skip_if_empty: true }],
    ] },
    { title: 'Consent', rows: [
      [{ label: 'Consent signed by', value: '{{consent.signed_by}}' }, { label: 'Consent status', value: '{{consent.status}}' }],
    ] },
  ],
  signature_label: 'Authorised signatory - {{business}}',
  source_note: "Generated from the nurse's completion report - {{business}}",
  footer_note: "{{business}} · This summary is for the patient's medical records.",
};

const PLACEHOLDERS = [
  ['{{business}}', 'organisation name'],
  ['{{patient.name}}', 'patient full name'], ['{{patient.code}}', 'patient code'],
  ['{{patient.cancer_type}}', 'cancer type'], ['{{patient.phone}}', 'patient phone'],
  ['{{case.address}}', 'care address'], ['{{case.code}}', 'case code'],
  ['{{case.care_type}}', 'care type'], ['{{case.line_type}}', 'line / access'],
  ['{{case.scheduled}}', 'scheduled at'], ['{{case.arrival_verified}}', 'arrival verified at'],
  ['{{case.completed}}', 'completed at'],
  ['{{doctor.name}}', 'referring doctor'], ['{{nurse.name}}', 'attending nurse'],
  ['{{report.started}}', 'session start'], ['{{report.ended}}', 'session end'],
  ['{{report.meds}}', 'medications given'], ['{{report.complications}}', 'complications'],
  ['{{report.notes}}', 'nurse notes'],
  ['{{consent.signed_by}}', 'consent signer'], ['{{consent.status}}', 'consent status'],
];

const deep = (o) => JSON.parse(JSON.stringify(o));

export async function renderFlowDocs(container) {
  const sb = getSupabase();
  container.innerHTML = `<h2 style="margin:0 0 6px">Documents</h2><p style="color:var(--ink-soft,#777)">Loading…</p>`;

  const { data: rows, error } = await sb.from('settings').select('key, value')
    .in('key', ['doc_template_invoice', 'doc_template_discharge']);
  if (error) {
    container.innerHTML = `<div class="empty-state"><h3>Could not load templates</h3><p>${escapeHtml(error.message)}</p></div>`;
    return;
  }
  const stored = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value]));
  const state = {
    kind: 'discharge',
    invoice: { ...deep(INVOICE_DEFAULT), ...(stored.doc_template_invoice ?? {}), labels: { ...INVOICE_DEFAULT.labels, ...(stored.doc_template_invoice?.labels ?? {}) } },
    discharge: { ...deep(DISCHARGE_DEFAULT), ...(stored.doc_template_discharge ?? {}) },
    dirty: false,
  };
  if (!Array.isArray(state.discharge.sections)) state.discharge.sections = deep(DISCHARGE_DEFAULT.sections);

  let previewTimer = null;
  let previewSeq = 0;
  let lastFocusedInput = null;
  let lastBlobUrl = null;

  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 900);
  };
  const refreshPreview = async () => {
    const seq = ++previewSeq;
    const box = container.querySelector('#fd-preview-box');
    if (!box) return;
    box.innerHTML = `<div class="fd-loading">Rendering preview…</div>`;
    try {
      const res = await adminAction('preview_doc', { doc: state.kind, template: state[state.kind] });
      if (seq !== previewSeq) return;
      const bytes = Uint8Array.from(atob(res.pdf_base64), (c) => c.charCodeAt(0));
      if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
      lastBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      box.innerHTML = `<iframe src="${lastBlobUrl}#toolbar=0&view=FitH" title="preview"></iframe>`;
    } catch (e) {
      if (seq !== previewSeq) return;
      box.innerHTML = `<div class="fd-loading">Preview failed: ${escapeHtml(e.message)}</div>`;
    }
  };

  const markDirty = () => { state.dirty = true; container.querySelector('#fd-save-note').textContent = 'Unsaved changes'; schedulePreview(); };

  const field = (label, key, value, { textarea = false, obj = null } = {}) => `
    <div class="fd-field">
      <label>${label}</label>
      ${textarea
        ? `<textarea data-tkey="${key}" ${obj ? `data-tobj="${obj}"` : ''}>${escapeHtml(value ?? '')}</textarea>`
        : `<input type="text" data-tkey="${key}" ${obj ? `data-tobj="${obj}"` : ''} value="${escapeHtml(value ?? '')}" />`}
    </div>`;

  const drawEditor = () => {
    const t = state[state.kind];
    const panel = container.querySelector('#fd-editor');
    if (state.kind === 'invoice') {
      panel.innerHTML = `
        <h3>Invoice format</h3>
        <div class="fd-sub">Amounts, line items and the UPI ID come from the live case. Here you control every label, color and sentence around them.</div>
        <div class="fd-row2">
          ${field('Document title', 'title', t.title)}
          <div class="fd-field"><label>Accent color</label>
            <div class="fd-color"><input type="color" data-tkey="accent" value="${escapeHtml(t.accent)}" /><span style="font-size:12px;color:var(--ink-soft,#777)">header band + UPI box</span></div>
          </div>
        </div>
        ${field('Tagline (under the organisation name)', 'tagline', t.tagline)}
        <div class="fd-row2">
          ${field('“Bill to” label', 'bill_to', t.labels.bill_to, { obj: 'labels' })}
          ${field('“Case details” label', 'case_details', t.labels.case_details, { obj: 'labels' })}
          ${field('Table: description', 'description', t.labels.description, { obj: 'labels' })}
          ${field('Table: amount', 'amount', t.labels.amount, { obj: 'labels' })}
          ${field('Subtotal label', 'subtotal', t.labels.subtotal, { obj: 'labels' })}
          ${field('Total label', 'total_due', t.labels.total_due, { obj: 'labels' })}
          ${field('UPI box heading', 'pay_via_upi', t.labels.pay_via_upi, { obj: 'labels' })}
          ${field('Discount label', 'discount', t.labels.discount, { obj: 'labels' })}
        </div>
        ${field('UPI help sentence', 'upi_help', t.upi_help, { textarea: true })}
        ${field('“Paid” note (shown once verified)', 'paid_note', t.paid_note)}
        ${field('Footer line', 'footer_note', t.footer_note)}`;
    } else {
      panel.innerHTML = `
        <h3>Discharge summary format</h3>
        <div class="fd-sub">Sections and rows are fully yours: rename, reorder, delete, or add rows using any placeholder below. Each row holds one or two fields.</div>
        <div class="fd-row2">
          ${field('Document title', 'title', t.title)}
          <div class="fd-field"><label>Accent color</label>
            <div class="fd-color"><input type="color" data-tkey="accent" value="${escapeHtml(t.accent)}" /><span style="font-size:12px;color:var(--ink-soft,#777)">band + section titles</span></div>
          </div>
        </div>
        ${field('Tagline', 'tagline', t.tagline)}
        <div class="fd-field"><label>Sections</label></div>
        <div id="fd-sections">
          ${t.sections.map((sec, si) => `
            <div class="fd-sec" data-si="${si}">
              <div class="fd-sec-head">
                <input type="text" data-sec-title="${si}" value="${escapeHtml(sec.title)}" />
                <button class="fd-mini" data-sec-up="${si}" title="Move up">↑</button>
                <button class="fd-mini" data-sec-down="${si}" title="Move down">↓</button>
                <button class="fd-mini" data-sec-del="${si}" title="Remove section">✕</button>
              </div>
              ${sec.rows.map((row, ri) => `
                <div class="fd-cellrow">
                  <div class="fd-cell">
                    <input type="text" placeholder="Label" data-cell="${si}.${ri}.0.label" value="${escapeHtml(row[0]?.label ?? '')}" />
                    <input type="text" placeholder="{{value}}" data-cell="${si}.${ri}.0.value" value="${escapeHtml(row[0]?.value ?? '')}" />
                  </div>
                  <div class="fd-cell">
                    <input type="text" placeholder="Label (optional 2nd column)" data-cell="${si}.${ri}.1.label" value="${escapeHtml(row[1]?.label ?? '')}" />
                    <input type="text" placeholder="{{value}}" data-cell="${si}.${ri}.1.value" value="${escapeHtml(row[1]?.value ?? '')}" />
                  </div>
                  <button class="fd-mini" data-row-del="${si}.${ri}" title="Remove row">✕</button>
                </div>`).join('')}
              <button class="fe-btn" data-row-add="${si}" style="margin-top:2px">＋ Row</button>
            </div>`).join('')}
        </div>
        <button class="fe-btn" id="fd-sec-add">＋ Section</button>
        <div style="height:10px"></div>
        ${field('Signature line', 'signature_label', t.signature_label)}
        ${field('Source note (bottom-left)', 'source_note', t.source_note)}
        ${field('Footer line', 'footer_note', t.footer_note)}`;
    }

    panel.insertAdjacentHTML('beforeend', `
      <div class="fd-field"><label>Placeholders: click to insert into the last field you touched</label>
        <div class="fd-ph">${PLACEHOLDERS.map(([p, d]) => `<button data-ph="${escapeHtml(p)}" title="${escapeHtml(d)}">${escapeHtml(p)}</button>`).join('')}</div>
      </div>
      <div class="fd-actions">
        <button class="fe-btn primary" id="fd-save">💾 Save. Future documents use this format</button>
        <button class="fe-btn" id="fd-reset">Reset to default</button>
        <span id="fd-save-note" style="font-size:12px;color:var(--ink-soft,#888);align-self:center"></span>
      </div>`);

    // Bindings
    panel.querySelectorAll('[data-tkey]').forEach((inp) => {
      // Color swatches must never become the placeholder-chip target: they
      // have no text selection, and inserting "{{…}}" into one turns it black.
      inp.addEventListener('focus', () => { if (inp.type !== 'color') lastFocusedInput = inp; });
      inp.addEventListener('input', () => {
        const t2 = state[state.kind];
        if (inp.dataset.tobj) t2[inp.dataset.tobj][inp.dataset.tkey] = inp.value;
        else t2[inp.dataset.tkey] = inp.value;
        markDirty();
      });
    });
    panel.querySelectorAll('[data-cell]').forEach((inp) => {
      inp.addEventListener('focus', () => { lastFocusedInput = inp; });
      inp.addEventListener('input', () => {
        const [si, ri, ci, k] = inp.dataset.cell.split('.');
        const row = state.discharge.sections[+si].rows[+ri];
        if (!row[+ci]) row[+ci] = { label: '', value: '' };
        row[+ci][k] = inp.value;
        // drop an empty 2nd cell so single-field rows stay full-width
        if (+ci === 1 && !row[1].label && !row[1].value) row.length = 1;
        markDirty();
      });
    });
    panel.querySelectorAll('[data-sec-title]').forEach((inp) => {
      inp.addEventListener('focus', () => { lastFocusedInput = inp; });
      inp.addEventListener('input', () => { state.discharge.sections[+inp.dataset.secTitle].title = inp.value; markDirty(); });
    });
    const redraw = () => { drawEditor(); markDirty(); };
    panel.querySelectorAll('[data-sec-del]').forEach((b) => b.addEventListener('click', () => { state.discharge.sections.splice(+b.dataset.secDel, 1); redraw(); }));
    panel.querySelectorAll('[data-sec-up]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.secUp; if (!i) return;
      const s = state.discharge.sections; [s[i - 1], s[i]] = [s[i], s[i - 1]]; redraw();
    }));
    panel.querySelectorAll('[data-sec-down]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.secDown; const s = state.discharge.sections;
      if (i >= s.length - 1) return; [s[i + 1], s[i]] = [s[i], s[i + 1]]; redraw();
    }));
    panel.querySelectorAll('[data-row-del]').forEach((b) => b.addEventListener('click', () => {
      const [si, ri] = b.dataset.rowDel.split('.').map(Number);
      state.discharge.sections[si].rows.splice(ri, 1); redraw();
    }));
    panel.querySelectorAll('[data-row-add]').forEach((b) => b.addEventListener('click', () => {
      state.discharge.sections[+b.dataset.rowAdd].rows.push([{ label: 'New field', value: '' }]); redraw();
    }));
    panel.querySelector('#fd-sec-add')?.addEventListener('click', () => {
      state.discharge.sections.push({ title: 'New section', rows: [[{ label: 'Field', value: '' }]] }); redraw();
    });
    panel.querySelectorAll('[data-ph]').forEach((b) => b.addEventListener('click', () => {
      if (!lastFocusedInput) return showToast('Click into a field first, then pick a placeholder', 'info');
      const inp = lastFocusedInput;
      const at = inp.selectionStart ?? inp.value.length;
      inp.value = inp.value.slice(0, at) + b.dataset.ph + inp.value.slice(inp.selectionEnd ?? at);
      inp.dispatchEvent(new Event('input'));
      inp.focus();
    }));
    panel.querySelector('#fd-save').addEventListener('click', async () => {
      const key = `doc_template_${state.kind}`;
      const { error: sErr } = await sb.from('settings').upsert(
        { key, value: state[state.kind], updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      );
      if (sErr) return showToast(sErr.message, 'error');
      state.dirty = false;
      container.querySelector('#fd-save-note').textContent = 'Saved. Every future document uses this format';
      showToast('Template saved ✔ The next generated PDF uses it.', 'success');
    });
    panel.querySelector('#fd-reset').addEventListener('click', () => {
      confirmModal('Reset this document to the original Carcinome format? Your customisations are discarded.', async () => {
        const key = `doc_template_${state.kind}`;
        await sb.from('settings').delete().eq('key', key);
        state[state.kind] = deep(state.kind === 'invoice' ? INVOICE_DEFAULT : DISCHARGE_DEFAULT);
        drawEditor();
        schedulePreview();
        showToast('Reset to default', 'success');
      }, { title: 'Reset template', confirmLabel: 'Reset', danger: true });
    });
  };

  container.innerHTML = `
    <div class="fl-head">
      <div>
        <h2 style="margin:0 0 4px">Documents</h2>
        <div style="font-size:12.5px;color:var(--ink-soft,#777)">Invoice and discharge formats. These are the REAL formats: save here and every invoice / discharge summary the system sends is generated in the new format, filled with each case's data.</div>
      </div>
    </div>
    <div class="sb-mode-row" style="display:flex;gap:8px;margin-bottom:14px">
      <button class="fl-tag ${state.kind === 'discharge' ? 'active' : ''}" data-kind="discharge">📄 Discharge summary</button>
      <button class="fl-tag ${state.kind === 'invoice' ? 'active' : ''}" data-kind="invoice">🧾 Invoice / bill</button>
    </div>
    <div class="fd-grid">
      <div class="fd-panel" id="fd-editor"></div>
      <div class="fd-preview">
        <div class="fd-panel" style="padding:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin:2px 4px 8px">
            <b style="font-size:13px">Live preview (sample data)</b>
            <button class="fe-btn" id="fd-refresh">↻ Refresh</button>
          </div>
          <div id="fd-preview-box"><div class="fd-loading">Rendering preview…</div></div>
        </div>
        <div class="fd-panel" style="margin-top:12px">
          <h3 style="font-size:13.5px">Consent form</h3>
          <div class="fd-sub" style="margin:4px 0 0">The consent form is not a PDF: it is a WhatsApp-native form hosted by Meta. Open <a href="#forms/consent"><b>WhatsApp forms → Consent</b></a> to preview its screens, see which form the system sends, and send a test. Its questions are authored in Meta WhatsApp Manager.</div>
        </div>
      </div>
    </div>`;

  container.querySelector('#fd-refresh').addEventListener('click', refreshPreview);
  container.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
    state.kind = b.dataset.kind;
    container.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('active', x.dataset.kind === state.kind));
    drawEditor();
    refreshPreview();
  }));

  drawEditor();
  refreshPreview();
}

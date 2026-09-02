// ============================================================
// Carcinome Home Care — Formatters
// All timestamps display in IST (Asia/Kolkata), regardless of
// the viewer's device timezone.
// ============================================================

const IST = 'Asia/Kolkata';

export function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: IST });
}

export function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: IST,
  });
}

export function formatTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return '—';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: IST });
}

export function formatRelativeTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return '—';
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return formatDate(dateStr);
}

export function maskPhone(phone) {
  if (!phone) return '—';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 4) return 'XXXX';
  return 'XXXXX-X' + digits.slice(-4);
}

// Display a canonical phone (919876543210) as +91 98765 43210.
export function formatPhone(phone) {
  if (!phone) return '—';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  return '+' + digits;
}

export function capitalize(str) {
  if (!str) return '';
  return String(str)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ---- INR: ₹ + Indian digit grouping (12,34,567.50) ----
export function formatINR(n) {
  if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '—';
  const num = Number(n);
  const hasPaise = Math.round(num * 100) % 100 !== 0;
  return '₹' + num.toLocaleString('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

// ---- Case lifecycle ----
export const CASE_STATUSES = [
  'registered', 'offering', 'assigned', 'consented', 'otp_sent',
  'in_care', 'care_done', 'awaiting_payment', 'paid', 'archived', 'cancelled',
];

const STATUS_LABELS = {
  registered: 'Registered',
  offering: 'Offering',
  assigned: 'Assigned',
  consented: 'Consented',
  otp_sent: 'OTP Sent',
  in_care: 'In Care',
  care_done: 'Care Done',
  awaiting_payment: 'Awaiting Payment',
  paid: 'Paid',
  archived: 'Archived',
  cancelled: 'Cancelled',
};

export function caseStatusLabel(status) {
  return STATUS_LABELS[status] || capitalize(status);
}

// → <span class="badge status-…">Label</span> (colors in components.css)
export function caseStatusBadge(status) {
  const known = STATUS_LABELS[status] ? status : 'registered';
  return `<span class="badge status-${known}">${caseStatusLabel(status)}</span>`;
}

// ---- Care/line type labels (match settings seeds in sql/04_seed.sql) ----
const CARE_TYPE_LABELS = {
  one_time_infusion: 'One-time infusion',
  chemo_infusion: 'Chemotherapy infusion',
  nursing_12h: '12-hour nursing',
  nursing_24h: '24-hour nursing',
};

const LINE_TYPE_LABELS = {
  chemo_port: 'Chemo Port',
  picc: 'PICC Line',
  peripheral: 'Peripheral Line',
  other: 'Other',
};

export function careTypeLabel(careType) {
  return CARE_TYPE_LABELS[careType] || capitalize(careType);
}

export function lineTypeLabel(lineType) {
  return LINE_TYPE_LABELS[lineType] || capitalize(lineType);
}

export const CARE_TYPES = Object.keys(CARE_TYPE_LABELS);
export const LINE_TYPES = Object.keys(LINE_TYPE_LABELS);

// ---- Invoice status badge (small convenience for pages) ----
export function invoiceStatusBadge(status) {
  const map = {
    draft: 'badge-neutral',
    sent: 'badge-info',
    paid_claimed: 'badge-warning',
    paid_verified: 'badge-success',
    void: 'badge-danger',
  };
  return `<span class="badge ${map[status] || 'badge-neutral'}">${capitalize(status)}</span>`;
}

// ---- Loading skeleton rows ----
export function renderSkeleton(rows = 5) {
  let html = '';
  for (let i = 0; i < rows; i++) {
    html += `<div class="skeleton skeleton-row"></div>`;
  }
  return html;
}

// ---- Escape untrusted text before injecting into innerHTML ----
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- CSV Export ----
export function exportToCSV(data, filename, columns) {
  if (!data || data.length === 0) return;

  const headers = columns.map(c => c.label);
  const rows = data.map(row =>
    columns.map(c => {
      let val = c.accessor ? c.accessor(row) : row[c.key] ?? '';
      // Escape CSV values
      val = String(val).replace(/"/g, '""');
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        val = `"${val}"`;
      }
      return val;
    }).join(',')
  );

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

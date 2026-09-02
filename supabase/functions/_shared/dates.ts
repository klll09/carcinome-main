// _shared/dates.ts — lenient date parsing for the doctor's "NEXT <date>" chemo input.
// Accepts: 24/7, 24/07/2026, 24-7, 24.7, "24 jul", "jul 24", "24 july 2026",
// "today", "tomorrow". Missing year → nearest future occurrence. Result is a
// timestamptz at 09:00 IST on that day.

const IST_OFFSET_MS = 5.5 * 3600_000;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export type ParsedChemoDate = { iso: string; display: string };

function istToday(now: Date): { y: number; m: number; d: number } {
  const t = new Date(now.getTime() + IST_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** UTC ms of 09:00 IST on (y, m, d). */
function nineAmIstUtcMs(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d, 9, 0, 0) - IST_OFFSET_MS;
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function formatChemoDate(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Build a chemo date from an LLM-interpreted YYYY-MM-DD (same guards as the
 * strict parser: valid calendar day, not past, within 370 days). */
export function chemoDateFromYmd(ymd: string, now = new Date()): ParsedChemoDate | null {
  const m = String(ymd ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (!isValidYmd(y, mo, d)) return null;
  const today = istToday(now);
  const ms = nineAmIstUtcMs(y, mo, d);
  const todayMs = nineAmIstUtcMs(today.y, today.m, today.d);
  if (ms < todayMs || ms > todayMs + 370 * 24 * 3600_000) return null;
  const iso = new Date(ms).toISOString();
  return { iso, display: formatChemoDate(iso) };
}

/**
 * Parse a doctor-typed date. Returns null when unparseable.
 * Throws never. Past dates and dates >370 days out return null too
 * (callers show one generic "could not read that date" reprompt).
 */
export function parseChemoDate(input: string, now = new Date()): ParsedChemoDate | null {
  const s = String(input ?? '')
    .toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/[,]+/g, ' ')
    .replace(/\bon\b/g, ' ')
    .trim();
  if (!s) return null;

  const today = istToday(now);
  let y: number | null = null;
  let m: number | null = null;
  let d: number | null = null;

  if (s === 'today' || s === 'aaj') {
    ({ y, m, d } = today);
  } else if (s === 'tomorrow' || s === 'tmrw' || s === 'kal') {
    const t = new Date(nineAmIstUtcMs(today.y, today.m, today.d) + 24 * 3600_000 + IST_OFFSET_MS);
    y = t.getUTCFullYear(); m = t.getUTCMonth() + 1; d = t.getUTCDate();
  } else {
    // Numeric: dd/mm[/yyyy] with / - or . separators (Indian day-first).
    let mm = s.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
    if (mm) {
      d = parseInt(mm[1], 10);
      m = parseInt(mm[2], 10);
      y = mm[3] ? parseInt(mm[3], 10) : null;
      if (y != null && y < 100) y += 2000;
    } else {
      // "24 jul [2026]" or "jul 24 [2026]" — month word required.
      mm = s.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/);
      let mw: string | null = null;
      if (mm) {
        d = parseInt(mm[1], 10);
        mw = mm[2];
        y = mm[3] ? parseInt(mm[3], 10) : null;
      } else {
        mm = s.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
        if (!mm) return null;
        mw = mm[1];
        d = parseInt(mm[2], 10);
        y = mm[3] ? parseInt(mm[3], 10) : null;
      }
      m = MONTHS[mw.slice(0, 3)] ?? null;
      if (m == null) return null;
    }
  }

  if (m == null || d == null) return null;

  // Missing year → nearest future occurrence (today counts as valid). A day
  // invalid THIS year (29 Feb in a non-leap year) rolls forward too.
  if (y == null) {
    y = today.y;
    const validThisYear = isValidYmd(y, m, d);
    if (!validThisYear || nineAmIstUtcMs(y, m, d) < nineAmIstUtcMs(today.y, today.m, today.d)) {
      y += 1;
    }
  }
  if (!isValidYmd(y, m, d)) return null;

  const ms = nineAmIstUtcMs(y, m, d);
  const todayMs = nineAmIstUtcMs(today.y, today.m, today.d);
  if (ms < todayMs) return null; // in the past
  if (ms > todayMs + 370 * 24 * 3600_000) return null; // implausibly far out

  const iso = new Date(ms).toISOString();
  return { iso, display: formatChemoDate(iso) };
}

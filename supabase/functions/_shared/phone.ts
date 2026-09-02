// _shared/phone.ts — phone canonicalization (CONTRACTS §Phone canonicalization)
// Canonical form = digits-only with country code, e.g. "919876543210" — equals WhatsApp wa_id.

export function normPhone(s: string | null | undefined): string {
  if (!s) return '';
  let d = String(s).replace(/\D+/g, '');
  if (d.length === 10) d = '91' + d;
  else if (d.length === 11 && d.startsWith('0')) d = '91' + d.slice(1);
  return d;
}

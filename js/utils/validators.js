// ============================================================
// Carcinome Home Care — Validators
// ============================================================

export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain a number';
  return null;
}

export function validateRequired(value, fieldName) {
  if (!value || (typeof value === 'string' && !value.trim())) {
    return `${fieldName} is required`;
  }
  return null;
}

export function validatePinCode(pin) {
  if (!pin) return null; // optional
  if (!/^\d{6}$/.test(pin)) return 'PIN code must be exactly 6 digits';
  return null;
}

// ---- Indian phone → canonical WhatsApp wa_id form ----
// Implements CONTRACTS normPhone in JS:
//   strip all non-digits; 10 digits → prefix '91';
//   11 digits starting with '0' → drop the 0, prefix '91'.
// Canonical = digits-only with country code, e.g. '919876543210'.
// Additionally validates that the mobile part starts 6–9 (Indian mobile
// numbering plan) so typos like landlines/short codes are caught at entry.
export function validateIndianPhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return { ok: false, normalized: null, error: 'Phone number is required' };

  let mobile = null;
  if (digits.length === 10) {
    mobile = digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    mobile = digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    mobile = digits.slice(2);
  } else {
    return { ok: false, normalized: null, error: 'Enter a 10-digit Indian mobile number' };
  }

  if (!/^[6-9]\d{9}$/.test(mobile)) {
    return { ok: false, normalized: null, error: 'Indian mobile numbers start with 6, 7, 8 or 9' };
  }

  return { ok: true, normalized: '91' + mobile, error: null };
}

// Sanitize input to prevent XSS when echoing user text into innerHTML.
export function sanitize(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// Carcinome Home Care — Modal Component
// One active modal at a time. confirmModal takes a DIRECT
// onConfirm callback (no global events — they stack and misfire).
// ============================================================

let activeModal = null;
let escHandler = null;

export function showModal({ title, content, size = '', footer = '', onClose = null }) {
  closeModal(); // close any existing modal first

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal ${size ? 'modal-' + size : ''}" role="dialog" aria-modal="true" aria-label="${String(title).replace(/"/g, '&quot;')}">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="btn btn-ghost btn-icon btn-sm modal-close-btn" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">${typeof content === 'string' ? content : ''}</div>
      ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
    </div>
  `;

  if (typeof content !== 'string' && content instanceof HTMLElement) {
    overlay.querySelector('.modal-body').innerHTML = '';
    overlay.querySelector('.modal-body').appendChild(content);
  }

  document.body.appendChild(overlay);
  activeModal = overlay;

  requestAnimationFrame(() => overlay.classList.add('active'));

  overlay.querySelector('.modal-close-btn').addEventListener('click', () => closeModal(onClose));
  // Intentionally NO backdrop-click-to-close: accidental outside clicks wipe
  // half-filled forms. Close via the ✕, a Cancel button, or Esc.

  // Single Escape handler, always removed on close.
  escHandler = (e) => { if (e.key === 'Escape') closeModal(onClose); };
  document.addEventListener('keydown', escHandler);

  return overlay;
}

export function closeModal(onClose = null) {
  if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
  if (!activeModal) return;
  activeModal.classList.remove('active');
  const m = activeModal;
  activeModal = null;
  setTimeout(() => m.remove(), 250);
  if (typeof onClose === 'function') onClose();
}

// Confirmation dialog with a direct callback.
export function confirmModal(message, onConfirm, { title = 'Confirm action', confirmLabel = 'Confirm', danger = true } = {}) {
  const overlay = showModal({
    title,
    content: `<p style="margin:0">${message}</p>`,
    footer: `
      <button class="btn btn-secondary" data-modal-cancel>Cancel</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-modal-confirm>${confirmLabel}</button>
    `,
  });
  overlay.querySelector('[data-modal-cancel]').addEventListener('click', () => closeModal());
  overlay.querySelector('[data-modal-confirm]').addEventListener('click', async () => {
    closeModal();
    if (typeof onConfirm === 'function') await onConfirm();
  });
  return overlay;
}

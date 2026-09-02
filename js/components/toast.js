// ============================================================
// Carcinome Home Care — Toast Notifications
// ============================================================

let container = null;

function getContainer() {
  if (!container || !container.isConnected) {
    container = document.createElement('div');
    container.className = 'toast-container';
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

const ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

const TITLES = { success: 'Success', error: 'Error', warning: 'Warning', info: 'Info' };

export function showToast(message, type = 'info', duration = 4000) {
  const c = getContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${ICONS[type] || ICONS.info}</div>
    <div class="toast-content">
      <div class="toast-title">${TITLES[type] || 'Info'}</div>
      <div class="toast-message"></div>
    </div>
    <button class="toast-close" aria-label="Close">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  // Message goes in as text — error strings often echo user/server input.
  toast.querySelector('.toast-message').textContent = String(message ?? '');

  toast.querySelector('.toast-close').addEventListener('click', () => removeToast(toast));
  c.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => removeToast(toast), duration);
  }

  return toast;
}

function removeToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.classList.add('removing');
  setTimeout(() => toast.remove(), 200);
}

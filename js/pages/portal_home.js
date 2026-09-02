// ============================================================
// Carcinome Home Care — #portal/home
// One hash for all three roles: the signed-in person's role decides which
// dashboard loads. Keeping a single route means a magic link never has to
// know which dashboard it is for, and a role change on the server takes
// effect on the next sign-in without any stale bookmark pointing at the
// wrong page.
// ============================================================

import { getPortalSession } from '../portal/api.js';
import { renderPortalShell, portalNotice } from '../portal/shell.js';
import { navigate } from '../router.js';
import { icon } from '../components/icons.js';
import { CONFIG } from '../config.js';

// Roles whose dashboard has shipped → the module that draws it.
const ROLE_PAGES = { nurse: 'portal_nurse', patient: 'portal_patient', doctor: 'portal_doctor' };

/** The entry into the case group chats. Every role gets one. */
export function chatCard(role) {
  const line = {
    patient: 'Message your nurse, your doctor and the Carcinome team together, on each of your cases.',
    nurse: 'One conversation per patient you are looking after.',
    doctor: 'One conversation per patient you referred.',
  }[role] ?? 'Your case conversations.';
  return `
    <button class="pt-chat-cta" type="button" id="pt-open-chat">
      <span class="pt-chat-cta-icon">${icon('message')}</span>
      <span class="pt-chat-cta-text">
        <span class="pt-chat-cta-title">Case chats</span>
        <span class="pt-chat-cta-sub">${line}</span>
      </span>
      <span class="pt-chat-cta-go">${icon('chevronRight')}</span>
    </button>`;
}

/** Wire the card above. Safe to call when the card is not on the page. */
export function bindChatCard() {
  document.getElementById('pt-open-chat')?.addEventListener('click', () => navigate('portal/chat'));
}

export default async function render() {
  const session = getPortalSession();
  if (!session) { navigate('welcome'); return; }

  const role = session.profile?.role;
  const moduleName = ROLE_PAGES[role];

  if (!moduleName) {
    // Patient and doctor dashboards are the next two deliveries. The chat is
    // live for them today, so lead with it rather than showing an empty shell —
    // these people are signed in correctly and nothing is broken.
    const content = renderPortalShell(session.profile, {
      title: `Hello, ${session.profile?.full_name || 'there'}`,
    });
    content.innerHTML = chatCard(role) + portalNotice(
      'info',
      'Your full dashboard is being built',
      'Everything for your care continues on WhatsApp exactly as before — nothing has changed there. The web dashboard is being rolled out one role at a time.',
    );
    bindChatCard();
    return;
  }

  const mod = await import(`./${moduleName}.js?v=${CONFIG.VERSION}`);
  await mod.default(session);
}

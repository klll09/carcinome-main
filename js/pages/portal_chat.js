// ============================================================
// Carcinome Home Care — #portal/chat
// The case group chats for a signed-in patient, nurse or doctor.
// The chat view is shared with the admin page; the only thing that differs
// is which rooms the server returns for this person's credential.
// ============================================================

import { getPortalSession } from '../portal/api.js';
import { mountChatView } from '../portal/chatview.js';
import { renderPortalShell } from '../portal/shell.js';
import { navigate } from '../router.js';
import { icon } from '../components/icons.js';

const SUBTITLE = {
  patient: 'Your care team — your nurse, your doctor and Carcinome ops, on each of your cases.',
  nurse: 'One conversation per patient you are looking after.',
  doctor: 'One conversation per patient you referred.',
};

let cleanup = null;

export default async function render() {
  const session = getPortalSession();
  if (!session) { navigate('welcome'); return; }

  // Leaving this page without tearing the socket listeners down would leave
  // them writing into a DOM that no longer exists.
  if (cleanup) { cleanup(); cleanup = null; }

  const role = session.profile?.role;
  const content = renderPortalShell(session.profile, {
    title: 'Case chats',
    subtitle: SUBTITLE[role] ?? '',
  });

  document.querySelector('.pt-main')?.classList.add('pt-main-wide');

  content.innerHTML = `
    <button class="pt-back" type="button" id="pc-back">${icon('arrowLeft')}<span>Back to my dashboard</span></button>
    <div id="pc-chat"></div>`;
  document.getElementById('pc-back')?.addEventListener('click', () => navigate('portal/home'));

  cleanup = await mountChatView(document.getElementById('pc-chat'), { title: 'Conversations' });

  // The portal shell is replaced wholesale on the next navigation, so hook the
  // hash change once to release the listeners.
  window.addEventListener('hashchange', function once() {
    window.removeEventListener('hashchange', once);
    if (cleanup) { cleanup(); cleanup = null; }
  });
}

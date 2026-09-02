// ============================================================
// Carcinome Home Care — #chat (admin)
// Every case conversation, read AND write. Same chat view the portals use;
// the admin's Supabase token buys a wider room list from the server, nothing
// else about the component changes.
//
// An admin message enters the room as the care team (🛟), which is how the
// WhatsApp relay already labels ops — so the patient sees one consistent voice
// whether the team answered from the dashboard or from the phone.
// ============================================================

import { mountChatView } from '../portal/chatview.js';
import { icon } from '../components/icons.js';

let cleanup = null;

export default async function render(container) {
  if (cleanup) { cleanup(); cleanup = null; }

  container.innerHTML = `
    <div class="ch-admin-intro">
      ${icon('message')}
      <div>
        <strong>Every case conversation.</strong>
        You can read and reply in all of them. Your replies appear to the patient, nurse and
        doctor as the Carcinome care team — the same voice the WhatsApp relay uses.
      </div>
    </div>
    <div id="ch-admin-mount"></div>`;

  cleanup = await mountChatView(document.getElementById('ch-admin-mount'), { title: 'All conversations' });

  window.addEventListener('hashchange', function once() {
    window.removeEventListener('hashchange', once);
    if (cleanup) { cleanup(); cleanup = null; }
  });
}

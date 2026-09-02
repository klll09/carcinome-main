// ============================================================
// Carcinome Home Care - Configuration
// Publishable key only - safe to commit (RLS is admin-only).
// ============================================================

export const CONFIG = {
  SUPABASE_URL: 'https://ampwszlbxbmpozjigvhk.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFtcHdzemxieGJtcG96amlndmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3NTAyOTksImV4cCI6MjEwMzMyNjI5OX0.T8wPryVM1k5jG15-mo15Eg4cHBl2sC58I-Okp7jefg4',
  FUNCTIONS_URL: 'https://ampwszlbxbmpozjigvhk.supabase.co/functions/v1',
  APP_NAME: 'Carcinome Home Care',
  VERSION: '20260820e',
  DEFAULT_PAGE_SIZE: 25,

  // Socket.IO group-chat server (server/). GitHub Pages cannot host a
  // WebSocket process, so this is its own deployment — point it at the
  // deployed host in production.
  CHAT_URL: 'http://localhost:3001',

  // ── DEMO SWITCH ─────────────────────────────────────────────────────────
  // true  → landing page offers one-tap sample logins, always shows the staff
  //         door, and routes portal calls at CHAT_URL/portal (the demo shim in
  //         server/index.mjs) so the whole flow works with NOTHING deployed.
  // false → production: real WhatsApp magic links against the portal edge
  //         function, and the staff door is fail-closed behind
  //         settings.portal.show_admin_login.
  // ⚠️ MUST be false in production. Sample logins are unauthenticated by
  //    design; the server side is independently gated on
  //    settings.portal.sample_login so flipping this alone cannot open a
  //    real deployment.
  SAMPLE_LOGIN: false,
};

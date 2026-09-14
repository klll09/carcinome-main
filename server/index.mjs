// ============================================================
// Carcinome Home Care — Socket.IO group-chat server
//
// One room per CASE. The patient, their allotted nurse and the referring
// doctor share it; admins can read and write every room. Who sees what is
// decided in store.mjs and re-checked on every join and every send — a client
// never gets a room by naming it.
//
// ═══ WHY THIS IS A SEPARATE PROCESS ═══
// The dashboard and portals are static files on GitHub Pages, which cannot run
// a WebSocket server. Socket.IO needs a long-lived Node process, so this ships
// as its own deployable (Railway / Render / Fly / any Node host) and the SPA
// points at it through CONFIG.CHAT_URL.
//
//   Real:  SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set → messages persist to
//          the `messages` ledger, so the admin Message log shows web chat next
//          to WhatsApp traffic.
//   Demo:  CHAT_STORE=demo → in-memory sample data, no credentials, nothing
//          touches a real phone. This is what the sample logins run against.
//
// Run:  npm start      (real)
//       npm run demo   (sample data, no Supabase needed)
// ============================================================

import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { demoStore, supabaseStore } from './store.mjs';

const PORT = Number(process.env.PORT ?? 3001);
const ORIGINS = (process.env.CHAT_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_LEN = 2000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 20;

// ─── Pick a store ────────────────────────────────────────────────────────────
function resolveServiceKey() {
  const secretKeysRaw = process.env.SUPABASE_SECRET_KEYS;
  if (secretKeysRaw) {
    try {
      const parsed = JSON.parse(secretKeysRaw);
      const key = parsed.default ?? Object.values(parsed)[0];
      if (key) return key;
    } catch (e) { console.error('resolveServiceKey: failed to parse SUPABASE_SECRET_KEYS:', e.message); }
  }
  return process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}
const serviceKey = resolveServiceKey();
const wantDemo = process.env.CHAT_STORE === 'demo' || !(process.env.SUPABASE_URL && serviceKey);

const store = wantDemo ? demoStore() : supabaseStore({ url: process.env.SUPABASE_URL, serviceKey });

if (wantDemo && process.env.CHAT_STORE !== 'demo') {
  console.warn('⚠️  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — falling back to the DEMO store.');
  console.warn('   Sample data only. Nothing is persisted and no real phone is involved.');
}
console.log(`▸ store: ${wantDemo ? 'demo (in-memory)' : 'supabase'}`);

// ════════════════════════════════════════════════════════════════════════════
// HTTP: health + (demo only) a stand-in for the portal edge function
// ════════════════════════════════════════════════════════════════════════════

function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes('*') ? '*' : (origin ?? ORIGINS[0] ?? '*'));
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const httpServer = createServer(async (req, res) => {
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end('ok'); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    return sendJson(res, { ok: true, store: wantDemo ? 'demo' : 'supabase' });
  }

  // Demo-only shim so the SPA's sample logins work with NOTHING deployed —
  // same action protocol as supabase/functions/portal. In production the SPA
  // talks to the real edge function and never reaches this handler.
  if (url.pathname === '/portal' && req.method === 'POST') {
    if (!wantDemo) return sendJson(res, { ok: false, error: 'portal_shim_disabled' }, 404);
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, { ok: false, error: 'invalid_json' }, 400); }

    const action = String(parsed.action ?? '');
    if (action === 'config') {
      return sendJson(res, { ok: true, enabled: true, show_admin_login: true, sample_login: true, wa_number: '' });
    }
    if (action === 'sample_login') {
      const role = String(parsed.role ?? '');
      const token = store._sampleToken?.(role);
      if (!token) return sendJson(res, { ok: false, error: 'invalid_role' }, 400);
      const profile = await store._profile(token);
      return sendJson(res, {
        ok: true,
        session: token,
        expires_at: new Date(Date.now() + 86400_000).toISOString(),
        profile: { role: profile.role, id: profile.personId, full_name: profile.name, language_pref: 'en' },
      });
    }
    if (action === 'request_link') {
      // Same generic answer the real endpoint gives — but say plainly that a
      // demo cannot send WhatsApp, so nobody waits for a message forever.
      return sendJson(res, { ok: true, demo: true });
    }
    if (action === 'me') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
      const p = await store.authenticatePortal(token);
      if (!p) return sendJson(res, { ok: false, error: 'not_signed_in' }, 401);
      return sendJson(res, { ok: true, profile: { role: p.role, id: p.personId, full_name: p.name, language_pref: 'en' } });
    }
    if (action === 'nurse_home') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
      const p = await store.authenticatePortal(token);
      if (!p) return sendJson(res, { ok: false, error: 'not_signed_in' }, 401);
      if (p.role !== 'nurse') return sendJson(res, { ok: false, error: 'wrong_role' }, 403);
      return sendJson(res, store._nurseHome(p));
    }
    if (action === 'logout') return sendJson(res, { ok: true });
    return sendJson(res, { ok: false, error: `unknown_action: ${action}` }, 400);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// ════════════════════════════════════════════════════════════════════════════
// Socket.IO
// ════════════════════════════════════════════════════════════════════════════

const io = new Server(httpServer, {
  cors: { origin: ORIGINS.includes('*') ? true : ORIGINS, credentials: false },
  path: '/socket.io',
});

/**
 * Identity is resolved ONCE here, from a credential the client cannot forge,
 * and pinned to the socket. Everything downstream reads socket.data.identity —
 * no handler ever takes the caller's word for who they are.
 */
io.use(async (socket, next) => {
  try {
    const { token, kind } = socket.handshake.auth ?? {};
    if (!token) return next(new Error('no_credentials'));
    const identity = kind === 'admin'
      ? await store.authenticateAdmin(token)
      : await store.authenticatePortal(token);
    if (!identity) return next(new Error('not_authorised'));
    socket.data.identity = identity;
    socket.data.sent = [];
    next();
  } catch (e) {
    console.error('handshake failed:', e);
    next(new Error('auth_error'));
  }
});

io.on('connection', (socket) => {
  const me = socket.data.identity;
  console.log(`+ ${me.kind}:${me.role} ${me.name} connected (${socket.id})`);

  socket.emit('ready', { role: me.role, kind: me.kind, name: me.name });

  socket.on('rooms:list', async (_p, ack) => {
    try {
      ack?.({ ok: true, rooms: await store.listRooms(me) });
    } catch (e) {
      console.error('rooms:list failed:', e);
      ack?.({ ok: false, error: 'rooms_failed' });
    }
  });

  socket.on('room:join', async ({ caseId } = {}, ack) => {
    try {
      // Re-checked against the pinned identity, every time.
      if (!(await store.canAccess(me, caseId))) return ack?.({ ok: false, error: 'forbidden' });
      // One room at a time: leaving the others keeps a client from quietly
      // accumulating subscriptions it is no longer looking at.
      for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);
      socket.join(caseId);
      ack?.({ ok: true, messages: await store.history(caseId) });
    } catch (e) {
      console.error('room:join failed:', e);
      ack?.({ ok: false, error: 'join_failed' });
    }
  });

  socket.on('message:send', async ({ caseId, text } = {}, ack) => {
    try {
      const body = String(text ?? '').trim().slice(0, MAX_LEN);
      if (!body) return ack?.({ ok: false, error: 'empty' });

      const now = Date.now();
      socket.data.sent = socket.data.sent.filter((t) => now - t < RATE_WINDOW_MS);
      if (socket.data.sent.length >= RATE_MAX) return ack?.({ ok: false, error: 'rate_limited' });
      socket.data.sent.push(now);

      if (!(await store.canAccess(me, caseId))) return ack?.({ ok: false, error: 'forbidden' });

      const message = await store.append(caseId, me, body);
      io.to(caseId).emit('message:new', message);   // includes the sender
      ack?.({ ok: true, message });
    } catch (e) {
      console.error('message:send failed:', e);
      ack?.({ ok: false, error: 'send_failed' });
    }
  });

  socket.on('typing', ({ caseId, on } = {}) => {
    if (!caseId || !socket.rooms.has(caseId)) return;
    socket.to(caseId).emit('typing', { name: me.name, role: me.role, on: !!on });
  });

  socket.on('disconnect', (reason) => {
    console.log(`- ${me.name} disconnected (${reason})`);
  });
});

// ─── Live push for automated events ─────────────────────────────────────────
//
// history() already returns case_events merged with messages, so a fresh
// room:join always shows the full picture — that part works with nothing
// below this line. This block is purely so an event that fires WHILE someone
// already has the chat open (e.g. admin assigns a nurse mid-conversation)
// appears immediately, instead of needing a refresh to see it.
//
// Demo mode has no real Postgres to listen to, so this is a no-op there —
// demo case_events never change after boot anyway.

// Kept in sync with the same map in store.mjs by hand — small and unlikely to
// drift, and importing across the two would tangle the demo/real split for
// no real benefit.
const EVENT_PHRASE = {
  registered: 'Case registered',
  offers_sent: 'Nurse offers sent',
  offer_yes: 'A nurse accepted the offer',
  nurse_assigned: 'Nurse assigned',
  nurse_reassigned: 'Nurse reassigned',
  consent_sent: 'Consent form sent to the family',
  consented: 'Consent signed',
  otp_issued: 'Arrival code sent to the family',
  otp_verified: 'Nurse arrival verified — session started',
  care_completed: 'Completion report received',
  invoice_sent: 'Invoice sent',
  discharge_sent: 'Discharge summary sent',
  payment_claimed: 'Family says they have paid',
  payment_verified: 'Payment verified',
  feedback_received: 'Feedback received',
  next_chemo_set: 'Next chemo date set',
};

if (store.db) {
  store.db
    .channel('chat-server-case-events')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'case_events' },
      (payload) => {
        const row = payload.new;
        if (!row?.case_id) return;
        io.to(row.case_id).emit('message:new', {
          id: `evt_${row.id}`,
          case_id: row.case_id,
          kind: 'event',
          event_type: row.event_type,
          label: EVENT_PHRASE[row.event_type] ?? String(row.event_type ?? '').replaceAll('_', ' '),
          actor: row.actor && row.actor !== 'system' ? row.actor : null,
          created_at: row.created_at,
        });
      },
    )
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') {
        console.warn('⚠️  case_events realtime subscription failed — automated events will still show on refresh, just not live.');
        console.warn('   Make sure case_events is added to the supabase_realtime publication:');
        console.warn('   ALTER PUBLICATION supabase_realtime ADD TABLE case_events;');
      } else if (status === 'SUBSCRIBED') {
        console.log('▸ listening for live case_events (automated messages will push instantly)');
      }
    });
}

httpServer.listen(PORT, () => {
  console.log(`▸ Carcinome chat listening on http://localhost:${PORT}`);
  console.log(`▸ origins: ${ORIGINS.join(', ')}`);
});
// _shared/relay.ts — the relay hub. One WhatsApp number, many participants per case:
// inbound from any participant fans out to every other active participant of the case.
import { db } from './db.ts';
import { langFor } from './lang.ts';
import { logEvent } from './log.ts';
import { normPhone } from './phone.ts';
import { paramSafe, sendMedia, sendSmart, sendTemplate, type SendOpts } from './wa.ts';

export const ROLE_EMOJI: Record<string, string> = {
  patient: '🧑',
  nurse: '🩺',
  doctor: '🥼',
  ops: '🛟',
  supplier: '📦',
};

/**
 * One phone can hold SEVERAL roles on a case (two-phone rehearsals double
 * nurse+doctor and patient+nurse on one number). When we must attribute a
 * message or pick ONE role for a phone, this is the preference order: the
 * person receiving care speaks most, the assigned nurse next.
 */
export const ROLE_PRIORITY = ['patient', 'nurse', 'doctor', 'supplier', 'ops'];

function roleRank(role: string): number {
  const i = ROLE_PRIORITY.indexOf(role);
  return i === -1 ? 99 : i;
}

export function pickPreferredRole<T extends { role: string }>(rows: T[]): T | null {
  if (!rows.length) return null;
  return [...rows].sort((a, b) => roleRank(a.role) - roleRank(b.role))[0];
}

/** Case statuses whose participants are considered "live" for relaying. */
export const LIVE_STATUSES = [
  'registered', 'offering', 'assigned', 'consented', 'otp_sent',
  'in_care', 'care_done', 'awaiting_payment',
];

export type Participation = {
  id: string;
  case_id: string;
  role: string;
  phone: string;
  display_name: string;
  relay: 'full' | 'milestones' | 'muted';
  cases: {
    id: string;
    status: string;
    case_code: string;
    care_type: string;
    scheduled_at: string;
    patients: { full_name: string } | null;
  };
};

/** Active participant rows for a phone whose case is in a live status. */
export async function findLiveParticipations(phone: string): Promise<Participation[]> {
  try {
    const { data, error } = await db
      .from('case_participants')
      .select(
        'id, case_id, role, phone, display_name, relay, ' +
        'cases!inner(id, status, case_code, care_type, scheduled_at, patients:patient_id(full_name))',
      )
      .eq('phone', normPhone(phone))
      .eq('active', true)
      .in('cases.status', LIVE_STATUSES)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('findLiveParticipations failed:', error.message);
      return [];
    }
    return (data ?? []) as unknown as Participation[];
  } catch (e) {
    console.error('findLiveParticipations exception:', e);
    return [];
  }
}

/** Phones (from the given set) whose owner opted out, across all people tables. */
async function optedOutPhones(phones: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (phones.length === 0) return out;
  try {
    const [pa, pb, nu, dr, su] = await Promise.all([
      db.from('patients').select('wa_number').eq('opted_out', true).in('wa_number', phones),
      db.from('patients').select('phone').eq('opted_out', true).in('phone', phones),
      db.from('nurses').select('phone').eq('opted_out', true).in('phone', phones),
      db.from('doctors').select('phone').eq('opted_out', true).in('phone', phones),
      db.from('suppliers').select('phone').eq('opted_out', true).in('phone', phones),
    ]);
    for (const r of pa.data ?? []) out.add(r.wa_number);
    for (const r of pb.data ?? []) out.add(r.phone);
    for (const r of nu.data ?? []) out.add(r.phone);
    for (const r of dr.data ?? []) out.add(r.phone);
    for (const r of su.data ?? []) out.add(r.phone);
  } catch (e) {
    console.error('optedOutPhones exception:', e);
  }
  return out;
}

export type FanOutContent = {
  text?: string;
  mediaId?: string;
  mediaType?: string; // MIME
  filename?: string;
  caption?: string;
};

/**
 * Fan a participant's message out to every other active participant of the case.
 * - muted → skipped; milestones → skipped for free-form relay
 * - opted-out phones skipped
 * - window-aware per recipient: open → free-form "🩺 Label: text" / media copy;
 *   closed → care_update template [label, snippet] in the recipient's language (+ relay_fallback event)
 * - sender's own first inbound flips their relay milestones → full (doctors joining the thread)
 */
export async function fanOut(
  caseId: string,
  senderPhone: string,
  senderLabel: string,
  content: FanOutContent,
  relayOfMsgId?: number | null,
): Promise<void> {
  const sender = normPhone(senderPhone);
  try {
    const { data: participants, error } = await db
      .from('case_participants')
      .select('id, case_id, role, phone, display_name, relay')
      .eq('case_id', caseId)
      .eq('active', true);
    if (error) {
      console.error('fanOut participants query failed:', error.message);
      return;
    }
    const all = participants ?? [];
    // A phone can hold several roles — attribute the message to the preferred one.
    const senderRows = all.filter((p) => p.phone === sender);
    const senderRow = pickPreferredRole(senderRows);

    // First inbound from a milestones-mode participant flips THAT row to full.
    // Only the attributed row: on a doubled nurse+doctor phone, nurse chatter
    // must not silently pull the doctor's milestones row into the full relay.
    // POC rows never auto-join: a casual "ok, thanks" from the intern must not
    // turn their log feed into the raw chat dump (they can still type JOIN).
    if (senderRow && senderRow.relay === 'milestones' && senderRow.role !== 'poc') {
      await db.from('case_participants').update({ relay: 'full' }).eq('id', senderRow.id);
      await logEvent(caseId, 'relay_joined', `${senderRow.role}:${sender}`, { via: 'first_inbound' });
    }

    const emoji = ROLE_EMOJI[senderRow?.role ?? ''] ?? '💬';

    // Group by phone and send AT MOST ONCE per phone: a doubled phone with a
    // full row receives one copy (labelled by its preferred eligible role);
    // the sender's phone never gets an echo regardless of its other roles.
    const byPhone = new Map<string, typeof all>();
    for (const p of all) {
      if (p.phone === sender) continue;
      if (p.relay === 'muted' || p.relay === 'milestones') continue;
      const list = byPhone.get(p.phone) ?? [];
      list.push(p);
      byPhone.set(p.phone, list);
    }
    if (byPhone.size === 0) return;

    const optedOut = await optedOutPhones([...byPhone.keys()]);

    for (const [phone, rows] of byPhone) {
      if (optedOut.has(phone)) continue;
      const p = pickPreferredRole(rows)!;
      const opts: SendOpts = { caseId, role: p.role, relayOf: relayOfMsgId ?? undefined };
      try {
        const lang = await langFor(p.phone);
        if (content.text != null) {
          const line = `${emoji} ${senderLabel}: ${content.text}`;
          const r = await sendSmart(
            p.phone,
            line,
            { name: 'care_update', lang, params: [senderLabel, paramSafe(content.text, 160)] },
            opts,
          );
          if (r.via === 'template') {
            await logEvent(caseId, 'relay_fallback', 'system', { to: p.phone, role: p.role, ok: r.ok });
          }
        } else if (content.mediaId) {
          const fileBit = content.filename ? `: ${content.filename}` : '';
          const sentAFile = lang === 'hi' ? `ने एक फ़ाइल भेजी है${fileBit}` : `sent a file${fileBit}`;
          const caption =
            `${emoji} ${senderLabel} ${sentAFile}` +
            (content.caption ? ` — ${paramSafe(content.caption, 200)}` : '');
          const { data: open } = await db.rpc('open_window', { p_phone: p.phone });
          if (open === true) {
            await sendMedia(
              p.phone,
              { mediaId: content.mediaId, mime: content.mediaType ?? 'application/octet-stream', filename: content.filename, caption },
              opts,
            );
          } else {
            const snippet = paramSafe(sentAFile, 160);
            const r = await sendTemplate(p.phone, 'care_update', lang, [senderLabel, snippet], opts);
            await logEvent(caseId, 'relay_fallback', 'system', { to: p.phone, role: p.role, media: true, ok: r.ok });
          }
        }
      } catch (e) {
        console.error(`fanOut → ${p.phone} failed:`, e);
      }
    }
  } catch (e) {
    console.error('fanOut exception:', e);
  }
}

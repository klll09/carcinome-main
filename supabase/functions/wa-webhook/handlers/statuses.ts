// wa-webhook/handlers/statuses.ts — delivery status callbacks.
// Idempotent, never-downgrade: read > delivered > sent > accepted; failed always lands.
import { db } from '../../_shared/db.ts';

const RANK: Record<string, number> = {
  pending: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
};

// deno-lint-ignore no-explicit-any
export async function handleStatuses(statuses: any[]): Promise<void> {
  for (const s of statuses ?? []) {
    try {
      const wamid: string | undefined = s?.id;
      const st: string | undefined = s?.status;
      if (!wamid || !st || !(st in RANK)) continue;

      const lower = Object.keys(RANK).filter((k) => RANK[k] < RANK[st]);
      if (lower.length === 0) continue;

      const patch: Record<string, unknown> = {
        status: st,
        status_at: s?.timestamp
          ? new Date(Number(s.timestamp) * 1000).toISOString()
          : new Date().toISOString(),
      };
      if (s?.pricing) {
        if (s.pricing.category != null) patch.pricing_category = String(s.pricing.category);
        patch.billable = s.pricing.billable === true;
      }
      if (s?.errors) patch.error = s.errors;

      const { error } = await db.from('messages').update(patch).eq('wamid', wamid).in('status', lower);
      if (error) console.error(`status update failed (${wamid} → ${st}):`, error.message);
    } catch (e) {
      console.error('handleStatuses item exception:', e);
    }
  }
}

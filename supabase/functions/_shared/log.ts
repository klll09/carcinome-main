// _shared/log.ts — case timeline events. Duplicate-key errors are swallowed on purpose:
// the partial unique index on case_events is a dedupe feature (reminders, invoice_sent, ...).
import { db } from './db.ts';

export async function logEvent(
  caseId: string,
  eventType: string,
  actor = 'system',
  data: Record<string, unknown> = {},
): Promise<void> {
  if (!caseId) return;
  try {
    const { error } = await db.from('case_events').insert({
      case_id: caseId,
      event_type: eventType,
      actor,
      data,
    });
    if (error && error.code !== '23505') {
      console.error(`logEvent(${eventType}) failed:`, error.message);
    }
  } catch (e) {
    console.error(`logEvent(${eventType}) exception:`, e);
  }
}

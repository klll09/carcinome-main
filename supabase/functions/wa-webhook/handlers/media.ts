// wa-webhook/handlers/media.ts — inbound media (image/document/audio/video/sticker):
// download from Meta IMMEDIATELY (media URLs expire), archive to Storage under the
// case, re-upload for relaying, then route through the relay hub.
import { db } from '../../_shared/db.ts';
import { downloadMedia, extFromMime, uploadMedia } from '../../_shared/wa.ts';
import { findLiveParticipations, type FanOutContent } from '../../_shared/relay.ts';
import { groupByCase, onceDailyAutoReply, routeToRelay, type InboundCtx } from './_common.ts';

/** Storage object keys: keep to a safe character set (wamids contain '=' etc.). */
function safeKey(s: string): string {
  return String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
}

export async function handleMedia(ctx: InboundCtx, kind: string): Promise<void> {
  const mediaObj = ctx.message?.[kind] as
    | { id?: string; mime_type?: string; filename?: string; caption?: string }
    | undefined;
  if (!mediaObj?.id) {
    console.warn(`media message from ${ctx.from} has no ${kind}.id — skipped`);
    return;
  }

  const parts = await findLiveParticipations(ctx.from);
  if (parts.length === 0) {
    // Same path as _common's unknown-sender handling.
    await onceDailyAutoReply(ctx.from);
    return;
  }

  // Download immediately — inbound media ids/URLs expire quickly.
  let bytes: Uint8Array;
  let mime: string;
  try {
    const dl = await downloadMedia(mediaObj.id);
    bytes = dl.bytes;
    mime = dl.mime || mediaObj.mime_type || 'application/octet-stream';
  } catch (e) {
    console.error(`downloadMedia(${mediaObj.id}) from ${ctx.from} failed:`, e);
    return;
  }

  const ext = extFromMime(mime);
  const filename = mediaObj.filename ?? `${kind}-${Date.now()}.${ext}`;
  const caption = mediaObj.caption;

  // Single active CASE (a doubled phone may hold several rows on it) →
  // archive the original bytes to the case folder.
  const byCase = groupByCase(parts);
  if (byCase.size === 1) {
    const caseId = [...byCase.keys()][0];
    const path = `cases/${caseId}/media/${safeKey(ctx.wamid)}.${ext}`;
    try {
      const { error } = await db.storage
        .from('case-docs')
        .upload(path, bytes.buffer as ArrayBuffer, { contentType: mime, upsert: true });
      if (error) {
        console.error(`storage upload failed (${path}):`, error.message);
      } else if (ctx.msgId) {
        // Record where the original landed on the inbound ledger row.
        await db
          .from('messages')
          .update({ payload: { ...ctx.message, storage_path: path } })
          .eq('id', ctx.msgId);
      }
    } catch (e) {
      console.error(`storage archive exception (${path}):`, e);
    }
  }

  // Re-upload to get a media id we own (inbound ids are not re-sendable).
  let relayMediaId: string;
  try {
    relayMediaId = await uploadMedia(bytes, mime);
  } catch (e) {
    console.error(`uploadMedia for relay failed (${ctx.wamid}):`, e);
    return;
  }

  const content: FanOutContent = {
    mediaId: relayMediaId,
    mediaType: mime,
    filename,
    ...(caption ? { caption } : {}),
  };

  // 1 case → attach + fanOut; >1 → routeToRelay stashes context.pending[wamid]
  // (PendingEntry, media nested) and sends the case-picker list; onRelayCtx releases it.
  await routeToRelay(ctx, content, parts);
}

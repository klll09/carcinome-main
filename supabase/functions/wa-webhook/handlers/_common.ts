// wa-webhook/handlers/_common.ts — shared context type, copy, and helpers for the handlers.
import { db, getSetting } from '../../_shared/db.ts';
import { notifyPoc } from '../../_shared/doctor.ts';
import { langFor, pick, type Lang } from '../../_shared/lang.ts';
import { buildCaseContext, conciergeClassify, llmBudgetConsume, llmBudgetOk, looksLikeEmergency } from '../../_shared/llm.ts';
import { logEvent } from '../../_shared/log.ts';
import { normPhone } from '../../_shared/phone.ts';
import { fanOut, findLiveParticipations, pickPreferredRole, type FanOutContent, type Participation } from '../../_shared/relay.ts';
import { sendFlow, sendList, sendSmart, sendText } from '../../_shared/wa.ts';

// deno-lint-ignore no-explicit-any
export type WaMessage = any;

export interface InboundCtx {
  from: string; // canonical phone (= wa_id)
  wamid: string;
  msgId: number | null; // messages ledger row id of this inbound
  profileName: string;
  message: WaMessage;
}

export function nonce8(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function inr(n: number): string {
  return `₹${Number(n ?? 0).toLocaleString('en-IN')}`;
}

export function istNow(): string {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
  });
}

/** Attach a case (and optionally a role) to an already-ledgered inbound message row. */
export async function attachCase(msgId: number | null, caseId: string, role?: string): Promise<void> {
  if (!msgId || !caseId) return;
  try {
    const patch: Record<string, unknown> = { case_id: caseId };
    if (role) patch.participant_role = role;
    await db.from('messages').update(patch).eq('id', msgId);
  } catch (e) {
    console.error('attachCase failed:', e);
  }
}

/**
 * Merge keys into conversation_state.context for a phone. Atomic via the
 * merge_context() SQL function (null values delete keys) — the old TS
 * read-modify-write lost writes when two webhook deliveries raced. Falls back
 * to the non-atomic path if the RPC is missing.
 */
export async function mergeContext(phone: string, patch: Record<string, unknown>): Promise<void> {
  const p = normPhone(phone);
  try {
    const { error } = await db.rpc('merge_context', { p_phone: p, p_patch: patch });
    if (!error) return;
    console.error('merge_context rpc failed, using fallback:', error.message);
  } catch (e) {
    console.error('merge_context rpc exception, using fallback:', e);
  }
  try {
    const { data } = await db.from('conversation_state').select('context').eq('phone', p).maybeSingle();
    const context = { ...(data?.context ?? {}), ...patch };
    for (const k of Object.keys(context)) {
      if ((context as Record<string, unknown>)[k] === null) delete (context as Record<string, unknown>)[k];
    }
    await db
      .from('conversation_state')
      .upsert({ phone: p, context, updated_at: new Date().toISOString() }, { onConflict: 'phone' });
  } catch (e) {
    console.error('mergeContext fallback failed:', e);
  }
}

/** Polite auto-reply for unknown numbers — at most once per 24h per phone. */
export async function onceDailyAutoReply(phone: string): Promise<void> {
  try {
    const p = normPhone(phone);
    const { data } = await db
      .from('conversation_state')
      .select('last_autoreply_at')
      .eq('phone', p)
      .maybeSingle();
    if (data?.last_autoreply_at && Date.now() - new Date(data.last_autoreply_at).getTime() < 24 * 3600_000) {
      return;
    }
    await sendText(
      p,
      'Namaste 🙏 This is Carcinome Home Care (Jarurat Care Foundation). ' +
        'This number sends updates for active home-care cases. If you need our care services, ' +
        'please contact our team or ask your doctor for a referral.\n\n' +
        'नमस्ते 🙏 यह Carcinome Home Care (जरूरत केयर फाउंडेशन) है। यह नंबर सक्रिय होम-केयर केस के अपडेट के लिए है। ' +
        'सेवा के लिए कृपया हमारी टीम से संपर्क करें या अपने डॉक्टर से रेफ़रल लें।',
    );
    await db
      .from('conversation_state')
      .upsert(
        { phone: p, last_autoreply_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: 'phone' },
      );
  } catch (e) {
    console.error('onceDailyAutoReply failed:', e);
  }
}

/** Notify supervisor + ops phones (settings) — window-aware with care_update fallback. */
export async function notifyTeam(text: string, caseId?: string): Promise<void> {
  try {
    const sup = (await getSetting<string[]>('supervisor_phones')) ?? [];
    const ops = (await getSetting<string[]>('ops_phones')) ?? [];
    const phones = [...new Set([...sup, ...ops].map(normPhone).filter(Boolean))];
    for (const ph of phones) {
      const lang = await langFor(ph);
      await sendSmart(
        ph,
        text,
        { name: 'care_update', lang, params: ['Carcinome System', text] },
        { caseId, role: 'ops' },
      );
    }
  } catch (e) {
    console.error('notifyTeam failed:', e);
  }
}

// ─── LLM concierge (rides the relay path; never replaces it) ────────────────
// Every free-form message STILL reaches the humans through the relay. On top,
// Gemini — fed the full case facts — decides whether an instant factual reply
// or an emergency escalation is warranted. The team hears about every single
// exchange the model touches; hard emergency keywords escalate even when the
// model is down or the daily budget is spent.
/** One 🚨 escalation burst per phone per 10 minutes — repeats are logged only. */
async function emergencyRateOk(phone: string): Promise<boolean> {
  try {
    const p = normPhone(phone);
    const { data } = await db.from('conversation_state').select('context').eq('phone', p).maybeSingle();
    const last = data?.context?.er_at ? new Date(data.context.er_at).getTime() : 0;
    if (Date.now() - last < 10 * 60_000) return false;
    await db.rpc('merge_context', { p_phone: p, p_patch: { er_at: new Date().toISOString() } });
    return true;
  } catch {
    return true; // when in doubt, escalate
  }
}

async function runConcierge(ctx: InboundCtx, p: Participation, text: string): Promise<void> {
  try {
    const t = String(text ?? '').trim();
    if (!t || t.length < 2) return;
    if (!['patient', 'doctor', 'nurse'].includes(p.role)) return;
    const caseCode = p.cases?.case_code ?? '';
    // Reply in the language the message was WRITTEN in — a Hindi message from
    // a phone whose stored pref is 'en' still deserves a Hindi answer.
    const lang: Lang = /[ऀ-ॿ]/.test(t) ? 'hi' : await langFor(ctx.from);
    const emergency = looksLikeEmergency(t); // 'hard' | 'soft' | false

    // The LLM only sees bounded input; the hard-keyword path has no length cap.
    let r = null;
    if (t.length <= 600 && (emergency || (await llmBudgetOk(ctx.from)))) {
      const caseCtx = await buildCaseContext(p.case_id);
      r = await conciergeClassify(p.role, p.display_name || ctx.profileName || 'participant', t, caseCtx);
      if (r) await llmBudgetConsume(ctx.from);
    }

    // Escalate when keywords are un-negated ('hard' — safety-first even if the
    // model disagrees), or when the model itself calls it an emergency, or on
    // a negated keyword hit that the model could not be consulted about.
    const escalate = emergency === 'hard' || r?.urgency === 'emergency' || (emergency === 'soft' && !r);
    if (escalate) {
      const burst = await emergencyRateOk(ctx.from);
      const reply = (r?.reply_en || r?.reply_hi)
        ? pick(lang, { en: r!.reply_en || r!.reply_hi, hi: r!.reply_hi || r!.reply_en })
        : pick(lang, {
          en: '🚨 We have alerted the Carcinome care team RIGHT NOW and they are contacting you. If this is a medical emergency, please also call 108 immediately.',
          hi: '🚨 हमने कार्सिनोम केयर टीम को तुरंत सूचित कर दिया है और वे आपसे संपर्क कर रहे हैं। यदि यह मेडिकल इमरजेंसी है, तो कृपया तुरंत 108 पर भी कॉल करें।',
        });
      if (burst) {
        await sendText(ctx.from, reply, { caseId: p.case_id, role: p.role });
        await notifyTeam(
          `🚨 POSSIBLE EMERGENCY on ${caseCode}: the ${p.role} wrote "${t.slice(0, 150)}"${r?.team_summary ? ` — ${r.team_summary}` : ''} — CONTACT THEM NOW.`,
          p.case_id,
        );
        await notifyPoc(p.case_id, `🚨 ${caseCode}: possible emergency from the ${p.role} — "${t.slice(0, 100)}" — care team alerted.`);
      }
      await logEvent(p.case_id, 'llm_emergency_flag', `${p.role}:${ctx.from}`, { msg: t.slice(0, 200), burst });
      return;
    }

    if (!r) return; // model unavailable/over budget → relay already did its job

    // Plain chatter/thanks: humans saw it via the relay; stay silent.
    if (r.intent === 'update_or_chatter' || r.intent === 'thanks' || (!r.reply_en && !r.reply_hi)) {
      if (r.urgency === 'high' && r.team_summary) {
        await notifyTeam(`⚠️ ${caseCode}: ${r.team_summary} — they wrote: "${t.slice(0, 120)}"`, p.case_id);
      }
      return;
    }

    const reply = pick(lang, { en: r.reply_en || r.reply_hi, hi: r.reply_hi || r.reply_en });
    if (!reply) return;
    await sendText(ctx.from, reply, { caseId: p.case_id, role: p.role });
    await logEvent(p.case_id, r.can_answer ? 'llm_reply' : 'llm_ack', `${p.role}:${ctx.from}`, {
      intent: r.intent,
      summary: r.team_summary,
    });
    await notifyTeam(
      `${r.urgency === 'high' ? '⚠️' : '🤖'} ${caseCode}: ${r.team_summary || `${p.role} asked something`} — they wrote: "${t.slice(0, 120)}"${r.can_answer ? ' (auto-answered from case facts)' : ' (holding reply sent — needs a human)'}`,
      p.case_id,
    );
  } catch (e) {
    console.error('runConcierge failed:', e);
  }
}

// ─── Flows ──────────────────────────────────────────────────────────────────

const DEFAULT_SCREENS: Record<string, string> = {
  consent_v1: 'INFO',
  completion_v1: 'REPORT',
  feedback_v1: 'FEEDBACK',
};

/** Resolve a flow's Meta id + entry screen from settings.flow_ids. */
export async function getFlowRef(name: string): Promise<{ id: string; screen: string } | null> {
  const ids = await getSetting<Record<string, unknown>>('flow_ids');
  const v = ids?.[name];
  if (!v) return null;
  if (typeof v === 'string') return { id: v, screen: DEFAULT_SCREENS[name] ?? 'START' };
  const obj = v as { id?: string; screen?: string };
  if (!obj.id) return null;
  return { id: obj.id, screen: obj.screen ?? DEFAULT_SCREENS[name] ?? 'START' };
}

/** Send the completion report flow to a nurse for a case. */
export async function sendCompletionFlow(
  c: { id: string; case_code: string },
  nursePhone: string,
  lang: Lang,
): Promise<boolean> {
  const flow = await getFlowRef('completion_v1');
  if (!flow) {
    console.error('completion_v1 flow id missing in settings.flow_ids');
    await sendText(
      nursePhone,
      pick(lang, {
        en: `Could not open the completion form for ${c.case_code}. Please share the report details here as a message — the care team will receive them.`,
        hi: `केस ${c.case_code} का रिपोर्ट फ़ॉर्म नहीं खुल पाया। कृपया रिपोर्ट की जानकारी यहीं संदेश में भेज दें — वह केयर टीम तक पहुंच जाएगी।`,
      }),
      { caseId: c.id, role: 'nurse' },
    );
    await logEvent(c.id, 'flow_unavailable', 'system', { flow: 'completion_v1' });
    return false;
  }
  const token = `completion_v1:${c.id}:${nonce8()}`;
  const r = await sendFlow(
    nursePhone,
    {
      flowId: flow.id,
      flowToken: token,
      cta: pick(lang, { en: 'Fill report', hi: 'रिपोर्ट भरें' }),
      screen: flow.screen,
      bodyText: pick(lang, {
        en: `Please fill the care completion report for case ${c.case_code}. It takes about a minute.`,
        hi: `कृपया केस ${c.case_code} की देखभाल रिपोर्ट भरें। इसमें लगभग एक मिनट लगेगा।`,
      }),
    },
    { caseId: c.id, role: 'nurse' },
  );
  return r.ok;
}

// ─── Relay routing (shared by text + media) ─────────────────────────────────

const CARE_LABELS_FALLBACK: Record<string, string> = {
  one_time_infusion: 'One-time infusion',
  chemo_infusion: 'Chemo infusion',
  nursing_12h: '12-hour nursing',
  nursing_24h: '24-hour nursing',
};

/** Stashed relay messages expire after 1 hour. */
export const PENDING_TTL_MS = 3600_000;

/** One inbound message parked while we ask "which case?" — keyed by wamid in context.pending. */
export type PendingEntry = {
  kind: 'text' | 'media';
  text?: string;
  media?: { mediaId?: string; mediaType?: string; filename?: string; caption?: string };
  msgId?: number | null;
  at?: string;
};

/** Group a phone's participations by case (a doubled phone holds several rows per case). */
export function groupByCase(parts: Participation[]): Map<string, Participation[]> {
  const byCase = new Map<string, Participation[]>();
  for (const p of parts) {
    const list = byCase.get(p.case_id) ?? [];
    list.push(p);
    byCase.set(p.case_id, list);
  }
  return byCase;
}

/**
 * Route an inbound free-form message into the relay hub.
 * 0 live cases → once-per-24h auto-reply; 1 case → fan out (attributed to the
 * phone's preferred role on that case); >1 case → stash pending + case-picker list.
 */
export async function routeToRelay(
  ctx: InboundCtx,
  content: FanOutContent,
  preloaded?: Participation[],
): Promise<void> {
  const parts = preloaded ?? (await findLiveParticipations(ctx.from));

  if (parts.length === 0) {
    await onceDailyAutoReply(ctx.from);
    return;
  }

  const inboundText = content.text ?? content.caption ?? '';
  const byCase = groupByCase(parts);
  if (byCase.size === 1) {
    const p = pickPreferredRole([...byCase.values()][0])!;
    await attachCase(ctx.msgId, p.case_id, p.role);
    await fanOut(p.case_id, ctx.from, p.display_name || ctx.profileName || 'Participant', content, ctx.msgId);
    // The humans have the message (relay above) — now let the concierge see
    // whether an instant factual answer or an emergency escalation is due.
    if (inboundText) await runConcierge(ctx, p, inboundText);
    return;
  }

  // Multi-case phone: the picker below asks "which patient?" — but a hard
  // emergency phrase must never wait for that answer.
  if (inboundText && looksLikeEmergency(inboundText) === 'hard') {
    const lang = await langFor(ctx.from);
    const codes = [...byCase.values()].map((rows) => pickPreferredRole(rows)?.cases?.case_code).filter(Boolean).join(', ');
    await sendText(ctx.from, pick(lang, {
      en: '🚨 We have alerted the Carcinome care team RIGHT NOW and they are contacting you. If this is a medical emergency, please also call 108 immediately.',
      hi: '🚨 हमने कार्सिनोम केयर टीम को तुरंत सूचित कर दिया है और वे आपसे संपर्क कर रहे हैं। मेडिकल इमरजेंसी होने पर कृपया तुरंत 108 पर भी कॉल करें।',
    }));
    await notifyTeam(`🚨 POSSIBLE EMERGENCY from +${ctx.from} (on cases ${codes}): they wrote "${inboundText.slice(0, 150)}" — CONTACT THEM NOW.`);
    const firstCase = [...byCase.keys()][0];
    if (firstCase) await logEvent(firstCase, 'llm_emergency_flag', `multi:${ctx.from}`, { msg: inboundText.slice(0, 200) });
  }

  // Ambiguous: stash the pending content per-message (keyed by wamid — a second message
  // must not overwrite the first), then ask which case it's about.
  const entry: PendingEntry = content.text != null
    ? { kind: 'text', text: content.text, msgId: ctx.msgId, at: new Date().toISOString() }
    : {
      kind: 'media',
      media: {
        mediaId: content.mediaId,
        mediaType: content.mediaType,
        filename: content.filename,
        caption: content.caption,
      },
      msgId: ctx.msgId,
      at: new Date().toISOString(),
    };
  const { data: cs } = await db
    .from('conversation_state')
    .select('context')
    .eq('phone', ctx.from)
    .maybeSingle();
  const pending: Record<string, PendingEntry> = { ...(cs?.context?.pending ?? {}) };
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [k, v] of Object.entries(pending)) {
    if (v?.at && new Date(v.at).getTime() < cutoff) delete pending[k];
  }
  pending[ctx.wamid] = entry;
  await mergeContext(ctx.from, { pending });

  const lang = await langFor(ctx.from);
  const labels = (await getSetting<Record<string, string>>('care_type_labels')) ?? CARE_LABELS_FALLBACK;
  // One list row per CASE (not per participant row — doubled phones would duplicate).
  const rows = [...byCase.values()].slice(0, 10).map((caseRows) => {
    const p = pickPreferredRole(caseRows)!;
    return {
      id: `relay_ctx:${p.case_id}`,
      title: (p.cases?.patients?.full_name ?? p.cases?.case_code ?? 'Case').slice(0, 24),
      description: `${p.cases?.case_code ?? ''} · ${labels[p.cases?.care_type] ?? p.cases?.care_type ?? ''}`.slice(0, 72),
    };
  });
  await sendList(
    ctx.from,
    pick(lang, {
      en: 'You are part of more than one active case. Which patient is this message about?',
      hi: 'आप एक से अधिक सक्रिय केस से जुड़े हैं। यह संदेश किस रोगी के बारे में है?',
    }),
    pick(lang, { en: 'Choose case', hi: 'केस चुनें' }),
    rows,
  );
}

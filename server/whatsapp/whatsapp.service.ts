import { Prisma, type WhatsAppConversation, type WhatsAppMessage } from '@prisma/client';

import { db } from '@/lib/db';
import { decrypt, encrypt, keyedHash } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import {
  contentSummary,
  fitContent,
  normalizeWaId,
  shouldApplyStatus,
  toApiMessage,
  withinServiceWindow,
  type InboundMessage,
  type OutboundContent,
  type ParsedWebhook,
  type StatusUpdate,
  type WhatsAppConfig,
} from '@/lib/whatsapp';
import { signedAssetUrl } from '@/server/media/asset-url';
import { recordAudit } from '@/server/services/audit.service';
import { sendMessage, WhatsAppApiError } from '@/server/whatsapp/client';

/**
 * Botella's WhatsApp Assistant — storage and sending for the central number.
 *
 *   processWebhook   a verified webhook: apply delivery statuses, and store
 *                    each new message together with the job that will answer
 *                    it (Meta's id is unique, so a redelivery is ignored).
 *                    Nothing slow happens here — the queue (queue.ts) answers.
 *   sendContent      one outgoing message (text, menu or image): stored first
 *                    as PENDING with a retry already scheduled, then sent; a
 *                    retryable failure is rescheduled, a final one audited
 *   retryDueMessages re-sends what is due (the sweep)
 *
 * Only replies to people who wrote to us, inside Meta's 24-hour window —
 * nothing is ever sent unprompted, and an opt-out is honoured at once.
 */

const HASH_PURPOSE = 'whatsapp-wa-id';
/** Give up sending after this many attempts. */
export const MAX_ATTEMPTS = 6;
/** Back-off before the next send retry, by attempts so far. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
/** Meta's throughput/rate errors (cloud API error codes), and HTTP 429. */
const THROTTLE_CODES = new Set(['130429', '131056', '131048', '80007', '4', '429']);
/** Base wait before the one quick retry of a throttled send (plus up to as much again, random). */
const quickRetryMs = () => Number(process.env.WHATSAPP_QUICK_RETRY_MS ?? 1000);

/** How long an image link Meta fetches stays valid. */
const IMAGE_LINK_TTL_MS = 15 * 60_000;

export const backoffFor = (attempts: number) =>
  BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)]!;

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** The lookup key for a WhatsApp id (their number). */
export const waIdKey = (waId: string) => keyedHash(waId, HASH_PURPOSE);

// ---------------------------------------------------------------------------
// Conversations and inbound messages
// ---------------------------------------------------------------------------

async function conversationFor(
  msg: InboundMessage,
): Promise<{ conversation: WhatsAppConversation; created: boolean }> {
  const waId = normalizeWaId(msg.waId);
  if (!waId) throw new Error('Inbound message has no usable WhatsApp id.');
  const waIdHash = waIdKey(waId);
  const touch = {
    lastMessageAt: new Date(),
    ...(msg.profileName ? { profileName: msg.profileName.slice(0, 120) } : {}),
  };

  const existing = await db.whatsAppConversation.findUnique({ where: { waIdHash } });
  if (existing) {
    const conversation = await db.whatsAppConversation.update({
      where: { id: existing.id },
      data: {
        ...touch,
        // Out-of-order webhooks must not move the window backwards.
        ...(!existing.lastInboundAt || msg.occurredAt > existing.lastInboundAt
          ? { lastInboundAt: msg.occurredAt }
          : {}),
      },
    });
    return { conversation, created: false };
  }
  try {
    const conversation = await db.whatsAppConversation.create({
      data: {
        waIdHash,
        waIdEncrypted: encrypt(waId),
        waIdLast4: waId.slice(-4),
        lastInboundAt: msg.occurredAt,
        ...touch,
      },
    });
    return { conversation, created: true };
  } catch (err) {
    // Two webhooks from the same new person at once: the other one created it.
    if (!isUniqueViolation(err)) throw err;
    const conversation = await db.whatsAppConversation.findUniqueOrThrow({ where: { waIdHash } });
    return { conversation, created: false };
  }
}

/**
 * Store an inbound message and queue the job that answers it, in one
 * transaction — so a message is never stored without being answered, nor
 * queued twice. `duplicate` when Meta delivered it before.
 */
export async function recordInbound(msg: InboundMessage): Promise<
  | { duplicate: true }
  | { duplicate: false; conversation: WhatsAppConversation; message: WhatsAppMessage }
> {
  // Cheap check first, so a redelivery does not even touch the conversation.
  if (await db.whatsAppMessage.findUnique({ where: { wamid: msg.wamid }, select: { id: true } })) {
    return { duplicate: true };
  }
  const { conversation } = await conversationFor(msg);
  try {
    const message = await db.$transaction(async (tx) => {
      const m = await tx.whatsAppMessage.create({
        data: {
          conversationId: conversation.id,
          direction: 'INBOUND',
          wamid: msg.wamid,
          type: msg.type.slice(0, 40),
          body: msg.text?.slice(0, 4096) ?? null,
          ...(msg.replyId ? { payload: { replyId: msg.replyId.slice(0, 200) } } : {}),
          status: 'RECEIVED',
          occurredAt: msg.occurredAt,
        },
      });
      await tx.whatsAppJob.create({
        data: { conversationId: conversation.id, messageId: m.id },
      });
      return m;
    });
    return { duplicate: false, conversation, message };
  } catch (err) {
    // The same message in two concurrent deliveries: only one is stored.
    if (isUniqueViolation(err)) return { duplicate: true };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type SendOutcome =
  | { status: 'sent'; messageId: string; wamid: string }
  | { status: 'scheduled'; messageId: string; error: string }
  | { status: 'failed'; messageId: string | null; error: string };

/**
 * Send one message. It is stored before it is sent — with a retry already
 * scheduled — so a message interrupted mid-send is picked up by the sweep
 * rather than lost.
 */
export async function sendContent(args: {
  config: WhatsAppConfig;
  conversation: WhatsAppConversation;
  content: OutboundContent;
  replyTo?: { id: string; wamid: string | null } | null;
  /** The opt-out confirmation itself is sent even though they have opted out. */
  allowOptedOut?: boolean;
  /** The workspace it was sent for (the dashboard shows only its own). */
  companyId?: string | null;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<SendOutcome> {
  const now = args.now ?? new Date();
  const { conversation } = args;
  if (conversation.optedOut && !args.allowOptedOut) {
    return { status: 'failed', messageId: null, error: 'They have opted out of messages.' };
  }
  if (!withinServiceWindow(conversation.lastInboundAt, now)) {
    // Outside the window only an approved template may be sent.
    return {
      status: 'failed',
      messageId: null,
      error: 'More than 24 hours since their last message — a template is required.',
    };
  }
  const content = fitContent(args.content);
  const message = await db.whatsAppMessage.create({
    data: {
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      type: content.kind === 'text' || content.kind === 'image' ? content.kind : 'interactive',
      body: contentSummary(content).slice(0, 4096),
      payload: content as unknown as Prisma.InputJsonObject,
      status: 'PENDING',
      replyToId: args.replyTo?.id ?? null,
      companyId: args.companyId ?? null,
      nextAttemptAt: new Date(now.getTime() + backoffFor(1)),
      occurredAt: now,
    },
  });
  await db.whatsAppConversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: now },
  });
  return attemptSend({
    config: args.config,
    message,
    conversation,
    replyToWamid: args.replyTo?.wamid ?? null,
    fetchImpl: args.fetchImpl,
    now,
  });
}

/** A text message — the common case. */
export function sendText(args: Omit<Parameters<typeof sendContent>[0], 'content'> & { text: string }) {
  const { text, ...rest } = args;
  return sendContent({ ...rest, content: { kind: 'text', text } });
}

/** What a stored outbound message sends: its payload, else its text. */
function storedContent(message: WhatsAppMessage): OutboundContent {
  const p = message.payload as { kind?: string } | null;
  if (p && typeof p.kind === 'string') return p as OutboundContent;
  return { kind: 'text', text: message.body ?? '' };
}

async function attemptSend(args: {
  config: WhatsAppConfig;
  message: WhatsAppMessage;
  conversation: WhatsAppConversation;
  replyToWamid: string | null;
  fetchImpl?: typeof fetch;
  now: Date;
}): Promise<SendOutcome> {
  const { message, conversation, now } = args;
  const attempts = message.attempts + 1;
  try {
    const content = storedContent(message);
    // A fresh signed link on every attempt, so a retry never sends an expired one.
    const link = content.kind === 'image' ? signedAssetUrl(content.assetId, IMAGE_LINK_TTL_MS).url : undefined;
    const send = () =>
      sendMessage(args.config, decrypt(conversation.waIdEncrypted), toApiMessage(content, link), {
        replyTo: args.replyToWamid,
        fetchImpl: args.fetchImpl,
      });
    let wamid: string;
    try {
      wamid = await send();
    } catch (err) {
      // Meta's throughput limits clear in seconds: one quick retry, with
      // jitter, before the minutes-long scheduled back-off. Measured under
      // load, waiting a full minute (then five) for a 2% throttle left
      // replies unsent for minutes.
      if (!(err instanceof WhatsAppApiError) || !THROTTLE_CODES.has(err.code)) throw err;
      await new Promise((r) => setTimeout(r, quickRetryMs() * (1 + Math.random())));
      wamid = await send();
    }
    await db.whatsAppMessage.update({
      where: { id: message.id },
      // Accepted by Meta; delivered/read follow as statuses.
      data: {
        wamid,
        status: 'SENT',
        sentAt: now,
        attempts,
        nextAttemptAt: null,
        errorCode: null,
        errorMessage: null,
        // A button link can carry a sign-in or connect token: once sent, it
        // is not kept (it is never sent again).
        ...(content.kind === 'cta'
          ? { payload: { ...content, url: '[sent]' } as unknown as Prisma.InputJsonObject }
          : {}),
      },
    });
    return { status: 'sent', messageId: message.id, wamid };
  } catch (err) {
    const e =
      err instanceof WhatsAppApiError
        ? err
        : new WhatsAppApiError(err instanceof Error ? err.message : String(err), 'internal', false, null);
    const retry = e.retryable && attempts < MAX_ATTEMPTS;
    await db.whatsAppMessage.update({
      where: { id: message.id },
      data: retry
        ? {
            attempts,
            status: 'PENDING',
            nextAttemptAt: new Date(now.getTime() + backoffFor(attempts)),
            errorCode: e.code,
            errorMessage: e.message,
          }
        : {
            attempts,
            status: 'FAILED',
            failedAt: now,
            nextAttemptAt: null,
            errorCode: e.code,
            errorMessage: e.message,
          },
    });
    if (!retry) {
      await recordAudit({
        action: 'WHATSAPP_SEND_FAILED',
        metadata: { messageId: message.id, conversationId: conversation.id, code: e.code, attempts },
      });
    }
    logger.warn('whatsapp: send failed', {
      messageId: message.id,
      code: e.code,
      retry,
      attempts,
    });
    return retry
      ? { status: 'scheduled', messageId: message.id, error: e.message }
      : { status: 'failed', messageId: message.id, error: e.message };
  }
}

/**
 * Re-send messages whose retry is due. Each one is claimed first, so two
 * sweeps (or a sweep and the original request) never send it twice. A
 * message whose 24-hour window has closed is failed, not sent.
 */
export async function retryDueMessages(args: {
  config: WhatsAppConfig;
  limit?: number;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<{ sent: number; scheduled: number; failed: number }> {
  const now = args.now ?? new Date();
  const due = await db.whatsAppMessage.findMany({
    where: {
      direction: 'OUTBOUND',
      status: 'PENDING',
      nextAttemptAt: { lte: now },
      attempts: { lt: MAX_ATTEMPTS },
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: args.limit ?? 20,
    include: { conversation: true },
  });
  const tally = { sent: 0, scheduled: 0, failed: 0 };
  for (const m of due) {
    const claim = await db.whatsAppMessage.updateMany({
      where: { id: m.id, status: 'PENDING', nextAttemptAt: m.nextAttemptAt },
      data: { nextAttemptAt: new Date(now.getTime() + backoffFor(1)) },
    });
    if (claim.count !== 1) continue;

    const blocked = m.conversation.optedOut
      ? 'They have opted out of messages.'
      : !withinServiceWindow(m.conversation.lastInboundAt, now)
        ? 'The 24-hour window closed before the message could be sent.'
        : null;
    if (blocked) {
      await db.whatsAppMessage.update({
        where: { id: m.id },
        data: { status: 'FAILED', failedAt: now, nextAttemptAt: null, errorCode: 'blocked', errorMessage: blocked },
      });
      tally.failed++;
      continue;
    }
    const replyTo = m.replyToId
      ? await db.whatsAppMessage.findUnique({ where: { id: m.replyToId }, select: { wamid: true } })
      : null;
    const outcome = await attemptSend({
      config: args.config,
      message: m,
      conversation: m.conversation,
      replyToWamid: replyTo?.wamid ?? null,
      fetchImpl: args.fetchImpl,
      now,
    });
    tally[outcome.status]++;
  }
  return tally;
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/** Apply a delivery status to the message it is about; never moves backwards. */
export async function applyStatus(update: StatusUpdate): Promise<'applied' | 'unknown' | 'stale'> {
  const message = await db.whatsAppMessage.findUnique({ where: { wamid: update.wamid } });
  if (!message) return 'unknown';
  const next = update.status.toUpperCase() as 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  if (!shouldApplyStatus(message.status, next)) return 'stale';
  const at = update.occurredAt;
  await db.whatsAppMessage.update({
    where: { id: message.id },
    data: {
      status: next,
      ...(next === 'SENT' ? { sentAt: message.sentAt ?? at } : {}),
      ...(next === 'DELIVERED' ? { deliveredAt: at } : {}),
      ...(next === 'READ' ? { readAt: at, deliveredAt: message.deliveredAt ?? at } : {}),
      ...(next === 'FAILED'
        ? {
            failedAt: at,
            nextAttemptAt: null,
            errorCode: update.error?.code ?? 'unknown',
            errorMessage: update.error?.message ?? 'Delivery failed',
          }
        : {}),
    },
  });
  if (next === 'FAILED') {
    await recordAudit({
      action: 'WHATSAPP_SEND_FAILED',
      metadata: { messageId: message.id, conversationId: message.conversationId, code: update.error?.code ?? 'unknown', stage: 'delivery' },
    });
  }
  return 'applied';
}

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

export interface WebhookResult {
  received: number;
  duplicates: number;
  statuses: number;
  /** Conversations with newly queued messages — for the caller to kick. */
  conversationIds: string[];
}

/**
 * Store a verified, parsed webhook: statuses applied, new messages stored
 * with their jobs. Fast — no AI, no sending. If storing fails this throws,
 * the route answers 500 and Meta redelivers (anything already stored is then
 * recognised as a duplicate).
 */
export async function processWebhook(parsed: ParsedWebhook): Promise<WebhookResult> {
  const result: WebhookResult = { received: 0, duplicates: 0, statuses: 0, conversationIds: [] };
  for (const update of parsed.statuses) {
    if ((await applyStatus(update)) === 'applied') result.statuses++;
  }
  const kick = new Set<string>();
  for (const msg of parsed.messages) {
    const stored = await recordInbound(msg);
    if (stored.duplicate) {
      result.duplicates++;
      continue;
    }
    result.received++;
    kick.add(stored.conversation.id);
  }
  result.conversationIds = [...kick];
  return result;
}

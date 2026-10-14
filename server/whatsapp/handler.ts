import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { optKeyword, type OutboundContent, type WhatsAppConfig } from '@/lib/whatsapp';
import { decide } from '@/server/whatsapp/agent';
import { markRead } from '@/server/whatsapp/client';
import { sendContent } from '@/server/whatsapp/whatsapp.service';

/**
 * Answer one inbound message — what a queue job does (queue.ts): decide what
 * to say (agent.ts), then send it, in order, threaded to their message.
 *
 * Idempotent: if a reply to this message already exists (the job ran, sent,
 * then died before finishing), nothing is sent again. Throws on failures worth
 * retrying (the database, a dependency); the queue backs off and retries.
 */

/**
 * Messages handled per conversation per minute. Generous enough for someone
 * tapping quickly through menus; a flood, or two bots answering each other,
 * stops being answered.
 */
const REPLY_LIMIT = { limit: 20, windowMs: 60_000 };

export async function handleInbound(args: {
  config: WhatsAppConfig;
  messageId: string;
  fetchImpl?: typeof fetch;
}): Promise<'answered' | 'silent' | 'already_answered' | 'rate_limited'> {
  const { config, fetchImpl } = args;
  const message = await db.whatsAppMessage.findUniqueOrThrow({
    where: { id: args.messageId },
    include: { conversation: true },
  });

  const replied = await db.whatsAppMessage.findFirst({
    where: { replyToId: message.id, direction: 'OUTBOUND' },
    select: { id: true },
  });
  if (replied) return 'already_answered';

  if (message.wamid) await markRead(config, message.wamid, fetchImpl);

  // STOP must always work; everything else is subject to the flood limit
  // (which also stops a flood from minting sign-in links).
  if (!optKeyword(message.body) && !rateLimit(`whatsapp-reply:${message.conversationId}`, REPLY_LIMIT).allowed) {
    logger.warn('whatsapp: reply rate limit reached', { conversationId: message.conversationId });
    return 'rate_limited';
  }

  // A progress note ("Writing your post…") goes out at once and is NOT
  // threaded: the reply-exists check above keys on the threaded answer, so a
  // job that dies mid-way still gets its real answer on the retry.
  const sendNow = async (content: OutboundContent, companyId?: string) => {
    const current = await db.whatsAppConversation.findUniqueOrThrow({ where: { id: message.conversationId } });
    await sendContent({ config, conversation: current, content, companyId, fetchImpl });
  };
  const reply = await decide({ conversation: message.conversation, message, config, fetchImpl, sendNow });
  // Recorded on the message: which workspace it was handled in.
  if (reply.companyId) {
    await db.whatsAppMessage.update({ where: { id: message.id }, data: { companyId: reply.companyId } });
  }
  if (!reply.contents.length) return 'silent';

  // Re-read: deciding may have changed it (opt-out, linking).
  const conversation = await db.whatsAppConversation.findUniqueOrThrow({ where: { id: message.conversationId } });
  for (const [i, content] of reply.contents.entries()) {
    await sendContent({
      config,
      conversation,
      content,
      // Only the first part threads to their message; the reply-exists check
      // above keys on it.
      replyTo: i === 0 ? { id: message.id, wamid: message.wamid } : null,
      allowOptedOut: reply.allowOptedOut,
      companyId: reply.companyId ?? null,
      fetchImpl,
    });
  }
  // A send that failed or was rescheduled is the sending side's to retry —
  // the message itself has been answered.
  return 'answered';
}

export const FALLBACK_TEXT =
  'Sorry — something went wrong on our side and I couldn’t handle that message. Please try again in a few minutes.';

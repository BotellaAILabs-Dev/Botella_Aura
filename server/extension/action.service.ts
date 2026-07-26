import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import type { ExtensionContext } from '@/lib/extension-auth';
import type { QueueItemType } from '@/server/extension/queue.service';

/**
 * Sync-back for extension actions (Sprint 4, Module 2). After the HUMAN clicks
 * send inside the extension, it calls this to mark the corresponding item as
 * PUBLISHED/SENT/POSTED — exactly like server-side publishing does, with an
 * AuditLog entry. The backend performs no LinkedIn action itself; it only
 * records that the human completed one.
 */
export class ActionItemError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = 'ActionItemError';
  }
}

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function completeAction(args: {
  ctx: ExtensionContext;
  itemType: QueueItemType;
  itemId: string;
  postedUrl?: string | null;
  requestMeta?: Meta;
}): Promise<{ ok: true; itemType: QueueItemType; itemId: string }> {
  const { ctx, itemType, itemId, postedUrl, requestMeta } = args;

  switch (itemType) {
    case 'content_draft':
      await completeContentDraft(ctx, itemId, postedUrl ?? null, requestMeta);
      break;
    case 'outreach_message':
      await completeOutreachMessage(ctx, itemId, requestMeta);
      break;
    case 'engagement_comment':
      await completeEngagementComment(ctx, itemId, requestMeta);
      break;
    default:
      throw new ActionItemError(`Unsupported item type: ${itemType}`, 400);
  }

  await recordAudit({
    action: 'EXTENSION_ACTION_COMPLETED',
    userId: ctx.userId,
    companyId: ctx.companyId,
    metadata: { itemType, itemId, via: 'chrome_extension' },
    ...requestMeta,
  });

  return { ok: true, itemType, itemId };
}

async function completeContentDraft(
  ctx: ExtensionContext,
  draftId: string,
  postedUrl: string | null,
  requestMeta?: Meta,
): Promise<void> {
  const draft = await db.contentDraft.findFirst({
    where: { id: draftId, companyId: ctx.companyId },
  });
  if (!draft) throw new ActionItemError('Draft not found.', 404);
  if (draft.status === 'PUBLISHED') return; // idempotent
  if (draft.status !== 'APPROVED') {
    throw new ActionItemError(
      'Only approved drafts can be marked published.',
      409,
    );
  }

  await db.$transaction(async (tx) => {
    await tx.contentDraft.update({
      where: { id: draftId },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        publishedUrl: postedUrl,
      },
    });
    await recordAudit(
      {
        action: 'CONTENT_PUBLISHED',
        userId: ctx.userId,
        companyId: ctx.companyId,
        metadata: { draftId, via: 'chrome_extension', postedUrl },
        ...requestMeta,
      },
      tx,
    );
  });
}

async function completeOutreachMessage(
  ctx: ExtensionContext,
  messageId: string,
  requestMeta?: Meta,
): Promise<void> {
  const message = await db.outreachMessage.findFirst({
    where: { id: messageId, companyId: ctx.companyId },
  });
  if (!message) throw new ActionItemError('Outreach message not found.', 404);
  if (message.status === 'SENT') return; // idempotent
  if (message.status !== 'APPROVED') {
    throw new ActionItemError('Only approved messages can be marked sent.', 409);
  }

  await db.$transaction(async (tx) => {
    await tx.outreachMessage.update({
      where: { id: messageId },
      data: { status: 'SENT', sentAt: new Date() },
    });
    // Mark the lead contacted so the pipeline reflects reality.
    await tx.lead.update({
      where: { id: message.leadId },
      data: { status: 'CONTACTED' },
    });
    await recordAudit(
      {
        action: 'OUTREACH_SENT',
        userId: ctx.userId,
        companyId: ctx.companyId,
        metadata: { messageId, via: 'chrome_extension' },
        ...requestMeta,
      },
      tx,
    );
  });
}

async function completeEngagementComment(
  ctx: ExtensionContext,
  commentId: string,
  requestMeta?: Meta,
): Promise<void> {
  const comment = await db.engagementComment.findFirst({
    where: { id: commentId, companyId: ctx.companyId },
  });
  if (!comment) throw new ActionItemError('Comment not found.', 404);
  if (comment.status === 'POSTED') return; // idempotent

  await db.$transaction(async (tx) => {
    await tx.engagementComment.update({
      where: { id: commentId },
      data: { status: 'POSTED', postedAt: new Date() },
    });
    await recordAudit(
      {
        action: 'ENGAGEMENT_COMMENT_POSTED',
        userId: ctx.userId,
        companyId: ctx.companyId,
        metadata: { commentId, via: 'chrome_extension' },
        ...requestMeta,
      },
      tx,
    );
  });
}

/** Count of extension actions the user completed today (for the rate display). */
export async function actionsToday(userId: string): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return db.auditLog.count({
    where: {
      userId,
      action: 'EXTENSION_ACTION_COMPLETED',
      createdAt: { gte: start },
    },
  });
}

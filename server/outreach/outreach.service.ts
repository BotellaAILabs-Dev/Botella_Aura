import type { AuditAction, OutreachStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import { checkOutreachMessage } from '@/server/outreach/outreach-checks.service';

/**
 * Outreach message state machine (Sprint 4, Module 3) — mirrors the Content
 * Studio approval flow so the UI reuses the same interaction pattern. APPROVED
 * messages are handed to the extension queue; only a human click there sets SENT.
 */
export class OutreachMessageNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Outreach message not found.');
    this.name = 'OutreachMessageNotFoundError';
  }
}

/**
 * Outreach history — recent messages across all leads, with lead context and
 * connection outcome, for the "Outreach History & connection status" view.
 */
export async function listOutreachHistory(companyId: string, take = 50) {
  const messages = await db.outreachMessage.findMany({
    where: { companyId },
    orderBy: [{ sentAt: 'desc' }, { updatedAt: 'desc' }],
    take,
    include: {
      lead: {
        select: {
          id: true,
          name: true,
          companyName: true,
          title: true,
          linkedInProfileUrl: true,
          status: true,
        },
      },
    },
  });

  // Roll-up counters for the summary strip.
  const summary = {
    total: messages.length,
    sent: messages.filter((m) => m.status === 'SENT').length,
    connected: messages.filter((m) => m.connectionAccepted).length,
    replied: messages.filter((m) => m.replyReceived).length,
  };
  return { messages, summary };
}

type Action = 'submit' | 'approve' | 'reject' | 'request_changes';

const ACTION_TO_STATUS: Record<Action, OutreachStatus> = {
  submit: 'PENDING_APPROVAL',
  approve: 'APPROVED',
  reject: 'REJECTED',
  request_changes: 'DRAFT',
};

const ACTION_TO_AUDIT: Record<Action, AuditAction> = {
  submit: 'OUTREACH_SUBMITTED_FOR_APPROVAL',
  approve: 'OUTREACH_APPROVED',
  reject: 'OUTREACH_REJECTED',
  request_changes: 'OUTREACH_DRAFTED',
};

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

async function getMessageOrThrow(companyId: string, messageId: string) {
  const msg = await db.outreachMessage.findFirst({
    where: { id: messageId, companyId },
  });
  if (!msg) throw new OutreachMessageNotFoundError();
  return msg;
}

export async function transitionMessage(args: {
  companyId: string;
  userId: string;
  messageId: string;
  action: Action;
  reason?: string;
  requestMeta?: Meta;
}) {
  const { companyId, userId, messageId, action, reason, requestMeta } = args;
  const current = await getMessageOrThrow(companyId, messageId);
  const status = ACTION_TO_STATUS[action];
  if (current.status === 'SENT') {
    throw Object.assign(new Error('This message was already sent.'), { status: 409 });
  }
  // The same checks the review shows (LinkedIn's limits, the workspace's
  // compliance rules): a message that breaks one cannot be approved.
  if (action === 'approve') {
    const blocking = (await checkOutreachMessage(current)).filter(
      (f) => f.severity === 'block',
    );
    if (blocking.length) {
      throw Object.assign(
        new Error(`Fix before approving: ${blocking.map((f) => f.message).join(' ')}`),
        { status: 409, code: 'outreach_checks_failed' },
      );
    }
  }

  return db.$transaction(async (tx) => {
    const msg = await tx.outreachMessage.update({
      where: { id: messageId },
      data: {
        status,
        rejectionReason:
          action === 'reject' || action === 'request_changes'
            ? reason || null
            : null,
      },
    });
    await recordAudit(
      {
        action: ACTION_TO_AUDIT[action],
        userId,
        companyId,
        metadata: { messageId, to: status },
        ...requestMeta,
      },
      tx,
    );
    return msg;
  });
}

export async function updateMessageText(args: {
  companyId: string;
  userId: string;
  messageId: string;
  draftText: string;
  requestMeta?: Meta;
}) {
  const { companyId, userId, messageId, draftText, requestMeta } = args;
  await getMessageOrThrow(companyId, messageId);
  return db.$transaction(async (tx) => {
    const msg = await tx.outreachMessage.update({
      where: { id: messageId },
      // Editing returns it to DRAFT — must be re-approved before it can be sent.
      data: { draftText, status: 'DRAFT' },
    });
    await recordAudit(
      {
        action: 'OUTREACH_DRAFTED',
        userId,
        companyId,
        metadata: { messageId, edited: true },
        ...requestMeta,
      },
      tx,
    );
    return msg;
  });
}

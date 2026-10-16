import type { AuditAction, CompanyRole, OutreachStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import { checkOutreachMessage } from '@/server/outreach/outreach-checks.service';
import { outreachMetaAfter } from '@/server/approval/approval.service';
import { withApprovedMessageVersion, withMessageVersion } from '@/server/versions/version.service';
import type { VersionSource } from '@/lib/versions';
import type { ApprovalAction } from '@/lib/approval';
import { can } from '@/lib/rbac';

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

/** Outreach moves like content: nothing is approved twice, sent is final. */
const OUTREACH_TRANSITIONS: Record<OutreachStatus, OutreachStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'DRAFT'],
  APPROVED: ['REJECTED', 'DRAFT'],
  REJECTED: ['DRAFT'],
  SENT: [],
};

const APPROVAL_ACTION: Record<Action, ApprovalAction> = {
  submit: 'submitted',
  approve: 'approved',
  reject: 'rejected',
  request_changes: 'changes_requested',
};

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
  /** The caller's role; approving and rejecting need content:approve. */
  role?: CompanyRole;
}) {
  const { companyId, userId, messageId, action, reason, requestMeta, role } = args;
  // Outreach is worked on by owners and admins (every outreach write needs
  // content:approve) — submitting or sending back included, so nobody else
  // can un-approve approved outreach.
  if (role && !can(role, 'content:approve')) {
    throw Object.assign(
      new Error(
        action === 'approve' || action === 'reject'
          ? 'Only owners and admins can approve or reject outreach.'
          : 'Only owners and admins can change outreach.',
      ),
      { status: 403 },
    );
  }
  const current = await getMessageOrThrow(companyId, messageId);
  const status = ACTION_TO_STATUS[action];
  if (current.status === 'SENT') {
    throw Object.assign(new Error('This message was already sent.'), { status: 409 });
  }
  if (current.status === status && (action === 'approve' || action === 'reject')) {
    throw Object.assign(
      new Error(action === 'approve' ? 'This message is already approved.' : 'This message is already rejected.'),
      { status: 409, code: 'duplicate' },
    );
  }
  if (!OUTREACH_TRANSITIONS[current.status].includes(status)) {
    throw Object.assign(new Error(`A ${current.status.toLowerCase().replace('_', ' ')} message cannot be ${action === 'request_changes' ? 'sent back for changes' : `${action}d`}.`), {
      status: 409,
    });
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

  const recorded = outreachMetaAfter(current, {
    action: APPROVAL_ACTION[action],
    by: userId,
    nextStatus: status,
    reason: action === 'reject' || action === 'request_changes' ? (reason ?? null) : null,
    approve: action === 'approve',
  });
  return db.$transaction(async (tx) => {
    // Only from the state it was read in: a concurrent second approval is refused.
    const { count } = await tx.outreachMessage.updateMany({
      where: { id: messageId, status: current.status },
      data: {
        status,
        rejectionReason:
          action === 'reject' || action === 'request_changes'
            ? reason || null
            : null,
        aiMetadata: action === 'approve' ? withApprovedMessageVersion(current, recorded, userId) : recorded,
      },
    });
    if (count === 0) {
      throw Object.assign(new Error('Someone else changed this message at the same moment. Reload to see where it is now.'), {
        status: 409,
        code: 'concurrent_change',
      });
    }
    const msg = await tx.outreachMessage.findUniqueOrThrow({ where: { id: messageId } });
    await recordAudit(
      {
        action: ACTION_TO_AUDIT[action],
        userId,
        companyId,
        metadata: { messageId, from: current.status, to: status, ...(reason ? { reason } : {}) },
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
  versionSource?: VersionSource;
  basedOn?: number | null;
}) {
  const { companyId, userId, messageId, draftText, requestMeta } = args;
  const current = await getMessageOrThrow(companyId, messageId);
  if (current.status === 'SENT') {
    throw Object.assign(new Error('A sent message cannot be edited.'), { status: 409 });
  }
  return db.$transaction(async (tx) => {
    const msg = await tx.outreachMessage.update({
      where: { id: messageId },
      // Editing returns it to DRAFT — must be re-approved before it can be sent.
      // The previous text is kept on the approval record.
      data: {
        draftText,
        status: 'DRAFT',
        aiMetadata: withMessageVersion(
          current,
          outreachMetaAfter(current, { action: 'edited', by: userId, nextStatus: 'DRAFT', nextText: draftText }),
          {
            text: draftText,
            source: args.versionSource ?? 'edited',
            by: userId,
            basedOn: args.basedOn ?? null,
            note: args.versionSource === 'restored' ? `Restored from version ${args.basedOn}` : null,
          },
        ),
      },
    });
    await recordAudit(
      {
        action: 'OUTREACH_DRAFTED',
        userId,
        companyId,
        metadata: { messageId, edited: true, reopenedApproval: current.status === 'APPROVED' },
        ...requestMeta,
      },
      tx,
    );
    return msg;
  });
}

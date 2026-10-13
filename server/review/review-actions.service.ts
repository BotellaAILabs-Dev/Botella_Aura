import type { CompanyRole } from '@prisma/client';

import { db } from '@/lib/db';
import { can } from '@/lib/rbac';
import { applyFields, bodyToFields, type ReviewKind } from '@/lib/review-item';
import {
  transition,
  updateDraftBody,
  scheduleDraft,
} from '@/server/content/content.service';
import { refineDraft } from '@/server/content/generator';
import {
  transitionMessage,
  updateMessageText,
} from '@/server/outreach/outreach.service';
import { regenerateMessage } from '@/server/outreach/drafting.service';
import { checkOutreachMessage } from '@/server/outreach/outreach-checks.service';

/**
 * The unified review's actions (lib/review-item.ts), one set for every module,
 * each delegating to that module's own service — so the same rules (the state
 * machine, the reviewer, compliance, the fact check) apply whichever screen a
 * person uses.
 */

export type ReviewActionInput =
  | { action: 'save'; edits: Record<string, string>; baseUpdatedAt?: string }
  | {
      action: 'regenerate';
      mode: 'fresh' | 'fix_review' | 'instructions';
      instructions?: string;
    }
  | { action: 'submit' }
  | { action: 'approve'; confirmed?: boolean }
  | { action: 'reject'; reason?: string }
  | { action: 'schedule'; scheduledFor: string };

const err = (message: string, status: number, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

const need = (
  role: CompanyRole,
  p: Parameters<typeof can>[1],
  message: string,
) => {
  if (!can(role, p)) throw err(message, 403);
};

export async function runReviewAction(args: {
  kind: ReviewKind;
  id: string;
  companyId: string;
  userId: string;
  role: CompanyRole;
  input: ReviewActionInput;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}): Promise<{ status: string; message: string }> {
  const { kind, id, companyId, userId, role, input, requestMeta } = args;

  if (kind === 'content') {
    const draft = await db.contentDraft.findFirst({ where: { id, companyId } });
    if (!draft) throw err('Not found.', 404);
    switch (input.action) {
      case 'save': {
        need(role, 'content:create', 'Your role is read-only.');
        // Never overwrite a newer version with edits made on an older one.
        if (
          input.baseUpdatedAt &&
          input.baseUpdatedAt !== draft.updatedAt.toISOString()
        ) {
          throw err(
            'It changed since you opened it (a rewrite or another person’s edit). Your edits are kept — reload to see the new version.',
            409,
            'stale',
          );
        }
        const body = applyFields(
          draft.body,
          input.edits,
          bodyToFields(draft.body),
        );
        const updated = await updateDraftBody({
          companyId,
          userId,
          draftId: id,
          body,
        });
        return {
          status: updated.status,
          message:
            draft.status === 'APPROVED'
              ? 'Saved — editing an approved piece sends it back for approval.'
              : 'Saved.',
        };
      }
      case 'regenerate': {
        need(role, 'content:create', 'Your role is read-only.');
        if (draft.status === 'PUBLISHED')
          throw err('Published content cannot be regenerated.', 409);
        const updated = await refineDraft({
          draft,
          userId,
          action:
            input.mode === 'fix_review'
              ? 'fix_review'
              : input.mode === 'instructions'
                ? 'custom'
                : 'regenerate',
          feedback:
            input.mode === 'instructions'
              ? input.instructions?.trim() || undefined
              : undefined,
        });
        return {
          status: updated.status,
          message:
            'Regenerated and reviewed again. The previous version can be restored with Undo on the full page.',
        };
      }
      case 'submit': {
        need(role, 'content:create', 'Your role is read-only.');
        const t = await transition({
          companyId,
          userId,
          draftId: id,
          to: 'PENDING_APPROVAL',
          requestMeta,
        });
        return { status: t.status, message: 'Sent for approval.' };
      }
      case 'approve': {
        need(role, 'content:approve', 'Only owners and admins can approve.');
        // An approver reviewing a draft submits and approves in one step.
        if (draft.status === 'DRAFT') {
          await transition({
            companyId,
            userId,
            draftId: id,
            to: 'PENDING_APPROVAL',
            requestMeta,
          });
        }
        const t = await transition({
          companyId,
          userId,
          draftId: id,
          to: 'APPROVED',
          requestMeta,
          factsReviewed: input.confirmed ?? false,
          reviewAcknowledged: input.confirmed ?? false,
        });
        return { status: t.status, message: 'Approved.' };
      }
      case 'reject': {
        need(role, 'content:approve', 'Only owners and admins can reject.');
        const t = await transition({
          companyId,
          userId,
          draftId: id,
          to: 'REJECTED',
          reason: input.reason,
          requestMeta,
        });
        return { status: t.status, message: 'Rejected.' };
      }
      case 'schedule': {
        need(role, 'content:publish', 'Only owners and admins can schedule.');
        const when = new Date(input.scheduledFor);
        if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
          throw err('Pick a time in the future.', 422);
        }
        const t = await scheduleDraft({
          companyId,
          userId,
          draftId: id,
          scheduledFor: when,
        });
        return {
          status: t.status,
          message: `Scheduled for ${when.toISOString()}.`,
        };
      }
    }
  }

  // Outreach
  const msg = await db.outreachMessage.findFirst({ where: { id, companyId } });
  if (!msg) throw err('Not found.', 404);
  const ownerOnly = 'Only owners and admins can work on outreach.';
  switch (input.action) {
    case 'save': {
      need(role, 'content:approve', ownerOnly);
      if (
        input.baseUpdatedAt &&
        input.baseUpdatedAt !== msg.updatedAt.toISOString()
      ) {
        throw err(
          'It changed since you opened it. Your edits are kept — reload to see the new version.',
          409,
          'stale',
        );
      }
      if (msg.status === 'SENT') throw err('Already sent.', 409);
      const text = (input.edits.draftText ?? msg.draftText).trim();
      if (!text) throw err('The message cannot be empty.', 422);
      const updated = await updateMessageText({
        companyId,
        userId,
        messageId: id,
        draftText: text,
        requestMeta,
      });
      return {
        status: updated.status,
        message: 'Saved — it needs approving again.',
      };
    }
    case 'regenerate': {
      need(role, 'content:approve', ownerOnly);
      const updated = await regenerateMessage({
        companyId,
        userId,
        messageId: id,
        requestMeta,
      });
      return {
        status: updated.status,
        message: 'Regenerated. The previous text is kept in its history.',
      };
    }
    case 'submit': {
      need(role, 'content:approve', ownerOnly);
      const t = await transitionMessage({
        companyId,
        userId,
        messageId: id,
        action: 'submit',
        requestMeta,
      });
      return { status: t.status, message: 'Sent for approval.' };
    }
    case 'approve': {
      need(role, 'content:approve', ownerOnly);
      const flags = await checkOutreachMessage(msg);
      if (flags.some((f) => f.severity === 'review') && !input.confirmed) {
        throw err(
          'Something is flagged for review — check it, then confirm to approve.',
          409,
          'needs_confirmation',
        );
      }
      const t = await transitionMessage({
        companyId,
        userId,
        messageId: id,
        action: 'approve',
        requestMeta,
      });
      return {
        status: t.status,
        message: 'Approved — it is ready to send from the extension.',
      };
    }
    case 'reject': {
      need(role, 'content:approve', ownerOnly);
      const t = await transitionMessage({
        companyId,
        userId,
        messageId: id,
        action: 'reject',
        reason: input.reason,
        requestMeta,
      });
      return { status: t.status, message: 'Rejected.' };
    }
    case 'schedule':
      throw err(
        'Outreach is sent by you from the browser extension once approved — it is not scheduled.',
        409,
      );
  }
}

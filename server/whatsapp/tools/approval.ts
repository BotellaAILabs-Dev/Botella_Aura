import { z } from 'zod';

import { can } from '@/lib/rbac';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import { bold, clip, openInAura, plain } from '@/lib/whatsapp-format';
import type { ContentTypeKey } from '@/lib/validations/content';
import { getDraft } from '@/server/content/content.service';
import { renderForManual } from '@/server/content/render';
import { runReviewAction } from '@/server/review/review-actions.service';
import { newPending, readState, writeState, type PendingAction } from '@/server/whatsapp/tools/state';
import { publishToPlatforms, type MultiPlatform } from '@/server/content/multi-publish.service';
import { resultsMessage } from '@/server/whatsapp/tools/social';
import { text, type Tool, type ToolContext, type ToolResult } from '@/server/whatsapp/tools/types';

/**
 * Approving and rejecting from WhatsApp — never in one step.
 *
 *   1. "Approve" shows exactly what will be approved and asks for a yes,
 *      with a single-use confirmation that expires in 10 minutes.
 *   2. The yes runs the SAME approval as the review screen
 *      (runReviewAction): role checked again, the AI review, compliance and
 *      fact check enforced. Blocking problems (a failed review, a
 *      contradicted fact) cannot be overridden from here.
 *   3. If Aura needs a person to vouch for unverified claims or the review's
 *      flags, it says what they are and asks a second, explicit yes — the
 *      same acknowledgement the review screen asks for.
 */

const draftArg = z.object({ draftId: z.string().min(1).max(40).optional() }).strict();

const ACK_CODES = new Set(['facts_need_review', 'review_needs_human']);

async function ask(ctx: ToolContext, action: PendingAction['action'], draftId: string | undefined): Promise<ToolResult> {
  const id = draftId ?? (await readState(ctx.linkId, ctx.companyId)).draftId;
  const draft = id ? await getDraft(ctx.companyId, id) : null;
  if (!draft) return { contents: [text('Which post? Say “show approvals” to pick one.')] };
  if (!['DRAFT', 'PENDING_APPROVAL', 'REJECTED'].includes(draft.status) || (action === 'reject' && draft.status === 'REJECTED')) {
    return { contents: [text(`That post is ${draft.status.toLowerCase().replace('_', ' ')} — there is nothing to ${action}.`)] };
  }
  const pending = newPending(action, draft.id);
  await writeState(ctx.linkId, ctx.companyId, { draftId: draft.id, pending });
  const label = CONTENT_TYPE_LABELS[draft.type as ContentTypeKey] ?? draft.type;
  const verb = action === 'approve' ? 'Approve' : 'Reject';
  return {
    contents: [
      {
        kind: 'buttons',
        body: `${verb} this ${label} in ${bold(ctx.companyName)}?\n\n“${clip(plain(renderForManual(draft)), 500)}”${
          action === 'approve' ? '\n\nApproving makes it ready to schedule or publish.' : ''
        }`,
        buttons: [
          { id: `confirm:${pending.nonce}`, title: `Yes, ${action}` },
          { id: `cancel:${pending.nonce}`, title: 'Cancel' },
        ],
        footer: 'This confirmation expires in 10 minutes',
      },
    ],
  };
}

export const approveTool: Tool<typeof draftArg> = {
  id: 'approve_draft',
  category: 'approvals',
  label: 'Approve',
  description: 'Approve the current draft (asks for confirmation first).',
  permission: 'content:approve',
  inMenu: false,
  args: draftArg,
  run: (ctx, args) => ask(ctx, 'approve', args.draftId),
};

export const rejectTool: Tool<typeof draftArg> = {
  id: 'reject_draft',
  category: 'approvals',
  label: 'Reject',
  description: 'Reject the current draft (asks for confirmation first).',
  permission: 'content:approve',
  inMenu: false,
  args: draftArg,
  run: (ctx, args) => ask(ctx, 'reject', args.draftId),
};

/**
 * The answer to a confirmation. Only the pending action's own nonce, in the
 * same workspace (readState ignores another's), unexpired, works — once.
 */
export async function answerConfirmation(ctx: ToolContext, nonce: string, yes: boolean): Promise<ToolResult> {
  const state = await readState(ctx.linkId, ctx.companyId);
  const pending = state.pending;
  if (!pending || pending.nonce !== nonce) {
    return { contents: [text('That confirmation is no longer valid. Start again from the post.')] };
  }
  // Single use: cleared before anything runs.
  await writeState(ctx.linkId, ctx.companyId, { pending: undefined });
  if (new Date(pending.expiresAt).getTime() <= Date.now()) {
    return { contents: [text('That confirmation expired. Open the post again to approve or reject it.')] };
  }
  if (!yes) return { contents: [text('Cancelled — nothing was changed.')] };
  if (pending.action === 'publish') return confirmPublish(ctx, pending);
  // The role now, not when the question was asked.
  if (!can(ctx.role, 'content:approve')) {
    return { contents: [text('Only owners and admins can approve or reject content.')] };
  }

  try {
    if (pending.action === 'reject') {
      await runReviewAction({
        kind: 'content',
        id: pending.draftId,
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: ctx.role,
        input: { action: 'reject', reason: 'Rejected from WhatsApp' },
      });
      return { contents: [text(`Rejected. ${openInAura(`/dashboard/content/${pending.draftId}`)}`)] };
    }
    await runReviewAction({
      kind: 'content',
      id: pending.draftId,
      companyId: ctx.companyId,
      userId: ctx.userId,
      role: ctx.role,
      input: { action: 'approve', confirmed: pending.acknowledged === true },
    });
    return {
      contents: [text(`✅ Approved. It’s ready to schedule or publish.\n\n${openInAura(`/dashboard/content/${pending.draftId}`)}`)],
    };
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    // Aura needs a person to vouch: say what, and ask once more.
    if (pending.action === 'approve' && !pending.acknowledged && e.code && ACK_CODES.has(e.code)) {
      const again = newPending('approve', pending.draftId, true);
      await writeState(ctx.linkId, ctx.companyId, { pending: again });
      return {
        contents: [
          {
            kind: 'buttons',
            body: `Before approving: ${plain(e.message ?? 'Aura flagged this for a person to check.')}\n\nApprove only if you have checked this yourself.`,
            buttons: [
              { id: `confirm:${again.nonce}`, title: 'I’ve checked — approve' },
              { id: `cancel:${again.nonce}`, title: 'Cancel' },
            ],
            footer: 'This confirmation expires in 10 minutes',
          },
        ],
      };
    }
    if (typeof e.status === 'number' && e.status < 500 && e.message) {
      return { contents: [text(`Not approved: ${plain(e.message)}\n\n${openInAura(`/dashboard/content/${pending.draftId}`)}`)] };
    }
    throw err;
  }
}

/**
 * The yes to "publish to these networks": exactly the networks asked about,
 * through Content Studio's one-click publishing — its approval (role, AI
 * review, compliance, fact check), its claims (never posted twice), each
 * network on its own.
 */
async function confirmPublish(ctx: ToolContext, pending: PendingAction): Promise<ToolResult> {
  // The role now, not when the question was asked.
  if (!can(ctx.role, 'content:publish')) {
    return { contents: [text('Only owners and admins can publish.')] };
  }
  try {
    const { results } = await publishToPlatforms({
      companyId: ctx.companyId,
      userId: ctx.userId,
      role: ctx.role,
      draftId: pending.draftId,
      platforms: (pending.platforms ?? []) as MultiPlatform[],
      acknowledged: pending.acknowledged === true,
    });
    return resultsMessage(results, pending.draftId);
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    if (!pending.acknowledged && e.code && ACK_CODES.has(e.code)) {
      const again = newPending('publish', pending.draftId, true, pending.platforms);
      await writeState(ctx.linkId, ctx.companyId, { pending: again });
      return {
        contents: [
          {
            kind: 'buttons',
            body: `Before approving: ${plain(e.message ?? 'Aura flagged this for a person to check.')}\n\nApprove and publish only if you have checked this yourself.`,
            buttons: [
              { id: `confirm:${again.nonce}`, title: 'I’ve checked — publish' },
              { id: `cancel:${again.nonce}`, title: 'Cancel' },
            ],
            footer: 'This confirmation expires in 10 minutes',
          },
        ],
      };
    }
    if (typeof e.status === 'number' && e.status < 500 && e.message) {
      return { contents: [text(`Not published: ${plain(e.message)}\n\n${openInAura(`/dashboard/content/${pending.draftId}`)}`)] };
    }
    throw err;
  }
}

export const APPROVAL_TOOLS = [approveTool, rejectTool];

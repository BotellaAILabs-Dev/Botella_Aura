import type {
  CompanyRole,
  AuditAction,
  ContentDraft,
  ContentStatus,
  Prisma,
  SocialPlatform,
} from '@prisma/client';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import {
  bodySchemaFor,
  isCopyOnlyType,
  type ContentTypeKey,
} from '@/lib/validations/content';
import type { QualityReport } from '@/lib/content-quality';
import { assessDraft } from '@/server/content/quality.service';
import { claimsToReview, type FactCheckReport } from '@/lib/fact-check';
import { factCheckDraft } from '@/server/content/fact-check.service';
import { ensureReview } from '@/server/content/review.service';
import { can } from '@/lib/rbac';
import {
  assertContentIntact,
  contentHash,
  contentMedia,
  contentMetaAfter,
  recordContentChange,
  syncCampaignTask,
} from '@/server/approval/approval.service';
import { contentFingerprint, type ApprovalAction } from '@/lib/approval';
import {
  withApprovedContentVersion,
  withContentVersion,
} from '@/server/versions/version.service';
import type { VersionSource } from '@/lib/versions';
import { traceAudit, withApprovalTrace } from '@/server/trace/trace.service';
import { DIMENSION_INFO, type ContentReview } from '@/lib/content-review';

/** Undo steps kept per draft (matches server/content/generator.ts). */
const HISTORY_LIMIT = 5;

/**
 * Content approval state machine + service. The publish guarantee lives HERE,
 * not in the UI (NON-NEGOTIABLE #2): the ONLY status that can transition to
 * PUBLISHED is APPROVED, so no code path can publish an unapproved draft.
 */

/** Allowed status transitions. Note PUBLISHED is reachable ONLY from APPROVED. */
const TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'REJECTED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'DRAFT'],
  APPROVED: ['PUBLISHED', 'DRAFT', 'REJECTED'],
  REJECTED: ['DRAFT'],
  PUBLISHED: [], // terminal
};

export function isValidTransition(from: ContentStatus, to: ContentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidTransitionError extends Error {
  readonly status = 409;
  constructor(from: ContentStatus, to: ContentStatus) {
    super(`Cannot move content from ${from} to ${to}.`);
    this.name = 'InvalidTransitionError';
  }
}
export class DraftNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Draft not found.');
    this.name = 'DraftNotFoundError';
  }
}

const ACTION_FOR: Partial<Record<ContentStatus, AuditAction>> = {
  PENDING_APPROVAL: 'CONTENT_SUBMITTED_FOR_APPROVAL',
  APPROVED: 'CONTENT_APPROVED',
  REJECTED: 'CONTENT_REJECTED',
  DRAFT: 'CONTENT_CHANGES_REQUESTED',
  PUBLISHED: 'CONTENT_PUBLISHED',
};

async function loadOwned(companyId: string, draftId: string): Promise<ContentDraft> {
  const draft = await db.contentDraft.findFirst({
    where: { id: draftId, companyId },
  });
  if (!draft) throw new DraftNotFoundError();
  return draft;
}

interface TransitionArgs {
  companyId: string;
  userId: string;
  draftId: string;
  to: ContentStatus;
  reason?: string;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
  /**
   * The approver has checked the claims the fact check could not verify
   * (lib/fact-check.ts). Required to approve a draft that needs review;
   * recorded in the audit trail.
   */
  factsReviewed?: boolean;
  /**
   * The approver has looked at what the AI Reviewer marked for human review
   * (lib/content-review.ts). Required to approve a draft whose review needs
   * one; recorded on the draft and in the audit trail.
   */
  reviewAcknowledged?: boolean;
  /**
   * The caller's role. Approving and rejecting need content:approve; every
   * route passes it. Omitted only by trusted server code (tests, jobs).
   */
  role?: CompanyRole;
}

/** Validated status transition + audit. The backbone of the approval loop. */
export async function transition({
  companyId,
  userId,
  draftId,
  to,
  reason,
  requestMeta,
  factsReviewed = false,
  reviewAcknowledged = false,
  role,
}: TransitionArgs): Promise<ContentDraft> {
  // Approving and rejecting are the human gate: owners and admins only.
  if (role && (to === 'APPROVED' || to === 'REJECTED') && !can(role, 'content:approve')) {
    throw Object.assign(new Error('Only owners and admins can approve or reject content.'), {
      status: 403,
    });
  }
  // Any other move (submit for approval, send back to draft) changes the
  // work: read-only roles cannot.
  if (role && !can(role, 'content:create')) {
    throw Object.assign(new Error('Your role is read-only and cannot change content.'), { status: 403 });
  }
  let draft = await loadOwned(companyId, draftId);
  if (draft.status === to && (to === 'APPROVED' || to === 'REJECTED')) {
    throw Object.assign(
      new Error(to === 'APPROVED' ? 'This is already approved.' : 'This is already rejected.'),
      { status: 409, code: 'duplicate' },
    );
  }
  if (!isValidTransition(draft.status, to)) {
    throw new InvalidTransitionError(draft.status, to);
  }

  // The AI Reviewer before the approval workflow (lib/content-review.ts):
  // nothing enters it, or is approved, without a review of the body as it now
  // stands. A failed review must be fixed or regenerated first. At approval
  // the compliance and fact checks below speak first: their messages name
  // the exact claim or rule.
  let review: ContentReview | null = null;
  let reviewFailed: Error | null = null;
  if (to === 'PENDING_APPROVAL' || to === 'APPROVED') {
    ({ draft, review } = await ensureReview(
      draft,
      to === 'APPROVED' ? 'approval' : 'submitted',
    ));
    if (review.status === 'fail') {
      const first = review.issues.find((i) => i.severity === 'blocker') ?? review.issues[0];
      const failed = review.failed.map((d) => DIMENSION_INFO[d].label).join(', ');
      reviewFailed = Object.assign(
        new Error(
          `The review failed${failed ? ` on ${failed}` : ''}${first ? ` — ${first.message}` : ''} Fix it or regenerate with the review's feedback before ${to === 'APPROVED' ? 'approving' : 'submitting'}.`,
        ),
        { status: 409, code: 'review_failed', failed: review.failed },
      );
      if (to === 'PENDING_APPROVAL') throw reviewFailed;
    }
  }
  // Compliance before approval: a draft whose check found something that
  // must not be published (an alcohol-code breach, a never-mention topic, an
  // unsupported claim, copy too long for its platform) cannot be approved
  // until it is fixed — by a rewrite, or a person's edit, which re-checks.
  if (to === 'APPROVED') {
    const quality = ((draft.aiMetadata ?? {}) as { quality?: QualityReport }).quality;
    const blocking = (quality?.issues ?? []).filter((i) => i.severity === 'block');
    if (blocking.length) {
      throw Object.assign(
        new Error(
          `Fix before approving: ${blocking.map((i) => i.message).join(' ')}`,
        ),
        { status: 409 },
      );
    }
  }

  // Factual validation before approval (lib/fact-check.ts), against what Aura
  // trusts now: a claim that contradicts it cannot be approved; claims it
  // cannot verify need the approver to say they checked them — an
  // unsupported business claim is never approved as if verified.
  let factCheck: FactCheckReport | null = null;
  if (to === 'APPROVED') {
    factCheck = await factCheckDraft(draft);
    const review = claimsToReview(factCheck);
    if (factCheck.status === 'contradicted') {
      const c = factCheck.claims.find((x) => x.status === 'contradicted')!;
      throw Object.assign(
        new Error(`Fix before approving — this contradicts what Aura knows: “${c.text}” ${c.reason}`),
        { status: 409, code: 'facts_contradicted' },
      );
    }
    const mustFix = factCheck.claims.find((x) => x.mustFix);
    if (mustFix) {
      throw Object.assign(
        new Error(`Fix before approving — “${mustFix.text}” ${mustFix.reason}`),
        { status: 409, code: 'facts_must_fix' },
      );
    }
    if (factCheck.status === 'needs_review' && !factsReviewed) {
      throw Object.assign(
        new Error(
          `${review.length} claim${review.length === 1 ? '' : 's'} could not be verified against your business details or evidence. Check ${review.length === 1 ? 'it' : 'them'}, then confirm to approve.`,
        ),
        { status: 409, code: 'facts_need_review' },
      );
    }
  }

  if (reviewFailed) throw reviewFailed;
  if (to === 'APPROVED' && review?.status === 'review_required' && !reviewAcknowledged) {
    throw Object.assign(
      new Error(
        `This piece needs a person's review before it is approved: ${review.humanReviewReasons.slice(0, 2).join(' ')} Look at the review, then confirm to approve.`,
      ),
      { status: 409, code: 'review_needs_human' },
    );
  }

  const data: Prisma.ContentDraftUpdateManyMutationInput = { status: to };
  if (to === 'APPROVED' && review) {
    // Who looked at what the review flagged.
    data.aiMetadata = {
      ...((draft.aiMetadata ?? {}) as object),
      review: {
        ...review,
        acknowledgedBy: review.status === 'review_required' ? userId : null,
      },
    } as unknown as Prisma.InputJsonObject;
  }
  if (factCheck) {
    // What was checked when it was approved, and whether a person vouched
    // for what Aura could not verify.
    data.aiMetadata = {
      ...((data.aiMetadata ?? draft.aiMetadata ?? {}) as object),
      factCheck: {
        status: factCheck.status,
        counts: factCheck.counts,
        checkedAt: factCheck.checkedAt,
        reviewedBy: factCheck.status === 'needs_review' ? userId : null,
        unverified: claimsToReview(factCheck).map((c) => ({ text: c.text, status: c.status })),
      },
    } as Prisma.InputJsonObject;
  }
  if (to === 'REJECTED') data.rejectionReason = reason ?? null;
  if (to === 'DRAFT') data.rejectionReason = null;

  // The approval record (lib/approval.ts): who, when, which version, and —
  // for an approval — exactly what was approved (text, network, images).
  const hash = await contentHash(draft);
  const action: ApprovalAction =
    to === 'PENDING_APPROVAL'
      ? 'submitted'
      : to === 'APPROVED'
        ? 'approved'
        : to === 'REJECTED'
          ? 'rejected'
          : to === 'PUBLISHED'
            ? 'executed'
            : draft.status === 'PENDING_APPROVAL'
              ? 'changes_requested'
              : 'reopened';
  data.aiMetadata = contentMetaAfter(
    { ...draft, aiMetadata: (data.aiMetadata ?? draft.aiMetadata) as Prisma.JsonValue },
    hash,
    {
      action,
      by: userId,
      nextStatus: to,
      nextHash: hash,
      reason: to === 'REJECTED' || to === 'DRAFT' ? (reason ?? null) : null,
      ...(to === 'APPROVED'
        ? { approve: { via: 'person' as const, snapshot: { body: draft.body, platform: draft.platform, media: await contentMedia(draft.id) } } }
        : {}),
    },
  );
  // The version being approved is marked (lib/versions.ts) — identifiable
  // later, and never dropped from the history.
  if (to === 'APPROVED') {
    data.aiMetadata = withApprovedContentVersion(draft, data.aiMetadata, userId);
    // The approval gets an id, and the trace points at the approved version.
    data.aiMetadata = withApprovalTrace(
      draft,
      data.aiMetadata,
      (await contentMedia(draft.id)).map((m) => m.assetId),
    );
  }

  // Only from the state it was read in: a second, concurrent approval (a
  // double click, two approvers) finds it already moved and is refused.
  // …and only the version that was reviewed and checked: an edit landing
  // while the review ran makes this a no-op, refused below.
  const { count } = await db.contentDraft.updateMany({ where: { id: draft.id, status: draft.status, updatedAt: draft.updatedAt }, data });
  if (count === 0) {
    throw Object.assign(new Error('Someone else changed this at the same moment. Reload to see where it is now.'), {
      status: 409,
      code: 'concurrent_change',
    });
  }
  await syncCampaignTask(draft.id, to);
  const updated = (await db.contentDraft.findUnique({ where: { id: draft.id } }))!;

  await recordAudit({
    action: ACTION_FOR[to] ?? 'CONTENT_DRAFT_CREATED',
    userId,
    companyId,
    metadata: {
      draftId: draft.id,
      from: draft.status,
      to,
      reason: reason ?? undefined,
      approval: { action, version: (updated.aiMetadata as { approval?: { version?: number } }).approval?.version, hash },
      // The chain back to why it exists — for analytics (lib/trace.ts).
      ...(to === 'APPROVED' || to === 'PUBLISHED' ? { trace: traceAudit(updated) } : {}),
      ...(review
        ? {
            review: review.status,
            reviewScore: review.score,
            reviewFailed: review.failed,
            reviewAcknowledgedByApprover: to === 'APPROVED' && review.status === 'review_required',
          }
        : {}),
      ...(factCheck
        ? {
            factCheck: factCheck.status,
            claimsReviewedByApprover:
              factCheck.status === 'needs_review' ? claimsToReview(factCheck).length : 0,
          }
        : {}),
    },
    ...requestMeta,
  });
  // Approval → Execution handoff (lib/execution-handoff.ts): prepared on
  // approval; leaving approval supersedes it. Best effort — never fails this.
  if (to === 'APPROVED' || draft.status === 'APPROVED') {
    const { refreshExecutionHandoff } = await import('@/server/execution/execution-handoff.service');
    await refreshExecutionHandoff({ companyId, draftId: draft.id, userId });
  }
  return updated;
}

/** Bulk transition (used by the queue's multi-select). Returns per-id results. */
export async function bulkTransition(args: {
  companyId: string;
  userId: string;
  draftIds: string[];
  to: ContentStatus;
  reason?: string;
  role?: CompanyRole;
  /**
   * Stop starting new items after this (each approval runs the reviewer and
   * fact check). Items not reached are returned as `notProcessed` — nothing
   * half-done, and retrying them is safe (approving twice is refused).
   */
  deadline?: number;
}): Promise<{ ok: string[]; failed: Array<{ id: string; error: string; code?: string }>; notProcessed: string[] }> {
  const ok: string[] = [];
  const failed: Array<{ id: string; error: string; code?: string }> = [];
  const notProcessed: string[] = [];
  for (const id of args.draftIds) {
    if (args.deadline && Date.now() > args.deadline) {
      notProcessed.push(id);
      continue;
    }
    try {
      await transition({ ...args, draftId: id });
      ok.push(id);
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      failed.push({ id, error: err instanceof Error ? err.message : 'failed', ...(typeof code === 'string' ? { code } : {}) });
    }
  }
  if (failed.length || notProcessed.length) {
    logger.warn('content: bulk transition left items unchanged', {
      companyId: args.companyId,
      to: args.to,
      failed: failed.map((f) => f.code ?? 'error'),
      notProcessed: notProcessed.length,
    });
  }
  return { ok, failed, notProcessed };
}

/**
 * Manual edit of a draft's body (validated per type). Editing an APPROVED draft
 * sends it back to DRAFT (re-approval required); PUBLISHED drafts are immutable.
 */
export async function updateDraftBody(args: {
  companyId: string;
  userId: string;
  draftId: string;
  title?: string;
  body: unknown;
  /** How this version came about (default: a person's edit). */
  versionSource?: VersionSource;
  /** For a restore: the version brought back. */
  basedOn?: number | null;
  /** The draft's updatedAt the edit was made on (the editor sends it). */
  baseUpdatedAt?: string | null;
}): Promise<ContentDraft> {
  const draft = await loadOwned(args.companyId, args.draftId);
  if (draft.status === 'PUBLISHED') {
    throw Object.assign(new Error('Published content cannot be edited.'), {
      status: 409,
    });
  }
  // Edited on a version that has since changed (another person, a rewrite):
  // refused, never silently overwriting — the caller keeps the edits.
  if (args.baseUpdatedAt && draft.updatedAt.toISOString() !== args.baseUpdatedAt) {
    throw Object.assign(
      new Error('This draft changed since you opened it. Your edits are kept here — reload to see the new version, then apply them again.'),
      { status: 409, code: 'stale' },
    );
  }
  const body = bodySchemaFor(draft.type as ContentTypeKey).parse(args.body);
  const nextStatus: ContentStatus =
    draft.status === 'APPROVED' ? 'DRAFT' : draft.status;
  // A person's edit is re-checked against the same rules (it can fix — or
  // introduce — a compliance problem), and is undoable like any rewrite.
  const quality = await assessDraft(draft, body);
  const meta = (draft.aiMetadata ?? {}) as Record<string, unknown>;
  const history = [
    { body: draft.body, at: new Date().toISOString(), before: 'edit' },
    ...((Array.isArray(meta.history) ? meta.history : []) as unknown[]),
  ].slice(0, HISTORY_LIMIT);

  // The edit is recorded: the version moves on and the previous text is kept.
  // An approved piece is reopened, never changed while approved.
  const media = await contentMedia(draft.id);
  // Only onto the version read above: a write that landed meanwhile makes
  // this fail (P2025), answered as a conflict below — never lost silently.
  const updated = await db.contentDraft
    .update({
    where: { id: draft.id, updatedAt: draft.updatedAt },
    data: {
      body: body as object,
      title: args.title ?? draft.title,
      status: nextStatus,
      // A new version (the person's edit, or a restored one); nothing earlier is lost.
      aiMetadata: withContentVersion(
        draft,
        contentMetaAfter(
          { ...draft, aiMetadata: { ...meta, quality, history } as unknown as Prisma.JsonValue },
          contentFingerprint({ body: draft.body, platform: draft.platform, media }),
          {
            action: 'edited',
            by: args.userId,
            nextStatus,
            nextHash: contentFingerprint({ body, platform: draft.platform, media }),
            previous: draft.body,
            note:
              args.versionSource === 'restored'
                ? `Restored version ${args.basedOn}${draft.status === 'APPROVED' ? ' — it needs approving again.' : ''}`
                : draft.status === 'APPROVED'
                  ? 'Edited after approval — it needs approving again.'
                  : null,
          },
        ),
        {
          body,
          source: args.versionSource ?? 'edited',
          by: args.userId,
          basedOn: args.basedOn ?? null,
          note: args.versionSource === 'restored' ? `Restored from version ${args.basedOn}` : null,
        },
      ),
    },
  })
    .catch((err: unknown) => {
      if ((err as { code?: string })?.code === 'P2025') {
        throw Object.assign(
          new Error('Someone changed this draft at the same moment. Your edits are kept here — reload, then apply them again.'),
          { status: 409, code: 'concurrent_change' },
        );
      }
      throw err;
    });
  if (draft.status === 'APPROVED') await syncCampaignTask(draft.id, nextStatus);
  // An approved post edited back to a draft: its execution is cancelled.
  if (draft.status === 'APPROVED') {
    const { refreshExecutionHandoff } = await import('@/server/execution/execution-handoff.service');
    await refreshExecutionHandoff({ companyId: args.companyId, draftId: draft.id, userId: args.userId });
  }
  await recordAudit({
    action: 'CONTENT_CHANGES_REQUESTED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: { draftId: draft.id, edited: true },
  });
  return updated;
}

/** Schedule an APPROVED draft for future publish (idempotent job picks it up). */
export async function scheduleDraft(args: {
  companyId: string;
  userId: string;
  draftId: string;
  scheduledFor: Date;
  /** The zone and wall time the person picked (server/scheduling/schedule-input.ts). */
  timeZone?: string;
  local?: string | null;
}): Promise<ContentDraft> {
  const draft = await loadOwned(args.companyId, args.draftId);
  if (isCopyOnlyType(draft.type as ContentTypeKey)) {
    throw Object.assign(
      new Error(
        'Email and ad copy are sent from your email tool or ad manager, not published by Aura — copy it out instead.',
      ),
      { status: 409 },
    );
  }
  if (draft.status !== 'APPROVED') {
    throw Object.assign(
      new Error('Only approved content can be scheduled.'),
      { status: 409 },
    );
  }
  // Only what was approved is scheduled.
  await assertContentIntact(draft);
  const hash = await contentHash(draft);
  const updated = await db.contentDraft.update({
    where: { id: draft.id },
    data: {
      scheduledFor: args.scheduledFor,
      aiMetadata: contentMetaAfter(draft, hash, {
        action: 'scheduled',
        by: args.userId,
        nextStatus: draft.status,
        nextScheduledFor: args.scheduledFor,
        nextHash: hash,
      }),
    },
  });
  await recordAudit({
    action: 'CONTENT_SCHEDULED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: {
      draftId: draft.id,
      scheduledFor: args.scheduledFor.toISOString(),
      ...(args.timeZone ? { timeZone: args.timeZone, local: args.local ?? null } : {}),
    },
  });
  // The zone and wall time stay with the execution; then the execution handoff
  // carries the scheduled time (and the execution becomes Scheduled).
  if (args.timeZone) {
    const { noteSchedule } = await import('@/server/execution/engine.service');
    await noteSchedule({ companyId: args.companyId, draftId: draft.id, timeZone: args.timeZone, local: args.local ?? null });
  }
  const { refreshExecutionHandoff } = await import('@/server/execution/execution-handoff.service');
  await refreshExecutionHandoff({ companyId: args.companyId, draftId: draft.id, userId: args.userId });
  return updated;
}

/**
 * Push a composed post into the existing queue.
 *
 * "Add to queue" in the composer means: this post — its copy, its graphic, its
 * platform and its time — is ready for a human to sign off. So it sets the
 * target platform and the scheduled time, then moves the draft to
 * PENDING_APPROVAL.
 *
 * It deliberately does NOT approve anything. The approval gate is the product's
 * trust backbone (nothing publishes without a human Approve), and a convenience
 * action that quietly walked around it would be the single most damaging change
 * that could be made here. `runScheduledPublishes()` still only ever picks up
 * APPROVED drafts, so a queued-but-unapproved post waits for a person.
 *
 * Already-APPROVED drafts keep their status — re-queueing to adjust the time
 * must not force a second approval round.
 */
export async function queueDraft(args: {
  companyId: string;
  userId: string;
  draftId: string;
  platform?: SocialPlatform;
  scheduledFor?: Date;
  timeZone?: string;
  local?: string | null;
}): Promise<ContentDraft> {
  const draft = await loadOwned(args.companyId, args.draftId);
  if (draft.status === 'PUBLISHED') {
    throw Object.assign(
      new Error('This post has already been published.'),
      { status: 409 },
    );
  }

  const data: Prisma.ContentDraftUpdateInput = {};
  if (args.platform) data.platform = args.platform;
  if (args.scheduledFor) data.scheduledFor = args.scheduledFor;

  // DRAFT and REJECTED both mean "not yet in front of a reviewer"; queueing is
  // what puts them there. APPROVED stays APPROVED — unless the network
  // changes: approval covers where it goes, so a new network needs a new one.
  const retargeted = Boolean(args.platform && args.platform !== draft.platform);
  const needsReview =
    draft.status === 'DRAFT' || draft.status === 'REJECTED' || (draft.status === 'APPROVED' && retargeted);
  if (needsReview) {
    data.status = 'PENDING_APPROVAL';
    data.rejectionReason = null;
  }
  if (draft.status === 'APPROVED' && !retargeted) await assertContentIntact(draft);
  const media = await contentMedia(draft.id);
  const before = contentFingerprint({ body: draft.body, platform: draft.platform, media });
  data.aiMetadata = contentMetaAfter(draft, before, {
    action: retargeted ? 'retargeted' : needsReview ? 'submitted' : 'scheduled',
    by: args.userId,
    nextStatus: (data.status as ContentStatus | undefined) ?? draft.status,
    nextScheduledFor: args.scheduledFor ?? draft.scheduledFor,
    nextHash: contentFingerprint({ body: draft.body, platform: args.platform ?? draft.platform, media }),
    ...(retargeted ? { previous: { platform: draft.platform } } : {}),
    note: retargeted && draft.status === 'APPROVED' ? 'The network changed after approval — it needs approving again.' : null,
  });
  if (retargeted && draft.status === 'APPROVED') await syncCampaignTask(draft.id, 'PENDING_APPROVAL');

  const updated = await db.contentDraft.update({
    where: { id: draft.id },
    data,
  });

  if (args.scheduledFor && args.timeZone) {
    const { noteSchedule } = await import('@/server/execution/engine.service');
    await noteSchedule({ companyId: args.companyId, draftId: draft.id, timeZone: args.timeZone, local: args.local ?? null });
  }
  // An approved post given a time: its execution becomes Scheduled.
  if (updated.status === 'APPROVED' && args.scheduledFor) {
    const { refreshExecutionHandoff } = await import('@/server/execution/execution-handoff.service');
    await refreshExecutionHandoff({ companyId: args.companyId, draftId: draft.id, userId: args.userId });
  }

  await recordAudit({
    action: 'CONTENT_QUEUED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: {
      draftId: draft.id,
      platform: updated.platform ?? undefined,
      scheduledFor: updated.scheduledFor?.toISOString(),
      from: draft.status,
      to: updated.status,
    },
  });
  return updated;
}

/**
 * Set a draft's target platform on its own (the composer's platform selector).
 *
 * Kept separate from queueDraft so switching platform to preview a different
 * format does not push the post into review as a side effect.
 */
export async function setDraftPlatform(args: {
  companyId: string;
  userId: string;
  draftId: string;
  platform: SocialPlatform;
}): Promise<ContentDraft> {
  const draft = await loadOwned(args.companyId, args.draftId);
  if (draft.status === 'PUBLISHED') {
    throw Object.assign(
      new Error('Published content cannot be retargeted.'),
      { status: 409 },
    );
  }
  if (draft.platform === args.platform) return draft;
  // Approval covers where a post goes: retargeting approved work reopens it.
  const { reopened } = await recordContentChange({
    draftId: draft.id,
    companyId: args.companyId,
    by: args.userId,
    action: 'retargeted',
    previous: { platform: draft.platform },
    apply: async (tx) => {
      await tx.contentDraft.update({ where: { id: draft.id }, data: { platform: args.platform } });
    },
  });
  if (reopened) {
    await recordAudit({
      action: 'CONTENT_CHANGES_REQUESTED',
      userId: args.userId,
      companyId: args.companyId,
      metadata: { draftId: draft.id, retargeted: { from: draft.platform, to: args.platform }, reopened: true },
    });
  }
  return (await db.contentDraft.findUnique({ where: { id: draft.id } }))!;
}

// ---- Publish guard (the hard gate) -----------------------------------------

/** Throws unless the draft is APPROVED. Every publish path MUST call this. */
export function assertPublishable(draft: ContentDraft): void {
  if (draft.status !== 'APPROVED') {
    throw new InvalidTransitionError(draft.status, 'PUBLISHED');
  }
}

/** Mark an approved draft published. Internal — called only after a real publish. */
export async function markPublished(args: {
  companyId: string;
  userId: string | null;
  draftId: string;
  publishedUrl: string | null;
}): Promise<ContentDraft> {
  const draft = await loadOwned(args.companyId, args.draftId);
  assertPublishable(draft); // never publish an unapproved draft, even internally
  await assertContentIntact(draft); // …or one changed since it was approved
  const hash = await contentHash(draft);
  const updated = await db.contentDraft.update({
    where: { id: draft.id },
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      publishedUrl: args.publishedUrl,
      aiMetadata: contentMetaAfter(draft, hash, {
        action: 'executed',
        by: args.userId,
        nextStatus: 'PUBLISHED',
        nextHash: hash,
        note: args.publishedUrl,
      }),
    },
  });
  await recordAudit({
    action: 'CONTENT_PUBLISHED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: { draftId: draft.id, publishedUrl: args.publishedUrl ?? undefined, trace: traceAudit(updated) },
  });
  const { markHandoffExecuted } = await import('@/server/execution/execution-handoff.service');
  await markHandoffExecuted(args.companyId, draft.id);
  return updated;
}

// ---- Queries ---------------------------------------------------------------

/**
 * The board is capped rather than unbounded.
 *
 * Content Studio renders every draft a workspace has ever produced, newest
 * first. That is fine at fifty rows and quietly ruinous at five thousand: the
 * query grows without limit, every row's full JSON `body` crosses the wire
 * from Postgres, and all of it is serialised into the RSC payload the browser
 * must download and hydrate — so the page gets slower every week the product
 * is used. A workspace with more drafts than this has a pagination problem to
 * solve properly; it should not pay for that with a frozen tab in the
 * meantime.
 */
const DRAFT_BOARD_LIMIT = 200;

export async function listDrafts(
  companyId: string,
  filter?: { status?: ContentStatus },
) {
  return db.contentDraft.findMany({
    where: { companyId, ...(filter?.status ? { status: filter.status } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: DRAFT_BOARD_LIMIT,
    // Explicit column list, not the implicit select-all an `include` gives.
    // The board uses eleven fields; fetching and deserialising the rest
    // (rejectionReason, publishedUrl, createdById, …) only to discard them is
    // pure cost on the widest query in the app.
    select: {
      id: true,
      type: true,
      status: true,
      title: true,
      body: true,
      aiMetadata: true,
      platform: true,
      scheduledFor: true,
      updatedAt: true,
      campaign: { select: { id: true, name: true } },
      // Attached-media COUNT, not the media itself: the board only needs to
      // show whether a post has a graphic, and one aggregate beats a per-card
      // query on a page that lists every draft in the workspace.
      _count: { select: { media: true } },
    },
  });
}

export async function getDraft(companyId: string, draftId: string) {
  return db.contentDraft.findFirst({ where: { id: draftId, companyId } });
}

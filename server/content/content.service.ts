import type {
  AuditAction,
  ContentDraft,
  ContentStatus,
  Prisma,
  SocialPlatform,
} from '@prisma/client';
import { db } from '@/lib/db';
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
}: TransitionArgs): Promise<ContentDraft> {
  const draft = await loadOwned(companyId, draftId);
  if (!isValidTransition(draft.status, to)) {
    throw new InvalidTransitionError(draft.status, to);
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

  const data: Prisma.ContentDraftUpdateInput = { status: to };
  if (factCheck) {
    // What was checked when it was approved, and whether a person vouched
    // for what Aura could not verify.
    data.aiMetadata = {
      ...((draft.aiMetadata ?? {}) as object),
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

  const updated = await db.contentDraft.update({ where: { id: draft.id }, data });

  await recordAudit({
    action: ACTION_FOR[to] ?? 'CONTENT_DRAFT_CREATED',
    userId,
    companyId,
    metadata: {
      draftId: draft.id,
      from: draft.status,
      to,
      reason: reason ?? undefined,
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
  return updated;
}

/** Bulk transition (used by the queue's multi-select). Returns per-id results. */
export async function bulkTransition(args: {
  companyId: string;
  userId: string;
  draftIds: string[];
  to: ContentStatus;
  reason?: string;
}): Promise<{ ok: string[]; failed: Array<{ id: string; error: string }> }> {
  const ok: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of args.draftIds) {
    try {
      await transition({ ...args, draftId: id });
      ok.push(id);
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : 'failed' });
    }
  }
  return { ok, failed };
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
}): Promise<ContentDraft> {
  const draft = await loadOwned(args.companyId, args.draftId);
  if (draft.status === 'PUBLISHED') {
    throw Object.assign(new Error('Published content cannot be edited.'), {
      status: 409,
    });
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

  const updated = await db.contentDraft.update({
    where: { id: draft.id },
    data: {
      body: body as object,
      title: args.title ?? draft.title,
      status: nextStatus,
      aiMetadata: {
        ...meta,
        quality,
        history,
      } as unknown as Prisma.InputJsonValue,
    },
  });
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
  const updated = await db.contentDraft.update({
    where: { id: draft.id },
    data: { scheduledFor: args.scheduledFor },
  });
  await recordAudit({
    action: 'CONTENT_SCHEDULED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: { draftId: draft.id, scheduledFor: args.scheduledFor.toISOString() },
  });
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
  // what puts them there. APPROVED stays APPROVED.
  const needsReview = draft.status === 'DRAFT' || draft.status === 'REJECTED';
  if (needsReview) {
    data.status = 'PENDING_APPROVAL';
    data.rejectionReason = null;
  }

  const updated = await db.contentDraft.update({
    where: { id: draft.id },
    data,
  });

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
  return db.contentDraft.update({
    where: { id: draft.id },
    data: { platform: args.platform },
  });
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
  const updated = await db.contentDraft.update({
    where: { id: draft.id },
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      publishedUrl: args.publishedUrl,
    },
  });
  await recordAudit({
    action: 'CONTENT_PUBLISHED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: { draftId: draft.id, publishedUrl: args.publishedUrl ?? undefined },
  });
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

import type { ContentDraft, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { approvalOf } from '@/lib/approval';
import {
  bodyHash as reviewBodyHash,
  type ContentReview,
} from '@/lib/content-review';
import type { CreationProvenance } from '@/lib/recommendation-creation';
import type { ContentBrief } from '@/lib/content-brief';
import {
  approvalId,
  briefId,
  newTraceId,
  reviewId,
  traceOf,
  type ContentTrace,
  type TraceIds,
  type TraceLink,
} from '@/lib/trace';
import { contentLog } from '@/server/versions/version.service';

/**
 * Recommendation → content traceability (lib/trace.ts) on stored drafts.
 */

type Meta = Record<string, unknown>;
type Provenance = Partial<CreationProvenance> & { id?: string; title?: string };

/** The signals behind a recommendation: its evidence, and its opportunity's. */
async function signalIdsFor(
  companyId: string,
  recommendationId: string | null,
  opportunityId: string | null,
): Promise<string[]> {
  // Scoped to the workspace through the parent, like every recommendation query.
  const [evidence, opp] = await Promise.all([
    recommendationId
      ? db.recommendationEvidence.findMany({
          where: { recommendationId, recommendation: { companyId }, signalId: { not: null } },
          select: { signalId: true },
        })
      : [],
    opportunityId
      ? db.opportunitySignal.findMany({
          where: { opportunityId, opportunity: { companyId }, signalId: { not: null } },
          select: { signalId: true },
        })
      : [],
  ]);
  return [
    ...new Set([...evidence, ...opp].map((r) => r.signalId!).filter(Boolean)),
  ];
}

/** The chain's ids for a newly generated asset. */
export async function initialTrace(args: {
  companyId: string;
  recommendation: {
    id: string;
    provenance?: Provenance | null;
    brief?: unknown;
  } | null;
  contextRevision: string | null;
}): Promise<TraceIds> {
  const rec = args.recommendation;
  const recRow = rec
    ? await db.recommendation.findFirst({
        where: { id: rec.id, companyId: args.companyId },
        select: { opportunityId: true, contextFields: true },
      })
    : null;
  const opportunityId =
    rec?.provenance?.opportunityId ??
    (rec?.brief as { opportunity?: { id?: string } } | null)?.opportunity?.id ??
    recRow?.opportunityId ??
    null;
  return {
    model: 1,
    traceId: newTraceId(),
    businessContext: {
      revision: args.contextRevision,
      fields: recRow?.contextFields ?? [],
    },
    signalIds: await signalIdsFor(args.companyId, rec?.id ?? null, opportunityId),
    opportunityId,
    recommendationId: rec?.id ?? null,
    briefId: briefId(rec?.brief ?? null),
    generatedVersion: 1,
    reviewedVersion: null,
    reviewId: null,
    approvedVersion: null,
    approvalId: null,
    mediaAssetIds: [],
  };
}

/** The trace of a draft — derived from its provenance if it predates traces. */
export function traceFor(
  draft: Pick<ContentDraft, 'id' | 'aiMetadata'>,
): TraceIds {
  const meta = (draft.aiMetadata ?? {}) as Meta;
  const existing = traceOf(meta);
  if (existing) return existing;
  const p = (meta.recommendation ?? null) as Provenance | null;
  const brief = (meta.brief ?? null) as Partial<ContentBrief> | null;
  return {
    model: 1,
    traceId: `trc_${draft.id}`,
    businessContext: {
      revision: (meta.contextRevision as string | null) ?? null,
      fields: [],
    },
    signalIds: [],
    opportunityId: p?.opportunityId ?? brief?.opportunity?.id ?? null,
    recommendationId: p?.recommendationId ?? p?.id ?? null,
    briefId: briefId(brief),
    generatedVersion: 1,
    reviewedVersion: null,
    reviewId: null,
    approvedVersion: null,
    approvalId: null,
    mediaAssetIds: [],
  };
}

/** Which version a review was of. */
function reviewedVersionOf(
  draft: Pick<ContentDraft, 'aiMetadata' | 'body' | 'createdAt' | 'status'>,
  review: ContentReview,
): number | null {
  const v = [...contentLog(draft).versions]
    .reverse()
    .find((x) => reviewBodyHash(x.body) === review.bodyHash);
  return v?.n ?? null;
}

/** `meta` with the trace moved on to a new review. */
export function withReviewTrace(
  draft: Pick<
    ContentDraft,
    'id' | 'aiMetadata' | 'body' | 'createdAt' | 'status'
  >,
  meta: Meta,
  review: ContentReview,
): Meta {
  const base = { ...draft, aiMetadata: meta as Prisma.JsonValue };
  return {
    ...meta,
    trace: {
      ...traceFor(base),
      reviewedVersion: reviewedVersionOf(base, review),
      reviewId: reviewId(review.bodyHash, review.reviewedAt),
    },
  };
}

/**
 * `meta` with the approval identified (approval.approved.id) and the trace
 * pointing at the approved version, its approval, its images and the review
 * it passed.
 */
export function withApprovalTrace(
  draft: Pick<
    ContentDraft,
    'id' | 'aiMetadata' | 'body' | 'createdAt' | 'status'
  >,
  meta: unknown,
  mediaAssetIds: string[],
): Prisma.InputJsonValue {
  const m = { ...((meta ?? {}) as Meta) };
  const approval = approvalOf(m);
  const versions = contentLog({ ...draft, aiMetadata: m as Prisma.JsonValue });
  const approvedVersion = versions.approved?.n ?? versions.current;
  const id = approval?.approved
    ? approvalId(draft.id, approvedVersion, approval.approved.at)
    : null;
  if (approval?.approved && id)
    m.approval = { ...approval, approved: { ...approval.approved, id } };
  const review = (m.review ?? null) as ContentReview | null;
  const base = { ...draft, aiMetadata: m as Prisma.JsonValue };
  m.trace = {
    ...traceFor(base),
    approvedVersion,
    approvalId: id,
    mediaAssetIds,
    ...(review
      ? {
          reviewedVersion: reviewedVersionOf(base, review),
          reviewId: reviewId(review.bodyHash, review.reviewedAt),
        }
      : {}),
  };
  return m as unknown as Prisma.InputJsonValue;
}

/** The ids, flat, for an audit entry or analytics. */
export function traceAudit(draft: Pick<ContentDraft, 'id' | 'aiMetadata'>) {
  const t = traceFor(draft);
  return {
    traceId: t.traceId,
    recommendationId: t.recommendationId,
    opportunityId: t.opportunityId,
    briefId: t.briefId,
    approvalId: t.approvalId,
    approvedVersion: t.approvedVersion,
  };
}

// ---------------------------------------------------------------------------
// Resolving the chain
// ---------------------------------------------------------------------------

/**
 * The full story of an asset: why it exists, which recommendation and
 * opportunity led to it, the signals and business context behind them, and
 * which version was reviewed and approved. Live records where they still
 * exist; the snapshot on the asset where they do not.
 */
export async function resolveTrace(
  companyId: string,
  draftId: string,
): Promise<ContentTrace | null> {
  const draft = await db.contentDraft.findFirst({
    where: { id: draftId, companyId },
    include: {
      media: { orderBy: { position: 'asc' }, select: { assetId: true } },
    },
  });
  if (!draft) return null;
  const meta = (draft.aiMetadata ?? {}) as Meta;
  const ids = traceFor(draft);
  const p = (meta.recommendation ?? null) as Provenance | null;
  const brief = (meta.brief ?? null) as Partial<ContentBrief> | null;
  const source = (meta.source ?? {}) as { brief?: string | null };
  const review = (meta.review ?? null) as ContentReview | null;
  const approval = approvalOf(meta);
  const log = contentLog(draft);
  const gaps: TraceLink[] = [];

  const [rec, opp, signalRows, company] = await Promise.all([
    ids.recommendationId
      ? db.recommendation.findFirst({
          where: { id: ids.recommendationId, companyId },
          select: {
            id: true,
            title: true,
            rationale: true,
            status: true,
            decidedAt: true,
            decidedById: true,
          },
        })
      : null,
    ids.opportunityId
      ? db.opportunity.findFirst({
          where: { id: ids.opportunityId, companyId },
          select: {
            id: true,
            title: true,
            type: true,
            summary: true,
            detectedAt: true,
          },
        })
      : null,
    ids.signalIds.length
      ? db.signal.findMany({
          where: { id: { in: ids.signalIds }, companyId },
          select: {
            id: true,
            title: true,
            source: true,
            observedAt: true,
            url: true,
          },
        })
      : [],
    db.company.findUnique({ where: { id: companyId }, select: { name: true } }),
  ]);
  const people = [rec?.decidedById, approval?.approved?.by].filter(
    (x): x is string => Boolean(x),
  );
  const users = people.length
    ? await db.user.findMany({
        where: { id: { in: people } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const nameOf = (id: string | null | undefined) =>
    id
      ? (users.find((u) => u.id === id)?.name ??
        users.find((u) => u.id === id)?.email ??
        'A former member')
      : null;

  const fromRecommendation = Boolean(ids.recommendationId);
  if (fromRecommendation && !rec) gaps.push('recommendation');
  if (ids.opportunityId && !opp) gaps.push('opportunity');
  if (fromRecommendation && !ids.signalIds.length) gaps.push('signal');

  const reviewed = review
    ? {
        version: ids.reviewedVersion ?? reviewedVersionOf(draft, review),
        id: ids.reviewId ?? reviewId(review.bodyHash, review.reviewedAt),
        status: review.status,
        at: review.reviewedAt,
      }
    : null;
  const approved = approval?.approved
    ? {
        version: ids.approvedVersion ?? log.approved?.n ?? null,
        id: ids.approvalId ?? approval.approved.id ?? null,
        by:
          approval.approved.via === 'autopilot'
            ? 'Autopilot'
            : nameOf(approval.approved.by),
        via: approval.approved.via,
        at: approval.approved.at,
      }
    : null;

  return {
    ids: {
      ...ids,
      assetId: draft.id,
      mediaAssetIds: ids.mediaAssetIds.length
        ? ids.mediaAssetIds
        : draft.media.map((m) => m.assetId),
    },
    why:
      rec?.rationale ??
      p?.why ??
      brief?.reason?.why ??
      (source.brief ? `Requested: ${source.brief}` : null),
    origin: fromRecommendation ? 'recommendation' : 'brief',
    businessContext: {
      revision: ids.businessContext.revision,
      name:
        brief?.businessContext?.name ??
        p?.business?.name ??
        company?.name ??
        null,
      description:
        brief?.businessContext?.description ?? p?.business?.description ?? null,
      fields: ids.businessContext.fields,
    },
    signals: signalRows.map((s) => ({
      id: s.id,
      title: s.title,
      source: s.source,
      observedAt: s.observedAt?.toISOString() ?? null,
      url: s.url,
    })),
    opportunity: opp
      ? {
          id: opp.id,
          title: opp.title,
          type: opp.type,
          summary: opp.summary,
          detectedAt: opp.detectedAt.toISOString(),
          href: `/dashboard/opportunities?focus=${opp.id}`,
        }
      : null,
    recommendation: rec
      ? {
          id: rec.id,
          title: rec.title,
          why: rec.rationale,
          status: rec.status,
          decidedAt: rec.decidedAt?.toISOString() ?? null,
          decidedBy: nameOf(rec.decidedById),
        }
      : p?.title && ids.recommendationId
        ? {
            id: ids.recommendationId,
            title: p.title,
            why: p.why ?? null,
            status: null,
            decidedAt: null,
            decidedBy: null,
          }
        : null,
    brief:
      brief || source.brief
        ? {
            id: ids.briefId,
            keyMessage:
              (brief?.keyMessage?.value as string | undefined) ?? null,
            goal: (brief?.marketingGoal?.value as string | undefined) ?? null,
            audience:
              (brief?.targetAudience?.value as string | undefined) ?? null,
            channel: (brief?.channel?.name as string | undefined) ?? null,
            request: source.brief ?? null,
          }
        : null,
    asset: {
      id: draft.id,
      type: draft.type,
      platform: draft.platform,
      status: draft.status,
      createdAt: draft.createdAt.toISOString(),
      mediaAssetIds: draft.media.map((m) => m.assetId),
    },
    generated: {
      version: 1,
      at:
        log.versions.find((v) => v.n === 1)?.at ??
        draft.createdAt.toISOString(),
    },
    reviewed,
    approved,
    published: draft.publishedAt
      ? { url: draft.publishedUrl, at: draft.publishedAt.toISOString() }
      : null,
    gaps,
  };
}

/** For analytics and measurement: every approved or published asset's chain ids, flat. */
export async function traceRows(
  companyId: string,
  opts: { since?: Date; limit?: number } = {},
) {
  const drafts = await db.contentDraft.findMany({
    where: {
      companyId,
      status: { in: ['APPROVED', 'PUBLISHED'] },
      ...(opts.since ? { updatedAt: { gte: opts.since } } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(opts.limit ?? 200, 500),
    select: {
      id: true,
      aiMetadata: true,
      status: true,
      type: true,
      platform: true,
      publishedAt: true,
      publishedUrl: true,
      performanceSnapshots: { select: { id: true } },
    },
  });
  return drafts.map((d) => {
    const t = traceFor(d);
    const approval = approvalOf(d.aiMetadata);
    return {
      assetId: d.id,
      traceId: t.traceId,
      status: d.status,
      type: d.type,
      platform: d.platform,
      businessContextRevision: t.businessContext.revision,
      signalIds: t.signalIds,
      opportunityId: t.opportunityId,
      recommendationId: t.recommendationId,
      briefId: t.briefId,
      generatedVersion: t.generatedVersion,
      reviewedVersion: t.reviewedVersion,
      reviewId: t.reviewId,
      approvedVersion: t.approvedVersion,
      approvalId: t.approvalId ?? approval?.approved?.id ?? null,
      approvedAt: approval?.approved?.at ?? null,
      mediaAssetIds: t.mediaAssetIds,
      publishedAt: d.publishedAt?.toISOString() ?? null,
      publishedUrl: d.publishedUrl,
      performanceSnapshotIds: d.performanceSnapshots.map((s) => s.id),
    };
  });
}

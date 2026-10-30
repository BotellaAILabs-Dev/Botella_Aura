import { offeringsSummary } from '@/lib/products';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { NOT_MIRRORED } from '@/lib/connection-manager';
import { logger } from '@/lib/logger';
import {
  SNAPSHOT_TTL_MS,
  SNAPSHOT_VERSION,
  snapshotSchema,
  type BusinessContextSnapshot,
  type RefreshReason,
  type SnapshotView,
} from '@/lib/business-context-snapshot';
import { retrieve } from '@/server/knowledge/retrieve';
import { getBusinessContext } from './business-context.service';
import { buildSnapshot, snapshotToPrompt, viewSnapshot } from './snapshot';

/**
 * Serving Business Context Snapshots to AI workflows.
 *
 *   const { snapshot, prompt } = await getContextSnapshot(companyId, { view: 'content' });
 *
 * REFRESH BEHAVIOUR
 * -----------------
 * One snapshot is stored per workspace (the full view; workflow views are cut
 * from it on read). A read rebuilds it when:
 *
 *   missing          — never built;
 *   version          — the snapshot format changed in a deploy;
 *   sources_changed  — the source stamp no longer matches (below);
 *   expired          — older than SNAPSHOT_TTL_MS, because freshness and
 *                      staleness depend on today's date, not only on edits;
 *   invalidated      — a writer the stamp cannot see asked for a rebuild;
 *   forced           — the caller asked (POST /api/business-context/snapshot).
 *
 * The SOURCE STAMP is a hash of the latest change time and row count of every
 * table the context reads. It costs one cheap aggregate per table, and it
 * catches edits, additions and deletions everywhere — including every write
 * through the Business Context service, which bumps Company.updatedAt — with
 * no hooks in the modules that own those tables. The one change it cannot see
 * is a memory insight's text being edited in place (MarketingMemory has no
 * updatedAt), so memory.service invalidates explicitly.
 *
 * The stamp is taken BEFORE building. If a source changes mid-build, the
 * stored stamp is already behind, so the next read rebuilds: a snapshot can be
 * briefly late, never silently wrong for longer than one read.
 */

export interface SnapshotOptions {
  view?: SnapshotView;
  /** Leave assumptions out entirely instead of listing them. */
  strict?: boolean;
  /** Rebuild even if the stored snapshot is current. */
  force?: boolean;
  now?: Date;
}

export interface SnapshotResult {
  snapshot: BusinessContextSnapshot;
  /** The snapshot rendered for a model. */
  prompt: string;
  /** Whether this read was served from the stored snapshot. */
  status: 'current' | 'rebuilt';
  reason?: RefreshReason;
}

/** Hash of the version of every source the context reads. */
export async function computeSourceStamp(
  companyId: string,
): Promise<string | null> {
  const [
    company,
    outreach,
    discovery,
    competitors,
    trend,
    plans,
    connections,
    linkedIn,
    chunks,
    memory,
    campaigns,
    content,
    analytics,
  ] = await Promise.all([
    db.company.findUnique({
      where: { id: companyId },
      select: { updatedAt: true },
    }),
    db.outreachConfig.findUnique({
      where: { companyId },
      select: { updatedAt: true },
    }),
    db.discoveryProfile.aggregate({
      where: { companyId, isActive: true },
      _max: { updatedAt: true },
      _count: { _all: true },
    }),
    db.competitorProfile.aggregate({
      where: { companyId },
      _max: { updatedAt: true },
      _count: { _all: true },
    }),
    db.companyTrendConfig.findUnique({
      where: { companyId },
      select: { updatedAt: true },
    }),
    db.marketingPlan.aggregate({
      where: { companyId },
      _max: { updatedAt: true },
      _count: { _all: true },
    }),
    db.connection.aggregate({
      where: { companyId, status: 'CONNECTED', ...NOT_MIRRORED },
      _max: { updatedAt: true },
      _count: { _all: true },
    }),
    db.linkedInConnection.findFirst({
      where: { companyId, status: 'ACTIVE' },
      select: { updatedAt: true },
    }),
    db.knowledgeChunk.aggregate({
      where: { companyId },
      _max: { createdAt: true },
      _count: { _all: true },
    }),
    db.marketingMemory.aggregate({
      where: { companyId, isActive: true },
      _max: { generatedAt: true },
      _count: { _all: true },
    }),
    db.campaign.aggregate({
      where: { companyId, status: { in: ['ACTIVE', 'PAUSED'] } },
      _max: { updatedAt: true },
      _count: { _all: true },
    }),
    db.contentDraft.aggregate({
      where: { companyId, status: { in: ['PUBLISHED', 'APPROVED'] } },
      _max: { updatedAt: true },
      _count: { _all: true },
    }),
    db.analyticsReport.aggregate({
      where: { companyId },
      _max: { generatedAt: true },
      _count: { _all: true },
    }),
  ]);
  if (!company) return null;
  // Connecting or losing a website changes which channels Aura can publish to.
  const websites = await db.websiteConnection.aggregate({
    where: { companyId, status: 'CONNECTED' },
    _max: { updatedAt: true },
    _count: { _all: true },
  });

  const t = (d: Date | null | undefined) => (d ? d.toISOString() : '-');
  const parts = [
    `company:${t(company.updatedAt)}`,
    `outreach:${t(outreach?.updatedAt)}`,
    `discovery:${t(discovery._max.updatedAt)}:${discovery._count._all}`,
    `competitors:${t(competitors._max.updatedAt)}:${competitors._count._all}`,
    `trend:${t(trend?.updatedAt)}`,
    `plans:${t(plans._max.updatedAt)}:${plans._count._all}`,
    `connections:${t(connections._max.updatedAt)}:${connections._count._all}`,
    `linkedin:${t(linkedIn?.updatedAt)}`,
    `knowledge:${t(chunks._max.createdAt)}:${chunks._count._all}`,
    `memory:${t(memory._max.generatedAt)}:${memory._count._all}`,
    `campaigns:${t(campaigns._max.updatedAt)}:${campaigns._count._all}`,
    `content:${t(content._max.updatedAt)}:${content._count._all}`,
    `analytics:${t(analytics._max.generatedAt)}:${analytics._count._all}`,
    // Only when there are any, so workspaces without websites keep their stamp.
    ...(websites._count._all ? [`websites:${t(websites._max.updatedAt)}:${websites._count._all}`] : []),
  ];
  return createHash('sha256')
    .update(parts.join('|'))
    .digest('hex')
    .slice(0, 24);
}

/** Decide whether a stored snapshot can be served. Pure, for testing. */
export function refreshReason(
  stored: {
    version: number;
    sourceStamp: string;
    generatedAt: Date;
    invalidatedAt: Date | null;
  } | null,
  currentStamp: string,
  now: Date,
  force = false,
): RefreshReason | null {
  if (force) return 'forced';
  if (!stored) return 'missing';
  if (stored.version !== SNAPSHOT_VERSION) return 'version';
  if (stored.invalidatedAt) return 'invalidated';
  if (stored.sourceStamp !== currentStamp) return 'sources_changed';
  if (now.getTime() - stored.generatedAt.getTime() > SNAPSHOT_TTL_MS)
    return 'expired';
  return null;
}

/**
 * The current Business Context Snapshot for a workflow.
 *
 * Returns null only for an unknown workspace. A stored snapshot that fails to
 * parse (written by an older build) is rebuilt rather than served.
 */
export async function getContextSnapshot(
  companyId: string,
  options: SnapshotOptions = {},
): Promise<SnapshotResult | null> {
  const now = options.now ?? new Date();
  const [stored, stamp] = await Promise.all([
    db.businessContextSnapshot.findUnique({ where: { companyId } }),
    computeSourceStamp(companyId),
  ]);
  if (!stamp) return null;

  let reason = refreshReason(stored, stamp, now, options.force);
  let full: BusinessContextSnapshot | null = null;

  if (!reason && stored) {
    const parsed = snapshotSchema.safeParse(stored.payload);
    if (parsed.success) full = parsed.data;
    else reason = 'version';
  }

  if (!full) {
    full = await rebuild(companyId, stamp, now);
    if (!full) return null;
  }

  const snapshot = viewSnapshot(
    full,
    options.view ?? 'full',
    options.strict ?? false,
  );
  return {
    snapshot,
    prompt: snapshotToPrompt(snapshot),
    status: reason ? 'rebuilt' : 'current',
    ...(reason ? { reason } : {}),
  };
}

/** Build the full snapshot from the live context and store it. */
async function rebuild(
  companyId: string,
  stamp: string,
  now: Date,
): Promise<BusinessContextSnapshot | null> {
  const ctx = await getBusinessContext(companyId);
  if (!ctx) return null;

  // Product evidence: what the business's own material says about what it
  // sells, retrieved against its own description of itself.
  const query = [
    offeringsSummary(ctx.identity),
    ctx.identity.description,
    ctx.identity.name,
  ]
    .filter(Boolean)
    .join(' ');
  const passages =
    ctx.knowledge.totalChunks > 0
      ? await retrieve(companyId, query, { limit: 12 })
      : [];

  const full = buildSnapshot(ctx, passages, now);
  const data = {
    version: SNAPSHOT_VERSION,
    fingerprint: full.fingerprint,
    sourceStamp: stamp,
    payload: full as unknown as Prisma.InputJsonObject,
    generatedAt: now,
    invalidatedAt: null,
  };
  await db.businessContextSnapshot.upsert({
    where: { companyId },
    create: { companyId, ...data },
    update: data,
  });
  return full;
}

/**
 * Ask for a rebuild on the next read. For writers whose changes the source
 * stamp cannot see. Best-effort: a failure here must never fail the write that
 * called it, and the TTL bounds how long a missed invalidation can last.
 */
export async function invalidateContextSnapshot(
  companyId: string,
): Promise<void> {
  try {
    await db.businessContextSnapshot.updateMany({
      where: { companyId },
      data: { invalidatedAt: new Date() },
    });
  } catch (err) {
    logger.warn(
      'business-context: snapshot invalidation failed (TTL will catch it)',
      {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

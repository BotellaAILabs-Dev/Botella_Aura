import type { PerformanceSource } from '@prisma/client';
import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import { engagementScore, type PerfMetrics } from '@/server/memory/metrics';
import { draftSnippet } from '@/lib/content-ui';
import { renderForManual } from '@/server/content/render';
import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * Performance data collection (Sprint 5, Module 2). Captures REAL metrics only:
 * from the extension's DOM read of the user's own post, or a manual entry.
 * LinkedIn API analytics are unavailable at our current scope — we never
 * fabricate; where there's no source, the UI shows "unavailable".
 */
interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Record metrics for a published post, matched to its ContentDraft by URL. */
export async function recordContentMetrics(args: {
  companyId: string;
  userId?: string | null;
  postUrl: string;
  metrics: PerfMetrics;
  source: PerformanceSource;
  requestMeta?: Meta;
}): Promise<{ matched: boolean; snapshotId: string }> {
  const { companyId, userId, postUrl, metrics, source, requestMeta } = args;

  const draft = await db.contentDraft.findFirst({
    where: { companyId, status: 'PUBLISHED', publishedUrl: postUrl },
    select: { id: true },
  });

  const snapshot = await db.performanceSnapshot.create({
    data: {
      companyId,
      contentDraftId: draft?.id ?? null,
      source,
      metrics: { ...metrics, postUrl } as unknown as object,
    },
  });

  await recordAudit({
    action: 'PERFORMANCE_SNAPSHOT_CAPTURED',
    userId: userId ?? null,
    companyId,
    metadata: { snapshotId: snapshot.id, matched: Boolean(draft), source },
    ...requestMeta,
  });

  return { matched: Boolean(draft), snapshotId: snapshot.id };
}

/** Update the manual outreach outcome (connection accepted / reply received). */
export async function setOutreachOutcome(args: {
  companyId: string;
  userId: string;
  messageId: string;
  connectionAccepted?: boolean;
  replyReceived?: boolean;
  requestMeta?: Meta;
}) {
  const { companyId, userId, messageId, connectionAccepted, replyReceived, requestMeta } = args;
  const existing = await db.outreachMessage.findFirst({
    where: { id: messageId, companyId },
  });
  if (!existing) throw Object.assign(new Error('Message not found.'), { status: 404 });

  const message = await db.outreachMessage.update({
    where: { id: messageId },
    data: {
      ...(connectionAccepted !== undefined ? { connectionAccepted } : {}),
      ...(replyReceived !== undefined ? { replyReceived } : {}),
    },
  });
  await recordAudit({
    action: 'OUTREACH_OUTCOME_UPDATED',
    userId,
    companyId,
    metadata: { messageId, connectionAccepted, replyReceived },
    ...requestMeta,
  });
  return message;
}

export interface ContentPerf {
  draftId: string;
  title: string;
  type: string;
  snippet: string;
  publishedAt: string | null;
  /** Approx word count of the rendered post (for length analysis). */
  wordCount: number;
  engagement: number;
  metrics: PerfMetrics;
}

/**
 * Published content with its latest real metrics snapshot, engagement-scored.
 * The single source for the dashboard trend + best/worst + extraction sample.
 */
export async function getContentPerformance(companyId: string): Promise<ContentPerf[]> {
  const snapshots = await db.performanceSnapshot.findMany({
    where: { companyId, contentDraftId: { not: null } },
    orderBy: { capturedAt: 'desc' },
    include: {
      contentDraft: {
        select: { id: true, title: true, type: true, body: true, publishedAt: true },
      },
    },
  });

  // Keep the latest snapshot per draft.
  const byDraft = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) {
    if (s.contentDraftId && !byDraft.has(s.contentDraftId)) byDraft.set(s.contentDraftId, s);
  }

  const out: ContentPerf[] = [];
  for (const s of byDraft.values()) {
    const d = s.contentDraft!;
    const metrics = (s.metrics ?? {}) as PerfMetrics;
    const rendered = renderForManual({ type: d.type, body: d.body } as never);
    out.push({
      draftId: d.id,
      title: d.title ?? draftSnippet(d.type as ContentTypeKey, d.body).slice(0, 60),
      type: d.type,
      snippet: draftSnippet(d.type as ContentTypeKey, d.body),
      publishedAt: d.publishedAt ? d.publishedAt.toISOString() : null,
      wordCount: rendered ? rendered.split(/\s+/).filter(Boolean).length : 0,
      engagement: engagementScore(metrics),
      metrics,
    });
  }
  return out;
}

/** Best/worst published posts by engagement (for the "wow" demo view). */
export function bestWorst(perf: ContentPerf[], n = 5) {
  const sorted = [...perf].sort((a, b) => b.engagement - a.engagement);
  return { best: sorted.slice(0, n), worst: sorted.slice(-n).reverse() };
}

/** Engagement over time for the trend chart (per published post, chronological). */
export function engagementTrend(perf: ContentPerf[]): { date: string; engagement: number }[] {
  return perf
    .filter((p) => p.publishedAt)
    .map((p) => ({ date: p.publishedAt!, engagement: p.engagement }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

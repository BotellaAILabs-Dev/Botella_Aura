import { db } from '@/lib/db';
import { ACTIVE_STATUSES } from '@/lib/opportunities';
import { toOpportunityView } from '@/lib/opportunity-ui';
import { LIVE_RECOMMENDATION_STATUSES } from '@/lib/recommendations';
import {
  buildWhatMatters,
  type Coverage,
  type MattersOpportunity,
  type MattersSignal,
  type WhatMatters,
} from '@/lib/what-matters';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import { listOpportunitiesForView } from '@/server/opportunities/opportunity.service';

/**
 * Loads "What matters now" (lib/what-matters.ts) from the Opportunity and
 * Signal models: the workspace's active opportunities with the signals they
 * were built from and their recommendation in play, its current signals with
 * the opportunity or recommendation that uses each, and what Aura has to go
 * on (topics followed, competitors tracked, result periods, goals).
 */
export async function getWhatMatters(
  companyId: string,
  now: Date = new Date(),
): Promise<WhatMatters> {
  const [
    oppRows,
    signalRows,
    trendConfig,
    competitorsTracked,
    resultPeriods,
    ctx,
  ] = await Promise.all([
    listOpportunitiesForView(companyId, { now, limit: 100 }),
    db.signal.findMany({
      where: {
        companyId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { lastSeenAt: 'desc' },
      take: 300,
      select: {
        id: true,
        source: true,
        title: true,
        summary: true,
        reliability: true,
        occurrences: true,
        strength: true,
        observedAt: true,
        expiresAt: true,
        lastSeenAt: true,
        contextMatches: true,
        metadata: true,
        opportunitySignals: {
          where: { opportunity: { status: { in: ACTIVE_STATUSES } } },
          select: { opportunityId: true },
          take: 1,
        },
        recommendationEvidence: {
          where: {
            recommendation: { status: { in: LIVE_RECOMMENDATION_STATUSES } },
          },
          select: {
            recommendation: {
              select: { id: true, title: true, status: true },
            },
          },
          take: 1,
        },
      },
    }),
    db.companyTrendConfig.findUnique({
      where: { companyId },
      select: { keywords: true },
    }),
    db.competitorProfile.count({ where: { companyId } }),
    db.analyticsReport.count({ where: { companyId } }),
    getBusinessContext(companyId).catch(() => null),
  ]);

  const active = oppRows.filter((o) => ACTIVE_STATUSES.includes(o.status));
  const recs = active.length
    ? await db.recommendation.findMany({
        where: {
          companyId,
          opportunityId: { in: active.map((o) => o.id) },
          status: { in: LIVE_RECOMMENDATION_STATUSES },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, title: true, status: true, opportunityId: true },
      })
    : [];
  const recOf = new Map<string, (typeof recs)[number]>();
  for (const r of recs)
    if (!recOf.has(r.opportunityId)) recOf.set(r.opportunityId, r);

  const opportunities: MattersOpportunity[] = active.map((row) => {
    const v = toOpportunityView(row, now);
    const rec = recOf.get(row.id);
    return {
      id: v.id,
      title: v.title,
      typeLabel: v.typeLabel,
      status: v.status,
      priority: v.priority,
      priorityScore: v.priorityScore,
      confidence: v.confidence,
      why: v.why[0] ?? v.summary,
      daysLeft: v.daysLeft,
      detectedAt: new Date(v.detectedAt),
      signalIds: row.signals
        .map((s) => s.signalId)
        .filter((x): x is string => Boolean(x)),
      recommendation: rec
        ? { id: rec.id, title: rec.title, status: rec.status }
        : null,
    };
  });

  const signals: MattersSignal[] = signalRows.map((s) => ({
    id: s.id,
    source: s.source,
    title: s.title,
    summary: s.summary,
    reliability: s.reliability,
    occurrences: s.occurrences,
    strength: s.strength,
    observedAt: s.observedAt,
    expiresAt: s.expiresAt,
    contextMatches: s.contextMatches,
    metadata:
      s.metadata && typeof s.metadata === 'object' && !Array.isArray(s.metadata)
        ? (s.metadata as Record<string, unknown>)
        : {},
    recommendation: s.recommendationEvidence[0]?.recommendation ?? null,
    opportunityId: s.opportunitySignals[0]?.opportunityId ?? null,
  }));

  const keywords = new Set([
    ...(trendConfig?.keywords ?? []),
    ...(ctx?.market.keywords ?? []),
  ]);
  const coverage: Coverage = {
    trendKeywords: keywords.size,
    competitorsTracked,
    resultPeriods,
    hasGoals: Boolean(ctx?.objectives.goals?.trim()),
    lastCollectedAt: signalRows.reduce<Date | null>(
      (latest, s) => (!latest || s.lastSeenAt > latest ? s.lastSeenAt : latest),
      null,
    ),
  };

  return buildWhatMatters({ opportunities, signals, coverage }, now);
}

import { offeringsSummary } from '@/lib/products';
import { db } from '@/lib/db';
import { assessReadiness, type Readiness } from '@/lib/data-readiness';
import { ACTIVE_STATUSES } from '@/lib/opportunities';
import { getBusinessContext } from '@/server/business-context/business-context.service';

/**
 * Data readiness for one workspace (lib/data-readiness.ts): the business
 * profile, what Aura watches, the current signals, the open opportunities and
 * the results it has — in a handful of counts.
 */
export async function getReadiness(
  companyId: string,
  now: Date = new Date(),
): Promise<Readiness> {
  const [
    ctx,
    trendConfig,
    competitors,
    currentSignals,
    active,
    low,
    reports,
    published,
  ] = await Promise.all([
    getBusinessContext(companyId, { sections: ['connections', 'market'] }),
    db.companyTrendConfig.findUnique({
      where: { companyId },
      select: { keywords: true },
    }),
    db.competitorProfile.count({ where: { companyId } }),
    db.signal.count({
      where: {
        companyId,
        source: { not: 'BUSINESS_CONTEXT' },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    }),
    db.opportunity.count({
      where: { companyId, status: { in: ACTIVE_STATUSES } },
    }),
    db.opportunity.count({
      where: { companyId, status: { in: ACTIVE_STATUSES }, confidence: 'LOW' },
    }),
    db.analyticsReport.count({ where: { companyId } }),
    db.contentDraft.count({ where: { companyId, status: 'PUBLISHED' } }),
  ]);
  const keywords = new Set([
    ...(trendConfig?.keywords ?? []),
    ...(ctx?.market.keywords ?? []),
  ]);
  return assessReadiness({
    business: {
      description: ctx?.identity.description ?? null,
      offerings: (ctx ? offeringsSummary(ctx.identity) : null),
      audience: ctx?.audience.stated ?? null,
      goals: ctx?.objectives.goals ?? null,
      channels: ctx?.channels.preferred ?? [],
      connected: ctx?.channels.connected ?? [],
    },
    sources: { trendKeywords: keywords.size, competitorsTracked: competitors },
    currentSignals,
    opportunities: { active, lowConfidence: low },
    results: { analyticsReports: reports, publishedPosts: published },
  });
}

import { db } from '@/lib/db';
import { getContentPerformance } from '@/server/memory/performance.service';

/**
 * Analytics aggregation (Sprint 6, Module 2). The client-presentable RESULTS
 * view (distinct from Marketing Memory's learnings). Every number reflects REAL
 * captured data (NON-NEGOTIABLE #2); ranges with no data report hasData:false so
 * the UI can show an honest "not enough data" state instead of a misleading zero
 * chart.
 */
export interface AnalyticsResult {
  range: { days: number; start: string; end: string };
  topline: {
    postsPublished: number;
    totalEngagement: number;
    outreachSent: number;
    connectionsMade: number;
    repliesReceived: number;
    leadsDiscovered: number;
    campaignsRun: number;
  };
  engagementTrend: { date: string; engagement: number }[];
  contentVolume: { date: string; count: number }[];
  funnel: { sent: number; connected: number; replied: number };
  channelBreakdown: { type: string; count: number; avgEngagement: number }[];
  hasData: boolean;
}

export async function getAnalytics(
  companyId: string,
  days = 30,
): Promise<AnalyticsResult> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);

  const [perfAll, publishedDrafts, outreach, leads, campaigns] = await Promise.all([
    getContentPerformance(companyId),
    db.contentDraft.findMany({
      where: { companyId, status: 'PUBLISHED', publishedAt: { gte: start, lte: end } },
      select: { id: true, type: true, publishedAt: true },
    }),
    db.outreachMessage.findMany({
      where: { companyId, status: 'SENT', sentAt: { gte: start, lte: end } },
      select: { connectionAccepted: true, replyReceived: true },
    }),
    db.lead.count({ where: { companyId, source: 'DISCOVERY_ENGINE', createdAt: { gte: start, lte: end } } }),
    db.campaign.count({ where: { companyId, createdAt: { gte: start, lte: end } } }),
  ]);

  // Performance for posts published within the range.
  const perf = perfAll.filter(
    (p) => p.publishedAt && new Date(p.publishedAt) >= start && new Date(p.publishedAt) <= end,
  );

  const totalEngagement = perf.reduce((sum, p) => sum + p.engagement, 0);
  const connectionsMade = outreach.filter((o) => o.connectionAccepted).length;
  const repliesReceived = outreach.filter((o) => o.replyReceived).length;

  // Engagement trend (per published post, chronological).
  const engagementTrend = perf
    .map((p) => ({ date: p.publishedAt!, engagement: p.engagement }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Content volume per day.
  const volMap = new Map<string, number>();
  for (const d of publishedDrafts) {
    if (!d.publishedAt) continue;
    const key = d.publishedAt.toISOString().slice(0, 10);
    volMap.set(key, (volMap.get(key) ?? 0) + 1);
  }
  const contentVolume = [...volMap.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Channel breakdown by content type.
  const byType = new Map<string, number[]>();
  for (const p of perf) {
    if (!byType.has(p.type)) byType.set(p.type, []);
    byType.get(p.type)!.push(p.engagement);
  }
  const channelBreakdown = [...byType.entries()].map(([type, vals]) => ({
    type,
    count: vals.length,
    avgEngagement: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
  }));

  const topline = {
    postsPublished: publishedDrafts.length,
    totalEngagement,
    outreachSent: outreach.length,
    connectionsMade,
    repliesReceived,
    leadsDiscovered: leads,
    campaignsRun: campaigns,
  };

  const hasData =
    topline.postsPublished > 0 ||
    topline.outreachSent > 0 ||
    topline.leadsDiscovered > 0 ||
    perf.length > 0;

  return {
    range: { days, start: start.toISOString(), end: end.toISOString() },
    topline,
    engagementTrend,
    contentVolume,
    funnel: { sent: outreach.length, connected: connectionsMade, replied: repliesReceived },
    channelBreakdown,
    hasData,
  };
}

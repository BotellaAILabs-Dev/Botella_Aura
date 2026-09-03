import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { complete, isClaudeConfigured } from '@/server/ai/claude';
import { getAnalytics } from '@/server/analytics/analytics.service';
import { startOfIsoWeekUTC } from '@/server/competitors/report.service';

/**
 * Weekly written analytics report (Sprint 6, Module 2) — a few short paragraphs
 * a founder can forward to their boss/investors, grounded in REAL numbers.
 * Idempotent per ISO week. Honest: an empty week says so plainly.
 */
interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function generateAnalyticsReport(args: {
  companyId: string;
  userId?: string | null;
  now?: Date;
  requestMeta?: Meta;
}) {
  const { companyId, userId, requestMeta } = args;
  const now = args.now ?? new Date();
  const weekStart = startOfIsoWeekUTC(now);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);

  const analytics = await getAnalytics(companyId, 7);
  const summary = await writeSummary(companyId, analytics);

  const report = await db.analyticsReport.upsert({
    where: { companyId_periodStart: { companyId, periodStart: weekStart } },
    create: {
      companyId,
      periodStart: weekStart,
      periodEnd: weekEnd,
      summary,
      metrics: analytics.topline as unknown as object,
    },
    update: {
      periodEnd: weekEnd,
      summary,
      metrics: analytics.topline as unknown as object,
      generatedAt: new Date(),
    },
  });

  await recordAudit({
    action: 'ANALYTICS_REPORT_GENERATED',
    userId: userId ?? null,
    companyId,
    metadata: { reportId: report.id, hasData: analytics.hasData },
    ...requestMeta,
  });

  return report;
}

async function writeSummary(
  companyId: string,
  a: Awaited<ReturnType<typeof getAnalytics>>,
): Promise<string> {
  const t = a.topline;
  const facts =
    `Last 7 days: ${t.postsPublished} posts published, ${t.totalEngagement} total engagement, ` +
    `${t.outreachSent} outreach sent (${t.connectionsMade} connected, ${t.repliesReceived} replied), ` +
    `${t.leadsDiscovered} leads discovered, ${t.campaignsRun} campaigns started.`;

  if (!a.hasData) {
    return 'Not enough activity this week to report on yet. Publish content, sync its metrics, and log outreach outcomes — next week\'s report will fill in with real numbers.';
  }
  if (!isClaudeConfigured()) {
    return `${facts} Keep the cadence going and review your approval queues to stay on schedule.`;
  }
  try {
    return await complete({
      system:
        'You are an AI marketing employee writing a short weekly results summary ' +
        'a founder can forward to their investors (2-3 short paragraphs). Use ONLY ' +
        'the numbers provided — never invent metrics. Confident, plain-English, ' +
        'no hype.',
      prompt: `${facts}\nWrite the weekly summary.`,
      maxTokens: 500,
      effort: 'low',
      tier: 'standard',
    });
  } catch (err) {
    logger.info('analytics report: AI summary failed, using facts', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return facts;
  }
}

export async function getLatestReport(companyId: string) {
  return db.analyticsReport.findFirst({
    where: { companyId },
    orderBy: { periodStart: 'desc' },
  });
}

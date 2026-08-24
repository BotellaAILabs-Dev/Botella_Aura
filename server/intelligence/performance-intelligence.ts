import { db } from '@/lib/db';

import type {
  MarketingPerformance,
  ScoreBlock,
} from '@/server/intelligence/types';

/**
 * Marketing Performance — campaign health, lead-generation health, competitor
 * visibility, content output, and outreach conversion.
 *
 * Each score is a ratio of real rows, never a vanity number, and each reports
 * `hasData: false` when the underlying activity has not happened yet. "No
 * campaigns" and "campaigns that are failing" must not look the same.
 */
const WINDOW_DAYS = 30;

function unavailable(basis: string, recommendation: string): ScoreBlock {
  return { score: null, hasData: false, basis, recommendation };
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

export async function analysePerformance(
  companyId: string,
): Promise<{ performance: MarketingPerformance; gaps: string[] }> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const gaps: string[] = [];

  const [
    campaigns,
    campaignTasks,
    leads,
    scoredLeads,
    contactedLeads,
    competitors,
    recentSnapshots,
    publishedCount,
    draftCount,
    outreachSent,
    outreachAccepted,
    outreachReplied,
  ] = await Promise.all([
    db.campaign.findMany({
      where: { companyId },
      select: { id: true, status: true, createdAt: true },
    }),
    db.campaignTask.groupBy({
      by: ['status'],
      where: { companyId },
      _count: { _all: true },
    }),
    db.lead.count({ where: { companyId } }),
    db.lead.count({ where: { companyId, fitScore: { gte: 60 } } }),
    db.lead.count({
      where: { companyId, status: { in: ['DRAFTED', 'CONTACTED'] } },
    }),
    db.competitorProfile.count({ where: { companyId, trackingEnabled: true } }),
    db.competitorSnapshot.count({
      where: { competitor: { companyId }, capturedAt: { gte: since } },
    }),
    db.contentDraft.count({
      where: { companyId, status: 'PUBLISHED', publishedAt: { gte: since } },
    }),
    db.contentDraft.count({ where: { companyId, createdAt: { gte: since } } }),
    db.outreachMessage.count({ where: { companyId, status: 'SENT' } }),
    db.outreachMessage.count({ where: { companyId, connectionAccepted: true } }),
    db.outreachMessage.count({ where: { companyId, replyReceived: true } }),
  ]);

  // --- Campaign performance ----------------------------------------------
  const taskCounts = new Map(campaignTasks.map((t) => [t.status, t._count._all]));
  const totalTasks = [...taskCounts.values()].reduce((a, b) => a + b, 0);
  // A task counts as "done" once it produced something a human can act on:
  // generated or approved. SKIPPED is neither a success nor a failure.
  const completedTasks =
    (taskCounts.get('GENERATED') ?? 0) + (taskCounts.get('APPROVED') ?? 0);
  const failedTasks = taskCounts.get('FAILED') ?? 0;

  const campaign: ScoreBlock = campaigns.length
    ? totalTasks > 0
      ? {
          score: Math.max(
            0,
            pct(completedTasks, totalTasks) - Math.round((failedTasks / totalTasks) * 30),
          ),
          hasData: true,
          basis: `${completedTasks} of ${totalTasks} planned campaign tasks have produced output across ${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'}${failedTasks ? `, ${failedTasks} failed` : ''}.`,
          recommendation:
            failedTasks > 0
              ? 'Open the campaign timeline and re-run the failed tasks — a stalled plan quietly stops producing.'
              : completedTasks < totalTasks / 2
                ? 'Most planned tasks have not run yet. Check the campaign is active and its schedule has started.'
                : undefined,
          detail: {
            campaigns: campaigns.length,
            active: campaigns.filter((c) => c.status === 'ACTIVE').length,
            tasksCompleted: completedTasks,
            tasksFailed: failedTasks,
          },
        }
      : unavailable(
          `${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'} exist but none has generated tasks yet.`,
          'Generate the campaign plan so it produces a schedule of content and outreach.',
        )
    : unavailable(
        'No campaigns created yet.',
        'Create a campaign to turn one goal into a reviewable plan across content, outreach, and discovery.',
      );
  if (!campaigns.length) gaps.push('No campaigns — campaign performance cannot be scored.');

  // --- Lead generation health --------------------------------------------
  // Health is about quality and movement, not raw count: good-fit leads that
  // never get contacted are not a healthy pipeline.
  const leadGeneration: ScoreBlock = leads
    ? {
        score: Math.round(pct(scoredLeads, leads) * 0.6 + pct(contactedLeads, leads) * 0.4),
        hasData: true,
        basis: `${scoredLeads} of ${leads} leads score 60+ on fit, and ${contactedLeads} have moved into outreach.`,
        recommendation:
          contactedLeads === 0 && leads > 0
            ? 'No lead has been moved into outreach yet — select your best-fit leads and send them to Outreach.'
            : scoredLeads / Math.max(1, leads) < 0.3
              ? 'Most leads score poorly against your criteria. Tighten the discovery requirement so runs return fewer, better matches.'
              : undefined,
        detail: {
          totalLeads: leads,
          goodFit: scoredLeads,
          inOutreach: contactedLeads,
        },
      }
    : unavailable(
        'No leads yet.',
        'Create a discovery requirement and run it — leads land on the Leads page and the Outreach board together.',
      );
  if (!leads) gaps.push('No leads — lead generation health cannot be scored.');

  // --- Competitor visibility ---------------------------------------------
  const competitorVisibility: ScoreBlock = competitors
    ? {
        // Visibility = are we actually watching them regularly?
        score: Math.min(
          100,
          Math.round(
            Math.min(1, competitors / 3) * 50 +
              Math.min(1, recentSnapshots / (competitors * 4)) * 50,
          ),
        ),
        hasData: true,
        basis: `Tracking ${competitors} competitor${competitors === 1 ? '' : 's'} with ${recentSnapshots} capture${recentSnapshots === 1 ? '' : 's'} in the last ${WINDOW_DAYS} days.`,
        recommendation:
          recentSnapshots === 0
            ? 'No captures in the last 30 days — generate a competitor report to take a snapshot, otherwise there is nothing to compare against.'
            : competitors < 3
              ? 'Track at least three competitors — with one or two, a quiet week is indistinguishable from a quiet market.'
              : undefined,
        detail: { competitors, snapshots: recentSnapshots },
      }
    : unavailable(
        'No competitors are being tracked.',
        'Add two or three competitors — this also powers the AI Marketing Advisor.',
      );
  if (!competitors) {
    gaps.push('No competitors tracked — competitor visibility cannot be scored.');
  }

  // --- Content output -----------------------------------------------------
  const contentOutput: ScoreBlock = draftCount
    ? {
        score: Math.round(
          // Target: ~8 published pieces in 30 days, and drafts actually shipping.
          Math.min(1, publishedCount / 8) * 60 + pct(publishedCount, draftCount) * 0.4,
        ),
        hasData: true,
        basis: `${publishedCount} published from ${draftCount} draft${draftCount === 1 ? '' : 's'} in the last ${WINDOW_DAYS} days.`,
        recommendation:
          publishedCount === 0
            ? 'Drafts are being created but nothing is going out. Approve and publish — unpublished drafts produce no results.'
            : publishedCount < 4
              ? 'Output is below a sustainable cadence. The Marketing Planner can turn your goals into a dated calendar.'
              : undefined,
        detail: { drafts: draftCount, published: publishedCount },
      }
    : unavailable(
        `No content created in the last ${WINDOW_DAYS} days.`,
        'Generate a draft in Content Studio, or build a monthly plan in the Marketing Planner.',
      );

  // --- Outreach conversion ------------------------------------------------
  const outreach: ScoreBlock = outreachSent
    ? {
        score: Math.round(
          pct(outreachAccepted, outreachSent) * 0.5 +
            pct(outreachReplied, outreachSent) * 0.5,
        ),
        hasData: true,
        basis: `${outreachAccepted} connection${outreachAccepted === 1 ? '' : 's'} accepted and ${outreachReplied} repl${outreachReplied === 1 ? 'y' : 'ies'} from ${outreachSent} sent message${outreachSent === 1 ? '' : 's'}.`,
        recommendation:
          outreachAccepted === 0
            ? 'No accepted connections recorded. Mark outcomes on sent messages — without them the learning loop has nothing to learn from.'
            : undefined,
        detail: {
          sent: outreachSent,
          accepted: outreachAccepted,
          replied: outreachReplied,
        },
      }
    : unavailable(
        'No outreach has been sent yet.',
        'Draft and approve outreach for your best-fit leads, then send it from the browser extension.',
      );

  return {
    performance: {
      campaign,
      leadGeneration,
      competitorVisibility,
      contentOutput,
      outreach,
    },
    gaps,
  };
}

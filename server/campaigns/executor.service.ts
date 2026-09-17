import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { generateDraft } from '@/server/content/generator';
import { runDiscovery } from '@/server/leads/discovery/discovery.service';
import { draftForLead } from '@/server/outreach/drafting.service';
import { generateCheckpointSummary } from '@/server/campaigns/checkpoint.service';
import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * Campaign task executor (Sprint 6, Module 1) — the daily conductor. It finds
 * due PENDING tasks for ACTIVE campaigns and TRIGGERS the existing Sprint 3-5
 * pipelines, landing output in the normal approval queues. It builds NO new
 * generation logic and NEVER publishes/sends anything — every produced item is
 * a DRAFT awaiting the usual human approval (NON-NEGOTIABLE #2).
 */
const MAX_TASKS_PER_RUN = 100;
const OUTREACH_BATCH_SIZE = 3;

export async function executeDueCampaignTasks(
  now: Date = new Date(),
): Promise<{
  processed: number;
  generated: number;
  skipped: number;
  failed: number;
  /** Campaigns closed out by this run. */
  completed: number;
}> {
  const tasks = await db.campaignTask.findMany({
    where: {
      status: 'PENDING',
      scheduledDate: { lte: now },
      campaign: { status: 'ACTIVE' },
    },
    orderBy: { scheduledDate: 'asc' },
    take: MAX_TASKS_PER_RUN,
    include: { campaign: true },
  });

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const task of tasks) {
    try {
      const outcome = await runTask(task);
      if (outcome === 'skipped') skipped++;
      else generated++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      await db.campaignTask.update({
        where: { id: task.id },
        data: { status: 'FAILED', error: message.slice(0, 500) },
      });
      await recordAudit({
        action: 'CAMPAIGN_TASK_FAILED',
        companyId: task.companyId,
        metadata: { taskId: task.id, taskType: task.taskType, error: message.slice(0, 200) },
      });
      logger.error('campaign executor: task failed', { taskId: task.id, error: message });
    }
  }

  // A campaign whose work is all done must stop reading as "running".
  const completed = await closeFinishedCampaigns(now);

  return { processed: tasks.length, generated, skipped, failed, completed };
}

/**
 * Mark campaigns COMPLETED once no task can still run.
 *
 * COMPLETED existed in the schema and in the UI — the list page styled it, the
 * pause button hid itself for it — but nothing in the codebase ever wrote it.
 * The result was that a campaign which had finished all thirty days of its work
 * stayed ACTIVE forever, indistinguishable from one started this morning, and
 * the pause button kept offering to pause work that could never run again.
 *
 * "Finished" means no PENDING task remains. Tasks awaiting human review do not
 * hold a campaign open: the scheduled work is done, and the approval queue is
 * where the remaining items live. The derived state still surfaces them (see
 * lib/campaign-status.ts), so nothing is lost by closing the campaign.
 */
async function closeFinishedCampaigns(now: Date): Promise<number> {
  const candidates = await db.campaign.findMany({
    where: {
      status: 'ACTIVE',
      // Cheap pre-filter: a campaign with any pending task is definitely open.
      tasks: { none: { status: 'PENDING' } },
    },
    select: { id: true, companyId: true, name: true, _count: { select: { tasks: true } } },
  });

  let closed = 0;
  for (const campaign of candidates) {
    // A campaign with no tasks at all was never planned; leave it alone rather
    // than declaring an empty thing complete.
    if (campaign._count.tasks === 0) continue;

    await db.campaign.update({
      where: { id: campaign.id },
      data: { status: 'COMPLETED', endDate: now },
    });
    await recordAudit({
      action: 'CAMPAIGN_COMPLETED',
      companyId: campaign.companyId,
      metadata: { campaignId: campaign.id, name: campaign.name },
    });
    logger.info('campaign executor: campaign completed', {
      campaignId: campaign.id,
    });
    closed++;
  }
  return closed;
}

type TaskWithCampaign = Awaited<ReturnType<typeof db.campaignTask.findMany>>[number] & {
  campaign: { id: string; name: string; goal: string | null; startDate: Date | null };
};

async function runTask(task: TaskWithCampaign): Promise<'generated' | 'skipped'> {
  const { companyId } = task;
  // Campaign automation is attributed to the company owner (a real user), so
  // generated drafts have a valid creator and audit trail.
  const actingUserId = await getActingUserId(companyId);

  switch (task.taskType) {
    case 'GENERATE_CONTENT': {
      if (!task.contentType) return markSkipped(task);
      // Trigger the EXISTING content generator → lands a DRAFT in the queue.
      const draft = await generateDraft({
        companyId,
        userId: actingUserId,
        type: task.contentType as ContentTypeKey,
        source: { kind: 'BRIEF', brief: task.topic ?? task.campaign.goal ?? task.campaign.name },
        campaignId: task.campaignId,
      });
      await markGenerated(task, { relatedContentDraftId: draft.id });
      return 'generated';
    }

    case 'RUN_DISCOVERY': {
      const profile = await db.discoveryProfile.findFirst({
        where: { companyId, isActive: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!profile) return markSkipped(task);
      const result = await runDiscovery({ companyId, profileId: profile.id });
      await markGenerated(task, { relatedDiscoveryRunId: result.runId });
      return 'generated';
    }

    case 'RUN_OUTREACH_BATCH': {
      const leads = await db.lead.findMany({
        where: {
          companyId,
          status: { in: ['NEW', 'QUALIFIED'] },
          messages: { none: {} },
        },
        take: OUTREACH_BATCH_SIZE,
        orderBy: [{ fitScore: 'desc' }, { createdAt: 'desc' }],
      });
      if (leads.length === 0) return markSkipped(task);
      for (const lead of leads) {
        // Trigger the EXISTING outreach drafter → OutreachMessage DRAFTs in queue.
        await draftForLead({ companyId, userId: actingUserId, leadId: lead.id }).catch((e) =>
          logger.info('campaign outreach draft failed for lead', { leadId: lead.id, error: String(e) }),
        );
      }
      await markGenerated(task, {});
      return 'generated';
    }

    case 'REVIEW_CHECKPOINT': {
      const start = task.campaign.startDate ?? task.createdAt;
      const weekNumber = Math.max(
        1,
        Math.round((task.scheduledDate.getTime() - start.getTime()) / (7 * 86_400_000)),
      );
      const summary = await generateCheckpointSummary({
        campaign: task.campaign as never,
        weekNumber,
      });
      await db.campaignTask.update({
        where: { id: task.id },
        data: { status: 'GENERATED', checkpointSummary: summary },
      });
      await recordAudit({
        action: 'CAMPAIGN_CHECKPOINT_GENERATED',
        companyId,
        metadata: { taskId: task.id, campaignId: task.campaignId, weekNumber },
      });
      return 'generated';
    }

    default:
      return markSkipped(task);
  }
}

// Resolve the acting user (company owner) for campaign-triggered generation,
// cached per run so a big batch doesn't re-query.
const actingUserCache = new Map<string, string>();
async function getActingUserId(companyId: string): Promise<string> {
  const cached = actingUserCache.get(companyId);
  if (cached) return cached;
  const owner =
    (await db.companyMember.findFirst({ where: { companyId, role: 'OWNER' } })) ??
    (await db.companyMember.findFirst({ where: { companyId } }));
  if (!owner) throw new Error('No member found to attribute campaign work to.');
  actingUserCache.set(companyId, owner.userId);
  return owner.userId;
}

async function markGenerated(
  task: TaskWithCampaign,
  data: { relatedContentDraftId?: string; relatedDiscoveryRunId?: string },
): Promise<void> {
  await db.campaignTask.update({
    where: { id: task.id },
    data: { status: 'GENERATED', ...data },
  });
  await recordAudit({
    action: 'CAMPAIGN_TASK_GENERATED',
    companyId: task.companyId,
    metadata: { taskId: task.id, taskType: task.taskType, ...data },
  });
}

async function markSkipped(task: TaskWithCampaign): Promise<'skipped'> {
  await db.campaignTask.update({ where: { id: task.id }, data: { status: 'SKIPPED' } });
  return 'skipped';
}

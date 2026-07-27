import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import { generateCampaignPlan } from '@/server/campaigns/planner';
import type { CreateCampaignInput } from '@/lib/validations/campaign';

/** Campaign Orchestrator service (Sprint 6, Module 1). */
export class CampaignNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Campaign not found.');
    this.name = 'CampaignNotFoundError';
  }
}

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

/**
 * Create a campaign: generate the AI plan, persist it, and materialize the
 * CampaignTask schedule. Tasks are PENDING — the daily executor triggers the
 * existing pipelines later; nothing is generated or sent here.
 */
export async function createCampaign(args: {
  companyId: string;
  userId: string;
  input: CreateCampaignInput;
  requestMeta?: Meta;
}) {
  const { companyId, userId, input, requestMeta } = args;
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error('Company not found.');

  const { plan, model } = await generateCampaignPlan({ company, userId, input });

  const start = startOfDayUTC(new Date());
  const end = addDays(start, input.durationDays);

  const campaign = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const created = await tx.campaign.create({
      data: {
        companyId,
        name: input.name,
        goal: input.goal,
        status: 'ACTIVE',
        startDate: start,
        endDate: end,
        durationDays: input.durationDays,
        modulesIncluded: input.modules,
        targetAudience: input.targetAudience || null,
        themes: input.themes,
        plan: plan as unknown as object,
      },
    });

    const tasks: Prisma.CampaignTaskCreateManyInput[] = [];
    for (const d of plan.days) {
      const scheduledDate = addDays(start, d.day - 1);
      if (d.contentType) {
        tasks.push({
          campaignId: created.id,
          companyId,
          scheduledDate,
          taskType: 'GENERATE_CONTENT',
          contentType: d.contentType,
          topic: d.topic ?? null,
          rationale: d.rationale ?? null,
        });
      }
      if (d.outreach) {
        tasks.push({
          campaignId: created.id,
          companyId,
          scheduledDate,
          taskType: 'RUN_OUTREACH_BATCH',
          rationale: d.rationale ?? null,
        });
      }
      if (d.discovery) {
        tasks.push({
          campaignId: created.id,
          companyId,
          scheduledDate,
          taskType: 'RUN_DISCOVERY',
          rationale: d.rationale ?? null,
        });
      }
    }
    // Weekly review checkpoints.
    for (let day = 7; day <= input.durationDays; day += 7) {
      tasks.push({
        campaignId: created.id,
        companyId,
        scheduledDate: addDays(start, day - 1),
        taskType: 'REVIEW_CHECKPOINT',
      });
    }

    if (tasks.length) await tx.campaignTask.createMany({ data: tasks });

    await recordAudit(
      { action: 'CAMPAIGN_CREATED', userId, companyId, metadata: { campaignId: created.id, name: created.name }, ...requestMeta },
      tx,
    );
    await recordAudit(
      { action: 'CAMPAIGN_PLAN_GENERATED', userId, companyId, metadata: { campaignId: created.id, taskCount: tasks.length, model }, ...requestMeta },
      tx,
    );
    return created;
  });

  return campaign;
}

export async function listCampaigns(companyId: string) {
  return db.campaign.findMany({
    where: { companyId, status: { not: 'ARCHIVED' } },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { tasks: true } } },
  });
}

export async function getCampaign(companyId: string, campaignId: string) {
  const campaign = await db.campaign.findFirst({
    where: { id: campaignId, companyId },
    include: { tasks: { orderBy: { scheduledDate: 'asc' } } },
  });
  if (!campaign) throw new CampaignNotFoundError();
  return campaign;
}

/** Pause / resume a campaign (stops/starts future task execution). */
export async function setCampaignStatus(args: {
  companyId: string;
  userId: string;
  campaignId: string;
  action: 'pause' | 'resume';
  requestMeta?: Meta;
}) {
  const { companyId, userId, campaignId, action, requestMeta } = args;
  const existing = await db.campaign.findFirst({ where: { id: campaignId, companyId } });
  if (!existing) throw new CampaignNotFoundError();

  const status = action === 'pause' ? 'PAUSED' : 'ACTIVE';
  const campaign = await db.campaign.update({ where: { id: campaignId }, data: { status } });
  await recordAudit({
    action: action === 'pause' ? 'CAMPAIGN_PAUSED' : 'CAMPAIGN_RESUMED',
    userId,
    companyId,
    metadata: { campaignId },
    ...requestMeta,
  });
  return campaign;
}

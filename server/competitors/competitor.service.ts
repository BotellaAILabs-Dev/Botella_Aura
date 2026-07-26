import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import type {
  CreateCompetitorInput,
  UpdateCompetitorInput,
} from '@/lib/validations/competitors';

/** Thrown when a competitor id doesn't belong to the acting company. */
export class CompetitorNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Competitor not found.');
    this.name = 'CompetitorNotFoundError';
  }
}

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Competitors for a company, each with its most recent snapshot (if any). */
export async function listCompetitors(companyId: string) {
  return db.competitorProfile.findMany({
    where: { companyId },
    orderBy: { createdAt: 'asc' },
    include: {
      snapshots: { orderBy: { capturedAt: 'desc' }, take: 1 },
    },
  });
}

/** Load a competitor scoped to a company, or throw 404. */
export async function getCompetitorOrThrow(
  companyId: string,
  competitorId: string,
) {
  const competitor = await db.competitorProfile.findFirst({
    where: { id: competitorId, companyId },
  });
  if (!competitor) throw new CompetitorNotFoundError();
  return competitor;
}

export async function addCompetitor(args: {
  companyId: string;
  userId: string;
  input: CreateCompetitorInput;
  requestMeta?: Meta;
}) {
  const { companyId, userId, input, requestMeta } = args;
  return db.$transaction(async (tx) => {
    const competitor = await tx.competitorProfile.create({
      data: {
        companyId,
        name: input.name,
        url: input.url ?? null,
        pricingUrl: input.pricingUrl ?? null,
        linkedInUrl: input.linkedInUrl ?? null,
        githubOrg: input.githubOrg ?? null,
        notes: input.notes || null,
      },
    });
    await recordAudit(
      {
        action: 'COMPETITOR_ADDED',
        userId,
        companyId,
        metadata: { competitorId: competitor.id, name: competitor.name },
        ...requestMeta,
      },
      tx,
    );
    return competitor;
  });
}

export async function updateCompetitor(args: {
  companyId: string;
  userId: string;
  competitorId: string;
  input: UpdateCompetitorInput;
  requestMeta?: Meta;
}) {
  const { companyId, userId, competitorId, input, requestMeta } = args;
  await getCompetitorOrThrow(companyId, competitorId);

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.url !== undefined) data.url = input.url || null;
  if (input.pricingUrl !== undefined) data.pricingUrl = input.pricingUrl || null;
  if (input.linkedInUrl !== undefined)
    data.linkedInUrl = input.linkedInUrl || null;
  if (input.githubOrg !== undefined) data.githubOrg = input.githubOrg || null;
  if (input.notes !== undefined) data.notes = input.notes || null;
  if (input.trackingEnabled !== undefined)
    data.trackingEnabled = input.trackingEnabled;

  return db.$transaction(async (tx) => {
    const competitor = await tx.competitorProfile.update({
      where: { id: competitorId },
      data,
    });
    await recordAudit(
      {
        action: 'COMPETITOR_UPDATED',
        userId,
        companyId,
        metadata: { competitorId, changedFields: Object.keys(data) },
        ...requestMeta,
      },
      tx,
    );
    return competitor;
  });
}

export async function removeCompetitor(args: {
  companyId: string;
  userId: string;
  competitorId: string;
  requestMeta?: Meta;
}) {
  const { companyId, userId, competitorId, requestMeta } = args;
  const competitor = await getCompetitorOrThrow(companyId, competitorId);
  await db.$transaction(async (tx) => {
    await tx.competitorProfile.delete({ where: { id: competitorId } });
    await recordAudit(
      {
        action: 'COMPETITOR_REMOVED',
        userId,
        companyId,
        metadata: { competitorId, name: competitor.name },
        ...requestMeta,
      },
      tx,
    );
  });
}

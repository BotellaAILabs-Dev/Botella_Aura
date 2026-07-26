import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import type { CreateLeadInput, UpdateLeadInput } from '@/lib/validations/outreach';

export class LeadNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Lead not found.');
    this.name = 'LeadNotFoundError';
  }
}

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Leads with their signals + drafted messages, newest activity first. */
export async function listLeads(companyId: string) {
  return db.lead.findMany({
    where: { companyId },
    orderBy: { updatedAt: 'desc' },
    include: {
      signals: { orderBy: { detectedAt: 'desc' }, take: 5 },
      messages: { orderBy: { createdAt: 'desc' } },
    },
  });
}

export async function getLeadOrThrow(companyId: string, leadId: string) {
  const lead = await db.lead.findFirst({ where: { id: leadId, companyId } });
  if (!lead) throw new LeadNotFoundError();
  return lead;
}

export async function createLead(args: {
  companyId: string;
  userId: string;
  input: CreateLeadInput;
  requestMeta?: Meta;
}) {
  const { companyId, userId, input, requestMeta } = args;
  return db.$transaction(async (tx) => {
    const lead = await tx.lead.create({
      data: {
        companyId,
        companyName: input.companyName,
        name: input.name || null,
        title: input.title || null,
        linkedInProfileUrl: input.linkedInProfileUrl ?? null,
        sourceUrl: input.sourceUrl ?? null,
        status: 'QUALIFIED',
      },
    });
    await recordAudit(
      {
        action: 'LEAD_CREATED',
        userId,
        companyId,
        metadata: { leadId: lead.id, manual: true },
        ...requestMeta,
      },
      tx,
    );
    return lead;
  });
}

export async function updateLead(args: {
  companyId: string;
  userId: string;
  leadId: string;
  input: UpdateLeadInput;
  requestMeta?: Meta;
}) {
  const { companyId, userId, leadId, input, requestMeta } = args;
  await getLeadOrThrow(companyId, leadId);

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name || null;
  if (input.title !== undefined) data.title = input.title || null;
  if (input.companyName !== undefined) data.companyName = input.companyName;
  if (input.linkedInProfileUrl !== undefined)
    data.linkedInProfileUrl = input.linkedInProfileUrl ?? null;
  if (input.status !== undefined) data.status = input.status;

  return db.$transaction(async (tx) => {
    const lead = await tx.lead.update({ where: { id: leadId }, data });
    await recordAudit(
      {
        action: 'LEAD_UPDATED',
        userId,
        companyId,
        metadata: { leadId, changedFields: Object.keys(data) },
        ...requestMeta,
      },
      tx,
    );
    return lead;
  });
}

export async function removeLead(args: {
  companyId: string;
  userId: string;
  leadId: string;
  requestMeta?: Meta;
}) {
  const { companyId, userId, leadId, requestMeta } = args;
  await getLeadOrThrow(companyId, leadId);
  await db.$transaction(async (tx) => {
    await tx.lead.delete({ where: { id: leadId } });
    await recordAudit(
      { action: 'LEAD_REMOVED', userId, companyId, metadata: { leadId }, ...requestMeta },
      tx,
    );
  });
}

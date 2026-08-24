import type { Prisma } from '@prisma/client';
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

export interface LeadListFilters {
  /** Requirement/category label, e.g. "Distillery". */
  category?: string | null;
  /** LeadSource value: SIGNAL | DISCOVERY_ENGINE | MANUAL. */
  source?: string | null;
  /** LeadStatus value. */
  status?: string | null;
}

/**
 * Leads with their signals + drafted messages, newest activity first.
 *
 * Both the Leads page and the Outreach board read through this single function,
 * so a lead that exists in one is guaranteed to exist in the other — the
 * "leads don't show up in Outreach" report is impossible by construction, and
 * the same filters apply on both screens.
 */
export async function listLeads(companyId: string, filters: LeadListFilters = {}) {
  const where: Prisma.LeadWhereInput = { companyId };
  if (filters.category) where.category = filters.category;
  if (filters.source) where.source = filters.source as Prisma.LeadWhereInput['source'];
  if (filters.status) where.status = filters.status as Prisma.LeadWhereInput['status'];

  return db.lead.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    include: {
      signals: { orderBy: { detectedAt: 'desc' }, take: 5 },
      messages: { orderBy: { createdAt: 'desc' } },
      discoveryProfile: { select: { id: true, name: true, category: true } },
    },
  });
}

export interface LeadCategoryCount {
  /** Null means "leads with no requirement" (signal/manual leads). */
  category: string | null;
  label: string;
  count: number;
}

/**
 * The requirement buckets a company's leads fall into, with counts — the data
 * behind the "group leads by where they came from" filters.
 */
export async function listLeadCategories(
  companyId: string,
): Promise<LeadCategoryCount[]> {
  const grouped = await db.lead.groupBy({
    by: ['category'],
    where: { companyId },
    _count: { _all: true },
  });
  return grouped
    .map((g) => ({
      category: g.category,
      label: g.category ?? 'Uncategorised',
      count: g._count._all,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Move leads into the outreach workflow explicitly.
 *
 * Leads have always been visible on the Outreach board, but nothing in the UI
 * said so, and a discovered lead sat at NEW with no obvious next step — which
 * is what "leads are not appearing in Outreach" actually described. This is the
 * explicit hand-off: it qualifies the leads and reports where they went.
 */
export async function sendLeadsToOutreach(args: {
  companyId: string;
  userId: string;
  leadIds: string[];
  requestMeta?: Meta;
}): Promise<{ moved: number; categories: string[] }> {
  const { companyId, userId, leadIds, requestMeta } = args;
  if (leadIds.length === 0) return { moved: 0, categories: [] };

  const leads = await db.lead.findMany({
    where: { id: { in: leadIds }, companyId },
    select: { id: true, category: true, status: true },
  });
  if (leads.length === 0) throw new LeadNotFoundError();

  // Already-contacted leads keep their further-along status.
  const promotable = leads.filter(
    (l) => l.status === 'NEW' || l.status === 'ARCHIVED',
  );

  await db.$transaction(async (tx) => {
    if (promotable.length > 0) {
      await tx.lead.updateMany({
        where: { id: { in: promotable.map((l) => l.id) }, companyId },
        data: { status: 'QUALIFIED' },
      });
    }
    await recordAudit(
      {
        action: 'LEAD_SENT_TO_OUTREACH',
        userId,
        companyId,
        metadata: {
          leadIds: leads.map((l) => l.id),
          promoted: promotable.length,
        },
        ...requestMeta,
      },
      tx,
    );
  });

  const categories = [
    ...new Set(leads.map((l) => l.category).filter((c): c is string => Boolean(c))),
  ];
  return { moved: leads.length, categories };
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
    // Dedup for accuracy: match an existing lead by LinkedIn profile URL, or by
    // (person name + company) case-insensitively. Prevents duplicate/conflicting
    // profiles from repeated detection or manual re-adds.
    const dedupConditions: Prisma.LeadWhereInput[] = [];
    if (input.linkedInProfileUrl) {
      dedupConditions.push({ linkedInProfileUrl: input.linkedInProfileUrl });
    }
    if (input.name) {
      dedupConditions.push({
        name: { equals: input.name, mode: 'insensitive' },
        companyName: { equals: input.companyName, mode: 'insensitive' },
      });
    }
    const existing =
      dedupConditions.length > 0
        ? await tx.lead.findFirst({
            where: { companyId, OR: dedupConditions },
          })
        : null;

    if (existing) {
      // Enrich: fill in any fields we were missing, rather than duplicate.
      const patch: Prisma.LeadUpdateInput = {};
      if (!existing.name && input.name) patch.name = input.name;
      if (!existing.title && input.title) patch.title = input.title;
      if (!existing.linkedInProfileUrl && input.linkedInProfileUrl)
        patch.linkedInProfileUrl = input.linkedInProfileUrl;
      if (!existing.sourceUrl && input.sourceUrl)
        patch.sourceUrl = input.sourceUrl;
      const lead = Object.keys(patch).length
        ? await tx.lead.update({ where: { id: existing.id }, data: patch })
        : existing;
      await recordAudit(
        {
          action: 'LEAD_UPDATED',
          userId,
          companyId,
          metadata: { leadId: lead.id, deduped: true, enriched: Object.keys(patch) },
          ...requestMeta,
        },
        tx,
      );
      return lead;
    }

    const lead = await tx.lead.create({
      data: {
        companyId,
        companyName: input.companyName,
        name: input.name || null,
        title: input.title || null,
        linkedInProfileUrl: input.linkedInProfileUrl ?? null,
        sourceUrl: input.sourceUrl ?? null,
        category: input.category?.trim() || null,
        source: 'MANUAL',
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
  if (input.category !== undefined) data.category = input.category?.trim() || null;
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

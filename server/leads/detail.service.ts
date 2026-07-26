import { db } from '@/lib/db';

/** Full lead detail for /dashboard/leads/[id] (Sprint 5). */
export async function getLeadDetail(companyId: string, leadId: string) {
  return db.lead.findFirst({
    where: { id: leadId, companyId },
    include: {
      signals: { orderBy: { detectedAt: 'desc' } },
      messages: { orderBy: { createdAt: 'desc' } },
      discoveryProfile: { select: { id: true, name: true } },
    },
  });
}

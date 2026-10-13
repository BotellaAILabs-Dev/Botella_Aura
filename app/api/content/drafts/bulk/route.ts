import { z } from 'zod';
import type { ContentStatus } from '@prisma/client';
import { requireActiveCompany } from '@/lib/auth-helpers';
import { bulkTransition } from '@/server/content/content.service';
import { handleRouteError, jsonOk } from '@/lib/api';

/** POST /api/content/drafts/bulk — approve/reject multiple drafts at once. */
const bodySchema = z.object({
  ids: z.array(z.string()).min(1).max(100),
  action: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(500).optional(),
});

const TO: Record<'approve' | 'reject', ContentStatus> = {
  approve: 'APPROVED',
  reject: 'REJECTED',
};

export async function POST(req: Request) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    const { ids, action, reason } = bodySchema.parse(await req.json());
    const result = await bulkTransition({
      companyId: company.id,
      userId: user.id,
      draftIds: ids,
      to: TO[action],
      reason,
      // Owners and admins only — checked per draft in the service.
      role: membership.role,
    });
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}

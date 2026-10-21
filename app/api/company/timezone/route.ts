import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { db } from '@/lib/db';
import { can } from '@/lib/rbac';
import { isValidTimeZone, offsetLabel, safeTimeZone } from '@/lib/timezone';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { recordAudit } from '@/server/services/audit.service';

/**
 * GET   /api/company/timezone — the workspace's timezone (any member).
 * PATCH /api/company/timezone { timezone } — change it (OWNER/ADMIN).
 *
 * Changing the zone never moves a post already scheduled: its instant is
 * kept, and it is shown in the new zone (the response says how many).
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ timezone: z.string().trim().min(1).max(64) });

export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    const row = await db.company.findUnique({ where: { id: company.id }, select: { timezone: true } });
    const tz = safeTimeZone(row?.timezone);
    return jsonOk({ timezone: tz, offset: offsetLabel(new Date(), tz) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(req: Request) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) return jsonError('Only owners and admins can change the workspace timezone.', 403);
    const { timezone } = bodySchema.parse(await req.json());
    if (!isValidTimeZone(timezone)) return jsonError(`“${timezone}” isn’t a timezone Aura recognises.`, 422);
    const before = await db.company.findUnique({ where: { id: company.id }, select: { timezone: true } });
    await db.company.update({ where: { id: company.id }, data: { timezone } });
    const scheduled = await db.contentDraft.count({ where: { companyId: company.id, scheduledFor: { gt: new Date() }, publishedAt: null } });
    await recordAudit({
      action: 'WORKSPACE_TIMEZONE_CHANGED',
      userId: user.id,
      companyId: company.id,
      metadata: { from: before?.timezone ?? null, to: timezone, scheduledPostsKept: scheduled },
      ...getRequestMeta(req),
    });
    return jsonOk({ timezone, offset: offsetLabel(new Date(), timezone), scheduledPostsKept: scheduled });
  } catch (error) {
    return handleRouteError(error);
  }
}

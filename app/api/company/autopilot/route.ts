import { z } from 'zod';

import { db } from '@/lib/db';
import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk, getRequestMeta } from '@/lib/api';
import { recordAudit } from '@/server/services/audit.service';
import {
  PUBLISH_MODES,
  MAX_AUTO_PUBLISH_PER_WEEK,
} from '@/server/briefing/autopilot.service';

/**
 * PATCH /api/company/autopilot — what Aura is allowed to do on its own.
 *
 * Turning on automatic publishing is the single most consequential setting in
 * the product: it is the one that can put something in public without a person
 * seeing it first. So it takes the strictest permission available here
 * ('content:approve' — the same one a human needs to approve a post, because
 * that is exactly the authority being delegated), and every change is written
 * to the audit log with who made it.
 */
export const dynamic = 'force-dynamic';

const settingsSchema = z.object({
  enabled: z.boolean(),
  postsPerWeek: z.number().int().min(0).max(5),
  generateGraphics: z.boolean(),
  publishMode: z.enum(PUBLISH_MODES),
});

export async function PATCH(req: Request) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    // Delegating publishing authority requires holding it in the first place.
    if (!can(membership.role, 'content:approve')) {
      return jsonError(
        'Only someone who can approve posts can change what Aura does on its own.',
        403,
      );
    }

    const input = settingsSchema.parse(await req.json());

    const current = await db.company.findUnique({
      where: { id: company.id },
      select: { preferences: true },
    });
    const bag =
      current?.preferences && typeof current.preferences === 'object' && !Array.isArray(current.preferences)
        ? (current.preferences as Record<string, unknown>)
        : {};

    await db.company.update({
      where: { id: company.id },
      // Merge, not replace: brand assets and the marketing profile live in the
      // same bag and must survive this write.
      data: { preferences: { ...bag, autopilot: input } as never },
    });

    await recordAudit({
      action: 'COMPANY_UPDATED',
      userId: user.id,
      companyId: company.id,
      metadata: { autopilot: input },
      ...getRequestMeta(req),
    });

    return jsonOk({ settings: input, maxAutoPublishPerWeek: MAX_AUTO_PUBLISH_PER_WEEK });
  } catch (error) {
    return handleRouteError(error);
  }
}

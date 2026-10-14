import { z } from 'zod';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { getMembership } from '@/server/services/company.service';
import { setWhatsAppEnabled } from '@/server/whatsapp/settings';

/**
 * PATCH /api/whatsapp/settings — turn WhatsApp access on or off for the
 * active workspace. Owners and admins only (company:update).
 */
export const dynamic = 'force-dynamic';

const Body = z.object({ enabled: z.boolean() });

export async function PATCH(req: Request) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const user = await requireUser();
    const { active } = await resolveActiveCompany(user.id);
    if (!active) return jsonError('No active workspace.', 400);
    const membership = await getMembership(user.id, active.id);
    if (!membership || !can(membership.role, 'company:update')) {
      return jsonError('Only owners and admins can change this.', 403);
    }
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError('Send { "enabled": true | false }.', 400);
    await setWhatsAppEnabled({ companyId: active.id, userId: user.id, enabled: parsed.data.enabled });
    return jsonOk({ enabled: parsed.data.enabled });
  } catch (error) {
    return handleRouteError(error);
  }
}

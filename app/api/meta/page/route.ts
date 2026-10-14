import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { getMetaStatus, selectMetaPage } from '@/server/connectors/meta.service';

/**
 * GET  /api/meta/page — the Pages the Meta connection can publish to, and the chosen one.
 * POST /api/meta/page { pageId } — publish to this Page (and its Instagram) from now on.
 *
 * Choosing is managing a connection: OWNER/ADMIN (company:update), as for
 * connecting it.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ pageId: z.string().regex(/^\d{1,30}$/) });

export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    return jsonOk(await getMetaStatus(company.id));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('Only owners and admins can change where Aura publishes.', 403);
    }
    const { pageId } = bodySchema.parse(await req.json());
    const r = await selectMetaPage({ companyId: company.id, userId: user.id, pageId });
    return jsonOk({ accountLabel: r.accountLabel, pageId: r.page.id, instagram: r.page.ig?.username ?? null });
  } catch (error) {
    return handleRouteError(error);
  }
}

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { getWebsiteSchedule, saveWebsiteSchedule, scheduleInputSchema } from '@/server/websites/publish.service';

/**
 * GET /api/websites/:id/schedule — the recurring auto-publish slot and the
 *     approved blogs it would take next.
 * PUT /api/websites/:id/schedule { enabled, weekdays, timeOfDay, mode, postsPerSlot }
 */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { company } = await requireActiveCompany();
    return jsonOk(await getWebsiteSchedule(company.id, params.id));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    const input = scheduleInputSchema.parse(await req.json());
    return jsonOk(await saveWebsiteSchedule({ companyId: company.id, userId: user.id, role: membership.role, websiteId: params.id, input }));
  } catch (error) {
    return handleRouteError(error);
  }
}

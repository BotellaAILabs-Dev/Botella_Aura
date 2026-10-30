import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { disconnectWebsite, updateWebsite } from '@/server/websites/connection.service';

/**
 * PATCH  /api/websites/:id { name?, settings? } — rename, or change the
 *        publishing defaults (categories, author, blog).
 * DELETE /api/websites/:id — disconnect: revoke at the platform where it
 *        allows, wipe the credentials, cancel scheduled publishes. History stays.
 */
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  settings: z
    .object({
      categories: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
      author: z.string().trim().max(200).optional(),
      blogId: z.string().trim().max(200).optional(),
    })
    .optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) return jsonError('Only owners and admins can change website settings.', 403);
    const input = patchSchema.parse(await req.json());
    return jsonOk({ website: await updateWebsite(company.id, params.id, input) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) return jsonError('Only owners and admins can disconnect websites.', 403);
    return jsonOk(await disconnectWebsite({ companyId: company.id, userId: user.id, id: params.id, requestMeta: getRequestMeta(req) }));
  } catch (error) {
    return handleRouteError(error);
  }
}

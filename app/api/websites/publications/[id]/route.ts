import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { cancelWebsitePublication, retryWebsitePublication } from '@/server/websites/publish.service';

/**
 * POST /api/websites/publications/:id { action: "retry" | "cancel" }
 *   retry  — run it again; a post already on the site is updated, never duplicated
 *   cancel — call off a scheduled publish
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const schema = z.object({ action: z.enum(['retry', 'cancel']) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    const { action } = schema.parse(await req.json());
    const args = { companyId: company.id, userId: user.id, role: membership.role, publicationId: params.id };
    const publication = action === 'retry' ? await retryWebsitePublication(args) : await cancelWebsitePublication(args);
    return jsonOk({ publication });
  } catch (error) {
    return handleRouteError(error);
  }
}

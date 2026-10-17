import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { can } from '@/lib/rbac';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { ConnectionManagerError, selectAccount } from '@/server/connections/manager.service';
import { MetaError, selectMetaPage } from '@/server/connectors/meta.service';

/**
 * POST /api/connections/:connectorId/select { accountId } — step 4 of the
 * connection flow: the account/page Aura uses. Meta Pages are re-checked
 * with Meta at the moment of choosing. OWNER/ADMIN (company:update).
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ accountId: z.string().min(1).max(64) });

export async function POST(req: Request, { params }: { params: { connectorId: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) return jsonError('Only owners and admins can choose the account Aura uses.', 403);
    const { accountId } = bodySchema.parse(await req.json());
    const setup = await selectAccount({
      companyId: company.id,
      userId: user.id,
      connectorId: params.connectorId,
      accountId,
      liveSelect:
        params.connectorId === 'meta'
          ? async (pageId) => {
              await selectMetaPage({ companyId: company.id, userId: user.id, pageId });
            }
          : undefined,
    });
    return jsonOk(setup);
  } catch (error) {
    if (error instanceof ConnectionManagerError || error instanceof MetaError) return jsonError(error.message, error.status);
    return handleRouteError(error);
  }
}

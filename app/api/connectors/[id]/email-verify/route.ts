import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { ConnectorError } from '@/server/connectors/connection.service';
import {
  confirmEmailVerification,
  startEmailVerification,
} from '@/server/connectors/email-verification.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/connectors/:id/email-verify — the email + one-time code path.
 *
 * Two steps on one route: `{ email }` sends a code, `{ code }` redeems it.
 * Keeping them together means the client never has to track which endpoint a
 * half-finished verification belongs to.
 */
const bodySchema = z.union([
  z.object({ email: z.string().trim().email('Enter a valid email address.') }),
  z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') }),
]);

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to manage connectors.', 403);
    }

    const body = bodySchema.parse(await req.json());

    if ('email' in body) {
      const result = await startEmailVerification({
        companyId: company.id,
        userId: user.id,
        connectorId: params.id,
        email: body.email,
      });
      return jsonOk({
        stage: 'code_sent',
        expiresAt: result.expiresAt.toISOString(),
      });
    }

    const { accountLabel } = await confirmEmailVerification({
      companyId: company.id,
      userId: user.id,
      connectorId: params.id,
      code: body.code,
    });
    return jsonOk({ stage: 'connected', accountLabel });
  } catch (error) {
    if (error instanceof ConnectorError) {
      return jsonError(error.message, error.status);
    }
    return handleRouteError(error);
  }
}

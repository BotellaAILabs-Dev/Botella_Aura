import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { isSameOrigin } from '@/lib/whatsapp-link';
import { cancelExecution, ExecutionActionError } from '@/server/execution/execution-actions.service';
import { InvalidTransitionError } from '@/lib/execution-state';

/** POST /api/executions/:id/cancel { reason? } — Scheduled (or waiting) → Cancelled. OWNER/ADMIN. */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ reason: z.string().trim().max(300).optional() });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isSameOrigin(req)) return jsonError('Cross-site request refused.', 403);
    const { company, user, membership } = await requireActiveCompany();
    const { reason } = bodySchema.parse(await req.json().catch(() => ({})));
    const execution = await cancelExecution({ companyId: company.id, userId: user.id, role: membership.role, id: params.id, reason });
    return jsonOk({ execution });
  } catch (error) {
    if (error instanceof ExecutionActionError) return jsonError(error.message, error.status, error.code ? { code: [error.code] } : undefined);
    if (error instanceof InvalidTransitionError) return jsonError(error.message, 409, { code: [error.code] });
    return handleRouteError(error);
  }
}

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { generateDigestForCompany } from '@/server/trends/digest.service';
import { recordAudit } from '@/server/services/audit.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import type { DigestPayload } from '@/server/trends/types';

/**
 * POST /api/trends/refresh — manual "Refresh digest" trigger for the active
 * company. Same idempotent generation as the cron job, scoped to one company.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const { active } = await resolveActiveCompany(user.id);
    if (!active) return jsonError('No active company', 400);

    const membership = await getMembership(user.id, active.id);
    if (!membership) return jsonError('Forbidden', 403);

    await recordAudit({
      action: 'TREND_DIGEST_REQUESTED',
      userId: user.id,
      companyId: active.id,
      metadata: { trigger: 'manual' },
      ...getRequestMeta(req),
    });

    const digest = await generateDigestForCompany({
      companyId: active.id,
      userId: user.id,
      trigger: 'manual',
    });

    const payload = digest.payload as unknown as DigestPayload;
    return jsonOk({
      id: digest.id,
      date: digest.date,
      itemCount: payload.items?.length ?? 0,
      model: payload.model,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

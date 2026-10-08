import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { getReadiness } from '@/server/recommendations/readiness.service';

/**
 * GET /api/recommendations/readiness — whether Aura has enough information to
 * recommend anything (lib/data-readiness.ts): ready / limited / blocked, each
 * missing piece in words, and the next step for it.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    return jsonOk({ readiness: await getReadiness(company.id) });
  } catch (error) {
    return handleRouteError(error);
  }
}

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { handoffToContentRequest } from '@/lib/recommendation-context-handoff';
import { getContextHandoff } from '@/server/recommendations/context-handoff.service';

/**
 * GET /api/recommendations/:id/handoff — the Recommendation Context Handoff
 * (lib/recommendation-context-handoff.ts, version 1): everything a content or
 * marketing brief needs, each value with its source, what is missing and what
 * that means, and whether it can go ahead (`readiness`). `contentRequest` is
 * the Content Studio generation request for it, ready to post — null when the
 * handoff is blocked or names no format.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const handoff = await getContextHandoff(company.id, params.id);
    if (!handoff) return jsonError('Recommendation not found', 404);
    return jsonOk({
      handoff,
      contentRequest: handoffToContentRequest(handoff),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

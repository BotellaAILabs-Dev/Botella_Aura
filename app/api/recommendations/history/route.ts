import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  HISTORY_OUTCOMES,
  type HistoryOutcome,
} from '@/lib/recommendation-history';
import { listRecommendationHistory } from '@/server/recommendations/history.service';

/**
 * GET /api/recommendations/history?outcome=&limit= — previous Aura
 * recommendations and what the business did with them, newest first
 * (lib/recommendation-history.ts): outcome, timestamps, who decided, what was
 * changed or made, the originating opportunity, whether Aura will suggest it
 * again — plus counts per outcome and the patterns ready for Marketing Memory.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const url = new URL(req.url);
    const outcome = url.searchParams.get('outcome');
    if (outcome && !(HISTORY_OUTCOMES as string[]).includes(outcome)) {
      return jsonError(
        `Unknown outcome. Use one of: ${HISTORY_OUTCOMES.join(', ')}.`,
        400,
      );
    }
    const limit = Math.min(
      200,
      Math.max(1, Number(url.searchParams.get('limit')) || 100),
    );
    const history = await listRecommendationHistory(company.id, {
      outcome: (outcome as HistoryOutcome | null) ?? undefined,
      limit,
    });
    return jsonOk(history);
  } catch (error) {
    return handleRouteError(error);
  }
}

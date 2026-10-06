import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { surfaceRecommendations } from '@/server/recommendations/ranking.service';

/**
 * GET /api/recommendations/surface?includeHidden=1
 *
 * The workspace's recommendations in the order to surface them now: each
 * with its rank, score, band (now / next / later), the factors behind it and
 * a one-line explanation (lib/recommendation-ranking.ts). Computed on every
 * read — not a stored ranking. Deferred ones are left out unless asked for.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const includeHidden =
      new URL(req.url).searchParams.get('includeHidden') === '1';
    const recommendations = await surfaceRecommendations(company.id, {
      includeHidden,
    });
    return jsonOk({ recommendations });
  } catch (error) {
    return handleRouteError(error);
  }
}

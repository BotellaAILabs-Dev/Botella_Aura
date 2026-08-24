import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import {
  generateIntelligenceSnapshot,
  getLatestIntelligence,
} from '@/server/intelligence/intelligence.service';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

// Scores every recent draft, then makes one high-effort advisory call.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** GET /api/intelligence — the latest computed snapshot (no recomputation). */
export async function GET() {
  try {
    const { company } = await requireActiveCompany();
    return jsonOk({ snapshot: await getLatestIntelligence(company.id) });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/intelligence — recompute today's snapshot. */
export async function POST() {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('You do not have permission to run this analysis.', 403);
    }
    const snapshot = await generateIntelligenceSnapshot({
      companyId: company.id,
      userId: user.id,
    });
    return jsonOk({
      overallScore: snapshot.overallScore,
      draftsAnalysed: snapshot.coverage.draftsAnalysed,
      suggestions: snapshot.suggestions.length,
      model: snapshot.model,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

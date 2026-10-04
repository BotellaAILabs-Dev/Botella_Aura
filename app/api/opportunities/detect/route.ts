import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { runAiDetection } from '@/server/opportunities/ai-detection.service';
import { runDetection } from '@/server/opportunities/detection.service';

/**
 * POST /api/opportunities/detect — refresh signals and run opportunity
 * detection now: the deterministic rules (lib/opportunity-detection.ts), then
 * AI-assisted detection for what the rules cannot judge
 * (lib/ai-opportunity-detection.ts). Returns what each found and recorded,
 * what was suppressed or rejected, and why.
 *
 * `?ai=0` runs the rules only. AI detection failing never fails the request:
 * its status and reason are reported under `ai`.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError(
        'Only owners and admins can run opportunity detection.',
        403,
      );
    }
    const run = await runDetection(company.id, { collect: true });
    if (!run) return jsonError('Company not found', 404);
    const withAi = new URL(req.url).searchParams.get('ai') !== '0';
    const ai = withAi
      ? await runAiDetection(company.id, { userId: user.id })
      : null;
    return jsonOk({ ...run, ai });
  } catch (error) {
    return handleRouteError(error);
  }
}

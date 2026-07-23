import { requireActiveCompany } from '@/lib/auth-helpers';
import { refineContentSchema } from '@/lib/validations/content';
import { getDraft } from '@/server/content/content.service';
import { refineDraft } from '@/server/content/generator';
import { ClaudeNotConfiguredError } from '@/server/ai/claude';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/content/drafts/:id/refine — regenerate with feedback ("make it
 * punchier"). Returns the draft to DRAFT status (must be re-approved).
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const { company, user } = await requireActiveCompany();
    const { feedback } = refineContentSchema.parse(await req.json());

    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);
    if (draft.status === 'PUBLISHED') {
      return jsonError('Published content cannot be refined.', 409);
    }

    const updated = await refineDraft({ draft, userId: user.id, feedback });
    return jsonOk({ id: updated.id, status: updated.status });
  } catch (error) {
    if (error instanceof ClaudeNotConfiguredError) {
      return jsonError('Refinement needs ANTHROPIC_API_KEY.', 503);
    }
    return handleRouteError(error);
  }
}

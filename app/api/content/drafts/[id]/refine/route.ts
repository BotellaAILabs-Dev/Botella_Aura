import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { refineContentSchema } from '@/lib/validations/content';
import { getDraft } from '@/server/content/content.service';
import { refineDraft } from '@/server/content/generator';
import { aiFailureMessage, ClaudeNotConfiguredError } from '@/server/ai/claude';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/content/drafts/:id/refine
 *   { action: 'regenerate' | 'shorten' | 'expand' | 'tone' | 'improve' | 'custom',
 *     tone?, feedback? }
 *
 * Rewrite a draft with one click, or follow a custom note ("make it
 * punchier" — `{ feedback }` alone still works). The previous version is kept
 * so it can be undone. Returns the draft to DRAFT status (must be re-approved).
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot change content.', 403);
    }
    const { action, tone, feedback } = refineContentSchema.parse(await req.json());

    const draft = await getDraft(company.id, params.id);
    if (!draft) return jsonError('Draft not found', 404);
    if (draft.status === 'PUBLISHED') {
      return jsonError('Published content cannot be refined.', 409);
    }

    const updated = await refineDraft({
      draft,
      userId: user.id,
      action,
      tone,
      feedback,
    });
    return jsonOk({ id: updated.id, status: updated.status });
  } catch (error) {
    if (error instanceof ClaudeNotConfiguredError) {
      return jsonError(
        'No AI writer is configured on this server. Add GEMINI_API_KEY (or ANTHROPIC_API_KEY) to the server environment.',
        503,
      );
    }
    const ai = aiFailureMessage(error);
    if (ai) return jsonError(ai, 503);
    return handleRouteError(error);
  }
}

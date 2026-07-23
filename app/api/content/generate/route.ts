import { requireActiveCompany } from '@/lib/auth-helpers';
import { generateContentSchema } from '@/lib/validations/content';
import { generateDraft } from '@/server/content/generator';
import { ClaudeNotConfiguredError } from '@/server/ai/claude';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/content/generate — generate a new draft from a trend/brief/campaign.
 * Returns the created draft id so the client can navigate to the detail view.
 */
export async function POST(req: Request) {
  try {
    const { company, user } = await requireActiveCompany();
    const input = generateContentSchema.parse(await req.json());

    const draft = await generateDraft({
      companyId: company.id,
      userId: user.id,
      type: input.type,
      source: input.source,
      campaignId: input.campaignId,
    });

    return jsonOk({ id: draft.id, type: draft.type, status: draft.status }, 201);
  } catch (error) {
    if (error instanceof ClaudeNotConfiguredError) {
      return jsonError(
        'Content generation needs ANTHROPIC_API_KEY. Add it to enable the AI writer.',
        503,
      );
    }
    return handleRouteError(error);
  }
}

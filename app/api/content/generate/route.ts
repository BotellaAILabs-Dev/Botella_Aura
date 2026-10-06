import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { generateContentSchema } from '@/lib/validations/content';
import { generateDraft } from '@/server/content/generator';
import { getEnabledContentTypes } from '@/server/company/profile.service';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import { ClaudeNotConfiguredError } from '@/server/ai/claude';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';

/**
 * POST /api/content/generate — generate a new draft from a trend/brief/campaign.
 * Returns the created draft id so the client can navigate to the detail view.
 */
export async function POST(req: Request) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot create content.', 403);
    }
    const input = generateContentSchema.parse(await req.json());

    // The composer already hides formats this workspace turned off; this is
    // what stops the same request succeeding when posted directly.
    const enabled = await getEnabledContentTypes(company.id);
    if (!enabled.includes(input.type)) {
      return jsonError(
        `${CONTENT_TYPE_LABELS[input.type]} is turned off for this workspace. ` +
          'Enable it in Settings → Content formats.',
        400,
      );
    }

    const draft = await generateDraft({
      companyId: company.id,
      userId: user.id,
      type: input.type,
      source: input.source,
      campaignId: input.campaignId,
      platform: input.platform,
      variations: input.variations,
      tone: input.tone,
    });

    return jsonOk({ id: draft.id, type: draft.type, status: draft.status }, 201);
  } catch (error) {
    if (error instanceof ClaudeNotConfiguredError) {
      return jsonError(
        'No AI writer is configured on this server. Add GEMINI_API_KEY (or ANTHROPIC_API_KEY) to the server environment.',
        503,
      );
    }
    return handleRouteError(error);
  }
}

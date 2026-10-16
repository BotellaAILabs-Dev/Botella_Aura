import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { generateContentSchema } from '@/lib/validations/content';
import { generateDraft } from '@/server/content/generator';
import { getEnabledContentTypes } from '@/server/company/profile.service';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import { ClaudeNotConfiguredError } from '@/server/ai/claude';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  getCreation,
  recordCreation,
} from '@/server/recommendations/creation.service';
import { validateContentBrief } from '@/lib/content-brief';
import { getContentBrief } from '@/server/content/content-brief.service';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

// Writing makes several model calls; give it the platform's full budget.
export const maxDuration = 60;

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

    // A retry of a request that already wrote its draft gets that draft back.
    if (input.idempotencyKey) {
      const already = await db.contentDraft.findFirst({
        where: { companyId: company.id, createdById: user.id, aiMetadata: { path: ['idempotencyKey'], equals: input.idempotencyKey } },
        select: { id: true, type: true, status: true },
      });
      if (already) return jsonOk({ ...already, reused: true }, 200);
    }

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

    // Only this workspace's recommendation is remembered; anything else is
    // ignored rather than trusted (lib/recommendation-creation.ts).
    const creation = input.recommendationId
      ? await getCreation(company.id, input.recommendationId, 'content-studio')
      : null;
    // Asked to write for a suggestion that is gone (removed, or not this
    // workspace's): say so — never write an unlinked, generic draft instead.
    if (input.recommendationId && !creation) {
      return jsonOk(
        {
          error: 'This suggestion is no longer available. Your brief is kept — write the post without it, or pick another suggestion.',
          fix: { label: 'See Aura Suggests', href: '/dashboard/suggestions' },
        },
        409,
      );
    }
    if (creation && !creation.plan.canCreate) {
      // Nothing to write (connect a channel), already closed, or missing
      // something required — said plainly, with where to go instead.
      return jsonOk(
        {
          error:
            creation.plan.message ?? 'There is nothing to write from this suggestion.',
          fix: creation.plan.fix,
        },
        409,
      );
    }
    if (creation?.plan.acceptsOnCreate) {
      // The page says yes first (POST /api/recommendations/:id/creation); a
      // draft is never written for a suggestion nobody has agreed to.
      return jsonError(
        'Say yes to this suggestion first — then Aura writes it.',
        409,
      );
    }
    // The Content Brief (lib/content-brief.ts) for exactly what is being
    // made — the person's format and network — checked before anything is
    // written. It is what the writer is held to and what the draft keeps.
    const brief = creation
      ? await getContentBrief(company.id, creation.plan.recommendationId, {
          type: input.type,
          ...(input.platform ? { platform: input.platform } : {}),
        })
      : null;
    if (brief) {
      const check = validateContentBrief(brief);
      if (!check.ok) {
        return jsonOk(
          {
            error: `The brief isn’t complete: ${check.errors[0]}`,
            errors: check.errors,
            fix: brief.missing.find((m) => m.requirement === 'required')?.fix ?? null,
          },
          409,
        );
      }
    }
    // Everything it carries, from the server's record rather than the
    // editable brief: opportunity, reason, evidence, goal, audience, business.
    const recommendation = creation?.provenance
      ? {
          id: creation.provenance.recommendationId,
          title: creation.provenance.title,
          provenance: creation.provenance,
          brief,
        }
      : null;
    const draft = await generateDraft({
      companyId: company.id,
      userId: user.id,
      type: input.type,
      source: input.source,
      campaignId: input.campaignId,
      platform: input.platform,
      variations: input.variations,
      tone: input.tone,
      recommendation,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    if (recommendation) {
      // The draft exists and keeps its provenance either way; a failure to
      // record it in the suggestion's history must not lose the person's draft.
      try {
        await recordCreation({
          companyId: company.id,
          recommendationId: recommendation.id,
          module: 'content-studio',
          created: { type: 'content-draft', id: draft.id, label: draft.title },
          actorId: user.id,
        });
      } catch (err) {
        logger.warn('generate: draft written but not recorded on the suggestion', {
          draftId: draft.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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

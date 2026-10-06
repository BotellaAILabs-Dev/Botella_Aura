import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  EDITABLE_FIELDS,
  RECOMMENDATION_STATUSES,
} from '@/lib/recommendations';
import {
  editRecommendation,
  getRecommendation,
} from '@/server/recommendations/recommendation.service';

/**
 * GET /api/recommendations/:id — one recommendation: what, why, action,
 * expected outcome, channel, audience, confidence, priority, status and its
 * history, its evidence, its originating opportunity, and `execution` — the
 * brief handed to the workflow that carries it out (lib/recommendations.ts).
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const recommendation = await getRecommendation(company.id, params.id);
    if (!recommendation) return jsonError('Recommendation not found', 404);
    return jsonOk({ recommendation });
  } catch (error) {
    return handleRouteError(error);
  }
}

const editSchema = z.object({
  changes: z
    .object(
      Object.fromEntries(
        EDITABLE_FIELDS.map((f) => [f, z.unknown()]),
      ) as Record<(typeof EDITABLE_FIELDS)[number], z.ZodUnknown>,
    )
    .partial()
    .strict()
    .refine((c) => Object.keys(c).length > 0, {
      message: 'Nothing to change.',
    }),
  note: z.string().trim().max(2000).optional(),
  expectedStatus: z.enum(RECOMMENDATION_STATUSES).optional(),
});

/**
 * PATCH /api/recommendations/:id { changes, note?, expectedStatus? }
 *
 * Edit: accept the recommendation with changes (status EDITED). Only
 * EDITABLE_FIELDS may change — never its evidence, link or assessment. Every
 * changed field is kept in its history from → to; an edit that changes
 * nothing is a no-op (`changed: false`).
 */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError(
        'Only owners and admins can edit a recommendation.',
        403,
      );
    }
    const { changes, note, expectedStatus } = editSchema.parse(
      await req.json(),
    );
    const { changed, ...recommendation } = await editRecommendation({
      companyId: company.id,
      recommendationId: params.id,
      changes,
      actorId: user.id,
      note,
      expectedStatus,
    });
    return jsonOk({ recommendation, changed });
  } catch (error) {
    return handleRouteError(error);
  }
}

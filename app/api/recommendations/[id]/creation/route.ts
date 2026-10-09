import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { AURA_MODULE_IDS } from '@/lib/aura-modules';
import { handoffToContentRequest } from '@/lib/recommendation-context-handoff';
import {
  getCreation,
  startCreation,
  type Creation,
} from '@/server/recommendations/creation.service';

/**
 * /api/recommendations/:id/creation — creating from a recommendation
 * (lib/recommendation-creation.ts).
 *
 *   GET   what "Create" means for it: the workflow, what it creates, whether it
 *         can happen now (`plan.state`) and why not, with the context any
 *         creation keeps (`provenance`) and, for content, the Content Studio
 *         request ready to post (`contentRequest`).
 *   POST  { module? } — get ready to create: says yes to it if still open
 *         (owners and admins only, like any decision), or 409 with the plain
 *         reason it cannot be created from. Returns the same shape, with
 *         `plan.href` the workflow to open.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ module: z.enum(AURA_MODULE_IDS).optional() });

function view(c: Creation) {
  return {
    plan: c.plan,
    provenance: c.provenance,
    contentRequest:
      c.plan.canCreate && c.plan.kind !== 'action'
        ? handoffToContentRequest(c.handoff)
        : null,
  };
}

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company } = await requireActiveCompany();
    const target = bodySchema.parse({
      module: new URL(req.url).searchParams.get('module') ?? undefined,
    }).module;
    const creation = await getCreation(company.id, params.id, target);
    if (!creation) return jsonError('Recommendation not found', 404);
    return jsonOk(view(creation));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError(
        'Your role is read-only and cannot create content.',
        403,
      );
    }
    const { module } = bodySchema.parse(await req.json().catch(() => ({})));

    const current = await getCreation(company.id, params.id, module);
    if (!current) return jsonError('Recommendation not found', 404);
    // Creating from an open suggestion says yes to it — a decision, which only
    // owners and admins make.
    if (
      current.plan.acceptsOnCreate &&
      !can(membership.role, 'company:update')
    ) {
      return jsonError(
        'Only owners and admins can say yes to a suggestion. Ask one to accept it — then you can create from it.',
        403,
      );
    }
    const creation = await startCreation({
      companyId: company.id,
      recommendationId: params.id,
      actorId: user.id,
      ...(module ? { module } : {}),
    });
    return jsonOk(view(creation));
  } catch (error) {
    return handleRouteError(error);
  }
}

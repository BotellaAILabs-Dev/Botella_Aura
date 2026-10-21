import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { aiFailureMessage, ClaudeNotConfiguredError } from '@/server/ai/claude';
import { getReviewItem } from '@/server/review/review-item.service';
import { runReviewAction } from '@/server/review/review-actions.service';

/**
 * The unified review (lib/review-item.ts) for one item of generated work.
 *
 *   GET   /api/review/:kind/:id — the item: content, asset, context, flags,
 *         reviewer feedback, and which actions are available
 *   POST  /api/review/:kind/:id — { action: save | regenerate | submit |
 *         approve | reject | schedule, … }, delegated to the module's service
 *
 * kind: content | outreach.
 */
export const maxDuration = 60;

const kindSchema = z.enum(['content', 'outreach']);

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    edits: z.record(z.string().max(20_000)),
    baseUpdatedAt: z.string().optional(),
  }),
  z.object({
    action: z.literal('regenerate'),
    mode: z.enum(['fresh', 'fix_review', 'instructions']).default('fresh'),
    instructions: z.string().trim().max(1000).optional(),
  }),
  z.object({ action: z.literal('submit') }),
  z.object({ action: z.literal('approve'), confirmed: z.boolean().optional() }),
  z.object({
    action: z.literal('reject'),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal('schedule'),
    // An exact instant, or a wall time in the workspace's timezone.
    scheduledFor: z.string().datetime({ offset: true }).optional(),
    localTime: z.string().trim().max(32).optional(),
    timeZone: z.string().trim().max(64).optional(),
  }),
]);

export async function GET(
  _req: Request,
  { params }: { params: { kind: string; id: string } },
) {
  try {
    const kind = kindSchema.safeParse(params.kind);
    if (!kind.success) return jsonError('Not found.', 404);
    const { company, membership } = await requireActiveCompany();
    const item = await getReviewItem(
      kind.data,
      company.id,
      params.id,
      membership.role,
    );
    if (!item) return jsonError('Not found.', 404);
    return jsonOk({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: { kind: string; id: string } },
) {
  try {
    const kind = kindSchema.safeParse(params.kind);
    if (!kind.success) return jsonError('Not found.', 404);
    const { company, user, membership } = await requireActiveCompany();
    const input = actionSchema.parse(await req.json());
    const result = await runReviewAction({
      kind: kind.data,
      id: params.id,
      companyId: company.id,
      userId: user.id,
      role: membership.role,
      input,
      requestMeta: getRequestMeta(req),
    });
    return jsonOk(result);
  } catch (error) {
    if (error instanceof ClaudeNotConfiguredError) {
      return jsonError('No AI writer is configured on this server.', 503);
    }
    const ai = aiFailureMessage(error);
    if (ai) return jsonError(ai, 503);
    return handleRouteError(error);
  }
}

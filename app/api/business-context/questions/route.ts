import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';
import {
  WORKFLOW_PRESETS,
  type ContextWorkflow,
} from '@/server/business-context/business-context.service';
import {
  answerQuestion,
  getQuestions,
  setQuestionAside,
} from '@/server/business-context/questions.service';

/**
 * Questions Aura has about the business.
 *
 * GET  ?workflow=content|opportunity|…&limit=3&markAsked=1
 *      The questions worth asking now — critical first, never one the user
 *      dismissed, put off, or has been asked too often. `markAsked=1` records
 *      that they were shown (counted at most once per 12 hours).
 * POST { key, action: 'answer', answer: { value } | { confirm: true } }
 *      { key, action: 'snooze' | 'dismiss' }
 *      Answering updates the Business Context through the same validated
 *      write path as every other edit. Returns the next questions.
 */
export const dynamic = 'force-dynamic';

const WORKFLOWS = Object.keys(WORKFLOW_PRESETS) as [
  ContextWorkflow,
  ...ContextWorkflow[],
];

const querySchema = z.object({
  workflow: z.enum(WORKFLOWS).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(3),
  markAsked: z
    .enum(['1', '0', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    key: z.string().max(80),
    action: z.literal('answer'),
    answer: z.unknown(),
  }),
  z.object({ key: z.string().max(80), action: z.enum(['snooze', 'dismiss']) }),
]);

export async function GET(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const { workflow, limit, markAsked } = querySchema.parse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    const result = await getQuestions(company.id, {
      workflow,
      limit,
      markAsked,
    });
    if (!result) return jsonError('Company not found', 404);
    return jsonOk(result);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(req: Request) {
  try {
    const { company, membership, user } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError(
        'Only owners and admins can answer questions about the business.',
        403,
      );
    }
    const body = actionSchema.parse(await req.json());

    let changed: string[] = [];
    let confirmed: string[] = [];
    if (body.action === 'answer') {
      ({ changed, confirmed } = await answerQuestion({
        companyId: company.id,
        userId: user.id,
        key: body.key,
        answer: body.answer,
        requestMeta: getRequestMeta(req),
      }));
    } else {
      await setQuestionAside({
        companyId: company.id,
        key: body.key,
        mode: body.action,
      });
    }

    const next = await getQuestions(company.id);
    return jsonOk({ changed, confirmed, ...next });
  } catch (error) {
    return handleRouteError(error);
  }
}

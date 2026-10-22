import type { ContentDraft } from '@prisma/client';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { aiFailureMessage } from '@/server/ai/claude';
import { getDraft } from '@/server/content/content.service';
import { VariationError } from '@/server/content/variations.service';

/**
 * Shared by the per-version routes (…/variations/:index/*, …/variations/more):
 * the person may create content, is within the rate limit, and the draft is
 * theirs. Returns a Response to send instead when any of that fails.
 */
export async function versionRequest(
  draftId: string,
  opts: { limitKey: string; limit: number },
): Promise<{ draft: ContentDraft; userId: string } | Response> {
  const { company, user, membership } = await requireActiveCompany();
  if (!can(membership.role, 'content:create')) {
    return jsonError('Your role is read-only and cannot change content.', 403);
  }
  const limit = rateLimit(`${opts.limitKey}:${user.id}`, { limit: opts.limit, windowMs: 60_000 });
  if (!limit.allowed) return jsonError(`Slow down a moment — try again in ${limit.retryAfterSeconds}s.`, 429);
  const draft = await getDraft(company.id, draftId);
  if (!draft) return jsonError('Draft not found', 404);
  return { draft, userId: user.id };
}

/** The index from the URL, or null when it is not a version number. */
export function versionIndex(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < 8 ? n : null;
}

export function versionError(error: unknown): Response {
  if (error instanceof VariationError) return jsonError(error.message, error.status);
  const ai = aiFailureMessage(error);
  if (ai) return jsonError(ai, 503);
  return handleRouteError(error);
}

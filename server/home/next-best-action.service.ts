import type { CompanyRole } from '@prisma/client';

import { attentionItems } from '@/lib/business-context-ui';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { buildNextActions, type NextAction } from '@/lib/next-best-action';
import { can } from '@/lib/rbac';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import { getMarketingGaps } from '@/server/intelligence/marketing-gaps.service';
import { getSuggestions } from '@/server/recommendations/suggestions.service';

/**
 * Loads everything lib/next-best-action.ts ranks. Each source is optional:
 * if one fails (a quota, a slow query) the others still give an answer,
 * rather than the whole list disappearing.
 */
export async function getNextActions(
  companyId: string,
  role: CompanyRole,
  options: { limit?: number; now?: Date } = {},
): Promise<NextAction[]> {
  const settle = async <T>(what: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      logger.warn('next-best-action: source unavailable', { what, companyId, error: err instanceof Error ? err.message : String(err) });
      return fallback;
    }
  };
  const [ctx, pendingApproval, suggestions, gaps] = await Promise.all([
    settle('business context', getBusinessContext(companyId, { sections: [] }), null),
    settle('approvals', db.contentDraft.count({ where: { companyId, status: 'PENDING_APPROVAL' } }), 0),
    settle('suggestions', getSuggestions(companyId, { limit: 10, ...(options.now ? { now: options.now } : {}) }), null),
    settle('gaps', getMarketingGaps(companyId, options.now), []),
  ]);
  return buildNextActions(
    {
      attention: ctx ? attentionItems(ctx) : [],
      pendingApproval,
      suggestions: suggestions?.suggestions ?? [],
      gaps,
      canApprove: can(role, 'content:approve'),
    },
    options.limit,
  );
}

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { LIVE_RECOMMENDATION_STATUSES } from '@/lib/recommendations';
import { generateRecommendation } from './engine.service';

/**
 * Aura suggests on its own.
 *
 * Before this, a recommendation was only ever made when a person pressed
 * "Recommend" on an opportunity — so Aura Suggests stayed empty until someone
 * did Aura's job for it. This pass runs the engine over the workspace's open
 * opportunities that have no recommendation in play, best first.
 *
 * The engine's guardrails still decide (lib/recommendation-rules.ts): an
 * opportunity that is not eligible, lacks evidence, would duplicate another
 * recommendation or exceed the daily / per-channel limits is skipped, with
 * the engine's reason. Nothing is forced through.
 *
 * Runs after every detection (POST /api/opportunities/detect) and from the
 * "Get Aura's suggestions" button (POST /api/recommendations/generate).
 */

/** Opportunities that could get a suggestion: open, and none in play for them. */
export async function openOpportunitiesWithoutSuggestion(companyId: string) {
  return db.opportunity.findMany({
    where: {
      companyId,
      status: { in: ['DETECTED', 'REVIEWED'] },
      recommendations: {
        none: { status: { in: LIVE_RECOMMENDATION_STATUSES } },
      },
    },
    orderBy: [{ priorityScore: 'desc' }, { detectedAt: 'desc' }],
    select: { id: true, title: true },
  });
}

export interface AutoSuggestReport {
  created: { opportunityId: string; recommendationId: string; title: string }[];
  skipped: { opportunityId: string; title: string; reasons: string[] }[];
  /** Left for the next run (the time budget or the limit was reached). */
  remaining: number;
}

export async function suggestFromOpportunities(
  companyId: string,
  options: {
    /** Most opportunities to try in one run. */
    limit?: number;
    /** Stop starting new ones after this long (keeps a request inside its budget). */
    budgetMs?: number;
    /** Skip the model and write from templates (tests, or when speed matters). */
    templatesOnly?: boolean;
    now?: Date;
  } = {},
): Promise<AutoSuggestReport> {
  const limit = options.limit ?? 5;
  const budgetMs = options.budgetMs ?? 40_000;
  const started = Date.now();
  const open = await openOpportunitiesWithoutSuggestion(companyId);
  const report: AutoSuggestReport = { created: [], skipped: [], remaining: 0 };

  let tried = 0;
  for (const o of open) {
    if (tried >= limit || Date.now() - started > budgetMs) {
      report.remaining = open.length - tried;
      break;
    }
    tried += 1;
    try {
      const g = await generateRecommendation({
        companyId,
        opportunityId: o.id,
        actorId: null,
        templatesOnly: options.templatesOnly,
        now: options.now,
      });
      if (g.recommendationId && g.status !== 'rejected') {
        report.created.push({
          opportunityId: o.id,
          recommendationId: g.recommendationId,
          title: o.title,
        });
      } else {
        report.skipped.push({
          opportunityId: o.id,
          title: o.title,
          reasons: g.reasons,
        });
      }
    } catch (error) {
      // One opportunity failing never stops the rest.
      const reason = error instanceof Error ? error.message : String(error);
      report.skipped.push({
        opportunityId: o.id,
        title: o.title,
        reasons: [reason],
      });
      logger.warn('autosuggest: opportunity skipped', {
        companyId,
        opportunityId: o.id,
        error: reason,
      });
    }
  }
  return report;
}

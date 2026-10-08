import { db } from '@/lib/db';
import { ACTIVE_STATUSES } from '@/lib/opportunities';
import { logger } from '@/lib/logger';
import { LIVE_RECOMMENDATION_STATUSES } from '@/lib/recommendations';
import { generateRecommendation } from './engine.service';
import { repeatHolds } from './history.service';
import { getRecommendationQuality } from './quality.service';
import { transitionRecommendation } from './recommendation.service';

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
 * History is respected (lib/recommendation-history.ts repeatHold): an
 * opportunity whose suggestion was just skipped is not suggested again until
 * its hold ends. A person pressing "Recommend" is never held back.
 *
 * Runs after every detection (POST /api/opportunities/detect) and from the
 * "Get Aura's suggestions" button (POST /api/recommendations/generate).
 */

/**
 * Opportunities that could get a suggestion: open, none in play for them, and
 * not held back by what happened to their last one (repeatHold — a skip waits
 * 14 days, so it is not answered by the same suggestion tomorrow).
 */
export async function openOpportunitiesWithoutSuggestion(
  companyId: string,
  now: Date = new Date(),
) {
  const open = await db.opportunity.findMany({
    where: {
      companyId,
      // RECOMMENDED with none in play: its suggestion was skipped, withdrawn
      // or expired — eligible again once its repeat hold ends.
      status: { in: ACTIVE_STATUSES },
      recommendations: {
        none: { status: { in: LIVE_RECOMMENDATION_STATUSES } },
      },
    },
    orderBy: [{ priorityScore: 'desc' }, { detectedAt: 'desc' }],
    select: { id: true, title: true },
  });
  const holds = await repeatHolds(
    companyId,
    open.map((o) => o.id),
    now,
  );
  return open.filter((o) => !holds.get(o.id)?.held);
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
  const open = await openOpportunitiesWithoutSuggestion(companyId, options.now);
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
      // Quality check straight after writing: a suggestion that fails one is
      // withdrawn — never shown — with the reasons in its history, and the
      // repeat hold stops it being made again tomorrow.
      const quality =
        g.recommendationId && g.status !== 'rejected'
          ? await getRecommendationQuality(
              companyId,
              g.recommendationId,
              options.now,
            )
          : null;
      if (g.recommendationId && quality?.verdict === 'blocked') {
        await transitionRecommendation({
          companyId,
          recommendationId: g.recommendationId,
          to: 'WITHDRAWN',
          actorId: null,
          source: 'system',
          note: `Failed Aura’s quality checks: ${quality.problems.join('; ')}`.slice(
            0,
            2000,
          ),
          metadata: {
            qualityCheck: {
              verdict: quality.verdict,
              problems: quality.problems,
            },
          },
          now: options.now,
        }).catch(() => undefined);
        report.skipped.push({
          opportunityId: o.id,
          title: o.title,
          reasons: quality.problems.map((p) => `quality check: ${p}`),
        });
      } else if (g.recommendationId && g.status !== 'rejected') {
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

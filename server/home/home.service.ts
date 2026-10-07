import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  activeOpportunities,
  buildActivity,
  buildResults,
  recommendationActivity,
  splitWeeks,
  whatMattersNow,
  type ActivityInput,
  type ActivityItem,
  type HomeCounts,
  type HomeOpportunity,
  type MatterItem,
  type ResultTile,
  type ResultsInput,
} from '@/lib/aura-home';
import type { SuggestionView } from '@/lib/aura-suggests';
import { toOpportunityView } from '@/lib/opportunity-ui';
import { getAnalytics } from '@/server/analytics/analytics.service';
import { listOpportunitiesForView } from '@/server/opportunities/opportunity.service';
import { getSuggestions } from '@/server/recommendations/suggestions.service';

/**
 * Everything Aura Home shows (lib/aura-home.ts), loaded live and in parallel.
 *
 * Each part is loaded on its own: if one source fails (analytics, say), that
 * part is left out and logged, and the rest of Home still renders. Home must
 * never be the page that breaks.
 */

const DAY = 86_400_000;

/** Capitalised and ending in a full stop, as a person would write it. */
function sentence(text: string | null): string | null {
  const t = text?.trim();
  if (!t) return null;
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]["”’)]?$/.test(cap) ? cap : `${cap}.`;
}

export interface AuraHome {
  matters: MatterItem[];
  suggestions: SuggestionView[];
  suggestionCount: number;
  accepted: SuggestionView[];
  opportunities: HomeOpportunity[];
  opportunityCount: number;
  results: ResultTile[] | null;
  activity: ActivityItem[];
}

async function part<T>(
  name: string,
  companyId: string,
  fallback: T,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    logger.warn(`home: ${name} unavailable`, {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

async function loadCounts(companyId: string): Promise<HomeCounts> {
  const [pendingApproval, approvedUnscheduled, newLeads, outreachReady] =
    await Promise.all([
      db.contentDraft.count({
        where: { companyId, status: 'PENDING_APPROVAL' },
      }),
      db.contentDraft.count({
        where: {
          companyId,
          status: 'APPROVED',
          scheduledFor: null,
          publishedAt: null,
        },
      }),
      db.lead.count({ where: { companyId, status: 'NEW' } }),
      db.outreachMessage.count({ where: { companyId, status: 'APPROVED' } }),
    ]);
  return { pendingApproval, approvedUnscheduled, newLeads, outreachReady };
}

async function loadOpportunities(
  companyId: string,
  now: Date,
): Promise<HomeOpportunity[]> {
  const rows = await listOpportunitiesForView(companyId, { now, limit: 100 });
  return rows
    .map((r) => toOpportunityView(r, now))
    .filter((o) => o.statusGroup === 'active')
    .map((o) => ({
      id: o.id,
      title: o.title,
      typeLabel: o.typeLabel,
      why: sentence(o.why[0] ?? o.summary),
      status: o.status,
      priorityScore: o.priorityScore,
      daysLeft: o.daysLeft,
      detectedAt: new Date(o.detectedAt),
    }));
}

async function loadResults(
  companyId: string,
  now: Date,
): Promise<ResultsInput> {
  const since30 = new Date(now.getTime() - 30 * DAY);
  const [analytics, health, answered, actedOn] = await Promise.all([
    getAnalytics(companyId, 14),
    db.intelligenceSnapshot.findMany({
      where: { companyId },
      orderBy: { date: 'desc' },
      take: 2,
      select: { overallScore: true },
    }),
    db.recommendation.count({
      where: {
        companyId,
        decidedAt: { gte: since30 },
        status: {
          in: [
            'ACCEPTED',
            'EDITED',
            'SKIPPED',
            'REJECTED',
            'IN_PROGRESS',
            'COMPLETED',
          ],
        },
      },
    }),
    db.recommendation.count({
      where: {
        companyId,
        decidedAt: { gte: since30 },
        status: { in: ['ACCEPTED', 'EDITED', 'IN_PROGRESS', 'COMPLETED'] },
      },
    }),
  ]);
  const posts = splitWeeks(
    analytics.contentVolume.map((v) => ({ date: v.date, value: v.count })),
    now,
  );
  const engagement = splitWeeks(
    analytics.engagementTrend.map((e) => ({
      date: e.date,
      value: e.engagement,
    })),
    now,
  );
  return {
    hasData: analytics.hasData,
    postsThisWeek: posts.thisWeek,
    postsLastWeek: posts.lastWeek,
    engagementThisWeek: engagement.thisWeek,
    engagementLastWeek: engagement.lastWeek,
    health: health[0]
      ? {
          score: health[0].overallScore,
          previous: health[1]?.overallScore ?? null,
        }
      : null,
    suggestionsAnswered: answered,
    suggestionsActedOn: actedOn,
  };
}

/** What Aura and the team did over the last two weeks, from the real records. */
async function loadActivity(
  companyId: string,
  now: Date,
): Promise<ActivityItem[]> {
  const since = new Date(now.getTime() - 14 * DAY);
  const [recEvents, opps, drafts, published, snapshots, briefings] =
    await Promise.all([
      db.recommendationEvent.findMany({
        where: {
          createdAt: { gte: since },
          recommendation: { companyId },
          action: { notIn: ['present', 'withdraw'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: {
          action: true,
          actorId: true,
          createdAt: true,
          recommendation: { select: { title: true } },
        },
      }),
      db.opportunity.findMany({
        where: { companyId, detectedAt: { gte: since } },
        orderBy: { detectedAt: 'desc' },
        take: 10,
        select: { id: true, title: true, detectedAt: true },
      }),
      db.contentDraft.findMany({
        where: { companyId, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, title: true, createdById: true, createdAt: true },
      }),
      db.contentDraft.findMany({
        where: { companyId, publishedAt: { gte: since } },
        orderBy: { publishedAt: 'desc' },
        take: 10,
        select: { id: true, title: true, publishedAt: true },
      }),
      db.competitorSnapshot.findMany({
        where: {
          capturedAt: { gte: since },
          competitor: { companyId },
          changesSummary: { path: ['hasChanges'], equals: true },
        },
        orderBy: { capturedAt: 'desc' },
        take: 5,
        select: {
          capturedAt: true,
          competitor: { select: { name: true } },
        },
      }),
      db.workspaceBriefing.findMany({
        where: { companyId, status: 'READY', generatedAt: { gte: since } },
        orderBy: { generatedAt: 'desc' },
        take: 2,
        select: { generatedAt: true },
      }),
    ]);

  const actorIds = [
    ...new Set(
      [
        ...recEvents.map((e) => e.actorId),
        ...drafts.map((d) => d.createdById),
      ].filter((x): x is string => Boolean(x)),
    ),
  ];
  const people = actorIds.length
    ? await db.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const nameOf = new Map(
    people.map((u) => [u.id, u.name?.split(' ')[0] || u.email.split('@')[0]!]),
  );
  const who = (id: string | null) =>
    id ? (nameOf.get(id) ?? 'Someone') : 'aura';

  const items: ActivityInput[] = [];
  for (const e of recEvents) {
    const text = recommendationActivity(e.action, e.recommendation.title);
    if (!text) continue;
    items.push({
      at: e.createdAt,
      by: e.action === 'expire' ? 'aura' : who(e.actorId),
      text,
      href: '/dashboard/suggestions',
      ...(e.action === 'generate' && !e.actorId
        ? { group: 'suggested' as const }
        : {}),
    });
  }
  for (const o of opps) {
    items.push({
      at: o.detectedAt,
      by: 'aura',
      text: `spotted an opportunity: “${o.title}”`,
      href: `/dashboard/opportunities?focus=${o.id}`,
      group: 'spotted',
    });
  }
  for (const d of drafts) {
    items.push({
      at: d.createdAt,
      by: who(d.createdById),
      text: d.createdById
        ? `started “${d.title || 'a new post'}”`
        : `wrote “${d.title || 'a new post'}”`,
      href: `/dashboard/content/${d.id}`,
      ...(d.createdById ? {} : { group: 'wrote' as const }),
    });
  }
  for (const d of published) {
    items.push({
      at: d.publishedAt!,
      by: 'aura',
      text: `published “${d.title || 'a post'}”`,
      href: `/dashboard/content/${d.id}`,
      group: 'published',
    });
  }
  for (const s of snapshots) {
    items.push({
      at: s.capturedAt,
      by: 'aura',
      text: `noticed a change at ${s.competitor.name}`,
      href: '/dashboard/competitors',
    });
  }
  for (const b of briefings) {
    items.push({
      at: b.generatedAt,
      by: 'aura',
      text: 'put together your weekly briefing',
      href: null,
    });
  }
  return buildActivity(items, now);
}

export async function getAuraHome(
  companyId: string,
  now: Date = new Date(),
): Promise<AuraHome> {
  const [suggested, counts, opportunities, resultsInput, activity] =
    await Promise.all([
      part('suggestions', companyId, { suggestions: [], accepted: [] }, () =>
        getSuggestions(companyId, { now }),
      ),
      part<HomeCounts>(
        'counts',
        companyId,
        {
          pendingApproval: 0,
          approvedUnscheduled: 0,
          newLeads: 0,
          outreachReady: 0,
        },
        () => loadCounts(companyId),
      ),
      part('opportunities', companyId, [] as HomeOpportunity[], () =>
        loadOpportunities(companyId, now),
      ),
      part('results', companyId, null as ResultsInput | null, () =>
        loadResults(companyId, now),
      ),
      part('activity', companyId, [] as ActivityItem[], () =>
        loadActivity(companyId, now),
      ),
    ]);

  return {
    matters: whatMattersNow({
      suggestions: suggested.suggestions,
      accepted: suggested.accepted,
      opportunities,
      counts,
      results: resultsInput,
    }),
    suggestions: suggested.suggestions.slice(0, 3),
    suggestionCount: suggested.suggestions.length,
    accepted: suggested.accepted,
    opportunities: activeOpportunities(opportunities),
    opportunityCount: opportunities.length,
    results: resultsInput ? buildResults(resultsInput) : null,
    activity,
  };
}

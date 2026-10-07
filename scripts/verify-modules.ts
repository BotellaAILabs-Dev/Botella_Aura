/**
 * Proves recommendations are connected to Aura's modules, on what the real
 * engine produces:
 *
 *   · each recommendation identifies the module that carries it out (and the
 *     related ones), with a destination that carries the recommendation
 *   · the engine records what the receiving module needs (competitor,
 *     metric, topic) so the hand-off has something real to pass
 *   · the context a module receives is the workspace's own, never another's
 *   · a module making something from it is recorded in its history, and
 *     each module gets typed hand-off data a creation workflow can consume
 *
 * Run: pnpm verify:modules
 *
 * Everything lives in throwaway workspaces, deleted at the end.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { AURA_MODULES, AURA_MODULE_IDS } from '@/lib/aura-modules';
import { executionBrief } from '@/lib/recommendations';
import { runDetection } from '@/server/opportunities/detection.service';
import {
  getRecommendationContext,
  getRecommendationHandoff,
  linkRecommendation,
  ownRecommendation,
} from '@/server/recommendations/context.service';
import { generateRecommendation } from '@/server/recommendations/engine.service';
import { getRecommendationHistory } from '@/server/recommendations/recommendation.service';
import { getSuggestions } from '@/server/recommendations/suggestions.service';
import { collectSignals } from '@/server/signals/signal.service';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

async function main() {
  const stamp = Date.now();
  const company = await db.company.create({
    data: {
      name: 'zzverify modules',
      slug: `zzverify-modules-${stamp}`,
      industry: 'Coffee',
      preferences: {
        business: {
          description: 'We roast single-origin coffee in small batches.',
        },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'Home brewers who buy beans online',
          channels: ['LinkedIn', 'Instagram'],
          goals: 'Grow coffee subscriptions',
        },
      },
    },
  });
  const other = await db.company.create({
    data: {
      name: 'zzverify modules other',
      slug: `zzverify-modules-o-${stamp}`,
    },
  });
  const user = await db.user.create({
    data: { email: `zzverify-modules-${stamp}@example.com`, name: 'Sam' },
  });
  const companyId = company.id;

  try {
    const item = (id: string, title: string, url: string) => ({
      id,
      title,
      url,
      source: 'news',
      sourceLabel: 'News',
      score: 10,
      publishedAt: ago(2).toISOString(),
      aiSummary: title,
      suggestedAngle: '',
    });
    await db.companyTrendConfig.create({
      data: { companyId, keywords: ['specialty coffee'] },
    });
    await db.trendDigest.create({
      data: {
        companyId,
        date: ago(1),
        payload: {
          items: [
            item('n1', 'Specialty coffee prices climb', 'https://a.example/1'),
            item(
              'n2',
              'Specialty coffee shops win on transparency',
              'https://a.example/2',
            ),
          ],
          summary: '',
          recommendations: [],
          hashtags: [],
          seasonal: [],
          competitorMentions: [],
        } as Prisma.InputJsonObject,
      },
    });
    const acme = await db.competitorProfile.create({
      data: { companyId, name: 'Acme Coffee' },
    });
    await db.competitorSnapshot.create({
      data: {
        competitorId: acme.id,
        capturedAt: ago(3),
        changesSummary: {
          hasChanges: true,
          pricing: 'Cut subscriptions by 20%',
          news: [],
          skipped: [],
          model: 'x',
          capturedAt: ago(3).toISOString(),
        } as Prisma.InputJsonObject,
      },
    });
    for (const [s, e, v] of [
      [14, 7, 500],
      [7, 0, 300],
    ] as const) {
      await db.analyticsReport.create({
        data: {
          companyId,
          periodStart: ago(s),
          periodEnd: ago(e),
          summary: 'p',
          metrics: { totalEngagement: v },
        },
      });
    }
    await collectSignals(companyId);
    await runDetection(companyId);
    for (const o of await db.opportunity.findMany({ where: { companyId } })) {
      await generateRecommendation({
        companyId,
        opportunityId: o.id,
        actorId: null,
        templatesOnly: true,
      });
    }
    const recs = await db.recommendation.findMany({
      where: { companyId },
      include: { evidence: true },
    });

    console.log('\nEach recommendation identifies its Aura workflow');
    const briefs = recs.map((r) => ({ r, b: executionBrief(r) }));
    check(
      'the engine’s recommendations each name a module, a button and a destination',
      recs.length >= 3 &&
        briefs.every(
          ({ b }) =>
            AURA_MODULE_IDS.includes(b.module) &&
            b.verb.length > 3 &&
            b.href.startsWith('/dashboard/'),
        ),
      briefs
        .map(({ r, b }) => `${r.title} → ${b.module} (${b.verb})`)
        .join(' | '),
    );
    check(
      'every destination carries the recommendation (?rec=)',
      briefs.every(
        ({ r, b }) =>
          b.href.includes(`rec=${r.id}`) &&
          b.related.every((d) => d.href.includes(`rec=${r.id}`)),
      ),
    );
    const response = recs.find(
      (r) => (r.details as { action?: string }).action === 'response-post',
    );
    const recovery = recs.find(
      (r) => (r.details as { action?: string }).action === 'recovery-post',
    );
    check(
      'a competitor response goes to Content Studio, with Competitors alongside',
      Boolean(
        response &&
        executionBrief(response).module === 'content-studio' &&
        executionBrief(response).related.some(
          (d) => d.module === 'competitors',
        ),
      ),
    );
    check(
      'a post to win back a drop is content, with Results alongside',
      Boolean(
        recovery &&
        executionBrief(recovery).module === 'content-studio' &&
        executionBrief(recovery).related.some((d) => d.module === 'analytics'),
      ),
    );
    check(
      'the engine records what the receiving module needs',
      (response?.details as { competitor?: string })?.competitor ===
        'Acme Coffee' &&
        (recovery?.details as { metric?: string })?.metric ===
          'Total engagement',
      JSON.stringify([response?.details, recovery?.details]),
    );
    const { suggestions } = await getSuggestions(companyId);
    check(
      'Aura Suggests leads to the same module, with the related modules, carrying the recommendation',
      suggestions.length > 0 &&
        suggestions.every((s) => {
          const b = briefs.find(({ r }) => r.id === s.id)!.b;
          // A low-confidence suggestion leads where the work is once accepted
          // (accepting is its review); the raw brief leads to the review.
          return (
            s.next.module === b.module &&
            s.next.href.includes(`rec=${s.id}`) &&
            s.next.related.length === b.related.length
          );
        }),
    );

    console.log('\nContext travels with the person');
    const ctx = await getRecommendationContext(companyId, response!.id);
    check(
      'the context says what, why, the goal, and what to do in each module',
      Boolean(
        ctx &&
        ctx.title === response!.title &&
        ctx.why.length > 10 &&
        ctx.expectedOutcome === response!.expectedOutcome &&
        ctx.primary.module === 'content-studio' &&
        ctx.related[0]?.hint ===
          'Look at what Acme Coffee changed before you respond.',
      ),
      JSON.stringify(ctx?.related),
    );
    check(
      'another business cannot read it',
      (await getRecommendationContext(other.id, response!.id)) === null &&
        (await ownRecommendation(other.id, response!.id)) === null,
    );
    const campaignHandoff = await getRecommendationHandoff(
      companyId,
      response!.id,
      'campaigns',
    );
    check(
      'a module receives typed hand-off data from the recommendation',
      campaignHandoff?.handoff.name === response!.title &&
        campaignHandoff.handoff.goal.includes(response!.expectedOutcome),
      JSON.stringify(campaignHandoff?.handoff),
    );

    console.log('\nWhat a module makes is linked both ways');
    const before = await db.recommendation.findUniqueOrThrow({
      where: { id: response!.id },
    });
    const linked = await linkRecommendation({
      companyId,
      recommendationId: response!.id,
      module: 'content-studio',
      created: { type: 'content-draft', id: 'draft-1', label: 'Our take' },
      actorId: user.id,
    });
    const history = await getRecommendationHistory(companyId, response!.id);
    const link = history!.events.find((e) => e.action === 'link');
    check(
      'it is recorded in the recommendation’s history, with the module and what was made',
      linked &&
        (link?.metadata as { module?: string })?.module === 'content-studio' &&
        (link?.metadata as { created?: { id?: string } })?.created?.id ===
          'draft-1' &&
        link?.actorName === 'Sam',
      JSON.stringify(link),
    );
    const after = await db.recommendation.findUniqueOrThrow({
      where: { id: response!.id },
    });
    check(
      'it does not change the recommendation’s status (execution comes later)',
      after.status === before.status,
    );
    check(
      'another business cannot link to it',
      (await linkRecommendation({
        companyId: other.id,
        recommendationId: response!.id,
        module: 'campaigns',
        created: { type: 'campaign', id: 'x', label: 'x' },
        actorId: null,
      })) === false,
    );
    check(
      'every module has a label, a route and capabilities',
      AURA_MODULE_IDS.every(
        (id) =>
          AURA_MODULES[id].label &&
          AURA_MODULES[id].route.startsWith('/dashboard') &&
          AURA_MODULES[id].capabilities.length > 0,
      ),
    );
  } finally {
    await db.company.delete({ where: { id: companyId } });
    await db.company.delete({ where: { id: other.id } });
    await db.user.delete({ where: { id: user.id } });
    check(
      'cleanup: throwaway workspaces removed',
      (await db.recommendation.count({ where: { companyId } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll module connection checks passed.'
      : `\n${failures} check(s) BROKEN.`,
  );
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});

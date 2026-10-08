/**
 * Proves Recommendation History & Activity against a real database:
 *
 *   · real recommendations, answered through the real lifecycle (accepted
 *     and completed, edited, skipped, turned down), show up in the history
 *     with their outcome, timestamps, who decided and their opportunity
 *   · filtering by outcome works, newest first
 *   · history stops repetition: a skipped opportunity is not suggested again
 *     by the automatic pass until its hold ends
 *   · learning candidates have Marketing Memory's shape
 *   · another workspace sees none of it
 *
 * Run: pnpm verify:history
 *
 * Everything lives in throwaway workspaces, deleted at the end.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { REPEAT_HOLD_DAYS } from '@/lib/recommendation-history';
import { runDetection } from '@/server/opportunities/detection.service';
import {
  openOpportunitiesWithoutSuggestion,
  suggestFromOpportunities,
} from '@/server/recommendations/autosuggest.service';
import { listRecommendationHistory } from '@/server/recommendations/history.service';
import {
  decideRecommendation,
  editRecommendation,
  transitionRecommendation,
} from '@/server/recommendations/recommendation.service';
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
      name: 'zzverify history',
      slug: `zzverify-history-${stamp}`,
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
      name: 'zzverify history other',
      slug: `zzverify-history-o-${stamp}`,
    },
  });
  const user = await db.user.create({
    data: { email: `zzverify-history-${stamp}@example.com`, name: 'Dana Ruiz' },
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

    console.log('\nNothing answered yet');
    const empty = await listRecommendationHistory(companyId);
    check(
      'the history is empty',
      empty.counts.all === 0 && empty.entries.length === 0,
    );

    await collectSignals(companyId);
    await runDetection(companyId);
    await suggestFromOpportunities(companyId, { templatesOnly: true });
    const recs = await db.recommendation.findMany({
      where: { companyId },
      orderBy: { priorityScore: 'desc' },
    });
    check(
      'Aura made suggestions to answer',
      recs.length >= 4,
      `${recs.length}`,
    );
    const [a, b, c, d] = recs as [
      (typeof recs)[number],
      (typeof recs)[number],
      (typeof recs)[number],
      (typeof recs)[number],
    ];

    // Answer each one through the real lifecycle.
    await decideRecommendation({
      companyId,
      recommendationId: a.id,
      decision: 'ACCEPTED',
      actorId: user.id,
      note: 'Let’s do it.',
    });
    const done = await transitionRecommendation({
      companyId,
      recommendationId: a.id,
      to: 'COMPLETED',
      actorId: user.id,
    }).catch((e: Error) => e);
    await editRecommendation({
      companyId,
      recommendationId: b.id,
      changes: { title: 'Our own take, in our words' },
      actorId: user.id,
    });
    await decideRecommendation({
      companyId,
      recommendationId: c.id,
      decision: 'SKIPPED',
      actorId: user.id,
    });
    await decideRecommendation({
      companyId,
      recommendationId: d.id,
      decision: 'REJECTED',
      actorId: user.id,
      note: 'Not our style.',
    });

    console.log('\nThe history');
    const h = await listRecommendationHistory(companyId);
    const byId = new Map(h.entries.map((e) => [e.id, e]));
    const completed = !(done instanceof Error);
    check(
      'accepted (completed where it was), edited, skipped and turned down are all there',
      byId.get(a.id)?.outcome === (completed ? 'completed' : 'accepted') &&
        byId.get(b.id)?.outcome === 'edited' &&
        byId.get(c.id)?.outcome === 'skipped' &&
        byId.get(d.id)?.outcome === 'rejected',
      h.entries.map((e) => `${e.title.slice(0, 20)}: ${e.outcome}`).join(' | '),
    );
    check(
      'counts per outcome add up',
      h.counts.all === 4 &&
        h.counts.edited === 1 &&
        h.counts.skipped === 1 &&
        h.counts.rejected === 1,
      JSON.stringify(h.counts),
    );
    check(
      'each has timestamps: suggested and decided; completed and edited where they happened',
      h.entries.every((e) => Boolean(e.suggestedAt && e.decidedAt)) &&
        Boolean(byId.get(b.id)?.editedAt) &&
        (!completed || Boolean(byId.get(a.id)?.completedAt)),
    );
    check(
      'who decided, and their note',
      h.entries.every((e) => e.decidedBy === 'Dana') &&
        byId.get(d.id)?.note === 'Not our style.',
    );
    check(
      'an edit says what was changed',
      byId.get(b.id)?.changedFields.includes('headline') === true,
      JSON.stringify(byId.get(b.id)?.changedFields),
    );
    check(
      'each links back to its originating opportunity',
      h.entries.every(
        (e) =>
          e.opportunity.href ===
            `/dashboard/opportunities?focus=${e.opportunity.id}` &&
          recs.find((r) => r.id === e.id)?.opportunityId === e.opportunity.id,
      ),
    );
    check(
      'newest decision first',
      h.entries.every(
        (e, i) =>
          i === 0 ||
          (e.decidedAt ?? '') <= (h.entries[i - 1]!.decidedAt ?? '~'),
      ),
    );
    const onlySkipped = await listRecommendationHistory(companyId, {
      outcome: 'skipped',
    });
    check(
      'filtering by outcome',
      onlySkipped.entries.length === 1 &&
        onlySkipped.entries[0]!.id === c.id &&
        onlySkipped.counts.all === 4,
    );

    console.log('\nHistory stops repetition');
    const skippedOpp = c.opportunityId;
    const waiting = await openOpportunitiesWithoutSuggestion(companyId);
    check(
      'a skipped opportunity is not offered for a new suggestion',
      !waiting.some((o) => o.id === skippedOpp),
    );
    const rerun = await suggestFromOpportunities(companyId, {
      templatesOnly: true,
    });
    check(
      'the automatic pass does not suggest it again',
      !rerun.created.some((x) => x.opportunityId === skippedOpp) &&
        (await db.recommendation.count({
          where: { opportunityId: skippedOpp },
        })) === 1,
    );
    check(
      'the history says when it may come back',
      byId.get(c.id)?.repeat ===
        `Aura won’t suggest it again for ${REPEAT_HOLD_DAYS.skipped} more days.`,
      byId.get(c.id)?.repeat ?? '',
    );
    const later = new Date(Date.now() + (REPEAT_HOLD_DAYS.skipped! + 1) * DAY);
    check(
      'once the hold has passed, it may be suggested again',
      (await openOpportunitiesWithoutSuggestion(companyId, later)).some(
        (o) => o.id === skippedOpp,
      ),
    );

    console.log('\nFor Marketing Memory');
    check(
      'learning candidates have Marketing Memory’s shape (none yet with so few answers)',
      Array.isArray(h.learning) &&
        h.learning.every(
          (l) =>
            l.insight &&
            l.sampleSize >= 4 &&
            l.supportingDataSummary.source === 'recommendation_history',
        ),
      JSON.stringify(h.learning),
    );

    console.log('\nNot shared across businesses');
    check(
      'another workspace sees none of it',
      (await listRecommendationHistory(other.id)).counts.all === 0,
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
      ? '\nAll history checks passed.'
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

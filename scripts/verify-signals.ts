/**
 * Proves the signal aggregation layer against a real database.
 *
 * Seeds every supported source in a throwaway workspace — trend digests,
 * a competitor snapshot, two analytics periods, a memory insight, a running
 * campaign and a goal — then checks that collection normalises them all,
 * keeps each one's source and record, associates them with the business,
 * never stores a duplicate, and that opportunity detection can consume them.
 *
 * Run: pnpm verify:signals
 *
 * The throwaway workspace is deleted at the end, including on failure.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { signalToEvidence } from '@/lib/signals';
import {
  asStoredSignal,
  collectSignals,
  listSignals,
} from '@/server/signals/signal.service';
import { recordOpportunity } from '@/server/opportunities/opportunity.service';

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
  const company = await db.company.create({
    data: {
      name: 'zzverify signals',
      slug: `zzverify-signals-${Date.now()}`,
      industry: 'Coffee',
      preferences: {
        business: {
          description: 'We roast single-origin coffee in small batches.',
        },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'Home brewers',
          goals: 'Reach 200 subscribers',
        },
      },
    },
  });

  try {
    const story = {
      id: 'news:1',
      title: 'Specialty coffee prices climb as harvests shrink',
      url: 'https://news.example/coffee-prices?utm_source=feed',
      source: 'news',
      sourceLabel: 'Coffee News',
      score: 30,
      publishedAt: ago(3).toISOString(),
      aiSummary: 'Costs are rising across specialty coffee.',
      suggestedAngle: 'Explain what you pay farmers.',
    };
    const payload = (items: unknown[]) =>
      ({
        items,
        summary: '',
        recommendations: [],
        hashtags: [],
        seasonal: [],
        competitorMentions: [],
      }) as Prisma.InputJsonObject;
    await db.companyTrendConfig.create({
      data: { companyId: company.id, keywords: ['specialty coffee'] },
    });
    await db.trendDigest.create({
      data: { companyId: company.id, date: ago(2), payload: payload([story]) },
    });
    // The same story again in a later digest, under a different item id and URL spelling.
    await db.trendDigest.create({
      data: {
        companyId: company.id,
        date: ago(1),
        payload: payload([
          {
            ...story,
            id: 'news:7',
            url: 'https://www.news.example/coffee-prices/',
          },
        ]),
      },
    });
    const competitor = await db.competitorProfile.create({
      data: { companyId: company.id, name: 'Acme Coffee' },
    });
    const snap = await db.competitorSnapshot.create({
      data: {
        competitorId: competitor.id,
        capturedAt: ago(4),
        changesSummary: {
          hasChanges: true,
          pricing: 'Cut the starter plan from $20 to $15',
          news: [],
          skipped: [],
          model: 'x',
          capturedAt: ago(4).toISOString(),
        },
      },
    });
    await db.analyticsReport.create({
      data: {
        companyId: company.id,
        periodStart: ago(14),
        periodEnd: ago(7),
        summary: 'p1',
        metrics: { totalEngagement: 200 },
      },
    });
    await db.analyticsReport.create({
      data: {
        companyId: company.id,
        periodStart: ago(7),
        periodEnd: ago(0),
        summary: 'p2',
        metrics: { totalEngagement: 320 },
      },
    });
    await db.marketingMemory.create({
      data: {
        companyId: company.id,
        insightType: 'CONTENT_FORMAT',
        insight: 'Carousels beat text posts',
        confidence: 'MEDIUM',
        sampleSize: 24,
      },
    });
    await db.campaign.create({
      data: {
        companyId: company.id,
        name: 'Holiday boxes',
        status: 'ACTIVE',
        goal: 'Sell 300 gift boxes',
        themes: ['gifting'],
      },
    });

    console.log('\nSignals from supported sources are normalised');
    const first = await collectSignals(company.id);
    check(
      'collection ran without a failing source',
      first !== null && first.failed.length === 0,
      JSON.stringify(first?.failed),
    );
    const all = await listSignals(company.id, { limit: 500 });
    const by = (src: string) => all.filter((s) => s.source === src);
    check('trends', by('TRENDS').length === 1, `${by('TRENDS').length}`);
    check('competitors', by('COMPETITORS').length === 1);
    check(
      'analytics',
      by('ANALYTICS').some((s) => s.title === 'Total engagement up 60%'),
      by('ANALYTICS')
        .map((s) => s.title)
        .join('; '),
    );
    check('marketing memory', by('MEMORY').length === 1);
    check(
      'business context (campaign + goal)',
      by('BUSINESS_CONTEXT').length === 2,
      by('BUSINESS_CONTEXT')
        .map((s) => s.title)
        .join('; '),
    );

    console.log('\nEach signal keeps its source, record, time and reliability');
    const pricing = by('COMPETITORS')[0]!;
    check(
      'competitor signal links to its snapshot',
      pricing.kind === 'COMPETITOR_SNAPSHOT' && pricing.refId === snap.id,
    );
    check(
      '…observed when the snapshot was captured',
      Math.abs(pricing.observedAt.getTime() - ago(4).getTime()) < 5000,
    );
    check(
      '…with a stated reliability',
      pricing.reliability === 'HIGH' &&
        pricing.reliabilityReason.includes('pricing page'),
    );
    check(
      'every signal has a source, timestamp and reliability',
      all.every(
        (s) => s.source && s.observedAt && s.reliability && s.reliabilityReason,
      ),
    );

    console.log('\nSignals are associated with the business');
    check(
      'every signal belongs to the workspace and its context revision',
      all.every(
        (s) => s.companyId === company.id && Boolean(s.contextRevision),
      ),
    );
    const trend = by('TRENDS')[0]!;
    check(
      'the trend story is matched to the business keyword and industry',
      trend.contextMatches.includes('keyword:specialty coffee') &&
        trend.contextMatches.includes('industry:Coffee'),
      JSON.stringify(trend.contextMatches),
    );
    const relevant = await listSignals(company.id, {
      relevantOnly: true,
      limit: 500,
    });
    check(
      'detection can ask for business-relevant signals only',
      relevant.length > 0 && relevant.length < all.length + 1,
    );

    console.log('\nNo duplicates');
    check(
      'the same story in two digests is one signal',
      by('TRENDS').length === 1,
    );
    check(
      '…seen twice, which raises its reliability',
      trend.occurrences === 2 && trend.reliability === 'HIGH',
      `${trend.occurrences} / ${trend.reliability}`,
    );
    const second = await collectSignals(company.id);
    const afterCount = await db.signal.count({
      where: { companyId: company.id },
    });
    check(
      'collecting again stores nothing new',
      second?.created === 0 && afterCount === all.length,
      `${second?.created} created, ${afterCount} rows`,
    );
    const analyticsAgain = (
      await listSignals(company.id, { sources: ['ANALYTICS'] })
    )[0]!;
    check(
      're-reading the same record is not counted as corroboration',
      analyticsAgain.occurrences === 1,
    );

    console.log('\nOpportunity detection consumes normalised signals');
    const evidence = [trend, pricing].map((s) =>
      signalToEvidence(asStoredSignal(s)),
    );
    const { opportunity } = await recordOpportunity(company.id, {
      type: 'COMPETITOR_MOVE',
      title: 'Explain your pricing while costs rise',
      summary: 'Prices are climbing and Acme just cut theirs.',
      source: 'TRENDS',
      detectedBy: 'verify-script',
      signals: evidence,
    });
    check(
      'an opportunity is recorded from signals',
      opportunity.signals.length === 2,
    );
    check(
      'its evidence links back to the normalised signals',
      opportunity.signals.every(
        (s) => s.signalId && [trend.id, pricing.id].includes(s.signalId),
      ),
    );
    check(
      '…and to the original records',
      opportunity.signals.some((s) => s.refId === snap.id),
    );
  } finally {
    await db.company.delete({ where: { id: company.id } });
    check(
      'cleanup: throwaway workspace and its signals removed',
      (await db.signal.count({ where: { companyId: company.id } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll signal checks passed.'
      : `\n${failures} check(s) BROKEN.`,
  );
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

/**
 * Proves the opportunity detection rules against a real database.
 *
 * Seeds a throwaway workspace with signals for every rule, runs detection
 * end to end (collect → detect → record), and checks: what each rule found,
 * that low-confidence evidence is never high priority, that running again
 * creates no duplicates, that a rejected opportunity is not proposed again,
 * and that an opportunity another detector already found is merged into
 * rather than duplicated.
 *
 * Run: pnpm verify:detection
 *
 * The throwaway workspace is deleted at the end, including on failure.
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { runDetection } from '@/server/opportunities/detection.service';
import {
  recordOpportunity,
  transitionOpportunity,
} from '@/server/opportunities/opportunity.service';
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
  const company = await db.company.create({
    data: {
      name: 'zzverify detection',
      slug: `zzverify-detect-${Date.now()}`,
      industry: 'Coffee',
      preferences: {
        business: {
          description: 'We roast single-origin coffee in small batches.',
        },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'Home brewers',
          channels: ['Instagram'],
        },
      },
    },
  });

  try {
    const payload = (items: unknown[]) =>
      ({
        items,
        summary: '',
        recommendations: [],
        hashtags: [],
        seasonal: [],
        competitorMentions: [],
      }) as Prisma.InputJsonObject;
    const item = (id: string, title: string, url: string, source = 'news') => ({
      id,
      title,
      url,
      source,
      sourceLabel: source,
      score: 10,
      publishedAt: ago(2).toISOString(),
      aiSummary: title,
      suggestedAngle: '',
    });
    await db.companyTrendConfig.create({
      data: {
        companyId: company.id,
        keywords: ['specialty coffee', 'cold brew'],
      },
    });
    await db.trendDigest.create({
      data: {
        companyId: company.id,
        date: ago(1),
        payload: payload([
          item(
            'n1',
            'Specialty coffee prices climb as harvests shrink',
            'https://a.example/1',
          ),
          item(
            'n2',
            'Why specialty coffee shops are winning on transparency',
            'https://a.example/2',
          ),
          // Only low-reliability chatter on this topic: must not become an opportunity.
          item(
            'r1',
            'Is cold brew overrated?',
            'https://reddit.example/1',
            'reddit',
          ),
          item(
            'r2',
            'Cold brew at home tips',
            'https://reddit.example/2',
            'reddit',
          ),
        ]),
      },
    });
    const competitor = await db.competitorProfile.create({
      data: { companyId: company.id, name: 'Acme Coffee' },
    });
    const snap = await db.competitorSnapshot.create({
      data: {
        competitorId: competitor.id,
        capturedAt: ago(3),
        changesSummary: {
          hasChanges: true,
          pricing: 'Cut subscriptions by 20%',
          news: [],
          skipped: [],
          model: 'x',
          capturedAt: ago(3).toISOString(),
        },
      },
    });
    await db.analyticsReport.create({
      data: {
        companyId: company.id,
        periodStart: ago(14),
        periodEnd: ago(7),
        summary: 'p1',
        metrics: { totalEngagement: 500 },
      },
    });
    await db.analyticsReport.create({
      data: {
        companyId: company.id,
        periodStart: ago(7),
        periodEnd: ago(0),
        summary: 'p2',
        metrics: { totalEngagement: 300 },
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

    // Another detector (the AI advisor) already found this competitor move.
    const advisor = await recordOpportunity(company.id, {
      type: 'COMPETITOR_MOVE',
      title: 'Answer Acme’s subscription discount',
      summary: 'Found by the advisor.',
      source: 'ADVISOR',
      detectedBy: 'claude-x',
      signals: [
        {
          kind: 'COMPETITOR_SNAPSHOT',
          refId: snap.id,
          label: 'Acme Coffee',
          detail: 'Pricing change: subscriptions -20%',
        },
      ],
    });

    await collectSignals(company.id);

    console.log('\nEach rule fires on the evidence it needs');
    const first = await runDetection(company.id);
    const by = (rule: string) =>
      first?.outcomes.filter((o) => o.rule === rule) ?? [];
    check('competitor move', by('competitor-move').length === 1);
    check(
      '…merged into the opportunity the advisor already found',
      by('competitor-move')[0]?.mergedInto === advisor.opportunity.id &&
        by('competitor-move')[0]?.outcome === 'updated',
    );
    check(
      'trending topic (two stories on "specialty coffee")',
      by('trending-topic').length === 1,
      JSON.stringify(first?.outcomes.map((o) => o.title)),
    );
    check(
      'results shift (engagement down 40%)',
      by('results-shift').length === 1,
    );
    check('proven pattern', by('proven-pattern').length === 1);
    check(
      'unconnected channel (Instagram)',
      by('unconnected-channel').length === 1,
    );
    const all = await db.opportunity.findMany({
      where: { companyId: company.id },
      include: { signals: true },
    });
    check(
      'low-reliability chatter alone did not become an opportunity',
      !all.some((o) => /cold brew/i.test(o.title)),
    );

    console.log('\nConfidence and priority');
    check(
      'every recorded opportunity has a confidence and its reason',
      all.every((o) => o.confidence && o.confidenceReason),
    );
    check(
      'no LOW-confidence opportunity is HIGH or URGENT priority',
      all
        .filter((o) => o.confidence === 'LOW')
        .every((o) => o.priority === 'LOW' || o.priority === 'MEDIUM'),
    );
    const pattern = all.find((o) => o.detectedBy === 'rule:proven-pattern');
    check(
      'rule-detected evidence links to the normalised signals',
      Boolean(pattern?.signals.every((s) => s.signalId)),
    );

    console.log('\nDuplicates are controlled');
    const countBefore = all.length;
    const second = await runDetection(company.id);
    const countAfter = await db.opportunity.count({
      where: { companyId: company.id },
    });
    check(
      'running again creates no new opportunities',
      countAfter === countBefore,
      `${countBefore} → ${countAfter}`,
    );
    check(
      '…it updates the existing ones',
      (second?.outcomes ?? []).every((o) => o.outcome === 'updated'),
    );

    console.log('\nRejected opportunities are not proposed again');
    const trend = all.find((o) => o.detectedBy === 'rule:trending-topic')!;
    await transitionOpportunity({
      companyId: company.id,
      opportunityId: trend.id,
      to: 'REJECTED',
      actorId: null,
      note: 'Not our angle.',
    });
    const third = await runDetection(company.id);
    check(
      'the rejected topic is suppressed, with the reason',
      (third?.suppressed ?? []).some(
        (s) => s.rule === 'trending-topic' && s.reason === 'already-rejected',
      ),
    );
    const stillRejected = await db.opportunity.findUnique({
      where: { id: trend.id },
    });
    check('…and stays rejected', stillRejected?.status === 'REJECTED');
  } finally {
    await db.company.delete({ where: { id: company.id } });
    check(
      'cleanup: throwaway workspace removed',
      (await db.opportunity.count({ where: { companyId: company.id } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll detection checks passed.'
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
